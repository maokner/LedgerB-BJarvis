/**
 * Phone numbers for calls. A call arrives with a caller ID, looked up as a handle: on iMessage the account's handle is
 * the owner's number already; a Telegram account (or an extra number) links its number to the account once. Two ways in:
 *   - from a call: an unknown number hears a short code; the owner texts that code to Jarvis (src/app.ts)
 *   - from a text: "link my number +1 415 ..." runs the engine's link_phone tool (src/agent/tools.ts)
 * A number belongs to at most one account (handles are unique), so nobody can take over a linked number.
 */
import { randomInt } from "node:crypto";
import type { Db } from "./db.js";
import { maskHandle, normalizeHandle } from "./handles.js";

const CODE_TTL_MS = 10 * 60_000;
export const PHONE_RE = /^\+\d{7,15}$/;

export interface PhoneLinksOptions {
  db: Db;
  /** The number people call (TWILIO_PHONE_NUMBER), for the prompts. */
  number?: string;
  log?: (line: string) => void;
}

export type LinkResult = { ok: true; handle: string } | { ok: false; reason: string };

export function createPhoneLinks(o: PhoneLinksOptions) {
  const { db } = o;
  const log = o.log ?? (() => {});
  /** Codes read out on calls from numbers without an account, by code. */
  const codes = new Map<string, { handle: string; expiresAt: number }>();
  const listeners = new Map<string, Set<(accountId: number) => void>>();

  function sweep(): void {
    const now = Date.now();
    for (const [code, c] of codes) if (c.expiresAt <= now) codes.delete(code);
  }

  /** Links `raw` to the account; the error line says why not. */
  function link(accountId: number, raw: string): LinkResult {
    const handle = normalizeHandle(raw);
    if (!PHONE_RE.test(handle)) return { ok: false, reason: `"${raw}" is not a phone number. It needs the country code, like +1 415 555 0100.` };
    const owner = db.accountByHandle(handle);
    if (owner?.id === accountId) return { ok: true, handle };
    if (owner) return { ok: false, reason: `${maskHandle(handle)} is already linked to another account.` };
    if (db.handlesOf(accountId).filter((h) => PHONE_RE.test(h)).length >= 3) return { ok: false, reason: "Three numbers are already linked; unlink one first." };
    if (!db.addHandle(accountId, handle)) return { ok: false, reason: `${maskHandle(handle)} is already linked to another account.` };
    log(`phone: linked ${handle} to account ${accountId}`);
    for (const fn of listeners.get(handle) ?? []) fn(accountId);
    listeners.delete(handle);
    for (const [code, c] of codes) if (c.handle === handle) codes.delete(code);
    return { ok: true, handle };
  }

  return {
    number: o.number,
    link,
    unlink(accountId: number, raw: string): LinkResult {
      const handle = normalizeHandle(raw);
      if (!db.removeHandle(accountId, handle)) return { ok: false, reason: `${maskHandle(handle)} is not linked to this account.` };
      log(`phone: unlinked ${handle} from account ${accountId}`);
      return { ok: true, handle };
    },
    /** Linked numbers of an account (never the Telegram id). */
    numbersOf: (accountId: number) => db.handlesOf(accountId).filter((h) => PHONE_RE.test(h)),
    /** A fresh code for a caller without an account, good for ten minutes; the same caller gets the same code while it lasts. */
    issue(handle: string): string {
      sweep();
      for (const [code, c] of codes) if (c.handle === handle) return code;
      let code: string;
      do code = String(randomInt(0, 10_000)).padStart(4, "0");
      while (codes.has(code));
      codes.set(code, { handle, expiresAt: Date.now() + CODE_TTL_MS });
      return code;
    },
    /** True when `text` is a code some caller is waiting on (so the app can treat the text as a claim). */
    pending(text: string): boolean {
      sweep();
      return codes.has(text.trim());
    },
    /** An owner texted a code: links that caller's number to their account. */
    claim(accountId: number, text: string): LinkResult {
      sweep();
      const c = codes.get(text.trim());
      if (!c) return { ok: false, reason: "That code is not waiting on anything (codes last ten minutes)." };
      return link(accountId, c.handle);
    },
    /** Called once `handle` gets linked to an account (a live call switches to the owner's tools). */
    onLinked(handle: string, fn: (accountId: number) => void): () => void {
      const set = listeners.get(handle) ?? new Set();
      set.add(fn);
      listeners.set(handle, set);
      return () => void set.delete(fn);
    },
  };
}
export type PhoneLinks = ReturnType<typeof createPhoneLinks>;
