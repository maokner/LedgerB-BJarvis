/**
 * The engine's tools. Read-only tools run directly; anything risky goes through propose_action and the owner's Ledger.
 * Meetings with friends are the exception by design: propose_meeting and answer_meeting arrange them agent to agent
 * and the people confirm by text (src/meetings.ts), nothing on a Ledger.
 */
import { describeAction, newActionId, toFieldText } from "../actions.js";
import { cleanAddress, mentionsAddress, noAddress, saveAddress, savedAddress } from "../address.js";
import type { Approvals } from "../approvals.js";
import { PENDING_ERROR } from "../approvals.js";
import type { Account, Db } from "../db.js";
import type { Calendar } from "../calendar/google.js";
import { addMinutes, formatCents, formatWhen, parseWhen, TIMEZONE } from "../format.js";
import { answerMeeting, MAX_DURATION_MIN, MIN_DURATION_MIN, proposeMeeting, type Answer, type MeetingDeps } from "../meetings.js";
import { changePolicy, describePolicy, executeDirectly, GUARDS, guardOf, isPreset, policyOf, requiresLedger } from "../policy.js";
import { ACTION_TITLES, type Action, type ActionField, type Channel } from "../types.js";
import type { ToolSpec } from "./xai.js";
import { txLink } from "../chain.js";
import { demoMoney, type Money } from "../money.js";
import type { PhoneLinks } from "../phone.js";
import type { Food } from "../food/food.js";
import type { Purchases } from "../purchases.js";
import { channelKind, joinHint } from "./bot.js";
import { normalizeHandle } from "../handles.js";

export interface Tools {
  specs: ToolSpec[];
  run(name: string, args: Record<string, unknown>): Promise<string>;
}

const range = {
  type: "object",
  properties: {
    from: { type: "string", description: "Start date or time, YYYY-MM-DD or YYYY-MM-DDTHH:MM, local time" },
    to: { type: "string", description: "End date or time (inclusive day), YYYY-MM-DD or YYYY-MM-DDTHH:MM, local time" },
  },
  required: ["from", "to"],
};
const none = { type: "object", properties: {} };
/** How an order tool's error starts when the owner has not confirmed the delivery address (the engine ends its task on it). */
export const UNCONFIRMED_ADDRESS = "Error: the owner has not confirmed where this order goes.";
/** Longest note one friend can send another in one go. */
export const NOTE_MAX = 500;

