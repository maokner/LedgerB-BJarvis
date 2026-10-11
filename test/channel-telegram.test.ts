import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramChannel } from "../src/channels/telegram.js";
import type { Channel, InboundMessage } from "../src/types.js";

const TOKEN = "123:fake";
const MATT = { id: 42, first_name: "Matt", last_name: "Okner", username: "mattokner" };

/** An in-process Bot API: records calls, serves queued updates by offset, and serves files. Never api.telegram.org. */
async function fakeBotApi() {
  const calls: { method: string; body: Record<string, any> }[] = [];
  const updates: Record<string, unknown>[] = [];
  const sent: string[] = [];
  const state = { failGetUpdates: 0, slowText: "" };
  let nextId = 1;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (req.url?.startsWith(`/file/bot${TOKEN}/`)) return res.end(`bytes of ${req.url.split("/").pop()}`);
      const method = req.url?.split("/").pop() ?? "";
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method, body });
      if (method === "getMe") return json(200, { ok: true, result: { id: 1, is_bot: true, username: "jarvis_test_bot" } });
      if (method === "getUpdates") {
        if (state.failGetUpdates > 0) {
          state.failGetUpdates -= 1;
          return json(500, { ok: false, error_code: 500, description: "Internal Server Error" });
        }
        const ready = () => updates.filter((u) => (u.update_id as number) >= (body.offset ?? 0));
        for (let i = 0; i < 10 && ready().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
        return json(200, { ok: true, result: ready() });
      }
      if (method === "getFile") return json(200, { ok: true, result: { file_id: body.file_id, file_path: `photos/${body.file_id}.jpg` } });
      if (method === "sendMessage") {
        if (body.chat_id === 666) return json(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
        if (state.slowText && body.text.startsWith(state.slowText)) await new Promise((r) => setTimeout(r, 80));
        sent.push(body.text);
      }
      return json(200, { ok: true, result: true });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const push = (message: Record<string, unknown>) => updates.push({ update_id: nextId++, message });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, sent, state, push, close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))) };
}

let n = 100;
const dm = (over: Record<string, unknown> = {}) => ({ message_id: n++, date: 1_790_000_000, chat: { id: MATT.id, type: "private" }, from: MATT, text: "hello", ...over });

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function setup(): Promise<{ api: Awaited<ReturnType<typeof fakeBotApi>>; channel: Channel; got: InboundMessage[]; dataDir: string; logs: string[] }> {
  const api = await fakeBotApi();
  const dataDir = mkdtempSync(join(tmpdir(), "agentsign-tg-"));
  const logs: string[] = [];
  const channel = createTelegramChannel({ token: TOKEN, apiBase: api.url, dataDir, log: (l) => logs.push(l) });
  const got: InboundMessage[] = [];
  cleanup.push(api.close, () => channel.stop());
  await channel.start(async (m) => {
    got.push(m);
  });
  return { api, channel, got, dataDir, logs };
}

