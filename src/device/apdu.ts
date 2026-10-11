/**
 * AgentSign APDUs (device-app/PROTOCOL.md), shared by the Speculos and USB HID transports.
 */

export const CLA = 0xe0;
export const INS_GET_VERSION = 0x01;
export const INS_GET_PUBKEY = 0x02;
export const INS_SIGN_ACTION = 0x03;

/** SIGN_ACTION chunk flags. */
export const P1_FIRST = 0x00;
export const P1_NEXT = 0x80;
export const P2_LAST = 0x00;
export const P2_MORE = 0x80;
export const CHUNK_SIZE = 255;

export const SW_OK = 0x9000;
export const SW_DENIED = 0x6985;
export const SW_BAD_DATA = 0x6a80;
export const SW_LOCKED = 0x5515;

export interface ApduResponse {
  data: Buffer;
  sw: number;
}

/** One open connection to a device: send an APDU, get the response. */
export type Exchange = (apdu: Buffer) => Promise<ApduResponse>;

/** A place a device can be: a Speculos port or a USB HID path. */
export interface Endpoint {
  id: string;
  kind: "speculos" | "hid";
  label: string;
  /**
   * Opens the transport, runs `fn`, closes it. Rejects with TimeoutError (and closes) if the whole
   * session takes longer than `timeoutMs`.
   */
  session<T>(fn: (exchange: Exchange) => Promise<T>, timeoutMs: number): Promise<T>;
}

export class TimeoutError extends Error {
  constructor(what: string) {
    super(`${what} timed out`);
  }
}

export function buildApdu(ins: number, p1 = 0, p2 = 0, data: Buffer = Buffer.alloc(0), cla = CLA): Buffer {
  if (data.length > 255) throw new Error("APDU data longer than 255 bytes");
  return Buffer.concat([Buffer.from([cla, ins, p1, p2, data.length]), data]);
}

/** BOLOS "get app name and version" (CLA 0xB0), answered by whatever is running, including the dashboard. */
export const APP_AND_VERSION_APDU = buildApdu(0x01, 0, 0, Buffer.alloc(0), 0xb0);
export const GET_VERSION_APDU = buildApdu(INS_GET_VERSION);
export const GET_PUBKEY_APDU = buildApdu(INS_GET_PUBKEY);

/** SIGN_ACTION split into 255-byte chunks: P1 0x00 first / 0x80 next, P2 0x80 more / 0x00 last. */
export function signActionApdus(actionBytes: Buffer): Buffer[] {
  const apdus: Buffer[] = [];
  for (let offset = 0; offset === 0 || offset < actionBytes.length; offset += CHUNK_SIZE) {
    const chunk = actionBytes.subarray(offset, offset + CHUNK_SIZE);
    const last = offset + CHUNK_SIZE >= actionBytes.length;
    apdus.push(buildApdu(INS_SIGN_ACTION, offset === 0 ? P1_FIRST : P1_NEXT, last ? P2_LAST : P2_MORE, chunk));
  }
  return apdus;
}

/** Splits a raw response (data || SW1 SW2) as returned by HID transports. */
export function splitResponse(raw: Buffer): ApduResponse {
  if (raw.length < 2) throw new Error(`response too short (${raw.length} bytes)`);
  return { data: raw.subarray(0, raw.length - 2), sw: raw.readUInt16BE(raw.length - 2) };
}

export function swHex(sw: number): string {
  return `0x${sw.toString(16).padStart(4, "0")}`;
}

/** Name of the running app from the BOLOS reply: 01 | len | name | len | version | ... */
export function parseAppName(response: ApduResponse): string | undefined {
  const { data, sw } = response;
  if (sw !== SW_OK || data[0] !== 0x01 || data.length < 2) return undefined;
  const len = data[1] ?? 0;
  if (data.length < 2 + len) return undefined;
  return data.subarray(2, 2 + len).toString("ascii");
}

export function parseVersion(response: ApduResponse): string | undefined {
  if (response.sw !== SW_OK || response.data.length !== 3) return undefined;
  return [...response.data].join(".");
}

/** 32-byte Ed25519 key as 64 lowercase hex characters. */
export function parsePubkey(response: ApduResponse): string | undefined {
  if (response.sw !== SW_OK || response.data.length !== 32) return undefined;
  return response.data.toString("hex");
}

/** Rejects with TimeoutError after `ms`, calling `onTimeout` first (to close a socket or device). */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new TimeoutError(what));
    }, Math.max(0, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
