/**
 * Phone calls through Twilio, spoken by OpenAI's realtime model. The call is recognised by its caller ID (src/phone.ts).
 *
 *   1. Twilio POSTs the call to /twilio/voice (form-encoded, signed with the account's auth token).
 *   2. The answer is TwiML that connects the call's audio to wss://<PUBLIC_URL>/twilio/media, with a one-time token
 *      naming the caller, so the media stream cannot claim a number the signed webhook did not see.
 *   3. The media stream (G.711 mu-law, 8 kHz, base64) is piped both ways into one realtime session (src/voice/session.ts)
 *      configured for audio/pcmu, so no transcoding happens here. A barge-in clears Twilio's playback buffer and
 *      truncates Jarvis's last item to what the caller actually heard.
 *   4. end_call (or the caller hanging up) closes the stream; the TwiML's <Hangup/> ends the call; the transcript
 *      goes into the owner's chat history.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import type { AppVoiceHooks } from "../app.js";
import type { PhoneLinks } from "../phone.js";
import { DEFAULT_OPENAI_VOICE, persistCall, runVoiceSession, type VoiceSession, type VoiceTurn } from "./session.js";
import { callerFrom, CONTEXT_KEY, type VoiceCallRecord } from "./webhook.js";

/** OpenAI's realtime models: gpt-realtime-2.1 (July 2026), gpt-realtime-2.1-mini (cheaper), gpt-realtime. */
export const DEFAULT_REALTIME_MODEL = "gpt-realtime-2.1";
export const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";
const TOKEN_TTL_MS = 60_000;
/** What Twilio puts in From when the caller ID is withheld: anonymous, restricted, unknown, unavailable. */
const WITHHELD = new Set(["+266696687", "+7378742833", "+8656696", "+86282452253"]);
const START_TIMEOUT_MS = 10_000;
const KEEP_CALLS = 20;
/** Caller audio that arrives before the model is connected (the first second or so) is kept, not dropped. */
const EARLY_AUDIO_MAX = 150;

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Twilio's request signature: base64 HMAC-SHA1 (the auth token) over the exact URL plus every POST field, sorted by
 * name, as name followed by value. Twilio may sign the URL with or without its default port, so both are accepted.
 */
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature) return false;
  const sorted = Object.keys(params).sort().map((k) => `${k}${params[k]}`).join("");
  const candidates = new Set([url]);
  const m = /^(https?):\/\/([^/:?#]+)(:\d+)?(.*)$/.exec(url);
  if (m) {
    const [, scheme, host, port, rest] = m as unknown as [string, string, string, string | undefined, string];
    if (!port) candidates.add(`${scheme}://${host}:${scheme === "https" ? 443 : 80}${rest}`);
    else if ((scheme === "https" && port === ":443") || (scheme === "http" && port === ":80")) candidates.add(`${scheme}://${host}${rest}`);
  }
  return [...candidates].some((u) => same(createHmac("sha1", authToken).update(u + sorted).digest("base64"), signature));
}

/** TwiML that streams the call to the media websocket; the stream carries the token that names the caller. */
export function connectTwiml(mediaUrl: string, token: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${esc(mediaUrl)}"><Parameter name="token" value="${esc(token)}"/></Stream></Connect><Hangup/></Response>`;
}

/** TwiML that says one line and hangs up (hidden numbers). */
export function sayTwiml(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</Say><Hangup/></Response>`;
}

export interface TwilioVoiceOptions {
  app: AppVoiceHooks;
  phone: PhoneLinks;
  openaiKey: string;
  /** OPENAI_REALTIME_MODEL. */
  model?: string;
  /** OPENAI_VOICE. */
  voice?: string;
  /** TWILIO_AUTH_TOKEN; without it webhooks are only accepted when `allowUnsigned` (dev). */
  authToken?: string;
  allowUnsigned?: boolean;
  /** Where Twilio reaches this server (https). The media stream is wss://<host>/twilio/media. */
  publicUrl: string;
  /** Tests point this at a fake realtime server. */
  openaiUrl?: string;
  log?: (line: string) => void;
}

export function createTwilioVoice(o: TwilioVoiceOptions) {
  const { db } = o.app.deps;
  const log = o.log ?? (() => {});
  const model = o.model || DEFAULT_REALTIME_MODEL;
  const voice = o.voice || DEFAULT_OPENAI_VOICE;
  const mediaUrl = `${o.publicUrl.replace(/\/$/, "").replace(/^http/, "ws")}/twilio/media`;
  const tokens = new Map<string, { caller: string; callSid: string; expiresAt: number }>();
  const calls: VoiceCallRecord[] = [];
  const live = new Map<string, VoiceSession>();
  const wss = new WebSocketServer({ noServer: true });
  const context = () => db.setting(CONTEXT_KEY) ?? "";

  function issueToken(caller: string, callSid: string): string {
    const now = Date.now();
    for (const [t, v] of tokens) if (v.expiresAt <= now) tokens.delete(t);
    const token = randomBytes(16).toString("hex");
    tokens.set(token, { caller, callSid, expiresAt: now + TOKEN_TTL_MS });
    return token;
  }

  /** One call: the Twilio stream on one side, the realtime session on the other. */
  function bridge(twilio: WebSocket): void {
    let streamSid = "";
    let session: VoiceSession | undefined;
    let openai: WebSocket | undefined;
    let record: VoiceCallRecord | undefined;
    const early: string[] = [];
    let latestMediaTs = 0; // ms since the stream started, from Twilio's media messages
    let responseStartTs: number | undefined; // latestMediaTs when Jarvis's current item started playing
    let lastItem: string | undefined;
    let marks: string[] = []; // audio chunks sent to Twilio and not yet played
    let markSeq = 0;
    const toTwilio = (msg: Record<string, unknown>) => void (twilio.readyState === WebSocket.OPEN && twilio.send(JSON.stringify({ ...msg, streamSid })));
    const startTimer = setTimeout(() => (log("twilio: no start message, closing"), twilio.close(1008, "no start")), START_TIMEOUT_MS);

    function onStart(start: { streamSid?: string; callSid?: string; customParameters?: Record<string, string> }): void {
      clearTimeout(startTimer);
      const token = start.customParameters?.token ?? "";
      const claim = tokens.get(token);
      tokens.delete(token);
      if (!claim || claim.expiresAt < Date.now() || (start.callSid && claim.callSid !== start.callSid)) {
        log(`twilio: stream without a valid token (call ${start.callSid ?? "?"}), closing`);
        return twilio.close(1008, "unknown stream");
      }
      streamSid = start.streamSid ?? "";
      const caller = claim.caller;
      record = { id: claim.callSid, caller, tag: db.accountByHandle(caller)?.tag, startedAt: new Date().toISOString(), turns: [] };
      calls.unshift(record);
      calls.splice(KEEP_CALLS);
      log(`twilio: call ${claim.callSid} from ${caller} (${record.tag ?? "unlinked"}) streaming`);
      openai = new WebSocket(`${o.openaiUrl ?? OPENAI_REALTIME_URL}?model=${encodeURIComponent(model)}`, { headers: { authorization: `Bearer ${o.openaiKey}` } });
      openai.on("error", (err) => log(`twilio ${claim.callSid}: openai socket error: ${err.message}`));
      openai.once("open", () => {
        session = runVoiceSession({
          ws: openai!, caller, deps: o.app, provider: "openai", voice, phone: o.phone, context, log,
          onAudio(delta, itemId) {
            if (itemId !== lastItem) {
              lastItem = itemId;
              responseStartTs = latestMediaTs;
            }
            toTwilio({ event: "media", media: { payload: delta } });
            const name = `m${++markSeq}`;
            marks.push(name);
            toTwilio({ event: "mark", mark: { name } });
          },
          onSpeechStarted() {
            // Barge-in: drop what Twilio has not played yet and tell the model where the caller stopped listening.
            if (!marks.length || !lastItem) return;
            if (responseStartTs !== undefined) session?.truncate(lastItem, latestMediaTs - responseStartTs);
            toTwilio({ event: "clear" });
            marks = [];
            lastItem = undefined;
            responseStartTs = undefined;
          },
          onHangup: () => twilio.close(1000, "end of call"),
        });
        record!.turns = session.turns;
        live.set(claim.callSid, session);
        for (const payload of early.splice(0)) session.appendAudio(payload);
      });
      openai.once("close", () => {
        live.delete(claim.callSid);
        if (twilio.readyState === WebSocket.OPEN) twilio.close(1000, "model left");
      });
    }

    twilio.on("message", (data) => {
      let msg: { event?: string; start?: Parameters<typeof onStart>[0]; media?: { payload?: string; timestamp?: string; track?: string }; mark?: { name?: string } };
      try {
        msg = JSON.parse(String(data)) as typeof msg;
      } catch {
        return;
      }
      switch (msg.event) {
        case "start":
          return onStart(msg.start ?? {});
        case "media": {
          if (msg.media?.track && msg.media.track !== "inbound") return;
          const payload = msg.media?.payload;
          if (!payload) return;
          latestMediaTs = Number(msg.media?.timestamp ?? latestMediaTs) || latestMediaTs;
          if (session) session.appendAudio(payload);
          else if (early.length < EARLY_AUDIO_MAX) early.push(payload);
          return;
        }
        case "mark": {
          const i = marks.indexOf(msg.mark?.name ?? "");
          if (i >= 0) marks.splice(0, i + 1);
          return;
        }
        case "stop":
          return twilio.close(1000, "stream stopped");
      }
    });
    twilio.on("error", (err) => log(`twilio: stream socket error: ${err.message}`));
    twilio.once("close", () => {
      clearTimeout(startTimer);
      if (openai && openai.readyState !== WebSocket.CLOSED) openai.close();
      if (!record) return;
      record.endedAt = new Date().toISOString();
      record.tag = db.accountByHandle(record.caller)?.tag ?? record.tag;
      log(`twilio: call ${record.id} with ${record.caller} ended after ${record.turns.length} turn(s)`);
      persistCall(db, record.caller, record.turns, record.startedAt, record.endedAt);
    });
  }

  return {
    mediaUrl,
    model,
    voice,
    /** POST /twilio/voice: the signed form from Twilio. `url` is the exact URL Twilio called. */
    webhook(url: string, headers: Record<string, string | string[] | undefined>, body: string): { status: number; type: string; body: string } {
      const params = Object.fromEntries(new URLSearchParams(body));
      const signature = [headers["x-twilio-signature"]].flat()[0];
      if (!o.authToken) {
        if (!o.allowUnsigned) return log("twilio: TWILIO_AUTH_TOKEN is not set, refusing the webhook"), { status: 503, type: "text/plain", body: "twilio is not configured" };
        log("twilio: !!! UNSIGNED WEBHOOK ACCEPTED (TWILIO_AUTH_TOKEN unset, dev only) !!!");
      } else if (!verifyTwilioSignature(o.authToken, url, params, signature)) return log(`twilio: bad signature for ${url}`), { status: 403, type: "text/plain", body: "bad signature" };
      const callSid = params.CallSid ?? "";
      const caller = callerFrom(params.From);
      if (!caller || WITHHELD.has(caller)) {
        log(`twilio: call ${callSid} from a hidden number, declined`);
        return { status: 200, type: "text/xml", body: sayTwiml("Jarvis here. Your number is hidden, so I can't tell who you are. Please call back with caller ID on.") };
      }
      log(`twilio: incoming call ${callSid} from ${caller} (${db.accountByHandle(caller)?.tag ?? "unlinked"})`);
      return { status: 200, type: "text/xml", body: connectTwiml(mediaUrl, issueToken(caller, callSid)) };
    },
    /** Takes the websocket upgrade for /twilio/media. */
    upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
      wss.handleUpgrade(req, socket, head, (ws) => bridge(ws));
    },
    calls: () => calls,
    context,
    /** Standing instructions for every call (POST /voice/context); refresh() pushes them to the live ones. */
    setContext: (text: string) => db.setSetting(CONTEXT_KEY, text),
    /** Pushes new standing context to the live calls. */
    async refresh(): Promise<number> {
      await Promise.all([...live.values()].map((s) => s.refresh()));
      return live.size;
    },
    async close(): Promise<void> {
      for (const s of live.values()) s.close();
      wss.close();
    },
  };
}
export type TwilioVoice = ReturnType<typeof createTwilioVoice>;
export type { VoiceTurn };
