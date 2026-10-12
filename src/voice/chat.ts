/**
 * A call talking to the owner's chat (whatever channel it is): text_owner sends a line there, look_at_chat reads the latest
 * texts and photos. Photos go through the engine with the call's hooks, so "look at this receipt and pay gabe back" ends
 * in an approval in the chat like any other.
 */
import { existsSync } from "node:fs";
import type { AgentDeps } from "../agent/agent.js";
import { firstName } from "../agent/bot.js";
import { runEngine, type EngineHooks } from "../agent/engine.js";
import { plain } from "../agent/persona.js";
import type { ChatMessage, ToolSpec } from "../agent/xai.js";
import type { Account } from "../db.js";
import { recentLines } from "./instructions.js";

const MAX_TEXT = 1000;
const MAX_PHOTOS = 4;
/** Photos in the owner's last few messages count as "what I just sent you". */
const LATEST_USER_MESSAGES = 3;
const VISUAL = /\b(photos?|pictures?|pics?|images?|screenshots?|receipts?|scans?|look(s|ing)? like|see)\b/i;

export const TEXT_OWNER: ToolSpec = {
  name: "text_owner",
  description:
    "Sends a text to the caller in their chat with you, and keeps it in your chat history. For anything better read than heard: an address, an order number, a link, a list, a summary. Plain text, no markdown.",
  parameters: { type: "object", properties: { text: { type: "string", description: "The text, as you would write it to them" } }, required: ["text"] },
};

export const LOOK_AT_CHAT: ToolSpec = {
  name: "look_at_chat",
  description:
    "Reads the caller's chat with you: their latest texts and photos. Photos are read for you, and a request about them (pay back from a receipt) is set up like any other. Use it whenever they say they sent you something.",
  parameters: {
    type: "object",
    properties: { question: { type: "string", description: "Their request in their words, like: read me the receipt; or: look at the receipt and pay gabe back" } },
  },
};

export const chatVoiceTools = (): ToolSpec[] => [TEXT_OWNER, LOOK_AT_CHAT];

/** text_owner: into the owner's chat and their history, so the next text turn knows it went out. */
export async function textOwner(deps: Pick<AgentDeps, "db" | "channel">, owner: Account, raw: unknown, chat: string): Promise<string> {
  const text = plain(String(raw ?? ""));
  if (!text) return "Error: the text is empty.";
  if (text.length > MAX_TEXT) return `Error: too long (${text.length} characters, at most ${MAX_TEXT}). Shorten it and try again.`;
  const handle = deps.db.primaryHandle(owner.id);
  if (!handle) return "Error: they have no chat to text right now.";
  await deps.channel.send(handle, text);
  deps.db.addMessage(owner.id, "assistant", { role: "assistant", content: text } satisfies ChatMessage);
  return `Sent in ${chat}: "${text}". Tell them it is there, in a few words.`;
}

/** The photo message look_at_chat reads: in the last few owner messages, or any recent one when the question is visual. */
function photoMessage(rows: ChatMessage[], question: string): { text: string; images: string[]; missing: boolean } | undefined {
  const users = rows.filter((m): m is Extract<ChatMessage, { role: "user" }> => m.role === "user").reverse(); // newest first
  const withPhotos = (m: (typeof users)[number]) => (m.images?.length ?? 0) > 0;
  const latest = users.slice(0, LATEST_USER_MESSAGES).find(withPhotos) ?? (VISUAL.test(question) ? users.find(withPhotos) : undefined);
  if (!latest) return undefined;
  const images = latest.images!.filter((p) => existsSync(p)).slice(-MAX_PHOTOS);
  return { text: latest.content === "(no text)" ? "" : latest.content, images, missing: images.length === 0 };
}

/**
 * look_at_chat: the latest lines of the chat, and with photos in reach the engine's reading of them (hooks as the call's
 * own, so a proposal is watched and told). `chat` names where approvals land.
 */
export async function lookAtChat(deps: AgentDeps, owner: Account, raw: unknown, hooks: EngineHooks, chat: string): Promise<string> {
  const question = String(raw ?? "").trim();
  const lines = recentLines(deps.db, owner.id, 12);
  const text = lines.length ? ["Their chat with you, oldest first (the last line is the newest):", ...lines] : ["Their chat with you is empty."];
  const photo = photoMessage(deps.db.recentMessages(owner.id, 40).map((m) => m.content as ChatMessage), question);
  if (!photo) return [...text, VISUAL.test(question) ? `No photo in their recent texts. Ask them to send it in ${chat}, then look again.` : ""].filter(Boolean).join("\n");
  if (photo.missing) return [...text, `Their photo is no longer on file. Ask them to send it again in ${chat}.`].join("\n");
  const name = firstName(owner);
  let proposed = false;
  const report = await runEngine(
    deps,
    owner,
    {
      goal: question || `Describe what ${name} sent`,
      context: [
        `${name} is on a phone call with you and asked you to look at what they sent in their chat; the photo(s) are attached.`,
        "If they only want to know what it shows, describe it in a few plain lines: names, amounts, totals, dates and numbers exactly as they appear.",
        "Their chat, oldest first:",
        ...lines,
      ].join("\n"),
      userText: photo.text,
      images: photo.images,
    },
    { ...hooks, onProposed: (action) => ((proposed = true), hooks.onProposed?.(action)) },
  );
  const after = proposed ? ` The details and the link to sign it went to ${chat}. Tell them it is on their Ledger.` : "";
  return [...text, `Their photo, read just now: ${report}${after}`].join("\n");
}
