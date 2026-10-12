/**
 * Calling Jarvis: Twilio's signed webhook and TwiML, the media stream bridged to a fake OpenAI realtime server, barge-in,
 * hang-up and the transcript; linking a phone number from a call (the code texted on Telegram) and from a text (link_phone).
 */
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createRemoteDeviceManager } from "../src/device/index.js";
import { ownerFacts } from "../src/agent/agent.js";
import { createPhoneLinks } from "../src/phone.js";
import { voiceRoutes, voiceUpgrades } from "../src/voice/routes.js";
import { connectTwiml, createTwilioVoice, verifyTwilioSignature, type TwilioVoice } from "../src/voice/twilio.js";
import { startWebServer, type WebServer } from "../src/web/server.js";
import { call, delegate, harness, PHONES, say, tgInbound } from "./helpers.js";

const AUTH = "twilio-auth-token";
const NUMBER = "+19406447419";

async function until(check: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) throw new Error("timed out");
}

/** Signs a form the way Twilio does. */
function sign(url: string, params: Record<string, string>, token = AUTH): string {
  const sorted = Object.keys(params).sort().map((k) => `${k}${params[k]}`).join("");
  return createHmac("sha1", token).update(url + sorted).digest("base64");
}

describe("twilio signature", () => {
  const url = "https://agentsign-jarvis.fly.dev/twilio/voice";
  const params = { CallSid: "CA1", From: "+14155550001", To: NUMBER, CallStatus: "ringing" };
  it("accepts Twilio's signature, with or without the default port, and nothing else", () => {
    expect(verifyTwilioSignature(AUTH, url, params, sign(url, params))).toBe(true);
    expect(verifyTwilioSignature(AUTH, url, params, sign("https://agentsign-jarvis.fly.dev:443/twilio/voice", params))).toBe(true);
    expect(verifyTwilioSignature(AUTH, "https://agentsign-jarvis.fly.dev:443/twilio/voice", params, sign(url, params))).toBe(true);
    expect(verifyTwilioSignature(AUTH, url, params, sign(url, params, "other"))).toBe(false);
    expect(verifyTwilioSignature(AUTH, url, { ...params, From: "+14155550002" }, sign(url, params))).toBe(false);
    expect(verifyTwilioSignature(AUTH, url, params, undefined)).toBe(false);
    expect(verifyTwilioSignature(AUTH, url, params, "")).toBe(false);
  });
  it("builds TwiML that connects the stream with the token", () => {
    const xml = connectTwiml("wss://x.test/twilio/media", "abc");
    expect(xml).toContain('<Connect><Stream url="wss://x.test/twilio/media"><Parameter name="token" value="abc"/></Stream></Connect><Hangup/>');
  });
});

