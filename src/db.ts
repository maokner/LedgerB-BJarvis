/** SQLite data layer. One file, plain functions over better-sqlite3. */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Action, ActionField } from "./types.js";

export interface Account {
  id: number;
  tag: string;
  pubkey: string;
  balance_cents: number;
  created_at: string;
  /** Telegram username without "@", lowercase, refreshed on every message; null without one. */
  username: string | null;
  /** Telegram display name, refreshed on every message. */
  display_name: string | null;
  /** What needs this owner's Ledger, as JSON (src/policy.ts); null is the default preset. */
  policy: string | null;
}
export interface Friend {
  id: number;
  tag: string;
  status: "pending" | "accepted";
  requested_by: number;
}
export interface Transaction {
  id: number;
  from_account: number;
  to_account: number;
  from_tag: string;
  to_tag: string;
  cents: number;
  memo: string | null;
  created_at: string;
}
export interface CalendarEvent {
  id: number;
  account_id: number;
  title: string;
  /** Local time in America/Los_Angeles, "YYYY-MM-DDTHH:MM". */
  starts_at: string;
  ends_at: string;
  with_tag: string | null;
  /** The action that added it (signed on the Ledger, or executed at once under the owner's policy); null for a meeting both friends said yes to. */
  action_id: string | null;
  /** The event's id on the owner's Google Calendar once mirrored there; null until then (or never, without a connection). */
  google_event_id: string | null;
}
/** An owner's connected Google Calendar (src/calendar/google.ts). */
export interface GoogleCalendarRow {
  account_id: number;
  /** The Google account, as shown to the owner. */
  email: string;
  refresh_token: string;
  access_token: string | null;
  /** Unix ms when access_token stops working. */
  expires_at: number | null;
  calendar_id: string;
  time_zone: string | null;
  created_at: string;
}
export type GoogleLinkStatus = "pending" | "done";
/** A one-time "connect Google Calendar" link texted to an owner; the token is the OAuth state. */
export interface GoogleLink {
  token: string;
  account_id: number;
  status: GoogleLinkStatus;
  created_at: string;
  expires_at: string;
}
export type MessageRole = "user" | "assistant" | "tool" | "system";
export interface StoredMessage {
  id: number;
  role: MessageRole;
  content: unknown;
  created_at: string;
}
export interface PeerMessage {
  from_tag: string;
  to_tag: string;
  text: string;
  created_at: string;
}
export type MeetingStatus = "proposed" | "confirmed" | "declined" | "cancelled";
/** A meeting two friends' agents are arranging (src/meetings.ts). One open ("proposed") meeting per pair at a time. */
export interface Meeting {
  id: number;
  /** Who asked for the meeting; their window below is what they are open to. */
  proposer_id: number;
  invitee_id: number;
  title: string;
  /** The slot on the table, local "YYYY-MM-DDTHH:MM". */
  starts_at: string;
  ends_at: string;
  /** The proposer's acceptable window; a counter inside it from the invitee books the meeting at once. */
  window_from: string;
  window_to: string;
  duration_min: number;
  /** Who put the current slot on the table, and whose answer it waits for. */
  offered_by: number;
  awaiting: number;
  status: MeetingStatus;
  created_at: string;
  resolved_at: string | null;
}
export type ActionStatus = "pending" | "approved" | "rejected" | "failed" | "expired" | "executed";
export interface ActionRow {
  id: string;
  account_id: number | null;
  code: string;
  fields: ActionField[];
  status: ActionStatus;
  signature: string | null;
  error: string | null;
  tx_hash: string | null;
}

/**
 * One Amazon purchase paid in ETH (src/purchases.ts). proposed: quoted, waiting on the Ledger. cancelled: the Ledger
 * said no or the quote lapsed, nothing paid. funded: the ETH transfer to the treasury is broadcast. ordering: the order
 * is being placed (a checkpoint before the side effect; never re-run). ordered: Amazon took it. refunding/refunded:
 * nothing was ordered and the ETH goes back. refund_failed and review: a person must look.
 */
