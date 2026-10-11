/**
 * Meetings between friends: arranged agent to agent, confirmed by the people in plain texts, never on a Ledger.
 *
 * The asker's engine calls propose(): both calendars are read (the friend's as free/busy only), and the slot free for
 * both inside the window the asker is open to, nearest the time they named, goes to the friend as one text. The friend
 * answers yes, no, or another time. Yes books it on both calendars. A counter inside the asker's window books it too:
 * the asker already said any time there works. A counter outside goes back to the asker, who answers the same way.
 * Nothing is written to any calendar until a person on each side has said yes to the slot. An owner whose Ledger
 * policy covers meetings (src/policy.ts) gets their side as a CAL on their Ledger at that point, instead of at once.
 */
import { describeAction, newActionId, toFieldText } from "./actions.js";
import { firstName } from "./agent/bot.js";
import type { Approvals } from "./approvals.js";
import type { Calendar, Interval } from "./calendar/google.js";
import type { Account, Db, Meeting } from "./db.js";
import { addMinutes, formatDay, formatWhen, localNow } from "./format.js";
import { requiresLedger } from "./policy.js";
import { ACTION_TITLES, type Action, type Channel } from "./types.js";

export interface MeetingDeps {
  db: Db;
  calendar: Pick<Calendar, "busy" | "afterEvent">;
  channel: Pick<Channel, "send">;
  /** For a side whose policy sends meetings to the Ledger: their CAL is requested here when the meeting is booked. */
  approvals: Pick<Approvals, "request">;
  /** Delivers the answering owner's own Ledger prompt under the reply being composed (engine context); unset: texted on its own. */
  deliver?: (prompt: string) => Promise<void>;
  /** Called when the answering owner's own CAL now waits on their Ledger. */
  onProposed?: (action: Action) => void;
  log?: (line: string) => void;
  /** The current local time as "YYYY-MM-DDTHH:MM" (tests). */
  now?: () => string;
}

export interface ProposeInput {
  friend: Account;
  title: string;
  /** The window the owner is open to, local stamps. An exact time is a window the size of the meeting. */
  from: string;
  to: string;
  durationMin: number;
  /** The start the owner named inside a wider window ("around 9" -> 09:00): the free slot nearest it is offered. */
  preferred?: string;
}

export type Answer = { kind: "yes" } | { kind: "no" } | { kind: "counter"; start: string; end: string };

export interface AnswerResult {
  /** The plain-fact line for the engine. */
  line: string;
  /** What to text the person who answered, when no persona is composing a reply (the yes/no shortcut). */
  reply: string;
  /** The answer changed something (booked, offered, declined); false for an error line. */
  ok: boolean;
}

/** Candidate starts fall on these boundaries. */
const STEP_MIN = 15;
/** Inside a window longer than a day, only these hours are offered. */
const DAY_START = "08:00";
const DAY_END = "21:00";
export const MIN_DURATION_MIN = 5;
export const MAX_DURATION_MIN = 8 * 60;
const DEFAULT_TITLE = "Meeting";
const TITLE_MAX = 60;

const whenOf = (m: Pick<Meeting, "starts_at" | "ends_at">) => formatWhen(m.starts_at, m.ends_at);

/** "Mon Oct 12 09:00-17:00", or "Mon Oct 12 2026 09:00 to Fri Oct 16 2026 17:00" across days. */
export function formatWindow(from: string, to: string): string {
  const sameDay = from.slice(0, 10) === to.slice(0, 10) || (to.slice(11) === "00:00" && addMinutes(to, -1).slice(0, 10) === from.slice(0, 10));
  return sameDay ? formatWhen(from, to) : `${formatDay(from)} ${from.slice(11)} to ${formatDay(to)} ${to.slice(11)}`;
}

/** The next slot boundary at or after `stamp`. */
function ceilToStep(stamp: string): string {
  const minute = Number(stamp.slice(14, 16));
  const over = minute % STEP_MIN;
  return over ? addMinutes(stamp, STEP_MIN - over) : stamp;
}

