/**
 * Inbound phone calls on a number created with a webhook: xAI POSTs `realtime.call.incoming`, this server checks
 * the Standard Webhooks signature, joins the call over the realtime websocket and runs Jarvis for the caller.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import WebSocket from "ws";
import type { AppVoiceHooks } from "../app.js";
import { normalizeHandle } from "../handles.js";
import { runVoiceSession, type VoiceTurn } from "./session.js";

const TOLERANCE_S = 5 * 60;
const KEEP_CALLS = 20;
export const CONTEXT_KEY = "voice_context";

/** Standard Webhooks v1: base64 HMAC-SHA256 of `${id}.${timestamp}.${body}` keyed with the base64 part of `whsec_...`. */
export function verifyWebhook(secret: string, headers: Record<string, string | string[] | undefined>, body: string, nowMs = Date.now()): boolean {
  const h = (k: string) => [headers[k]].flat()[0] ?? "";
  const id = h("webhook-id");
  const timestamp = h("webhook-timestamp");
  if (!id || !/^\d+$/.test(timestamp) || Math.abs(nowMs / 1000 - Number(timestamp)) > TOLERANCE_S) return false;
  const raw = secret.replace(/^whsec_/, "");
  // Tolerant about the key: the documented base64 key, and the raw string in case a secret is not base64.
  const keys = [Buffer.from(raw, "base64"), Buffer.from(secret, "utf8")].filter((k) => k.length);
  const expected = keys.map((k) => createHmac("sha256", k).update(`${id}.${timestamp}.${body}`).digest());
  return h("webhook-signature")
    .split(/\s+/)
    .map((s) => s.split(",", 2))
    .some(([v, sig]) => v === "v1" && !!sig && expected.some((e) => {
      const got = Buffer.from(sig, "base64");
      return got.length === e.length && timingSafeEqual(got, e);
    }));
}

/** "+14155550100", "<sip:+14155550100@x.y>;tag=1" or "\"Matt\" <tel:4155550100>" -> "+14155550100"; undefined when hidden. */
export function callerFrom(value: string | undefined): string | undefined {
  const uri = /(?:sips?|tel):([^@;>]+)/i.exec(value ?? "")?.[1] ?? value ?? "";
  const handle = normalizeHandle(uri);
  return /^\+\d{7,15}$/.test(handle) ? handle : undefined;
}

export interface VoiceCallRecord {
  id: string;
  caller: string;
  tag?: string;
  startedAt: string;
  endedAt?: string;
  turns: VoiceTurn[];
}

export interface VoiceOptions {
  app: AppVoiceHooks;
  apiKey: string;
  /** VOICE_WEBHOOK_SECRET (the number's dispatch_signing_secret). */
  secret?: string;
  /** Accept unsigned webhooks when no secret is set (dev only). */
  allowUnsigned?: boolean;
  voice?: string;
  baseUrl?: string;
  log?: (line: string) => void;
}

export function createVoice(o: VoiceOptions) {
  const { db } = o.app.deps;
  const log = o.log ?? (() => {});
  const api = (o.baseUrl ?? "https://api.x.ai/v1").replace(/\/$/, "");
  const calls: VoiceCallRecord[] = [];
  const live = new Map<string, { refresh(): Promise<void> }>();
  const seen = new Set<string>();
  const context = () => db.setting(CONTEXT_KEY) ?? "";

  async function hangup(callId: string): Promise<void> {
    const res = await fetch(`${api}/realtime/calls/${encodeURIComponent(callId)}/hangup`, { method: "POST", headers: { authorization: `Bearer ${o.apiKey}` } }).catch((err: Error) => err);
    if (res instanceof Error || !res.ok) log(`voice ${callId}: hangup failed: ${res instanceof Error ? res.message : res.status}`);
  }

  /** The call's words go into the account's chat history, so the text agent knows what was said. */
  function persist(call: VoiceCallRecord): void {
    const account = db.accountByHandle(call.caller);
    const lines = call.turns.filter((t) => t.who === "caller" || t.who === "jarvis").map((t) => `${t.who === "caller" ? "User" : "Jarvis"} said: ${t.text}`);
    if (!account || !lines.length) return;
    const minutes = Math.max(1, Math.round((Date.parse(call.endedAt!) - Date.parse(call.startedAt)) / 60_000));
    db.addMessage(account.id, "system", { role: "system", content: `Phone call (${minutes} min):\n${lines.join("\n").slice(-3000)}` });
  }

  function join(callId: string, caller: string): void {
    const record: VoiceCallRecord = { id: callId, caller, tag: db.accountByHandle(caller)?.tag, startedAt: new Date().toISOString(), turns: [] };
    calls.unshift(record);
    calls.splice(KEEP_CALLS);
    const ws = new WebSocket(`${api.replace(/^http/, "ws")}/realtime?call_id=${encodeURIComponent(callId)}`, { headers: { authorization: `Bearer ${o.apiKey}` } });
    ws.on("error", (err) => log(`voice ${callId}: socket error: ${err.message}`));
    ws.once("open", () => {
      const session = runVoiceSession({
        ws, caller, deps: o.app, context, voice: o.voice, log,
        onHangup: () => void hangup(callId).finally(() => ws.close()),
      });
      record.turns = session.turns;
      live.set(callId, session);
    });
    ws.once("close", () => {
      live.delete(callId);
      record.endedAt = new Date().toISOString();
      record.tag = db.accountByHandle(caller)?.tag ?? record.tag;
      log(`voice ${callId}: call with ${caller} ended after ${record.turns.length} turn(s)`);
      persist(record);
    });
  }

  return {
    /** POST /voice/webhook. Answers fast; the call runs in the background. */
    webhook(headers: Record<string, string | string[] | undefined>, body: string): { status: number; body: unknown } {
      if (!o.secret) {
        if (!o.allowUnsigned) return log("voice: VOICE_WEBHOOK_SECRET is not set, refusing the webhook"), { status: 503, body: { error: "voice webhook not configured" } };
        log("voice: !!! UNSIGNED WEBHOOK ACCEPTED (VOICE_WEBHOOK_SECRET unset, dev only) !!!");
      } else if (!verifyWebhook(o.secret, headers, body)) return { status: 401, body: { error: "bad signature" } };
      let event: { id?: string; type?: string; data?: { call_id?: string; sip_headers?: { name: string; value: string }[] } };
      try {
        event = JSON.parse(body) as typeof event;
      } catch {
        return { status: 400, body: { error: "not JSON" } };
      }
      if (event.type !== "realtime.call.incoming" || !event.data?.call_id) return { status: 200, body: { ignored: event.type ?? "unknown" } };
      if (event.id && seen.has(event.id)) return { status: 200, body: { duplicate: true } };
      if (event.id) seen.add(event.id);
      const from = event.data.sip_headers?.find((h) => h.name.toLowerCase() === "from")?.value;
      const caller = callerFrom(from) ?? "unknown";
      log(`voice: incoming call ${event.data.call_id} from ${caller}`);
      join(event.data.call_id, caller);
      return { status: 200, body: { ok: true } };
    },
    calls: () => calls,
    context,
    /** POST /voice/context: stored for new calls and pushed to the live ones. */
    async setContext(text: string): Promise<number> {
      db.setSetting(CONTEXT_KEY, text);
      await Promise.all([...live.values()].map((s) => s.refresh()));
      return live.size;
    },
  };
}
export type Voice = ReturnType<typeof createVoice>;
