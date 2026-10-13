/** The account page's API: sign-in with the Ledger (an ethers Wallet), sessions, CSRF, the MeView, and every change over real HTTP. */
import { Wallet } from "ethers";
import { afterEach, describe, expect, it } from "vitest";
import { newActionId } from "../src/actions.js";
import { createApprovals } from "../src/approvals.js";
import { createCalendar } from "../src/calendar/google.js";
import { openDb } from "../src/db.js";
import { askEthApp, type EthRequest } from "../src/device/eth-tx.js";
import { createRemoteDeviceManager } from "../src/device/remote.js";
import { baseMoney, type Money } from "../src/money.js";
import { createPhoneLinks } from "../src/phone.js";
import { ACTION_TITLES, type Action } from "../src/types.js";
import type { MeView } from "../src/web/account-api.js";
import { type AccountApiDeps, createAccountApi } from "../src/web/account.js";
import { startWebServer, type WebServer } from "../src/web/server.js";
import { fakeChannel, fakeEthApp, stubChain } from "./helpers.js";

const PUBLIC_URL = "https://agent.example";
const DASHBOARD = "https://dash.example";
const MATT_PHONE = "+14155550001";
const matt = new Wallet(Wallet.createRandom().privateKey);
const stranger = new Wallet(Wallet.createRandom().privateKey);
const addr = (w: Wallet) => w.address.toLowerCase();
const cal = (): Action => ({ code: "CAL", id: newActionId(), fields: [{ label: "Title", value: "Lunch" }, { label: "When", value: "Sun Oct 11 12:00-12:30" }] });

let web: WebServer | undefined;
afterEach(async () => {
  await web?.close();
  web = undefined;
});

type Res = { status: number; headers: Headers; body: Record<string, unknown> };

