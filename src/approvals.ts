/**
 * Propose -> sign on the owner's Ledger -> verify -> execute -> notify.
 * Signing runs in the background, one approval at a time per account (or per handle during onboarding).
 */
import { describeAction, validateAction } from "./actions.js";
import type { Calendar } from "./calendar/google.js";
import { txLink } from "./chain.js";
import type { ActionStatus, Db } from "./db.js";
import { execute, ExecutorError, field, onChainAmount } from "./executors.js";
import { demoMoney, type Money } from "./money.js";
import { type Action, type ActionCode, ANY_DEVICE, type Channel, type DeviceManager, isPurchaseCode, type SignResult } from "./types.js";

export interface RequestOptions {
  /** Why this was proposed, for the log ("agent", "accept shortcut", "invite from @matt"). */
  reason?: string;
  /** Replaces the default "Please confirm on your Ledger: ..." text. */
  prompt?: string;
  /** The prompt is texted and the device asked only once this resolves (after the agent's own reply went out). */
  after?: Promise<void>;
  /**
   * Replaces the channel send of the prompt: the caller delivers it (for example merged into one text with the
   * agent's reply) and the device is asked once this resolves. Takes precedence over `after`.
   */
  deliver?: (prompt: string) => Promise<void>;
  /** When the device manager hands out a link: the whole prompt for it, instead of the prompt plus the "Or approve from..." line. */
  linkPrompt?: (url: string) => string;
  /** Texted when the link expired before the Ledger answered. Default: ask again for a new link. */
  expiredText?: string;
}

export interface Approvals {
  /** Inserts the action as pending and texts the owner. Throws if the account already has one pending. Signing continues in the background. */
  request(accountId: number, action: Action, options?: RequestOptions): Promise<void>;
  /** Same for ACC, before the account exists: signs with `pubkey` and texts `handle`. ANY_DEVICE: the account is bound to whichever free Ledger signs. */
  requestAccount(handle: string, pubkey: string, action: Action, options?: RequestOptions): Promise<void>;
  /** Resolves when the background work for one account (or handle), or for everything, is done. */
  whenIdle(key?: number | string): Promise<void>;
  /** The approval link of the job now in flight for `key` ("handle:<handle>" during sign-up), if it has one. */
  link(key: number | string): string | undefined;
  /** Stops the job in flight for `key`: it ends as expired, its link stops working, and no outcome is texted. False if none. */
  cancel(key: number | string): boolean;
}

export const PENDING_ERROR = "wait for the pending approval";

const outcomeText = (status: Exclude<SignResult["status"], "approved">, appName: string): string =>
  ({
    rejected: "You rejected it on your Ledger, so nothing happened.",
    no_device: `I couldn't find your Ledger, so nothing happened. Plug it in, unlock it, open ${appName}, and ask me again. If it still shows an old request, reject that one first.`,
    timeout: "Your Ledger timed out before you approved it, so nothing happened. Ask me again when you're ready.",
    error: "I lost the connection to your Ledger, so nothing happened. Try again in a moment.",
  })[status];

const LINK_EXPIRED = "The link expired before your Ledger signed, so nothing happened. Ask me again and I'll send a new one.";

interface Job {
  key: number | string;
  accountId: number | null;
  pubkey: string;
  handle: string;
  action: Action;
  prompt: string;
  linkPrompt?: (url: string) => string;
  expiredText?: string;
  reason: string;
}

