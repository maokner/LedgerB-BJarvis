import { sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeAction } from "../src/actions.js";
import {
  type ApduResponse,
  createFakeDevice,
  type Endpoint,
  EndpointDeviceManager,
  type FakeDevice,
  signActionApdus,
  splitResponse,
  withTimeout,
} from "../src/device/index.js";
import type { Action } from "../src/types.js";

const pay: Action = {
  code: "PAY",
  id: "00112233445566778899aabbccddeeff",
  fields: [
    { label: "To", value: "@gabriel" },
    { label: "Amount", value: "$5.00" },
  ],
};

const ok = (data: Buffer = Buffer.alloc(0)): ApduResponse => ({ data, sw: 0x9000 });

/** An in-process AgentSign device speaking the real APDUs. `decide` plays the person. */
function emulator(options: { app?: string; device?: FakeDevice; decide?: (bytes: Buffer) => Promise<ApduResponse | "sign"> } = {}) {
  const device = options.device ?? createFakeDevice();
  const app = options.app ?? "AgentSign";
  const log: string[] = [];
  let upload = Buffer.alloc(0);
  let busy = 0;
  let maxBusy = 0;
  const endpoint: Endpoint = {
    id: `emu:${device.pubkey.slice(0, 8)}`,
    kind: "speculos",
    label: "emulator",
    async session(fn, timeoutMs) {
      busy += 1;
      maxBusy = Math.max(maxBusy, busy);
      try {
        return await withTimeout(
          fn(async (apdu) => {
            const [cla, ins, p1, p2] = apdu;
            const data = apdu.subarray(5);
            if (cla === 0xb0) return ok(Buffer.concat([Buffer.from([1, app.length]), Buffer.from(app), Buffer.from([1, 0x30])]));
            if (app !== "AgentSign") return { data: Buffer.alloc(0), sw: 0x6e00 };
            if (ins === 1) return ok(Buffer.from([0, 1, 0]));
            if (ins === 2) return ok(Buffer.from(device.pubkey, "hex"));
            upload = p1 === 0 ? Buffer.from(data) : Buffer.concat([upload, data]);
            if (p2 === 0x80) return ok();
            log.push(upload.toString("latin1").slice(4, 7));
            const answer = options.decide ? await options.decide(upload) : "sign";
            if (answer !== "sign") return answer;
            const digest = (await import("node:crypto")).createHash("sha256").update(upload).digest();
            return ok(cryptoSign(null, digest, device.privateKey));
          }),
          timeoutMs,
          "emulator",
        );
      } finally {
        busy -= 1;
      }
    },
  };
  return { endpoint, device, log, maxBusy: () => maxBusy };
}

describe("APDU helpers", () => {
  it("chunks the largest action into three APDUs with the documented P1/P2", () => {
    const fields = Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`.padEnd(16, "x"), value: "v".repeat(64) }));
    const bytes = encodeAction({ code: "CAL", id: pay.id, fields });
    expect(bytes.length).toBe(516);
    const apdus = signActionApdus(bytes);
    expect(apdus.map((a) => [...a.subarray(0, 5)])).toEqual([
      [0xe0, 0x03, 0x00, 0x80, 255],
      [0xe0, 0x03, 0x80, 0x80, 255],
      [0xe0, 0x03, 0x80, 0x00, 6],
    ]);
    expect(Buffer.concat(apdus.map((a) => a.subarray(5)))).toEqual(bytes);
    expect(signActionApdus(encodeAction(pay)).map((a) => a[3])).toEqual([0x00]);
    expect(splitResponse(Buffer.from([1, 2, 0x69, 0x85]))).toEqual({ data: Buffer.from([1, 2]), sw: 0x6985 });
  });
});

describe("EndpointDeviceManager", () => {
  it("lists only AgentSign endpoints and signs on the one with the right key", async () => {
    const a = emulator();
    const b = emulator();
    const dashboard = emulator({ app: "BOLOS" });
    const manager = new EndpointDeviceManager(async () => [a.endpoint, b.endpoint, dashboard.endpoint]);
    expect((await manager.list()).map((d) => d.pubkey)).toEqual([a.device.pubkey, b.device.pubkey]);
    const result = await manager.sign(b.device.pubkey, pay);
    expect(result.status).toBe("approved");
    expect(b.log).toEqual(["PAY"]);
    expect(a.log).toEqual([]);
  });

  it("maps 0x6985 to rejected, other status words and bad signatures to error", async () => {
    let next: ApduResponse | "sign" = { data: Buffer.alloc(0), sw: 0x6985 };
    const emu = emulator({ decide: async () => next });
    const manager = new EndpointDeviceManager(async () => [emu.endpoint]);
    expect(await manager.sign(emu.device.pubkey, pay)).toEqual({ status: "rejected" });
    next = { data: Buffer.alloc(0), sw: 0x6a80 };
    expect(await manager.sign(emu.device.pubkey, pay)).toEqual({ status: "error", message: "device answered 0x6a80" });
    next = ok(Buffer.alloc(64, 7));
    expect((await manager.sign(emu.device.pubkey, pay)).status).toBe("error");
  });

  it("returns no_device after polling, and timeout when nobody answers", async () => {
    const emu = emulator({ decide: () => new Promise(() => {}) });
    const manager = new EndpointDeviceManager(async () => [emu.endpoint], { pollIntervalMs: 20 });
    expect(await manager.sign(createFakeDevice().pubkey, pay, { timeoutMs: 100 })).toEqual({ status: "no_device" });
    expect(await manager.sign(emu.device.pubkey, pay, { timeoutMs: 150 })).toEqual({ status: "timeout" });
  });

  it("finds a device that shows up later", async () => {
    const emu = emulator();
    let plugged = false;
    setTimeout(() => (plugged = true), 60);
    const manager = new EndpointDeviceManager(async () => (plugged ? [emu.endpoint] : []), { pollIntervalMs: 20 });
    expect((await manager.sign(emu.device.pubkey, pay, { timeoutMs: 2000 })).status).toBe("approved");
  });

  it("serializes requests to one device, and list() still reports it while it is busy", async () => {
    const answers: Array<() => void> = [];
    const emu = emulator({ decide: () => new Promise((resolve) => answers.push(() => resolve("sign"))) });
    const manager = new EndpointDeviceManager(async () => [emu.endpoint], { pollIntervalMs: 20 });
    await manager.list();
    const first = manager.sign(emu.device.pubkey, pay);
    const second = manager.sign(emu.device.pubkey, { ...pay, id: "ffeeddccbbaa99887766554433221100" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answers).toHaveLength(1);
    expect((await manager.list()).map((d) => d.pubkey)).toEqual([emu.device.pubkey]);
    answers[0]!();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answers).toHaveLength(2);
    answers[1]!();
    expect((await Promise.all([first, second])).map((r) => r.status)).toEqual(["approved", "approved"]);
    expect(emu.maxBusy()).toBe(1);
  });
});
