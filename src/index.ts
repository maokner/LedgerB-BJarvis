/** Entry point: env, DB, devices, channel, model, app. */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createModel, DEFAULT_MODEL } from "./agent/xai.js";
import { createApp } from "./app.js";
import { createCalendar } from "./calendar/google.js";
import { createDevChannel, createIMessageChannel, createPhotonChannel, createTelegramChannel } from "./channels/index.js";
import { openDb } from "./db.js";
import { createBaseChain, formatUsdc, USDC } from "./chain.js";
import { combineDeviceManagers, createDeviceManager, createEthDeviceManager, createRemoteDeviceManager, parseDevicesEnv } from "./device/index.js";
import { createAmazonMerchant } from "./amazon/browser.js";
import { alwaysOrderedMerchant, demoMerchant, type Merchant } from "./merchant.js";
import { baseMoney, demoMoney, formatEth } from "./money.js";
import { createPhoneLinks, PHONE_RE, type PhoneLinks } from "./phone.js";
import { createPurchases, type Purchases } from "./purchases.js";
import { createDoorDashProvider } from "./food/browser.js";
import { createDoorDashCli } from "./food/cli.js";
import { demoDoorDash } from "./food/demo.js";
import { createFood, type Food } from "./food/food.js";
import type { FoodProvider } from "./food/provider.js";
import { createTreasury, type Treasury } from "./treasury.js";
import type { Channel } from "./types.js";
import { startWebServer, type WebServer } from "./web/server.js";
import { setupVoice, type VoiceSetup } from "./voice/index.js";
import { normalizeHandle } from "./handles.js";