describe("Telegram channel", () => {
  it("turns a private text into an InboundMessage and advances the offset", async () => {
    const { api, got } = await setup();
    api.push(dm({ text: "send $5 to @yadu" }));
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(got[0]).toMatchObject({ handle: "tg:42", username: "mattokner", name: "Matt Okner", text: "send $5 to @yadu", images: [], service: "telegram" });
    expect(got[0]?.id).toMatch(/^42:\d+$/);
    expect(got[0]?.at).toEqual(new Date(1_790_000_000_000));
    const poll = api.calls.find((c) => c.method === "getUpdates");
    expect(poll?.body).toMatchObject({ timeout: 30, allowed_updates: ["message"] });
    await vi.waitFor(() => expect(api.calls.some((c) => c.method === "getUpdates" && c.body.offset === 2)).toBe(true));
    expect(got).toHaveLength(1);
  });

  it("downloads the largest photo size and image documents, with the caption as text", async () => {
    const { api, got, dataDir } = await setup();
    const sizes = [{ file_id: "small", width: 90, height: 90 }, { file_id: "big", width: 1280, height: 960 }, { file_id: "mid", width: 320, height: 240 }];
    api.push(dm({ text: undefined, caption: "pay yadu back for lunch", photo: sizes }));
    api.push(dm({ text: undefined, document: { file_id: "scan", file_name: "r.png", mime_type: "image/png" } }));
    api.push(dm({ text: undefined, document: { file_id: "pdf", file_name: "r.pdf", mime_type: "application/pdf" } }));
    await vi.waitFor(() => expect(got).toHaveLength(2));
    expect(got[0]?.text).toBe("pay yadu back for lunch");
    expect(got[0]?.images).toHaveLength(1);
    expect(got[0]?.images[0]?.startsWith(dataDir)).toBe(true);
    expect(readFileSync(got[0]!.images[0]!, "utf8")).toBe("bytes of big.jpg");
    expect(readFileSync(got[1]!.images[0]!, "utf8")).toBe("bytes of scan.jpg");
    expect(api.calls.filter((c) => c.method === "getFile").map((c) => c.body.file_id)).toEqual(["big", "scan"]);
  });

  it("delivers /start as hi, other commands without the slash, and ignores groups and bots", async () => {
    const { api, got } = await setup();
    api.push(dm({ text: "/start" }));
    api.push(dm({ text: "/start ref123" }));
    api.push(dm({ chat: { id: -100, type: "group" }, text: "hi group" }));
    api.push(dm({ chat: { id: -200, type: "channel" }, text: "hi channel" }));
    api.push(dm({ from: { id: 7, is_bot: true, first_name: "Bot" }, chat: { id: 7, type: "private" } }));
    api.push(dm({ text: "/help@jarvis_test_bot now" }));
    await vi.waitFor(() => expect(got).toHaveLength(3));
    expect(got.map((m) => m.text)).toEqual(["hi", "hi", "help now"]);
  });

  it("splits long texts, keeps sends to one chat in order, and enables link previews", async () => {
    const { api, channel } = await setup();
    api.state.slowText = "A";
    const long = `${"A".repeat(3000)}\n${"a".repeat(3000)}`;
    await Promise.all([channel.send("tg:42", long), channel.send("tg:42", "B after")]);
    expect(api.sent.map((t) => t.slice(0, 1))).toEqual(["A", "a", "B"]);
    expect(api.sent.every((t) => t.length <= 4000)).toBe(true);
    const first = api.calls.find((c) => c.method === "sendMessage");
    expect(first?.body).toMatchObject({ chat_id: 42, link_preview_options: { is_disabled: false } });
  });

  it("explains that a blocked or never-started user has to press Start", async () => {
    const { channel } = await setup();
    await expect(channel.send("tg:666", "hello")).rejects.toThrow(/open @jarvis_test_bot in Telegram and press Start/);
    await expect(channel.send("+14155551234", "hello")).rejects.toThrow(/not a Telegram handle/);
  });

  it("repeats typing every 4 s while on and reacts with an allowed emoji", async () => {
    const { api, channel } = await setup();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const actions = () => api.calls.filter((c) => c.method === "sendChatAction");
    await channel.typing!("tg:42", true);
    await vi.waitFor(() => expect(actions()).toHaveLength(1));
    vi.advanceTimersByTime(8000);
    await vi.waitFor(() => expect(actions()).toHaveLength(3));
    await channel.typing!("tg:42", false);
    vi.advanceTimersByTime(8000);
    expect(actions()[0]?.body).toEqual({ chat_id: 42, action: "typing" });
    expect(actions()).toHaveLength(3);

    await channel.react!("42:101", "👍");
    await channel.react!("42:102", "✅");
    const reactions = api.calls.filter((c) => c.method === "setMessageReaction").map((c) => c.body);
    expect(reactions).toEqual([
      { chat_id: 42, message_id: 101, reaction: [{ type: "emoji", emoji: "👍" }] },
      { chat_id: 42, message_id: 102, reaction: [{ type: "emoji", emoji: "👍" }] },
    ]);
  });

  it("resumes polling after a 500", async () => {
    const { api, got, logs } = await setup();
    api.state.failGetUpdates = 1;
    await vi.waitFor(() => expect(logs.some((l) => /getUpdates failed.*500/.test(l))).toBe(true));
    api.push(dm({ text: "still there?" }));
    await vi.waitFor(() => expect(got.map((m) => m.text)).toEqual(["still there?"]), { timeout: 4000 });
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
});
