/**
 * The owner's calendar: AgentSign's own events table, plus their Google Calendar once they connect it.
 *
 * Connecting is a one-time link (PUBLIC_URL/google/connect/<token>) that sends the owner through Google's consent
 * screen and lands on /google/callback, where the refresh token is stored on the account. From then on reads merge
 * Google's events with AgentSign's, friends' agents see Google busy times too, and every CAL the owner approves on
 * their Ledger is mirrored to Google. Nothing here is risky: the Ledger still gates every write, and Google is only
 * ever written with events the Ledger signed.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CalendarEvent, Db } from "../db.js";
import { localNow, TIMEZONE, toInstant, toLocal } from "../format.js";
import { messagePage } from "../web/page.js";
import { SECURITY_HEADERS } from "../web/headers.js";

export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendars.readonly"];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";
/** How long a connect link stays valid. */
export const LINK_TTL_MS = 15 * 60_000;
/** Refresh an access token this long before Google says it expires. */
const TOKEN_SLACK_MS = 60_000;
const MAX_EVENTS = 250;

export interface Interval {
  start: string;
  end: string;
}
export interface CalendarEventView {
  title: string;
  /** Local stamps "YYYY-MM-DDTHH:MM" in TIMEZONE. An all-day event runs 00:00 to 00:00 the next day. */
  start: string;
  end: string;
  with?: string;
  allDay?: true;
  /** Where the event lives: Google Calendar, or only AgentSign's own table. */
  source: "google" | "agentsign";
}
export interface CalendarRead {
  events: CalendarEventView[];
  /** Set when Google could not be read; the events are AgentSign's own only. */
  warning?: string;
}

export interface Calendar {
  /** Google OAuth is configured on this server (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET). */
  readonly available: boolean;
  /** The owner's connected Google account, if any. */
  connection(accountId: number): { email: string } | undefined;
  /** A fresh one-time link that connects the owner's Google Calendar. */
  connectLink(accountId: number): string;
  /** Forgets the connection and asks Google to revoke it. False when there was none. */
  disconnect(accountId: number): Promise<boolean>;
  /** Events overlapping [from, to): Google's (when connected and reachable) plus AgentSign's own that are not on Google. */
  events(accountId: number, from: string, to: string): Promise<CalendarRead>;
  /** Busy intervals in [from, to), no titles: for friends' agents. All-day and "free" Google events do not count. */
  busy(accountId: number, from: string, to: string): Promise<{ busy: Interval[]; warning?: string }>;
  /**
   * After an event landed in the table: mirrors the owner's new (and any earlier unmirrored, still upcoming) events to Google.
   * A sentence for the owner's notification, or undefined when there is no connection.
   */
  afterEvent(accountId: number): Promise<string | undefined>;
  /** GET /google/connect/:token (to Google) and GET /google/callback (from Google). */
  routes(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
}

export interface CalendarOptions {
  db: Db;
  /** Without these, only AgentSign's own events exist and connectLink throws. */
  google?: { clientId: string; clientSecret: string; publicUrl: string };
  /** Tells the owner how the connection went (texted, and kept in their chat history). */
  notify?: (accountId: number, text: string) => Promise<void>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  now?: () => Date;
}

/** Failures the owner should read, in plain words ("Google no longer allows access"). */
export class CalendarError extends Error {}

interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Google event ids are base32hex: lowercase a-v and digits, 5 to 1024 characters. */
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

export function createCalendar(o: CalendarOptions): Calendar {
  const { db } = o;
  const log = o.log ?? (() => {});
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? (() => new Date());
  const google = o.google;
  const redirectUri = google ? `${google.publicUrl.replace(/\/$/, "")}/google/callback` : "";

  /** One random salt per database, so event ids never collide with an older database's on the same Google calendar. */
  function salt(): string {
    let s = db.setting("google_event_salt");
    if (!s) db.setSetting("google_event_salt", (s = Array.from(randomBytes(8), (b) => ID_ALPHABET[b % 32]).join("")));
    return s;
  }
  const googleEventId = (event: CalendarEvent) => `agentsign${salt()}${event.id}`;

  async function notify(accountId: number, text: string): Promise<void> {
    if (db.account(accountId)) db.addMessage(accountId, "system", { role: "system", content: text });
    await o.notify?.(accountId, text).catch((err: unknown) => log(`google: notify ${accountId} failed: ${(err as Error).message}`));
  }

  // ---- OAuth -------------------------------------------------------------------------------------------------

  async function tokenRequest(form: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string }> {
    const res = await doFetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
    const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string; access_token?: string; expires_in?: number; refresh_token?: string };
    if (!res.ok || !body.access_token) {
      log(`google: token request failed: ${res.status} ${body.error ?? ""} ${body.error_description ?? ""}`);
      if (body.error === "invalid_grant") throw new CalendarError("Google no longer allows access");
      throw new CalendarError(`Google didn't accept the request (${body.error ?? res.status})`);
    }
    return { access_token: body.access_token, expires_in: body.expires_in ?? 3600, refresh_token: body.refresh_token };
  }

