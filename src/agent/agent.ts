/** Shared by the persona and the engine: the tool loop and persisted history. Plus peer turns between two friends' agents. */
import type { Approvals } from "../approvals.js";
import { describeAction } from "../actions.js";
import { createCalendar, type Calendar } from "../calendar/google.js";
import type { Money } from "../money.js";
import type { Food } from "../food/food.js";
import type { PhoneLinks } from "../phone.js";
import { purchasesFact, type Purchases } from "../purchases.js";
import type { Account, Db } from "../db.js";
import { formatDay, localNow, TIMEZONE } from "../format.js";
import { meetingFacts } from "../meetings.js";
import { describePolicy, policyOf } from "../policy.js";
import { ACTION_TITLES, type Action, type Channel } from "../types.js";
import { firstName, withUsername } from "./bot.js";
import { freeBusy, PEER_TOOL_SPECS, type Tools } from "./tools.js";
import type { ChatMessage, Model } from "./xai.js";

export interface AgentDeps {
  db: Db;
  model: Model;
  approvals: Approvals;
  channel: Pick<Channel, "send">;
  log?: (line: string) => void;
  money?: Money;
  /** Model for the persona's calls (see CompleteRequest.model). Unset: the main model. */
  personaModel?: string;
  /** The owners' calendars (AgentSign's own events plus Google once connected). Unset: AgentSign's own events only. */
  calendar?: Calendar;
  /** Buying on Amazon with ETH (src/purchases.ts). Unset: not available. */
  purchases?: Purchases;
  /** Phone numbers linked for calls (src/phone.ts). Unset: calls are not available. */
  phone?: PhoneLinks;
  /** Ordering food on DoorDash with USDC (src/food/). Unset: not available. */
  food?: Food;
}

/** Food ordering where it works: it pays in USDC on Base, so demo money (the custom app) never offers it. */
export const foodOf = (deps: Pick<AgentDeps, "food" | "money">): Food | undefined => (deps.money?.mode === "eth" ? deps.food : undefined);

/** The calendar behind these deps; without one, AgentSign's own events table alone. */
export const calendarOf = (deps: Pick<AgentDeps, "db" | "calendar">): Calendar => deps.calendar ?? createCalendar({ db: deps.db });

const PEER_MAX_STEPS = 4;
const HISTORY = 30;

export const nameOf = (tag: string) => tag.slice(1, 2).toUpperCase() + tag.slice(2);
export const nowLine = () => {
  const now = localNow();
  return `Now: ${formatDay(now)} ${now.slice(11)} (${TIMEZONE}). Today is ${now.slice(0, 10)}. All times are local to that zone.`;
};

