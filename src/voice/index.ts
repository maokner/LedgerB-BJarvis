/** Phone calls from env: the webhook path (VOICE_WEBHOOK_SECRET) and the MCP path (MCP_TOKEN), as web routes. */
import { randomBytes } from "node:crypto";
import type { AppVoiceHooks } from "../app.js";
import { createMcpHandler } from "./mcp.js";
import { voiceRoutes, type Routes } from "./routes.js";
import { DEFAULT_VOICE } from "./session.js";
import { createVoice } from "./webhook.js";

export function setupVoice(o: { app: AppVoiceHooks; apiKey: string; publicUrl: string; dev: boolean; log: (line: string) => void; env?: NodeJS.ProcessEnv }): Routes {
  const env = o.env ?? process.env;
  const { db } = o.app.deps;
  const secret = env.VOICE_WEBHOOK_SECRET || undefined;
  if (!secret) o.log(o.dev ? "voice: VOICE_WEBHOOK_SECRET unset, UNSIGNED call webhooks are accepted (dev channel only)" : "voice: VOICE_WEBHOOK_SECRET unset, the call webhook is off");
  const voice = createVoice({ app: o.app, apiKey: o.apiKey, secret, allowUnsigned: o.dev, voice: env.VOICE || DEFAULT_VOICE, log: o.log });
  // A generated MCP token is kept in the DB so the console agent's header survives restarts.
  let mcpToken = env.MCP_TOKEN || db.setting("mcp_token");
  if (!mcpToken) db.setSetting("mcp_token", (mcpToken = randomBytes(24).toString("base64url")));
  o.log(`voice: call webhook ${o.publicUrl}/voice/webhook, MCP server ${o.publicUrl}/mcp (Authorization: Bearer ${mcpToken})${env.ADMIN_TOKEN ? "" : ", ADMIN_TOKEN unset so /voice/context and /voice/calls are off"}`);
  return voiceRoutes({ voice, mcp: createMcpHandler(o.app, o.log), adminToken: env.ADMIN_TOKEN || undefined, mcpToken });
}
