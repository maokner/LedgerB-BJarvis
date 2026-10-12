import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPhotonChannel, type PhotonClient, type PhotonContent, type PhotonMessage, type PhotonSpace } from "../src/channels/photon.js";
import type { Channel, InboundMessage } from "../src/types.js";

const MATT = "+14155550001";
const GABE = "+14155550002";
const NUMBER = "+14155550199";
const dm = (address: string): PhotonSpace => ({ id: `any;-;${address}`, type: "dm", phone: "shared" });
const GROUP: PhotonSpace = { id: "any;+;chat42", type: "group", phone: "shared" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Spectrum message with recorded reactions and read receipts. */
type FakeMessage = PhotonMessage & { reactions: string[]; reads: number; platform?: string };
let seq = 0;
function message(content: PhotonContent, over: Partial<FakeMessage> = {}, address = MATT): FakeMessage {
  return {
    id: `msg-${++seq}`,
    direction: "inbound",
    sender: { id: address, address, service: "iMessage" },
    timestamp: new Date(1_790_000_000_000),
    content,
    reactions: [],
    reads: 0,
    async react(emoji) {
      this.reactions.push(emoji);
    },
    async read() {
      this.reads += 1;
    },
    ...over,
  };
}
const text = (t: string, address = MATT) => message({ type: "text", text: t }, {}, address);
const image = (bytes: string, wait = 0): PhotonContent => ({
  type: "attachment",
  name: "IMG_0001.HEIC",
  mimeType: "image/heic",
  size: bytes.length,
  read: async () => (await sleep(wait), Buffer.from(bytes)),
});

/** Photon's cloud, in memory: every connection is a stream we push into; sends, typing and chats are recorded. */
function fakePhoton() {
  const world = {
    sent: [] as { space: string; text: string }[],
    typing: [] as { space: string; on: boolean }[],
    created: [] as string[],
    got: [] as string[],
    /** Chats a shared line may not open (the person never texted it). */
    strangers: new Set<string>(),
    slowText: "",
    connections: [] as ReturnType<typeof connection>[],
    failConnect: false,
  };
  function connection() {
    const queue: [PhotonSpace, PhotonMessage][] = [];
    let wake: (() => void) | undefined;
    const state = { ended: false, stopped: false };
    const end = () => {
      state.ended = true;
      wake?.();
    };
    const client: PhotonClient = {
      messages: {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (queue.length) yield queue.shift()!;
            if (state.ended) return;
            await new Promise<void>((r) => (wake = r));
          }
        },
      },
      async send(space, t) {
        if (world.strangers.has(space.id)) throw Object.assign(new Error("recipient has not messaged this line"), { code: "newContactThrottled" });
        if (world.slowText && t.startsWith(world.slowText)) await sleep(80);
        world.sent.push({ space: space.id, text: t });
      },
      async typing(space, on) {
        world.typing.push({ space: space.id, on });
      },
      space: {
        async create(handle) {
          world.created.push(handle);
          return dm(handle);
        },
        async get(id) {
          world.got.push(id);
          return { id, type: "dm", phone: "shared" };
        },
      },
      is: (m) => (m as FakeMessage).platform !== "telegram",
      async stop() {
        state.stopped = true;
        end();
      },
    };
    const push = (space: PhotonSpace, m: PhotonMessage) => {
      queue.push([space, m]);
      wake?.();
    };
    return { client, push, end, state };
  }
  const connect = async () => {
    if (world.failConnect) throw new Error("401 Unauthorized: invalid project secret");
    const c = connection();
    world.connections.push(c);
    return c.client;
  };
  const push = (space: PhotonSpace, m: PhotonMessage) => world.connections.at(-1)!.push(space, m);
  return { world, connect, push };
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

