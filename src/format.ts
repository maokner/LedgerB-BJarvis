/** Money and local-time helpers. All calendar times are naive local "YYYY-MM-DDTHH:MM" strings in TIMEZONE. */
export const TIMEZONE = "America/Los_Angeles";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const formatCents = (cents: number): string => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/** "$23.40", "23.4", "$1,000", "5 USD" -> cents. Undefined unless a positive amount with at most 2 decimals. */
export function parseCents(text: string): number | undefined {
  const s = text.replace(/usd|dollars?|[$,\s]/gi, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const cents = Math.round(Number(s) * 100);
  return cents > 0 && Number.isSafeInteger(cents) ? cents : undefined;
}

/** The current wall-clock time in TIMEZONE as "YYYY-MM-DDTHH:MM". */
export function localNow(now = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// Naive local stamps are handled as if they were UTC, which keeps date arithmetic and weekdays right.
const toMs = (stamp: string): number => Date.parse(`${stamp}:00Z`);
const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 16);
export const addMinutes = (stamp: string, minutes: number): string => fromMs(toMs(stamp) + minutes * 60_000);

/** The instant a local stamp names in TIMEZONE (DST aware). "2026-10-11T12:00" -> 19:00Z. */
export function toInstant(stamp: string): Date {
  // The zone's offset at the guessed instant, then once more at the corrected one (a stamp near a DST switch).
  const wall = toMs(stamp);
  const offsetAt = (utcMs: number) => toMs(localNow(new Date(utcMs))) - utcMs;
  const once = wall - offsetAt(wall);
  return new Date(wall - offsetAt(once));
}

/** An instant as a local stamp in TIMEZONE. */
export const toLocal = (date: Date): string => localNow(date);

/** "2026-10-11T12:00" -> "Sat Oct 11 2026". */
export function formatDay(stamp: string): string {
  const d = new Date(toMs(stamp));
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}

/** The text shown on the device: "Sat Oct 11 12:00-13:00". */
export function formatWhen(start: string, end: string): string {
  const d = new Date(toMs(start));
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${start.slice(11)}-${end.slice(11)}`;
}

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)?`;
const ISO_RE = new RegExp(String.raw`(\d{4})-(\d{2})-(\d{2})[ T]+${TIME}\s*(?:-|to)\s*(?:\d{4}-\d{2}-\d{2}[ T]+)?${TIME}`, "i");
const TEXT_RE = new RegExp(String.raw`(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*,?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?,?\s+${TIME}\s*(?:-|to)\s*${TIME}`, "i");

function clock(h?: string, m?: string, ampm?: string): string | undefined {
  let hour = Number(h);
  const minute = Number(m ?? "0");
  if (ampm) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  }
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) return undefined;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Parses "2026-10-11 12:00-13:00" or "Sat Oct 11 12:00-13:00" (also "12pm-1pm") into local stamps.
 * Without a year, picks the year that matches the weekday (if given) and is closest to `now`.
 */
export function parseWhen(text: string, now = new Date()): { start: string; end: string } | undefined {
  let date: string | undefined;
  let startClock: string | undefined;
  let endClock: string | undefined;
  const iso = ISO_RE.exec(text);
  if (iso) {
    date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    startClock = clock(iso[4], iso[5], iso[6] ?? iso[9]);
    endClock = clock(iso[7], iso[8], iso[9]);
  } else {
    const t = TEXT_RE.exec(text);
    if (!t) return undefined;
    const month = MONTHS.findIndex((m) => m.toLowerCase() === t[2]!.toLowerCase());
    const day = Number(t[3]);
    const weekday = t[1] ? DAYS.findIndex((d) => d.toLowerCase() === t[1]!.toLowerCase()) : -1;
    const nowMs = toMs(localNow(now));
    const thisYear = new Date(nowMs).getUTCFullYear();
    const years = t[4] ? [Number(t[4])] : [thisYear - 1, thisYear, thisYear + 1];
    const candidates = years
      .map((y) => `${y}-${pad(month + 1)}-${pad(day)}`)
      .filter((d) => new Date(toMs(`${d}T00:00`)).getUTCDate() === day)
      .filter((d) => weekday < 0 || new Date(toMs(`${d}T00:00`)).getUTCDay() === weekday)
      .sort((a, b) => Math.abs(toMs(`${a}T12:00`) - nowMs) - Math.abs(toMs(`${b}T12:00`) - nowMs));
    date = candidates[0];
    startClock = clock(t[5], t[6], t[7] ?? t[10]);
    endClock = clock(t[8], t[9], t[10]);
  }
  if (!date || !startClock || !endClock || Number.isNaN(toMs(`${date}T00:00`))) return undefined;
  const start = `${date}T${startClock}`;
  let end = `${date}T${endClock}`;
  if (end <= start) end = addMinutes(end, 24 * 60);
  if (toMs(end) - toMs(start) > 24 * 3600_000) return undefined;
  return { start, end };
}
