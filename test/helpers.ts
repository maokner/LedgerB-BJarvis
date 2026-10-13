/** Offline fakes for app tests: devices with real Ed25519 keys, a recording channel, and a scripted model. */
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { Signature, Transaction, type Wallet } from "ethers";
import type { Chain } from "../src/chain.js";
import { createEthDeviceManager, type EthApp, type EthEndpoint } from "../src/device/eth.js";
import { actionDigest } from "../src/actions.js";
import type { CompleteRequest, CompleteResult, Model, ToolCall } from "../src/agent/xai.js";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import type { Calendar } from "../src/calendar/google.js";
import type { Money } from "../src/money.js";
import { createPhoneLinks, type PhoneLinks } from "../src/phone.js";
import type { Food } from "../src/food/food.js";
import type { Purchases } from "../src/purchases.js";
import type { Action, Channel, DeviceInfo, DeviceManager, InboundMessage, SignResult } from "../src/types.js";

export type Policy = "approve" | "reject" | "timeout" | "error" | "wrong-key";

export interface FakeDevice {
  info: DeviceInfo;
  privateKey: KeyObject;
  policy: Policy;
  connected: boolean;
  /** Every action this device was asked to show. */
  shown: Action[];
  /** When set, sign() waits for it before answering (a person who has not pressed anything yet). */
  gate?: Promise<void>;
}

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkey = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url").toString("hex");
  return { pubkey, privateKey };
}

export function fakeDevices(count: number): { manager: DeviceManager; devices: FakeDevice[] } {
  const devices: FakeDevice[] = Array.from({ length: count }, (_, i) => {
    const { pubkey, privateKey } = keypair();
    return { info: { id: `fake:${i}`, kind: "speculos", pubkey, label: `Fake device ${i}` }, privateKey, policy: "approve", connected: true, shown: [] };
  });
  const manager: DeviceManager = {
    async list() {
      return devices.filter((d) => d.connected).map((d) => d.info);
    },
    async sign(pubkey, action): Promise<SignResult> {
      const device = devices.find((d) => d.connected && d.info.pubkey === pubkey);
      if (!device) return { status: "no_device" };
      device.shown.push(action);
      if (device.gate) await device.gate;
      switch (device.policy) {
        case "approve":
          return { status: "approved", signature: sign(null, actionDigest(action), device.privateKey).toString("hex") };
        case "wrong-key":
          return { status: "approved", signature: sign(null, actionDigest(action), keypair().privateKey).toString("hex") };
        case "reject":
          return { status: "rejected" };
        case "timeout":
          return { status: "timeout" };
        case "error":
          return { status: "error", message: "boom" };
      }
    },
    async close() {},
  };
  return { manager, devices };
}

export function fakeChannel() {
  const sent: { handle: string; text: string }[] = [];
  const reactions: { messageId: string; emoji: string }[] = [];
  const typing: { handle: string; on: boolean }[] = [];
  const channel: Pick<Channel, "send" | "typing" | "react"> = {
    async send(handle, text) {
      sent.push({ handle, text });
    },
    async typing(handle, on) {
      typing.push({ handle, on });
    },
    async react(messageId, emoji) {
      reactions.push({ messageId, emoji });
    },
  };
  return { channel, sent, reactions, typing, to: (handle: string) => sent.filter((s) => s.handle === handle).map((s) => s.text) };
}

/** A step is a canned reply, or a function of the request (to assert on what the model saw). */
export type Step = CompleteResult | ((request: CompleteRequest) => CompleteResult);
let callSeq = 0;
export const say = (text: string): CompleteResult => ({ text, toolCalls: [] });
export const call = (name: string, args: Record<string, unknown>): CompleteResult => ({
  text: "",
  toolCalls: [{ id: `call_${++callSeq}`, name, arguments: JSON.stringify(args) } satisfies ToolCall],
});

/** The persona hands a task to the engine; `address`: the delivery address the owner confirmed for an order. */
export const delegate = (goal: string, context?: string, address?: string): CompleteResult => call("delegate", { goal, ...(context ? { context } : {}), ...(address ? { address } : {}) });
/** Which side of the two-layer agent a request came from. */
export const isPersona = (request: CompleteRequest) => request.tools.some((t) => t.name === "delegate");
export const isEngine = (request: CompleteRequest) => request.tools.some((t) => t.name === "propose_action");

/** Scripted steps run in order across persona, engine and peer calls (personaModel is "" so nothing overrides). */
export function scriptedModel() {
  const queue: Step[] = [];
  const requests: CompleteRequest[] = [];
  const model: Model = {
    async complete(request) {
      requests.push(structuredClone(request));
      const step = queue.shift();
      if (!step) throw new Error(`scripted model ran out of steps; last message: ${JSON.stringify(request.messages.at(-1))}`);
      return typeof step === "function" ? step(request) : step;
    },
  };
  return { model, requests, script: (...steps: Step[]) => queue.push(...steps), remaining: () => queue.length };
}

export const PHONES = { matt: "+14155550001", gabriel: "+14155550002", yadu: "+14155550003" } as const;

let msgSeq = 0;
export function inbound(handle: string, text: string, images: string[] = []): InboundMessage {
  return { id: `m${++msgSeq}`, handle, text, images, at: new Date(), service: "dev" };
}

/** A Telegram message from user `id` (handle "tg:<id>"), with their @username and display name when given. */
export function tgInbound(id: number, text: string, username?: string, name?: string): InboundMessage {
  return { id: `tg${++msgSeq}`, handle: `tg:${id}`, text, images: [], at: new Date(), service: "telegram", ...(username ? { username } : {}), ...(name ? { name } : {}) };
}

