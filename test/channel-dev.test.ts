import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevChannel, devOutbox, devSend, type DevChannel } from "../src/channels/dev.js";
import type { InboundMessage } from "../src/types.js";

let channel: DevChannel | undefined;
afterEach(async () => {
  await channel?.stop();
  channel = undefined;
});

async function startEcho(): Promise<{ url: string; got: InboundMessage[] }> {
  const ch = createDevChannel({ port: 0, repl: false, log: () => {} });
  channel = ch;
  const got: InboundMessage[] = [];
  await ch.start(async (m) => {
    got.push(m);
    await ch.send(m.handle, `echo: ${m.text}`);
    // Like an approval: finishes after the request returned.
    setTimeout(() => {
      void ch.send(m.handle, `done: ${m.text}`);
      void ch.send("+15550000003", `fyi ${m.text}`);
    }, 50);
  });
  expect(ch.port).toBeGreaterThan(0);
  return { url: ch.url, got };
}

describe("dev channel", () => {
  it("delivers a posted text and returns the replies sent during the call", async () => {
    const { url, got } = await startEcho();
    const res = await devSend(url, "+15550000001", "send $5 to @gabriel");
    expect(res.replies).toEqual(["echo: send $5 to @gabriel"]);
    expect(got[0]).toMatchObject({ handle: "+15550000001", text: "send $5 to @gabriel", images: [], service: "dev" });
    expect(got[0]?.id).toMatch(/^dev-/);

    // Later texts show up in the outbox after the cursor.
    await vi.waitFor(async () => {
      const page = await devOutbox(url, "+1 555 000 0001", res.since);
      expect(page.messages.map((m) => m.text)).toEqual(["done: send $5 to @gabriel"]);
    });
    const all = await devOutbox(url);
    expect(all.messages.map((m) => m.to)).toEqual(["+15550000001", "+15550000001", "+15550000003"]);
    expect(all.since).toBe(3);
    expect(Date.parse(all.messages[0]!.at)).not.toBeNaN();
  });

  it("does not make one handle wait for another", async () => {
    const ch = createDevChannel({ port: 0, repl: false, log: () => {} });
    channel = ch;
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    await ch.start(async (m) => {
      if (m.text === "slow") await gate; // finishes only after Yadu's text was handled
      else openGate();
      await ch.send(m.handle, `echo: ${m.text}`);
    });
    const [a, b] = await Promise.all([devSend(ch.url, "+15550000001", "slow"), devSend(ch.url, "+15550000002", "fast")]);
    expect(a.replies).toEqual(["echo: slow"]);
    expect(b.replies).toEqual(["echo: fast"]);
  });

  it("handles texts from the same handle one at a time, in order", async () => {
    const ch = createDevChannel({ port: 0, repl: false, log: () => {} });
    channel = ch;
    const events: string[] = [];
    await ch.start(async (m) => {
      events.push(`start ${m.text}`);
      await new Promise((r) => setTimeout(r, m.text === "1" ? 60 : 1));
      await ch.send(m.handle, `echo: ${m.text}`);
      events.push(`end ${m.text}`);
    });
    const first = devSend(ch.url, "+15550000001", "1");
    await vi.waitFor(() => expect(events).toContain("start 1"));
    const second = devSend(ch.url, "+1 (555) 000-0001", "2");
    const [a, b] = await Promise.all([first, second]);
    expect(events).toEqual(["start 1", "end 1", "start 2", "end 2"]);
    expect(a.replies).toEqual(["echo: 1"]);
    expect(b.replies).toEqual(["echo: 2"]);
  });

  it("refuses foreign Host headers and non-JSON posts with 403", async () => {
    const { url, got } = await startEcho();
    const { port } = new URL(url);
    const outbox = { method: "GET", path: "/dev/outbox" };
    expect((await raw(port, { ...outbox, host: "evil.example" })).status).toBe(403);
    expect((await raw(port, { ...outbox, host: `evil.example:${port}` })).status).toBe(403);
    expect((await raw(port, { ...outbox, host: `localhost:${port}` })).status).toBe(200);
    expect((await raw(port, { ...outbox, host: "[::1]" })).status).toBe(200);
    expect((await raw(port, { ...outbox, host: `127.0.0.1:${port}` })).status).toBe(200);

    const body = JSON.stringify({ handle: "+15550000001", text: "hi" });
    const post = { method: "POST", path: "/dev/message", host: `127.0.0.1:${port}`, body };
    const plain = await raw(port, { ...post, contentType: "text/plain" });
    expect(plain.status).toBe(403);
    expect(plain.body).toMatch(/application\/json/);
    expect((await raw(port, { ...post, contentType: "application/x-www-form-urlencoded" })).status).toBe(403);
    expect((await raw(port, post)).status).toBe(403);
    expect((await raw(port, { ...post, host: "evil.example", contentType: "application/json" })).status).toBe(403);
    expect(got).toHaveLength(0);
    expect((await raw(port, { ...post, contentType: "application/json; charset=utf-8" })).status).toBe(200);
    expect(got).toHaveLength(1);
  });

  it("rejects a missing image and bad bodies", async () => {
    const { url } = await startEcho();
    await expect(devSend(url, "+15550000001", "receipt", ["/nonexistent/receipt.jpg"])).rejects.toThrow(/image not found/);
    const res = await fetch(new URL("/dev/message", url), { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(res.status).toBe(400);
    expect((await fetch(new URL("/nope", url))).status).toBe(404);
  });

  it("prints a reaction to an inbound text in the log, not the outbox", async () => {
    const lines: string[] = [];
    const ch = createDevChannel({ port: 0, repl: false, log: (l) => lines.push(l) });
    channel = ch;
    await ch.start(async (m) => {
      await ch.typing!(m.handle, true);
      await ch.react!(m.id, "👍");
      await ch.send(m.handle, "on it");
    });
    const res = await ch.deliver("+15550000001", "send $5 to @gabriel");
    expect(res.replies).toEqual(["on it"]);
    expect(lines).toContain("agent reacted 👍 to +15550000001 (Matt)'s message");
    await ch.react!("unknown-id", "👍"); // never throws
  });
});

/** A raw HTTP request, so the test controls the Host header (fetch does not allow that). */
function raw(
  port: string,
  o: { method: string; path: string; host: string; contentType?: string; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: o.host };
    if (o.contentType) headers["content-type"] = o.contentType;
    const req = request({ host: "127.0.0.1", port: Number(port), method: o.method, path: o.path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}
