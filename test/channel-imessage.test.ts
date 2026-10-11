import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, DispatchEvents, Message } from "@photon-ai/imessage-kit";
import { describe, expect, it, vi } from "vitest";
import { createIMessageChannel, type PhotonSDK } from "../src/channels/imessage.js";
import type { InboundMessage } from "../src/types.js";

// A fully fake Photon SDK. Nothing here touches chat.db or Messages.app.
function fakeSdk() {
  let events: DispatchEvents = {};
  const sent: { to: string; text?: string }[] = [];
  const sdk = {
    getMessages: vi.fn(async (): Promise<readonly Message[]> => []),
    startWatching: vi.fn(async (e: DispatchEvents) => {
      events = e;
    }),
    stopWatching: vi.fn(async () => {}),
    send: vi.fn(async (r: { to: string; text?: string }) => {
      sent.push(r);
    }),
    close: vi.fn(async () => {}),
  };
  const emit = (m: Message) => events.onDirectMessage?.(m);
  return { sdk, photon: sdk as unknown as PhotonSDK, sent, emit };
}

let n = 0;
function msg(over: Partial<Record<keyof Message, unknown>> = {}): Message {
  n += 1;
  return {
    id: `guid-${n}`,
    rowId: n,
    chatId: "iMessage;-;+14155551234",
    chatKind: "dm",
    participant: "+14155551234",
    service: "iMessage",
    text: "hello",
    kind: "text",
    isFromMe: false,
    isAutoReply: false,
    isSystem: false,
    reaction: null,
    hasAttachments: false,
    attachments: [],
    createdAt: new Date("2026-10-10T12:00:00Z"),
    ...over,
  } as unknown as Message;
}

function image(over: Partial<Record<keyof Attachment, unknown>> = {}): Attachment {
  return { id: "att", mimeType: "image/heic", localPath: null, transferStatus: "complete", ...over } as unknown as Attachment;
}

const quiet = { log: () => {} };

async function started(options: Record<string, unknown> = {}) {
  const fake = fakeSdk();
  const got: InboundMessage[] = [];
  const channel = createIMessageChannel({ sdk: fake.photon, ...quiet, ...options });
  await channel.start(async (m) => {
    got.push(m);
  });
  return { ...fake, channel, got };
}

describe("iMessage channel mapping", () => {
  it("drops from-me, reactions, group chats, system rows, auto-replies and empty rows", async () => {
    const { emit, got, sdk } = await started();
    expect(sdk.getMessages).toHaveBeenCalledWith({ limit: 1 });
    emit(msg({ isFromMe: true }));
    emit(msg({ reaction: { kind: "like" } }));
    emit(msg({ chatKind: "group" }));
    emit(msg({ isSystem: true }));
    emit(msg({ isAutoReply: true }));
    emit(msg({ text: "   " }));
    emit(msg({ kind: "memberAdded" }));
    emit(msg({ text: "send $5 to @gabriel", service: null }));
    emit(msg({ text: "via sms", service: "SMS" }));
    await vi.waitFor(() => expect(got).toHaveLength(2));
    expect(got[0]).toMatchObject({ handle: "+14155551234", text: "send $5 to @gabriel", images: [], service: "iMessage" });
    expect(got[0]?.id).toMatch(/^guid-/);
    expect(got[0]?.at).toBeInstanceOf(Date);
    expect(got[1]?.service).toBe("SMS");
  });

  it("waits for an image whose localPath shows up late and drops non-images", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentsign-"));
    const path = join(dir, "receipt.heic");
    writeFileSync(path, "x");
    const fake = fakeSdk();
    const first = msg({
      text: "pay gabe back for lunch",
      hasAttachments: true,
      attachments: [image({ localPath: null, transferStatus: "transferring" }), image({ mimeType: "application/pdf", localPath: path })],
    });
    let calls = 0;
    fake.sdk.getMessages.mockImplementation(async () => {
      calls += 1;
      if (calls < 4) return [];
      return [{ ...first, attachments: [image({ localPath: path, transferStatus: "complete" }), first.attachments[1]] } as Message];
    });
    const got: InboundMessage[] = [];
    const channel = createIMessageChannel({ sdk: fake.photon, pollMs: 20, ...quiet });
    await channel.start(async (m) => {
      got.push(m);
    });
    fake.emit(first);
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(got[0]?.images).toEqual([path]);
    expect(got[0]?.text).toBe("pay gabe back for lunch");
  });

  it("waits for a localPath whose file is still being written", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "agentsign-")), "photo.jpg");
    const { emit, got } = await started({ pollMs: 20 });
    emit(msg({ text: "", hasAttachments: true, attachments: [image({ mimeType: "image/jpeg", localPath: path })] }));
    setTimeout(() => writeFileSync(path, "x"), 150);
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(got[0]).toMatchObject({ text: "", images: [path] });
  });

  it("gives up on an image that never arrives and still delivers the text", async () => {
    const { emit, got } = await started({ pollMs: 20, attachmentWaitMs: 150 });
    emit(msg({ text: "see photo", hasAttachments: true, attachments: [image({ transferStatus: "pending" })] }));
    await vi.waitFor(() => expect(got).toHaveLength(1));
    expect(got[0]?.images).toEqual([]);
  });
});