/** A full app with in-memory DB, `deviceCount` fake devices, a recording channel and a scripted (or given) model. */
export function harness(
  deviceCount = 3,
  model?: Model,
  extra: {
    money?: Money;
    deviceManager?: DeviceManager;
    db?: ReturnType<typeof openDb>;
    calendar?: Calendar;
    /** Buying on Amazon, built on the harness's own DB and channel. */
    purchases?: (ctx: { db: ReturnType<typeof openDb>; channel: Pick<Channel, "send">; log: (line: string) => void }) => Purchases;
    /** Ordering food, built on the harness's own DB and channel. */
    food?: (ctx: { db: ReturnType<typeof openDb>; channel: Pick<Channel, "send">; log: (line: string) => void }) => Food;
    /** Phone calls: true for links on the harness's DB with this number to call, or ready-made links. */
    phone?: boolean | string | PhoneLinks;
  } = {},
) {
  const db = extra.db ?? openDb(":memory:");
  const phone = typeof extra.phone === "object" ? extra.phone : extra.phone ? createPhoneLinks({ db, number: typeof extra.phone === "string" ? extra.phone : "+19406447419" }) : undefined;
  const { manager, devices } = fakeDevices(deviceCount);
  const ch = fakeChannel();
  const scripted = scriptedModel();
  const logs: string[] = [];
  const log = (l: string) => logs.push(l);
  const app = createApp({
    db,
    deviceManager: extra.deviceManager ?? manager,
    channel: ch.channel,
    model: model ?? scripted.model,
    personaModel: model ? undefined : "",
    log,
    money: extra.money,
    calendar: extra.calendar,
    purchases: extra.purchases?.({ db, channel: ch.channel, log }),
    food: extra.food?.({ db, channel: ch.channel, log }),
    phone,
  });
  const deliver = async (message: InboundMessage) => {
    await app.handleInbound(message);
    await app.whenIdle();
    return message;
  };
  const send = (handle: string, text: string, images: string[] = []) => deliver(inbound(handle, text, images));
  /** Onboard `name` on device `index` through the real flow. */
  const onboard = async (name: keyof typeof PHONES, index: number) => {
    for (const d of devices) d.connected = d === devices[index] || db.accountByPubkey(d.info.pubkey) !== undefined;
    await send(PHONES[name], `@${name}`);
    for (const d of devices) d.connected = true;
    return db.accountByTag(`@${name}`)!;
  };
  /** Make two onboarded accounts friends directly in the DB. */
  const befriend = (a: number, b: number) => {
    db.requestFriend(a, b);
    db.acceptFriend(a, b);
  };
  return { db, app, devices, manager, phone, ...ch, ...scripted, logs, send, deliver, onboard, befriend };
}

/** A Ledger running the Ethereum app, played by an ethers Wallet. Answers in hw-app-eth's shapes. */
export function fakeEthApp(wallet: Wallet, options: { reject?: boolean; tamper?: boolean } = {}): EthApp {
  const deny = () => {
    if (options.reject) throw Object.assign(new Error("Ledger device: Condition of use not satisfied (denied by the user?)"), { statusCode: 0x6985 });
  };
  return {
    async getAddress(display) {
      if (display) deny();
      return wallet.address;
    },
    async signTransaction(hex) {
      deny();
      const tx = Transaction.from(`0x${hex}`);
      if (options.tamper) tx.value = tx.value + 1n;
      const sig = wallet.signingKey.sign(tx.unsignedHash);
      return { v: sig.yParity.toString(16).padStart(2, "0"), r: sig.r.slice(2), s: sig.s.slice(2) };
    },
    async signPersonalMessage(hex) {
      deny();
      const sig = Signature.from(await wallet.signMessage(Buffer.from(hex, "hex")));
      return { v: sig.v, r: sig.r.slice(2), s: sig.s.slice(2) };
    },
  };
}

/** Wallet-backed devices behind the real Ethereum DeviceManager; `plugged` decides which ones list() sees. */
export function fakeEthDevices(wallets: Wallet[]) {
  const plugged = new Set(wallets.map((_, i) => i));
  const options = wallets.map(() => ({}) as { reject?: boolean; tamper?: boolean });
  const endpoints: EthEndpoint[] = wallets.map((wallet, i) => ({
    id: `fake-eth:${i}`,
    kind: "hid",
    label: `Fake Ledger ${i}`,
    open: async () => ({ app: fakeEthApp(wallet, options[i]), close: async () => {} }),
  }));
  const manager = createEthDeviceManager({ discover: async () => endpoints.filter((_, i) => plugged.has(i)), pollIntervalMs: 5 });
  return { manager, plugged, options };
}

/** Base without a network: balances by address, a fixed price, and a record of broadcast transactions. */
/** The Ledger USDC descriptor a stubbed Base hands out (any hex: the fake Ledger does not read it). */
export const FAKE_USDC_DESCRIPTOR = "0455534443833589fcd6edb6e08f4c7c32d4f71b54bda02913000000060000210500";

export function stubChain(balances: Record<string, bigint>, usdPerEth = 4000, usdc: Record<string, bigint> = {}) {
  const sent: string[] = [];
  const chain: Chain = {
    balanceWei: async (address) => balances[address.toLowerCase()] ?? 0n,
    tokenBalance: async (_token, address) => usdc[address.toLowerCase()] ?? 0n,
    ethUsdPrice: async () => usdPerEth,
    prepareTransfer: async (_from, _to, _value, data) => ({ chainId: 8453, nonce: 7, gasLimit: data && data !== "0x" ? 60_000n : 21_000n, maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    erc20Resolution: async () => [FAKE_USDC_DESCRIPTOR],
    broadcast: async (raw) => {
      sent.push(raw);
      return Transaction.from(raw).hash!;
    },
    waitForReceipt: async () => "confirmed",
  };
  return { chain, sent };
}