  /** A working access token for the account, refreshed when stale. Drops the connection if Google revoked it. */
  async function accessToken(accountId: number): Promise<string> {
    const row = db.googleCalendar(accountId);
    if (!row) throw new CalendarError("Google Calendar is not connected");
    if (row.access_token && row.expires_at && row.expires_at - now().getTime() > TOKEN_SLACK_MS) return row.access_token;
    if (!google) throw new CalendarError("Google Calendar is not set up on this server");
    let token;
    try {
      token = await tokenRequest({ grant_type: "refresh_token", refresh_token: row.refresh_token, client_id: google.clientId, client_secret: google.clientSecret });
    } catch (err) {
      if (err instanceof CalendarError && /no longer allows/.test(err.message)) {
        db.deleteGoogleCalendar(accountId);
        await notify(accountId, `Google Calendar (${row.email}) no longer allows access, so I disconnected it. Ask me to connect it again any time.`);
      }
      throw err;
    }
    db.setGoogleAccessToken(accountId, token.access_token, now().getTime() + token.expires_in * 1000);
    return token.access_token;
  }

  async function api<T>(accountId: number, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const token = await accessToken(accountId);
    const res = await doFetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: T;
    try {
      parsed = (text ? JSON.parse(text) : {}) as T;
    } catch {
      parsed = {} as T;
    }
    if (!res.ok && res.status !== 409) {
      const reason = (parsed as { error?: { message?: string } })?.error?.message ?? "";
      log(`google: ${method} ${path} -> ${res.status} ${reason}`);
      // A fresh Google Cloud project answers 403 until the Calendar API is enabled on it: a server-side fix, so name it.
      if (res.status === 403 && /has not been used in project|is disabled/i.test(reason)) throw new CalendarError("the Google Calendar API is not enabled on this server's Google project");
      throw new CalendarError(res.status === 401 || res.status === 403 ? "Google refused access" : `Google answered ${res.status}`);
    }
    return { status: res.status, body: parsed };
  }

  // ---- Reads ---------------------------------------------------------------------------------------------------

  function view(e: GoogleEvent): CalendarEventView | undefined {
    if (e.status === "cancelled") return undefined;
    const title = e.summary?.trim() || "(no title)";
    if (e.start?.date && e.end?.date) return { title, start: `${e.start.date}T00:00`, end: `${e.end.date}T00:00`, allDay: true, source: "google" };
    if (!e.start?.dateTime || !e.end?.dateTime) return undefined;
    const start = new Date(e.start.dateTime);
    const end = new Date(e.end.dateTime);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return undefined;
    return { title, start: toLocal(start), end: toLocal(end), source: "google" };
  }
  const declined = (e: GoogleEvent) => e.attendees?.some((a) => a.self && a.responseStatus === "declined") ?? false;

  async function googleEvents(accountId: number, from: string, to: string): Promise<{ events: CalendarEventView[]; busy: Interval[] }> {
    const row = db.googleCalendar(accountId)!;
    const q = new URLSearchParams({
      singleEvents: "true", orderBy: "startTime", maxResults: String(MAX_EVENTS), timeZone: TIMEZONE,
      timeMin: toInstant(from).toISOString(), timeMax: toInstant(to).toISOString(),
    });
    const { body } = await api<{ items?: GoogleEvent[] }>(accountId, "GET", `/calendars/${encodeURIComponent(row.calendar_id)}/events?${q}`);
    const events: CalendarEventView[] = [];
    const busy: Interval[] = [];
    for (const e of body.items ?? []) {
      const v = view(e);
      if (!v || v.end <= from || v.start >= to) continue;
      events.push(v);
      if (!v.allDay && e.transparency !== "transparent" && !declined(e)) busy.push({ start: v.start, end: v.end });
    }
    return { events, busy };
  }

