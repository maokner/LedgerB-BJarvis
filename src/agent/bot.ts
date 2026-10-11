/** How people find Jarvis on Telegram: TELEGRAM_BOT_USERNAME when set ("@AgentSignBot"), else a generic name. */
export function botMention(): string {
  const name = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  return name ? `@${name}` : "the AgentSign bot";
}

/** "@mokner (Telegram @mokner_tg)" style label: the tag, plus the Telegram username when it differs. */
export function withUsername(account: { tag: string; username: string | null }): string {
  return account.username && `@${account.username}` !== account.tag ? `${account.tag} (Telegram @${account.username})` : account.tag;
}

/** First name for prompts and texts: the Telegram display name when known, else the tag ("@matt" -> "Matt"). */
export function firstName(account: { tag: string; display_name: string | null }): string {
  return account.display_name?.trim().split(/\s+/)[0] || account.tag.slice(1, 2).toUpperCase() + account.tag.slice(2);
}