export const OWNER_TOOL_SPECS: ToolSpec[] = [
  { name: "get_balance", description: "The owner's current balance.", parameters: none },
  { name: "list_friends", description: "Friends (whose agents can talk to this one) and pending friend requests.", parameters: none },
  { name: "get_calendar", description: "The owner's calendar events in a time range: their Google Calendar when it is connected (with location, notes, organizer, attendees, the owner's reply and links when Google has them), plus events added through AgentSign.", parameters: range },
  {
    name: "connect_google_calendar",
    description:
      "Send the owner a one-time link that connects their Google Calendar, so get_calendar shows it, friends' agents see its busy times, and events they approve on their Ledger land there. " +
      "Call when they ask to connect, link, sync or hook up Google Calendar.",
    parameters: none,
  },
  { name: "disconnect_google_calendar", description: "Disconnect the owner's Google Calendar. Only when they ask for that.", parameters: none },
  { name: "get_notes", description: "Notes you saved about the owner.", parameters: none },
  {
    name: "remember",
    description: "Save a lasting note about the owner (preferences, names, facts).",
    parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  },
  { name: "list_transactions", description: "The owner's 10 most recent payments in and out.", parameters: none },
  {
    name: "send_note",
    description:
      "Send a friend a short note from the owner: thanks, hello, a reply, anything they want to say to that person. " +
      "It reaches the friend right away as a text from their own Jarvis (\"@tag says: ...\"); nothing to approve. Write it as the owner would say it. Only works with accepted friends.",
    parameters: {
      type: "object",
      properties: { tag: { type: "string", description: "The friend's tag, like @yadu" }, text: { type: "string", description: "The note, in the owner's words, a sentence or two" } },
      required: ["tag", "text"],
    },
  },
  {
    name: "message_agent",
    description:
      "Ask a friend's agent when they are free and get its reply (busy intervals only), for questions like 'when is yadu free tomorrow'. " +
      "To set up a meeting call propose_meeting instead; it checks both calendars itself. " +
      "It cannot pass anything on to the friend themselves: for that use send_note. Only works with accepted friends.",
    parameters: {
      type: "object",
      properties: { tag: { type: "string", description: "The friend's tag, like @yadu" }, text: { type: "string" } },
      required: ["tag", "text"],
    },
  },
  {
    name: "propose_meeting",
    description:
      "Set up a meeting with a friend. Checks both calendars (the friend's as free/busy only) for a slot inside the window the owner is open to, " +
      "free for both, and texts it to the friend, who books it by replying yes or names another time (a time inside the owner's window books at once). " +
      "Nothing goes on any Ledger, and nothing is booked until the friend answers; the owner is texted then. Only works with accepted friends.",
    parameters: {
      type: "object",
      properties: {
        tag: { type: "string", description: "The friend's tag, like @yadu" },
        title: { type: "string", description: "What it is about, a few words, never the person's name ('Coffee', 'Project sync'). Default: Meeting" },
        from: { type: "string", description: "Start of the window the owner is open to, YYYY-MM-DD HH:MM local time. For an exact time, that time" },
        to: { type: "string", description: "End of the window, YYYY-MM-DD HH:MM. For an exact time, the start plus the length" },
        duration_minutes: { type: "integer", description: "Length of the meeting. Default 30" },
        preferred: { type: "string", description: "Only with a window wider than the meeting: the start the owner mentioned ('around 9' -> YYYY-MM-DD 09:00); the free slot nearest it is offered" },
      },
      required: ["tag", "from", "to"],
    },
  },
  {
    name: "answer_meeting",
    description:
      "The owner's answer to a meeting being arranged with a friend (the facts list them). yes: books it on both calendars. no: declines it, or withdraws the owner's own offer. " +
      "another time: offers a different slot; when the friend proposed and the slot is inside the window they gave, it is booked at once, otherwise the friend is asked.",
    parameters: {
      type: "object",
      properties: {
        tag: { type: "string", description: "The friend's tag" },
        answer: { type: "string", enum: ["yes", "no", "another time"] },
        when: { type: "string", description: "For another time: YYYY-MM-DD HH:MM-HH:MM, or just the start YYYY-MM-DD HH:MM for the same length" },
      },
      required: ["tag", "answer"],
    },
  },
  {
    name: "set_ledger_policy",
    description:
      "Change what needs the owner's Ledger, when they ask (the facts show the current policy). Money and deleting the account always need it. " +
      "A preset sets the rest: relaxed (nothing else), standard (adding friends), strict (own calendar events, meetings with friends and adding friends). " +
      "Or flip one thing: calendar, meetings or friends, true for 'ask my Ledger', false for 'just do it'. Takes effect at once.",
    parameters: {
      type: "object",
      properties: {
        preset: { type: "string", enum: ["relaxed", "standard", "strict"] },
        calendar: { type: "boolean", description: "The owner's own calendar events need the Ledger" },
        meetings: { type: "boolean", description: "The owner's side of a meeting with a friend needs the Ledger" },
        friends: { type: "boolean", description: "Friend requests and accepting them need the Ledger" },
      },
    },
  },
  {
    name: "propose_action",
    description:
      "Do or propose an action: payments and deleting the account always go to the owner's Ledger; calendar events, friend requests and accepts go there only when the owner's Ledger policy says so (see the facts), otherwise they happen at once and the result says so. " +
      "On the Ledger the owner sees exactly these fields. " +
      "PAY: To @tag (or a 0x address in Ethereum mode), Amount like $5.00 (sent as USDC on Base when the owner holds enough, else as ETH; or like 0.001 ETH to send ETH), optional Memo (a few words). " +
      "CAL: the owner's own event (never a meeting with a friend: that is propose_meeting): Title, When as YYYY-MM-DD HH:MM-HH:MM (24h local time). " +
      "FRQ (friend request): To @tag. FAC (accept a friend request): From @tag. " +
      "DEL (delete the owner's own account, only when they clearly ask to delete, close or reset it): no fields needed. " +
      "BUY (buy one item on Amazon, paid in USDC; only where the facts say Amazon is available): Item <the 10-character item id from search_amazon>, and Ship <full address> only when the owner named another address for this order (default: their saved delivery address). " +
      "It quotes the exact total with shipping and tax, refuses anything over the limit or without an address, and the money comes back if the order does not go through. " +
      "EAT (order food on DoorDash, paid in USDC; only where the facts say DoorDash is available): Order <the quote_id from quote_doordash>. It prices the quoted order again and refuses anything over the limit.",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", enum: ["PAY", "CAL", "FRQ", "FAC", "DEL", "BUY", "EAT"] },
        fields: {
          type: "array",
          items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] },
        },
      },
      required: ["code", "fields"],
    },
  },
];

