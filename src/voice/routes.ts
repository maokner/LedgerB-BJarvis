/**
 * Voice routes on the approval page's web server:
 *   POST /voice/webhook   xAI realtime.call.incoming (signed)       GET  /voice/calls   recent calls (admin)
 *   POST /voice/context   { instructions } for every call (admin)    POST /mcp           MCP, Streamable HTTP
 *   GET  /sse, POST /messages   MCP, legacy SSE transport. All MCP routes need `Authorization: Bearer <MCP_TOKEN>`.
 * Admin routes need the header `x-agentsign-admin: <ADMIN_TOKEN>`.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpHandler } from "./mcp.js";
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

export function voiceRoutes(o: {
  voice?: Voice;
  mcp?: McpHandler;
  adminToken?: string;
  mcpToken?: string;
}): Routes {
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
    if (!path.startsWith("/voice/")) return false;
    if (!o.voice) return json(404, { error: "voice is off" }), true;
    const route = `${req.method} ${path}`;
    if (route === "POST /voice/webhook") {
      const body = await readBody(req);
      if (body === undefined) return json(413, { error: "too large" }), true;
      const result = o.voice.webhook(req.headers, body);
      return json(result.status, result.body), true;
    }
    if (route === "GET /voice/calls" || route === "POST /voice/context") {
      if (!admin()) return json(o.adminToken ? 401 : 503, { error: o.adminToken ? "unauthorized" : "ADMIN_TOKEN is not set" }), true;
      if (route === "GET /voice/calls") return json(200, { calls: o.voice.calls(), context: o.voice.context() }), true;
      const raw = await readBody(req);
      let instructions: unknown;
      try {
        instructions = (JSON.parse(raw ?? "") as { instructions?: unknown }).instructions;
      } catch {}
      if (typeof instructions !== "string") return json(400, { error: 'send JSON { "instructions": "..." }' }), true;
      return json(200, { ok: true, liveCallsUpdated: await o.voice.setContext(instructions.slice(0, 8000)) }), true;
    }
    return json(404, { error: "not found" }), true;
  };
}
