/**
 * Phone calls from env, as web routes and websocket upgrades:
 *   - Twilio + OpenAI realtime (OPENAI_API_KEY, TWILIO_AUTH_TOKEN): the number Matt calls; see voice/TWILIO.md
 *   - the xAI webhook path (VOICE_WEBHOOK_SECRET) and the MCP path (MCP_TOKEN) for an xAI console agent
 */
import { randomBytes } from "node:crypto";
import type { AppVoiceHooks } from "../app.js";
import type { PhoneLinks } from "../phone.js";
import { createMcpHandler } from "./mcp.js";
import { voiceRoutes, voiceUpgrades, type Routes, type Upgrades } from "./routes.js";
import { DEFAULT_VOICE } from "./session.js";
import { createTwilioVoice, type TwilioVoice } from "./twilio.js";
import { createVoice } from "./webhook.js";

export interface VoiceSetup {
  routes: Routes;
  upgrades: Upgrades;
  twilio?: TwilioVoice;
  close(): Promise<void>;
}

export function setupVoice(o: { app: AppVoiceHooks; apiKey: string; publicUrl: string; dev: boolean; phone?: PhoneLinks; log: (line: string) => void; env?: NodeJS.ProcessEnv }): VoiceSetup {
  const env = o.env ?? process.env;
  const { db } = o.app.deps;
  const secret = env.VOICE_WEBHOOK_SECRET || undefined;
  if (!secret) o.log(o.dev ? "voice: VOICE_WEBHOOK_SECRET unset, UNSIGNED call webhooks are accepted (dev channel only)" : "voice: VOICE_WEBHOOK_SECRET unset, the xAI call webhook is off");
  const voice = createVoice({ app: o.app, apiKey: o.apiKey, secret, allowUnsigned: o.dev, voice: env.VOICE || DEFAULT_VOICE, log: o.log });
  // A generated MCP token is kept in the DB so the console agent's header survives restarts.
  let mcpToken = env.MCP_TOKEN || db.setting("mcp_token");
  if (!mcpToken) db.setSetting("mcp_token", (mcpToken = randomBytes(24).toString("base64url")));
  o.log(`voice: xAI call webhook ${o.publicUrl}/voice/webhook, MCP server ${o.publicUrl}/mcp (Authorization: Bearer ${mcpToken})${env.ADMIN_TOKEN ? "" : ", ADMIN_TOKEN unset so /voice/context and /voice/calls are off"}`);

  let twilio: TwilioVoice | undefined;
  const openaiKey = env.OPENAI_API_KEY?.trim();
  if (openaiKey && o.phone) {
    const authToken = env.TWILIO_AUTH_TOKEN?.trim() || undefined;
    twilio = createTwilioVoice({
      app: o.app, phone: o.phone, openaiKey, authToken, allowUnsigned: o.dev, publicUrl: o.publicUrl,
      model: env.OPENAI_REALTIME_MODEL?.trim(), voice: env.OPENAI_VOICE?.trim(), log: o.log,
    });
    if (!authToken) o.log(o.dev ? "twilio: TWILIO_AUTH_TOKEN unset, UNSIGNED call webhooks are accepted (dev channel only)" : "twilio: TWILIO_AUTH_TOKEN unset, so the call webhook refuses every call");
    o.log(`twilio: calls ${o.phone.number ? `to ${o.phone.number} ` : ""}answered at ${o.publicUrl}/twilio/voice, audio on ${twilio.mediaUrl}, ${twilio.model} speaking as ${twilio.voice}`);
  } else o.log("twilio: off (set OPENAI_API_KEY, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER to let owners call Jarvis; see voice/TWILIO.md)");

  const options = { voice, twilio, mcp: createMcpHandler(o.app, o.log), adminToken: env.ADMIN_TOKEN || undefined, mcpToken, publicUrl: o.publicUrl };
  return { routes: voiceRoutes(options), upgrades: voiceUpgrades(options), twilio, close: async () => void (await twilio?.close()) };
}
