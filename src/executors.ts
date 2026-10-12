/**
 * What each action does once its signature is verified. Each executor is a DB mutation (run inside a
 * transaction by approvals.ts) that returns the texts to send.
 */
import type { Account, Db } from "./db.js";
import { formatCents, formatWhen, parseCents, parseWhen } from "./format.js";
import { txLink } from "./chain.js";
import type { Action } from "./types.js";

export const STARTING_BALANCE_CENTS = 25_000;

export interface Notification {
  handle: string;
  text: string;
}
export interface ExecResult {
  notifications: Notification[];
}
export interface ExecContext {
  /** The signer's account; null only for ACC. */
  accountId: number | null;
  /** ACC: the handle the sign-up came from ("tg:<id>" on Telegram); the new account is bound to it. */
  handle?: string;
  /** The key (or Ethereum address) that signed the action. */
  pubkey: string;
  /** Ethereum mode PAY: the broadcast transaction. */
  txHash?: string;
  /** ACC: the text for the new owner (it may need a chain lookup, so approvals.ts builds it). */
  createdText?: string;
  startingCents?: number;
}

/** A failure the owner should read, like "not enough money". */
export class ExecutorError extends Error {}

export const field = (action: Action, label: string): string | undefined => action.fields.find((f) => f.label === label)?.value;

function need(action: Action, label: string): string {
  const value = field(action, label);
  if (!value) throw new ExecutorError(`The ${label} field is missing, so nothing happened.`);
  return value;
}

export function execute(db: Db, ctx: ExecContext, action: Action): ExecResult {
  if (action.code === "ACC") return createAccount(db, ctx, action);
  const owner = ctx.accountId === null ? undefined : db.account(ctx.accountId);
  if (!owner) throw new ExecutorError("I could not find your account, so nothing happened.");
  const ownerHandle = db.primaryHandle(owner.id)!;
  const other = (label: string): { account: Account; handle: string } => {
    const tag = need(action, label);
    const account = db.accountByTag(tag);
    if (!account) throw new ExecutorError(`There is no account ${tag}, so nothing happened.`);
    if (account.id === owner.id) throw new ExecutorError("That is your own account, so nothing happened.");
    return { account, handle: db.primaryHandle(account.id)! };
  };
  const done = (notifications: Notification[]): ExecResult => ({ notifications });

  switch (action.code) {
    case "DEL": {
      const address = field(action, "Address");
      if (need(action, "Tag") !== owner.tag || (address && address !== owner.pubkey)) {
        throw new ExecutorError("That delete request was for a different account, so nothing happened.");
      }
      db.deleteAccount(owner.id);
      return done([{ handle: ownerHandle, text: `Your account ${owner.tag} is gone. Message me again any time to start over.` }]);
    }
    case "PAY": {
      if (ctx.txHash) return ethPayment(db, owner, ownerHandle, action, ctx.txHash);
      const to = other("To");
      const cents = parseCents(need(action, "Amount"));
      if (!cents) throw new ExecutorError("The amount was not valid, so nothing happened.");
      if (owner.balance_cents < cents) {
        throw new ExecutorError(`Payment failed: your balance is ${formatCents(owner.balance_cents)}, not enough to send ${formatCents(cents)}.`);
      }
      const memo = field(action, "Memo") ?? null;
      db.transfer(owner.id, to.account.id, cents, memo, action.id);
      const amount = formatCents(cents) + (memo ? ` (${memo})` : "");
      return done([
        { handle: ownerHandle, text: `Sent ${amount} to ${to.account.tag}. Your balance is ${formatCents(owner.balance_cents - cents)}.` },
        { handle: to.handle, text: `${owner.tag} sent you ${amount}. Your balance is ${formatCents(to.account.balance_cents + cents)}.` },
      ]);
    }
    case "BUY": {
      // The ETH is on its way to the treasury; src/purchases.ts takes it from here (receipt, order, refund).
      if (!ctx.txHash) throw new ExecutorError("Buying needs a payment on Base, so nothing happened.");
      const item = need(action, "Item");
      const amount = field(action, "USDC") ? `${field(action, "USDC")} USDC` : `${need(action, "ETH")} ETH`;
      return done([{ handle: ownerHandle, text: `Paid ${amount} (${need(action, "Total")}) to the treasury on Base for ${item}. I'll place the Amazon order as soon as Base confirms it. ${txLink(ctx.txHash)}` }]);
    }
    case "EAT": {
      // Like BUY: the USDC is on its way to the treasury; src/purchases.ts (through src/food/) places the order once Base confirms.
      if (!ctx.txHash) throw new ExecutorError("Ordering food needs a payment on Base, so nothing happened.");
      return done([{ handle: ownerHandle, text: `Paid ${need(action, "USDC")} USDC (${need(action, "Total")}) to the treasury on Base for ${need(action, "Order")} from ${need(action, "From")}. I'll place the DoorDash order as soon as Base confirms it. ${txLink(ctx.txHash)}` }]);
    }
    case "CAL": {
      // The owner's own event, or their side of a meeting (With @friend) when their policy sends meetings to the Ledger.
      const title = need(action, "Title");
      const whenText = need(action, "When");
      const when = parseWhen(whenText);
      if (!when) throw new ExecutorError(`I could not read the time "${whenText}", so nothing happened.`);
      const withTag = field(action, "With") ?? null;
      db.addEvent(owner.id, title, when.start, when.end, withTag, action.id);
      return done([{ handle: ownerHandle, text: `Added '${title}'${withTag ? ` with ${withTag}` : ""} ${formatWhen(when.start, when.end)} to your calendar.` }]);
    }
    case "FRQ": {
      const to = other("To");
      if (db.friendship(owner.id, to.account.id)) throw new ExecutorError(`You and ${to.account.tag} are already connected or have a pending request.`);
      db.requestFriend(owner.id, to.account.id);
      return done([
        { handle: ownerHandle, text: `Friend request sent to ${to.account.tag}. I will tell you when they accept.` },
        {
          handle: to.handle,
          text: `${owner.tag} wants to connect your agents (so they can schedule with each other and pass notes between you). Reply 'accept ${owner.tag}' to connect.`,
        },
      ]);
    }
    case "FAC": {
      const from = other("From");
      const f = db.friendship(owner.id, from.account.id);
      if (f?.status !== "pending" || f.requested_by !== from.account.id) {
        throw new ExecutorError(`There is no pending friend request from ${from.account.tag}, so nothing happened.`);
      }
      db.acceptFriend(owner.id, from.account.id);
      return done([
        { handle: ownerHandle, text: `You and ${from.account.tag} are now friends. Your agents can schedule with each other and pass notes between you.` },
        { handle: from.handle, text: `${owner.tag} accepted your friend request. Your agents can now talk to each other.` },
      ]);
    }
  }
  throw new ExecutorError(`Unknown action ${action.code}, so nothing happened.`);
}

