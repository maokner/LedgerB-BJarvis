/**
 * iMessage channel through Photon (@photon-ai/imessage-kit).
 * Reads ~/Library/Messages/chat.db (needs Full Disk Access) and sends through Messages.app (needs Automation).
 * Photon is imported lazily so this module loads on any OS; pass `sdk` to inject a fake in tests.
 */
import { existsSync } from "node:fs";
import type { Attachment, IMessageSDK, Message } from "@photon-ai/imessage-kit";
import type { Channel, ChannelService, InboundMessage } from "../types.js";
import { normalizeHandle } from "../handles.js";
import { keyedQueue, splitText } from "./serial.js";

/** The part of Photon's SDK this channel uses. */
export type PhotonSDK = Pick<IMessageSDK, "getMessages" | "startWatching" | "stopWatching" | "send" | "close">;

export interface IMessageChannelOptions {
  sdk?: PhotonSDK;
  databasePath?: string;
  log?: (line: string) => void;
  /** How long to wait for image attachments to finish transferring. Default 10 s. */
  attachmentWaitMs?: number;
  /** Poll interval while waiting for attachments. Default 250 ms. */
  pollMs?: number;
}

/** Longest text sent in one iMessage; longer replies are split. */
export const MAX_IMESSAGE_CHARS = 1500;

export function createIMessageChannel(options: IMessageChannelOptions = {}): Channel {
  const log = options.log ?? ((line: string) => console.log(`[imessage] ${line}`));
  const waitMs = options.attachmentWaitMs ?? 10_000;
  const pollMs = options.pollMs ?? 250;
  // Per sender, only the attachment wait is queued, so handleInbound is called in arrival order.
  // The handler itself is not awaited: one slow turn must not hold up other people.
  const run = keyedQueue();
  let sdk: PhotonSDK | undefined = options.sdk;

  async function getSdk(): Promise<PhotonSDK> {
    if (sdk) return sdk;
    if (process.platform !== "darwin") throw new Error("The iMessage channel only runs on macOS. Use CHANNEL=dev elsewhere.");
    const { IMessageSDK } = await import("@photon-ai/imessage-kit");
    try {
      sdk = new IMessageSDK(options.databasePath ? { databasePath: options.databasePath } : {});
    } catch (err) {
      // Photon opens chat.db in its constructor, so a missing Full Disk Access fails here.
      throw new Error(fullDiskAccessMessage(options.databasePath, err), { cause: err });
    }
    return sdk;
  }

  async function refetch(sdk: PhotonSDK, m: Message): Promise<Message | undefined> {
    try {
      const scope = m.chatId ? { chatId: m.chatId } : { participant: m.participant ?? undefined };
      const rows = await sdk.getMessages({ ...scope, since: new Date(m.createdAt.getTime() - 1000), limit: 50 });
      return rows.find((r) => r.id === m.id);
    } catch {
      return undefined;
    }
  }

  /** Image paths of a message, waiting for transfers still in flight. */
  async function waitForImages(sdk: PhotonSDK, first: Message): Promise<string[]> {
    const deadline = Date.now() + waitMs;
    let m = first;
    for (;;) {
      const images = m.attachments.filter((a) => a.mimeType?.startsWith("image/"));
      const ready = images.filter(isReady).map((a) => a.localPath as string);
      const joinPending = m.hasAttachments && m.attachments.length === 0;
      const inFlight = images.some((a) => !isReady(a) && a.transferStatus !== "failed");
      if (!joinPending && !inFlight) return ready;
      if (Date.now() >= deadline) {
        log(`gave up waiting for attachments of ${m.id}; using ${ready.length} of ${images.length} image(s)`);
        return ready;
      }
      await sleep(pollMs);
      m = (await refetch(sdk, m)) ?? m;
    }
  }

  async function toInbound(sdk: PhotonSDK, m: Message): Promise<InboundMessage | undefined> {
    const text = (m.text ?? "").trim();
    const images = m.hasAttachments || m.attachments.length > 0 ? await waitForImages(sdk, m) : [];
    if (!text && images.length === 0) {
      log(`dropped ${m.id}: no text and no image`);
      return undefined;
    }
    return { id: m.id, handle: m.participant as string, text, images, at: m.createdAt, service: (m.service ?? "iMessage") as ChannelService };
  }

  return {
    name: "imessage",

    async start(onMessage) {
      const s = await getSdk();
      try {
        // One cheap read so a missing Full Disk Access fails here, with instructions, not later.
        await s.getMessages({ limit: 1 });
      } catch (err) {
        throw new Error(fullDiskAccessMessage(options.databasePath, err), { cause: err });
      }
      await s.startWatching({
        onDirectMessage: (m) => {
          try {
            if (!isDeliverable(m)) return;
            const failed = (err: unknown) => log(`handling ${m.id} failed: ${errorText(err)}`);
            run(normalizeHandle(m.participant as string), async () => {
              const inbound = await toInbound(s, m);
              if (inbound) Promise.resolve().then(() => onMessage(inbound)).catch(failed);
            }).catch(failed);
          } catch (err) {
            log(`watcher callback failed: ${errorText(err)}`);
          }
        },
        onError: (err) => log(`watcher error: ${err.message}`),
      });
      log("watching Messages for direct messages");
    },

    async send(handle, text) {
      const s = await getSdk();
      for (const part of splitText(text, MAX_IMESSAGE_CHARS)) {
        try {
          await s.send({ to: handle, text: part });
        } catch (err) {
          throw new Error(sendErrorMessage(handle, err), { cause: err });
        }
      }
    },

    // Typing indicators and tapbacks cannot be sent from the Mac's own Messages: AppleScript has no verb for them,
    // imessage-kit only reads reactions, and Spectrum's local provider makes typing a no-op and refuses reactions
    // ("requires remote iMessage", i.e. Photon's cloud). Kept as no-ops so the app already calls them.
    async typing() {},
    async react() {},

    async stop() {
      if (!sdk) return;
      const s = sdk;
      sdk = undefined;
      await s.stopWatching().catch(() => undefined);
      await s.close();
    },
  };
}

