/**
 * In-memory DeviceManager for tests: fake devices with real Ed25519 keys, a configurable answer
 * policy, and a record of every action shown.
 */
import { generateKeyPairSync, type KeyObject, sign as cryptoSign } from "node:crypto";
import { actionDigest, encodeAction } from "../actions.js";
import type { Action, DeviceInfo, DeviceManager, SignOptions, SignResult } from "../types.js";

export { parseDevicesEnv } from "./manager.js";

export interface FakeDevice extends DeviceInfo {
  privateKey: KeyObject;
}

let fakeCount = 0;

export function createFakeDevice(label?: string): FakeDevice {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url").toString("hex");
  fakeCount += 1;
  return { id: `fake:${fakeCount}`, kind: "speculos", pubkey, label: label ?? `Fake device ${fakeCount}`, privateKey };
}

/** What the person "does" on the device. A full SignResult is returned as-is. */
export type FakeAnswer = "approved" | "rejected" | "timeout" | "error" | SignResult;
export type FakePolicy = FakeAnswer | ((device: FakeDevice, action: Action) => FakeAnswer | Promise<FakeAnswer>);

export interface ShownAction {
  pubkey: string;
  action: Action;
}

export class FakeDeviceManager implements DeviceManager {
  readonly devices: FakeDevice[];
  /** Every action a device displayed, in order. */
  readonly shown: ShownAction[] = [];
  policy: FakePolicy;

  constructor(devices: FakeDevice[] = [createFakeDevice()], options: { policy?: FakePolicy } = {}) {
    this.devices = [...devices];
    this.policy = options.policy ?? "approved";
  }

  async list(): Promise<DeviceInfo[]> {
    return this.devices.map(({ id, kind, pubkey, label }) => ({ id, kind, pubkey, label }));
  }

  /**
   * Like the real one, but waits for a missing device only if `timeoutMs` is given (default 0 here,
   * so tests do not hang for two minutes).
   */
  async sign(pubkey: string, action: Action, options: SignOptions = {}): Promise<SignResult> {
    const deadline = Date.now() + (options.timeoutMs ?? 0);
    let device = this.find(pubkey);
    while (!device && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      device = this.find(pubkey);
    }
    if (!device) return { status: "no_device" };
    try {
      encodeAction(action);
    } catch (error) {
      return { status: "error", message: `device refused the action: ${(error as Error).message}` };
    }
    this.shown.push({ pubkey: device.pubkey, action: structuredClone(action) });
    const answer = typeof this.policy === "function" ? await this.policy(device, action) : this.policy;
    if (typeof answer !== "string") return answer;
    if (answer === "approved") {
      return { status: "approved", signature: cryptoSign(null, actionDigest(action), device.privateKey).toString("hex") };
    }
    if (answer === "error") return { status: "error", message: "fake device error" };
    return { status: answer };
  }

  async close(): Promise<void> {}

  private find(pubkey: string): FakeDevice | undefined {
    return this.devices.find((d) => d.pubkey === pubkey.toLowerCase());
  }
}