describe("iMessage channel delivery", () => {
  it("does not wait for a slow turn before delivering the next message", async () => {
    const fake = fakeSdk();
    const events: string[] = [];
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    const channel = createIMessageChannel({ sdk: fake.photon, ...quiet });
    await channel.start(async (m) => {
      events.push(`start ${m.text}`);
      if (m.text === "slow") await gate; // only finishes once the same sender's next message was delivered
      if (m.text === "same sender") openGate();
      events.push(`end ${m.text}`);
    });
    fake.emit(msg({ text: "slow" }));
    fake.emit(msg({ text: "next", participant: "+14155550000" }));
    fake.emit(msg({ text: "same sender" }));
    await vi.waitFor(() => expect(events).toHaveLength(6));
    expect(events.slice(0, 2)).toEqual(["start slow", "start next"]);
    expect(events.indexOf("start same sender")).toBeLessThan(events.indexOf("end slow"));
    expect(events.at(-1)).toBe("end slow");
  });

  it("keeps one sender's messages in arrival order across an attachment wait, without blocking others", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "agentsign-")), "late.jpg");
    const { emit, got } = await started({ pollMs: 20 });
    emit(msg({ text: "photo", hasAttachments: true, attachments: [image({ mimeType: "image/jpeg", localPath: path })] }));
    emit(msg({ text: "after photo" }));
    emit(msg({ text: "other person", participant: "+14155550000" }));
    await vi.waitFor(() => expect(got.map((m) => m.text)).toEqual(["other person"]));
    writeFileSync(path, "x");
    await vi.waitFor(() => expect(got.map((m) => m.text)).toEqual(["other person", "photo", "after photo"]));
    expect(got[1]?.images).toEqual([path]);
  });

  it("keeps going after a handler error and never throws into the watcher", async () => {
    const fake = fakeSdk();
    const seen: string[] = [];
    const channel = createIMessageChannel({ sdk: fake.photon, ...quiet });
    await channel.start(async (m) => {
      seen.push(m.text);
      if (m.text === "boom") throw new Error("boom");
    });
    expect(() => fake.emit(msg({ text: "boom" }))).not.toThrow();
    fake.emit(msg({ text: "after" }));
    await vi.waitFor(() => expect(seen).toEqual(["boom", "after"]));
  });

  it("fails at startup with Full Disk Access instructions when chat.db is unreadable", async () => {
    const fake = fakeSdk();
    fake.sdk.getMessages.mockRejectedValue(new Error("Failed to open database: unable to open database file"));
    const channel = createIMessageChannel({ sdk: fake.photon, ...quiet });
    const started = channel.start(async () => {});
    await expect(started).rejects.toThrow(/System Settings > Privacy & Security > Full Disk Access/);
    await expect(started).rejects.toThrow(/unable to open database file/);
    expect(fake.sdk.startWatching).not.toHaveBeenCalled();
  });

  it("splits long texts into several sends", async () => {
    const { channel, sent } = await started();
    const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ") + "\n" + "z".repeat(1700);
    await channel.send("+14155551234", text);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const s of sent) {
      expect(s.to).toBe("+14155551234");
      expect(s.text!.length).toBeLessThanOrEqual(1500);
    }
    expect(sent.map((s) => s.text).join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });

  it("sends a short text as one message", async () => {
    const { channel, sent } = await started();
    await channel.send("matt@example.com", "Please confirm on your Ledger");
    expect(sent).toEqual([{ to: "matt@example.com", text: "Please confirm on your Ledger" }]);
  });

  it("maps the -1743 osascript error to Automation instructions", async () => {
    const { channel, sdk } = await started();
    const cause = new Error("execution error: Not authorized to send Apple events to Messages. (-1743)");
    sdk.send.mockRejectedValue(new Error("Send failed: osascript exited with code 1", { cause }));
    await expect(channel.send("+14155551234", "hi")).rejects.toThrow(/Privacy & Security > Automation.*Messages/);
  });

  it("stop() stops watching and closes the SDK", async () => {
    const { channel, sdk } = await started();
    await channel.stop();
    expect(sdk.stopWatching).toHaveBeenCalled();
    expect(sdk.close).toHaveBeenCalled();
  });
});