async function setup(extra: Partial<AccountApiDeps> = {}) {
  const db = openDb(":memory:");
  const account = db.createAccount("@matt", addr(matt), MATT_PHONE, 0);
  const remote = createRemoteDeviceManager({ db, publicUrl: `${PUBLIC_URL}/` });
  const ch = fakeChannel();
  const money = baseMoney(stubChain({ [addr(matt)]: 10n ** 16n }).chain);
  const approvals = createApprovals({ db, deviceManager: remote, channel: ch.channel, titles: ACTION_TITLES, money, signTimeoutMs: 5000 });
  const revoked: string[] = [];
  const calendar = createCalendar({
    db,
    google: { clientId: "id", clientSecret: "secret", publicUrl: PUBLIC_URL },
    fetch: async (input) => (revoked.push(String(input)), new Response("{}", { status: 200 })),
  });
  const phone = createPhoneLinks({ db, number: "+19406447419" });
  const logs: string[] = [];
  const api = createAccountApi({
    db, approvals, calendar, money, phone,
    purchases: { limitCents: 2000, shipsTo: "Matt's address" },
    food: { limitCents: 4000, provider: "DoorDash" },
    channel: { kind: "iMessage", jarvis: "+14155550199" },
    publicUrl: `${PUBLIC_URL}/`,
    allowedOrigins: [`${DASHBOARD}/`],
    log: (l) => logs.push(l),
    ...extra,
  });
  web = await startWebServer({ db, remote, port: 0, routes: api.routes });
  const base = `http://127.0.0.1:${web.port}`;
  const http = async (path: string, init?: RequestInit): Promise<Res> => {
    const res = await fetch(base + path, init);
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: (res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : { text }) as Record<string, unknown> };
  };
  const post = (path: string, body: unknown = {}, o: { cookie?: string; origin?: string; type?: string } = {}) =>
    http(path, {
      method: "POST",
      headers: { "content-type": o.type ?? "application/json", ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.origin ? { origin: o.origin } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const get = (path: string, cookie?: string) => http(path, cookie ? { headers: { cookie } } : undefined);
  /** The challenge, signed by `wallet` as the Ethereum app signs a personal message. */
  const signIn = async (wallet = matt, address = wallet.address) => {
    const c = (await post("/api/login/challenge")).body as { message: string; nonce: string };
    return { res: await post("/api/login", { nonce: c.nonce, address, signature: await wallet.signMessage(c.message) }), nonce: c.nonce, message: c.message };
  };
  const login = async () => {
    const { res } = await signIn();
    expect(res.status).toBe(200);
    return res.headers.get("set-cookie")!.split(";")[0]!;
  };
  /** The browser on the approval page: load the job, have the "Ledger" sign it, post the answer. */
  const signInBrowser = async (path: string, wallet: Wallet) => {
    const job = (await get(`${path}/job`)).body as unknown as { request: EthRequest };
    return post(`${path}/result`, await askEthApp(fakeEthApp(wallet), job.request));
  };
  return { db, account, approvals, calendar, phone, ch, logs, revoked, http, post, get, signIn, login, signInBrowser };
}

describe("signing in with the Ledger", () => {
  it("challenge, then a signed login sets an HttpOnly session cookie and returns the tag", async () => {
    const s = await setup();
    const c = await s.post("/api/login/challenge");
    expect(c.status).toBe(200);
    expect(c.headers.get("cache-control")).toBe("no-store");
    expect(c.headers.get("content-security-policy")).toContain("default-src 'none'");
    const { message, nonce, expiresAt } = c.body as { message: string; nonce: string; expiresAt: number };
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(expiresAt - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(message).toBe(`AgentSign\nSign in to your account\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString().slice(0, 16)}Z`);
    const res = await s.post("/api/login", { nonce, address: matt.address, signature: await matt.signMessage(message) });
    expect([res.status, res.body]).toEqual([200, { ok: true, tag: "@matt" }]);
    expect(res.headers.get("set-cookie")).toMatch(/^agentsign_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure$/);
    expect(s.logs).toContain(`account: @matt signed in from ${addr(matt).slice(0, 6)}..${addr(matt).slice(-4)}`);
    // Only the hash is stored.
    const token = /=([0-9a-f]{64})/.exec(res.headers.get("set-cookie")!)![1]!;
    const rows = s.db.raw.prepare("select token_hash from sessions").all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(token);
  });

  it("refuses a wrong signature, an address without an account, and a reused nonce", async () => {
    const s = await setup();
    // Signed by someone else but claiming Matt's address.
    const c = (await s.post("/api/login/challenge")).body as { message: string; nonce: string };
    const wrong = await s.post("/api/login", { nonce: c.nonce, address: matt.address, signature: await stranger.signMessage(c.message) });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    // The nonce was consumed by the failed try.
    const retry = await s.post("/api/login", { nonce: c.nonce, address: matt.address, signature: await matt.signMessage(c.message) });
    expect([retry.status, retry.body]).toEqual([401, { ok: false, error: "That sign-in request expired. Try again." }]);
    const garbage = (await s.post("/api/login/challenge")).body as { nonce: string };
    expect((await s.post("/api/login", { nonce: garbage.nonce, address: matt.address, signature: "0x1234" })).status).toBe(401);
    const nobody = await s.signIn(stranger);
    expect([nobody.res.status, nobody.res.body]).toEqual([404, { ok: false, error: "No account is bound to this Ledger yet. Text Jarvis and it will set one up." }]);
    const ok = await s.signIn();
    expect(ok.res.status).toBe(200);
    const again = await s.post("/api/login", { nonce: ok.nonce, address: matt.address, signature: await matt.signMessage(ok.message) });
    expect(again.status).toBe(401);
    expect((await s.post("/api/login", { nonce: "x" })).status).toBe(400);
  });

  it("logout deletes the session and clears the cookie", async () => {
    const s = await setup();
    const cookie = await s.login();
    expect((await s.get("/api/me", cookie)).status).toBe(200);
    const out = await s.post("/api/logout", {}, { cookie });
    expect([out.status, out.body]).toEqual([200, { ok: true }]);
    expect(out.headers.get("set-cookie")).toMatch(/^agentsign_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
    expect(s.logs).toContain("account: @matt signed out");
    const me = await s.get("/api/me", cookie);
    expect([me.status, me.body]).toEqual([401, { ok: false, error: "Sign in with your Ledger first." }]);
  });

  it("sessions slide: a day in, a request pushes the expiry out again; a week without one ends it", async () => {
    let clock = new Date("2026-10-12T19:00:00Z");
    const s = await setup({ now: () => clock });
    const cookie = await s.login();
    const expiry = () => (s.db.raw.prepare("select expires_at from sessions").get() as { expires_at: string }).expires_at;
    expect(expiry()).toBe("2026-10-19T19:00:00.000Z");
    clock = new Date("2026-10-12T23:00:00Z");
    expect((await s.get("/api/me", cookie)).headers.get("set-cookie")).toBeNull();
    expect(expiry()).toBe("2026-10-19T19:00:00.000Z");
    clock = new Date("2026-10-14T19:00:00Z");
    const later = await s.get("/api/me", cookie);
    expect(later.status).toBe(200);
    expect(later.headers.get("set-cookie")).toBe(`${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure`);
    expect(expiry()).toBe("2026-10-21T19:00:00.000Z");
    clock = new Date("2026-10-21T19:00:01Z");
    const gone = await s.get("/api/me", cookie);
    expect(gone.status).toBe(401);
    expect(gone.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});

describe("the account view", () => {
  it("needs a session, then shows the whole account", async () => {
    const s = await setup();
    expect((await s.get("/api/me")).status).toBe(401);
    expect((await s.get("/api/me", `agentsign_session=${"ab".repeat(32)}`)).status).toBe(401);
    const yadu = s.db.createAccount("@yadu", "0x" + "1".repeat(40), "+14155550003", 0);
    const gabe = s.db.createAccount("@gabe", "0x" + "2".repeat(40), "+14155550002", 0);
    const zed = s.db.createAccount("@zed", "0x" + "3".repeat(40), "+14155550004", 0);
    s.db.requestFriend(s.account.id, yadu.id);
    s.db.requestFriend(gabe.id, s.account.id);
    s.db.requestFriend(zed.id, s.account.id);
    s.db.acceptFriend(zed.id, s.account.id);
    const pay: Action = { code: "PAY", id: newActionId(), fields: [{ label: "To", value: "@yadu" }, { label: "Amount", value: "$5.00" }, { label: "ETH", value: "0.00125" }, { label: "Address", value: "0x" + "1".repeat(40) }] };
    s.db.insertAction(s.account.id, pay);
    s.db.setActionTxHash(pay.id, "0x" + "ab".repeat(32));
    s.db.setActionStatus(pay.id, "executed");
    s.db.setDeliveryAddress(s.account.id, "1 Market St, San Francisco");
    const cookie = await s.login();
    const res = await s.get("/api/me", cookie);
    expect(res.status).toBe(200);
    const me = res.body as unknown as MeView;
    expect(me.tag).toBe("@matt");
    expect(me.address).toBe(matt.address);
    expect(me.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
    expect(me.channel).toEqual({ kind: "iMessage", handle: MATT_PHONE, jarvis: "+14155550199" });
    expect(me.balance).toBe("0.01 ETH ($40.00) on Base");
    expect(me.explorerUrl).toBe(`https://basescan.org/address/${matt.address}`);
    expect(me.policy).toEqual({ preset: "standard", gates: { calendar: false, meetings: false, friends: true }, description: expect.stringMatching(/^standard: /) });
    expect(me.connections.map((c) => [c.id, c.name, c.status])).toEqual([
      ["chat", "iMessage", "connected"],
      ["ledger", "Ledger", "connected"],
      ["google", "Google Calendar", "available"],
      ["phone", "Phone calls", "connected"],
      ["amazon", "Amazon", "connected"],
      ["doordash", "DoorDash", "connected"],
    ]);
    const by = Object.fromEntries(me.connections.map((c) => [c.id, c]));
    expect(by.chat).toMatchObject({ summary: "Text Jarvis at +14155550199.", detail: MATT_PHONE, actions: [] });
    expect(by.ledger).toMatchObject({ detail: matt.address });
    expect(by.google!.actions).toEqual([{ kind: "connect-google" }]);
    // The number Matt texts from counts for calls but cannot be unlinked here.
    expect(by.phone).toMatchObject({ summary: "Call Jarvis at +19406447419 from a linked number.", detail: MATT_PHONE, actions: [{ kind: "link-phone" }] });
    // One saved address for both stores.
    expect(by.amazon).toMatchObject({ summary: "Pay in USDC on Base, up to $20.00 per order, shipped to your delivery address.", detail: "1 Market St, San Francisco", actions: [] });
    expect(by.doordash).toMatchObject({ summary: "Order food, up to $40.00 per order, paid in USDC on Base.", detail: "1 Market St, San Francisco" });
    s.db.setDeliveryAddress(s.account.id, null);
    const bare = Object.fromEntries(((await s.get("/api/me", cookie)).body as unknown as MeView).connections.map((c) => [c.id, c]));
    expect([bare.amazon!.summary, bare.amazon!.detail, bare.doordash!.summary, bare.doordash!.detail]).toEqual([
      "Pay in USDC on Base, up to $20.00 per order, shipped to your delivery address. Tell Jarvis your address first.",
      undefined,
      "Order food, up to $40.00 per order, paid in USDC on Base. Tell Jarvis your address first.",
      undefined,
    ]);
    expect(me.friends).toEqual([
      { tag: "@gabe", status: "pending" },
      { tag: "@yadu", status: "requested" },
      { tag: "@zed", status: "accepted" },
    ]);
    expect(me.activity).toEqual([
      { id: pay.id, code: "PAY", title: "Send money", summary: "To @yadu · Amount $5.00 · ETH 0.00125", status: "executed", at: expect.stringMatching(/Z$/), link: `https://basescan.org/tx/0x${"ab".repeat(32)}` },
    ]);
    expect(me.pending).toBeUndefined();
  });

  it("servers without Google, calls, Amazon or food say so; Telegram names the username; a failing balance is left out", async () => {
    const money: Pick<Money, "mode" | "balanceText"> = { mode: "eth", balanceText: () => Promise.reject(new Error("Base is down")) };
    const s = await setup({
      money, phone: undefined, purchases: undefined, food: undefined, channel: { kind: "Telegram", jarvis: "@JarvisBot" },
      calendar: { available: false, connection: () => undefined, connectLink: () => "", disconnect: async () => false },
    });
    s.db.raw.prepare("update handles set handle = 'tg:4242' where account_id = ?").run(s.account.id);
    s.db.setProfile(s.account.id, "mokner", "Matt");
    const cookie = await s.login();
    const me = (await s.get("/api/me", cookie)).body as unknown as MeView;
    expect(me.balance).toBeUndefined();
    expect(me.displayName).toBe("Matt");
    expect(me.channel).toEqual({ kind: "Telegram", handle: "tg:4242", jarvis: "@JarvisBot" });
    expect(me.connections.map((c) => [c.id, c.status, c.summary, c.detail])).toEqual([
      ["chat", "connected", "Open @JarvisBot on Telegram to talk to Jarvis.", "@mokner"],
      ["ledger", "connected", "Signs every payment and anything your policy sends to it.", matt.address],
      ["google", "unavailable", "Not set up on this server.", undefined],
      ["phone", "unavailable", "Calling Jarvis is not set up on this server.", undefined],
      ["amazon", "unavailable", expect.any(String), undefined],
      ["doordash", "unavailable", expect.any(String), undefined],
    ]);
    expect((await s.post("/api/google/connect", {}, { cookie })).status).toBe(503);
    expect((await s.post("/api/phone/link", { number: "+14155550102" }, { cookie })).status).toBe(503);
    expect(s.logs.some((l) => l.includes("Base is down"))).toBe(true);
  });
});

describe("posts", () => {
  it("need JSON and an allowed Origin (or none)", async () => {
    const s = await setup();
    const cookie = await s.login();
    expect((await s.post("/api/policy", "preset=strict", { cookie, type: "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await s.post("/api/login/challenge", "{}", { type: "text/plain" })).status).toBe(415);
    const foreign = await s.post("/api/policy", { preset: "strict" }, { cookie, origin: "https://evil.example" });
    expect([foreign.status, foreign.body]).toEqual([403, { ok: false, error: "This page is not allowed to do that." }]);
    expect((await s.post("/api/login/challenge", {}, { origin: "null" })).status).toBe(403);
    expect((await s.post("/api/policy", { preset: "strict" }, { cookie, origin: PUBLIC_URL })).status).toBe(200);
    expect((await s.post("/api/policy", { preset: "relaxed" }, { cookie, origin: DASHBOARD })).status).toBe(200);
    expect((await s.get("/api/policy", cookie)).status).toBe(405);
    expect((await s.post("/api/me", {}, { cookie })).status).toBe(405);
    // Not ours: the server's own 404.
    expect((await s.get("/api/nothing")).status).toBe(404);
  });

  it("google: connect hands out a link that returns to the page's origin; disconnect forgets it", async () => {
    const s = await setup();
    const cookie = await s.login();
    const res = await s.post("/api/google/connect", {}, { cookie, origin: DASHBOARD });
    expect(res.status).toBe(200);
    const url = res.body.url as string;
    expect(url).toMatch(/^https:\/\/agent\.example\/google\/connect\/[0-9a-f]{64}$/);
    expect(s.db.googleLink(url.split("/").pop()!)?.return_to).toBe(`${DASHBOARD}/`);
    // Without an Origin header it goes back to the server's own page.
    const own = (await s.post("/api/google/connect", {}, { cookie })).body.url as string;
    expect(s.db.googleLink(own.split("/").pop()!)?.return_to).toBe(`${PUBLIC_URL}/`);
    expect((await s.post("/api/google/disconnect", {}, { cookie })).status).toBe(404);
    s.db.setGoogleCalendar({ account_id: s.account.id, email: "matt@gmail.com", refresh_token: "r", access_token: null, expires_at: null, calendar_id: "primary", time_zone: null });
    const me = (await s.get("/api/me", cookie)).body as unknown as MeView;
    expect(me.connections.find((c) => c.id === "google")).toMatchObject({ status: "connected", detail: "matt@gmail.com", actions: [{ kind: "disconnect-google" }] });
    expect((await s.post("/api/google/connect", {}, { cookie })).status).toBe(409);
    expect((await s.post("/api/google/disconnect", {}, { cookie })).body).toEqual({ ok: true });
    expect(s.calendar.connection(s.account.id)).toBeUndefined();
    expect(s.revoked.some((u) => u.startsWith("https://oauth2.googleapis.com/revoke"))).toBe(true);
    expect(s.logs).toContain("account: @matt disconnected Google Calendar");
  });

  it("phone: link and unlink numbers for calls; the texting number stays", async () => {
    const s = await setup();
    const cookie = await s.login();
    const linked = await s.post("/api/phone/link", { number: "+1 (415) 555-0102" }, { cookie });
    expect([linked.status, linked.body]).toEqual([200, { ok: true, handle: "+14155550102" }]);
    expect((await s.post("/api/phone/link", { number: "nope" }, { cookie })).status).toBe(400);
    const phone = ((await s.get("/api/me", cookie)).body as unknown as MeView).connections.find((c) => c.id === "phone")!;
    expect(phone).toMatchObject({ status: "connected", detail: `${MATT_PHONE}, +14155550102`, actions: [{ kind: "unlink-phone", handle: "+14155550102", label: "+14155550102" }, { kind: "link-phone" }] });
    expect((await s.post("/api/phone/unlink", { handle: MATT_PHONE }, { cookie })).status).toBe(400);
    expect((await s.post("/api/phone/unlink", { handle: "+14155550102" }, { cookie })).body).toEqual({ ok: true });
    expect(s.phone.numbersOf(s.account.id)).toEqual([MATT_PHONE]);
    expect((await s.post("/api/phone/unlink", { handle: "+14155550102" }, { cookie })).status).toBe(400);
    expect(s.logs).toContain("account: @matt linked +14155550102 for calls");
  });

  it("policy: a preset, then a single flag on top, both show in /api/me", async () => {
    const s = await setup();
    const cookie = await s.login();
    const strict = await s.post("/api/policy", { preset: "strict" }, { cookie });
    expect(strict.body).toMatchObject({ ok: true, policy: { preset: "strict", gates: { calendar: true, meetings: true, friends: true } } });
    const flag = await s.post("/api/policy", { calendar: false }, { cookie });
    expect(flag.body).toMatchObject({ ok: true, policy: { preset: "strict", gates: { calendar: false, meetings: true, friends: true }, description: expect.stringMatching(/^strict with changes: /) } });
    expect(((await s.get("/api/me", cookie)).body as unknown as MeView).policy.gates).toEqual({ calendar: false, meetings: true, friends: true });
    for (const bad of [{}, { preset: "lax" }, { calendar: "no" }, { money: false }, []]) expect((await s.post("/api/policy", bad, { cookie })).status).toBe(400);
  });

  it("delete: texts the owner the approval link, and once the Ledger signs on the page the account and its session are gone", async () => {
    const s = await setup();
    const cookie = await s.login();
    const res = await s.post("/api/delete", {}, { cookie, origin: DASHBOARD });
    expect(res.status).toBe(200);
    const { url, path } = res.body as { url: string; path: string };
    expect(path).toMatch(/^\/sign\/[0-9a-f]{64}$/);
    expect(url).toBe(`${PUBLIC_URL}${path}`);
    expect(s.ch.to(MATT_PHONE)).toEqual([`You asked to delete your account from your AgentSign account page. If that was you, confirm it on your Ledger: ${url}\nIf it wasn't, ignore this and nothing happens.`]);
    const pending = s.db.pendingAction(s.account.id)!;
    expect(pending).toMatchObject({ code: "DEL", fields: [{ label: "Tag", value: "@matt" }, { label: "Address", value: addr(matt) }] });
    const me = (await s.get("/api/me", cookie)).body as unknown as MeView;
    expect(me.pending).toEqual({ code: "DEL", title: "Delete account", summary: "Tag @matt", path, url });
    // Something is waiting now: a second delete is refused.
    const second = await s.post("/api/delete", {}, { cookie });
    expect([second.status, second.body]).toEqual([409, { ok: false, error: "Your Ledger has something else waiting. Approve or reject that first." }]);
    expect((await s.signInBrowser(path, matt)).body).toEqual({ ok: true, status: "signed" });
    await s.approvals.whenIdle();
    expect(s.db.account(s.account.id)).toBeUndefined();
    expect(s.db.action(pending.id)?.status).toBe("executed");
    expect(s.ch.to(MATT_PHONE).at(-1)).toBe("Your account @matt is gone. Message me again any time to start over.");
    const after = await s.get("/api/me", cookie);
    expect(after.status).toBe(401);
    expect(after.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });

  it("delete is refused while another approval waits", async () => {
    const s = await setup();
    const cookie = await s.login();
    s.db.insertAction(s.account.id, cal());
    const res = await s.post("/api/delete", {}, { cookie });
    expect([res.status, res.body]).toEqual([409, { ok: false, error: "Your Ledger has something else waiting. Approve or reject that first." }]);
    expect(s.ch.sent).toHaveLength(0);
  });

  it("delete needs Ethereum mode", async () => {
    const s = await setup({ money: { mode: "agentsign", balanceText: async () => "$250.00 (demo money)" } });
    const cookie = await s.login();
    expect((await s.post("/api/delete", {}, { cookie })).status).toBe(503);
  });
});

describe("sessions in the database", () => {
  it("only unexpired sessions count, purge drops the rest, and deleting the account deletes its sessions", () => {
    const db = openDb(":memory:");
    const a = db.createAccount("@matt", addr(matt), MATT_PHONE, 0);
    const b = db.createAccount("@yadu", addr(stranger), "+14155550003", 0);
    db.insertSession("live", a.id, new Date(Date.now() + 60_000));
    db.insertSession("old", a.id, new Date(Date.now() - 1));
    db.insertSession("other", b.id, new Date(Date.now() + 60_000));
    expect(db.session("live")).toMatchObject({ account_id: a.id });
    expect(db.session("old")).toBeUndefined();
    expect(db.purgeSessions()).toBe(1);
    const later = new Date(Date.now() + 3_600_000);
    db.touchSession("live", later);
    expect(db.session("live")?.expires_at).toBe(later.toISOString());
    db.deleteAccount(a.id);
    expect(db.session("live")).toBeUndefined();
    expect(db.session("other")).toMatchObject({ account_id: b.id });
    expect(db.deleteSessionsOf(b.id)).toBe(1);
    expect(db.deleteSession("other")).toBe(false);
  });

  it("actionsOf lists an account's actions newest first with their stamps", () => {
    const db = openDb(":memory:");
    const a = db.createAccount("@matt", addr(matt), MATT_PHONE, 0);
    const first = cal();
    const second = cal();
    db.insertAction(a.id, first);
    db.insertAction(a.id, second);
    db.setActionStatus(first.id, "rejected");
    const rows = db.actionsOf(a.id);
    expect(rows.map((r) => [r.id, r.status])).toEqual([[second.id, "pending"], [first.id, "rejected"]]);
    expect(rows[0]!.created_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(rows[0]!.resolved_at).toBeNull();
    expect(rows[1]!.resolved_at).toMatch(/Z$/);
    expect(db.actionsOf(a.id, 1)).toHaveLength(1);
  });
});
