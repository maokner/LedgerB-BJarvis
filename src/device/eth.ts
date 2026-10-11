/**
 * DeviceManager over Ledger's official Ethereum app (DEVICE_MODE=eth). A device's identity is the
 * address at m/44'/60'/0'/0/0 (lowercase 0x hex), used wherever the rest of the code says "pubkey".
 *
 *   ACC            -> "Verify address" on the device; the signature is the placeholder "verified"
 *                     (the approval page signs actionMessage() instead, see remote.ts)
 *   PAY, BUY       -> an EIP-1559 transfer built from action.meta; the signature is the raw signed tx
 *   CAL, FRQ, FAC  -> personal_sign of actionMessage(action); the signature is the 65-byte hex
 */
import { createRequire } from "node:module";
import type { Action, DeviceInfo, DeviceManager, SignOptions, SignResult } from "../types.js";
import { APP_AND_VERSION_APDU, parseAppName, splitResponse, SW_DENIED } from "./apdu.js";
import { askEthApp, ETH_PATH, type EthApp } from "./eth-tx.js";
import { ethProof, ethRequest } from "./eth-verify.js";
import { listHidPaths } from "./transport-hid.js";

export { ETH_PATH, type EthApp, unsignedTx } from "./eth-tx.js";
export { verifyEthSignature } from "./eth-verify.js";

export interface EthEndpoint {
  id: string;
  kind: DeviceInfo["kind"];
  label: string;
  /** Opens the device; `app` is undefined when the Ethereum app is not open (locked, dashboard, other app). */
  open(): Promise<{ app?: EthApp; close(): Promise<void> }>;
}

/** Asks one open Ethereum app to approve `action` for `address`. Never throws. */
export async function signOnEthApp(app: EthApp, address: string, action: Action): Promise<SignResult> {
  try {
    const proof = ethProof(address, action, await askEthApp(app, ethRequest(action)));
    return "signature" in proof ? { status: "approved", signature: proof.signature } : { status: "error", message: proof.error };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === SW_DENIED) return { status: "rejected" };
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export function createEthDeviceManager(options: { discover?: () => Promise<EthEndpoint[]>; log?: (line: string) => void; pollIntervalMs?: number } = {}): DeviceManager {
  const discover = options.discover ?? (async () => (await listHidPaths()).map(hidEthEndpoint));
  const log = options.log ?? (() => {});
  const cache = new Map<string, DeviceInfo>();
  const busy = new Set<string>();
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  let closed = false;

  async function probe(endpoint: EthEndpoint): Promise<DeviceInfo | undefined> {
    // A device in the middle of a review cannot answer; trust what we learned before.
    if (busy.has(endpoint.id)) return cache.get(endpoint.id);
    busy.add(endpoint.id);
    let session: Awaited<ReturnType<EthEndpoint["open"]>> | undefined;
    try {
      session = await endpoint.open();
      const address = session.app && (await session.app.getAddress(false)).toLowerCase();
      if (!address) throw new Error("Ethereum app not open");
      const info = { id: endpoint.id, kind: endpoint.kind, pubkey: address, label: endpoint.label };
      if (cache.get(endpoint.id)?.pubkey !== address) log(`found the Ethereum app on ${endpoint.label} (${address})`);
      cache.set(endpoint.id, info);
      return info;
    } catch {
      if (cache.delete(endpoint.id)) log(`lost the Ethereum app on ${endpoint.label}`);
      return undefined;
    } finally {
      await session?.close().catch(() => {});
      busy.delete(endpoint.id);
    }
  }

  async function list(): Promise<{ endpoint: EthEndpoint; info: DeviceInfo }[]> {
    const endpoints = await discover().catch(() => []);
    const found = await Promise.all(endpoints.map(async (endpoint) => ({ endpoint, info: await probe(endpoint) })));
    return found.flatMap((f) => (f.info ? [{ endpoint: f.endpoint, info: f.info }] : []));
  }

  return {
    list: async () => (await list()).map((d) => d.info),
    async sign(pubkey: string, action: Action, options: SignOptions = {}): Promise<SignResult> {
      const deadline = Date.now() + (options.timeoutMs ?? 120_000);
      const address = pubkey.toLowerCase();
      const { signal } = options;
      const aborted = new Promise<SignResult>((resolve) => signal?.addEventListener("abort", () => resolve({ status: "no_device" }), { once: true }));
      while (!closed && !signal?.aborted) {
        // ANY_DEVICE (""): the one plugged-in device `accept` allows; with two candidates, keep waiting rather than guess.
        const candidates = (await list()).filter((d) => (address ? d.info.pubkey === address : (options.accept?.(d.info.pubkey) ?? true)));
        const device = candidates.length === 1 ? candidates[0] : undefined;
        if (device && !busy.has(device.endpoint.id) && !signal?.aborted) {
          busy.add(device.endpoint.id);
          const session = await device.endpoint.open().catch(() => undefined);
          try {
            if (session?.app) {
              // The device shows the request now: the approval page, if any, steps aside.
              options.claim?.();
              log(`${action.code} ${action.id} sent to ${device.info.label}, waiting for the person`);
              let timer: NodeJS.Timeout | undefined;
              const timeout = new Promise<SignResult>((resolve) => (timer = setTimeout(() => resolve({ status: "timeout" }), Math.max(0, deadline - Date.now()))));
              const result = await Promise.race([signOnEthApp(session.app, device.info.pubkey, action), timeout, aborted]);
              clearTimeout(timer);
              return result.status === "approved" ? { ...result, pubkey: device.info.pubkey } : result;
            }
          } finally {
            await session?.close().catch(() => {});
            busy.delete(device.endpoint.id);
          }
        }
        if (Date.now() >= deadline) break;
        await Promise.race([new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())))), aborted]);
      }
      return { status: "no_device" };
    },
    async close() {
      closed = true;
    },
  };
}

interface HidTransport {
  exchange(apdu: Buffer): Promise<Buffer>;
  close(): Promise<void>;
}

const require = createRequire(import.meta.url);

/** A USB Ledger through @ledgerhq/hw-transport-node-hid and @ledgerhq/hw-app-eth (both CommonJS, loaded lazily). */
export function hidEthEndpoint(path: string): EthEndpoint {
  return {
    id: `hid:${path}`,
    kind: "hid",
    label: "Ledger Nano S Plus (USB)",
    async open() {
      const Transport = (require("@ledgerhq/hw-transport-node-hid") as { default: { open(path: string): Promise<HidTransport> } }).default;
      const transport = await Transport.open(path);
      const close = () => transport.close();
      let name: string | undefined;
      try {
        name = parseAppName(splitResponse(await transport.exchange(APP_AND_VERSION_APDU)));
      } catch {
        name = undefined;
      }
      if (name !== "Ethereum") return { close };
      type EthClass = new (t: HidTransport) => {
        getAddress(path: string, display?: boolean): Promise<{ address: string }>;
        signTransaction(path: string, rawTxHex: string, resolution: unknown): Promise<{ v: string; r: string; s: string }>;
        signPersonalMessage(path: string, messageHex: string): Promise<{ v: number; r: string; s: string }>;
      };
      const eth = new (require("@ledgerhq/hw-app-eth") as { default: EthClass }).default(transport);
      return {
        close,
        app: {
          getAddress: async (display) => (await eth.getAddress(ETH_PATH, display)).address,
          signTransaction: (hex, resolution) => eth.signTransaction(ETH_PATH, hex, resolution),
          signPersonalMessage: (hex) => eth.signPersonalMessage(ETH_PATH, hex),
        },
      };
    },
  };
}
