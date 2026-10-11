/**
 * Dev channel: a local HTTP server (and an optional stdin REPL) that stands in for iMessage.
 *
 *   POST /dev/message  {handle, text, images?}  -> {replies, since}   runs the app on one simulated text
 *   GET  /dev/outbox?handle=&since=             -> {messages, since}  texts sent after the cursor
 *
 * Requests need a local Host header (127.0.0.1, localhost, [::1]); POSTs need content-type application/json.
 * Default simulated people: Matt +15550000001 and Yadu +15550000002.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import * as readline from "node:readline";
import { normalizeHandle } from "../handles.js";
import type { Channel, InboundMessage } from "../types.js";
import { keyedQueue } from "./serial.js";

export const DEV_HANDLES = { matt: "+15550000001", yadu: "+15550000002" } as const;
const NAMES: Record<string, string> = { [DEV_HANDLES.matt]: "Matt", [DEV_HANDLES.yadu]: "Yadu" };
const OUTBOX_LIMIT = 500;
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export interface OutboxEntry {
  to: string;
  text: string;
  /** ISO timestamp. */
  at: string;
}
export interface OutboxPage {
  messages: OutboxEntry[];
  /** Cursor: pass it back as `since` to get only newer texts. */
  since: number;
}
export interface DevReply {
  /** Every text sent to the sender's handle while the app handled the message. */
  replies: string[];
  since: number;
}

export interface DevChannel extends Channel {
  /** Port actually bound (useful with `port: 0`). Valid after start() resolves. */
  readonly port: number;
  readonly url: string;
  /** Same as POST /dev/message, in process. */
  deliver(handle: string, text: string, images?: string[]): Promise<DevReply>;
  /** Same as GET /dev/outbox, in process. */
  outbox(handle?: string, since?: number): OutboxPage;
}

export interface DevChannelOptions {
  /** Default 7777. 0 picks a free port. */
  port?: number;
  host?: string;
  log?: (line: string) => void;
  /** Read simulated texts from stdin when it is a TTY. Default true. */
  repl?: boolean;
}

