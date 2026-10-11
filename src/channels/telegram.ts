/**
 * Telegram channel: a bot on the Bot API over plain fetch, long polling getUpdates. No SDK, no webhook.
 * People are "tg:<user id>". Only private chats are handled; photos and image documents are downloaded into `dataDir`.
 * A bot cannot text someone first: each person has to open the bot and press Start once.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { Channel, InboundMessage } from "../types.js";
import { keyedQueue, splitText } from "./serial.js";

export interface TelegramChannelOptions {
  /** Bot token from BotFather. */
  token: string;
  /** Default https://api.telegram.org. Tests point it at a fake Bot API. */
  apiBase?: string;
  log?: (line: string) => void;
  /** Where downloaded images go. Default data/telegram. */
  dataDir?: string;
}

/** Telegram's limit is 4096 characters; leave room. */
export const MAX_TELEGRAM_CHARS = 4000;
const TYPING_EVERY_MS = 4000;
const TYPING_MAX_MS = 5 * 60_000;
// Telegram only accepts reactions from a fixed set; anything else becomes a thumbs up.
const REACTIONS = new Set([..."👍👎❤🔥🥰👏😁🤔🤯😱🤬😢🎉🤩🙏👌🕊🤡🥱😍🐳🌚💯🤣⚡🏆💔🤨😐🍾💋😈😴😭🤓👻👀🎃🙈😇😨🤝✍🤗🫡🎅🎄☃💅🤪🗿🆒💘🙉🦄😘💊🙊😎👾🤷😡"]);

