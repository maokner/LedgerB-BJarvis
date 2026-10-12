/**
 * iMessage through Photon's hosted service (Spectrum: @spectrum-ts/core and @spectrum-ts/imessage), on a Photon line.
 * Nothing runs on a Mac: the stream of messages and every send go to Photon's cloud with the project's id and secret.
 * People are their iMessage address (an E.164 phone number or an email). Only 1:1 chats are handled; image attachments
 * are written into `dataDir`. A shared line may only text a number that texted it first, about 50 new people a day.
 * Spectrum is imported lazily inside the default `connect`, so this module loads in tests without touching the network.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { normalizeHandle } from "../handles.js";
import type { Channel, ChannelService, InboundMessage } from "../types.js";
import { MAX_IMESSAGE_CHARS } from "./imessage.js";
import { keyedQueue, splitText } from "./serial.js";

/** A chat as this channel uses it: Spectrum's Space, of which only these fields are read. */
export interface PhotonSpace {
  id: string;
  /** iMessage: "dm" or "group". */
  type?: string;
  /** iMessage: the line's number, or "shared" on a shared line. */
  phone?: string;
}

/** Spectrum's message content: a union on `type`; only the fields this channel reads. */
export interface PhotonContent {
  type: string;
  text?: string;
  markdown?: string;
  url?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  read?: () => Promise<Buffer>;
  /** "group" (an album, or a photo with its text): the parts, each a message. */
  items?: PhotonMessage[];
  /** "reply": what was said in the thread. */
  content?: PhotonContent;
}

/** Spectrum's Message, as far as this channel reads it. */
export interface PhotonMessage {
  id: string;
  direction: "inbound" | "outbound";
  sender?: { id: string; kind?: "agent"; address?: string; service?: string };
  timestamp: Date;
  content: PhotonContent;
  react(emoji: string): Promise<unknown>;
  read(): Promise<void>;
}

/** The slice of a Spectrum instance (with the iMessage platform on it) this channel needs. Tests pass a fake. */
export interface PhotonClient {
  messages: AsyncIterable<[PhotonSpace, PhotonMessage]>;
  send(space: PhotonSpace, text: string): Promise<unknown>;
  typing(space: PhotonSpace, on: boolean): Promise<unknown>;
  /** imessage(app).space: create resolves or opens the 1:1 chat with a phone or email; get rebuilds one from its id. */
  space: { create(handle: string): Promise<PhotonSpace>; get(id: string): Promise<PhotonSpace> };
  /** imessage.is: the message came from the iMessage platform. */
  is(message: PhotonMessage): boolean;
  stop(): Promise<void>;
}

export interface PhotonChannelOptions {
  /** From the Photon dashboard (project Settings): SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET. */
  projectId: string;
  projectSecret: string;
  /** The number people text Jarvis at (PHOTON_NUMBER), for the "they have to text first" error. */
  number?: string;
  log?: (line: string) => void;
  /** Where image attachments go. Default data/photon. */
  dataDir?: string;
  /** Longest text sent in one iMessage; longer ones are split. Default 1500. */
  maxChars?: number;
  /** Persists the chat id of each handle, so a restart can still text someone (src/index.ts: the settings table). */
  spaces?: { get(handle: string): string | undefined; set(handle: string, id: string): void };
  /** Opens the Spectrum connection. Default: Photon's cloud with projectId and projectSecret. */
  connect?: () => Promise<PhotonClient>;
}

const TYPING_MAX_MS = 5 * 60_000;
const RECENT_MESSAGES = 500;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Rows that are not something the person said: tapbacks and chat signals. Dropped without a log line. */
const SIGNALS = new Set(["reaction", "typing", "read", "edit", "unsend", "rename", "avatar", "addMember", "removeMember", "leaveSpace"]);

