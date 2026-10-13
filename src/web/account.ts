/**
 * The account page's API (the contract and the routes are in ./account-api.ts): the owner signs in with their Ledger
 * and sees and changes their account from any browser.
 *
 * Sign-in: POST /api/login/challenge hands out a short message with a single-use nonce (5 minutes, memory only); the
 * Ledger's Ethereum app signs it as a personal message; POST /api/login recovers the signer with ethers and looks the
 * address up as an account's pubkey. Nothing else proves who someone is: no passwords, no email.
 * A session is 32 random bytes in an HttpOnly cookie; the database keeps only its sha256. Sessions last 7 days and
 * slide: once more than a day of that has passed, an authenticated request pushes the expiry (and the cookie) out to
 * 7 days again. Deleting the account deletes its sessions.
 *
 * CSRF: every POST needs a JSON content type (cross-site forms cannot send one without a CORS preflight, which this
 * server never grants) and, when the browser sends an Origin, the origin of PUBLIC_URL or one of DASHBOARD_ORIGINS.
 *
 * What changes money or deletes the account still goes through the Ledger: POST /api/delete only proposes DEL, exactly
 * like the chat does, and answers with the approval page to sign it on.
 */
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getAddress, isAddress, verifyMessage } from "ethers";
import { newActionId } from "../actions.js";
import { type Approvals, PENDING_ERROR } from "../approvals.js";
import type { Calendar } from "../calendar/google.js";
import { txLink } from "../chain.js";
import type { Account, ActionRow, Db } from "../db.js";
import { formatCents } from "../format.js";
import { normalizeHandle } from "../handles.js";
import type { Money } from "../money.js";
import type { PhoneLinks } from "../phone.js";
import { changePolicy, describePolicy, gates, GUARDS, type Guard, isPreset, type Policy, policyOf, type Preset } from "../policy.js";
import { ACTION_TITLES, type Action, type ActionCode } from "../types.js";
import type { Routes } from "../voice/routes.js";
import type { ActivityView, ConnectionAction, ConnectionView, FriendView, LoginChallenge, MeView, PolicyView } from "./account-api.js";
import { SECURITY_HEADERS } from "./headers.js";

export interface AccountApiDeps {
  db: Db;
  approvals: Pick<Approvals, "request" | "link">;
  calendar: Pick<Calendar, "available" | "connection" | "connectLink" | "disconnect">;
  /** balanceText for the Base balance; left out of the view when it takes over 4 s or throws. */
  money: Pick<Money, "mode" | "balanceText">;
  /** Absent: calls are off on this server. */
  phone?: Pick<PhoneLinks, "number" | "link" | "unlink" | "numbersOf">;
  /** Absent: Amazon is off. `shipsTo`: the Amazon account's own address in words; orders ship to the owner's delivery address, so the page does not show it. */
  purchases?: { limitCents: number; shipsTo?: string };
  /** Absent: food is off. */
  food?: { limitCents: number; provider: string };
  /** What the owner talks on, and Jarvis's number or @bot there. */
  channel: { kind: "iMessage" | "Telegram" | "dev"; jarvis?: string; /** The number "Text Jarvis" opens Messages with (E.164). */ text?: string };
  /** The server's own origin (PUBLIC_URL); sign links come from approvals built on it. */
  publicUrl: string;
  /** Extra origins the page may be served from (DASHBOARD_ORIGINS); PUBLIC_URL's origin is always allowed. */
  allowedOrigins?: string[];
  /** Default: publicUrl starts with https. */
  secureCookies?: boolean;
  log?: (line: string) => void;
  now?: () => Date;
}

export const SESSION_COOKIE = "agentsign_session";
const SESSION_MS = 7 * 24 * 3600_000;
const SLIDE_AFTER_MS = 24 * 3600_000;
const NONCE_MS = 5 * 60_000;
/** Outstanding challenges kept at most; the oldest go first. */
const MAX_NONCES = 10_000;
const MAX_BODY = 64 * 1024;
const BALANCE_MS = 4000;
const LINK_WAIT_MS = 5000;