config({ quiet: true });
config({ path: join(homedir(), ".grok", ".env"), quiet: true });

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const flag = process.argv.indexOf("--channel");
const telegramToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
const spectrumId = process.env.SPECTRUM_PROJECT_ID?.trim();
const spectrumSecret = process.env.SPECTRUM_PROJECT_SECRET?.trim();
// Photon's hosted iMessage once a Spectrum project is set, else Telegram once a bot token is set, else the Mac's iMessage.
const channelName = (flag >= 0 ? process.argv[flag + 1] : undefined) || process.env.CHANNEL || (spectrumId ? "photon" : telegramToken ? "telegram" : "imessage");
if (channelName === "telegram" && !telegramToken) {
  console.error("CHANNEL=telegram needs TELEGRAM_BOT_TOKEN. Create a bot with @BotFather (/newbot) and put its token in .env.");
  process.exit(1);
}
if (channelName === "photon" && !(spectrumId && spectrumSecret)) {
  console.error("CHANNEL=photon needs SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET. Copy them from the Photon dashboard (project Settings) into .env.");
  process.exit(1);
}
// The prompts (src/agent/bot.ts) name the chat and say how people join by the channel that runs.
process.env.CHANNEL = channelName;
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
let voice: VoiceSetup | undefined;
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
if ((googleClientId || googleClientSecret) && !(googleClientId && googleClientSecret)) {
  console.error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET go together. See the Google Calendar section in DESIGN.md.");
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
      routes: async (req, res, path) => (await calendar.routes(req, res, path)) || (voice ? voice.routes(req, res, path) : false),
      upgrades: (req, socket, head, path) => voice?.upgrades(req, socket, head, path) ?? false,
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
else if (channelName === "photon") {
  // PHOTON_NUMBER: the line people text, as Jarvis tells them. Each person's chat id is kept so a restart can still text them.
  const number = process.env.PHOTON_NUMBER?.trim() || undefined;
  if (!number) log("photon: PHOTON_NUMBER unset, so Jarvis cannot tell people which number to text");
  channel = createPhotonChannel({
    projectId: spectrumId!,
    projectSecret: spectrumSecret!,
    number,
    log: (line) => log(`[photon] ${line}`),
    spaces: { get: (handle) => db.setting(`photon_space:${handle}`), set: (handle, id) => db.setSetting(`photon_space:${handle}`, id) },
  });
} else {
  console.error(`Unknown channel "${channelName}". Use photon, telegram, imessage or dev.`);
  process.exit(1);
}
const model = createModel({ apiKey, model: process.env.XAI_MODEL || DEFAULT_MODEL, baseUrl: process.env.XAI_BASE_URL });
// Set up once by commerce(), shared by Amazon purchases and food orders; declared before the setup calls below run.
let commerceShared: { treasury: Treasury; operator: { name: string; handle: () => string | undefined } } | undefined;
const sendOnly: Pick<Channel, "send"> = { send: (handle, text) => channel.send(handle, text) };
const purchases = await setupPurchases();
const food = await setupFood();
const phone = setupPhone();
const app = createApp({ db, deviceManager, channel, model, log, money, calendar, purchases, phone, food });
if (web) voice = setupVoice({ app, apiKey, publicUrl, dev: channelName === "dev", phone, log });
else log("voice: phone calls and MCP need the web server (DEVICE_MODE=eth)");

try {
  await channel.start(app.handleInbound);
} catch (err) {
  console.error(`Cannot start the ${channel.name} channel: ${(err as Error).message}`);
  process.exit(1);
}
log(`AgentSign listening on ${channel.name} (mode ${mode}, model ${process.env.XAI_MODEL || DEFAULT_MODEL}, devices ${process.env.DEVICES ?? "hid"})`);

/** The shared treasury and operator, set up once for whichever of Amazon and food comes first. */
function commerce(what: string): NonNullable<typeof commerceShared> {
  if (commerceShared) return commerceShared;
  const key = process.env.TREASURY_PRIVATE_KEY?.trim();
  const address = process.env.TREASURY_ADDRESS?.trim();
  if (!key && !address) {
    console.error(`${what} needs a treasury (TREASURY_ADDRESS or TREASURY_PRIVATE_KEY). See "Buying on Amazon" in DESIGN.md.`);
    process.exit(1);
  }
  const chain = createBaseChain({ rpcUrl: process.env.BASE_RPC_URL });
  let treasury: Treasury;
  try {
    treasury = createTreasury({ privateKey: key, address }, chain);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const operatorTag = process.env.OPERATOR_TAG?.trim().toLowerCase();
  const operatorName = process.env.OPERATOR_NAME?.trim() || (operatorTag ? operatorTag.replace(/^@/, "").replace(/^./, (c) => c.toUpperCase()) : "the operator");
  const operator = { name: operatorName, handle: () => (operatorTag ? db.primaryHandle(db.accountByTag(operatorTag.startsWith("@") ? operatorTag : `@${operatorTag}`)?.id ?? -1) : undefined) };
  Promise.all([treasury.balanceWei(), chain.tokenBalance(USDC.address, treasury.address)]).then(
    ([wei, usdc]) => log(`treasury ${treasury.address} holds ${formatUsdc(usdc)} USDC and ${formatEth(wei)} ETH${key ? "" : " (receive only, refunds by hand)"}`),
    (err: unknown) => log(`could not read the treasury balance: ${(err as Error).message}`),
  );
  return (commerceShared = { treasury, operator });
}

/** A per-order cap from the environment, in cents; exits on a bad value. */
function usdLimit(name: string, fallbackUsd: number, maxUsd: number): number {
  const usd = Number(process.env[name] || fallbackUsd);
  if (!(usd > 0 && usd <= maxUsd)) {
    console.error(`${name} must be a dollar amount between 0 and ${maxUsd}, not "${process.env[name]}".`);
    process.exit(1);
  }
  return Math.round(usd * 100);
}

/** A Playwright storage state from its env var (JSON, or base64 of it, as fly secrets carry it) or a file path. */
function storageState(inline: string | undefined, path: string | undefined): string {
  let state = inline?.trim() ?? "";
  if (!state && path?.trim()) state = readFileSync(path.trim(), "utf8");
  return state && !state.startsWith("{") ? Buffer.from(state, "base64").toString("utf8") : state;
}

/** 1, true or yes. */
function isSet(v: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(v ?? "");
}

/**
 * Buying on Amazon with USDC (src/purchases.ts): on when a store is set (AMAZON_MERCHANT, or an Amazon session) in
 * Ethereum mode, with a treasury. The store is the operator's own Amazon account through a browser
 * (AMAZON_STORAGE_STATE, see "Buying on Amazon" in DESIGN.md), a mock that confirms every order, or a built-in demo
 * catalog (AMAZON_MERCHANT=demo) to try the flow without touching Amazon.
 */
async function setupPurchases(): Promise<Purchases | undefined> {
  const kind = process.env.AMAZON_MERCHANT?.trim() || (process.env.AMAZON_STORAGE_STATE || process.env.AMAZON_STORAGE_STATE_PATH ? "browser" : "");
  if (!kind) {
    log("amazon: off (set AMAZON_MERCHANT and a treasury, TREASURY_ADDRESS or TREASURY_PRIVATE_KEY, to let owners buy things)");
    return undefined;
  }
  if (mode !== "eth") {
    log("amazon: needs DEVICE_MODE=eth (buyers pay the treasury in USDC), so it is off");
    return undefined;
  }
  const { treasury, operator } = commerce("Buying on Amazon");
  const limitCents = usdLimit("PURCHASE_LIMIT_USD", 20, 100);
  const amazonLog = (line: string) => log(`[amazon] ${line}`);
  let merchant: Merchant & { warm?(): Promise<void> };
  if (kind === "demo") merchant = demoMerchant();
  else if (kind === "mock") {
    // Every order is confirmed, nothing is bought: real search and prices from amazon.com (no session needed), the
    // demo catalog when amazon.com cannot be searched (captcha, no Chromium), a generated order number at confirm.
    const live = createAmazonMerchant({ storageState: '{"cookies":[],"origins":[]}', limitCents, log: amazonLog });
    const demo = demoMerchant();
    merchant = alwaysOrderedMerchant({
      log: amazonLog,
      search: async (query, limit) => {
        try {
          const found = await live.search(query, limit);
          if (found.length) return found;
        } catch (err) {
          amazonLog(`live search failed (${(err as Error).message}); using the demo catalog`);
        }
        return demo.search(query, limit);
      },
    });
    const closeLive = merchant.close;
    merchant.close = async () => {
      await closeLive();
      await live.close();
    };
  } else if (kind === "browser") {
    try {
      merchant = createAmazonMerchant({ storageState: storageState(process.env.AMAZON_STORAGE_STATE, process.env.AMAZON_STORAGE_STATE_PATH), limitCents, dryRun: isSet(process.env.AMAZON_DRY_RUN), log: amazonLog });
    } catch (err) {
      console.error(`AMAZON_STORAGE_STATE is not a usable Amazon session: ${(err as Error).message}`);
      process.exit(1);
    }
  } else {
    console.error(`Unknown AMAZON_MERCHANT "${kind}". Use mock, demo or browser.`);
    process.exit(1);
  }
  const shipsTo = process.env.PURCHASE_SHIPS_TO?.trim() || `${operator.name}'s address`;
  const purchases = createPurchases({ db, merchant, treasury, money, channel: sendOnly, limitCents, shipsTo, operator, log });
  log(`amazon: on (${kind}${isSet(process.env.AMAZON_DRY_RUN) ? ", dry run" : ""}), limit $${(limitCents / 100).toFixed(2)} per order, treasury ${treasury.address}, ships to ${shipsTo}`);
  // A browser session that is signed out shows up in the log at start, not at the first purchase.
  merchant.warm?.().then(() => log("amazon: session ready"), (err: unknown) => log(`amazon: WARNING ${(err as Error).message}`));
  return purchases;
}

/**
 * Ordering food on DoorDash with USDC (src/food/): on when FOOD_PROVIDER is set in Ethereum mode, with the same
 * treasury as Amazon. demo: an in-memory DoorDash that confirms every order (the deployed default). browser:
 * doordash.com signed in as the operator (DOORDASH_STORAGE_STATE from pnpm doordash:login). cli: DoorDash's dd-cli beta
 * at DOORDASH_CLI. See "Ordering food on DoorDash" in DESIGN.md.
 */
async function setupFood(): Promise<Food | undefined> {
  const kind = process.env.FOOD_PROVIDER?.trim();
  if (!kind) {
    log("food: off (set FOOD_PROVIDER=demo, browser or cli, and a treasury, to let owners order food)");
    return undefined;
  }
  if (mode !== "eth") {
    log("food: needs DEVICE_MODE=eth (owners pay the treasury in USDC), so it is off");
    return undefined;
  }
  const { treasury, operator } = commerce("Ordering food");
  const limitCents = usdLimit("FOOD_LIMIT_USD", 40, 200);
  const dryRun = isSet(process.env.DOORDASH_DRY_RUN);
  const foodLog = (line: string) => log(`[doordash] ${line}`);
  let provider: FoodProvider;
  if (kind === "demo") provider = demoDoorDash();
  else if (kind === "browser") {
    try {
      provider = createDoorDashProvider({ storageState: storageState(process.env.DOORDASH_STORAGE_STATE, process.env.DOORDASH_STORAGE_STATE_PATH), limitCents, dryRun, log: foodLog });
    } catch (err) {
      console.error(`DOORDASH_STORAGE_STATE is not a usable DoorDash session: ${(err as Error).message}`);
      process.exit(1);
    }
  } else if (kind === "cli") provider = createDoorDashCli({ bin: process.env.DOORDASH_CLI, limitCents, dryRun, log: foodLog });
  else {
    console.error(`Unknown FOOD_PROVIDER "${kind}". Use demo, browser or cli.`);
    process.exit(1);
  }
  const food = createFood({ db, provider, treasury, money, channel: sendOnly, limitCents, operator, log });
  log(`food: on (${kind}${dryRun ? ", dry run" : ""}), limit $${(limitCents / 100).toFixed(2)} per order, treasury ${treasury.address}`);
  provider.warm?.().then(() => log("food: DoorDash session ready"), (err: unknown) => log(`food: WARNING ${(err as Error).message}`));
  return food;
}

/**
 * Calling Jarvis (src/voice/twilio.ts): on when OPENAI_API_KEY is set and the web server runs. TWILIO_PHONE_NUMBER is
 * the number owners call, as Jarvis tells them; TWILIO_AUTH_TOKEN signs Twilio's webhooks. See voice/TWILIO.md.
 */
function setupPhone(): PhoneLinks | undefined {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return undefined;
  if (!web) {
    log("twilio: calling Jarvis needs the web server (DEVICE_MODE=eth), so it is off");
    return undefined;
  }
  const raw = process.env.TWILIO_PHONE_NUMBER?.trim();
  const number = raw ? normalizeHandle(raw) : undefined;
  if (raw && !PHONE_RE.test(number!)) {
    console.error(`TWILIO_PHONE_NUMBER must be the number in E.164 form, like +14155550100, not "${raw}".`);
    process.exit(1);
  }
  if (!raw) log("twilio: TWILIO_PHONE_NUMBER unset, so Jarvis cannot tell owners which number to call");
  if (!/^https:\/\//.test(publicUrl)) log("twilio: PUBLIC_URL is not https; Twilio needs https for the webhook and wss for the audio");
  return createPhoneLinks({ db, number, log });
}

let stopping = false;
async function shutdown(): Promise<void> {
  log("stopping (signal received)");
  if (stopping) return process.exit(1);
  stopping = true;
  log("shutting down");
  await channel.stop().catch((err) => log(`channel stop: ${(err as Error).message}`));
  await voice?.close().catch((err: unknown) => log(`voice stop: ${(err as Error).message}`));
  await app.close();
  await purchases?.close().catch((err: unknown) => log(`amazon stop: ${(err as Error).message}`));
  await food?.close().catch((err: unknown) => log(`food stop: ${(err as Error).message}`));
  await deviceManager.close().catch((err: unknown) => log(`device stop: ${(err as Error).message}`));
  await web?.close();
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
