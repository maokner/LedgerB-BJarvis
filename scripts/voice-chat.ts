/**
 * Type to Jarvis in the terminal: the exact phone-call session (instructions, tools, harness) over a realtime API in
 * text mode, against an in-memory demo world (Matt and Yadu, fake Ledgers that approve, texts printed instead of sent).
 * Nothing here touches Telegram, a real Ledger or the real database.
 *
 *   pnpm voice:chat                      as @matt over xAI (XAI_API_KEY)
 *   pnpm voice:chat --provider openai    the same session over OpenAI's realtime API (OPENAI_API_KEY): what a Twilio call runs
 *   pnpm voice:chat --as unlinked        a number no account has linked (the code flow; "openai" provider)
 *   pnpm voice:chat --as stranger        a number without an account (sign-up by phone, "xai" provider)
 *   pnpm voice:chat --context 'Matt is demoing at a hackathon.'
 */
import { config } from "dotenv";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import { runVoiceSession, type RealtimeProvider } from "../src/voice/session.js";
import { DEFAULT_REALTIME_MODEL, OPENAI_REALTIME_URL } from "../src/voice/twilio.js";
import { harness, PHONES } from "../test/helpers.js";
import { createModel, DEFAULT_MODEL } from "../src/agent/xai.js";

config({ quiet: true });
config({ path: join(homedir(), ".grok", ".env"), quiet: true });
const { values } = parseArgs({ options: { as: { type: "string", default: "matt" }, context: { type: "string", default: "" }, voice: { type: "string" }, provider: { type: "string", default: "xai" } } });
const provider = values.provider as RealtimeProvider;
if (provider !== "xai" && provider !== "openai") throw new Error("--provider must be xai or openai");
const apiKey = process.env.XAI_API_KEY;
if (!apiKey) throw new Error("XAI_API_KEY is missing (.env or ~/.grok/.env).");
const openaiKey = process.env.OPENAI_API_KEY;
if (provider === "openai" && !openaiKey) throw new Error("OPENAI_API_KEY is missing (.env).");

// message_agent runs the friend's agent on the chat model, as on the server. Phone links as on a Twilio setup.
const h = harness(3, createModel({ apiKey, model: process.env.XAI_MODEL || DEFAULT_MODEL }), { phone: process.env.TWILIO_PHONE_NUMBER || "+19406447419" });
const matt = await h.onboard("matt", 0);
const yadu = await h.onboard("yadu", 1);
h.befriend(matt.id, yadu.id);
const caller = values.as === "stranger" || values.as === "unlinked" ? "+14155550099" : values.as === "yadu" ? PHONES.yadu : PHONES.matt;
if (values.as === "unlinked") console.log("(an unlinked number: text the code Jarvis reads with `link <code>` here to link it, as Matt would on Telegram)");
const printed = new Set<string>(h.sent.map((m) => JSON.stringify(m))); // not the sign-up texts above
setInterval(() => {
  for (const s of h.sent) if (!printed.has(JSON.stringify(s))) printed.add(JSON.stringify(s)), console.log(`  [text -> ${s.handle}] ${s.text}`);
}, 200).unref();

const ws =
  provider === "openai"
    ? new WebSocket(`${OPENAI_REALTIME_URL}?model=${process.env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL}`, { headers: { authorization: `Bearer ${openaiKey}` } })
    : new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", { headers: { authorization: `Bearer ${apiKey}` } });
await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
const session = runVoiceSession({
  ws, caller, deps: h.app, mode: "text", provider, voice: values.voice, context: () => values.context,
  // Only the stranger flow signs up by phone; everyone else is a Telegram account that links numbers.
  phone: values.as === "stranger" ? undefined : h.phone,
  onTurn: (t) => t.who !== "caller" && console.log(`${t.who === "jarvis" ? "Jarvis" : `  [${t.who}]`} ${t.text}`),
});
await session.idle();
const rl = createInterface({ input: process.stdin, output: process.stdout });
ws.once("close", () => (console.log("(call ended)"), process.exit(0)));
rl.once("close", () => ws.close()); // Ctrl-D or the end of piped input hangs up
for (;;) {
  const text = (await rl.question("you> ")).trim();
  const link = /^link (\d{4})$/i.exec(text);
  if (link) {
    const r = h.phone!.claim(matt.id, link[1]!);
    console.log(r.ok ? `  [telegram] linked ${r.handle} to @matt` : `  [telegram] ${r.reason}`);
    continue;
  }
  if (text) await session.say(text);
}