const SIGN_IN_FIRST = "Sign in with your Ledger first.";
const NOT_ALLOWED = "This page is not allowed to do that.";
const BUSY = "Your Ledger has something else waiting. Approve or reject that first.";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const shortAddress = (a: string) => `${a.slice(0, 6)}..${a.slice(-4)}`;
/** SQLite's "YYYY-MM-DD HH:MM:SS" is UTC without a zone; ISO stamps pass through. */
const iso = (stamp: string) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(stamp) ? stamp : `${stamp.replace(" ", "T")}Z`).toISOString();
const checksummed = (pubkey: string) => (isAddress(pubkey) ? getAddress(pubkey) : pubkey);
/** The fields in one line, "To @gabriel · Amount $5.00"; the long address is left out. */
const fieldLine = (row: Pick<ActionRow, "fields">) => row.fields.filter((f) => f.label !== "Address").map((f) => `${f.label} ${f.value}`).join(" · ");
const titleOf = (code: string) => ACTION_TITLES[code as ActionCode] ?? code;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    if ((size += chunk.length) > MAX_BODY) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(raw: string): unknown {
  try {
    return raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

/** "https://x.example/" -> "https://x.example"; throws on something that is not a URL (a config mistake). */
function originOf(url: string, what: string): string {
  try {
    return new URL(url.trim()).origin;
  } catch {
    throw new Error(`${what} has "${url}", which is not a URL`);
  }
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

export function policyView(policy: Policy): PolicyView {
  return { preset: policy.preset, gates: gates(policy), description: describePolicy(policy) };
}

export function createAccountApi(deps: AccountApiDeps): { routes: Routes } {
  const { db, approvals, calendar, money, phone } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const base = deps.publicUrl.trim().replace(/\/+$/, "");
  const ownOrigin = originOf(base, "PUBLIC_URL");
  const origins = new Set([ownOrigin, ...(deps.allowedOrigins ?? []).filter((o) => o.trim()).map((o) => originOf(o, "DASHBOARD_ORIGINS"))]);
  const secure = deps.secureCookies ?? /^https:/i.test(base);
  const nonces = new Map<string, { message: string; expiresAt: number }>();
  const purged = db.purgeSessions(now());
  if (purged) log(`account: dropped ${purged} expired session(s)`);

  const cookie = (value: string, maxAge: number) => `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const sessionCookie = (token: string) => cookie(token, SESSION_MS / 1000);
  const clearCookie = () => cookie("", 0);

  function challenge(): LoginChallenge {
    const t = now().getTime();
    for (const [nonce, c] of nonces) if (c.expiresAt <= t) nonces.delete(nonce);
    while (nonces.size >= MAX_NONCES) nonces.delete(nonces.keys().next().value!);
    const nonce = randomBytes(16).toString("hex");
    const expiresAt = t + NONCE_MS;
    // Short on purpose: the Ethereum app shows it page by page.
    const message = ["AgentSign", "Sign in to your account", `Nonce: ${nonce}`, `Expires: ${new Date(expiresAt).toISOString().slice(0, 16)}Z`].join("\n");
    nonces.set(nonce, { message, expiresAt });
    return { message, nonce, expiresAt };
  }

  /** The Base balance, or undefined when Base is slow or down: the page must never wait on it for long. */
  async function balance(account: Account): Promise<string | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), BALANCE_MS)));
    try {
      return await Promise.race([money.balanceText(account).catch((err: unknown) => void log(`account: balance for ${account.tag} failed: ${(err as Error).message}`)), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  function connections(account: Account): ConnectionView[] {
    const { channel } = deps;
    const handle = db.primaryHandle(account.id) ?? "";
    const tg = /^tg:(\d+)$/.exec(handle);
    const chatName = channel.kind === "dev" ? "Dev channel" : channel.kind;
    const chatSummary = !channel.jarvis ? "Jarvis texts you here." : channel.kind === "Telegram" ? `Open ${channel.jarvis} on Telegram to talk to Jarvis.` : `Text Jarvis at ${channel.jarvis}.`;
    const chat: ConnectionView = {
      id: "chat", name: chatName, status: "connected", summary: chatSummary,
      detail: tg ? (account.username ? `@${account.username}` : `Telegram id ${tg[1]}`) : handle, actions: [],
    };
    const ledger: ConnectionView = { id: "ledger", name: "Ledger", status: "connected", summary: "Signs every payment and anything your policy sends to it.", detail: checksummed(account.pubkey), actions: [] };

    const linked = calendar.connection(account.id);
    const google: ConnectionView = linked
      ? { id: "google", name: "Google Calendar", status: "connected", summary: "Jarvis reads your calendar, friends' agents see busy times, and events you approve land on it.", detail: linked.email, actions: [{ kind: "disconnect-google" }] }
      : calendar.available
        ? { id: "google", name: "Google Calendar", status: "available", summary: "Jarvis reads your calendar, friends' agents see busy times, and events you approve land on it.", actions: [{ kind: "connect-google" }] }
        : { id: "google", name: "Google Calendar", status: "unavailable", summary: "Not set up on this server.", actions: [] };

    let calls: ConnectionView = { id: "phone", name: "Phone calls", status: "unavailable", summary: "Calling Jarvis is not set up on this server.", actions: [] };
    if (phone) {
      const numbers = phone.numbersOf(account.id);
      const summary = phone.number ? `Call Jarvis at ${phone.number} from a linked number.` : "Call Jarvis from a linked number.";
      // The number the owner texts from (iMessage) counts for calls but cannot be unlinked.
      const actions: ConnectionAction[] = numbers.filter((n) => n !== handle).map((n) => ({ kind: "unlink-phone", handle: n, label: n }));
      if (numbers.length < 3) actions.push({ kind: "link-phone" });
      calls = numbers.length
        ? { id: "phone", name: "Phone calls", status: "connected", summary, detail: numbers.join(", "), actions }
        : { id: "phone", name: "Phone calls", status: "available", summary, actions };
    }

    // Both stores use the one saved delivery address, shown as the detail; without it, the summary asks for it.
    const address = account.delivery_address ?? undefined;
    const ask = " Tell Jarvis your address first.";
    let amazon: ConnectionView = { id: "amazon", name: "Amazon", status: "unavailable", summary: "Buying on Amazon is not set up on this server.", actions: [] };
    if (deps.purchases) {
      const summary = `Pay in USDC on Base, up to ${formatCents(deps.purchases.limitCents)} per order, shipped to your delivery address.`;
      amazon = address ? { id: "amazon", name: "Amazon", status: "connected", summary, detail: address, actions: [] } : { id: "amazon", name: "Amazon", status: "connected", summary: `${summary}${ask}`, actions: [] };
    }

    let doordash: ConnectionView = { id: "doordash", name: "DoorDash", status: "unavailable", summary: "Ordering food is not set up on this server.", actions: [] };
    if (deps.food) {
      const summary = `Order food, up to ${formatCents(deps.food.limitCents)} per order, paid in USDC on Base.`;
      doordash = address ? { id: "doordash", name: "DoorDash", status: "connected", summary, detail: address, actions: [] } : { id: "doordash", name: "DoorDash", status: "connected", summary: `${summary}${ask}`, actions: [] };
    }
    return [chat, ledger, google, calls, amazon, doordash];
  }

  async function me(account: Account): Promise<MeView> {
    const address = checksummed(account.pubkey);
    const friends: FriendView[] = db.friendsOf(account.id).map((f) => ({
      tag: f.tag,
      status: f.status === "accepted" ? "accepted" : f.requested_by === f.id ? "pending" : "requested",
    }));
    const activity: ActivityView[] = db.actionsOf(account.id, 50).map((r) => ({
      id: r.id, code: r.code, title: titleOf(r.code), summary: fieldLine(r), status: r.status, at: iso(r.created_at),
      ...(r.tx_hash ? { link: txLink(r.tx_hash) } : {}),
    }));
    const waiting = db.pendingAction(account.id);
    const url = waiting ? approvals.link(account.id) : undefined;
    const path = url ? /^\/sign\/[0-9a-f]{64}$/.exec(new URL(url).pathname)?.[0] : undefined;
    const bal = await balance(account);
    return {
      tag: account.tag,
      address,
      createdAt: iso(account.created_at),
      ...(account.display_name ? { displayName: account.display_name } : {}),
      channel: { kind: deps.channel.kind, handle: db.primaryHandle(account.id) ?? "", ...(deps.channel.jarvis ? { jarvis: deps.channel.jarvis } : {}), ...(deps.channel.text ? { text: deps.channel.text } : {}) },
      ...(bal ? { balance: bal } : {}),
      explorerUrl: `https://basescan.org/address/${address}`,
      policy: policyView(policyOf(account)),
      connections: connections(account),
      friends,
      activity,
      ...(waiting ? { pending: { code: waiting.code, title: titleOf(waiting.code), summary: fieldLine(waiting), ...(path ? { path } : {}), ...(url ? { url } : {}) } } : {}),
    };
  }

  /** A PolicyChange from the page, or the reason it is not one. */
  function parsePolicyChange(body: unknown): ({ preset?: Preset } & Partial<Record<Guard, boolean>>) | string {
    if (!isObject(body)) return "Send the policy change as JSON.";
    const change: { preset?: Preset } & Partial<Record<Guard, boolean>> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === "preset") {
        if (!isPreset(value)) return "The preset must be relaxed, standard or strict.";
        change.preset = value;
      } else if ((GUARDS as string[]).includes(key)) {
        if (typeof value !== "boolean") return `${key} must be true or false.`;
        change[key as Guard] = value;
      } else return `There is no policy setting called ${key}.`;
    }
    return Object.keys(change).length ? change : "Say what to change: a preset, or calendar, meetings or friends.";
  }

  /** Proposes DEL like the chat does and waits (briefly) for the approval link the owner was texted. */
  async function requestDelete(account: Account): Promise<{ status: number; body: unknown }> {
    if (money.mode !== "eth") return { status: 503, body: { ok: false, error: "Deleting an account is not available on this server." } };
    if (db.pendingAction(account.id)) return { status: 409, body: { ok: false, error: BUSY } };
    const action: Action = { code: "DEL", id: newActionId(), fields: [{ label: "Tag", value: account.tag }, { label: "Address", value: account.pubkey }] };
    let linked!: (url: string) => void;
    const url = new Promise<string>((resolve) => (linked = resolve));
    try {
      await approvals.request(account.id, action, {
        reason: "account page",
        linkPrompt: (u) => {
          linked(u);
          return `You asked to delete your account from your AgentSign account page. If that was you, confirm it on your Ledger: ${u}\nIf it wasn't, ignore this and nothing happens.`;
        },
      });
    } catch (err) {
      if ((err as Error).message === PENDING_ERROR) return { status: 409, body: { ok: false, error: BUSY } };
      throw err;
    }
    let timer: NodeJS.Timeout | undefined;
    const got = await Promise.race([url, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), LINK_WAIT_MS)))]);
    clearTimeout(timer);
    if (!got) {
      log(`account: ${account.tag} asked to delete the account, but no approval link came back`);
      return { status: 503, body: { ok: false, error: "Could not get an approval link. Try again." } };
    }
    log(`account: ${account.tag} asked to delete the account (approval ${action.id.slice(0, 8)} texted)`);
    return { status: 200, body: { ok: true, url: got, path: new URL(got).pathname } };
  }

  const routes: Routes = async (req, res, path) => {
    if (!path.startsWith("/api/")) return false;
    const route = path.replace(/\/+$/, "");
    const known = ["/api/info", "/api/login/challenge", "/api/login", "/api/logout", "/api/me", "/api/google/connect", "/api/google/disconnect", "/api/phone/link", "/api/phone/unlink", "/api/policy", "/api/delete"];
    if (!known.includes(route)) return false;
    const headers: Record<string, string> = {};
    const json = (status: number, body: unknown) => void res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", ...headers }).end(JSON.stringify(body));
    const fail = (status: number, error: string) => (json(status, { ok: false, error }), true);

    // GET /api/info and /api/me only read; everything else is a POST with the CSRF checks.
    if (route === "/api/info" || route === "/api/me" ? req.method !== "GET" : req.method !== "POST") return fail(405, "Not allowed.");
    // The front door, before anyone signs in: how to reach Jarvis.
    if (route === "/api/info") return json(200, { ok: true, kind: deps.channel.kind, ...(deps.channel.jarvis ? { jarvis: deps.channel.jarvis } : {}), ...(deps.channel.text ? { text: deps.channel.text } : {}) }), true;
    let body: unknown;
    if (req.method === "POST") {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return fail(415, "Send JSON.");
      const origin = req.headers.origin;
      if (origin !== undefined) {
        let parsed: string | undefined;
        try {
          parsed = new URL(origin).origin;
        } catch {}
        if (!parsed || !origins.has(parsed)) return fail(403, NOT_ALLOWED);
      }
      const raw = await readBody(req);
      if (raw === undefined) return fail(413, "That request is too large.");
      body = parseJson(raw);
    }
    const field = (name: string) => (isObject(body) && typeof body[name] === "string" ? body[name] : undefined);

    if (route === "/api/login/challenge") return json(200, challenge()), true;

    if (route === "/api/login") {
      const nonce = field("nonce");
      const address = field("address");
      const signature = field("signature");
      if (!nonce || !address || !signature) return fail(400, "Bad request.");
      const pending = nonces.get(nonce);
      // Single use, even when the rest fails.
      nonces.delete(nonce);
      if (!pending || pending.expiresAt <= now().getTime()) return fail(401, "That sign-in request expired. Try again.");
      if (!isAddress(address)) return fail(400, "That is not an Ethereum address.");
      let signer: string;
      try {
        signer = verifyMessage(pending.message, signature).toLowerCase();
      } catch {
        return fail(401, "That signature could not be read, so you are not signed in. Try again.");
      }
      if (signer !== address.toLowerCase()) return fail(401, "That signature did not come from this Ledger, so you are not signed in.");
      const account = db.accountByPubkey(signer);
      if (!account) return fail(404, "No account is bound to this Ledger yet. Text Jarvis and it will set one up.");
      const token = randomBytes(32).toString("hex");
      db.insertSession(sha256(token), account.id, new Date(now().getTime() + SESSION_MS));
      headers["set-cookie"] = sessionCookie(token);
      log(`account: ${account.tag} signed in from ${shortAddress(signer)}`);
      return json(200, { ok: true, tag: account.tag }), true;
    }

    // Everything below needs a session.
    const token = cookieValue(req, SESSION_COOKIE);
    const tokenHash = token && /^[0-9a-f]{64}$/.test(token) ? sha256(token) : undefined;
    const session = tokenHash ? db.session(tokenHash, now()) : undefined;

    if (route === "/api/logout") {
      headers["set-cookie"] = clearCookie();
      if (tokenHash && db.deleteSession(tokenHash) && session) log(`account: ${db.account(session.account_id)?.tag ?? `account ${session.account_id}`} signed out`);
      return json(200, { ok: true }), true;
    }

    const account = session ? db.account(session.account_id) : undefined;
    if (!session || !account || !tokenHash) {
      // A stale cookie (expired, signed out elsewhere, or the account is gone) is dropped from the browser too.
      if (token !== undefined) headers["set-cookie"] = clearCookie();
      if (session && tokenHash) db.deleteSession(tokenHash);
      return fail(401, SIGN_IN_FIRST);
    }
    // Sliding: once a day of the 7 has passed, the session (and the cookie) get 7 days again.
    if (Date.parse(session.expires_at) - now().getTime() < SESSION_MS - SLIDE_AFTER_MS) {
      db.touchSession(tokenHash, new Date(now().getTime() + SESSION_MS));
      headers["set-cookie"] = sessionCookie(token!);
    } else db.touchSession(tokenHash);

    switch (route) {
      case "/api/me":
        return json(200, await me(account)), true;

      case "/api/google/connect": {
        const linked = calendar.connection(account.id);
        if (linked) return fail(409, `Google Calendar is already connected as ${linked.email}.`);
        if (!calendar.available) return fail(503, "Google Calendar is not set up on this server.");
        // Back to the page that asked: its origin when allowed, else this server's own.
        let from: string | undefined;
        try {
          from = req.headers.origin ? new URL(req.headers.origin).origin : undefined;
        } catch {}
        const returnTo = from && origins.has(from) ? `${from}/` : `${base}/`;
        const url = calendar.connectLink(account.id, { returnTo });
        log(`account: ${account.tag} is connecting Google Calendar (back to ${returnTo})`);
        return json(200, { ok: true, url }), true;
      }

      case "/api/google/disconnect": {
        if (!(await calendar.disconnect(account.id))) return fail(404, "Google Calendar is not connected, so there is nothing to disconnect.");
        log(`account: ${account.tag} disconnected Google Calendar`);
        return json(200, { ok: true }), true;
      }

      case "/api/phone/link":
      case "/api/phone/unlink": {
        if (!phone) return fail(503, "Calling Jarvis is not set up on this server.");
        const linking = route === "/api/phone/link";
        const raw = field(linking ? "number" : "handle");
        if (!raw?.trim()) return fail(400, linking ? "Send the phone number to link." : "Send the number to unlink.");
        if (!linking && normalizeHandle(raw) === db.primaryHandle(account.id)) return fail(400, "That is the number you text Jarvis from, so it stays linked.");
        const result = linking ? phone.link(account.id, raw) : phone.unlink(account.id, raw);
        if (!result.ok) return fail(400, result.reason);
        log(`account: ${account.tag} ${linking ? "linked" : "unlinked"} ${result.handle} for calls`);
        return json(200, linking ? { ok: true, handle: result.handle } : { ok: true }), true;
      }

      case "/api/policy": {
        const change = parsePolicyChange(body);
        if (typeof change === "string") return fail(400, change);
        const next = changePolicy(policyOf(account), change);
        db.setPolicy(account.id, JSON.stringify(next));
        log(`account: ${account.tag} set the Ledger policy: ${describePolicy(next)}`);
        return json(200, { ok: true, policy: policyView(next) }), true;
      }

      case "/api/delete": {
        const result = await requestDelete(account);
        return json(result.status, result.body), true;
      }
    }
    return fail(404, "Not found.");
  };

  return { routes };
}