export function createDevChannel(options: DevChannelOptions = {}): DevChannel {
  const host = options.host ?? "127.0.0.1";
  const log = options.log ?? ((line: string) => console.log(line));
  // Texts from one handle are handled in order; different handles do not wait for each other.
  const run = keyedQueue();
  const sent: (OutboxEntry & { seq: number })[] = [];
  let seq = 0;
  let onMessage: ((message: InboundMessage) => Promise<void>) | undefined;
  let rl: readline.Interface | undefined;
  let busy = false;
  let boundPort = options.port ?? 7777;
  /** Inbound message ids to senders, for react(). */
  const reacted = new Map<string, string>();

  const server = createServer((req, res) => {
    route(req, res).catch((err) => reply(res, 500, { error: errorText(err) }));
  });

  function outbox(handle?: string, since = 0): OutboxPage {
    const who = handle ? normalizeHandle(handle) : undefined;
    const messages = sent
      .filter((m) => m.seq > since && (!who || normalizeHandle(m.to) === who))
      .map(({ to, text, at }) => ({ to, text, at }));
    return { messages, since: seq };
  }

  async function deliver(handle: string, text: string, images: string[] = []): Promise<DevReply> {
    const handler = onMessage;
    if (!handler) throw new Error("dev channel is not started");
    const paths = images.map((p) => resolve(p));
    const missing = paths.find((p) => !existsSync(p));
    if (missing) throw new BadRequest(`image not found: ${missing}`);
    return run(normalizeHandle(handle), async () => {
      const before = seq;
      const message: InboundMessage = { id: `dev-${randomUUID()}`, handle, text, images: paths, at: new Date(), service: "dev" };
      reacted.set(message.id, handle);
      if (reacted.size > OUTBOX_LIMIT) reacted.delete(reacted.keys().next().value!);
      await handler(message);
      const page = outbox(handle, before);
      return { replies: page.messages.map((m) => m.text), since: page.since };
    });
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Only local tools may talk to this: a foreign Host means DNS rebinding, and requiring JSON forces
    // a CORS preflight (which is never answered), so a web page cannot post texts as someone.
    if (!LOCAL_HOST.test(req.headers.host ?? "")) {
      return reply(res, 403, { error: "forbidden: Host must be 127.0.0.1, localhost or [::1]" });
    }
    if (req.method === "POST" && url.pathname === "/dev/message") {
      if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
        return reply(res, 403, { error: "forbidden: content-type must be application/json" });
      }
      let body: { handle?: unknown; text?: unknown; images?: unknown };
      try {
        body = JSON.parse(await readBody(req)) as typeof body;
      } catch {
        return reply(res, 400, { error: "body must be JSON: {handle, text, images?}" });
      }
      const { handle, text = "", images = [] } = body;
      if (typeof handle !== "string" || !handle.trim()) return reply(res, 400, { error: "handle is required" });
      if (typeof text !== "string") return reply(res, 400, { error: "text must be a string" });
      if (!Array.isArray(images) || images.some((i) => typeof i !== "string")) {
        return reply(res, 400, { error: "images must be an array of file paths" });
      }
      try {
        return reply(res, 200, await deliver(handle.trim(), text, images as string[]));
      } catch (err) {
        return reply(res, err instanceof BadRequest ? 400 : 500, { error: errorText(err), replies: [], since: seq });
      }
    }
    if (req.method === "GET" && url.pathname === "/dev/outbox") {
      const since = Number(url.searchParams.get("since") ?? 0);
      return reply(res, 200, outbox(url.searchParams.get("handle") ?? undefined, Number.isFinite(since) ? since : 0));
    }
    return reply(res, 404, { error: "routes: POST /dev/message {handle,text,images?}, GET /dev/outbox?handle=&since=" });
  }

  /** Prints a line without mangling what the REPL user is typing. */
  function print(line: string): void {
    if (rl) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
    log(line);
    if (rl && !busy) rl.prompt(true);
  }

  function startRepl(): void {
    let as: string = DEV_HANDLES.matt;
    let pending: string[] = [];
    const repl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `you (${as})> ` });
    rl = repl;
    // Without a listener readline swallows Ctrl-C; forward it so the process shuts down normally.
    repl.on("SIGINT", () => process.kill(process.pid, "SIGINT"));
    // After Enter the cursor is on a fresh line, so command output uses log() and then one prompt.
    const answer = (...lines: string[]) => {
      for (const line of lines) log(line);
      repl.prompt();
    };
    repl.on("line", (raw) => {
      const line = raw.trim();
      const [cmd, ...rest] = line.split(/\s+/);
      const arg = rest.join(" ");
      if (cmd === "/as" && arg) {
        as = DEV_HANDLES[arg.replace(/^@/, "").toLowerCase() as keyof typeof DEV_HANDLES] ?? normalizeHandle(arg);
        repl.setPrompt(`you (${as})> `);
        return answer(`now texting as ${label(as)}`);
      }
      if (cmd === "/image" && arg) {
        const path = resolve(arg.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
        if (!existsSync(path)) return answer(`no such file: ${path}`);
        pending.push(path);
        return answer(`attached ${path} to your next message`);
      }
      if (cmd === "/outbox") {
        const recent = outbox().messages.slice(-20);
        return answer(...recent.map((m) => `${new Date(m.at).toLocaleTimeString()}  agent -> ${label(m.to)}: ${m.text}`), `(${recent.length} shown)`);
      }
      if (line.startsWith("/")) {
        return answer("commands: /as <+1555...|matt|yadu>, /image <path>, /outbox; anything else is texted to the agent");
      }
      if (!line && pending.length === 0) return repl.prompt();
      const images = pending;
      pending = [];
      busy = true;
      deliver(as, line, images)
        .catch((err) => log(`error: ${errorText(err)}`))
        .finally(() => {
          busy = false;
          repl.prompt();
        });
    });
    answer(`Dev chat: you are ${label(as)}. /as yadu switches sender, /image <path> attaches a photo, /outbox shows sent texts.`);
  }

  return {
    name: "dev",
    get port() {
      return boundPort;
    },
    get url() {
      return `http://${host}:${boundPort}`;
    },
    deliver,
    outbox,

    async start(handler) {
      onMessage = handler;
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(boundPort, host, () => {
          server.off("error", reject);
          boundPort = (server.address() as AddressInfo).port;
          resolveListen();
        });
      });
      log(`dev channel listening on http://${host}:${boundPort} (POST /dev/message, GET /dev/outbox)`);
      if ((options.repl ?? true) && process.stdin.isTTY) startRepl();
    },

    async send(handle, text) {
      seq += 1;
      sent.push({ seq, to: handle, text, at: new Date().toISOString() });
      if (sent.length > OUTBOX_LIMIT) sent.splice(0, sent.length - OUTBOX_LIMIT);
      print(`agent -> ${label(handle)}: ${text}`);
    },

    // The REPL shows reactions; typing would only add noise between texts.
    async typing() {},
    async react(messageId, emoji) {
      const to = reacted.get(messageId);
      if (to) print(`agent reacted ${emoji} to ${label(to)}'s message`);
    },

    async stop() {
      rl?.close();
      rl = undefined;
      onMessage = undefined;
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

// ---------------------------------------------------------------------------
// Client helpers for scripts and tests
// ---------------------------------------------------------------------------

/** Texts the agent as `handle` through a running dev channel and returns its immediate replies. */
export async function devSend(baseUrl: string, handle: string, text: string, images?: string[]): Promise<DevReply> {
  const res = await fetch(new URL("/dev/message", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, text, images }),
  });
  const body = (await res.json()) as DevReply & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/** Texts sent after `since` (to `handle`, or to everyone when omitted). */
export async function devOutbox(baseUrl: string, handle?: string, since = 0): Promise<OutboxPage> {
  const url = new URL("/dev/outbox", baseUrl);
  if (handle) url.searchParams.set("handle", handle);
  url.searchParams.set("since", String(since));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as OutboxPage;
}

class BadRequest extends Error {}

function label(handle: string): string {
  const name = NAMES[normalizeHandle(handle)];
  return name ? `${handle} (${name})` : handle;
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(new Error("body too large"));
    });
    req.on("end", () => resolveBody(data));
    req.on("error", reject);
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
