/**
 * How Jarvis names itself and the chat, per channel. src/index.ts sets CHANNEL to the channel it runs; unset (tests,
 * scripts) reads as Telegram, the wording these prompts had first. PHOTON_NUMBER is the iMessage number people text.
 */
export type ChannelKind = "photon" | "telegram" | "imessage" | "dev";

export function channelKind(): ChannelKind {
  const name = process.env.CHANNEL?.trim().toLowerCase();
  return name === "photon" || name === "imessage" || name === "dev" ? name : "telegram";
}

/** "iMessage" or "Telegram"; undefined for the dev channel, which is not an app people know. */
export function channelLabel(): string | undefined {
  const kind = channelKind();
  return kind === "telegram" ? "Telegram" : kind === "dev" ? undefined : "iMessage";
}

/** Jarvis's iMessage number as people should text it (PHOTON_NUMBER), when set. */
const photonNumber = () => process.env.PHOTON_NUMBER?.trim() || undefined;

/**
 * How people find Jarvis: on iMessage "Jarvis at +14155550100" (PHOTON_NUMBER), on Telegram the bot's @username
 * (TELEGRAM_BOT_USERNAME, "@AgentSignBot"), else a generic name.
 */
export function botMention(): string {
  const kind = channelKind();
  if (kind === "photon" || kind === "imessage") {
    const number = photonNumber();
    return number ? `Jarvis at ${number}` : "Jarvis on iMessage";
  }
  if (kind === "dev") return "Jarvis";
  const name = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  return name ? `@${name}` : "the AgentSign bot";
}

/** How someone joins, to finish "they need to ...": text Jarvis on iMessage, or open the bot on Telegram, then set up with a Ledger. */
export function joinHint(): string {
  const kind = channelKind();
  if (kind === "photon" || kind === "imessage") {
    const number = photonNumber();
    return `text Jarvis${number ? ` at ${number}` : ""} on iMessage and set up with their own Ledger`;
  }
  if (kind === "dev") return "message Jarvis and set up with their own Ledger";
  return `open ${botMention()} on Telegram, press Start and set up with their own Ledger`;
}

/** Where the owner's texts land, as Jarvis says it ("the link is in ..."): by the handle's channel, else the running one. */
export function chatName(handle: string | undefined): string {
  if (handle?.startsWith("tg:")) return "their Telegram chat with you";
  const kind = channelKind();
  return kind === "photon" || kind === "imessage" ? "their iMessage chat with you" : "their texts";
}

/** "@mokner (Telegram @mokner_tg)" style label: the tag, plus the Telegram username when it differs. */
export function withUsername(account: { tag: string; username: string | null }): string {
  return account.username && `@${account.username}` !== account.tag ? `${account.tag} (Telegram @${account.username})` : account.tag;
}

/** First name for prompts and texts: the Telegram display name when known, else the tag ("@matt" -> "Matt"). */
export function firstName(account: { tag: string; display_name: string | null }): string {
  return account.display_name?.trim().split(/\s+/)[0] || account.tag.slice(1, 2).toUpperCase() + account.tag.slice(2);
}
