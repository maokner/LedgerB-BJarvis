/**
 * A handle is how a channel names a person: a phone number or an Apple ID email.
 * Everything in the database is keyed by the normalized form.
 */
export function normalizeHandle(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const digits = trimmed.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return `+${digits.slice(1).replace(/\D/g, "")}`;
  // A bare 10-digit US number becomes +1XXXXXXXXXX; anything else keeps its digits with a plus.
  const only = digits.replace(/\D/g, "");
  if (only.length === 10) return `+1${only}`;
  return `+${only}`;
}

/** "+14155551234" -> "+1 (415) ***-1234" for notes to other people. */
export function maskHandle(handle: string): string {
  if (handle.includes("@")) {
    const [user = "", domain = ""] = handle.split("@");
    return `${user.slice(0, 2)}***@${domain}`;
  }
  return `***${handle.slice(-4)}`;
}

/** A tag is "@" plus 2..24 lowercase letters, digits or underscores. Returns the canonical tag or undefined. */
export function parseTag(raw: string): string | undefined {
  const m = /^@?([a-z0-9_]{2,24})$/i.exec(raw.trim());
  return m?.[1] ? `@${m[1].toLowerCase()}` : undefined;
}