/** A web server with the Twilio routes, plus a fake OpenAI realtime server, around a harness. */
async function stack(h: ReturnType<typeof harness>, options: { authToken?: string; allowUnsigned?: boolean } = { authToken: AUTH }) {
  const openaiSockets: { sock: WebSocket; url: string; headers: Record<string, string | string[] | undefined>; got: any[] }[] = [];
  const fake = createServer((_req, res) => res.end("{}"));
  new WebSocketServer({ server: fake, path: "/v1/realtime" }).on("connection", (sock, req) => {
    const entry = { sock, url: req.url ?? "", headers: req.headers, got: [] as any[] };
    sock.on("message", (d) => entry.got.push(JSON.parse(String(d))));
    openaiSockets.push(entry);
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const openaiUrl = `ws://127.0.0.1:${(fake.address() as AddressInfo).port}/v1/realtime`;
  let web: WebServer | undefined;
  const publicUrl = { value: "http://127.0.0.1:0" };
  const twilio: TwilioVoice = createTwilioVoice({ app: h.app, phone: h.phone!, openaiKey: "sk-test", openaiUrl, publicUrl: "https://jarvis.test", ...options });
  web = await startWebServer({
    db: h.db, remote: createRemoteDeviceManager({ db: h.db, publicUrl: "http://x" }), port: 0,
    routes: voiceRoutes({ twilio, adminToken: "admin", publicUrl: "https://jarvis.test" }), upgrades: voiceUpgrades({ twilio }),
  });
  publicUrl.value = `http://127.0.0.1:${web.port}`;
  const url = publicUrl.value;
  /** Twilio calls the webhook; returns the TwiML (or the error). */
  const ring = async (from: string, callSid = "CA1", signed = true) => {
    const params = { CallSid: callSid, From: from, To: NUMBER, CallStatus: "ringing", Direction: "inbound" };
    const body = new URLSearchParams(params).toString();
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (signed) headers["x-twilio-signature"] = sign("https://jarvis.test/twilio/voice", params);
    const res = await fetch(`${url}/twilio/voice`, { method: "POST", headers, body });
    return { status: res.status, text: await res.text() };
  };
  /** Twilio's media stream: connects and sends start with the token from the TwiML. */
  const stream = async (twiml: string, callSid = "CA1") => {
    const token = /name="token" value="([0-9a-f]+)"/.exec(twiml)?.[1] ?? "";
    const sock = new WebSocket(`ws://127.0.0.1:${web!.port}/twilio/media`);
    const got: any[] = [];
    const closed: { code?: number } = {};
    sock.on("message", (d) => got.push(JSON.parse(String(d))));
    sock.on("close", (code) => (closed.code = code));
    await new Promise((resolve, reject) => sock.once("open", resolve).once("error", reject));
    const send = (m: object) => sock.send(JSON.stringify(m));
    send({ event: "connected", protocol: "Call", version: "1.0.0" });
    send({ event: "start", sequenceNumber: "1", start: { streamSid: "MZ1", callSid, accountSid: "AC1", tracks: ["inbound"], mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 }, customParameters: { token } }, streamSid: "MZ1" });
    let chunk = 0;
    const media = (payload: string, timestamp: number) => send({ event: "media", sequenceNumber: String(++chunk + 1), media: { track: "inbound", chunk: String(chunk), timestamp: String(timestamp), payload }, streamSid: "MZ1" });
    return { sock, got, closed, send, media, of: (event: string) => got.filter((m) => m.event === event) };
  };
  const openai = () => openaiSockets.at(-1)!;
  const close = async () => {
    await twilio.close();
    await web?.close();
    fake.closeAllConnections();
    await new Promise((r) => fake.close(r));
  };
  return { url, twilio, ring, stream, openai, openaiSockets, close };
}

describe("calling Jarvis through Twilio", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("refuses unsigned and badly signed calls, declines hidden numbers, and answers TwiML for the rest", async () => {
    const h = harness(1, undefined, { phone: NUMBER });
    const s = await stack(h);
    cleanup = s.close;
    expect((await s.ring(PHONES.matt, "CA1", false)).status).toBe(403);
    const forged = await fetch(`${s.url}/twilio/voice`, { method: "POST", headers: { "x-twilio-signature": "nope" }, body: "From=%2B14155550001&CallSid=CA9" });
    expect(forged.status).toBe(403);
    const hidden = await s.ring("anonymous", "CA2");
    expect(hidden.status).toBe(200);
    expect(hidden.text).toMatch(/<Say>Jarvis here. Your number is hidden/);
    const ok = await s.ring(PHONES.matt, "CA3");
    expect(ok.status).toBe(200);
    expect(ok.text).toMatch(/<Stream url="wss:\/\/jarvis.test\/twilio\/media"><Parameter name="token" value="[0-9a-f]{32}"\/>/);
    expect((await fetch(`${s.url}/twilio/media`)).status).toBe(405); // no upgrade, no stream
  });

  it("drops a media stream whose token is not one the webhook issued", async () => {
    const h = harness(1, undefined, { phone: NUMBER });
    const s = await stack(h);
    cleanup = s.close;
    const t = await s.stream('name="token" value="deadbeef"');
    await until(() => t.closed.code !== undefined);
    expect(t.closed.code).toBe(1008);
    expect(s.openaiSockets).toHaveLength(0);
  });

  it("bridges the call: audio both ways in mu-law, tools through the engine, barge-in, hang-up, transcript", async () => {
    const h = harness(2, undefined, { phone: NUMBER });
    const matt = await h.onboard("matt", 0);
    await h.onboard("yadu", 1);
    const s = await stack(h);
    cleanup = s.close;
    const twiml = (await s.ring(PHONES.matt)).text;
    const t = await s.stream(twiml);
    // Caller audio before the model is connected is kept.
    t.media("AAAA", 20);
    await until(() => s.openaiSockets.length === 1);
    const ai = s.openai();
    expect(ai.url).toBe("/v1/realtime?model=gpt-realtime-2.1");
    expect(ai.headers.authorization).toBe("Bearer sk-test");
    await until(() => ai.got.some((m) => m.type === "response.create"));
    const session = ai.got.find((m) => m.type === "session.update").session;
    expect(session).toMatchObject({
      type: "realtime",
      output_modalities: ["audio"],
      audio: { input: { format: { type: "audio/pcmu" }, turn_detection: { type: "server_vad" }, transcription: { model: "gpt-4o-transcribe" } }, output: { format: { type: "audio/pcmu" }, voice: "cedar" } },
    });
    expect(session.instructions).toContain("@matt");
    expect(session.instructions).toContain("Phone: @matt can call you at +19406447419");
    expect(session.tools.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(["get_balance", "propose_action", "link_phone", "end_call"]));
    expect(ai.got.filter((m) => m.type === "input_audio_buffer.append").map((m) => m.audio)).toEqual(["AAAA"]);

    // Jarvis speaks: audio deltas become Twilio media, each followed by a mark.
    const server = (e: object) => ai.sock.send(JSON.stringify(e));
    server({ type: "response.created" });
    server({ type: "response.output_audio.delta", item_id: "item_1", delta: "QUJD" });
    server({ type: "response.output_audio.delta", item_id: "item_1", delta: "REVG" });
    await until(() => t.of("media").length === 2);
    expect(t.got.filter((m) => m.event === "media" || m.event === "mark").map((m) => m.event)).toEqual(["media", "mark", "media", "mark"]);
    expect(t.of("media")[0]).toEqual({ event: "media", streamSid: "MZ1", media: { payload: "QUJD" } });
    // The caller talks over it 700 ms in: Twilio's buffer is cleared and the item truncated to what was heard.
    t.media("AQID", 720);
    await until(() => ai.got.filter((m) => m.type === "input_audio_buffer.append").length === 2);
    server({ type: "input_audio_buffer.speech_started", item_id: "item_2", audio_start_ms: 700 });
    await until(() => t.of("clear").length === 1);
    await until(() => ai.got.some((m) => m.type === "conversation.item.truncate"));
    expect(ai.got.find((m) => m.type === "conversation.item.truncate")).toEqual({ type: "conversation.item.truncate", item_id: "item_1", content_index: 0, audio_end_ms: 700 });
    server({ type: "response.done", response: { status: "cancelled" } });

    // A tool call runs the engine's harness; the Ledger prompt goes out as a text.
    server({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_2", transcript: "Send two dollars to Yadu." });
    server({ type: "response.created" });
    server({ type: "response.function_call_arguments.done", name: "propose_action", call_id: "c1", arguments: JSON.stringify({ code: "PAY", fields: [{ label: "To", value: "@yadu" }, { label: "Amount", value: "$2.00" }] }) });
    server({ type: "response.done", response: { status: "completed" } });
    await until(() => ai.got.some((m) => m.type === "conversation.item.create" && m.item.type === "function_call_output"));
    const output = JSON.parse(ai.got.find((m) => m.type === "conversation.item.create" && m.item.type === "function_call_output").item.output);
    expect(output).toMatch(/^Proposed: Send money: To @yadu, Amount \$2\.00\./);
    await h.app.whenIdle();
    expect(h.to(PHONES.matt)).toContain("Please confirm on your Ledger: Send money: To @yadu, Amount $2.00");
    await until(() => ai.got.filter((m) => m.type === "response.create").length === 2);

    // Goodbye: end_call, one last line, then the stream closes, which ends the call.
    server({ type: "response.created" });
    server({ type: "response.output_audio_transcript.done", transcript: "Two dollars to Yadu is on your Ledger." });
    server({ type: "response.done", response: { status: "completed" } });
    await until(() => ai.got.filter((m) => m.type === "response.create").length === 3); // the approval outcome is told
    server({ type: "response.created" });
    server({ type: "response.function_call_arguments.done", name: "end_call", call_id: "c2", arguments: "{}" });
    server({ type: "response.done", response: { status: "completed" } });
    await until(() => ai.got.filter((m) => m.type === "response.create").length === 4);
    server({ type: "response.created" });
    server({ type: "response.output_audio_transcript.done", transcript: "Bye." });
    server({ type: "response.done", response: { status: "completed" } });
    await until(() => t.closed.code !== undefined, 6000);
    expect(t.closed.code).toBe(1000);
    await until(() => h.db.recentMessages(matt.id).some((m) => JSON.stringify(m.content).includes("Phone call")));
    const note = h.db.recentMessages(matt.id).at(-1)!.content as { content: string };
    expect(note.content).toContain("User said: Send two dollars to Yadu.");
    expect(note.content).toContain("Jarvis said: Two dollars to Yadu is on your Ledger.");
    const calls = (await (await fetch(`${s.url}/voice/calls`, { headers: { "x-agentsign-admin": "admin" } })).json()) as { calls: { id: string; caller: string; tag?: string; endedAt?: string }[] };
    expect(calls.calls[0]).toMatchObject({ id: "CA1", caller: PHONES.matt, tag: "@matt" });
    expect(calls.calls[0]!.endedAt).toBeDefined();
  }, 15_000);

  it("reads an unlinked caller a code; the owner texts it on Telegram and the live call becomes theirs", async () => {
    const h = harness(1, undefined, { phone: NUMBER });
    const matt = h.db.createAccount("@matt", "00".repeat(32), "tg:42", 25_000);
    const s = await stack(h);
    cleanup = s.close;
    const caller = "+14155550077";
    const t = await s.stream((await s.ring(caller)).text);
    await until(() => s.openaiSockets.length === 1);
    const ai = s.openai();
    await until(() => ai.got.some((m) => m.type === "response.create"));
    const first = ai.got.find((m) => m.type === "session.update").session;
    expect(first.tools.map((x: { name: string }) => x.name)).toEqual(["end_call"]);
    const code = /Their code is (\d{4})\./.exec(first.instructions)?.[1];
    expect(code).toBeDefined();
    expect(first.instructions).toContain(`"${code!.split("").join(" ")}"`);
    expect(h.phone!.pending(code!)).toBe(true);
    // The greeting (the code) is spoken.
    ai.sock.send(JSON.stringify({ type: "response.created" }));
    ai.sock.send(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "Jarvis here. Text the code to Jarvis on Telegram." }));
    ai.sock.send(JSON.stringify({ type: "response.done", response: { status: "completed" } }));
    // A wrong code is not a link; the right one texted by Matt links the number without a model call.
    await h.send("tg:42", String((Number(code) + 1) % 10_000).padStart(4, "0"));
    expect(h.db.accountByHandle(caller)).toBeUndefined();
    await h.deliver(tgInbound(42, code!, "mokner", "Matt"));
    expect(h.db.accountByHandle(caller)?.id).toBe(matt.id);
    expect(h.to("tg:42").at(-1)).toBe(`Linked ${caller} to your account. Calls from it are you now; call me at ${NUMBER} any time.`);
    expect(h.remaining()).toBe(0);
    await until(() => ai.got.filter((m) => m.type === "session.update").length === 2);
    const second = ai.got.filter((m) => m.type === "session.update").at(-1).session;
    expect(second.tools.map((x: { name: string }) => x.name)).toContain("get_balance");
    expect(second.instructions).toContain("Linked phone numbers (calls from these are @matt): +14155550077");
    expect(second.audio.output.voice).toBeUndefined(); // only the first update may set the voice
    await until(() => ai.got.some((m) => m.type === "conversation.item.create" && m.item.content?.[0]?.text?.includes("now linked: they are @matt")));
    t.sock.close();
  }, 15_000);

  it("accepts unsigned webhooks only when told to (dev)", async () => {
    const h = harness(1, undefined, { phone: NUMBER });
    const s = await stack(h, { allowUnsigned: true });
    cleanup = s.close;
    expect((await s.ring(PHONES.matt, "CA1", false)).status).toBe(200);
    const s2 = await stack(h, {});
    const prev = cleanup;
    cleanup = async () => (await prev(), s2.close());
    expect((await s2.ring(PHONES.matt, "CA1", false)).status).toBe(503);
  });
});

