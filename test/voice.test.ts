/**
 * Phone calls: webhook signatures, Jarvis's instructions, the realtime function-call bridge (with the owner's chat:
 * text_owner, look_at_chat), the routes, and one live text-mode session.
 */
import { config } from "dotenv";
import { createHmac, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { history } from "../src/agent/agent.js";
import { createModel } from "../src/agent/xai.js";
import { createRemoteDeviceManager } from "../src/device/index.js";
import { instructionsFor } from "../src/voice/instructions.js";
import { voiceRoutes } from "../src/voice/routes.js";
import { runVoiceSession } from "../src/voice/session.js";
import { callerFrom, createVoice, verifyWebhook } from "../src/voice/webhook.js";
import { startWebServer, type WebServer } from "../src/web/server.js";
import { call, harness, isEngine, PHONES, say } from "./helpers.js";
import { receiptPng } from "./receipt.js";

config({ path: join(homedir(), ".grok", ".env"), quiet: true });

async function until(check: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) throw new Error("timed out");
}

/** A realtime socket played by the test: records what the session sends, emits server events. */
class FakeSocket extends EventEmitter {
  sent: any[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.emit("close");
  }
  event(e: Record<string, unknown>) {
    this.emit("message", JSON.stringify(e));
  }
  of(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
  notes() {
    return this.of("conversation.item.create").filter((m) => m.item.type === "message").map((m) => m.item.content[0].text as string);
  }
}

const SECRET = `whsec_${randomBytes(24).toString("base64")}`;
function signed(body: string, at = Math.floor(Date.now() / 1000), id = `msg_${randomBytes(4).toString("hex")}`) {
  const sig = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64")).update(`${id}.${at}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": `v1,${sig}` };
}

describe("webhook signature", () => {
  const body = '{"type":"realtime.call.incoming"}';
  it("accepts a valid signature, also among several", () => {
    const h = signed(body);
    expect(verifyWebhook(SECRET, h, body)).toBe(true);
    expect(verifyWebhook(SECRET, { ...h, "webhook-signature": `v1,AAAA ${h["webhook-signature"]}` }, body)).toBe(true);
  });
  it("rejects a wrong secret, a changed body and a stale timestamp", () => {
    expect(verifyWebhook(`whsec_${randomBytes(24).toString("base64")}`, signed(body), body)).toBe(false);
    expect(verifyWebhook(SECRET, signed(body), body.replace("call", "cal"))).toBe(false);
    expect(verifyWebhook(SECRET, signed(body, Math.floor(Date.now() / 1000) - 301), body)).toBe(false);
    expect(verifyWebhook(SECRET, { ...signed(body), "webhook-signature": "garbage" }, body)).toBe(false);
  });
  it("reads the caller from SIP From values", () => {
    expect(callerFrom("+14155550100")).toBe("+14155550100");
    expect(callerFrom('"Matt" <sip:+14155550100@sip.x.ai>;tag=abc')).toBe("+14155550100");
    expect(callerFrom("<tel:4155550100>")).toBe("+14155550100");
    expect(callerFrom("anonymous")).toBeUndefined();
  });
});

describe("instructions", () => {
  it("gives Jarvis the owner's facts and the propose-only rules", async () => {
    const h = harness(2);
    const matt = await h.onboard("matt", 0);
    await h.onboard("yadu", 1);
    h.befriend(matt.id, h.db.accountByTag("@yadu")!.id);
    const text = await instructionsFor(h.app.deps, matt, "Matt is demoing at a hackathon.");
    for (const s of ["Jarvis", "@matt (Matt)", "$250.00", "@yadu", "Waiting on @matt's Ledger: nothing", "propose_action", "Never read addresses", "Matt is demoing at a hackathon."]) expect(text).toContain(s);
    for (const s of ["text_owner", "look_at_chat", "never say you cannot see", "the link is in your texts"]) expect(text).toContain(s);
    expect(text).not.toContain("Telegram");
  });
  it("walks a stranger to a tag", async () => {
    const text = await instructionsFor(harness(1).app.deps, undefined, "");
    expect(text).toContain("no AgentSign account");
    expect(text).toContain("choose_tag");
  });
});

