/**
 * The execution engine: no access to the user. It gets a task from the persona, does it with tools
 * (read-only tools, send_note, message_agent, propose_meeting, answer_meeting, propose_action) and reports back in plain facts.
 */
import { describeAction } from "../actions.js";
import type { Account } from "../db.js";
import { demoMoney } from "../money.js";
import { ACTION_TITLES, type Action } from "../types.js";
import { calendarOf, claimsProposal, deliverNote, ownerFacts, runPeerTurn, toolLoop, type AgentDeps } from "./agent.js";
import { firstName } from "./bot.js";
import { ownerTools, type Tools } from "./tools.js";
import type { ChatMessage } from "./xai.js";

const MAX_STEPS = 8;

export function engineSystemPrompt(facts: string[], owner: Account): string {
  const name = firstName(owner);
  return [
    `You are the execution engine of AgentSign, working for ${owner.tag} (${name}).`,
    `You have no direct access to ${name}. AgentSign's personality agent talks to them, hands you a task, and passes your report on.`,
    ...facts,
    "",
    "How to work:",
    "- Do the task with your tools. Read-only tools run right away.",
    `- Google Calendar: if ${name} asks to connect (link, sync, hook up) their Google Calendar, call connect_google_calendar; it sends them the link itself. Disconnect only when asked. Never ask for Google passwords or codes.`,
    `- Money, calendar events, friend requests, accepting them and deleting the account all go through propose_action. Money and deleting always wait for ${name}'s Ledger, which shows exactly the fields you propose; only one action can wait there at a time. Calendar events and friend changes wait for the Ledger only when ${name}'s Ledger policy (in the facts) says so; otherwise propose_action does them at once and its result says so. Report what actually happened.`,
    `- The Ledger policy: when ${name} asks what needs their Ledger, answer from the facts. When they want to change it (a preset: relaxed, standard or strict; or one thing: calendar, meetings, friends), call set_ledger_policy.`,
    "- For a receipt photo, read the final total (with tax and tip) and use it as the Amount.",
    "- Match names to tags (gabe -> @gabriel). If a tool says a name is unknown or ambiguous, do not guess: report what you need.",
    `- To meet a friend, call propose_meeting right away (no need to ask their agent first): their tag, a short title (what it is about, never their name), the window ${name} is open to, the length (30 minutes unless they said), and preferred when they named a time inside a wider window. Windows: an exact time ("at 9") is a slot of that length, 09:00 to 09:30; "around 9" is 08:30 to 10:00 with preferred 09:00; "morning" 09:00-12:00; "afternoon" 12:00-17:00; "evening" 17:00-21:00; "any time 9 to 5" or a day alone 09:00-17:00. Never use CAL for a meeting with a friend, and do not ask ${name} to pick a slot unless they asked to choose.`,
    `- When ${name} answers a meeting a friend is arranging with them (yes, no, or a different time; the facts above list them), call answer_meeting. If they name a new time for a meeting they offered themselves, answer_meeting with another time offers it.`,
    `- To send a friend a note (a thank you, a hello, a reply, anything ${name} wants to say to them), call send_note with the note written as ${name} would say it, a sentence or two. It reaches the friend at once as a text from their own Jarvis; nothing to approve. message_agent only asks when a friend is free and never passes anything on to them.`,
    `- To buy something (only where the facts say Amazon is available): search_amazon first, pick the item that fits best within what ${name} said (cheapest match unless they said otherwise), then propose_action BUY with Item <its id>. The tool quotes the exact total and refuses anything over the limit; if it does, report the price and the limit, do not look for ways around it. Never buy more than one thing per request, and never without a search result's id.`,
    `- Use remember for lasting facts ${name} tells you.`,
    `- Only if ${name} clearly asks to delete, close or reset their account, propose DEL (no fields). Never for anything less. Their Ledger is the confirmation, so do not ask them to confirm first.`,
    "",
    "How to report:",
    "- Plain facts from tool results only. Never invent balances, names, times or outcomes. If something failed, say what failed and why.",
    `- Say what you did, what now waits on the Ledger, and exactly what you need from ${name}, if anything.`,
    "- No preamble, no sign-off, no markdown. A few short lines at most.",
  ].join("\n");
}

export interface EngineTask {
  goal: string;
  context?: string;
  /** The owner's latest text and photos, verbatim, so amounts and names are not lost in the hand-off. */
  userText: string;
  images: string[];
}

