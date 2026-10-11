/**
 * Against a running Speculos (scripts/speculos.sh). Skipped unless SPECULOS_APDU_PORT is set:
 *   SPECULOS_APDU_PORT=9999 SPECULOS_API_PORT=5000 pnpm vitest run test/device-speculos.test.ts
 * Plays the person through the Speculos REST API (screen text and buttons).
 */
import { afterAll, describe, expect, it } from "vitest";
import { verifyActionSignature } from "../src/actions.js";
import { createDeviceManager } from "../src/device/index.js";
import type { Action } from "../src/types.js";

const host = process.env.SPECULOS_HOST ?? "127.0.0.1";
const apduPort = process.env.SPECULOS_APDU_PORT;
const api = `http://${host}:${process.env.SPECULOS_API_PORT ?? "5000"}`;

async function screen(): Promise<string> {
  const res = await fetch(`${api}/events?currentscreenonly=true`);
  const body = (await res.json()) as { events?: Array<{ text: string }> };
  return (body.events ?? []).map((e) => e.text).join(" ");
}

async function press(button: "left" | "right" | "both"): Promise<void> {
  await fetch(`${api}/button/${button}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "press-and-release" }),
  });
}

async function waitScreen(predicate: (text: string) => boolean, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await screen();
    if (predicate(text) || Date.now() > deadline) return text;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Waits for a review, walks every page, then approves or rejects. Returns the text of each page. */
async function answer(approve: boolean): Promise<string[]> {
  const pages = [await waitScreen((t) => t.trim() !== "" && !t.includes("ready"))];
  while (!pages.at(-1)!.includes("Approve") && pages.length < 30) {
    const before = pages.at(-1)!;
    await press("right");
    pages.push(await waitScreen((t) => t !== before));
  }
  if (!approve) {
    await press("right");
    pages.push(await waitScreen((t) => t.includes("Reject")));
  }
  await press("both");
  await waitScreen((t) => t.includes("ready"));
  return pages;
}

const pay: Action = {
  code: "PAY",
  id: "0123456789abcdef0123456789abcdef",
  fields: [
    { label: "To", value: "@gabriel" },
    { label: "Amount", value: "$5.00" },
    { label: "Memo", value: "lunch" },
  ],
};

describe.skipIf(!apduPort)("Speculos device", { timeout: 60_000 }, () => {
  const manager = createDeviceManager({ devices: apduPort ? [`speculos:${host}:${apduPort}`] : [] });
  afterAll(() => manager.close());

  it("lists the emulator with its AgentSign key", async () => {
    const devices = await manager.list();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ id: `speculos:${host}:${apduPort}`, kind: "speculos" });
    expect(devices[0]!.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("shows the action, signs it on approve, and Node's crypto.verify accepts the signature", async () => {
    const [device] = await manager.list();
    const [result, pages] = await Promise.all([manager.sign(device!.pubkey, pay, { timeoutMs: 30_000 }), answer(true)]);
    expect(result.status).toBe("approved");
    if (result.status !== "approved") return;
    expect(verifyActionSignature(device!.pubkey, pay, result.signature)).toBe(true);
    expect(verifyActionSignature(device!.pubkey, { ...pay, id: "f".repeat(32) }, result.signature)).toBe(false);
    const seen = pages.join(" | ");
    for (const text of ["Send money", "@gabriel", "$5.00", "lunch"]) expect(seen).toContain(text);
  });

  it("reports a rejection", async () => {
    const [device] = await manager.list();
    const frq: Action = { code: "FRQ", id: "1".repeat(32), fields: [{ label: "To", value: "@yadu" }] };
    const [result] = await Promise.all([manager.sign(device!.pubkey, frq, { timeoutMs: 30_000 }), answer(false)]);
    expect(result).toEqual({ status: "rejected" });
  });

  it("queues a second request to the same device until the first is answered", async () => {
    const [device] = await manager.list();
    const one = manager.sign(device!.pubkey, { ...pay, id: "2".repeat(32) }, { timeoutMs: 30_000 });
    const two = manager.sign(device!.pubkey, { ...pay, id: "3".repeat(32) }, { timeoutMs: 30_000 });
    await answer(true);
    await answer(false);
    expect((await Promise.all([one, two])).map((r) => r.status).sort()).toEqual(["approved", "rejected"]);
  });
});
