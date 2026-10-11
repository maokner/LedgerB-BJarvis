import { describe, expect, it } from "vitest";
import { verifyActionSignature } from "../src/actions.js";
import { createFakeDevice, FakeDeviceManager, parseDevicesEnv } from "../src/device/index.js";
import type { Action } from "../src/types.js";

const pay: Action = {
  code: "PAY",
  id: "00112233445566778899aabbccddeeff",
  fields: [
    { label: "To", value: "@gabriel" },
    { label: "Amount", value: "$5.00" },
  ],
};

describe("FakeDeviceManager", () => {
  it("lists its devices and signs with real Ed25519 keys", async () => {
    const matt = createFakeDevice("matt");
    const yadu = createFakeDevice("yadu");
    const manager = new FakeDeviceManager([matt, yadu]);
    expect((await manager.list()).map((d) => d.pubkey)).toEqual([matt.pubkey, yadu.pubkey]);
    expect(matt.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(matt.pubkey).not.toBe(yadu.pubkey);

    const result = await manager.sign(yadu.pubkey, pay);
    expect(result.status).toBe("approved");
    if (result.status !== "approved") throw new Error("unreachable");
    expect(verifyActionSignature(yadu.pubkey, pay, result.signature)).toBe(true);
    expect(verifyActionSignature(matt.pubkey, pay, result.signature)).toBe(false);
    expect(manager.shown).toEqual([{ pubkey: yadu.pubkey, action: pay }]);
  });

  it("follows a policy, fixed or per call", async () => {
    const device = createFakeDevice();
    const manager = new FakeDeviceManager([device], { policy: "rejected" });
    expect(await manager.sign(device.pubkey, pay)).toEqual({ status: "rejected" });
    manager.policy = (_device, action) => (action.code === "PAY" ? "timeout" : "approved");
    expect(await manager.sign(device.pubkey, pay)).toEqual({ status: "timeout" });
    expect((await manager.sign(device.pubkey, { ...pay, code: "FRQ", fields: [{ label: "To", value: "@yadu" }] })).status).toBe("approved");
    manager.policy = { status: "error", message: "boom" };
    expect(await manager.sign(device.pubkey, pay)).toEqual({ status: "error", message: "boom" });
    expect(manager.shown).toHaveLength(4);
  });

  it("reports a missing device, waits for one that appears, and refuses what a device cannot show", async () => {
    const device = createFakeDevice();
    const manager = new FakeDeviceManager([]);
    expect(await manager.sign(device.pubkey, pay)).toEqual({ status: "no_device" });
    setTimeout(() => manager.devices.push(device), 50);
    expect((await manager.sign(device.pubkey, pay, { timeoutMs: 2000 })).status).toBe("approved");
    const bad = await manager.sign(device.pubkey, { ...pay, fields: [] });
    expect(bad.status).toBe("error");
    expect(manager.shown).toHaveLength(1);
  });
});

describe("parseDevicesEnv", () => {
  it("parses speculos and hid entries", () => {
    expect(parseDevicesEnv("speculos:127.0.0.1:9999, speculos:127.0.0.1:9998,hid")).toEqual([
      "speculos:127.0.0.1:9999",
      "speculos:127.0.0.1:9998",
      "hid",
    ]);
    expect(parseDevicesEnv("hid hid")).toEqual(["hid"]);
    expect(parseDevicesEnv("")).toEqual([]);
    expect(parseDevicesEnv(undefined)).toEqual([]);
  });

  it("rejects typos", () => {
    expect(() => parseDevicesEnv("speculos:9999")).toThrow(/bad entry/);
    expect(() => parseDevicesEnv("usb")).toThrow(/bad entry/);
    expect(() => parseDevicesEnv("speculos:localhost:99999")).toThrow(/bad entry/);
  });
});
