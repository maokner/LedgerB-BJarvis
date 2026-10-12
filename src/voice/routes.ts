/**
 * Voice routes on the approval page's web server:
 *   POST /twilio/voice    Twilio's call webhook (signed), answers TwiML   WS   /twilio/media   the call's audio (upgrade)
 *   POST /twilio/status   Twilio's stream status callback (logged)
 *   POST /voice/webhook   xAI realtime.call.incoming (signed)            GET  /voice/calls   recent calls (admin)
 *   POST /voice/context   { instructions } for every call (admin)         POST /mcp           MCP, Streamable HTTP
 *   GET  /sse, POST /messages   MCP, legacy SSE transport. All MCP routes need `Authorization: Bearer <MCP_TOKEN>`.
 * Admin routes need the header `x-agentsign-admin: <ADMIN_TOKEN>`.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { McpHandler } from "./mcp.js";
import type { TwilioVoice } from "./twilio.js";
import type { Voice } from "./webhook.js";

const MAX_BODY = 256 * 1024;

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    if ((size += chunk.length) > MAX_BODY) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type Routes = (req: IncomingMessage, res: ServerResponse, path: string) => Promise<boolean>;
/** A websocket upgrade; true when taken. */
export type Upgrades = (req: IncomingMessage, socket: Socket, head: Buffer, path: string) => boolean;

export interface VoiceRouteOptions {
  voice?: Voice;
  twilio?: TwilioVoice;
  mcp?: McpHandler;
  adminToken?: string;
  mcpToken?: string;
  /** Where Twilio reaches this server; the signature covers the exact URL it called. */
  publicUrl?: string;
}

export function voiceRoutes(o: VoiceRouteOptions): Routes {
  return async (req, res, path) => {
    const json = (status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
    const admin = () => !!o.adminToken && same(String(req.headers["x-agentsign-admin"] ?? ""), o.adminToken);
    if (path === "/mcp" || path === "/sse" || path === "/messages") {
      if (!o.mcp || !o.mcpToken) return json(404, { error: "MCP is off" }), true;
      if (!same(String(req.headers.authorization ?? ""), `Bearer ${o.mcpToken}`)) return json(401, { error: "unauthorized" }), true;
      if (path === "/sse") return req.method === "GET" ? await o.mcp.sse(req, res) : json(405, { error: "GET only" }), true;
      const raw = req.method === "POST" ? await readBody(req) : "";
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        return json(400, { error: "not JSON" }), true;
      }
      await (path === "/mcp" ? o.mcp.http(req, res, body) : o.mcp.message(req, res, body));
      return true;
    }
    if (path.startsWith("/twilio/")) {
      if (!o.twilio) return json(404, { error: "twilio is off" }), true;
      if (req.method !== "POST") return json(405, { error: "POST only" }), true;
      const body = await readBody(req);
      if (body === undefined) return json(413, { error: "too large" }), true;
      if (path === "/twilio/voice") {
        const url = `${(o.publicUrl ?? "").replace(/\/$/, "")}${req.url ?? path}`;
        const r = o.twilio.webhook(url, req.headers, body);
        res.writeHead(r.status, { "content-type": `${r.type}; charset=utf-8`, "cache-control": "no-store" }).end(r.body);
        return true;
      }
      if (path === "/twilio/status") return res.writeHead(204).end(), true;
      return json(404, { error: "not found" }), true;
    }
    if (!path.startsWith("/voice/")) return false;
    const route = `${req.method} ${path}`;
    if (route === "POST /voice/webhook") {
      if (!o.voice) return json(404, { error: "voice is off" }), true;
      const body = await readBody(req);
      if (body === undefined) return json(413, { error: "too large" }), true;
      const result = o.voice.webhook(req.headers, body);
      return json(result.status, result.body), true;
    }
    if (route === "GET /voice/calls" || route === "POST /voice/context") {
      if (!o.voice && !o.twilio) return json(404, { error: "voice is off" }), true;
      if (!admin()) return json(o.adminToken ? 401 : 503, { error: o.adminToken ? "unauthorized" : "ADMIN_TOKEN is not set" }), true;
      const context = () => o.voice?.context() ?? o.twilio?.context() ?? "";
      if (route === "GET /voice/calls") {
        const calls = [...(o.twilio?.calls() ?? []), ...(o.voice?.calls() ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
        return json(200, { calls, context: context() }), true;
      }
      const raw = await readBody(req);
      let instructions: unknown;
      try {
        instructions = (JSON.parse(raw ?? "") as { instructions?: unknown }).instructions;
      } catch {}
      if (typeof instructions !== "string") return json(400, { error: 'send JSON { "instructions": "..." }' }), true;
      const text = instructions.slice(0, 8000);
      let updated = 0;
      if (o.voice) updated += await o.voice.setContext(text);
      else o.twilio?.setContext(text);
      if (o.twilio) updated += await o.twilio.refresh();
      return json(200, { ok: true, liveCallsUpdated: updated }), true;
    }
    return json(404, { error: "not found" }), true;
  };
}

/** The websocket upgrades the voice routes take: Twilio's media stream. */
export function voiceUpgrades(o: Pick<VoiceRouteOptions, "twilio">): Upgrades {
  return (req, socket, head, path) => {
    if (path !== "/twilio/media" || !o.twilio) return false;
    o.twilio.upgrade(req, socket, head);
    return true;
  };
}
