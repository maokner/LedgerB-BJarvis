/**
 * What needs the owner's Ledger. Money and deleting the account always do. Three more things can go either way,
 * per owner: their own calendar events, meetings with friends, and friend changes. A preset sets all three
 * (standard by default: only friends) and the owner can flip any one of them by asking Jarvis.
 *
 * When the policy says no Ledger, executeDirectly() runs the same executor the Ledger path would have, at once.
 */
import { describeAction } from "./actions.js";
import type { Calendar } from "./calendar/google.js";
import type { Account, Db } from "./db.js";
import { execute, ExecutorError } from "./executors.js";
import { ACTION_TITLES, type Action, type ActionCode, type Channel } from "./types.js";

export type Guard = "calendar" | "meetings" | "friends";
export const GUARDS: Guard[] = ["calendar", "meetings", "friends"];
export const GUARD_LABELS: Record<Guard, string> = { calendar: "own calendar events", meetings: "meetings with friends", friends: "adding friends" };

export type Preset = "relaxed" | "standard" | "strict";
export const PRESETS: Record<Preset, Record<Guard, boolean>> = {
  relaxed: { calendar: false, meetings: false, friends: false },
  standard: { calendar: false, meetings: false, friends: true },
  strict: { calendar: true, meetings: true, friends: true },
};
export const DEFAULT_PRESET: Preset = "standard";

export interface Policy {
  preset: Preset;
  /** Per-guard changes on top of the preset: true means the Ledger is required. */
  overrides: Partial<Record<Guard, boolean>>;
}

/** Which guard an action code falls under; none for money and deleting the account (always the Ledger). */
export function guardOf(code: ActionCode): Guard | undefined {
  return code === "CAL" ? "calendar" : code === "FRQ" || code === "FAC" ? "friends" : undefined;
}

export const isPreset = (v: unknown): v is Preset => v === "relaxed" || v === "standard" || v === "strict";

/** The stored policy, or the default; a damaged value is the default too. */
export function policyOf(account: Pick<Account, "policy">): Policy {
  if (!account.policy) return { preset: DEFAULT_PRESET, overrides: {} };
  try {
    const raw = JSON.parse(account.policy) as Partial<Policy>;
    const overrides: Partial<Record<Guard, boolean>> = {};
    for (const g of GUARDS) if (typeof raw.overrides?.[g] === "boolean") overrides[g] = raw.overrides[g];
    return { preset: isPreset(raw.preset) ? raw.preset : DEFAULT_PRESET, overrides };
  } catch {
    return { preset: DEFAULT_PRESET, overrides: {} };
  }
}

/** The preset with the overrides applied. */
export function gates(policy: Policy): Record<Guard, boolean> {
  return { ...PRESETS[policy.preset], ...policy.overrides };
}

export const requiresLedger = (account: Pick<Account, "policy">, guard: Guard): boolean => gates(policyOf(account))[guard];

/** A new policy: a preset resets the overrides; single changes stack on the current preset. */
export function changePolicy(current: Policy, change: { preset?: Preset } & Partial<Record<Guard, boolean>>): Policy {
  const next: Policy = change.preset ? { preset: change.preset, overrides: {} } : { preset: current.preset, overrides: { ...current.overrides } };
  for (const g of GUARDS) if (typeof change[g] === "boolean") next.overrides[g] = change[g];
  // An override that matches the preset is no override.
  for (const g of GUARDS) if (next.overrides[g] === PRESETS[next.preset][g]) delete next.overrides[g];
  return next;
}

/** "standard: the Ledger confirms money, deleting the account and adding friends; own calendar events and meetings with friends happen at once." */
export function describePolicy(policy: Policy): string {
  const g = gates(policy);
  const on = GUARDS.filter((x) => g[x]).map((x) => GUARD_LABELS[x]);
  const off = GUARDS.filter((x) => !g[x]).map((x) => GUARD_LABELS[x]);
  const list = (items: string[]) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0]!);
  const changed = Object.keys(policy.overrides).length ? " with changes" : "";
  return `${policy.preset}${changed}: the Ledger confirms ${list(["money", "deleting the account", ...on])}; ${off.length ? `${list(off)} happen${off.length === 1 ? "s" : ""} at once` : "nothing happens without it"}.`;
}

export interface DirectDeps {
  db: Db;
  calendar: Pick<Calendar, "afterEvent">;
  channel: Pick<Channel, "send">;
  log?: (line: string) => void;
}

/**
 * Runs an action the owner's policy does not send to the Ledger. Texts everyone else the executor names; the
 * owner's own text comes back as `line` for whoever is replying to them. Errors come back as "Error: ..." lines.
 */
export async function executeDirectly(deps: DirectDeps, owner: Account, action: Action): Promise<{ ok: boolean; line: string }> {
  const { db } = deps;
  let outcome;
  try {
    outcome = db.tx(() => execute(db, { accountId: owner.id, pubkey: owner.pubkey }, action));
  } catch (err) {
    if (err instanceof ExecutorError) return { ok: false, line: `Error: ${err.message}` };
    throw err;
  }
  deps.log?.(`direct ${action.code} for ${owner.tag} (no Ledger under their policy): ${describeAction(action, ACTION_TITLES)}`);
  const google = action.code === "CAL" ? await deps.calendar.afterEvent(owner.id) : undefined;
  const mine = db.primaryHandle(owner.id);
  let line = `${describeAction(action, ACTION_TITLES)}: done.`;
  for (const n of outcome.notifications) {
    if (n.handle === mine) line = n.text;
    else await deps.channel.send(n.handle, n.text).catch((err: unknown) => deps.log?.(`direct ${action.code}: text to ${n.handle} failed: ${(err as Error).message}`));
  }
  return { ok: true, line: google ? `${line} ${google}` : line };
}
