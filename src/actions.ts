/**
 * Canonical byte encoding of an Action. The server encodes, the Ledger app parses and displays the
 * same bytes, both sides hash them with SHA-256, and the device signs that digest with Ed25519.
 * The Rust app in device-app/ implements the exact same layout; change both or neither.
 *
 *   offset  size  meaning
 *   0       4     magic "AGS1"
 *   4       3     action code, ASCII (PAY, CAL, FRQ, FAC, ACC; Ethereum mode adds DEL, BUY, EAT)
 *   7       16    action id, raw bytes
 *   23      1     field count N (1..6)
 *   24      ...   N fields, each: label_len u8 (1..16), label bytes, value_len u8 (1..64), value bytes
 *
 * Labels and values are printable ASCII (0x20..0x7E) so every device can show them as-is.
 * Maximum payload: 24 + 6 * (1 + 16 + 1 + 64) = 516 bytes.
 */
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import { ACTION_TITLES, type Action, type ActionCode, type ActionField } from "./types.js";

export const ACTION_MAGIC = Buffer.from("AGS1", "ascii");
export const MAX_FIELDS = 6;
export const MAX_LABEL_BYTES = 16;
export const MAX_VALUE_BYTES = 64;
export const MAX_ACTION_BYTES = 24 + MAX_FIELDS * (1 + MAX_LABEL_BYTES + 1 + MAX_VALUE_BYTES);

const CODES: readonly ActionCode[] = ["PAY", "CAL", "FRQ", "FAC", "ACC", "DEL", "BUY", "EAT"];
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

export class ActionFormatError extends Error {}

export function isActionCode(value: string): value is ActionCode {
  return (CODES as readonly string[]).includes(value);
}

export function newActionId(): string {
  return randomBytes(16).toString("hex");
}

/** Throws ActionFormatError when the action cannot be shown on a device. */
export function validateAction(action: Action): void {
  if (!isActionCode(action.code)) throw new ActionFormatError(`unknown action code ${JSON.stringify(action.code)}`);
  if (!/^[0-9a-f]{32}$/.test(action.id)) throw new ActionFormatError("action id must be 32 lowercase hex characters");
  if (action.fields.length < 1 || action.fields.length > MAX_FIELDS) {
    throw new ActionFormatError(`an action needs 1 to ${MAX_FIELDS} fields, got ${action.fields.length}`);
  }
  for (const field of action.fields) {
    checkText(field.label, MAX_LABEL_BYTES, "label");
    checkText(field.value, MAX_VALUE_BYTES, "value");
  }
}

function checkText(text: string, max: number, what: string): void {
  if (typeof text !== "string" || text.length === 0) throw new ActionFormatError(`${what} is empty`);
  if (!PRINTABLE_ASCII.test(text)) throw new ActionFormatError(`${what} ${JSON.stringify(text)} is not printable ASCII`);
  if (Buffer.byteLength(text, "ascii") > max) throw new ActionFormatError(`${what} ${JSON.stringify(text)} is longer than ${max} bytes`);
}

/** Make free text safe for a field: ASCII only, trimmed, cut to `max` bytes. */
export function toFieldText(text: string, max = MAX_VALUE_BYTES): string {
  const ascii = text
    .normalize("NFKD")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const cut = ascii.length > max ? `${ascii.slice(0, max - 3)}...` : ascii;
  return cut.length === 0 ? "-" : cut;
}

export function encodeAction(action: Action): Buffer {
  validateAction(action);
  const parts: Buffer[] = [ACTION_MAGIC, Buffer.from(action.code, "ascii"), Buffer.from(action.id, "hex"), Buffer.from([action.fields.length])];
  for (const field of action.fields) {
    const label = Buffer.from(field.label, "ascii");
    const value = Buffer.from(field.value, "ascii");
    parts.push(Buffer.from([label.length]), label, Buffer.from([value.length]), value);
  }
  return Buffer.concat(parts);
}

/** Inverse of encodeAction. Throws ActionFormatError on malformed input. */
export function decodeAction(bytes: Buffer): Action {
  let offset = 0;
  const take = (n: number): Buffer => {
    if (offset + n > bytes.length) throw new ActionFormatError("truncated action");
    const out = bytes.subarray(offset, offset + n);
    offset += n;
    return out;
  };
  if (!take(4).equals(ACTION_MAGIC)) throw new ActionFormatError("bad magic");
  const code = take(3).toString("ascii");
  if (!isActionCode(code)) throw new ActionFormatError(`unknown action code ${JSON.stringify(code)}`);
  const id = take(16).toString("hex");
  const count = take(1)[0] ?? 0;
  const fields: ActionField[] = [];
  for (let i = 0; i < count; i++) {
    const labelLen = take(1)[0] ?? 0;
    const label = take(labelLen).toString("ascii");
    const valueLen = take(1)[0] ?? 0;
    const value = take(valueLen).toString("ascii");
    fields.push({ label, value });
  }
  if (offset !== bytes.length) throw new ActionFormatError("trailing bytes after action");
  const action: Action = { code, id, fields };
  validateAction(action);
  return action;
}

/** SHA-256 of the encoded action: the 32 bytes the device signs. */
export function actionDigest(action: Action): Buffer {
  return createHash("sha256").update(encodeAction(action)).digest();
}

function ed25519PublicKey(pubkeyHex: string) {
  if (!/^[0-9a-f]{64}$/.test(pubkeyHex)) throw new ActionFormatError("pubkey must be 64 lowercase hex characters");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pubkeyHex, "hex").toString("base64url") }, format: "jwk" });
}

/** True when `signatureHex` is a valid Ed25519 signature by `pubkeyHex` over actionDigest(action). */
export function verifyActionSignature(pubkeyHex: string, action: Action, signatureHex: string): boolean {
  if (!/^[0-9a-f]{128}$/.test(signatureHex)) return false;
  try {
    return cryptoVerify(null, actionDigest(action), ed25519PublicKey(pubkeyHex), Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/** One line for a text message: "Send money: To @gabriel, Amount $5.00". */
export function describeAction(action: Action, titles: Record<ActionCode, string>): string {
  return `${titles[action.code]}: ${action.fields.map((f) => `${f.label} ${f.value}`).join(", ")}`;
}

/**
 * The text the official Ethereum app signs as a personal message (CAL, FRQ, FAC in Ethereum mode):
 * "AgentSign\nAdd to calendar\nTitle: Lunch\n...\nid: 0011aabb".
 */
export function actionMessage(action: Action): string {
  return ["AgentSign", ACTION_TITLES[action.code], ...action.fields.map((f) => `${f.label}: ${f.value}`), `id: ${action.id.slice(0, 8)}`].join("\n");
}
