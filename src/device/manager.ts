/**
 * The real DeviceManager: Speculos emulators over TCP and Nano S Plus devices over USB HID.
 * Devices are always picked by the pubkey of their AgentSign app, never by port or USB path.
 */
import { encodeAction, verifyActionSignature } from "../actions.js";
import type { Action, DeviceInfo, DeviceManager, SignOptions, SignResult } from "../types.js";
import {
  APP_AND_VERSION_APDU,
  type ApduResponse,
  type Endpoint,
  type Exchange,
  GET_PUBKEY_APDU,
  GET_VERSION_APDU,
  parseAppName,
  parsePubkey,
  parseVersion,
  signActionApdus,
  SW_DENIED,
  SW_OK,
  swHex,
  TimeoutError,
} from "./apdu.js";
import { hidEndpoint, listHidPaths } from "./transport-hid.js";
import { speculosEndpoint } from "./transport-speculos.js";

export const APP_NAME = "AgentSign";
const DEFAULT_SIGN_TIMEOUT_MS = 120_000;

export interface DeviceManagerOptions {
  /** Parsed DEVICES entries: "speculos:<host>:<port>" or "hid". */
  devices: string[];
  log?: (message: string) => void;
  /** Per-device budget for one list() probe. Default 2000 ms. */
  probeTimeoutMs?: number;
  /** How often sign() re-lists while the device is missing. Default 2000 ms. */
  pollIntervalMs?: number;
}

/**
 * Parses DEVICES: comma or whitespace separated "speculos:<host>:<port>" and "hid" entries.
 * Throws on anything else so a typo does not silently hide a device.
 */
export function parseDevicesEnv(value: string | undefined): string[] {
  const entries = (value ?? "").split(/[\s,]+/).filter((e) => e.length > 0);
  for (const entry of entries) {
    if (entry !== "hid" && !parseSpeculosEntry(entry)) {
      throw new Error(`DEVICES: bad entry ${JSON.stringify(entry)}; expected "speculos:<host>:<port>" or "hid"`);
    }
  }
  return [...new Set(entries)];
}

function parseSpeculosEntry(entry: string): { host: string; port: number } | undefined {
  const m = /^speculos:([^:\s]+):(\d{1,5})$/.exec(entry);
  const port = Number(m?.[2]);
  if (!m?.[1] || !(port > 0 && port < 65536)) return undefined;
  return { host: m[1], port };
}

export function createDeviceManager(options: DeviceManagerOptions): DeviceManager {
  const devices = parseDevicesEnv(options.devices.join(","));
  const speculos = devices.flatMap((entry) => {
    const parsed = parseSpeculosEntry(entry);
    return parsed ? [speculosEndpoint(parsed.host, parsed.port)] : [];
  });
  const useHid = devices.includes("hid");
  const discover = async () => [...speculos, ...(useHid ? (await listHidPaths()).map(hidEndpoint) : [])];
  return new EndpointDeviceManager(discover, options);
}

/** Reads name, version and pubkey. Undefined when the endpoint is not running AgentSign (locked, dashboard, other app). */
async function probe(endpoint: Endpoint, exchange: Exchange): Promise<DeviceInfo | undefined> {
  if (parseAppName(await exchange(APP_AND_VERSION_APDU)) !== APP_NAME) return undefined;
  if (!parseVersion(await exchange(GET_VERSION_APDU))) return undefined;
  const pubkey = parsePubkey(await exchange(GET_PUBKEY_APDU));
  return pubkey ? { id: endpoint.id, kind: endpoint.kind, pubkey, label: endpoint.label } : undefined;
}

const LOCK_TIMEOUT = Symbol("lock timeout");

/** DeviceManager over any set of endpoints. createDeviceManager() is the usual way in; tests can inject endpoints. */
export class EndpointDeviceManager implements DeviceManager {
  private readonly log: (message: string) => void;
  private readonly probeTimeoutMs: number;
  private readonly pollIntervalMs: number;
  /** One queue per device: a pending request holds it until done. */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly cache = new Map<string, DeviceInfo>();
  private readonly endpoints = new Map<string, Endpoint>();
  private closed = false;

  constructor(
    private readonly discover: () => Promise<Endpoint[]>,
    options: Omit<DeviceManagerOptions, "devices"> = {},
  ) {
    this.log = options.log ?? (() => {});
    this.probeTimeoutMs = options.probeTimeoutMs ?? 2000;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
  }