/** Rows the agent should never see: own sends, tapbacks, Focus auto-replies, system rows, group chats. */
export function isDeliverable(m: Message): boolean {
  if (m.isFromMe || m.reaction || m.isAutoReply || m.isSystem) return false;
  if (m.chatKind === "group" || !m.participant) return false;
  if (m.kind !== "text" && m.kind !== "unknown") return false;
  return Boolean(m.text?.trim()) || m.hasAttachments || m.attachments.length > 0;
}

function isReady(a: Attachment): boolean {
  if (!a.localPath || !existsSync(a.localPath)) return false;
  return a.transferStatus === "complete" || a.transferStatus === "unknown";
}

/** The app macOS checks permissions against: the terminal or IDE that runs node. */
function hostApp(): string {
  const names: Record<string, string> = {
    Apple_Terminal: "Terminal",
    "iTerm.app": "iTerm",
    vscode: "Visual Studio Code (or Cursor)",
    WarpTerminal: "Warp",
    ghostty: "Ghostty",
  };
  const term = process.env.TERM_PROGRAM;
  return term ? (names[term] ?? term) : "the terminal or IDE that runs node";
}

export function fullDiskAccessMessage(databasePath: string | undefined, err: unknown): string {
  const app = hostApp();
  return (
    `Cannot read the Messages database at ${databasePath ?? "~/Library/Messages/chat.db"} (${errorText(err)}). ` +
    `Grant Full Disk Access: open System Settings > Privacy & Security > Full Disk Access, click +, add ${app}, ` +
    `then quit and reopen ${app} and run the server again. Messages must also be signed in on this Mac.`
  );
}

export function sendErrorMessage(handle: string, err: unknown): string {
  const text = errorText(err);
  const app = hostApp();
  if (/-1743|not authori[sz]ed/i.test(text)) {
    return (
      `macOS blocked control of Messages.app (-1743). Grant Automation permission: open System Settings > ` +
      `Privacy & Security > Automation, find ${app}, and turn on Messages. Then retry. (${text})`
    );
  }
  if (/not running/i.test(text)) return `Messages.app is not running. Open Messages on this Mac, signed in as the agent. (${text})`;
  return `iMessage send to ${handle} failed: ${text}`;
}

/** The error message plus every nested cause, so codes like -1743 are not hidden. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let i = 0; e && i < 5; i++) {
    parts.push(e instanceof Error ? e.message : String(e));
    e = e instanceof Error ? e.cause : undefined;
  }
  return [...new Set(parts)].join(": ");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