  const local = (e: CalendarEvent): CalendarEventView => ({ title: e.title, start: e.starts_at, end: e.ends_at, ...(e.with_tag ? { with: e.with_tag } : {}), source: "agentsign" });
  const byStart = (a: Interval, b: Interval) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0);

  /** Both sources merged; with Google down, AgentSign's own events and a warning. */
  async function read(accountId: number, from: string, to: string): Promise<{ events: CalendarEventView[]; busy: Interval[]; warning?: string }> {
    const own = db.events(accountId, from, to);
    const all = { events: own.map(local), busy: own.map((e) => ({ start: e.starts_at, end: e.ends_at })) };
    if (!db.googleCalendar(accountId)) return all;
    try {
      const g = await googleEvents(accountId, from, to);
      // Events already mirrored to Google come back from Google; the rest (older, or a failed push) are AgentSign's alone.
      const unmirrored = own.filter((e) => !e.google_event_id);
      return {
        events: [...g.events, ...unmirrored.map(local)].sort(byStart),
        busy: [...g.busy, ...unmirrored.map((e) => ({ start: e.starts_at, end: e.ends_at }))].sort(byStart),
      };
    } catch (err) {
      const reason = err instanceof CalendarError ? err.message : "Google didn't answer";
      log(`google: read for ${accountId} failed: ${(err as Error).message}`);
      return { ...all, warning: `${reason}, so only AgentSign's own events are listed; Google Calendar events are missing.` };
    }
  }

  // ---- Writes --------------------------------------------------------------------------------------------------

  /** Mirrors unmirrored upcoming events. Idempotent: the id is derived from the row, so a retry hits 409 and marks it. */
  async function push(accountId: number): Promise<number> {
    const row = db.googleCalendar(accountId);
    if (!row) return 0;
    let pushed = 0;
    for (const e of db.unsyncedEvents(accountId, localNow(now()))) {
      const id = googleEventId(e);
      const body = {
        id,
        summary: e.with_tag ? `${e.title} with ${e.with_tag}` : e.title,
        description: e.with_tag ? `Meeting with ${e.with_tag}, arranged by Jarvis on AgentSign and confirmed by both of you.` : "Added by Jarvis on AgentSign, approved on the owner's Ledger.",
        start: { dateTime: `${e.starts_at}:00`, timeZone: TIMEZONE },
        end: { dateTime: `${e.ends_at}:00`, timeZone: TIMEZONE },
      };
      const { status } = await api(accountId, "POST", `/calendars/${encodeURIComponent(row.calendar_id)}/events`, body);
      db.setEventGoogleId(e.id, id);
      log(`google: ${status === 409 ? "already had" : "added"} '${e.title}' ${e.starts_at} for ${accountId} as ${id}`);
      pushed++;
    }
    return pushed;
  }

  // ---- Connecting ----------------------------------------------------------------------------------------------

  function authUrl(token: string): string {
    const q = new URLSearchParams({
      client_id: google!.clientId, redirect_uri: redirectUri, response_type: "code", scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: token,
    });
    return `${AUTH_URL}?${q}`;
  }

  /** Exchanges the code, looks up the primary calendar, stores the connection and mirrors upcoming events. */
  async function finishConnect(accountId: number, code: string): Promise<string> {
    const token = await tokenRequest({ grant_type: "authorization_code", code, client_id: google!.clientId, client_secret: google!.clientSecret, redirect_uri: redirectUri });
    if (!token.refresh_token) throw new CalendarError("Google didn't give lasting access");
    const expiresAt = now().getTime() + token.expires_in * 1000;
    db.setGoogleCalendar({ account_id: accountId, email: "", refresh_token: token.refresh_token, access_token: token.access_token, expires_at: expiresAt, calendar_id: "primary", time_zone: null });
    let primary: { id?: string; summary?: string; timeZone?: string };
    try {
      primary = (await api<{ id?: string; summary?: string; timeZone?: string }>(accountId, "GET", "/calendars/primary")).body;
    } catch (err) {
      db.deleteGoogleCalendar(accountId);
      throw err;
    }
    const email = primary.id?.trim() || primary.summary?.trim() || "your Google account";
    db.setGoogleCalendar({ account_id: accountId, email, refresh_token: token.refresh_token, access_token: token.access_token, expires_at: expiresAt, calendar_id: "primary", time_zone: primary.timeZone ?? null });
    log(`google: ${accountId} connected ${email}${primary.timeZone ? ` (${primary.timeZone})` : ""}`);
    return email;
  }

  /** The owner's connect link: a pending, unexpired token for their account. */
  function pendingLink(token: string) {
    if (!/^[0-9a-f]{64}$/.test(token)) return undefined;
    const link = db.googleLink(token);
    return link && link.status === "pending" && Date.parse(link.expires_at) > now().getTime() && db.account(link.account_id) ? link : undefined;
  }

  async function routes(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://x");
    const html = (status: number, body: string) => void res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" }).end(body);
    const fail = (title: string, detail: string) => html(400, messagePage({ eyebrow: "Google Calendar", title, detail, tone: "bad" }));
    const connect = /^\/google\/connect\/([0-9a-f]{64})\/?$/.exec(path);
    if (connect) {
      if (req.method !== "GET") return html(405, messagePage({ eyebrow: "Google Calendar", title: "Not allowed.", detail: "", tone: "bad" })), true;
      if (!google) return fail("Google Calendar is not set up on this server.", "Ask whoever runs AgentSign to add Google credentials."), true;
      const link = pendingLink(connect[1]!);
      if (!link) return fail("This link has expired.", "Ask Jarvis to connect Google Calendar again and open the new link."), true;
      res.writeHead(302, { ...SECURITY_HEADERS, location: authUrl(link.token) }).end();
      return true;
    }
    if (path !== "/google/callback") return false;
    if (req.method !== "GET") return html(405, messagePage({ eyebrow: "Google Calendar", title: "Not allowed.", detail: "", tone: "bad" })), true;
    const link = pendingLink(url.searchParams.get("state") ?? "");
    if (!link || !google) return fail("This link has expired.", "Ask Jarvis to connect Google Calendar again and open the new link."), true;
    if (!db.useGoogleLink(link.token)) return fail("This link was already used.", "Ask Jarvis to connect Google Calendar again if it is not connected."), true;
    const code = url.searchParams.get("code");
    if (!code) {
      log(`google: ${link.account_id} did not grant access (${url.searchParams.get("error") ?? "no code"})`);
      await notify(link.account_id, "Google Calendar was not connected (you didn't grant access). Ask me again any time.");
      return html(200, messagePage({ eyebrow: "Google Calendar", title: "Not connected.", detail: "You didn't grant access, so nothing changed. Ask Jarvis again any time." })), true;
    }
    try {
      const email = await finishConnect(link.account_id, code);
      let pushed = 0;
      let pushNote = "";
      try {
        pushed = await push(link.account_id);
      } catch (err) {
        pushNote = ` I couldn't copy your upcoming AgentSign events over yet (${err instanceof CalendarError ? err.message : "Google didn't answer"}); I'll try again with your next event.`;
      }
      const copied = pushed ? ` I copied ${pushed} upcoming AgentSign event${pushed === 1 ? "" : "s"} over.` : "";
      await notify(link.account_id, `Google Calendar connected as ${email}.${copied}${pushNote} I'll read it when you ask about your schedule, and new events you approve on your Ledger will land there too.`);
      return html(200, messagePage({ eyebrow: "Google Calendar", title: "Connected.", detail: `Jarvis can now read ${esc(email)} and add the events you approve on your Ledger. You can close this tab.`, tone: "ok" })), true;
    } catch (err) {
      const reason = err instanceof CalendarError ? err.message : "something went wrong on my side";
      log(`google: connect for ${link.account_id} failed: ${(err as Error).stack ?? err}`);
      await notify(link.account_id, `Google Calendar was not connected: ${reason}. Ask me again any time.`);
      return html(502, messagePage({ eyebrow: "Google Calendar", title: "Not connected.", detail: `${esc(reason)}. Ask Jarvis to try again.`, tone: "bad" })), true;
    }
  }

  return {
    available: !!google,
    connection(accountId) {
      const row = db.googleCalendar(accountId);
      return row ? { email: row.email } : undefined;
    },
    connectLink(accountId) {
      if (!google) throw new CalendarError("Google Calendar is not set up on this server");
      const token = randomBytes(32).toString("hex");
      db.insertGoogleLink(token, accountId, new Date(now().getTime() + LINK_TTL_MS));
      return `${google.publicUrl.replace(/\/$/, "")}/google/connect/${token}`;
    },
    async disconnect(accountId) {
      const row = db.googleCalendar(accountId);
      if (!row) return false;
      db.deleteGoogleCalendar(accountId);
      // Best effort: the row is gone either way, and Google shows the app under the account's permissions regardless.
      await doFetch(`${REVOKE_URL}?${new URLSearchParams({ token: row.refresh_token })}`, { method: "POST" }).catch((err: unknown) => log(`google: revoke failed: ${(err as Error).message}`));
      log(`google: ${accountId} disconnected ${row.email}`);
      return true;
    },
    async events(accountId, from, to) {
      const r = await read(accountId, from, to);
      return { events: r.events, ...(r.warning ? { warning: r.warning } : {}) };
    },
    async busy(accountId, from, to) {
      const r = await read(accountId, from, to);
      return { busy: r.busy, ...(r.warning ? { warning: r.warning } : {}) };
    },
    async afterEvent(accountId) {
      if (!db.googleCalendar(accountId)) return undefined;
      try {
        return (await push(accountId)) ? "It's on your Google Calendar too." : undefined;
      } catch (err) {
        const reason = err instanceof CalendarError ? err.message : "Google didn't answer";
        log(`google: push for ${accountId} failed: ${(err as Error).stack ?? err}`);
        return `I couldn't add it to your Google Calendar (${reason}); I'll try again with your next event.`;
      }
    },
    routes,
  };
}