/** Photon's cloud through Spectrum, imported only here. Albums arrive whole ("group") so a photo keeps its text. */
export async function connectSpectrum(projectId: string, projectSecret: string): Promise<PhotonClient> {
  const [{ Spectrum, typing }, { imessage }] = await Promise.all([import("@spectrum-ts/core"), import("@spectrum-ts/imessage")]);
  const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()], options: { logLevel: "warn" } });
  const platform = imessage(app);
  type Space = Parameters<typeof app.send>[0];
  return {
    // A getter: each read subscribes to the stream, so only the loop in run() reads it.
    get messages() {
      return app.messages as AsyncIterable<[PhotonSpace, PhotonMessage]>;
    },
    send: (space, text) => app.send(space as Space, text),
    typing: (space, on) => app.send(space as Space, typing(on ? "start" : "stop")),
    space: { create: (handle) => platform.space.create(handle), get: (id) => platform.space.get(id) },
    is: (message) => imessage.is(message as unknown as Parameters<typeof imessage.is>[0]),
    stop: () => app.stop(),
  };
}

export function createPhotonChannel(options: PhotonChannelOptions): Channel {
  const dir = resolve(options.dataDir ?? "data/photon");
  const max = options.maxChars ?? MAX_IMESSAGE_CHARS;
  const log = options.log ?? ((line: string) => console.log(`[photon] ${line}`));
  const connect = options.connect ?? (() => connectSpectrum(options.projectId, options.projectSecret));
  const inbound = keyedQueue(); // per sender: attachment downloads, so messages reach the app in order
  const outbound = keyedQueue(); // per handle: sends stay in order
  /** Chats by normalized handle, for the current connection (a reconnect rebuilds them from their ids). */
  const spaces = new Map<string, PhotonSpace>();
  const spaceIds = new Map<string, string>();
  /** Recent inbound messages by id, for react(); oldest dropped first. */
  const recent = new Map<string, PhotonMessage>();
  const typingTimers = new Map<string, NodeJS.Timeout>();
  let current: Promise<PhotonClient> | undefined;
  let abort = new AbortController();
  let loop: Promise<void> | undefined;

  /** The open connection, opening one when there is none. A failed open is not kept, so the next call retries. */
  function client(): Promise<PhotonClient> {
    if (!current) {
      const opening = connect();
      current = opening;
      opening.catch(() => {
        if (current === opening) current = undefined;
      });
    }
    return current;
  }

  /** Drops the connection (the stream ended or failed); the next client() opens a new one. */
  async function drop(dead: PhotonClient): Promise<void> {
    if (current && (await current.catch(() => undefined)) === dead) {
      current = undefined;
      spaces.clear();
    }
    await dead.stop().catch((err: unknown) => log(`stopping the old connection: ${errorText(err)}`));
  }

  function remember(handle: string, space: PhotonSpace): void {
    spaces.set(handle, space);
    if (spaceIds.get(handle) === space.id) return;
    spaceIds.set(handle, space.id);
    try {
      options.spaces?.set(handle, space.id);
    } catch (err) {
      log(`could not store the chat of ${handle}: ${errorText(err)}`);
    }
  }

  /** The 1:1 chat with `handle`: the one they last wrote from, else the stored id, else a new one. */
  async function spaceFor(c: PhotonClient, raw: string): Promise<PhotonSpace> {
    const handle = normalizeHandle(raw);
    const known = spaces.get(handle);
    if (known) return known;
    const id = spaceIds.get(handle) ?? options.spaces?.get(handle);
    const space = id ? await c.space.get(id) : await c.space.create(handle);
    remember(handle, space);
    return space;
  }

  async function saveImage(message: PhotonMessage, part: PhotonContent, index: number): Promise<string | undefined> {
    if (!part.read) return undefined;
    if (part.size && part.size > MAX_IMAGE_BYTES) {
      log(`image of ${message.id} skipped: ${part.size} bytes`);
      return undefined;
    }
    const ext = extname(part.name ?? "") || `.${(part.mimeType ?? "image/jpeg").slice(6).replace(/[^a-z0-9]/gi, "") || "jpg"}`;
    const path = join(dir, `${message.id.replace(/[^\w.-]/g, "_")}-${index}${ext}`);
    try {
      const bytes = await part.read();
      await mkdir(dir, { recursive: true });
      await writeFile(path, bytes);
      return path;
    } catch (err) {
      log(`image of ${message.id} not downloaded: ${errorText(err)}`);
      return undefined;
    }
  }

  /** Text and image paths of a message; a group's parts are joined, so a photo and its words make one message. */
  async function collect(message: PhotonMessage, part: PhotonContent, out: { text: string[]; images: string[]; parts: number }): Promise<void> {
    switch (part.type) {
      case "text":
        if (part.text?.trim()) out.text.push(part.text.trim());
        return;
      case "markdown":
        if (part.markdown?.trim()) out.text.push(part.markdown.trim());
        return;
      case "richlink":
        if (part.url) out.text.push(part.url);
        return;
      case "reply":
        if (part.content) await collect(message, part.content, out);
        return;
      case "attachment": {
        if (!part.mimeType?.startsWith("image/")) {
          log(`attachment of ${message.id} dropped: ${part.mimeType ?? "unknown type"}`);
          return;
        }
        const path = await saveImage(message, part, out.parts++);
        if (path) out.images.push(path);
        return;
      }
      case "group":
        for (const item of part.items ?? []) await collect(item, item.content, out);
        return;
      default:
        // contact cards, polls, voice notes and anything newer: nothing the agent can read yet.
        return;
    }
  }

  async function toInbound(message: PhotonMessage, address: string): Promise<InboundMessage | undefined> {
    const out = { text: [] as string[], images: [] as string[], parts: 0 };
    await collect(message, message.content, out);
    const text = out.text.join("\n").trim();
    if (!text && out.images.length === 0) {
      log(`dropped ${message.id}: no text and no image (${message.content.type})`);
      return undefined;
    }
    return { id: message.id, handle: address, text, images: out.images, at: message.timestamp, service: serviceOf(message.sender?.service) };
  }

  /** Hands one stream row to the app if it is a person's direct message; never throws. */
  function receive(c: PhotonClient, space: PhotonSpace, message: PhotonMessage, onMessage: (message: InboundMessage) => Promise<void>): void {
    try {
      if (!c.is(message) || message.direction !== "inbound" || message.sender?.kind === "agent") return;
      if (SIGNALS.has(message.content.type)) return;
      if (space.type !== "dm") return; // group chats are not Jarvis's business
      const address = message.sender?.address ?? message.sender?.id;
      if (!address) return;
      const handle = normalizeHandle(address);
      remember(handle, space);
      recent.delete(message.id);
      recent.set(message.id, message);
      if (recent.size > RECENT_MESSAGES) recent.delete(recent.keys().next().value!);
      void message.read().catch((err: unknown) => log(`marking ${message.id} read: ${errorText(err)}`));
      const failed = (err: unknown) => log(`handling ${message.id} failed: ${errorText(err)}`);
      inbound(handle, async () => {
        const m = await toInbound(message, address);
        // Not awaited: one slow turn must not hold up other people or the stream.
        if (m) Promise.resolve().then(() => onMessage(m)).catch(failed);
      }).catch(failed);
    } catch (err) {
      log(`stream row ${message?.id} failed: ${errorText(err)}`);
    }
  }

  /** Reads the stream until stopped; reconnects with backoff when it ends or fails. */
  async function run(onMessage: (message: InboundMessage) => Promise<void>, signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      let c: PhotonClient | undefined;
      try {
        c = await client();
        for await (const [space, message] of until(c.messages, signal)) {
          failures = 0;
          receive(c, space, message, onMessage);
        }
        if (signal.aborted) return;
        log("the message stream ended; reconnecting");
      } catch (err) {
        if (signal.aborted) return;
        log(`the message stream failed: ${errorText(err)}`);
      }
      if (c) await drop(c);
      failures += 1;
      const wait = Math.min(60_000, 1000 * 2 ** (failures - 1));
      log(`reconnecting in ${wait / 1000} s`);
      await sleep(wait, signal);
    }
  }

  function stopTyping(handle: string): void {
    const t = typingTimers.get(handle);
    if (!t) return;
    clearTimeout(t);
    typingTimers.delete(handle);
  }

  return {
    name: "photon",

    async start(onMessage) {
      try {
        await client();
      } catch (err) {
        throw new Error(`Cannot connect to Photon's iMessage service: ${errorText(err)}. Check SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET (Photon dashboard, project Settings).`, { cause: err });
      }
      abort = new AbortController();
      loop = run(onMessage, abort.signal);
      log(`listening on Photon iMessage${options.number ? ` (people text ${options.number})` : ""}`);
    },

    async send(handle, text) {
      if (/^tg:/i.test(handle.trim())) throw new Error(`${handle} is a Telegram user; the iMessage channel cannot text them.`);
      await outbound(normalizeHandle(handle), async () => {
        for (const part of splitText(text, max)) {
          try {
            const c = await client();
            await c.send(await spaceFor(c, handle), part);
          } catch (err) {
            throw new Error(sendErrorMessage(handle, options.number, err), { cause: err });
          }
        }
      });
    },

    async typing(handle, on) {
      const key = normalizeHandle(handle);
      stopTyping(key);
      try {
        // Only chats someone wrote from: typing must never open a conversation on a shared line.
        const space = spaces.get(key);
        if (!space) return;
        await (await client()).typing(space, on);
        if (!on) return;
        // Never type forever if the app forgets to turn it off.
        const timer = setTimeout(() => {
          typingTimers.delete(key);
          void client().then((c) => c.typing(space, false)).catch(() => undefined);
        }, TYPING_MAX_MS);
        timer.unref?.();
        typingTimers.set(key, timer);
      } catch (err) {
        log(`typing for ${handle}: ${errorText(err)}`);
      }
    },

    async react(messageId, emoji) {
      const message = recent.get(messageId);
      if (!message) return;
      await message.react(emoji).catch((err: unknown) => log(`react to ${messageId}: ${errorText(err)}`));
    },

    async stop() {
      for (const t of typingTimers.values()) clearTimeout(t);
      typingTimers.clear();
      abort.abort();
      await loop;
      loop = undefined;
      const c = await current?.catch(() => undefined);
      current = undefined;
      spaces.clear();
      await c?.stop().catch((err: unknown) => log(`stop: ${errorText(err)}`));
    },
  };
}

