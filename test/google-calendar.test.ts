/** Google Calendar: the connect link and OAuth round trip, merged reads, friends' busy times, and mirroring approved events. */
import { afterEach, describe, expect, it } from "vitest";
import { createCalendar, GOOGLE_SCOPES, LINK_TTL_MS } from "../src/calendar/google.js";
import { createRemoteDeviceManager } from "../src/device/index.js";
import { addMinutes, formatWhen, localNow, toInstant, toLocal } from "../src/format.js";
import { startWebServer, type WebServer } from "../src/web/server.js";
import { call, delegate, harness, isEngine, PHONES, say } from "./helpers.js";

const NOW = new Date("2026-10-10T20:00:00Z"); // Sat Oct 10, 13:00 in Los Angeles
const PUBLIC_URL = "https://agentsign.example";
const GOOGLE = { clientId: "client-id", clientSecret: "client-secret", publicUrl: PUBLIC_URL };

interface GoogleEventRow {
  id: string;
  summary?: string;
  description?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  status?: string;
  transparency?: string;
  attendees?: { self?: boolean; responseStatus?: string }[];
}

/** Google's token endpoint and Calendar API, in memory. */
function fakeGoogle() {
  const state = {
    events: [] as GoogleEventRow[],
    requests: [] as { method: string; url: string; body?: string }[],
    /** The refresh token Google still honours; set to undefined to simulate the user revoking access. */
    refreshToken: "refresh-1" as string | undefined,
    accessTokens: 0,
    listFails: false,
    primaryDisabled: false,
    insertFails: false,
    email: "matt@gmail.com",
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    state.requests.push({ method, url, body });
    if (url === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(body);
      if (form.get("client_id") !== GOOGLE.clientId || form.get("client_secret") !== GOOGLE.clientSecret) return json(401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== "good-code" || form.get("redirect_uri") !== `${PUBLIC_URL}/google/callback`) return json(400, { error: "invalid_grant" });
        return json(200, { access_token: `access-${++state.accessTokens}`, expires_in: 3600, refresh_token: state.refreshToken, scope: GOOGLE_SCOPES.join(" "), token_type: "Bearer" });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (!state.refreshToken || form.get("refresh_token") !== state.refreshToken) return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        return json(200, { access_token: `access-${++state.accessTokens}`, expires_in: 3600, token_type: "Bearer" });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return json(200, {});
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
    if (!/^Bearer access-\d+$/.test(auth)) return json(401, { error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } });
    const u = new URL(url);
    if (u.pathname === "/calendar/v3/calendars/primary") {
      if (state.primaryDisabled) return json(403, { error: { code: 403, message: "Google Calendar API has not been used in project 123 before or it is disabled. Enable it by visiting ... then retry.", status: "PERMISSION_DENIED" } });
      return json(200, { id: state.email, summary: state.email, timeZone: "America/Los_Angeles" });
    }
    if (u.pathname === "/calendar/v3/calendars/primary/events" && method === "GET") {
      if (state.listFails) return json(500, { error: { code: 500, message: "Backend Error" } });
      const min = Date.parse(u.searchParams.get("timeMin")!);
      const max = Date.parse(u.searchParams.get("timeMax")!);
      const at = (p: { dateTime?: string; date?: string }) => Date.parse(p.dateTime ?? `${p.date}T00:00:00Z`);
      return json(200, { items: state.events.filter((e) => at(e.end) > min && at(e.start) < max) });
    }
    if (u.pathname === "/calendar/v3/calendars/primary/events" && method === "POST") {
      if (state.insertFails) return json(503, { error: { code: 503, message: "Service Unavailable" } });
      const event = JSON.parse(body!) as GoogleEventRow;
      if (state.events.some((e) => e.id === event.id)) return json(409, { error: { code: 409, message: "The requested identifier already exists." } });
      state.events.push(event);
      return json(200, event);
    }
    return json(404, { error: { code: 404, message: `no route ${method} ${u.pathname}` } });
  };
  return { state, fetch: fetchImpl };
}

let web: WebServer | undefined;
afterEach(async () => {
  await web?.close();
  web = undefined;
});