describe("linking a number by text", () => {
  it("link_phone and unlink_phone through the engine, and the Phone line in the facts", async () => {
    const h = harness(1, undefined, { phone: NUMBER });
    const matt = await h.onboard("matt", 0);
    const phone = h.phone!;
    expect(ownerFacts(h.db, matt, "$250.00", undefined, undefined, phone).find((l) => l.startsWith("Phone:"))).toBe(
      `Phone: @matt can call you at ${NUMBER} and talk instead of typing; a call can do everything a text can. Linked phone numbers (calls from these are @matt): ${PHONES.matt}. They can unlink one (unlink_phone).`,
    );
    h.script(delegate("link +1 415 555 0199"), call("link_phone", { number: "+1 (415) 555-0199" }), say("Linked."));
    await h.send(PHONES.matt, "my other number is 415 555 0199, link it");
    expect(h.db.accountByHandle("+14155550199")?.id).toBe(matt.id);
    expect(h.requests.filter((r) => r.tools.some((t) => t.name === "propose_action")).at(-1)!.tools.map((t) => t.name)).toContain("link_phone");
    // Another account cannot take a linked number; the primary handle cannot be unlinked.
    const yadu = h.db.createAccount("@yadu", "11".repeat(32), "tg:7", 0);
    expect(phone.link(yadu.id, "+14155550199")).toEqual({ ok: false, reason: "***0199 is already linked to another account." });
    expect(phone.link(yadu.id, "415")).toMatchObject({ ok: false });
    expect(phone.unlink(matt.id, PHONES.matt)).toMatchObject({ ok: false });
    expect(phone.unlink(matt.id, "+14155550199")).toEqual({ ok: true, handle: "+14155550199" });
    expect(phone.numbersOf(matt.id)).toEqual([PHONES.matt]);
  });

  it("codes: one per caller, claimed once, gone after linking", () => {
    const h = harness(0, undefined, { phone: NUMBER });
    const matt = h.db.createAccount("@matt", "00".repeat(32), "tg:42", 0);
    const links = createPhoneLinks({ db: h.db });
    const code = links.issue("+14155550077");
    expect(links.issue("+14155550077")).toBe(code);
    expect(links.pending("0000")).toBe(code === "0000");
    expect(links.claim(matt.id, "nope")).toMatchObject({ ok: false });
    const linked: number[] = [];
    links.onLinked("+14155550077", (id) => linked.push(id));
    expect(links.claim(matt.id, code)).toEqual({ ok: true, handle: "+14155550077" });
    expect(linked).toEqual([matt.id]);
    expect(links.pending(code)).toBe(false);
    expect(links.numbersOf(matt.id)).toEqual(["+14155550077"]);
  });
});
