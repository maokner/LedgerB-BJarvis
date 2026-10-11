/** What Jarvis knows and how he speaks on a phone call: the owner version and the stranger (sign-up) version. */
import { nameOf, ownerFacts, type AgentDeps } from "../agent/agent.js";
import { OWNER_TOOL_SPECS } from "../agent/tools.js";
import type { ToolSpec } from "../agent/xai.js";
import type { Account, Db } from "../db.js";
import { demoMoney } from "../money.js";

export const END_CALL: ToolSpec = {
  name: "end_call",
  description: "Call once the caller says goodbye or is clearly done. You then say one short goodbye and the call ends.",
  parameters: { type: "object", properties: {} },
};

export const CHOOSE_TAG: ToolSpec = {
  name: "choose_tag",
  description: "Call as soon as the caller says which tag they want, like @gabe. Starts their sign-up on their Ledger.",
  parameters: { type: "object", properties: { tag: { type: "string", description: "The tag, like @gabe" } }, required: ["tag"] },
};

export const ownerVoiceTools = (): ToolSpec[] => [...OWNER_TOOL_SPECS, END_CALL];
export const strangerVoiceTools = (): ToolSpec[] => [CHOOSE_TAG, END_CALL];

const VOICE = [
  "How you sound: composed, dry, quietly witty, unfailingly helpful, like a good butler with a sense of humour. Never gushing.",
  "This is a phone call: short spoken sentences, one or two at a time, then let them talk. No lists, no markdown, no emoji, no URLs.",
  'Say numbers the way people say them ("five dollars", "two thirty tomorrow"). Never read addresses, hashes, links or long numbers aloud; at most "your address ending in" and the last four characters.',
];

const standing = (context: string) => (context.trim() ? ["", "Standing instructions from Matt, who runs AgentSign. Follow them unless they conflict with the rules above:", context.trim()] : []);

/** "0x1234abcd...9f3e" style, for an Ethereum address; undefined for anything else. */
export const shortAddress = (pubkey: string) => (/^0x[0-9a-f]{40}$/i.test(pubkey) ? `${pubkey.slice(0, 6)}...${pubkey.slice(-4)}` : undefined);

export function ownerInstructions(owner: Account, facts: string[], context = "", recent: string[] = []): string {
  const name = nameOf(owner.tag);
  return [
    `You are Jarvis, the voice of AgentSign and the personal agent of ${owner.tag} (${name}). You are on a phone call with ${name}.`,
    ...VOICE,
    "",
    "What you know right now:",
    ...facts,
    ...(recent.length ? ["Recent texts and notes with them, oldest first:", ...recent] : []),
    "",
    "How you work:",
    "- Use your tools for anything that needs fresh data: balance, friends, calendar, notes, past payments, a friend's free time. Never invent balances, names, times or outcomes.",
    `- You cannot move money, add calendar events, add friends or delete the account yourself. For those call propose_action; ${name} approves or rejects it on their Ledger, which shows exactly the fields you propose. Only one action can wait at a time.`,
    `- While you set it up, say something like "I'll put that on your Ledger." Afterwards: it is on their Ledger and the details are in their texts. Never say it is sent, booked or done until you are told it was approved; you will be told during the call if it lands.`,
    "- Match names to tags (gabe -> @gabriel). If a tool says a name is unknown or ambiguous, ask.",
    `- To meet a friend: ask their agent for free slots with message_agent, then propose CAL for the earliest slot that fits, With @friend, 30 minutes by default.`,
    `- To tell a friend something (a thank you, a hello, a reply): send_note, in ${name}'s words. It is texted to them at once; nothing to approve. message_agent never passes anything on.`,
    `- Use remember for lasting facts ${name} tells you.`,
    "- Receipts need a photo: ask them to text it to this number.",
    `- Only if ${name} clearly asks to delete or close their account, propose DEL. Their Ledger is the confirmation.`,
    "- Lines in square brackets that start with AgentSign are updates from the system, not the caller. Pass them on briefly.",
    "- When they say goodbye or are done, call end_call, then say one short goodbye.",
    `- Open the call by greeting ${name} by name in one short line, like "Jarvis here. What can I do for you, ${name}?"`,
    ...standing(context),
  ].join("\n");
}

export function strangerInstructions(appName: string, context = ""): string {
  return [
    "You are Jarvis, the voice of AgentSign. The caller's phone number has no AgentSign account yet.",
    ...VOICE,
    "",
    'What AgentSign is: you text or call it like a friend ("send five dollars to @yadu", "lunch with yadu tomorrow"), and nothing risky happens until you approve it on your own Ledger.',
    `To sign up they need a tag (like @sam) that friends use to find them, and their Ledger plugged into the AgentSign Mac with ${appName} open.`,
    "- Open with one short line saying who you are, then ask what tag they want.",
    '- As soon as they say a tag ("call me gabe", "at gabe"), call choose_tag. Tags are 2 to 24 letters, numbers or underscores. If unsure of the spelling, ask them to spell it.',
    "- If choose_tag started the sign-up, tell them to approve it on their Ledger; a text with the same request went to their phone. Stay on the line. Never say the account exists until you are told it was created.",
    "- You cannot do anything else for them until they have an account.",
    "- Lines in square brackets that start with AgentSign are updates from the system, not the caller. Pass them on briefly.",
    "- When they say goodbye or are done, call end_call, then say one short goodbye.",
    ...standing(context),
  ].join("\n");
}

/** The last few plain texts and notes in the owner's chat history, one line each. */
export function recentLines(db: Db, accountId: number, limit = 10): string[] {
  const who = { user: "They", assistant: "You", system: "Note" } as Record<string, string>;
  return db
    .recentMessages(accountId, 40)
    .map((m) => m.content as { role: string; content?: unknown; toolCalls?: unknown[] })
    .filter((m) => who[m.role] && typeof m.content === "string" && m.content.trim() && !m.toolCalls?.length)
    .slice(-limit)
    .map((m) => `- ${who[m.role]}: ${String(m.content).replace(/\s+/g, " ").slice(0, 240)}`);
}

/** Instructions for whoever is calling now: their account's facts, or the stranger flow. */
export async function instructionsFor(deps: AgentDeps, owner: Account | undefined, context: string): Promise<string> {
  const money = deps.money ?? demoMoney();
  if (!owner) return strangerInstructions(money.appName, context);
  const balance = await money.balanceText(owner).catch(() => "unknown right now (use get_balance)");
  const address = shortAddress(owner.pubkey);
  const facts = [...ownerFacts(deps.db, owner, balance), ...(address ? [`Their address (never read it aloud): ${address}.`] : [])];
  return ownerInstructions(owner, facts, context, recentLines(deps.db, owner.id));
}