  async list(): Promise<DeviceInfo[]> {
    let endpoints: Endpoint[];
    try {
      endpoints = await this.discover();
    } catch (error) {
      this.log(`device discovery failed: ${errorText(error)}`);
      return [];
    }
    for (const endpoint of endpoints) this.endpoints.set(endpoint.id, endpoint);
    const found = await Promise.all(endpoints.map((endpoint) => this.probeOrCached(endpoint)));
    return found.filter((info): info is DeviceInfo => info !== undefined);
  }

  async sign(pubkey: string, action: Action, options: SignOptions = {}): Promise<SignResult> {
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS);
    let bytes: Buffer;
    try {
      bytes = encodeAction(action);
    } catch (error) {
      return { status: "error", message: `cannot encode action: ${errorText(error)}` };
    }
    const wanted = pubkey.toLowerCase();
    let waitingLogged = false;
    while (!this.closed) {
      const device = (await this.list()).find((d) => d.pubkey === wanted);
      const endpoint = device && this.endpoints.get(device.id);
      if (endpoint) {
        const result = await this.signOn(endpoint, wanted, action, bytes, deadline);
        if (result) return result;
      } else if (!waitingLogged) {
        this.log(`waiting for the device with key ${wanted.slice(0, 12)}... to appear`);
        waitingLogged = true;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(this.pollIntervalMs, remaining));
    }
    return { status: "no_device" };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Signs on one endpoint. Undefined means "that device is not the one any more, keep looking". */
  private async signOn(endpoint: Endpoint, pubkey: string, action: Action, bytes: Buffer, deadline: number): Promise<SignResult | undefined> {
    let response: ApduResponse | "moved" | typeof LOCK_TIMEOUT;
    try {
      response = await this.withLock(endpoint.id, deadline, () =>
        endpoint.session(async (exchange) => {
          // The person may have swapped devices on that port or USB path since list().
          if (parsePubkey(await exchange(GET_PUBKEY_APDU)) !== pubkey) return "moved" as const;
          this.log(`${action.code} ${action.id} sent to ${endpoint.label}, waiting for the person`);
          let last: ApduResponse | undefined;
          for (const apdu of signActionApdus(bytes)) {
            last = await exchange(apdu);
            if (last.sw !== SW_OK) break;
          }
          return last!;
        }, deadline - Date.now()),
      );
    } catch (error) {
      if (error instanceof TimeoutError) return { status: "timeout" };
      return { status: "error", message: `${endpoint.label}: ${errorText(error)}` };
    }
    if (response === LOCK_TIMEOUT) return { status: "timeout" };
    if (response === "moved") {
      this.cache.delete(endpoint.id);
      return undefined;
    }
    if (response.sw === SW_DENIED) return { status: "rejected" };
    if (response.sw !== SW_OK) return { status: "error", message: `device answered ${swHex(response.sw)}` };
    const signature = response.data.toString("hex");
    if (!verifyActionSignature(pubkey, action, signature)) {
      return { status: "error", message: "the device returned a signature that does not verify" };
    }
    return { status: "approved", signature };
  }

  private async probeOrCached(endpoint: Endpoint): Promise<DeviceInfo | undefined> {
    const cached = this.cache.get(endpoint.id);
    // A device busy with a review cannot answer a probe; trust what we learned when it was free.
    if (this.queues.has(endpoint.id) && cached) return cached;
    let info: DeviceInfo | undefined;
    try {
      const probed = await this.withLock(endpoint.id, undefined, () =>
        endpoint.session((exchange) => probe(endpoint, exchange), this.probeTimeoutMs),
      );
      info = probed === LOCK_TIMEOUT ? undefined : probed;
    } catch {
      info = undefined;
    }
    if (info) {
      if (this.cache.get(endpoint.id)?.pubkey !== info.pubkey) this.log(`found AgentSign on ${info.label} (${info.pubkey})`);
      this.cache.set(endpoint.id, info);
    } else if (this.cache.delete(endpoint.id)) {
      this.log(`lost AgentSign on ${endpoint.label}`);
    }
    return info;
  }

  /** Runs `fn` when every earlier request on `id` is done. Gives up with LOCK_TIMEOUT at `deadline`. */
  private async withLock<T>(id: string, deadline: number | undefined, fn: () => Promise<T>): Promise<T | typeof LOCK_TIMEOUT> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => mine);
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    try {
      if (deadline === undefined) await previous;
      else if (!(await raceDeadline(previous, deadline))) return LOCK_TIMEOUT;
      return await fn();
    } finally {
      release();
    }
  }
}

/** True if `promise` settles before `deadline`. */
function raceDeadline(promise: Promise<void>, deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