describe("realtime bridge", () => {
  it("runs tools through the engine's harness, answers every call, then one response.create", async () => {
    const h = harness(2);
    await h.onboard("matt", 0);
    await h.onboard("yadu", 1);
    const ws = new FakeSocket();
    runVoiceSession({ ws, caller: PHONES.matt, deps: h.app });
    await until(() => ws.of("response.create").length === 1);
    const session = ws.of("session.update")[0].session;
    expect(session).toMatchObject({ voice: "atlas", turn_detection: { type: "server_vad" }, reasoning: { effort: "none" } });
    expect(session.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["get_balance", "propose_action", "message_agent", "end_call"]));
    ws.event({ type: "response.created" });
    ws.event({ type: "response.function_call_arguments.done", name: "get_balance", call_id: "c1", arguments: "{}" });
    const pay = { code: "PAY", fields: [{ label: "To", value: "@yadu" }, { label: "Amount", value: "$2.00" }] };
    ws.event({ type: "response.function_call_arguments.done", name: "propose_action", call_id: "c2", arguments: JSON.stringify(pay) });
    ws.event({ type: "response.done" });
    await until(() => ws.of("response.create").length === 2);
    const outputs = ws.of("conversation.item.create").filter((m) => m.item.type === "function_call_output");
    expect(outputs.map((m) => m.item.call_id)).toEqual(["c1", "c2"]);
    expect(JSON.parse(outputs[0].item.output)).toContain("Balance: $250.00");
    expect(JSON.parse(outputs[1].item.output)).toMatch(/^Proposed: Send money.*NOT done.*went to their texts/);
    await h.app.whenIdle();
    expect(h.to(PHONES.matt)).toContain("Please confirm on your Ledger: Send money: To @yadu, Amount $2.00");
    ws.event({ type: "response.created" });
    ws.event({ type: "response.done" });
    await until(() => ws.notes().some((n) => n.includes("Approved on their Ledger and done: Send money")));
    expect(ws.of("response.create")).toHaveLength(3);
  });

  it("hangs up after the goodbye that follows end_call", async () => {
    const h = harness(1);
    await h.onboard("matt", 0);
    const ws = new FakeSocket();
    let hungUp = false;
    runVoiceSession({ ws, caller: PHONES.matt, deps: h.app, mode: "text", greet: false, onHangup: () => (hungUp = true) });
    await until(() => ws.of("session.update").length === 1);
    expect(ws.of("session.update")[0].session.turn_detection).toBeNull();
    ws.event({ type: "response.created" });
    ws.event({ type: "response.function_call_arguments.done", name: "end_call", call_id: "e1", arguments: "{}" });
    ws.event({ type: "response.done" });
    await until(() => ws.of("response.create").length === 1);
    expect(hungUp).toBe(false);
    ws.event({ type: "response.created" });
    ws.event({ type: "response.output_audio_transcript.done", transcript: "Goodbye, Matt." });
    ws.event({ type: "response.done" });
    await until(() => hungUp);
  });

  it("signs a stranger up with choose_tag, then switches to the owner's tools", async () => {
    const h = harness(1);
    const ws = new FakeSocket();
    runVoiceSession({ ws, caller: "+14155550009", deps: h.app, mode: "text", greet: false });
    await until(() => ws.of("session.update").length === 1);
    expect(ws.of("session.update")[0].session.tools.map((t: { name: string }) => t.name)).toEqual(["choose_tag", "end_call"]);
    ws.event({ type: "response.created" });
    ws.event({ type: "response.function_call_arguments.done", name: "choose_tag", call_id: "t1", arguments: '{"tag":"at Gabe"}' });
    ws.event({ type: "response.done" });
    await until(() => ws.of("response.create").length === 1);
    const output = ws.of("conversation.item.create").find((m) => m.item.type === "function_call_output").item.output;
    expect(JSON.parse(output)).toMatch(/^Started\. Their Ledger now shows 'Create account' for @gabe/);
    ws.event({ type: "response.created" });
    ws.event({ type: "response.done" });
    await until(() => ws.notes().some((n) => n.includes("account @gabe now exists")));
    expect(h.db.accountByHandle("+14155550009")?.tag).toBe("@gabe");
    expect(h.to("+14155550009")[0]).toContain("@gabe");
    expect(ws.of("session.update").at(-1).session.tools.map((t: { name: string }) => t.name)).toContain("get_balance");
  });
});

