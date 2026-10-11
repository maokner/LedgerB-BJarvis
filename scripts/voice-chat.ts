/**
 * Type to Jarvis in the terminal: the exact phone-call session (instructions, tools, harness) over xAI's
 * realtime API in text mode, against an in-memory demo world (Matt and Yadu, fake Ledgers that approve,
 * texts printed instead of sent). Nothing here touches Messages, a real Ledger or the real database.
 *
 *   pnpm voice:chat                 as @matt
 *   pnpm voice:chat --as stranger   a number without an account (sign-up flow)
 *   pnpm voice:chat --context 'Matt is demoing at a hackathon.'
 */
import { config } from "dotenv";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import { runVoiceSession } from "../src/voice/session.js";
import { harness, PHONES } from "../test/helpers.js";
import { createModel, DEFAULT_MODEL } from "../src/agent/xai.js";

config({ quiet: true });
config({ path: join(homedir(), ".grok", ".env"), quiet: true });
const { values } = parseArgs({ options: { as: { type: "string", default: "matt" }, context: { type: "string", default: "" }, voice: { type: "string" } } });
const apiKey = process.env.XAI_API_KEY;
if (!apiKey) throw new Error("XAI_API_KEY is missing (.env or ~/.grok/.env).");

// message_agent runs the friend's agent on the chat model, as on the server.
const h = harness(3, createModel({ apiKey, model: process.env.XAI_MODEL || DEFAULT_MODEL }));
const matt = await h.onboard("matt", 0);
const yadu = await h.onboard("yadu", 1);
h.befriend(matt.id, yadu.id);
const caller = values.as === "stranger" ? "+14155550099" : values.as === "yadu" ? PHONES.yadu : PHONES.matt;
const printed = new Set<string>(h.sent.map((m) => JSON.stringify(m))); // not the sign-up texts above
setInterval(() => {
  for (const s of h.sent) if (!printed.has(JSON.stringify(s))) printed.add(JSON.stringify(s)), console.log(`  [text -> ${s.handle}] ${s.text}`);
}, 200).unref();

const ws = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", { headers: { authorization: `Bearer ${apiKey}` } });
await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
const session = runVoiceSession({
  ws, caller, deps: h.app, mode: "text", voice: values.voice, context: () => values.context,
  onTurn: (t) => t.who !== "caller" && console.log(`${t.who === "jarvis" ? "Jarvis" : `  [${t.who}]`} ${t.text}`),
});
await session.idle();
const rl = createInterface({ input: process.stdin, output: process.stdout });
ws.once("close", () => (console.log("(call ended)"), process.exit(0)));
rl.once("close", () => ws.close()); // Ctrl-D or the end of piped input hangs up
for (;;) {
  const text = (await rl.question("you> ")).trim();
  if (text) await session.say(text);
}