function createAccount(db: Db, ctx: ExecContext, action: Action): ExecResult {
  const tag = need(action, "Tag");
  // Telegram: the device shows "Telegram @name" and the account binds to the sender's id; dev and iMessage show the handle itself.
  const handle = ctx.handle ?? need(action, "Phone");
  const shown = field(action, "Phone");
  if (shown !== undefined && shown !== handle) throw new ExecutorError("That sign-up was for a different sender, so nothing happened.");
  if (db.accountByTag(tag)) throw new ExecutorError(`${tag} was taken in the meantime. Send me another tag.`);
  if (db.accountByPubkey(ctx.pubkey)) throw new ExecutorError("That Ledger already has an account.");
  if (db.accountByHandle(handle)) throw new ExecutorError("You already have an account.");
  db.createAccount(tag, ctx.pubkey, handle, ctx.startingCents ?? STARTING_BALANCE_CENTS);
  return { notifications: [{ handle, text: ctx.createdText ?? `Account ${tag} created.` }] };
}

/** The transfer is already on chain; record nothing but the texts (the hash is on the action row). */
function ethPayment(db: Db, owner: Account, ownerHandle: string, action: Action, hash: string): ExecResult {
  const to = need(action, "To");
  const amount = `${need(action, "ETH")} ETH (${need(action, "Amount")})${field(action, "Memo") ? ` for ${field(action, "Memo")}` : ""}`;
  const recipient = to.startsWith("@") ? db.accountByTag(to) : db.accountByPubkey(to.toLowerCase());
  const notifications: Notification[] = [{ handle: ownerHandle, text: `Sent ${amount} to ${to} on Base. ${txLink(hash)}` }];
  const recipientHandle = recipient && recipient.id !== owner.id ? db.primaryHandle(recipient.id) : undefined;
  if (recipientHandle) notifications.push({ handle: recipientHandle, text: `${owner.tag} sent you ${amount} on Base. ${txLink(hash)}` });
  return { notifications };
}