describe("the owner's chat from a call", () => {
  /** One model response that calls `name` with `args`; resolves with the tool's output once the session answered it. */
  async function toolCall(ws: FakeSocket, name: string, args: Record<string, unknown>): Promise<string> {
    const before = ws.of("response.create").length;
    const id = `${name}_${randomBytes(3).toString("hex")}`;
    ws.event({ type: "response.created" });
    ws.event({ type: "response.function_call_arguments.done", name, call_id: id, arguments: JSON.stringify(args) });
    ws.event({ type: "response.done" });
    await until(() => ws.of("response.create").length > before);
    return JSON.parse(ws.of("conversation.item.create").find((m) => m.item.call_id === id).item.output) as string;
  }
  async function dial(h: ReturnType<typeof harness>) {
    const ws = new FakeSocket();
    runVoiceSession({ ws, caller: PHONES.matt, deps: h.app, mode: "text", greet: false });
    await until(() => ws.of("session.update").length === 1);
    return ws;
  }

  it("text_owner sends plain text to the owner's chat and keeps it in their history", async () => {
    const h = harness(1);
    const matt = await h.onboard("matt", 0);
    const ws = await dial(h);
    expect(ws.of("session.update")[0].session.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["text_owner", "look_at_chat"]));
    const output = await toolCall(ws, "text_owner", { text: "**Order** 113-5550 — arriving Tuesday" });
    expect(output).toBe('Sent in their texts: "Order 113-5550 - arriving Tuesday". Tell them it is there, in a few words.');
    expect(h.to(PHONES.matt).at(-1)).toBe("Order 113-5550 - arriving Tuesday");
    expect(h.db.recentMessages(matt.id).at(-1)!.content).toEqual({ role: "assistant", content: "Order 113-5550 - arriving Tuesday" });
    expect(await toolCall(ws, "text_owner", { text: "x".repeat(1001) })).toMatch(/^Error: too long/);
  });

  it("a text sent from a call while a text turn has tool calls open stays after their results in the history", async () => {
    const h = harness(1);
    const matt = await h.onboard("matt", 0);
    h.db.addMessage(matt.id, "user", { role: "user", content: "pay gabe back" });
    h.db.addMessage(matt.id, "assistant", { role: "assistant", content: "", toolCalls: [{ id: "d1", name: "delegate", arguments: "{}" }] });
    h.db.addMessage(matt.id, "assistant", { role: "assistant", content: "Order 113-5550" });
    h.db.addMessage(matt.id, "tool", { role: "tool", toolCallId: "d1", content: "Proposed." });
    expect(history(h.db, matt.id, ["delegate"]).map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("look_at_chat reads the latest texts back as lines, without the engine", async () => {
    const h = harness(1);
    await h.onboard("matt", 0);
    h.script(say("Noted: 4417."));
    await h.send(PHONES.matt, "the gate code is 4417");
    const ws = await dial(h);
    const asked = h.requests.length;
    const output = await toolCall(ws, "look_at_chat", { question: "what was the last thing I sent you" });
    expect(output).toContain("- They: the gate code is 4417\n- You: Noted: 4417.");
    expect(h.requests).toHaveLength(asked);
  });

  it("look_at_chat runs the engine on a photo: the receipt becomes a PAY, the approval lands in the chat, the call hears it", async () => {
    const h = harness(2);
    const matt = await h.onboard("matt", 0);
    await h.onboard("gabriel", 1);
    const receipt = join(mkdtempSync(join(tmpdir(), "agentsign-voice-")), "receipt.jpg");
    writeFileSync(receipt, "not really a jpeg");
    h.script(say("That's a lot of tacos."));
    await h.send(PHONES.matt, "", [receipt]);
    const ws = await dial(h);
    h.script((request) => {
      expect(isEngine(request)).toBe(true);
      expect(request.messages[0]).toMatchObject({ role: "user", images: [receipt] });
      expect(request.messages[0]!.content).toContain("Task: look at the receipt and pay gabe back half");
      return call("propose_action", { code: "PAY", fields: [{ label: "To", value: "@gabriel" }, { label: "Amount", value: "$12.40" }] });
    });
    const output = await toolCall(ws, "look_at_chat", { question: "look at the receipt and pay gabe back half" });
    expect(output).toContain("- They: [sent a photo]");
    expect(output).toMatch(/Their photo, read just now: Proposed on @matt's Ledger: Send money: To @gabriel, Amount \$12\.40\..*went to their texts/);
    await h.app.whenIdle();
    expect(h.to(PHONES.matt)).toContain("Please confirm on your Ledger: Send money: To @gabriel, Amount $12.40");
    ws.event({ type: "response.created" });
    ws.event({ type: "response.done" });
    await until(() => ws.notes().some((n) => n.includes("Approved on their Ledger and done: Send money: To @gabriel, Amount $12.40")));
    expect(h.remaining()).toBe(0);
  });
});

describe("call routes", () => {
  let web: WebServer | undefined;
  let fake: Server | undefined;
  afterEach(async () => {
    await web?.close();
    fake?.closeAllConnections();
    await new Promise((r) => (fake ? fake.close(r) : r(undefined)));
  });

  it("joins a signed call as Jarvis for the caller, takes new context live, and keeps the transcript", async () => {
    const h = harness(1);
    const matt = await h.onboard("matt", 0);
    // xAI played by a local server: the realtime websocket and the hangup endpoint.
    const sockets: { sock: WebSocket; url: string; got: any[] }[] = [];
    const hangups: string[] = [];
    fake = createServer((req, res) => void (hangups.push(req.url ?? ""), res.end("{}")));
    new WebSocketServer({ server: fake }).on("connection", (sock, req) => {
      const entry = { sock, url: req.url ?? "", got: [] as any[] };
      sock.on("message", (d) => entry.got.push(JSON.parse(String(d))));
      sockets.push(entry);
    });
    await new Promise<void>((r) => fake!.listen(0, "127.0.0.1", r));
    const voice = createVoice({ app: h.app, apiKey: "k", secret: SECRET, baseUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1` });
    web = await startWebServer({ db: h.db, remote: createRemoteDeviceManager({ db: h.db, publicUrl: "http://x" }), port: 0, routes: voiceRoutes({ voice, adminToken: "admin" }) });
    const url = `http://127.0.0.1:${web.port}`;
    const body = JSON.stringify({ object: "event", id: "evt_1", type: "realtime.call.incoming", data: { call_id: "call_1", sip_headers: [{ name: "From", value: PHONES.matt }] } });
    expect((await fetch(`${url}/voice/webhook`, { method: "POST", body })).status).toBe(401);
    expect((await fetch(`${url}/voice/webhook`, { method: "POST", body, headers: signed(body, Math.floor(Date.now() / 1000) - 600) })).status).toBe(401);
    expect((await fetch(`${url}/voice/webhook`, { method: "POST", body, headers: signed(body) })).status).toBe(200);
    await until(() => sockets[0]?.got.some((m) => m.type === "response.create") ?? false);
    expect(sockets[0]!.url).toBe("/v1/realtime?call_id=call_1");
    expect(sockets[0]!.got[0].session.instructions).toContain("@matt");

    const context = (headers: Record<string, string>) => fetch(`${url}/voice/context`, { method: "POST", headers, body: JSON.stringify({ instructions: "Speak like a pirate." }) });
    expect((await context({})).status).toBe(401);
    expect(await (await context({ "x-agentsign-admin": "admin" })).json()).toEqual({ ok: true, liveCallsUpdated: 1 });
    expect(sockets[0]!.got.at(-1).session.instructions).toContain("Speak like a pirate.");

    const server = (e: object) => sockets[0]!.sock.send(JSON.stringify(e));
    server({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "Bye for now." });
    server({ type: "response.created" });
    server({ type: "response.function_call_arguments.done", name: "end_call", call_id: "e1", arguments: "{}" });
    server({ type: "response.done" });
    await until(() => sockets[0]!.got.filter((m) => m.type === "response.create").length === 2);
    server({ type: "response.created" });
    server({ type: "response.output_audio_transcript.done", transcript: "Goodbye." });
    server({ type: "response.done" });
    await until(() => hangups.length === 1, 4000);
    expect(hangups[0]).toBe("/v1/realtime/calls/call_1/hangup");
    await until(() => h.db.recentMessages(matt.id).some((m) => JSON.stringify(m.content).includes("Phone call")));
    const note = h.db.recentMessages(matt.id).at(-1)!.content as { content: string };
    expect(note.content).toContain("User said: Bye for now.");
    expect(note.content).toContain("Jarvis said: Goodbye.");
    const calls = (await (await fetch(`${url}/voice/calls`, { headers: { "x-agentsign-admin": "admin" } })).json()) as { calls: { caller: string; endedAt?: string }[] };
    expect(calls.calls[0]).toMatchObject({ caller: PHONES.matt });
    expect(calls.calls[0]!.endedAt).toBeDefined();
  }, 15_000);
});

const apiKey = process.env.XAI_API_KEY;
describe.skipIf(!apiKey)("live realtime session (text mode)", () => {
  it("checks the balance with a tool and proposes $2.00 to @yadu", async () => {
    const h = harness(2);
    await h.onboard("matt", 0);
    await h.onboard("yadu", 1);
    const ws = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", { headers: { authorization: `Bearer ${apiKey}` } });
    await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
    const lines: string[] = [];
    const session = runVoiceSession({ ws, caller: PHONES.matt, deps: h.app, mode: "text", greet: false, onTurn: (t) => lines.push(`${t.who}: ${t.text}`) });
    try {
      await session.say("What's my balance?");
      expect(session.turns.some((t) => t.who === "tool" && t.text.startsWith("get_balance("))).toBe(true);
      await session.say("Send two dollars to @yadu.");
      expect(session.turns.some((t) => t.who === "tool" && t.text.startsWith("propose_action("))).toBe(true);
      await h.app.whenIdle();
      const shown = h.devices[0]!.shown.at(-1)!;
      expect(shown.code).toBe("PAY");
      expect(shown.fields).toEqual(expect.arrayContaining([{ label: "To", value: "@yadu" }, { label: "Amount", value: "$2.00" }]));
      await session.idle();
      console.log(`live voice transcript:\n${lines.join("\n")}`);
    } finally {
      ws.close();
    }
  }, 90_000);

  it("looks at the receipt the owner texted and puts paying gabe back on the Ledger", async () => {
    const h = harness(2, createModel({ apiKey: apiKey! }));
    await h.onboard("matt", 0);
    await h.onboard("gabriel", 1);
    const receipt = join(mkdtempSync(join(tmpdir(), "agentsign-voice-")), "receipt.png");
    writeFileSync(receipt, receiptPng(["CAFE ROMA", "", "BURRITO   $12.50", "TACOS      $8.00", "TAX        $2.90", "", "TOTAL     $23.40"]));
    await h.send(PHONES.matt, "keep this for later", [receipt]);
    const ws = new WebSocket("wss://api.x.ai/v1/realtime?model=grok-voice-latest", { headers: { authorization: `Bearer ${apiKey}` } });
    await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
    const lines: string[] = [];
    const session = runVoiceSession({ ws, caller: PHONES.matt, deps: h.app, mode: "text", greet: false, onTurn: (t) => lines.push(`${t.who}: ${t.text}`) });
    try {
      await session.say("Hey, take a look at what I just sent you and pay Gabe back for it.");
      await h.app.whenIdle();
      console.log(`live look_at_chat transcript:\n${lines.join("\n")}`);
      expect(session.turns.some((t) => t.who === "tool" && t.text.startsWith("look_at_chat("))).toBe(true);
      const shown = h.devices[0]!.shown.filter((a) => a.code === "PAY").at(-1)!;
      expect(shown.fields.slice(0, 2)).toEqual([{ label: "To", value: "@gabriel" }, { label: "Amount", value: "$23.40" }]);
      expect(h.to(PHONES.matt).some((t) => t.startsWith("Please confirm on your Ledger: Send money: To @gabriel, Amount $23.40"))).toBe(true);
      await session.idle();
    } finally {
      ws.close();
    }
  }, 120_000);
});