/** Only where buying is set up (src/purchases.ts). */
export const PURCHASE_TOOL_SPECS: ToolSpec[] = [
  {
    name: "search_amazon",
    description:
      "Search Amazon for something the owner wants to buy. Returns up to a few matching items with their item id, title and listed price (before shipping and tax). " +
      "Pick the one that best fits what they asked (cheapest that matches, unless they said otherwise), then propose_action BUY with Item <id>. Never guess an item id.",
    parameters: { type: "object", properties: { query: { type: "string", description: "What to look for, like 'trident gum' or 'usb-c cable 6ft'" } }, required: ["query"] },
  },
];

/** Where Amazon or food ordering is set up: one list for both. */
export const LIST_PURCHASES_SPEC: ToolSpec = {
  name: "list_purchases",
  description: "The owner's purchases through you (Amazon items, DoorDash food orders): store, what, total, status (ordered, refunded, in progress), order number.",
  parameters: none,
};

/** Where Amazon or food ordering is set up: the one address both use (src/address.ts). */
export const DELIVERY_ADDRESS_SPEC: ToolSpec = {
  name: "set_delivery_address",
  description:
    "Save the owner's delivery address: where food orders are delivered and Amazon orders ship. Only an address the owner gives as their own (home, work, \"my new place\"); never one you guessed, and not one meant for just this order (that goes in the order's address or Ship instead). Replaces the saved one.",
  parameters: { type: "object", properties: { address: { type: "string", description: "Street and number, apartment if any, city, ZIP, like '1 Market St Apt 5, San Francisco, CA 94105'" } }, required: ["address"] },
};

/** Only where food ordering is set up (src/food/). */
export const FOOD_TOOL_SPECS: ToolSpec[] = [
  {
    name: "search_doordash",
    description: "Find restaurants on DoorDash that deliver to the owner's address and match what they feel like. Returns store ids, names, ratings, ETAs and delivery fees.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "A dish, a cuisine or a restaurant, like 'burrito', 'sushi' or 'chipotle'" },
        address: { type: "string", description: "Only when the owner names a different address for this order; default the saved one" },
      },
      required: ["query"],
    },
  },
  {
    name: "doordash_menu",
    description: "A DoorDash restaurant's menu: item ids, names and prices. Call it before quoting; never guess an item id.",
    parameters: { type: "object", properties: { store_id: { type: "string", description: "The store_id from search_doordash" } }, required: ["store_id"] },
  },
  {
    name: "quote_doordash",
    description:
      "Price an exact DoorDash order: the items and quantities from one restaurant, delivered to the owner's address. Returns the total all in (food, fees, tax, tip), the ETA and a quote_id. " +
      "Then propose_action EAT with Order <quote_id>. Nothing is ordered by quoting.",
    parameters: {
      type: "object",
      properties: {
        store_id: { type: "string", description: "The store_id from search_doordash" },
        items: {
          type: "array",
          items: { type: "object", properties: { item_id: { type: "string", description: "From doordash_menu" }, quantity: { type: "integer" } }, required: ["item_id", "quantity"] },
        },
        tip_percent: { type: "number", description: "Dasher tip as a percent of the food. Default 15" },
        address: { type: "string", description: "Only when the owner names a different address for this order; default the saved one" },
      },
      required: ["store_id", "items"],
    },
  },
];

/** Only where phone calls are set up (src/phone.ts). */
export const PHONE_TOOL_SPECS: ToolSpec[] = [
  {
    name: "link_phone",
    description: "Link a phone number to the owner, so a call from it is recognised as them. Only the owner's own number, when they give it. Takes effect at once.",
    parameters: { type: "object", properties: { number: { type: "string", description: "The number with its country code, like +1 415 555 0100" } }, required: ["number"] },
  },
  {
    name: "unlink_phone",
    description: "Unlink one of the owner's phone numbers (the facts list them). Only when they ask.",
    parameters: { type: "object", properties: { number: { type: "string" } }, required: ["number"] },
  },
];

export const PEER_TOOL_SPECS: ToolSpec[] = [
  { name: "get_free_busy", description: "Busy intervals of your owner's calendar in a time range (no titles).", parameters: range },
];