interface User { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
interface PhotoSize { file_id: string; width: number; height: number; file_size?: number }
interface Message {
  message_id: number;
  date: number;
  chat: { id: number; type: string };
  from?: User;
  text?: string;
  caption?: string;
  photo?: PhotoSize[];
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}
interface Update { update_id: number; message?: Message }

export class TelegramError extends Error {
  constructor(readonly method: string, readonly code: number, readonly description: string, readonly retryAfter?: number) {
    super(`Telegram ${method} failed (${code}): ${description}`);
  }
}

export function createTelegramChannel(options: TelegramChannelOptions): Channel {
  const { token } = options;
  const base = (options.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "");
  const dir = resolve(options.dataDir ?? "data/telegram");
  const log = options.log ?? ((line: string) => console.log(`[telegram] ${line}`));
  const inbound = keyedQueue(); // per sender: downloads, so messages reach the app in order
  const outbound = keyedQueue(); // per chat: sends stay in order
  const typingTimers = new Map<string, { interval: NodeJS.Timeout; stop: NodeJS.Timeout }>();
  let abort = new AbortController();
  let loop: Promise<void> | undefined;
  let bot = "the bot";

  async function call<T>(method: string, body: object, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${base}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }).catch((err: unknown) => {
      throw new Error(redact(`Telegram ${method}: ${errorText(err)}`), { cause: err });
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
    if (!res.ok || !data.ok) throw new TelegramError(method, data.error_code ?? res.status, data.description ?? `HTTP ${res.status}`, data.parameters?.retry_after);
    return data.result as T;
  }

  /** Retries on 429 (flood control) after the wait Telegram asks for. */
  async function callRetrying<T>(method: string, body: object): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call<T>(method, body);
      } catch (err) {
        if (!(err instanceof TelegramError) || err.code !== 429 || attempt >= 3) throw err;
        await sleep(Math.min(30, err.retryAfter ?? 1) * 1000);
      }
    }
  }

  async function download(fileId: string, name: string, fallbackExt: string): Promise<string> {
    const file = await call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new Error("getFile returned no file_path (over 20 MB?)");
    const res = await fetch(`${base}/file/bot${token}/${file.file_path}`);
    if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name}${extname(file.file_path) || fallbackExt}`);
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
    return path;
  }

  async function images(m: Message): Promise<string[]> {
    const wanted: { id: string; ext: string }[] = [];
    const largest = m.photo?.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    if (largest) wanted.push({ id: largest.file_id, ext: ".jpg" });
    const doc = m.document;
    if (doc?.mime_type?.startsWith("image/")) wanted.push({ id: doc.file_id, ext: extname(doc.file_name ?? "") || `.${doc.mime_type.slice(6)}` });
    const paths: string[] = [];
    for (const [i, w] of wanted.entries()) {
      try {
        paths.push(await download(w.id, `${m.chat.id}-${m.message_id}-${i}`, w.ext));
      } catch (err) {
        log(`image of ${m.chat.id}:${m.message_id} not downloaded: ${redact(errorText(err))}`);
      }
    }
    return paths;
  }

  async function toInbound(m: Message, from: User): Promise<InboundMessage | undefined> {
    const text = commandText((m.text ?? m.caption ?? "").trim());
    const paths = await images(m);
    if (!text && paths.length === 0) {
      log(`dropped ${m.chat.id}:${m.message_id}: no text and no image`);
      return undefined;
    }
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || undefined;
    return { id: `${m.chat.id}:${m.message_id}`, handle: `tg:${from.id}`, text, images: paths, at: new Date(m.date * 1000), service: "telegram", username: from.username, name };
  }

  async function poll(onMessage: (message: InboundMessage) => Promise<void>, signal: AbortSignal): Promise<void> {
    let offset = 0;
    let failures = 0;
    while (!signal.aborted) {
      let updates: Update[];
      try {
        updates = await call<Update[]>("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] }, signal);
        failures = 0;
      } catch (err) {
        if (signal.aborted) return;
        failures += 1;
        const wait = Math.min(30_000, 1000 * 2 ** (failures - 1));
        const hint = err instanceof TelegramError && err.code === 409 ? " (another process is polling this bot, or a webhook is set)" : "";
        log(`getUpdates failed: ${redact(errorText(err))}${hint}; retrying in ${wait / 1000} s`);
        await sleep(wait, signal);
        continue;
      }
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        const m = u.message;
        const from = m?.from;
        // Private chats with people only: groups, channels and other bots are ignored.
        if (!m || !from || from.is_bot || m.chat.type !== "private") continue;
        const failed = (err: unknown) => log(`handling ${m.chat.id}:${m.message_id} failed: ${errorText(err)}`);
        inbound(`tg:${from.id}`, async () => {
          const message = await toInbound(m, from);
          // Not awaited: one slow turn must not hold up other people or the poll loop.
          if (message) Promise.resolve().then(() => onMessage(message)).catch(failed);
        }).catch(failed);
      }
    }
  }

  function stopTyping(handle: string): void {
    const t = typingTimers.get(handle);
    if (!t) return;
    clearInterval(t.interval);
    clearTimeout(t.stop);
    typingTimers.delete(handle);
  }

  const action = (handle: string) =>
    call("sendChatAction", { chat_id: chatId(handle), action: "typing" }).catch((err) => log(`typing for ${handle}: ${redact(errorText(err))}`));

  return {
    name: "telegram",

    async start(onMessage) {
      try {
        const me = await call<User>("getMe", {});
        if (me.username) bot = `@${me.username}`;
      } catch (err) {
        if (err instanceof TelegramError && err.code === 401) throw new Error("TELEGRAM_BOT_TOKEN was rejected (401 Unauthorized). Copy the token from BotFather again.");
        throw new Error(redact(`Cannot reach the Telegram Bot API: ${errorText(err)}`), { cause: err });
      }
      abort = new AbortController();
      loop = poll(onMessage, abort.signal);
      log(`polling as ${bot} (https://t.me/${bot.replace(/^@/, "")})`);
    },

    async send(handle, text) {
      const chat_id = chatId(handle);
      await outbound(handle, async () => {
        for (const part of splitText(text, MAX_TELEGRAM_CHARS)) {
          try {
            await callRetrying("sendMessage", { chat_id, text: part, link_preview_options: { is_disabled: false } });
          } catch (err) {
            throw new Error(sendErrorMessage(handle, bot, err), { cause: err });
          }
        }
      });
    },

    async typing(handle, on) {
      stopTyping(handle);
      if (!on || !/^tg:\d+$/i.test(handle)) return;
      void action(handle);
      const interval = setInterval(() => void action(handle), TYPING_EVERY_MS);
      // Never type forever if the app forgets to turn it off.
      const stop = setTimeout(() => stopTyping(handle), TYPING_MAX_MS);
      stop.unref?.();
      typingTimers.set(handle, { interval, stop });
    },

    async react(messageId, emoji) {
      const [chat, message] = messageId.split(":");
      if (!chat || !message) return;
      const plain = emoji.replace(/️/g, "");
      const reaction = [{ type: "emoji", emoji: REACTIONS.has(plain) ? plain : "👍" }];
      await call("setMessageReaction", { chat_id: Number(chat), message_id: Number(message), reaction }).catch((err) =>
        log(`react to ${messageId}: ${redact(errorText(err))}`),
      );
    },

    async stop() {
      for (const handle of [...typingTimers.keys()]) stopTyping(handle);
      abort.abort();
      await loop;
      loop = undefined;
    },
  };

  function redact(text: string): string {
    return token ? text.split(token).join("<token>") : text;
  }
}

/** "/start anything" is a hello; "/help@jarvis_bot x" becomes "help x". */
export function commandText(text: string): string {
  const cmd = /^\/([a-z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
  if (!cmd?.[1]) return text;
  if (cmd[1].toLowerCase() === "start") return "hi";
  return `${cmd[1]} ${cmd[2] ?? ""}`.trim();
}

function chatId(handle: string): number {
  const m = /^tg:(\d+)$/i.exec(handle.trim());
  if (!m?.[1]) throw new Error(`${handle} is not a Telegram handle (tg:<user id>); the Telegram channel cannot text it.`);
  return Number(m[1]);
}

export function sendErrorMessage(handle: string, bot: string, err: unknown): string {
  const text = errorText(err);
  if (/bot was blocked by the user|chat not found|user is deactivated|bot can't initiate/i.test(text)) {
    return `Telegram cannot message ${handle}: they have to open ${bot} in Telegram and press Start first (or unblock it). (${text})`;
  }
  return `Telegram send to ${handle} failed: ${text}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