/** A full app with Google configured, the fake API behind fetch, and the web routes served for real. */
async function setup(deviceCount = 2) {
  const google = fakeGoogle();
  const db = (await import("../src/db.js")).openDb(":memory:");
  const notified: { accountId: number; text: string }[] = [];
  const calendar = createCalendar({ db, google: GOOGLE, fetch: google.fetch, now: () => NOW, notify: async (accountId, text) => void notified.push({ accountId, text }) });
  const h = harness(deviceCount, undefined, { db, calendar });
  web = await startWebServer({ db, remote: createRemoteDeviceManager({ db, publicUrl: "http://x" }), port: 0, routes: calendar.routes });
  const base = `http://127.0.0.1:${web.port}`;
  const get = (path: string) => fetch(base + path, { redirect: "manual" });
  const matt = await h.onboard("matt", 0);
  return { ...h, google, calendar, notified, matt, get, base };
}

/** Walks the connect link through the fake consent screen: follow our redirect, then come back with the code. */
async function consent(get: (path: string) => Promise<Response>, link: string, code = "good-code") {
  const path = link.slice(PUBLIC_URL.length);
  const redirect = await get(path);
  expect(redirect.status).toBe(302);
  const to = new URL(redirect.headers.get("location")!);
  expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(to.searchParams.get("redirect_uri")).toBe(`${PUBLIC_URL}/google/callback`);
  expect(to.searchParams.get("access_type")).toBe("offline");
  expect(to.searchParams.get("scope")).toBe(GOOGLE_SCOPES.join(" "));
  const state = to.searchParams.get("state")!;
  return get(`/google/callback?${new URLSearchParams(code ? { state, code } : { state, error: "access_denied" })}`);
}

/** The engine's report as the persona saw it on its last call: a CAL the policy does not gate is done at once, so the owner reads the persona's words, not a Ledger outcome text. */
const report = (s: { requests: { messages: { content: unknown }[] }[] }) => String(s.requests.at(-1)!.messages.at(-1)!.content);