export type PurchaseStatus = "proposed" | "cancelled" | "funded" | "ordering" | "ordered" | "refunding" | "refunded" | "refund_failed" | "review";
export interface Purchase {
  /** The BUY action that paid for it. */
  action_id: string;
  account_id: number;
  asin: string;
  title: string;
  quote: string;
  /** What the owner paid, in USD cents at the quote, and in wei at the spot price then. */
  total_cents: number;
  wei: string;
  /** The treasury address the ETH went to, and the buyer's address a refund goes back to. */
  treasury: string;
  buyer: string;
  status: PurchaseStatus;
  fund_tx_hash: string | null;
  order_id: string | null;
  refund_tx_hash: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export type SigningJobStatus = "pending" | "signed" | "rejected" | "expired" | "superseded";
/** A remote signing job: the link texted to the owner, opened on any computer their Ledger is plugged into. */
export interface SigningJob {
  token: string;
  action_id: string;
  pubkey: string;
  action: Action;
  status: SigningJobStatus;
  created_at: string;
  expires_at: string;
}

const SCHEMA = `
create table if not exists accounts (
  id integer primary key, tag text not null unique, pubkey text not null unique,
  balance_cents integer not null, created_at text not null default (datetime('now')), username text, display_name text);
create table if not exists handles (
  handle text primary key, account_id integer not null references accounts(id), is_primary integer not null default 0);
create table if not exists friendships (
  a integer not null, b integer not null, status text not null check (status in ('pending','accepted')),
  requested_by integer not null, created_at text not null default (datetime('now')), primary key (a, b));
create table if not exists transactions (
  id integer primary key, from_account integer not null, to_account integer not null, cents integer not null,
  memo text, action_id text, created_at text not null default (datetime('now')));
create table if not exists events (
  id integer primary key, account_id integer not null, title text not null, starts_at text not null, ends_at text not null,
  with_tag text, action_id text, created_at text not null default (datetime('now')), google_event_id text);
create table if not exists meetings (
  id integer primary key, proposer_id integer not null, invitee_id integer not null, title text not null,
  starts_at text not null, ends_at text not null, window_from text not null, window_to text not null, duration_min integer not null,
  offered_by integer not null, awaiting integer not null,
  status text not null check (status in ('proposed','confirmed','declined','cancelled')),
  created_at text not null default (datetime('now')), resolved_at text);
create table if not exists google_calendars (
  account_id integer primary key references accounts(id), email text not null, refresh_token text not null,
  access_token text, expires_at integer, calendar_id text not null default 'primary', time_zone text,
  created_at text not null default (datetime('now')));
create table if not exists google_links (
  token text primary key, account_id integer not null, status text not null check (status in ('pending','done')),
  created_at text not null default (datetime('now')), expires_at text not null);
create table if not exists notes (
  id integer primary key, account_id integer not null, text text not null, created_at text not null default (datetime('now')));
create table if not exists messages (
  id integer primary key, account_id integer not null, role text not null check (role in ('user','assistant','tool','system')),
  content text not null, created_at text not null default (datetime('now')));
create table if not exists peer_messages (
  id integer primary key, thread text not null, from_tag text not null, to_tag text not null, text text not null,
  created_at text not null default (datetime('now')));
create table if not exists actions (
  id text primary key, account_id integer, code text not null, fields text not null,
  status text not null check (status in ('pending','approved','rejected','failed','expired','executed')),
  signature text, error text, tx_hash text, created_at text not null default (datetime('now')), resolved_at text);
create table if not exists signing_jobs (
  token text primary key, action_id text not null, pubkey text not null, action text not null,
  status text not null check (status in ('pending','signed','rejected','expired','superseded')),
  created_at text not null default (datetime('now')), expires_at text not null);
create table if not exists purchases (
  action_id text primary key, account_id integer not null, asin text not null, title text not null, quote text not null,
  total_cents integer not null, wei text not null, treasury text not null, buyer text not null,
  status text not null check (status in ('proposed','cancelled','funded','ordering','ordered','refunding','refunded','refund_failed','review')),
  fund_tx_hash text, order_id text, refund_tx_hash text, error text,
  created_at text not null default (datetime('now')), updated_at text not null default (datetime('now')));
create table if not exists settings (key text primary key, value text not null);
create table if not exists seen_inbound (
  id text primary key, handle text not null, at text not null default (datetime('now')));
create index if not exists messages_by_account on messages (account_id, id);
create index if not exists peer_by_thread on peer_messages (thread, id);
create index if not exists events_by_account on events (account_id, starts_at);
create index if not exists meetings_open on meetings (status, proposer_id, invitee_id);
`;

/** Thread key for two agents: the sorted pair of tags. */
export const threadKey = (a: string, b: string): string => [a, b].sort().join(" ");

export type Db = ReturnType<typeof openDb>;

export function openDb(path = "data/agentsign.db") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // Databases created before Ethereum mode lack actions.tx_hash.
  const columns = (table: string) => (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!columns("actions").includes("tx_hash")) db.exec("alter table actions add column tx_hash text");
  // Databases created before Telegram lack the profile columns.
  for (const col of ["username", "display_name"]) if (!columns("accounts").includes(col)) db.exec(`alter table accounts add column ${col} text`);
  // Databases created before Google Calendar lack events.google_event_id.
  if (!columns("events").includes("google_event_id")) db.exec("alter table events add column google_event_id text");
  // Databases created before the Ledger policy lack accounts.policy.
  if (!columns("accounts").includes("policy")) db.exec("alter table accounts add column policy text");