export interface EngineHooks {
  /** Delivers a "Please confirm on your Ledger" text (merged into the persona's reply). */
  deliver?: (prompt: string) => Promise<void>;
  onProposed?: (action: Action) => void;
  /** Called with the outcome line of something done at once: a meeting step, an action the policy did not gate, a policy change. */
  onSettled?: (line: string) => void;
  /** Sends a text (a link) right under the persona's reply. Unset: texted on its own. */
  attach?: (text: string) => Promise<void>;
}

/**
 * The engine's tool set for one task: ownerTools plus the message_agent progress texts. Also used by phone calls
 * (src/voice/session.ts), so a call runs exactly the same harness. `proposed` collects every action proposed.
 */
export function engineTools(deps: AgentDeps, owner: Account, hooks: EngineHooks = {}): { tools: Tools; proposed: Action[]; settled: string[] } {
  const { db } = deps;
  const notified = new Set<string>();
  const proposed: Action[] = [];
  /** Outcome lines of things done at once this task: meeting steps, actions the policy did not gate, policy changes. */
  const settled: string[] = [];
  const tools = ownerTools({
    db,
    approvals: deps.approvals,
    owner,
    calendar: calendarOf(deps),
    channel: deps.channel,
    log: deps.log,
    money: deps.money,
    purchases: deps.purchases,
    deliver: hooks.deliver,
    attach: hooks.attach ?? (async (text) => void (await deps.channel.send(db.primaryHandle(owner.id)!, text))),
    onProposed: (action) => {
      proposed.push(action);
      hooks.onProposed?.(action);
    },
    onSettled: (line) => {
      settled.push(line);
      hooks.onSettled?.(line);
    },
    sendNote: (target, text) => deliverNote(deps, owner, target, text),
    messageAgent: async (target, message) => {
      // A progress text for the owner as it starts, and a heads-up for the friend, once per thread and task.
      const first = !notified.has(target.tag);
      notified.add(target.tag);
      const ownerHandle = first ? db.primaryHandle(owner.id) : undefined;
      if (ownerHandle) await deps.channel.send(ownerHandle, `Checking with ${target.tag}'s agent. It only shares when ${firstName(target)} is free or busy.`);
      const reply = await runPeerTurn(deps, target, owner.tag, message);
      const targetHandle = first ? db.primaryHandle(target.id) : undefined;
      if (targetHandle) await deps.channel.send(targetHandle, `${owner.tag}'s agent asked when you are free. I only shared free and busy times, nothing else.`);
      return `${target.tag}'s agent replied: ${reply}\nNothing is booked. To set up a meeting, call propose_meeting.`;
    },
  });
  return { tools, proposed, settled };
}

/** Runs one task and returns the report for the persona. Nothing here is persisted except what the tools do. */
export async function runEngine(deps: AgentDeps, owner: Account, task: EngineTask, hooks: EngineHooks = {}): Promise<string> {
  const { db } = deps;
  const { tools, proposed, settled } = engineTools(deps, owner, hooks);
  // Models sometimes say "I proposed it" without calling propose_action. Catch that once per task.
  const review = (report: string) =>
    !proposed.length && claimsProposal(report)
      ? "Your report says something was proposed, but propose_action was not called, so nothing was proposed. Call propose_action now, or report honestly what is missing."
      : undefined;
  const money = deps.money ?? demoMoney();
  const balance = await money.balanceText(owner).catch(() => "unknown right now (use get_balance)");
  const user: ChatMessage = {
    role: "user",
    content: [`Task: ${task.goal}`, task.context ? `Context: ${task.context}` : "", `${firstName(owner)}'s latest text: ${JSON.stringify(task.userText)}`]
      .filter(Boolean)
      .join("\n"),
    ...(task.images.length ? { images: task.images } : {}),
  };
  return toolLoop(deps, {
    system: engineSystemPrompt(ownerFacts(db, owner, balance, calendarOf(deps), deps.purchases), owner),
    messages: [user],
    tools,
    maxSteps: MAX_STEPS,
    review,
    // A proposal, or something done at once, ends the task: the report is a known fact, so skip a model call that could embellish it.
    stop: () =>
      proposed.length || settled.length
        ? [...settled, ...proposed.map((a) => `Proposed on ${owner.tag}'s Ledger: ${describeAction(a, ACTION_TITLES)}. Not done until they approve it there.`)].join("\n")
        : undefined,
    giveUp: "The engine stopped after too many steps without finishing. Nothing was proposed.",
  });
}