/** "2026-10-11 09:30" or "2026-10-11T09:30" -> "2026-10-11T09:30"; a bare day gets `clock`; anything else undefined. */
export function stampArg(v: unknown, clock: string): string | undefined {
  const s = String(v ?? "").trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T${clock}`;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return undefined;
  const out = s.slice(0, 16);
  return Number.isNaN(Date.parse(`${out}:00Z`)) ? undefined : out;
}

/** "2026-10-11" -> start or end of that day; full stamps pass through. */
function rangeArgs(args: Record<string, unknown>): { from: string; to: string } | undefined {
  const from = stampArg(args.from, "00:00");
  const to = stampArg(args.to, "24:00");
  return from && to ? { from, to } : undefined;
}

export async function freeBusy(calendar: Calendar, accountId: number, args: Record<string, unknown>): Promise<string> {
  const r = rangeArgs(args);
  if (!r) return "Error: from and to must be YYYY-MM-DD or YYYY-MM-DDTHH:MM.";
  const { busy, warning } = await calendar.busy(accountId, r.from, r.to);
  return JSON.stringify({ timezone: TIMEZONE, from: r.from, to: r.to, busy, ...(warning ? { warning } : {}) });
}

/** "+1 (415) 555-0100" or "gabe@icloud.com": a phone number or email someone could text from, else undefined. */
function handleOf(raw: string): string | undefined {
  const s = raw.trim();
  const digits = s.replace(/\D/g, "").length;
  if (/^\+?[\d\s().-]+$/.test(s) && (digits >= 10 || (s.startsWith("+") && digits >= 8))) return normalizeHandle(s);
  if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s)) return normalizeHandle(s);
  return undefined;
}

/**
 * Resolve "gabe", "@gabriel" or "Gabriel" to an account: exact tag, exact Telegram username, an exact phone number or
 * email (the iMessage handle they signed up from), then prefix matches among friends, then everyone; must be unambiguous.
 */
export function resolveTag(db: Db, owner: Account, raw: string): Account | string {
  const name = raw.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (name.length < 2) return `Error: "${raw}" is not a tag. Ask the owner who they mean.`;
  const exact = db.accountByTag(`@${name}`) ?? db.accountByUsername(name);
  if (exact) return exact;
  // A number or an email is matched exactly, never by prefix: digits that start alike are different people.
  const handle = handleOf(raw);
  if (handle) {
    return (
      db.accountByHandle(handle) ??
      `Error: nobody on AgentSign has the number or email "${raw}". If they are not on AgentSign yet, tell the owner: they need to ${joinHint()} first. Otherwise ask the owner for their @tag.`
    );
  }
  const prefix = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return i;
  };
  const matches = (accounts: Account[]) =>
    accounts.filter((a) => {
      const t = a.tag.slice(1);
      return t.startsWith(name) || name.startsWith(t) || prefix(t, name) >= 3;
    });
  const friendIds = new Set(db.friendsOf(owner.id).map((f) => f.id));
  const others = db.accounts().filter((a) => a.id !== owner.id);
  for (const pool of [others.filter((a) => friendIds.has(a.id)), others]) {
    const found = matches(pool);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) return `Error: "${raw}" could be ${found.map((a) => a.tag).join(" or ")}. Ask the owner which one.`;
  }
  return (
    `Error: nobody on AgentSign has the tag ${channelKind() === "telegram" ? "or Telegram username " : ""}"${raw}". If they are not on AgentSign yet, tell the owner: ` +
    `they need to ${joinHint()} first. Otherwise ask the owner for the exact @tag.`
  );
}

function readFields(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const put = (label: unknown, value: unknown) => {
    if (typeof label === "string" && value !== undefined && value !== null && String(value).trim()) out.set(label.trim().toLowerCase(), String(value).trim());
  };
  if (Array.isArray(raw)) for (const f of raw) put((f as ActionField)?.label, (f as ActionField)?.value);
  else if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw)) put(k, v);
  return out;
}

/**
 * Turns what the model proposed into an Action a device can show, or an error the model can act on. `shipTo`: where a
 * BUY ships when its fields name no Ship address (the address the owner confirmed for this order).
 */
export async function buildAction(db: Db, owner: Account, code: unknown, rawFields: unknown, money: Money = demoMoney(), purchases?: Purchases, food?: Food, shipTo?: string): Promise<{ action: Action; prompt?: string } | string> {
  const f = readFields(rawFields);
  const fields: ActionField[] = [];
  const person = (label: string): Account | string => {
    const raw = f.get(label.toLowerCase());
    if (!raw) return `Error: ${String(code)} needs a ${label} field.`;
    const account = resolveTag(db, owner, raw);
    if (typeof account !== "string" && account.id === owner.id) return "Error: that is the owner's own account.";
    return account;
  };
  switch (code) {
    case "PAY": {
      // In Ethereum mode a raw address works too (including the owner's own, for a test transfer).
      const raw = f.get("to") ?? "";
      const to = money.mode === "eth" && /^0x[0-9a-f]{40}$/i.test(raw) ? raw : person("To");
      if (typeof to === "string" && to.startsWith("Error")) return to;
      return money.pay(owner, to, f.get("amount") ?? "", f.get("memo"));
    }
    case "CAL": {
      const title = f.get("title");
      if (!title) return "Error: CAL needs a Title.";
      const when = parseWhen(f.get("when") ?? "");
      if (!when) return "Error: When must look like 2026-10-11 12:00-13:00 (24h, local time).";
      if (f.get("with")) return "Error: CAL is for the owner's own events only. A meeting with a friend is propose_meeting, which needs no Ledger.";
      fields.push({ label: "Title", value: toFieldText(title) }, { label: "When", value: formatWhen(when.start, when.end) });
      break;
    }
    case "FRQ": {
      const to = person("To");
      if (typeof to === "string") return to;
      const fs = db.friendship(owner.id, to.id);
      if (fs?.status === "accepted") return `Error: ${to.tag} is already a friend.`;
      if (fs && fs.requested_by === owner.id) return `Error: a friend request to ${to.tag} is already waiting for them.`;
      if (fs) return `Error: ${to.tag} already sent the owner a request. Propose FAC with From ${to.tag} instead.`;
      fields.push({ label: "To", value: to.tag });
      break;
    }
    case "FAC": {
      const from = person("From");
      if (typeof from === "string") return from;
      const fs = db.friendship(owner.id, from.id);
      if (fs?.status !== "pending" || fs.requested_by !== from.id) return `Error: there is no pending friend request from ${from.tag}.`;
      fields.push({ label: "From", value: from.tag });
      break;
    }
    case "DEL": {
      // The custom AgentSign app refuses codes it does not know, so DEL exists only with the Ethereum app.
      if (money.mode !== "eth") return "Error: deleting an account is not available in this mode. Tell the owner it cannot be done here.";
      fields.push({ label: "Tag", value: owner.tag }, { label: "Address", value: owner.pubkey });
      break;
    }
    case "BUY": {
      // Paid in ETH to the treasury, so Ethereum mode only; the server quotes, caps and builds the transfer.
      if (!purchases || money.mode !== "eth") return "Error: buying on Amazon is not available on this server. Tell the owner it cannot be done here.";
      // Ships to the address named for this order, else the confirmed one, else the owner's saved one; purchases refuses without any.
      const ship = f.get("ship") ?? f.get("ship to") ?? f.get("address") ?? shipTo;
      return purchases.propose(owner, f.get("item") ?? f.get("asin") ?? "", ship ? { shipTo: ship } : undefined);
    }
    case "EAT": {
      // Paid in USDC to the treasury like BUY; the quote id names a draft from quote_doordash that only this owner can pay for.
      if (!food || money.mode !== "eth") return "Error: ordering food is not available on this server. Tell the owner it cannot be done here.";
      return food.propose(owner, f.get("order") ?? f.get("quote_id") ?? f.get("quote") ?? "");
    }
    default:
      return "Error: code must be PAY, CAL, FRQ, FAC, DEL, BUY or EAT.";
  }
  return { action: { code, id: newActionId(), fields } };
}

export function ownerTools(deps: {
  db: Db;
  approvals: Approvals;
  owner: Account;
  calendar: Calendar;
  /** Texts friends about meetings (src/meetings.ts). */
  channel: Pick<Channel, "send">;
  log?: (line: string) => void;
  messageAgent: (target: Account, text: string) => Promise<string>;
  /** Delivers a note from the owner to a friend; returns the line for the model. */
  sendNote: (target: Account, text: string) => Promise<string>;
  /** Delivers the "Please confirm on your Ledger" text (merged into the persona's reply); the device is asked after it resolves. */
  deliver?: (prompt: string) => Promise<void>;
  /** Called with each action that now waits on the owner's Ledger. */
  onProposed?: (action: Action) => void;
  /** Called with the outcome line of something done at once (a meeting step, an action the policy did not gate, a policy change). */
  onSettled?: (line: string) => void;
  /** Sends a text (a link) to the owner right under the persona's reply. */
  attach: (text: string) => Promise<void>;
  money?: Money;
  /** Buying on Amazon with ETH, where the server is set up for it. */
  purchases?: Purchases;
  /** Phone numbers for calls, where the server is set up for them. */
  phone?: PhoneLinks;
  /** Ordering food on DoorDash with USDC, where the server is set up for it (Ethereum mode only). */
  food?: Food;
  /**
   * Texts (the persona's tasks): the delivery address the owner confirmed for this order, or null when they have not.
   * Food and Amazon orders then go to it, or to an address the task names, and never fall back on the saved address
   * unconfirmed. Unset (calls, the voice tools): orders default to the saved address.
   */
  orderAddress?: string | null;
}): Tools {
  const { db, approvals, owner, calendar, purchases, phone } = deps;
  const money = deps.money ?? demoMoney();
  const food = money.mode === "eth" ? deps.food : undefined;
  // Saving the owner's own address in this task confirms it: they just gave it.
  let confirmed = deps.orderAddress;
  /**
   * Where an order goes: an address the model names (one the owner gave for this order), else the confirmed one;
   * unchecked (calls), the store's default (the saved one). The saved address copied from the facts is no way around
   * the question: unconfirmed, it gets the error that sends "Deliver to ...?" back to the owner.
   */
  const orderAddress = (given: unknown, verb: "deliver" | "ship"): { address?: string } | string => {
    const named = cleanAddress(typeof given === "string" ? given : "");
    if (confirmed === undefined) return named ? { address: named } : {};
    const saved = savedAddress(db, owner);
    const isSaved = !!named && !!saved && (mentionsAddress(saved, named) || mentionsAddress(named, saved));
    if (named && (confirmed || !isSaved)) return { address: named };
    if (confirmed) return { address: confirmed };
    if (!saved) return noAddress(verb);
    return `${UNCONFIRMED_ADDRESS} Do not search or order yet; report that you need them to confirm "${verb === "ship" ? "Ship" : "Deliver"} to ${saved}?"`;
  };
  const meetings: MeetingDeps = { db, calendar, channel: deps.channel, log: deps.log, approvals, deliver: deps.deliver, onProposed: deps.onProposed };
  const settled = (line: string) => {
    if (!/^(Error|Refused)\b/.test(line)) deps.onSettled?.(line);
    return line;
  };
  /** An accepted friend by tag, or the error line for the model. */
  const friend = (me: Account, raw: unknown, what: string): Account | string => {
    const target = resolveTag(db, me, String(raw ?? ""));
    if (typeof target === "string") return target;
    if (target.id === me.id) return "Error: that is the owner's own account.";
    if (db.friendship(me.id, target.id)?.status !== "accepted") return `Refused: ${target.tag} is not a friend, so ${what}. The owner can send a friend request (FRQ) first.`;
    return target;
  };
  return {
    specs: [
      ...OWNER_TOOL_SPECS,
      ...(purchases ? PURCHASE_TOOL_SPECS : []),
      ...(purchases || food ? [DELIVERY_ADDRESS_SPEC] : []),
      ...(food ? FOOD_TOOL_SPECS : []),
      ...(purchases || food ? [LIST_PURCHASES_SPEC] : []),
      ...(phone ? PHONE_TOOL_SPECS : []),
    ],
    async run(name, args) {
      const me = db.account(owner.id)!;
      switch (name) {
        case "link_phone":
        case "unlink_phone": {
          if (!phone) return "Error: phone calls are not set up on this server.";
          const r = name === "link_phone" ? phone.link(me.id, String(args.number ?? "")) : phone.unlink(me.id, String(args.number ?? ""));
          if (!r.ok) return `Error: ${r.reason}`;
          return settled(name === "link_phone" ? `Linked ${r.handle}: calls from it are now ${me.tag}.${phone.number ? ` They can call ${phone.number}.` : ""}` : `Unlinked ${r.handle}.`);
        }
        case "search_amazon":
          if (!purchases) return "Error: buying on Amazon is not available on this server.";
          return purchases.search(String(args.query ?? ""));
        case "list_purchases":
          if (!purchases && !food) return "Error: buying on Amazon is not available on this server.";
          // Both stores, newest first.
          return JSON.stringify([...(purchases?.list(me.id) ?? []), ...(food?.list(me.id) ?? [])].sort((a, b) => String(b.at).localeCompare(String(a.at))));
        case "set_delivery_address": {
          if (!purchases && !food) return "Error: ordering food or buying on Amazon is not available on this server.";
          const saved = saveAddress(db, me, String(args.address ?? ""), deps.log);
          if (!saved.startsWith("Error") && confirmed !== undefined) confirmed = cleanAddress(String(args.address));
          return saved;
        }
        case "search_doordash":
        case "doordash_menu":
        case "quote_doordash": {
          if (!food) return "Error: ordering food is not available on this server.";
          if (name === "doordash_menu") return food.menu(String(args.store_id ?? ""));
          const to = orderAddress(args.address, "deliver");
          if (typeof to === "string") return to;
          if (name === "search_doordash") return food.restaurants(me, String(args.query ?? ""), to.address);
          const items = Array.isArray(args.items) ? (args.items as { item_id?: unknown; quantity?: unknown }[]).map((i) => ({ itemId: String(i?.item_id ?? "").trim(), quantity: Number(i?.quantity ?? 1) })) : [];
          const tip = args.tip_percent === undefined || args.tip_percent === null || args.tip_percent === "" ? undefined : Number(args.tip_percent);
          return food.quote(me, { storeId: String(args.store_id ?? ""), items, ...(tip !== undefined ? { tipPercent: tip } : {}), ...(to.address ? { address: to.address } : {}) });
        }
        case "get_balance":
          return `Balance: ${await money.balanceText(me)}`;
        case "list_friends":
          return JSON.stringify(
            db.friendsOf(me.id).map((f) => ({
              tag: f.tag,
              status: f.status === "accepted" ? "friend" : f.requested_by === me.id ? "request sent, waiting for them" : "they asked you, not accepted yet",
            })),
          );
        case "get_calendar": {
          const r = rangeArgs(args);
          if (!r) return "Error: from and to must be YYYY-MM-DD or YYYY-MM-DDTHH:MM.";
          const google = calendar.connection(me.id);
          const { events, warning } = await calendar.events(me.id, r.from, r.to);
          return JSON.stringify({
            timezone: TIMEZONE,
            google: google ? `connected as ${google.email}` : "not connected",
            ...(warning ? { warning } : {}),
            // Google's details ride along when they exist: where, notes, who, the owner's answer, the links.
            events: events.map((e) => ({
              title: e.title, start: e.start, end: e.end, ...(e.with ? { with: e.with } : {}), ...(e.allDay ? { allDay: true } : {}), source: e.source,
              ...(e.location ? { location: e.location } : {}), ...(e.notes ? { notes: e.notes } : {}), ...(e.organizer ? { organizer: e.organizer } : {}),
              ...(e.attendees ? { attendees: e.attendees } : {}), ...(e.myStatus ? { myStatus: e.myStatus } : {}), ...(e.link ? { link: e.link } : {}), ...(e.call ? { call: e.call } : {}),
            })),
          });
        }
        case "connect_google_calendar": {
          if (!calendar.available) return "Error: Google Calendar is not set up on this server, so it cannot be connected. Tell the owner it is not available here.";
          const current = calendar.connection(me.id);
          if (current) return `Google Calendar is already connected as ${current.email}. To switch accounts, disconnect it first (disconnect_google_calendar), then connect again.`;
          await deps.attach(`Connect your Google Calendar here (the link works for 15 minutes): ${calendar.connectLink(me.id)}`);
          return "A link to connect Google Calendar goes out right under the reply. Tell the owner to open it and pick the Google account; once they do, it is connected and they get a text.";
        }
        case "disconnect_google_calendar": {
          const current = calendar.connection(me.id);
          if (!current) return "Google Calendar is not connected, so there is nothing to disconnect.";
          await calendar.disconnect(me.id);
          return `Disconnected Google Calendar (${current.email}). Events already on it stay there; new ones will only be on AgentSign.`;
        }
        case "get_notes":
          return JSON.stringify(db.notes(me.id).map((n) => n.text));
        case "remember": {
          const note = String(args.note ?? "").trim();
          if (!note) return "Error: note is empty.";
          db.addNote(me.id, note.slice(0, 500));
          return "Saved.";
        }
        case "list_transactions":
          if (money.mode === "eth") {
            return JSON.stringify(db.sentPayments(me.id).map((a) => ({ sent: a.fields.map((x) => `${x.label} ${x.value}`).join(", "), status: a.status, tx: a.tx_hash && txLink(a.tx_hash) })));
          }
          return JSON.stringify(
            db.transactions(me.id).map((t) => ({
              direction: t.from_account === me.id ? "sent" : "received",
              who: t.from_account === me.id ? t.to_tag : t.from_tag,
              amount: formatCents(t.cents),
              memo: t.memo ?? undefined,
              at: t.created_at,
            })),
          );
        case "send_note": {
          const target = resolveTag(db, me, String(args.tag ?? ""));
          if (typeof target === "string") return target;
          if (target.id === me.id) return "Error: that is the owner's own account.";
          if (db.friendship(me.id, target.id)?.status !== "accepted") {
            return `Refused: ${target.tag} is not a friend, so no note can reach them. The owner can send a friend request (FRQ) first.`;
          }
          const text = String(args.text ?? "").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
          if (!text) return "Error: text is empty.";
          return deps.sendNote(target, text);
        }
        case "message_agent": {
          const target = friend(me, args.tag, "their agent will not talk to you");
          if (typeof target === "string") return target;
          const text = String(args.text ?? "").trim();
          if (!text) return "Error: text is empty.";
          return deps.messageAgent(target, text);
        }
        case "propose_meeting": {
          const target = friend(me, args.tag, "no meeting can be arranged with them");
          if (typeof target === "string") return target;
          const from = stampArg(args.from, "09:00");
          const to = stampArg(args.to, "17:00");
          if (!from || !to) return "Error: from and to must be YYYY-MM-DD HH:MM (local time): the window the owner is open to.";
          const duration = args.duration_minutes === undefined || args.duration_minutes === null || args.duration_minutes === "" ? 30 : Number(args.duration_minutes);
          if (!Number.isInteger(duration) || duration < MIN_DURATION_MIN || duration > MAX_DURATION_MIN) return `Error: duration_minutes must be ${MIN_DURATION_MIN} to ${MAX_DURATION_MIN}.`;
          if (Date.parse(`${to}:00Z`) - Date.parse(`${from}:00Z`) < duration * 60_000) return `Error: the window ${from.replace("T", " ")} to ${to.replace("T", " ")} is shorter than ${duration} minutes.`;
          const preferred = stampArg(args.preferred, "");
          return settled(await proposeMeeting(meetings, me, { friend: target, title: String(args.title ?? ""), from, to, durationMin: duration, ...(preferred && preferred.length === 16 ? { preferred } : {}) }));
        }
        case "answer_meeting": {
          const target = friend(me, args.tag, "no meeting is being arranged with them");
          if (typeof target === "string") return target;
          const meeting = db.openMeetingBetween(me.id, target.id);
          if (!meeting) return `Error: no meeting is being arranged with ${target.tag}. To set one up, call propose_meeting.`;
          const kind = String(args.answer ?? "").trim().toLowerCase();
          let answer: Answer;
          if (kind === "yes") answer = { kind: "yes" };
          else if (kind === "no") answer = { kind: "no" };
          else if (kind === "another time") {
            const raw = String(args.when ?? "").trim();
            const range = parseWhen(raw);
            const start = range?.start ?? stampArg(raw, "");
            if (!start || start.length !== 16) return "Error: when must be YYYY-MM-DD HH:MM-HH:MM, or just the start as YYYY-MM-DD HH:MM for the same length.";
            answer = { kind: "counter", start, end: range?.end ?? addMinutes(start, meeting.duration_min) };
          } else return "Error: answer must be yes, no or another time.";
          return settled((await answerMeeting(meetings, me, meeting, answer)).line);
        }
        case "set_ledger_policy": {
          const change: Parameters<typeof changePolicy>[1] = {};
          if (args.preset !== undefined && args.preset !== null && args.preset !== "") {
            if (!isPreset(args.preset)) return "Error: preset must be relaxed, standard or strict.";
            change.preset = args.preset;
          }
          for (const g of GUARDS) if (typeof args[g] === "boolean") change[g] = args[g] as boolean;
          if (!change.preset && !GUARDS.some((g) => g in change)) return "Error: give a preset (relaxed, standard, strict) or one of calendar, meetings, friends as true or false.";
          const next = changePolicy(policyOf(me), change);
          db.setPolicy(me.id, JSON.stringify(next));
          deps.log?.(`policy for ${me.tag}: ${describePolicy(next)}`);
          return settled(`Ledger policy is now ${describePolicy(next)} Takes effect right away.`);
        }
        case "propose_action": {
          let shipTo: string | undefined;
          if (args.code === "BUY" && purchases && money.mode === "eth") {
            const f = readFields(args.fields);
            const to = orderAddress(f.get("ship") ?? f.get("ship to") ?? f.get("address"), "ship");
            if (typeof to === "string") return to;
            shipTo = to.address;
          }
          const proposal = await buildAction(db, me, args.code, args.fields, money, purchases, food, shipTo);
          if (typeof proposal === "string") return proposal;
          const { action, prompt } = proposal;
          const guard = guardOf(action.code);
          if (guard && !requiresLedger(me, guard)) {
            const r = await executeDirectly({ db, calendar, channel: deps.channel, log: deps.log }, me, action);
            return settled(r.ok ? `${r.line} Done at once: ${me.tag}'s Ledger policy does not ask the Ledger for this.` : r.line);
          }
          try {
            await approvals.request(me.id, action, { reason: "agent", ...(prompt ? { prompt } : {}), ...(deps.deliver ? { deliver: deps.deliver } : {}) });
          } catch (err) {
            if ((err as Error).message === PENDING_ERROR) {
              if (action.code === "BUY") purchases?.cancel(action.id);
              if (action.code === "EAT") food?.cancel(action.id);
              const pending = db.pendingAction(me.id);
              const what = pending ? ` (${describeAction({ code: pending.code as Action["code"], id: pending.id, fields: pending.fields }, ACTION_TITLES)})` : "";
              return `Error: ${PENDING_ERROR}${what} on the owner's Ledger before proposing another action.`;
            }
            throw err;
          }
          deps.onProposed?.(action);
          return `Proposed: ${describeAction(action, ACTION_TITLES)}. It waits on the owner's Ledger and is NOT done until they approve it there.`;
        }
        default:
          return `Error: unknown tool ${name}.`;
      }
    },
  };
}
