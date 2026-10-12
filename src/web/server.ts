/**
 * The approval page behind every link (node:http, no framework). Routes, all keyed by the 64-hex token:
 *   GET  /sign/:token          the page            GET  /sign/:token/job     what to sign (JSON)
 *   GET  /sign/:token/state    status for polling  POST /sign/:token/result  { kind, value } from the Ledger
 *   POST /sign/:token/reject   rejected on device  GET  /ledger.js           the browser bundle
 *   POST /sign/:token/log      { lines } from the page's step log, printed as "page <token8>: <line>" (1 per second, pending jobs only)
 * Plus optional extra routes (Google Calendar, src/calendar/google.ts; phone calls and MCP, src/voice/routes.ts), tried first,
 * and websocket upgrades (Twilio media streams, src/voice/twilio.ts); an upgrade nobody takes is closed.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { txLink } from "../chain.js";
import type { Db } from "../db.js";
import type { EthAnswer } from "../device/eth-tx.js";
import { ethRequest } from "../device/eth-verify.js";
import type { RemoteDeviceManager } from "../device/remote.js";
import { ACTION_TITLES } from "../types.js";
import type { Routes, Upgrades } from "../voice/routes.js";
import { buildClient } from "./bundle.js";
import { SECURITY_HEADERS as SECURITY } from "./headers.js";
import { notFoundPage, page } from "./page.js";


export interface WebServer {
  port: number;
  /** Builds the browser bundle now, so the first visitor does not wait (and a broken build shows at start). */
  warm(): Promise<void>;
  close(): Promise<void>;
}

export async function startWebServer(options: { db: Db; remote: RemoteDeviceManager; port: number; host?: string; log?: (line: string) => void; routes?: Routes; upgrades?: Upgrades }): Promise<WebServer> {
  const { db, remote } = options;
  const log = options.log ?? (() => {});
  let bundle: Promise<string> | undefined;
  const lastLog = new Map<string, number>();
  const client = () => (bundle ??= buildClient().catch((err: unknown) => ((bundle = undefined), Promise.reject(err))));

  /** The action's own status (actions table) is the truth; the job's status covers rows from before a restart. */
  function state(token: string) {
    const job = remote.job(token)!;
    const row = db.action(job.action.id);
    const fallback = { pending: "pending", signed: "approved", rejected: "rejected", expired: "expired", superseded: "pending" } as const;
    const status = row?.status ?? fallback[job.status];
    // Superseded while the action is still pending: a USB Ledger on this Mac shows the request, so the page waits for it.
    const onDevice = job.status === "superseded" && status === "pending";
    return { status, code: job.action.code, txHash: row?.tx_hash ?? undefined, link: row?.tx_hash ? txLink(row.tx_hash) : undefined, ...(onDevice ? { onDevice } : {}) };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, type: string, body: string): void => void res.writeHead(status, { ...SECURITY, "content-type": type }).end(body);
    const json = (status: number, body: unknown) => send(status, "application/json; charset=utf-8", JSON.stringify(body));
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (options.routes && (await options.routes(req, res, path))) return;
    if (req.method === "GET" && path === "/ledger.js") return send(200, "text/javascript; charset=utf-8", await client());
    const m = /^\/sign\/([0-9a-f]{64})(\/job|\/state|\/result|\/reject|\/log)?\/?$/.exec(path);
    const job = m && remote.job(m[1]!);
    if (!m || !job) return m && !m[2] ? send(404, "text/html; charset=utf-8", notFoundPage()) : json(404, { ok: false, error: "This link is not valid." });
    const token = m[1]!;
    const route = `${req.method} ${m[2] ?? ""}`;
    if (route === "GET ") return send(200, "text/html; charset=utf-8", page({ action: job.action, tag: job.tag, status: state(token).status }));
    if (route === "GET /state") return json(200, state(token));
    if (route === "GET /job") {
      remote.opened(token);
      const { action } = job;
      return json(200, {
        code: action.code, title: ACTION_TITLES[action.code], fields: action.fields, meta: action.meta,
        tag: job.tag, address: job.pubkey, request: ethRequest(action, "page"), status: job.status, expiresAt: job.expires_at,
      });
    }
    if (req.method === "POST" && m[2] === "/log") {
      if (job.status !== "pending") return json(200, { ok: true, ignored: true });
      if (Date.now() - (lastLog.get(token) ?? 0) < 1000) return json(429, { ok: false, error: "Too fast." });
      lastLog.set(token, Date.now());
      const body = await readJson(req);
      const lines = (body as { lines?: unknown } | undefined)?.lines;
      if (!Array.isArray(lines)) return json(400, { ok: false, error: "Bad request." });
      for (const line of lines.slice(0, 30)) log(`page ${token.slice(0, 8)}: ${String(line).replace(/[^\x20-\x7e]/g, "?").slice(0, 300)}`);
      return json(200, { ok: true });
    }
    if (req.method === "POST" && (m[2] === "/result" || m[2] === "/reject")) {
      // A JSON content type makes cross-site posts need a CORS preflight, which this server never grants.
      if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return json(415, { ok: false, error: "Send JSON." });
      const body = await readJson(req);
      if (body === undefined) return json(400, { ok: false, error: "Bad request." });
      const { kind, value } = body as { kind?: unknown; value?: unknown };
      const valid = (kind === "address" || kind === "tx" || kind === "message") && typeof value === "string";
      if (m[2] === "/result" && !valid) return json(400, { ok: false, error: "Bad request." });
      const claimed = typeof (body as { address?: unknown }).address === "string" ? (body as { address: string }).address : undefined;
      const result = m[2] === "/reject" ? remote.reject(token) : remote.submit(token, { kind, value } as EthAnswer, claimed);
      return json(result.ok ? 200 : result.status === "pending" ? 422 : 409, result);
    }
    return json(405, { ok: false, error: "Not allowed." });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`web: ${req.method} ${req.url?.slice(0, 18)}... failed: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end('{"ok":false,"error":"Something went wrong."}');
    });
  });
  server.on("upgrade", (req, socket: Socket, head: Buffer) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (options.upgrades?.(req, socket, head, path)) return;
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    warm: async () => void (await client()),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** The request body as JSON, at most 64 KB. Undefined when it is not JSON. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 65_536) return undefined;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}