/** Starts of every slot of `durationMin` inside [from, to) that is not in the past and overlaps nothing in `busy`. */
export function freeSlots(busy: Interval[], from: string, to: string, durationMin: number, now: string): string[] {
  const out: string[] = [];
  const multiDay = from.slice(0, 10) !== addMinutes(to, -1).slice(0, 10);
  for (let start = ceilToStep(from > now ? from : now); addMinutes(start, durationMin) <= to; start = addMinutes(start, STEP_MIN)) {
    const end = addMinutes(start, durationMin);
    if (multiDay && (start.slice(11) < DAY_START || end.slice(11) > DAY_END || end.slice(0, 10) !== start.slice(0, 10))) continue;
    if (busy.some((b) => b.start < end && b.end > start)) continue;
    out.push(start);
  }
  return out;
}

/** The slot nearest `preferred` (earlier wins a tie), or the earliest. */
export function pickSlot(slots: string[], preferred?: string): string {
  if (!preferred) return slots[0]!;
  const ms = (s: string) => Date.parse(`${s}:00Z`);
  const distance = (s: string) => Math.abs(ms(s) - ms(preferred));
  return [...slots].sort((a, b) => distance(a) - distance(b) || (a < b ? -1 : 1))[0]!;
}

/** A short title without the friend's name on it (each side's calendar says who it is with). */
export function cleanTitle(raw: string, friend: Account): string {
  let title = raw.replace(/\s+/g, " ").trim().replace(/^['"]|['"]$/g, "").trim();
  const name = friend.display_name?.split(/\s+/)[0] ?? "";
  const tails = [friend.tag, friend.tag.slice(1), friend.username ? `@${friend.username}` : "", friend.username ?? "", name].filter(Boolean);
  for (const tail of tails) {
    const re = new RegExp(`\\s+(?:with|w/)\\s+${tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
    title = title.replace(re, "");
  }
  title = title.trim().replace(/^(a|the)\s+/i, "");
  if (!title) return DEFAULT_TITLE;
  return (title[0]!.toUpperCase() + title.slice(1)).slice(0, TITLE_MAX);
}

/** Busy intervals of both people in [from, to), plus a warning when a Google Calendar could not be read. */
async function bothBusy(deps: MeetingDeps, a: Account, b: Account, from: string, to: string): Promise<{ busy: Interval[]; warning: string }> {
  const [ra, rb] = await Promise.all([deps.calendar.busy(a.id, from, to), deps.calendar.busy(b.id, from, to)]);
  const warning = [ra.warning ? `${a.tag}: ${ra.warning}` : "", rb.warning ? `${b.tag}: ${rb.warning}` : ""].filter(Boolean).join(" ");
  return { busy: [...ra.busy, ...rb.busy], warning };
}

/** Whoever is busy during [start, end), checked again right before anything is booked. */
async function conflict(deps: MeetingDeps, a: Account, b: Account, start: string, end: string): Promise<Account | undefined> {
  const [ra, rb] = await Promise.all([deps.calendar.busy(a.id, start, end), deps.calendar.busy(b.id, start, end)]);
  return ra.busy.length ? a : rb.busy.length ? b : undefined;
}

/** Up to three slots free for both on the day of `stamp`, 08:00-21:00, as "Mon Oct 12 10:00-10:30". */
async function alternatives(deps: MeetingDeps, a: Account, b: Account, stamp: string, durationMin: number, now: string): Promise<string[]> {
  const day = stamp.slice(0, 10);
  const { busy } = await bothBusy(deps, a, b, `${day}T${DAY_START}`, `${day}T${DAY_END}`);
  return freeSlots(busy, `${day}T${DAY_START}`, `${day}T${DAY_END}`, durationMin, now)
    .slice(0, 3)
    .map((s) => formatWhen(s, addMinutes(s, durationMin)));
}

/** Texts `account` and keeps the same line in their chat history, so their next turn knows. */
async function tell(deps: MeetingDeps, account: Account, text: string, note = text): Promise<void> {
  deps.db.addMessage(account.id, "system", { role: "system", content: note });
  const handle = deps.db.primaryHandle(account.id);
  if (!handle) return;
  await deps.channel.send(handle, text).catch((err: unknown) => deps.log?.(`meeting: text to ${account.tag} failed: ${(err as Error).message}`));
}

/** A note in the owner's own history (their reply comes from the persona or the shortcut, not from here). */
const note = (deps: MeetingDeps, account: Account, text: string) => deps.db.addMessage(account.id, "system", { role: "system", content: text });

/**
 * The owner asks to meet a friend: find a slot free for both and put it to the friend. Returns the line for the engine.
 * The owner is not texted here; the persona's reply covers it.
 */
export async function proposeMeeting(deps: MeetingDeps, owner: Account, input: ProposeInput): Promise<string> {
  const { db } = deps;
  const now = deps.now?.() ?? localNow();
  const { friend, durationMin } = input;
  const name = firstName(owner);
  if (db.friendship(owner.id, friend.id)?.status !== "accepted") {
    return `Refused: ${friend.tag} is not a friend, so no meeting can be arranged with them. The owner can send a friend request (FRQ) first.`;
  }
  if (input.to <= input.from) return "Error: the window ends before it starts.";
  if (input.to <= now) return `Error: that window is already over; now is ${formatDay(now)} ${now.slice(11)}. Ask ${name} for another time.`;
  const title = cleanTitle(input.title, friend);
  const { busy, warning } = await bothBusy(deps, owner, friend, input.from, input.to);
  const slots = freeSlots(busy, input.from, input.to, durationMin, now);
  if (!slots.length) {
    const alt = await alternatives(deps, owner, friend, input.from, durationMin, now);
    return (
      `Error: no ${durationMin}-minute slot in ${formatWindow(input.from, input.to)} is free for both ${name} and ${friend.tag}.` +
      (alt.length ? ` Free for both that day: ${alt.join(", ")}.` : " Nothing else is free for both that day either.") +
      ` Ask ${name} which time to offer; propose_meeting again with it.` +
      (warning ? ` Warning: ${warning}` : "")
    );
  }
  const start = pickSlot(slots, input.preferred);
  const end = addMinutes(start, durationMin);
  const when = formatWhen(start, end);
  // One open meeting per pair: a new proposal replaces whatever was on the table.
  const open = db.openMeetingBetween(owner.id, friend.id);
  if (open) db.setMeetingStatus(open.id, "cancelled");
  db.insertMeeting({
    proposer_id: owner.id, invitee_id: friend.id, title, starts_at: start, ends_at: end,
    window_from: input.from, window_to: input.to, duration_min: durationMin, offered_by: owner.id, awaiting: friend.id,
  });
  // The exchange between the two agents, on the record (free/busy only, no titles from the friend's side).
  const shown = slots.slice(0, 6).map((s) => s.slice(11));
  db.addPeerMessage(owner.tag, friend.tag, `${name} would like ${durationMin} minutes for '${title}' in ${formatWindow(input.from, input.to)}.${input.preferred ? ` Ideally around ${input.preferred.slice(11)}.` : ""}`);
  db.addPeerMessage(friend.tag, owner.tag, `Free for both on ${formatDay(start)}: ${shown.join(", ")}${slots.length > shown.length ? " and more" : ""}. Offering ${when} to ${firstName(friend)}.`);
  deps.log?.(`meeting: ${owner.tag} -> ${friend.tag} '${title}' ${when}${open ? " (replaces an earlier proposal)" : ""}`);
  const wider = input.from < start || input.to > end;
  const text =
    `${owner.tag} would like to meet: '${title}' ${when}${open ? ` (instead of ${whenOf(open)})` : ""}.` +
    (wider ? ` Any time ${formatWindow(input.from, input.to)} works for ${name}.` : "") +
    " Reply 'yes' and it goes on both calendars, or name another time.";
  await tell(deps, friend, text, `${text} (A plain yes or no is handled before you see it; anything else about this meeting: delegate it to answer_meeting.)`);
  note(deps, owner, `Proposed '${title}' ${when} to ${friend.tag}; waiting for their answer. Nothing is on either calendar yet.`);
  return (
    `Proposed to ${friend.tag}: '${title}' ${when}, free for both.${warning ? ` Warning: ${warning}.` : ""} ` +
    `${friend.tag} was texted and must say yes before it is booked; nothing is on any calendar yet. ${name} will be texted when they answer.`
  );
}

/** This side's calendar entry as a Ledger action, for an owner whose policy sends meetings there. */
function calAction(meeting: Meeting, start: string, end: string, withTag: string): Action {
  return { code: "CAL", id: newActionId(), fields: [{ label: "Title", value: toFieldText(meeting.title) }, { label: "When", value: formatWhen(start, end) }, { label: "With", value: withTag }] };
}

/**
 * Books the meeting: confirmed in one transaction with the event on each side whose policy does not gate meetings
 * (Google mirrored); a side whose policy does gets their CAL on their Ledger instead. Texts the other side, notes both.
 */
async function book(deps: MeetingDeps, meeting: Meeting, who: Account, other: Account, start: string, end: string, howCome: string): Promise<AnswerResult> {
  const { db } = deps;
  const proposer = who.id === meeting.proposer_id ? who : other;
  const invitee = proposer === who ? other : who;
  const gated = (a: Account) => requiresLedger(a, "meetings");
  db.tx(() => {
    db.offerMeetingSlot(meeting.id, start, end, who.id, who.id);
    if (!gated(proposer)) db.addEvent(proposer.id, meeting.title, start, end, invitee.tag, null);
    if (!gated(invitee)) db.addEvent(invitee.id, meeting.title, start, end, proposer.tag, null);
    db.setMeetingStatus(meeting.id, "confirmed");
  });
  const when = formatWhen(start, end);
  deps.log?.(`meeting: booked '${meeting.title}' ${when} for ${proposer.tag}${gated(proposer) ? " (Ledger)" : ""} and ${invitee.tag}${gated(invitee) ? " (Ledger)" : ""}`);
  // Google is a mirror: a failure there is a line in the text, never a failed booking. A gated side mirrors after its Ledger.
  const [gWho, gOther] = await Promise.all([gated(who) ? undefined : deps.calendar.afterEvent(who.id), gated(other) ? undefined : deps.calendar.afterEvent(other.id)]);
  const where = (me: Account, them: Account) =>
    gated(them) ? `is on your calendar; ${them.tag}'s side goes on theirs once they confirm it on their Ledger` : gated(me) ? `is on ${them.tag}'s calendar` : "is on both calendars";
  // The answering side: a text of their own, or their Ledger prompt under the reply being composed.
  let reply = `Done: '${meeting.title}' with ${other.tag}, ${when}, ${where(who, other)}.${gWho ? ` ${gWho}` : ""}`;
  if (gated(who)) {
    const action = calAction(meeting, start, end, other.tag);
    const lead = `Done: '${meeting.title}' with ${other.tag}, ${when}${gated(other) ? "" : `, is on ${other.tag}'s calendar`}.`;
    await deps.approvals.request(who.id, action, { reason: "meeting policy", prompt: `${lead} Your Ledger policy asks you to confirm it before it goes on your calendar: ${describeAction(action, ACTION_TITLES)}`, deliver: deps.deliver });
    deps.onProposed?.(action);
    reply = "";
  } else note(deps, who, reply);
  // The other side: a text, or their Ledger prompt on its own.
  if (gated(other)) {
    const action = calAction(meeting, start, end, who.tag);
    const lead = `${howCome}: '${meeting.title}' with ${who.tag}, ${when}${gated(who) ? "" : `, is on ${who.tag}'s calendar`}.`;
    await deps.approvals.request(other.id, action, { reason: "meeting policy", prompt: `${lead} Your Ledger policy asks you to confirm it before it goes on your calendar: ${describeAction(action, ACTION_TITLES)}` });
  } else await tell(deps, other, `${howCome}: '${meeting.title}' with ${who.tag}, ${when}, ${where(other, who)}.${gOther ? ` ${gOther}` : ""}`);
  const mine = gated(who) ? `waits on ${firstName(who)}'s Ledger (their policy asks for that; the prompt goes out with the reply)` : `is on ${firstName(who)}'s calendar`;
  const theirs = gated(other) ? `${other.tag} confirms their side on their Ledger (their policy)` : `on ${other.tag}'s calendar`;
  const status = gated(who) || gated(other) ? `: ${mine}; ${theirs}.` : ", is on both calendars.";
  return { ok: true, reply, line: `Booked: '${meeting.title}' with ${other.tag}, ${when}${status}${gWho ? ` ${gWho}` : ""} ${other.tag} was texted.` };
}

/** A side whose policy sends meetings to the Ledger cannot be asked while something else waits there. */
function ledgerBusy(deps: MeetingDeps, who: Account, other: Account): string | undefined {
  const blocked = [who, other].find((a) => requiresLedger(a, "meetings") && deps.db.pendingAction(a.id));
  if (!blocked) return undefined;
  const whose = blocked.id === who.id ? `${firstName(who)}'s` : `${other.tag}'s`;
  return `Error: ${whose} Ledger already has something waiting, and their policy asks it to confirm meetings, so this cannot be booked right now. Try again once that is done.`;
}

/** `who` answers the meeting on the table with `other`: yes, no, or a different slot. */
export async function answerMeeting(deps: MeetingDeps, who: Account, meeting: Meeting, answer: Answer): Promise<AnswerResult> {
  const { db } = deps;
  const now = deps.now?.() ?? localNow();
  const name = firstName(who);
  const other = db.account(who.id === meeting.proposer_id ? meeting.invitee_id : meeting.proposer_id);
  const label = `'${meeting.title}'`;
  const when = whenOf(meeting);
  const fail = (line: string): AnswerResult => ({ ok: false, line, reply: line });
  if (meeting.status !== "proposed") return fail(`Error: ${label} ${when} is already ${meeting.status}.`);
  if (!other) {
    db.setMeetingStatus(meeting.id, "cancelled");
    return fail(`Error: the other account no longer exists, so ${label} is off.`);
  }
  const waitingOnMe = meeting.awaiting === who.id;
  switch (answer.kind) {
    case "no": {
      db.setMeetingStatus(meeting.id, waitingOnMe ? "declined" : "cancelled");
      deps.log?.(`meeting: ${who.tag} ${waitingOnMe ? "declined" : "withdrew"} '${meeting.title}' ${when} with ${other.tag}`);
      await tell(deps, other, waitingOnMe ? `${who.tag} can't make ${label} ${when}. Ask me to try another time.` : `${who.tag} withdrew ${label} ${when}. Nothing is on either calendar.`);
      const line = `${waitingOnMe ? "Declined" : "Withdrawn"}: ${label} ${when} with ${other.tag}. ${other.tag} was told. Nothing is on either calendar.`;
      note(deps, who, line);
      return { ok: true, line, reply: `Understood. I told ${other.tag}${waitingOnMe ? " you can't make it" : ""}. Nothing is on either calendar.` };
    }
    case "yes": {
      if (!waitingOnMe) return fail(`Error: ${label} ${when} is ${name}'s own offer, waiting for ${other.tag}'s answer, so there is nothing for ${name} to accept.`);
      if (meeting.starts_at <= now) return fail(`Error: ${when} has already passed. Propose a new time with propose_meeting.`);
      const busy = await conflict(deps, who, other, meeting.starts_at, meeting.ends_at);
      if (busy) return fail(`Error: ${busy.id === who.id ? name : other.tag} is no longer free ${when}; something landed on their calendar since. Name another time.`);
      const blocked = ledgerBusy(deps, who, other);
      if (blocked) return fail(blocked);
      return book(deps, meeting, who, other, meeting.starts_at, meeting.ends_at, `${who.tag} said yes`);
    }
    case "counter": {
      const { start, end } = answer;
      const minutes = (Date.parse(`${end}:00Z`) - Date.parse(`${start}:00Z`)) / 60_000;
      if (!(minutes >= MIN_DURATION_MIN && minutes <= MAX_DURATION_MIN)) return fail(`Error: a meeting is ${MIN_DURATION_MIN} minutes to ${MAX_DURATION_MIN / 60} hours long.`);
      if (start <= now) return fail(`Error: ${formatWhen(start, end)} has already passed.`);
      const busy = await conflict(deps, who, other, start, end);
      if (busy) {
        const alt = await alternatives(deps, who, other, start, meeting.duration_min, now);
        return fail(`Error: ${busy.id === who.id ? name : other.tag} is busy ${formatWhen(start, end)}.${alt.length ? ` Free for both that day: ${alt.join(", ")}.` : ""} Ask ${name} for another time.`);
      }
      const insideWindow = who.id === meeting.invitee_id && start >= meeting.window_from && end <= meeting.window_to;
      if (insideWindow) {
        const blocked = ledgerBusy(deps, who, other);
        if (blocked) return fail(blocked);
        return book(deps, meeting, who, other, start, end, `${who.tag} suggested ${formatWhen(start, end)} instead, which works for you too`);
      }
      db.offerMeetingSlot(meeting.id, start, end, who.id, other.id);
      deps.log?.(`meeting: ${who.tag} offers '${meeting.title}' ${formatWhen(start, end)} to ${other.tag}`);
      const text = `${who.tag} suggests ${formatWhen(start, end)} for ${label} instead. Reply 'yes' and it goes on both calendars, or name another time.`;
      await tell(deps, other, text, `${text} (A plain yes or no is handled before you see it; anything else about this meeting: delegate it to answer_meeting.)`);
      const line = `Offered ${formatWhen(start, end)} for ${label} to ${other.tag}, free for both. They were texted and must say yes before it is booked; nothing is on any calendar yet.`;
      note(deps, who, line);
      return { ok: true, line, reply: `I offered ${formatWhen(start, end)} to ${other.tag}. I'll tell you when they answer.` };
    }
  }
}

/** Facts for the owner's prompts: meetings waiting for their answer, and ones they are waiting on. */
export function meetingFacts(db: Db, owner: Account): string[] {
  const open = db.openMeetings(owner.id);
  const forMe: string[] = [];
  const onThem: string[] = [];
  for (const m of open) {
    const other = db.account(m.proposer_id === owner.id ? m.invitee_id : m.proposer_id);
    if (!other) continue;
    const wider = m.invitee_id === owner.id && (m.window_from < m.starts_at || m.window_to > m.ends_at);
    const item = `${other.tag}: '${m.title}' ${whenOf(m)}${wider ? ` (any time ${formatWindow(m.window_from, m.window_to)} works for ${other.tag})` : ""}`;
    (m.awaiting === owner.id ? forMe : onThem).push(item);
  }
  return [
    forMe.length ? `Meetings waiting for ${owner.tag}'s answer (yes, no or another time; answer_meeting): ${forMe.join("; ")}.` : "",
    onThem.length ? `Meetings ${owner.tag} offered, waiting for the friend's answer: ${onThem.join("; ")}.` : "",
  ].filter(Boolean);
}