export function createApprovals(deps: {
  db: Db;
  deviceManager: DeviceManager;
  channel: Pick<Channel, "send">;
  titles: Record<ActionCode, string>;
  log?: (line: string) => void;
  signTimeoutMs?: number;
  /** Device mode specifics (verification, broadcasting). Default: the custom AgentSign app with demo money. */
  money?: Money;
  /** Mirrors executed CAL events to the owner's Google Calendar when they connected one. */
  calendar?: Pick<Calendar, "afterEvent">;
  /** Hears how every action ended: executed (with the broadcast hash in Ethereum mode) or rejected, failed, expired. Purchases follow BUY and EAT from here. */
  onSettled?: (action: Action, status: Exclude<ActionStatus, "pending" | "approved">, extra: { txHash?: string }) => void;
}): Approvals {
  const { db, deviceManager, channel, titles, calendar } = deps;
  const money = deps.money ?? demoMoney();
  const log = deps.log ?? (() => {});
  const queues = new Map<number | string, Promise<void>>();
  /** The job each key is working on right now: its link and a switch to cancel it. */
  const inFlight = new Map<number | string, { url?: string; abort: AbortController }>();
  const stale = db.expireStaleActions();
  if (stale) log(`expired ${stale} approval(s) left pending by a previous run`);

  function enqueue(key: number | string, work: () => Promise<void>): void {
    const next = (queues.get(key) ?? Promise.resolve()).then(work).catch((err) => log(`approval error: ${(err as Error).stack ?? err}`));
    queues.set(key, next);
  }

  async function send(handle: string, text: string): Promise<void> {
    try {
      await channel.send(handle, text);
    } catch (err) {
      log(`send to ${handle} failed: ${(err as Error).message}`);
    }
  }

  /** A note in the owner's chat history so the next agent turn knows what happened. */
  function note(job: Job, outcome: string): void {
    if (job.accountId !== null) systemNote(job.accountId, `Action ${job.action.code} (${describeAction(job.action, titles)}) ${outcome}`);
  }
  // After DEL the account row is gone: write nothing for it (a new account could reuse the id).
  const systemNote = (accountId: number, content: string) => {
    if (db.account(accountId)) db.addMessage(accountId, "system", { role: "system", content });
  };

  function job(key: number | string, accountId: number | null, pubkey: string, handle: string, action: Action, options: RequestOptions): Job {
    validateAction(action);
    const prompt = options.prompt ?? `Please confirm on your Ledger: ${describeAction(action, titles)}`;
    return { key, accountId, pubkey, handle, action, prompt, linkPrompt: options.linkPrompt, expiredText: options.expiredText, reason: options.reason ?? "" };
  }

  /** Reserves the slot right away (one pending action per account); the prompt goes out through `deliver` or after `after`. */
  function begin(j: Job, options: Pick<RequestOptions, "after" | "deliver"> = {}): void {
    db.insertAction(j.accountId, j.action);
    log(`approval ${j.action.id.slice(0, 8)} ${j.action.code} pending for ${j.handle}${j.reason ? ` (${j.reason})` : ""}: ${describeAction(j.action, titles)}`);
    enqueue(j.key, async () => {
      const current = { abort: new AbortController() } as { url?: string; abort: AbortController };
      inFlight.set(j.key, current);
      try {
        await work(j, options, current);
      } finally {
        if (inFlight.get(j.key) === current) inFlight.delete(j.key);
      }
    });
  }

  /** One job: hand out the link, text the prompt (the link line tells them where else to approve), then wait for the device (or a cancel). */
  async function work(j: Job, options: Pick<RequestOptions, "after" | "deliver">, current: { url?: string; abort: AbortController }): Promise<void> {
    // A device manager that can sign elsewhere (the remote page) hands out a link for this action.
    const prepared = await deviceManager.prepare?.(j.pubkey, j.action).catch((err: unknown) => void log(`prepare failed: ${(err as Error).message}`));
    const url = prepared?.url;
    current.url = url;
    const prompt = url ? (j.linkPrompt?.(url) ?? `${j.prompt}\nOr approve from any computer your Ledger is plugged into: ${url}`) : j.prompt;
    if (options.deliver) await options.deliver(prompt).catch((err) => log(`deliver failed: ${(err as Error).message}`));
    else {
      await options.after;
      await send(j.handle, prompt);
    }
    await settle(j, current.abort.signal);
  }

  function setStatus(j: Job, status: Parameters<Db["setActionStatus"]>[1], extra: { signature?: string; error?: string } = {}): void {
    db.setActionStatus(j.action.id, status, extra);
    log(`approval ${j.action.id.slice(0, 8)} ${j.action.code} -> ${status}${extra.error ? `: ${extra.error}` : ""}`);
    if (status !== "pending" && status !== "approved") settled(j.action, status, {});
  }
  function settled(action: Action, status: Exclude<ActionStatus, "pending" | "approved">, extra: { txHash?: string }): void {
    try {
      deps.onSettled?.(action, status, extra);
    } catch (err) {
      log(`onSettled failed: ${(err as Error).stack ?? err}`);
    }
  }

  /** Texts everyone who heard about a payment once Base includes it (or does not within 2 minutes). */
  function watchReceipt(j: Job, hash: string, handles: string[]): void {
    enqueue(`receipt:${hash}`, async () => {
      const status = await money.confirm(hash);
      log(`tx ${hash} ${status}`);
      const text =
        status === "confirmed"
          ? `Confirmed on Base: ${onChainAmount(j.action)} to ${field(j.action, "To")}. ${txLink(hash)}`
          : status === "failed"
            ? `The payment to ${field(j.action, "To")} failed on Base. ${txLink(hash)}`
            : `Still waiting for Base to confirm the payment to ${field(j.action, "To")}. You can follow it here: ${txLink(hash)}`;
      if (j.accountId !== null) systemNote(j.accountId, `Payment ${hash}: ${status} on Base.`);
      for (const handle of handles) await send(handle, text);
    });
  }

  /** Asks the device, verifies, executes and texts the outcome. True when the action was executed. */
  async function settle(j: Job, signal: AbortSignal): Promise<boolean> {
    // Sign-up from an unknown Ledger: any device without an account may answer, and the account is bound to it.
    const accept = (pubkey: string) => !db.accountByPubkey(pubkey.toLowerCase());
    // Cancelled: stop waiting even if the device manager ignores the signal.
    const cancelled = new Promise<"cancelled">((resolve) => (signal.aborted ? resolve("cancelled") : signal.addEventListener("abort", () => resolve("cancelled"), { once: true })));
    const options = { signal, ...(deps.signTimeoutMs ? { timeoutMs: deps.signTimeoutMs } : {}), ...(j.pubkey === ANY_DEVICE ? { accept } : {}) };
    const result = await Promise.race([deviceManager.sign(j.pubkey, j.action, options), cancelled]);
    if (result === "cancelled" || signal.aborted) {
      setStatus(j, "expired", { error: "cancelled" });
      note(j, "was cancelled. Nothing happened.");
      return false;
    }
    if (result.status !== "approved") {
      const status = result.status === "rejected" ? "rejected" : result.status === "error" ? "failed" : "expired";
      setStatus(j, status, { error: result.status === "error" ? result.message : result.status === "rejected" ? undefined : result.status });
      note(j, result.status === "rejected" ? "was rejected on the device. Nothing happened." : `was not signed (${result.status}). Nothing happened.`);
      const expiredLink = (result.status === "no_device" || result.status === "timeout") && result.expiredLink;
      await send(j.handle, expiredLink ? (j.expiredText ?? LINK_EXPIRED) : outcomeText(result.status, money.appName));
      return false;
    }
    if (j.pubkey === ANY_DEVICE) {
      const pubkey = result.pubkey?.toLowerCase() ?? "";
      if (!pubkey || !accept(pubkey)) {
        setStatus(j, "failed", { signature: result.signature, error: `signer ${pubkey || "unknown"} already has an account` });
        await send(j.handle, `That Ledger already has an account, so I didn't create ${field(j.action, "Tag") ?? "it"}. Use a Ledger without an account and send me your tag again.`);
        return false;
      }
      j = { ...j, pubkey };
    }
    // Belt and braces: the device manager should only return good signatures, but never trust it.
    if (db.action(j.action.id)?.status !== "pending" || !money.verify(j.pubkey, j.action, result.signature)) {
      setStatus(j, "failed", { signature: result.signature, error: "signature did not verify" });
      note(j, "came back with a signature that did not match the owner's Ledger. Nothing happened.");
      await send(j.handle, "That approval didn't come from the Ledger on your account, so nothing happened.");
      return false;
    }
    setStatus(j, "approved", { signature: result.signature });
    // Ethereum mode: a signed PAY only counts once the network accepted it.
    let txHash: string | undefined;
    try {
      txHash = await money.submit(j.action, result.signature);
      if (txHash) db.setActionTxHash(j.action.id, txHash);
    } catch (err) {
      // The raw RPC reason goes to the log only; the owner gets plain words.
      const reason = (err as { shortMessage?: string }).shortMessage ?? (err as Error).message;
      const plain = /insufficient funds/i.test(reason) ? "not enough ETH to cover the network fee" : undefined;
      setStatus(j, "failed", { error: `broadcast failed: ${reason}` });
      note(j, `was signed but Base didn't accept it${plain ? ` (${plain})` : ""}. Nothing was sent.`);
      await send(j.handle, plain ? `Base didn't accept it: ${plain}. Nothing was sent.` : "Base didn't accept it, so nothing was sent.");
      return false;
    }
    const createdText = j.action.code === "ACC" ? await money.accountCreatedText(field(j.action, "Tag") ?? "", j.pubkey) : undefined;
    let outcome;
    try {
      // The mutation and the "executed" mark commit together, so a crash cannot leave one without the other.
      outcome = db.tx(() => {
        const result = execute(db, { accountId: j.accountId, handle: j.handle, pubkey: j.pubkey, txHash, createdText, startingCents: money.startingCents }, j.action);
        db.setActionStatus(j.action.id, "executed");
        return result;
      });
    } catch (err) {
      const reason = err instanceof ExecutorError ? err.message : "Something went wrong on my side, so nothing happened.";
      setStatus(j, "failed", { error: (err as Error).message });
      note(j, `was approved but failed: ${reason}`);
      await send(j.handle, reason);
      return false;
    }
    log(`approval ${j.action.id.slice(0, 8)} ${j.action.code} -> executed`);
    note(j, "was approved on the device and executed.");
    settled(j.action, "executed", { txHash });
    const proposer = j.accountId === null ? undefined : db.account(j.accountId);
    // The event is on AgentSign's calendar either way; Google is a mirror, so a failure there is only a line in the text.
    const googleLine = j.action.code === "CAL" && proposer && calendar ? await calendar.afterEvent(proposer.id) : undefined;
    for (const n of outcome.notifications) {
      const extra = n.handle === j.handle && googleLine ? [googleLine] : [];
      await send(n.handle, [n.text, ...extra].join(" "));
    }
    // A purchase follows its own payment (src/purchases.ts): the order text is its confirmation.
    if (txHash && !isPurchaseCode(j.action.code)) watchReceipt(j, txHash, outcome.notifications.map((n) => n.handle));
    return true;
  }

  return {
    async request(accountId, action, options = {}) {
      const account = db.account(accountId);
      const handle = account && db.primaryHandle(accountId);
      if (!account || !handle) throw new Error(`no account ${accountId}`);
      if (db.pendingAction(accountId)) throw new Error(PENDING_ERROR);
      begin(job(accountId, accountId, account.pubkey, handle, action, options), options);
    },
    async requestAccount(handle, pubkey, action, options = {}) {
      begin(job(`handle:${handle}`, null, pubkey, handle, action, options), options);
    },
    link: (key) => inFlight.get(key)?.url,
    cancel(key) {
      const current = inFlight.get(key);
      if (!current || current.abort.signal.aborted) return false;
      current.abort.abort();
      return true;
    },
    async whenIdle(key) {
      // Follow-ups can enqueue more work while we wait, so loop until nothing changed.
      for (;;) {
        const pending = key === undefined ? [...queues.values()] : [queues.get(key) ?? Promise.resolve()];
        await Promise.all(pending);
        const now = key === undefined ? [...queues.values()] : [queues.get(key) ?? Promise.resolve()];
        if (now.length === pending.length && now.every((p, i) => p === pending[i])) return;
      }
    },
  };
}