/** A failed send in plain words: on a shared line someone who never texted Jarvis cannot be texted. */
export function sendErrorMessage(handle: string, number: string | undefined, err: unknown): string {
  const text = errorText(err);
  const code = (err as { code?: unknown; cause?: { code?: unknown } })?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code;
  const at = number ? `Jarvis at ${number}` : "Jarvis's iMessage number";
  if (code === "dailyLimitExceeded" || code === "recipientLimitExceeded" || /daily limit|recipient limit/i.test(text)) {
    return `iMessage cannot reach ${handle}: Jarvis's line hit its limit of new conversations for today. They can text ${at} and Jarvis answers them. (${text})`;
  }
  if (
    ["newContactThrottled", "chatNotFound", "addressNotFound", "preconditionFailed", "recipientLocked"].includes(String(code)) ||
    /text(?:ed)? .*first|message(?:d)? .*first|never (?:texted|messaged)|not (?:allowed|permitted) to (?:message|text|send)|new contact|chat not found|address not found/i.test(text)
  ) {
    return `iMessage cannot reach ${handle}: they have to text ${at} first. (${text})`;
  }
  return `iMessage send to ${handle} failed: ${text}`;
}

function serviceOf(service: string | undefined): ChannelService {
  return service === "SMS" || service === "RCS" ? service : "iMessage";
}

/** Iterates `iterable` until it ends or `signal` aborts, so stop() never waits on a stream that keeps quiet. */
async function* until<T>(iterable: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const it = iterable[Symbol.asyncIterator]();
  let onAbort = () => {};
  const aborted = new Promise<IteratorResult<T>>((done) => {
    onAbort = () => done({ done: true, value: undefined });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (!signal.aborted) {
      const next = await Promise.race([it.next(), aborted]);
      if (next.done) return;
      yield next.value;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    void Promise.resolve(it.return?.()).catch(() => undefined);
  }
}

/** The error message plus every nested cause, so codes from Photon are not hidden. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let i = 0; e && i < 5; i++) {
    parts.push(e instanceof Error ? e.message : String(e));
    e = e instanceof Error ? e.cause : undefined;
  }
  return [...new Set(parts)].join(": ");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