describe("google calendar", () => {
  it("'connect my google calendar' sends a link without a model call, and the callback stores the connection and texts the owner", async () => {
    const s = await setup();
    await s.send(PHONES.matt, "connect my google calendar");
    const text = s.to(PHONES.matt).at(-1)!;
    expect(text).toMatch(/^Here's the link to connect your Google Calendar\./);
    const link = /https:\/\/agentsign\.example\/google\/connect\/[0-9a-f]{64}/.exec(text)?.[0];
    expect(link).toBeDefined();
    expect(s.remaining()).toBe(0); // nothing scripted, nothing consumed
    const res = await consent(s.get, link!);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Connected.");
    expect(s.calendar.connection(s.matt.id)).toEqual({ email: "matt@gmail.com" });
    expect(s.notified).toEqual([{ accountId: s.matt.id, text: expect.stringMatching(/^Google Calendar connected as matt@gmail\.com\. I'll read it/) }]);
    expect(s.db.recentMessages(s.matt.id).at(-1)).toMatchObject({ role: "system", content: { content: expect.stringContaining("connected as matt@gmail.com") } });
    // The code was exchanged with the client secret and the right redirect URI.
    const token = s.google.state.requests.find((r) => r.url.endsWith("/token"))!;
    expect(new URLSearchParams(token.body).get("grant_type")).toBe("authorization_code");
    // A second visit with the same state is refused, and so is a made-up one.
    expect((await s.get(link!.slice(PUBLIC_URL.length))).status).toBe(400);
    expect((await s.get(`/google/callback?state=${"0".repeat(64)}&code=good-code`)).status).toBe(400);
  });

  it("the engine's connect tool attaches the link under the persona's reply", async () => {
    const s = await setup();
    s.script(
      delegate("connect Google Calendar"),
      (req) => {
        expect(isEngine(req)).toBe(true);
        expect(req.system).toContain("Google Calendar: not connected");
        return call("connect_google_calendar", {});
      },
      say("Link sent."),
      say("Here's the link to connect your Google Calendar."),
    );
    await s.send(PHONES.matt, "can you hook my calendar up to google?");
    const text = s.to(PHONES.matt).at(-1)!;
    expect(text).toMatch(/^Here's the link to connect your Google Calendar\.\n\nConnect your Google Calendar here \(the link works for 15 minutes\): https:\/\/agentsign\.example\/google\/connect\/[0-9a-f]{64}$/);
    expect(s.requests.at(-2)!.messages.at(-1)!.content).toContain("A link to connect Google Calendar goes out right under the reply");
  });

  it("denying access on Google's side connects nothing and says so", async () => {
    const s = await setup();
    await s.send(PHONES.matt, "connect google calendar");
    const link = /https:\S+/.exec(s.to(PHONES.matt).at(-1)!)![0];
    const res = await consent(s.get, link, "");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Not connected.");
    expect(s.calendar.connection(s.matt.id)).toBeUndefined();
    expect(s.notified.at(-1)!.text).toBe("Google Calendar was not connected (you didn't grant access). Ask me again any time.");
  });

  it("names the fix when the Calendar API is not enabled on the server's Google project", async () => {
    const s = await setup();
    s.google.state.primaryDisabled = true;
    await s.send(PHONES.matt, "connect google calendar");
    const res = await consent(s.get, /https:\S+/.exec(s.to(PHONES.matt).at(-1)!)![0]);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("the Google Calendar API is not enabled on this server&#39;s Google project. Ask Jarvis to try again.");
    expect(s.calendar.connection(s.matt.id)).toBeUndefined();
    expect(s.notified.at(-1)!.text).toBe("Google Calendar was not connected: the Google Calendar API is not enabled on this server's Google project. Ask me again any time.");
  });

  it("a link from the account page leads back to it after Google, whatever the outcome", async () => {
    const s = await setup();
    const back = (html: string) => /<a class="btn" href="([^"]*)">Back to your account<\/a>/.exec(html)?.[1];
    const denied = await consent(s.get, s.calendar.connectLink(s.matt.id, { returnTo: "https://dash.example/" }), "");
    expect(back(await denied.text())).toBe("https://dash.example/");
    const ok = await consent(s.get, s.calendar.connectLink(s.matt.id, { returnTo: "https://dash.example/?a=1&b=<x>" }));
    const html = await ok.text();
    expect(html).toContain("Connected.");
    expect(html).not.toContain("You can close this tab.");
    expect(back(html)).toBe("https://dash.example/?a=1&amp;b=%3Cx%3E");
    // Texted links have no page to go back to; a stored return_to that is not http(s) is dropped.
    const plain = await consent(s.get, s.calendar.connectLink(s.matt.id));
    expect(back(await plain.text())).toBeUndefined();
    const sneaky = await consent(s.get, s.calendar.connectLink(s.matt.id, { returnTo: "javascript:alert(1)" }));
    expect(await sneaky.text()).not.toContain("Back to your account");
  });

  it("an expired link goes nowhere", async () => {
    const s = await setup();
    const link = s.calendar.connectLink(s.matt.id);
    const row = s.db.googleLink(link.slice(link.lastIndexOf("/") + 1))!;
    expect(Date.parse(row.expires_at) - NOW.getTime()).toBe(LINK_TTL_MS);
    s.db.raw.prepare("update google_links set expires_at = ?").run(new Date(NOW.getTime() - 1).toISOString());
    const res = await s.get(link.slice(PUBLIC_URL.length));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("This link has expired.");
  });

  it("reads merge Google's events with AgentSign's, and friends' agents see Google busy times without titles", async () => {
    const s = await setup();
    const yadu = await s.onboard("yadu", 1);
    s.befriend(s.matt.id, yadu.id);
    await s.send(PHONES.matt, "connect google calendar");
    await consent(s.get, /https:\S+/.exec(s.to(PHONES.matt).at(-1)!)![0]);
    s.google.state.events.push(
      { id: "dentist", summary: "Dentist", start: { dateTime: "2026-10-11T09:00:00-07:00" }, end: { dateTime: "2026-10-11T10:00:00-07:00" } },
      {
        id: "ooo", summary: "Conference", start: { date: "2026-10-11" }, end: { date: "2026-10-12" },
        location: "167 Rue de la Roquette, 75011 Paris, France", description: "Stay at <b>Chez Mia</b>.<br>Check-in after 3pm.&nbsp;Code 4471", htmlLink: "https://www.google.com/calendar/event?eid=ooo",
        organizer: { email: "unknownorganizer@calendar.google.com", displayName: "Google Calendar" },
        attendees: [{ email: "matt@gmail.com", self: true, responseStatus: "accepted" }, { email: "mia@chezmia.fr", displayName: "Mia" }],
      },
      { id: "fyi", summary: "Optional standup", transparency: "transparent", start: { dateTime: "2026-10-11T11:00:00-07:00" }, end: { dateTime: "2026-10-11T11:30:00-07:00" } },
      { id: "no", summary: "Declined", attendees: [{ self: true, responseStatus: "declined" }], start: { dateTime: "2026-10-11T15:00:00-07:00" }, end: { dateTime: "2026-10-11T16:00:00-07:00" } },
      { id: "gone", summary: "Cancelled", status: "cancelled", start: { dateTime: "2026-10-11T16:00:00-07:00" }, end: { dateTime: "2026-10-11T17:00:00-07:00" } },
    );
    s.db.addEvent(s.matt.id, "Old AgentSign lunch", "2026-10-11T12:00", "2026-10-11T12:30", "@yadu", null);
    const read = await s.calendar.events(s.matt.id, "2026-10-11T00:00", "2026-10-12T00:00");
    expect(read.warning).toBeUndefined();
    expect(read.events).toEqual([
      {
        title: "Conference", start: "2026-10-11T00:00", end: "2026-10-12T00:00", allDay: true, source: "google",
        location: "167 Rue de la Roquette, 75011 Paris, France", notes: "Stay at Chez Mia.\nCheck-in after 3pm. Code 4471", organizer: "Google Calendar", attendees: ["Mia"], myStatus: "accepted",
        link: "https://www.google.com/calendar/event?eid=ooo",
      },
      { title: "Dentist", start: "2026-10-11T09:00", end: "2026-10-11T10:00", source: "google" },
      { title: "Optional standup", start: "2026-10-11T11:00", end: "2026-10-11T11:30", source: "google" },
      { title: "Old AgentSign lunch", start: "2026-10-11T12:00", end: "2026-10-11T12:30", with: "@yadu", source: "agentsign" },
      { title: "Declined", start: "2026-10-11T15:00", end: "2026-10-11T16:00", source: "google", myStatus: "declined" },
    ]);
    // Matt's agent, asked by Yadu's, shares busy intervals only: no all-day, no "free", no declined.
    s.script((req) => {
      expect(req.tools.map((t) => t.name)).toEqual(["get_free_busy"]);
      return call("get_free_busy", { from: "2026-10-11", to: "2026-10-11" });
    }, (req) => {
      const busy = JSON.parse(String(req.messages.at(-1)!.content)) as { busy: unknown; warning?: string };
      expect(busy.warning).toBeUndefined();
      expect(busy.busy).toEqual([
        { start: "2026-10-11T09:00", end: "2026-10-11T10:00" },
        { start: "2026-10-11T12:00", end: "2026-10-11T12:30" },
      ]);
      expect(JSON.stringify(req.messages)).not.toContain("Dentist");
      expect(JSON.stringify(req.messages)).not.toContain("Roquette");
      return say("Free before 9, 10 to 12, after 12:30.");
    });
    const { runPeerTurn } = await import("../src/agent/agent.js");
    expect(await runPeerTurn(s.app.deps, s.matt, "@yadu", "When is Matt free on Oct 11?")).toBe("Free before 9, 10 to 12, after 12:30.");
    // The engine's get_calendar says which source each event came from.
    s.script(
      delegate("what's on my calendar tomorrow"),
      call("get_calendar", { from: "2026-10-11", to: "2026-10-11" }),
      (req) => {
        const out = JSON.parse(String(req.messages.at(-1)!.content)) as { google: string; events: { title: string; source: string; location?: string; notes?: string; myStatus?: string }[] };
        expect(out.google).toBe("connected as matt@gmail.com");
        expect(out.events.map((e) => `${e.source}:${e.title}`)).toContain("google:Dentist");
        // The engine sees Google's details, so a call or a text can answer "where am I staying?".
        expect(out.events.find((e) => e.title === "Conference")).toMatchObject({ location: "167 Rue de la Roquette, 75011 Paris, France", notes: "Stay at Chez Mia.\nCheck-in after 3pm. Code 4471", myStatus: "accepted" });
        return say("Dentist at 9, lunch with Yadu at noon.");
      },
      say("Dentist at 9, lunch with Yadu at noon."),
    );
    await s.send(PHONES.matt, "what's tomorrow look like");
    expect(s.to(PHONES.matt).at(-1)).toBe("Dentist at 9, lunch with Yadu at noon.");
  });

  it("falls back to AgentSign's own events with a warning when Google is down", async () => {
    const s = await setup();
    await s.send(PHONES.matt, "connect google calendar");
    await consent(s.get, /https:\S+/.exec(s.to(PHONES.matt).at(-1)!)![0]);
    s.db.addEvent(s.matt.id, "Lunch", "2026-10-11T12:00", "2026-10-11T12:30", null, null);
    s.google.state.listFails = true;
    const read = await s.calendar.events(s.matt.id, "2026-10-11T00:00", "2026-10-12T00:00");
    expect(read.events.map((e) => e.title)).toEqual(["Lunch"]);
    expect(read.warning).toBe("Google answered 500, so only AgentSign's own events are listed; Google Calendar events are missing.");
  });

  it("an event approved on the Ledger lands on Google, once, with the same local time", async () => {
    const s = await setup();
    await s.send(PHONES.matt, "connect google calendar");
    await consent(s.get, /https:\S+/.exec(s.to(PHONES.matt).at(-1)!)![0]);
    s.script(
      delegate("dentist tomorrow 9 to 10"),
      call("propose_action", { code: "CAL", fields: [{ label: "Title", value: "Dentist" }, { label: "When", value: "2026-10-11 09:00-10:00" }] }),
      say("Dentist tomorrow at 9 is ready."),
    );
    await s.send(PHONES.matt, "put the dentist on my calendar tomorrow 9 to 10");
    expect(report(s)).toContain("Added 'Dentist' Sun Oct 11 09:00-10:00 to your calendar. It's on your Google Calendar too. Done at once:");
    const [event] = s.google.state.events;
    expect(event).toMatchObject({ summary: "Dentist", start: { dateTime: "2026-10-11T09:00:00", timeZone: "America/Los_Angeles" }, end: { dateTime: "2026-10-11T10:00:00", timeZone: "America/Los_Angeles" } });
    expect(event!.id).toMatch(/^agentsign[0-9a-v]{8}\d+$/);
    expect(s.db.events(s.matt.id, "2026-10-11T00:00", "2026-10-12T00:00")[0]!.google_event_id).toBe(event!.id);
    // Reading back shows it once, from Google.
    const read = await s.calendar.events(s.matt.id, "2026-10-11T00:00", "2026-10-12T00:00");
    expect(read.events).toEqual([{ title: "Dentist", start: "2026-10-11T09:00", end: "2026-10-11T10:00", source: "google", notes: "Added by Jarvis on AgentSign, approved on the owner's Ledger." }]);
    // A retry of the same row is a no-op on Google's side (409) and still marks it.
    s.db.raw.prepare("update events set google_event_id = null").run();
    expect(await s.calendar.afterEvent(s.matt.id)).toBe("It's on your Google Calendar too.");
    expect(s.google.state.events).toHaveLength(1);
  });

  it("a Google outage during the push keeps the event on AgentSign and says so; the next event retries it", async () => {
    const s = await setup();
    await s.send(PHONES.matt, "connect google calendar");
    await consent(s.get, /https:\S+/.exec(s.to(PHONES.matt).at(-1)!)![0]);
    s.google.state.insertFails = true;
    s.script(delegate("lunch"), call("propose_action", { code: "CAL", fields: [{ label: "Title", value: "Lunch" }, { label: "When", value: "2026-10-11 12:00-13:00" }] }), say("Lunch is ready."));
    await s.send(PHONES.matt, "lunch tomorrow at noon");
    expect(report(s)).toContain("Added 'Lunch' Sun Oct 11 12:00-13:00 to your calendar. I couldn't add it to your Google Calendar (Google answered 503); I'll try again with your next event. Done at once:");
    expect(s.db.events(s.matt.id, "2026-10-11T00:00", "2026-10-12T00:00")).toHaveLength(1);
    s.google.state.insertFails = false;
    s.script(delegate("dinner"), call("propose_action", { code: "CAL", fields: [{ label: "Title", value: "Dinner" }, { label: "When", value: "2026-10-11 19:00-20:00" }] }), say("Dinner is ready."));
    await s.send(PHONES.matt, "dinner tomorrow at 7");
    expect(report(s)).toContain("Added 'Dinner' Sun Oct 11 19:00-20:00 to your calendar. It's on your Google Calendar too. Done at once:");
    expect(s.google.state.events.map((e) => e.summary)).toEqual(["Lunch", "Dinner"]);
  });

  it("connecting copies upcoming AgentSign events over, not past ones", async () => {
    const s = await setup();
    s.db.addEvent(s.matt.id, "Yesterday", "2026-10-09T12:00", "2026-10-09T13:00", null, null);
    s.db.addEvent(s.matt.id, "Next week", "2026-10-17T12:00", "2026-10-17T13:00", null, null);
    await s.send(PHONES.matt, "connect google calendar");
    await consent(s.get, /https:\S+/.exec(s.to(PHONES.matt).at(-1)!)![0]);
    expect(s.google.state.events.map((e) => e.summary)).toEqual(["Next week"]);
    expect(s.notified.at(-1)!.text).toContain("I copied 1 upcoming AgentSign event over.");
  });

  it("a meeting with a friend avoids their Google busy times and lands on their Google Calendar once they say yes", async () => {
    const s = await setup();
    const yadu = await s.onboard("yadu", 1);
    s.befriend(s.matt.id, yadu.id);
    s.google.state.email = "yadu@gmail.com";
    await s.send(PHONES.yadu, "connect google calendar");
    await consent(s.get, /https:\S+/.exec(s.to(PHONES.yadu).at(-1)!)![0]);
    const day = addMinutes(localNow(), 24 * 60).slice(0, 10);
    const stamp = (clock: string) => toInstant(`${day}T${clock}`).toISOString();
    s.google.state.events.push({ id: "g1", summary: "Dentist (secret)", start: { dateTime: stamp("12:00") }, end: { dateTime: stamp("12:30") } });
    s.script(
      delegate("lunch with yadu tomorrow at noon"),
      call("propose_meeting", { tag: "@yadu", title: "Lunch", from: `${day} 12:00`, to: `${day} 13:30`, preferred: `${day} 12:00` }),
      say("Asked Yadu about lunch tomorrow at 12:30."),
    );
    await s.send(PHONES.matt, "set up lunch with yadu tomorrow at noon");
    const when = formatWhen(`${day}T12:30`, `${day}T13:00`);
    expect(s.to(PHONES.yadu).at(-1)).toBe(`@matt would like to meet: 'Lunch' ${when}. Any time ${formatWhen(`${day}T12:00`, `${day}T13:30`)} works for Matt. Reply 'yes' and it goes on both calendars, or name another time.`);
    expect(s.db.peerThread("@matt", "@yadu").map((m) => m.text).join(" ")).not.toMatch(/dentist/i);
    await s.send(PHONES.yadu, "yes");
    expect(s.to(PHONES.yadu).at(-1)).toBe(`Done: 'Lunch' with @matt, ${when}, is on both calendars. It's on your Google Calendar too.`);
    expect(s.to(PHONES.matt).at(-1)).toBe(`@yadu said yes: 'Lunch' with @yadu, ${when}, is on both calendars.`);
    expect(s.google.state.events.filter((e) => e.id !== "g1")).toEqual([
      expect.objectContaining({ summary: "Lunch with @matt", description: expect.stringContaining("Meeting with @matt"), start: { dateTime: `${day}T12:30:00`, timeZone: "America/Los_Angeles" } }),
    ]);
    expect(s.db.events(yadu.id, `${day}T00:00`, `${day}T24:00`)).toEqual([expect.objectContaining({ title: "Lunch", with_tag: "@matt", google_event_id: expect.stringMatching(/^agentsign/) })]);
  });

  it("a revoked connection is dropped and the owner is told", async () => {
    const s = await setup();
    await s.send(PHONES.matt, "connect google calendar");
    await consent(s.get, /https:\S+/.exec(s.to(PHONES.matt).at(-1)!)![0]);
    s.db.raw.prepare("update google_calendars set expires_at = 0").run(); // the access token is stale, so the next read refreshes
    s.google.state.refreshToken = undefined;
    const read = await s.calendar.events(s.matt.id, "2026-10-11T00:00", "2026-10-12T00:00");
    expect(read.warning).toContain("Google no longer allows access");
    expect(s.calendar.connection(s.matt.id)).toBeUndefined();
    expect(s.notified.at(-1)!.text).toBe("Google Calendar (matt@gmail.com) no longer allows access, so I disconnected it. Ask me to connect it again any time.");
  });

  it("disconnects on request and refuses a second connection while one exists", async () => {
    const s = await setup();
    await s.send(PHONES.matt, "connect google calendar");
    await consent(s.get, /https:\S+/.exec(s.to(PHONES.matt).at(-1)!)![0]);
    await s.send(PHONES.matt, "connect google calendar");
    expect(s.to(PHONES.matt).at(-1)).toBe("Your Google Calendar is already connected as matt@gmail.com. Say 'disconnect google calendar' first if you want a different account.");
    s.script(delegate("disconnect Google Calendar"), call("disconnect_google_calendar", {}), say("Disconnected."), say("Google Calendar is disconnected."));
    await s.send(PHONES.matt, "disconnect google calendar");
    expect(s.to(PHONES.matt).at(-1)).toBe("Google Calendar is disconnected.");
    expect(s.calendar.connection(s.matt.id)).toBeUndefined();
    expect(s.google.state.requests.some((r) => r.url.startsWith("https://oauth2.googleapis.com/revoke?token=refresh-1"))).toBe(true);
    expect(s.requests.at(-2)!.messages.at(-1)!.content).toBe("Disconnected Google Calendar (matt@gmail.com). Events already on it stay there; new ones will only be on AgentSign.");
  });

  it("without Google credentials the tool explains and the shortcut stays out of the way", async () => {
    const h = harness(1);
    const matt = await h.onboard("matt", 0);
    h.script(delegate("connect Google Calendar"), (req) => {
      expect(req.system).toContain("Google Calendar: not available on this server.");
      return call("connect_google_calendar", {});
    }, say("Not available."), say("Google Calendar isn't available here, I'm afraid."));
    await h.send(PHONES.matt, "connect my google calendar");
    expect(h.to(PHONES.matt).at(-1)).toBe("Google Calendar isn't available here, I'm afraid.");
    expect(h.requests.at(-2)!.messages.at(-1)!.content).toBe("Error: Google Calendar is not set up on this server, so it cannot be connected. Tell the owner it is not available here.");
    expect(h.db.googleCalendar(matt.id)).toBeUndefined();
  });

  it("converts local stamps to instants across daylight saving time", () => {
    expect(toInstant("2026-10-11T12:00").toISOString()).toBe("2026-10-11T19:00:00.000Z"); // PDT
    expect(toInstant("2026-12-11T12:00").toISOString()).toBe("2026-12-11T20:00:00.000Z"); // PST
    expect(toLocal(new Date("2026-11-01T08:30:00Z"))).toBe("2026-11-01T01:30"); // the morning the clocks go back
    expect(toLocal(toInstant("2026-03-08T03:30"))).toBe("2026-03-08T03:30");
  });
});