  const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T | undefined;
  const all = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as T[];
  const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
  const pair = (x: number, y: number) => (x < y ? [x, y] : [y, x]) as [number, number];
  const toAction = (r: Omit<ActionRow, "fields"> & { fields: string }): ActionRow => ({ ...r, fields: JSON.parse(r.fields) as ActionField[] });

  return {
    raw: db,
    tx: <T>(fn: () => T): T => db.transaction(fn)(),
    close: () => db.close(),

    // accounts and handles
    createAccount(tag: string, pubkey: string, handle: string, balanceCents: number): Account {
      return db.transaction(() => {
        const id = Number(run("insert into accounts (tag, pubkey, balance_cents) values (?, ?, ?)", tag, pubkey, balanceCents).lastInsertRowid);
        run("insert into handles (handle, account_id, is_primary) values (?, ?, 1)", handle, id);
        return one<Account>("select * from accounts where id = ?", id)!;
      })();
    },
    account: (id: number) => one<Account>("select * from accounts where id = ?", id),
    accountByTag: (tag: string) => one<Account>("select * from accounts where tag = ?", tag),
    accountByPubkey: (pubkey: string) => one<Account>("select * from accounts where pubkey = ?", pubkey),
    accountByHandle: (handle: string) =>
      one<Account>("select a.* from accounts a join handles h on h.account_id = a.id where h.handle = ?", handle),
    /** By Telegram username, with or without "@", any case. */
    accountByUsername: (username: string) => one<Account>("select * from accounts where username = ?", username.replace(/^@/, "").toLowerCase()),
    setProfile: (accountId: number, username: string | null, displayName: string | null) =>
      run("update accounts set username = ?, display_name = ? where id = ?", username?.replace(/^@/, "").toLowerCase() || null, displayName || null, accountId),
    accounts: () => all<Account>("select * from accounts order by id"),
    setPolicy: (accountId: number, policy: string | null) => run("update accounts set policy = ? where id = ?", policy, accountId),
    primaryHandle: (accountId: number) =>
      one<{ handle: string }>("select handle from handles where account_id = ? order by is_primary desc, rowid limit 1", accountId)?.handle,
    addCents: (accountId: number, cents: number) => run("update accounts set balance_cents = balance_cents + ? where id = ?", cents, accountId),

    /**
     * Removes an account and everything personal to it. The actions log and transactions stay, detached
     * (account_id NULL, account 0), so a later account that reuses the row id inherits nothing.
     */
    deleteAccount(id: number) {
      const tag = one<{ tag: string }>("select tag from accounts where id = ?", id)?.tag;
      for (const table of ["handles", "notes", "events", "messages", "google_calendars", "google_links"]) run(`delete from ${table} where account_id = ?`, id);
      run("delete from friendships where a = ? or b = ?", id, id);
      run("delete from meetings where proposer_id = ? or invitee_id = ?", id, id);
      if (tag) run("delete from peer_messages where from_tag = ? or to_tag = ?", tag, tag);
      run("update actions set account_id = null where account_id = ?", id);
      run("update transactions set from_account = 0 where from_account = ?", id);
      run("update transactions set to_account = 0 where to_account = ?", id);
      run("delete from accounts where id = ?", id);
    },

    // friendships (stored once per pair, a < b)
    friendship(x: number, y: number) {
      const [a, b] = pair(x, y);
      return one<{ status: "pending" | "accepted"; requested_by: number }>("select status, requested_by from friendships where a = ? and b = ?", a, b);
    },
    requestFriend(from: number, to: number) {
      const [a, b] = pair(from, to);
      run("insert into friendships (a, b, status, requested_by) values (?, ?, 'pending', ?) on conflict (a, b) do nothing", a, b, from);
    },
    acceptFriend(x: number, y: number) {
      const [a, b] = pair(x, y);
      run("update friendships set status = 'accepted' where a = ? and b = ?", a, b);
    },
    /** Everyone this account has a friendship row with, accepted or pending. */
    friendsOf: (accountId: number) =>
      all<Friend>(
        `select acc.id, acc.tag, f.status, f.requested_by from friendships f
         join accounts acc on acc.id = case when f.a = ? then f.b else f.a end
         where f.a = ? or f.b = ? order by acc.tag`,
        accountId, accountId, accountId,
      ),

    // money
    transfer(from: number, to: number, cents: number, memo: string | null, actionId: string) {
      run("update accounts set balance_cents = balance_cents - ? where id = ?", cents, from);
      run("update accounts set balance_cents = balance_cents + ? where id = ?", cents, to);
      run("insert into transactions (from_account, to_account, cents, memo, action_id) values (?, ?, ?, ?, ?)", from, to, cents, memo, actionId);
    },
    transactions: (accountId: number, limit = 10) =>
      all<Transaction>(
        `select t.*, coalesce(fa.tag, 'a deleted account') as from_tag, coalesce(ta.tag, 'a deleted account') as to_tag from transactions t
         left join accounts fa on fa.id = t.from_account left join accounts ta on ta.id = t.to_account
         where t.from_account = ? or t.to_account = ? order by t.id desc limit ?`,
        accountId, accountId, limit,
      ),

    // calendar
    addEvent(accountId: number, title: string, startsAt: string, endsAt: string, withTag: string | null, actionId: string | null) {
      run("insert into events (account_id, title, starts_at, ends_at, with_tag, action_id) values (?, ?, ?, ?, ?, ?)", accountId, title, startsAt, endsAt, withTag, actionId);
    },
    /** Events overlapping [from, to). Times are local "YYYY-MM-DDTHH:MM" strings, so string order is time order. */
    events: (accountId: number, from: string, to: string) =>
      all<CalendarEvent>("select * from events where account_id = ? and ends_at > ? and starts_at < ? order by starts_at", accountId, from, to),

    // meetings between friends (src/meetings.ts)
    insertMeeting(m: Omit<Meeting, "id" | "status" | "created_at" | "resolved_at">): Meeting {
      const id = Number(
        run(
          `insert into meetings (proposer_id, invitee_id, title, starts_at, ends_at, window_from, window_to, duration_min, offered_by, awaiting, status)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed')`,
          m.proposer_id, m.invitee_id, m.title, m.starts_at, m.ends_at, m.window_from, m.window_to, m.duration_min, m.offered_by, m.awaiting,
        ).lastInsertRowid,
      );
      return one<Meeting>("select * from meetings where id = ?", id)!;
    },
    meeting: (id: number) => one<Meeting>("select * from meetings where id = ?", id),
    /** Meetings still being arranged that involve this account, oldest first. */
    openMeetings: (accountId: number) =>
      all<Meeting>("select * from meetings where status = 'proposed' and (proposer_id = ? or invitee_id = ?) order by id", accountId, accountId),
    /** The meeting still being arranged between these two, if any. */
    openMeetingBetween: (x: number, y: number) =>
      one<Meeting>(
        "select * from meetings where status = 'proposed' and ((proposer_id = ? and invitee_id = ?) or (proposer_id = ? and invitee_id = ?)) order by id desc limit 1",
        x, y, y, x,
      ),
    /** A new slot on the table, offered by one side and waiting for the other. */
    offerMeetingSlot: (id: number, startsAt: string, endsAt: string, offeredBy: number, awaiting: number) =>
      run("update meetings set starts_at = ?, ends_at = ?, offered_by = ?, awaiting = ? where id = ?", startsAt, endsAt, offeredBy, awaiting, id),
    setMeetingStatus: (id: number, status: Exclude<MeetingStatus, "proposed">) =>
      run("update meetings set status = ?, resolved_at = ? where id = ?", status, new Date().toISOString(), id),
    /** Events not mirrored to Google Calendar yet that end after `from`, oldest first. */
    unsyncedEvents: (accountId: number, from: string) =>
      all<CalendarEvent>("select * from events where account_id = ? and google_event_id is null and ends_at > ? order by starts_at", accountId, from),
    setEventGoogleId: (id: number, googleEventId: string) => run("update events set google_event_id = ? where id = ?", googleEventId, id),

    // Google Calendar connection (src/calendar/google.ts)
    googleCalendar: (accountId: number) => one<GoogleCalendarRow>("select * from google_calendars where account_id = ?", accountId),
    setGoogleCalendar: (row: Omit<GoogleCalendarRow, "created_at">) =>
      run(
        `insert into google_calendars (account_id, email, refresh_token, access_token, expires_at, calendar_id, time_zone) values (?, ?, ?, ?, ?, ?, ?)
         on conflict (account_id) do update set email = excluded.email, refresh_token = excluded.refresh_token, access_token = excluded.access_token,
         expires_at = excluded.expires_at, calendar_id = excluded.calendar_id, time_zone = excluded.time_zone, created_at = datetime('now')`,
        row.account_id, row.email, row.refresh_token, row.access_token, row.expires_at, row.calendar_id, row.time_zone,
      ),
    setGoogleAccessToken: (accountId: number, accessToken: string, expiresAt: number) =>
      run("update google_calendars set access_token = ?, expires_at = ? where account_id = ?", accessToken, expiresAt, accountId),
    /** Forgets the connection; the events table keeps its google_event_id marks (those events exist on Google either way). */
    deleteGoogleCalendar: (accountId: number) => run("delete from google_calendars where account_id = ?", accountId).changes > 0,
    insertGoogleLink: (token: string, accountId: number, expiresAt: Date) =>
      run("insert into google_links (token, account_id, status, expires_at) values (?, ?, 'pending', ?)", token, accountId, expiresAt.toISOString()),
    googleLink: (token: string) => one<GoogleLink>("select * from google_links where token = ?", token),
    /** Marks the link used. Returns false when it was not pending any more (a second visit). */
    useGoogleLink: (token: string) => run("update google_links set status = 'done' where token = ? and status = 'pending'", token).changes > 0,

    // notes
    addNote: (accountId: number, text: string) => run("insert into notes (account_id, text) values (?, ?)", accountId, text),
    notes: (accountId: number) => all<{ text: string; created_at: string }>("select text, created_at from notes where account_id = ? order by id", accountId),

    // chat history
    addMessage: (accountId: number, role: MessageRole, content: unknown) =>
      run("insert into messages (account_id, role, content) values (?, ?, ?)", accountId, role, JSON.stringify(content)),
    recentMessages: (accountId: number, limit = 30): StoredMessage[] =>
      all<{ id: number; role: MessageRole; content: string; created_at: string }>(
        "select * from (select * from messages where account_id = ? order by id desc limit ?) order by id",
        accountId, limit,
      ).map((m) => ({ ...m, content: JSON.parse(m.content) as unknown })),

    // agent-to-agent threads
    addPeerMessage: (fromTag: string, toTag: string, text: string) =>
      run("insert into peer_messages (thread, from_tag, to_tag, text) values (?, ?, ?, ?)", threadKey(fromTag, toTag), fromTag, toTag, text),
    peerThread: (tagA: string, tagB: string, limit = 20) =>
      all<PeerMessage>(
        "select * from (select * from peer_messages where thread = ? order by id desc limit ?) order by id",
        threadKey(tagA, tagB), limit,
      ),

    // actions log
    insertAction: (accountId: number | null, action: Action) =>
      run("insert into actions (id, account_id, code, fields, status) values (?, ?, ?, ?, 'pending')", action.id, accountId, action.code, JSON.stringify(action.fields)),
    setActionStatus(id: string, status: ActionStatus, extra: { signature?: string; error?: string } = {}) {
      const resolved = status === "pending" || status === "approved" ? null : new Date().toISOString();
      run(
        "update actions set status = ?, signature = coalesce(?, signature), error = coalesce(?, error), resolved_at = coalesce(?, resolved_at) where id = ?",
        status, extra.signature ?? null, extra.error ?? null, resolved, id,
      );
    },
    action(id: string) {
      const r = one<Omit<ActionRow, "fields"> & { fields: string }>("select * from actions where id = ?", id);
      return r && toAction(r);
    },
    setActionTxHash: (id: string, hash: string) => run("update actions set tx_hash = ? where id = ?", hash, id),
    /** Ethereum mode: payments this account broadcast, newest first. */
    sentPayments: (accountId: number, limit = 10) =>
      all<Omit<ActionRow, "fields"> & { fields: string; created_at: string }>(
        "select * from actions where account_id = ? and code = 'PAY' and tx_hash is not null order by created_at desc limit ?",
        accountId, limit,
      ).map(toAction),
    /** On startup: nothing from a previous run is still waiting on a device. */
    expireStaleActions: () =>
      run("update actions set status = 'expired', error = 'server restarted', resolved_at = ? where status in ('pending','approved')", new Date().toISOString()).changes,
    /** The account's action that is waiting on the device, if any. */
    pendingAction(accountId: number) {
      const r = one<Omit<ActionRow, "fields"> & { fields: string }>(
        "select * from actions where account_id = ? and status in ('pending','approved') order by created_at desc limit 1",
        accountId,
      );
      return r && toAction(r);
    },

    // remote signing jobs (src/device/remote.ts)
    insertSigningJob: (token: string, pubkey: string, action: Action, expiresAt: Date) =>
      run("insert into signing_jobs (token, action_id, pubkey, action, status, expires_at) values (?, ?, ?, ?, 'pending', ?)", token, action.id, pubkey, JSON.stringify(action), expiresAt.toISOString()),
    signingJob(token: string): SigningJob | undefined {
      const r = one<Omit<SigningJob, "action"> & { action: string }>("select * from signing_jobs where token = ?", token);
      return r && { ...r, action: JSON.parse(r.action) as Action };
    },
    setSigningJobStatus: (token: string, status: SigningJobStatus) => run("update signing_jobs set status = ? where token = ?", status, token),
    /** On startup: nobody is waiting on a job from a previous run any more. */
    expireSigningJobs: () => run("update signing_jobs set status = 'expired' where status = 'pending'").changes,

    // Amazon purchases paid in ETH (src/purchases.ts)
    insertPurchase: (p: Pick<Purchase, "action_id" | "account_id" | "asin" | "title" | "quote" | "total_cents" | "wei" | "treasury" | "buyer">) =>
      run(
        "insert into purchases (action_id, account_id, asin, title, quote, total_cents, wei, treasury, buyer, status) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed')",
        p.action_id, p.account_id, p.asin, p.title, p.quote, p.total_cents, p.wei, p.treasury, p.buyer,
      ),
    purchase: (actionId: string) => one<Purchase>("select * from purchases where action_id = ?", actionId),
    setPurchaseStatus(actionId: string, status: PurchaseStatus, extra: { fundTxHash?: string; orderId?: string; refundTxHash?: string; error?: string } = {}) {
      run(
        `update purchases set status = ?, fund_tx_hash = coalesce(?, fund_tx_hash), order_id = coalesce(?, order_id), refund_tx_hash = coalesce(?, refund_tx_hash),
         error = coalesce(?, error), updated_at = ? where action_id = ?`,
        status, extra.fundTxHash ?? null, extra.orderId ?? null, extra.refundTxHash ?? null, extra.error ?? null, new Date().toISOString(), actionId,
      );
    },
    /** An account's purchases, newest first. */
    purchases: (accountId: number, limit = 10) => all<Purchase>("select * from purchases where account_id = ? order by created_at desc limit ?", accountId, limit),
    /** Every purchase in one of these states, oldest first (startup recovery). */
    purchasesIn: (statuses: PurchaseStatus[]) =>
      all<Purchase>(`select * from purchases where status in (${statuses.map(() => "?").join(",")}) order by created_at`, ...statuses),

    // settings (key/value; "voice_context" is the standing instruction for phone calls)
    setting: (key: string) => one<{ value: string }>("select value from settings where key = ?", key)?.value,
    setSetting: (key: string, value: string) => run("insert into settings (key, value) values (?, ?) on conflict (key) do update set value = excluded.value", key, value),

    /** Records an inbound message id. Returns false when it was seen before. */
    markSeen: (id: string, handle: string) => run("insert or ignore into seen_inbound (id, handle) values (?, ?)", id, handle).changes > 0,
  };
}