async function setup(options: { maxChars?: number; stored?: Map<string, string>; onMessage?: (m: InboundMessage) => Promise<void> } = {}) {
  const photon = fakePhoton();
  const dataDir = mkdtempSync(join(tmpdir(), "agentsign-photon-"));
  const logs: string[] = [];
  const stored = options.stored ?? new Map<string, string>();
  const channel: Channel = createPhotonChannel({
    projectId: "proj",
    projectSecret: "secret",
    number: NUMBER,
    dataDir,
    maxChars: options.maxChars,
    log: (l) => logs.push(l),
    spaces: { get: (h) => stored.get(h), set: (h, id) => void stored.set(h, id) },
    connect: photon.connect,
  });
  const got: InboundMessage[] = [];
  cleanup.push(() => channel.stop());
  await channel.start(
    options.onMessage ??
      (async (m) => {
        got.push(m);
      }),
  );
  return { ...photon, channel, got, dataDir, logs, stored };
}

describe("Photon iMessage channel", () => {
  it("turns a direct text into an InboundMessage, marks it read and remembers the chat", async () => {
    const { push, got, stored } = await setup();
    const m = text("send $5 to @yadu");
    push(dm(MATT), m);
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(got[0]).toEqual({ id: m.id, handle: MATT, text: "send $5 to @yadu", images: [], at: new Date(1_790_000_000_000), service: "iMessage" });
    expect(m.reads).toBe(1);
    expect(stored.get(MATT)).toBe(`any;-;${MATT}`);
  });

  it("writes image attachments into dataDir and joins a photo with its words into one message", async () => {
    const { push, got, dataDir, logs } = await setup();
    push(dm(MATT), message({ type: "group", items: [message(image("receipt bytes")), text("pay gabe back for lunch")] }));
    push(dm(MATT), message({ type: "attachment", name: "menu.pdf", mimeType: "application/pdf", read: async () => Buffer.from("pdf") }));
    push(dm(MATT), message({ type: "reply", content: { type: "text", text: "yes" } }));
    await vi.waitFor(() => expect(got).toHaveLength(2));
    expect(got[0]?.text).toBe("pay gabe back for lunch");
    expect(got[0]?.images).toHaveLength(1);
    expect(got[0]?.images[0]?.startsWith(dataDir)).toBe(true);
    expect(got[0]?.images[0]).toMatch(/\.HEIC$/);
    expect(readFileSync(got[0]!.images[0]!, "utf8")).toBe("receipt bytes");
    expect(got[1]?.text).toBe("yes");
    expect(logs.some((l) => /attachment of msg-\d+ dropped: application\/pdf/.test(l))).toBe(true);
  });

  it("drops group chats, tapbacks, its own sends, other platforms and empty rows", async () => {
    const { push, got } = await setup();
    const tapback = message({ type: "reaction" });
    push(GROUP, text("hi group"));
    push(dm(MATT), tapback);
    push(dm(MATT), message({ type: "text", text: "sent by Jarvis" }, { direction: "outbound" }));
    push(dm(MATT), message({ type: "text", text: "agent echo" }, { sender: { id: NUMBER, kind: "agent" } }));
    push(dm(MATT), message({ type: "text", text: "from telegram" }, { platform: "telegram" }));
    push(dm(MATT), message({ type: "text", text: "   " }));
    push(dm(MATT), message({ type: "contact" }));
    push(dm(MATT), text("still there?"));
    await vi.waitFor(() => expect(got.map((m) => m.text)).toEqual(["still there?"]));
    await sleep(20);
    expect(got).toHaveLength(1);
    expect(tapback.reads).toBe(0);
  });

  it("keeps each sender's order and never lets one slow turn hold up someone else", async () => {
    const got: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const { push } = await setup({
      onMessage: async (m) => {
        got.push(m.text || "(photo)");
        if (m.text === "hold") await held; // a slow turn for Gabe
      },
    });
    push(dm(GABE), text("hold", GABE));
    push(dm(MATT), message(image("slow photo", 80))); // its download finishes after the next text arrives
    push(dm(MATT), text("after the photo"));
    push(dm(GABE), text("gabe again", GABE));
    await vi.waitFor(() => expect(got).toHaveLength(4));
    expect(got.filter((t) => t !== "hold" && t !== "gabe again")).toEqual(["(photo)", "after the photo"]);
    expect(got.indexOf("hold")).toBeLessThan(got.indexOf("gabe again"));
    release();
  });

  it("splits long texts and keeps sends to one person in order, in the chat they wrote from", async () => {
    const { push, got, world, channel } = await setup({ maxChars: 100 });
    push(dm(MATT), text("hi"));
    await vi.waitFor(() => expect(got).toHaveLength(1));
    world.slowText = "A";
    await Promise.all([channel.send(MATT, `${"A".repeat(80)}\n${"a".repeat(80)}`), channel.send("(415) 555-0001", "B after")]);
    expect(world.sent.map((s) => s.text.slice(0, 1))).toEqual(["A", "a", "B"]);
    expect(world.sent.every((s) => s.text.length <= 100 && s.space === `any;-;${MATT}`)).toBe(true);
    expect(world.created).toEqual([]);
  });

  it("opens a chat for an unknown handle, and after a restart reuses the stored one", async () => {
    const first = await setup();
    await first.channel.send(GABE, "@matt says: thanks for lunch");
    expect(first.world.created).toEqual([GABE]);
    expect(first.world.sent).toEqual([{ space: `any;-;${GABE}`, text: "@matt says: thanks for lunch" }]);
    const second = await setup({ stored: first.stored });
    await second.channel.send(GABE, "again");
    expect(second.world.created).toEqual([]);
    expect(second.world.got).toEqual([`any;-;${GABE}`]);
  });

  it("says plainly that someone has to text Jarvis first on a shared line", async () => {
    const { channel, world } = await setup();
    world.strangers.add(`any;-;${GABE}`);
    await expect(channel.send(GABE, "hello")).rejects.toThrow(`iMessage cannot reach ${GABE}: they have to text Jarvis at ${NUMBER} first.`);
    await expect(channel.send("tg:42", "hello")).rejects.toThrow(/Telegram user; the iMessage channel cannot text them/);
  });

  it("shows typing only in a chat someone wrote from, and reacts to recent messages", async () => {
    const { push, got, world, channel } = await setup();
    await channel.typing!(GABE, true); // never wrote: nothing, and never opens a chat
    const m = text("hello");
    push(dm(MATT), m);
    await vi.waitFor(() => expect(got).toHaveLength(1));
    await channel.typing!(MATT, true);
    await channel.typing!(MATT, false);
    expect(world.typing).toEqual([
      { space: `any;-;${MATT}`, on: true },
      { space: `any;-;${MATT}`, on: false },
    ]);
    expect(world.created).toEqual([]);
    await channel.react!(m.id, "👍");
    await channel.react!("msg-unknown", "👍");
    expect(m.reactions).toEqual(["👍"]);
  });

  it("reconnects when the stream ends, and stop() closes the connection", async () => {
    const { world, push, got, channel, logs } = await setup();
    world.connections[0]!.end();
    await vi.waitFor(() => expect(world.connections).toHaveLength(2), { timeout: 3000 });
    expect(world.connections[0]!.state.stopped).toBe(true);
    expect(logs.some((l) => /stream ended; reconnecting/.test(l))).toBe(true);
    push(dm(MATT), text("back"));
    await vi.waitFor(() => expect(got.map((m) => m.text)).toEqual(["back"]));
    await channel.stop();
    expect(world.connections[1]!.state.stopped).toBe(true);
  });

  it("fails start with a clear message when Photon refuses the project", async () => {
    const photon = fakePhoton();
    photon.world.failConnect = true;
    const channel = createPhotonChannel({ projectId: "p", projectSecret: "s", connect: photon.connect, log: () => {} });
    await expect(channel.start(async () => {})).rejects.toThrow(/Cannot connect to Photon's iMessage service: 401 Unauthorized.*SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET/);
    await channel.stop();
  });
});
