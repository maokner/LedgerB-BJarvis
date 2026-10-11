/** Entry point: env, DB, devices, channel, model, app. */
import { config } from "dotenv";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModel, DEFAULT_MODEL } from "./agent/xai.js";
import { createApp } from "./app.js";
import { createCalendar } from "./calendar/google.js";
import { createDevChannel, createIMessageChannel, createTelegramChannel } from "./channels/index.js";
import { openDb } from "./db.js";
import { createBaseChain } from "./chain.js";
import { combineDeviceManagers, createDeviceManager, createEthDeviceManager, createRemoteDeviceManager, parseDevicesEnv } from "./device/index.js";
import { baseMoney, demoMoney } from "./money.js";
import type { Channel } from "./types.js";
import { startWebServer, type WebServer } from "./web/server.js";
import { setupVoice } from "./voice/index.js";
import type { Routes } from "./voice/routes.js";

config({ quiet: true });
config({ path: join(homedir(), ".grok", ".env"), quiet: true });

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const flag = process.argv.indexOf("--channel");
const telegramToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
// Telegram is the default once a bot token is set; iMessage otherwise.
const channelName = (flag >= 0 ? process.argv[flag + 1] : undefined) || process.env.CHANNEL || (telegramToken ? "telegram" : "imessage");
if (channelName === "telegram" && !telegramToken) {
  console.error("CHANNEL=telegram needs TELEGRAM_BOT_TOKEN. Create a bot with @BotFather (/newbot) and put its token in .env.");
  process.exit(1);
}
const apiKey = process.env.XAI_API_KEY;
if (!apiKey) {
  console.error("XAI_API_KEY is missing. Put it in .env or ~/.grok/.env.");
  process.exit(1);
}

const db = openDb(process.env.DB_PATH || "data/agentsign.db");
// eth (default): Ledger's Ethereum app over USB and real ETH on Base. agentsign: the custom app (Speculos or USB) and demo money.
const mode = process.env.DEVICE_MODE || "eth";
if (mode !== "eth" && mode !== "agentsign") {
  console.error(`Unknown DEVICE_MODE "${mode}". Use eth or agentsign.`);
  process.exit(1);
}
const devices = parseDevicesEnv(process.env.DEVICES ?? "hid");
if (mode === "eth" && devices.some((d) => d !== "hid")) log("DEVICE_MODE=eth only uses USB devices; ignoring Speculos entries in DEVICES");
// eth mode: USB on this Mac, raced against the approval page (PUBLIC_URL/sign/<token>) on any computer with the Ledger.
const webPort = Number(process.env.WEB_PORT || 7788);
const publicUrl = process.env.PUBLIC_URL || `http://127.0.0.1:${webPort}`;
const remote = mode === "eth" ? createRemoteDeviceManager({ db, publicUrl, log }) : undefined;
const deviceManager = remote ? combineDeviceManagers([createEthDeviceManager({ log }), remote]) : createDeviceManager({ devices, log });
let web: WebServer | undefined;
// Google Calendar, phone call and MCP routes ride on the approval page; the latter are set once the app exists.
let voiceRoutes: Routes | undefined;
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
if ((googleClientId || googleClientSecret) && !(googleClientId && googleClientSecret)) {
  console.error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET go together. See \"Google Calendar\" in README.md.");
  process.exit(1);
}
if (googleClientId && !remote) log("google calendar: needs the web server (DEVICE_MODE=eth), so it is off");
const calendar = createCalendar({
  db,
  google: googleClientId && googleClientSecret && remote ? { clientId: googleClientId, clientSecret: googleClientSecret, publicUrl } : undefined,
  notify: async (accountId, text) => {
    const handle = db.primaryHandle(accountId);
    if (handle) await channel.send(handle, text);
  },
  log,
});
if (remote) {
  try {
    web = await startWebServer({
      db, remote, port: webPort, host: process.env.WEB_HOST || "127.0.0.1", log,
      routes: async (req, res, path) => (await calendar.routes(req, res, path)) || (voiceRoutes ? voiceRoutes(req, res, path) : false),
    });
    await web.warm();
  } catch (err) {
    console.error(`Cannot start the approval page on port ${webPort}: ${(err as Error).message}`);
    process.exit(1);
  }
  log(`approval page on http://127.0.0.1:${web.port}, links point to ${publicUrl}`);
  // WebHID only works in a secure context: https, or this Mac's own localhost.
  if (!/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(`${publicUrl}/`)) log(`PUBLIC_URL is not https, so approval links only work on this Mac. Use ngrok (ngrok http ${webPort}).`);
  if (calendar.available) log(`google calendar: on, redirect URI ${publicUrl}/google/callback (must be listed on the OAuth client)`);
  else log("google calendar: off (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to let owners connect theirs)");
}
const money = mode === "eth" ? baseMoney(createBaseChain({ rpcUrl: process.env.BASE_RPC_URL })) : demoMoney();
let channel: Channel;
if (channelName === "dev") channel = createDevChannel({ port: Number(process.env.DEV_PORT || 7777), log });
else if (channelName === "imessage") channel = createIMessageChannel({ log });
else if (channelName === "telegram") channel = createTelegramChannel({ token: telegramToken!, log: (line) => log(`[telegram] ${line}`) });
else {
  console.error(`Unknown channel "${channelName}". Use telegram, imessage or dev.`);
  process.exit(1);
}
const model = createModel({ apiKey, model: process.env.XAI_MODEL || DEFAULT_MODEL, baseUrl: process.env.XAI_BASE_URL });
const app = createApp({ db, deviceManager, channel, model, log, money, calendar });
if (web) voiceRoutes = setupVoice({ app, apiKey, publicUrl, dev: channelName === "dev", log });
else log("voice: phone calls and MCP need the web server (DEVICE_MODE=eth)");

try {
  await channel.start(app.handleInbound);
} catch (err) {
  console.error(`Cannot start the ${channel.name} channel: ${(err as Error).message}`);
  process.exit(1);
}
log(`AgentSign listening on ${channel.name} (mode ${mode}, model ${process.env.XAI_MODEL || DEFAULT_MODEL}, devices ${process.env.DEVICES ?? "hid"})`);

let stopping = false;
async function shutdown(): Promise<void> {
  log("stopping (signal received)");
  if (stopping) return process.exit(1);
  stopping = true;
  log("shutting down");
  await channel.stop().catch((err) => log(`channel stop: ${(err as Error).message}`));
  await app.close();
  await deviceManager.close().catch((err: unknown) => log(`device stop: ${(err as Error).message}`));
  await web?.close();
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