/** True when some sentence says an action was proposed or now waits on the Ledger, without a negation ("not proposed"). */
export function claimsProposal(text: string): boolean {
  return text
    .split(/(?<=[.!?])\s+|\n/)
    .some((s) => /\bpropos|\bwaits? on (the|their|your) ledger|\b(confirm|approve|check) (it |that |this )?on (the|their|your) ledger|\bcheck your ledger/i.test(s) && !/\b(not|no|nothing|never|couldn'?t|didn'?t|can'?t|cannot|won'?t|wasn'?t)\b/i.test(s));
}

/** What both the persona and the engine know about the owner at the start of a turn, as prompt lines. */
export function ownerFacts(db: Db, owner: Account, balance: string, calendar?: Calendar, purchases?: Purchases, phone?: PhoneLinks, food?: Pick<Food, "fact">): string[] {
  const friends = db.friendsOf(owner.id);
  const google = calendar?.connection(owner.id);
  const googleLine = !calendar
    ? ""
    : google
      ? `Google Calendar: connected as ${google.email}. get_calendar shows its events, and events AgentSign books (approved on the Ledger, or meetings both friends said yes to) land there too.`
      : calendar.available
        ? `Google Calendar: not connected. ${owner.tag} can ask to connect it (connect_google_calendar sends them a link).`
        : "Google Calendar: not available on this server.";
  const accepted = friends.filter((f) => f.status === "accepted").map((f) => f.tag);
  const incoming = friends.filter((f) => f.status === "pending" && f.requested_by === f.id).map((f) => f.tag);
  const outgoing = friends.filter((f) => f.status === "pending" && f.requested_by === owner.id).map((f) => f.tag);
  const others = db.accounts().filter((a) => a.id !== owner.id).map(withUsername);
  const pending = db.pendingAction(owner.id);
  const notes = db.notes(owner.id).map((n) => `- ${n.text}`);
  return [
    nowLine(),
    `Balance: ${balance}.`,
    `Friends (their agents can talk to ${owner.tag}'s): ${accepted.join(", ") || "none yet"}.`,
    incoming.length ? `Friend requests waiting for ${owner.tag} to accept: ${incoming.join(", ")}.` : "",
    outgoing.length ? `Friend requests ${owner.tag} sent, not accepted yet: ${outgoing.join(", ")}.` : "",
    `People on AgentSign: ${others.join(", ") || "nobody else yet"}.`,
    `Waiting on ${owner.tag}'s Ledger: ${pending ? describeAction({ code: pending.code as Action["code"], id: pending.id, fields: pending.fields }, ACTION_TITLES) : "nothing"}.`,
    ...meetingFacts(db, owner),
    `Ledger policy, ${describePolicy(policyOf(owner))} ${owner.tag} can change it by asking (set_ledger_policy): a preset (relaxed, standard, strict) or one thing at a time.`,
    googleLine,
    purchasesFact(purchases, owner),
    purchasesFact(food, owner, "EAT"),
    phoneFact(phone, owner),
    notes.length ? `Notes saved about ${owner.tag}:\n${notes.join("\n")}` : "",
  ].filter(Boolean);
}

/** The phone line of the facts: the number to call and which of the owner's numbers are linked (recognised as them). */
export function phoneFact(phone: PhoneLinks | undefined, owner: Account): string {
  if (!phone) return "";
  const linked = phone.numbersOf(owner.id);
  const call = phone.number ? `${owner.tag} can call you at ${phone.number} and talk instead of typing; a call can do everything a text can.` : "Phone calls are set up but have no number yet.";
  const numbers = linked.length
    ? `Linked phone numbers (calls from these are ${owner.tag}): ${linked.join(", ")}. They can unlink one (unlink_phone).`
    : `No phone number is linked yet, so a call from ${owner.tag} is not recognised. To link one: they tell you their number (link_phone), or they call and text back the four-digit code they hear.`;
  return `Phone: ${call} ${numbers}`;
}

function peerSystemPrompt(target: Account, fromTag: string): string {
  return [
    `You are the AgentSign agent of ${target.tag}. You are talking to ${fromTag}'s agent, agent to agent. No human reads this thread.`,
    nowLine(),
    `Share only availability. Use get_free_busy and answer with free time. Never reveal event titles, notes, money, contacts, or anything else about ${target.tag}.`,
    "Be brief. When asked to find time, propose up to 3 concrete free slots as YYYY-MM-DD HH:MM-HH:MM inside the window asked (default 09:00-18:00).",
    `You cannot book anything. Meetings are arranged by ${fromTag}'s side with propose_meeting, which reads both calendars' free/busy itself; ${target.tag} then says yes or no by text.`,
    "Plain text, no markdown.",
  ].join("\n");
}

export interface LoopOptions {
  system: string;
  messages: ChatMessage[];
  tools: Tools;
  maxSteps: number;
  /** Sees every new assistant and tool message. */
  persist?: (m: ChatMessage) => void;
  /** May reject a final answer once with a correction for the model (not persisted). */
  review?: (text: string) => string | undefined;
  /** Checked after each tool step: a string ends the loop with that text (not persisted). */
  stop?: () => string | undefined;
  /** Returned when the model is still calling tools after maxSteps. */
  giveUp: string;
  /** Model override for this loop (see CompleteRequest.model). */
  model?: string;
}

/** Runs the model with tools until it answers in text. */
export async function toolLoop(deps: Pick<AgentDeps, "model" | "log">, o: LoopOptions): Promise<string> {
  const { messages, tools } = o;
  const persist = o.persist ?? (() => {});
  let reviewed = false;
  for (let step = 0; step < o.maxSteps; step++) {
    const started = Date.now();
    const res = await deps.model.complete({ system: o.system, messages, tools: tools.specs, ...(o.model ? { model: o.model } : {}) });
    deps.log?.(`model ${Date.now() - started}ms: ${res.toolCalls.length ? res.toolCalls.map((c) => `${c.name}(${c.arguments})`).join(" ") : JSON.stringify(res.text)}`);
    if (!res.toolCalls.length) {
      const text = res.text.trim() || "OK.";
      const correction = reviewed ? undefined : o.review?.(text);
      if (correction) {
        reviewed = true;
        deps.log?.(`review: ${correction}`);
        messages.push({ role: "system", content: correction });
        continue;
      }
      persist({ role: "assistant", content: text });
      return text;
    }
    const assistant: ChatMessage = { role: "assistant", content: res.text, toolCalls: res.toolCalls };
    messages.push(assistant);
    persist(assistant);
    for (const call of res.toolCalls) {
      let result: string;
      try {
        const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
        result = await tools.run(call.name, args && typeof args === "object" ? args : {});
      } catch (err) {
        deps.log?.(`tool ${call.name} failed: ${(err as Error).stack ?? err}`);
        result = err instanceof SyntaxError ? "Error: arguments were not valid JSON." : "Error: the tool failed. Try something else or report it.";
      }
      const tool: ChatMessage = { role: "tool", toolCallId: call.id, content: result };
      messages.push(tool);
      persist(tool);
    }
    const stopped = o.stop?.();
    if (stopped !== undefined) return stopped;
  }
  return o.giveUp;
}

/**
 * Last messages for the model, starting at a user message or a system note (a friend's note, an outcome) so no tool
 * result is orphaned. Notes and call texts that landed while tool calls were still open are moved after the tool results.
 * Old images become a marker. Tool calls other than `keepTools` (from an older agent layout) are dropped with their results.
 */
export function history(db: Db, accountId: number, keepTools: string[]): ChatMessage[] {
  const rows = db.recentMessages(accountId, HISTORY).map((r) => r.content as ChatMessage);
  const dropped = new Set<string>();
  const out: ChatMessage[] = [];
  const held: ChatMessage[] = [];
  let open = 0;
  const opens = (m: ChatMessage) => m.role === "user" || m.role === "system";
  for (let m of rows.slice(Math.max(0, rows.findIndex(opens)))) {
    if (out.length === 0 && !opens(m)) continue;
    if (m.role === "assistant" && m.toolCalls?.length) {
      const keep = m.toolCalls.filter((c) => keepTools.includes(c.name));
      for (const c of m.toolCalls) if (!keep.includes(c)) dropped.add(c.id);
      if (!keep.length && !m.content) continue;
      m = keep.length ? { ...m, toolCalls: keep } : { role: "assistant", content: m.content };
    }
    if (m.role === "tool" && dropped.has(m.toolCallId)) continue;
    // Also a plain assistant text written from outside the turn (text_owner during a call) while tool calls were open.
    if ((m.role === "system" || (m.role === "assistant" && !m.toolCalls?.length)) && open > 0) {
      held.push(m);
      continue;
    }
    out.push(m.role === "user" && m.images?.length ? { role: "user", content: `${m.content} [sent ${m.images.length} image(s)]` } : m);
    if (m.role === "assistant") open = m.toolCalls?.length ?? 0;
    if (m.role === "tool") open = Math.max(0, open - 1);
    if (open === 0) out.push(...held.splice(0));
  }
  return [...out, ...held];
}

/**
 * A note from one friend to another, texted to the recipient by their own Jarvis ("@matt says: ...") and kept in the
 * recipient's history so their next turn can quote it or answer it. Returns the line for the sender's engine.
 */
export async function deliverNote(deps: Pick<AgentDeps, "db" | "channel">, from: Account, target: Account, text: string): Promise<string> {
  const { db } = deps;
  if (db.friendship(from.id, target.id)?.status !== "accepted") return `Refused: ${target.tag} is not a friend, so no note can reach them.`;
  const handle = db.primaryHandle(target.id);
  if (!handle) return `Error: ${target.tag} cannot be reached right now.`;
  await deps.channel.send(handle, `${from.tag} says: ${text}`);
  db.addMessage(target.id, "system", { role: "system", content: `${from.tag} sent ${firstName(target)} a note, delivered as a text: "${text}"` });
  return `Delivered to ${target.tag} as a text from their Jarvis: "${text}"`;
}

/** `fromTag`'s agent sends `text` to `target`'s agent. Returns the reply. Only free/busy is available to the target's agent. */
export async function runPeerTurn(deps: AgentDeps, target: Account, fromTag: string, text: string): Promise<string> {
  const { db } = deps;
  const from = db.accountByTag(fromTag);
  if (!from || db.friendship(from.id, target.id)?.status !== "accepted") {
    return `Refused: ${target.tag}'s agent only talks to friends' agents.`;
  }
  db.addPeerMessage(fromTag, target.tag, text);
  const messages: ChatMessage[] = db
    .peerThread(fromTag, target.tag)
    .map((m) => (m.from_tag === target.tag ? { role: "assistant", content: m.text } : { role: "user", content: m.text }));
  const tools: Tools = {
    specs: PEER_TOOL_SPECS,
    run: async (name, args) => (name === "get_free_busy" ? freeBusy(calendarOf(deps), target.id, args) : `Error: unknown tool ${name}.`),
  };
  const reply = await toolLoop(deps, { system: peerSystemPrompt(target, fromTag), messages, tools, maxSteps: PEER_MAX_STEPS, giveUp: "I could not check the calendar just now." });
  db.addPeerMessage(target.tag, fromTag, reply);
  return reply;
}
