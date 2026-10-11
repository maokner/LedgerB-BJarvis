/**
 * Buying on Amazon with ETH: the buyer pays the operator's treasury on Base (a BUY action their Ledger signs), the
 * server then orders the item with the operator's own Amazon account and card, and the treasury refunds the buyer
 * when nothing was ordered. The treasury is the escrow: it holds the ETH from the Ledger's signature to Amazon's
 * order confirmation, and only a definite "nothing ordered" sends it back.
 *
 *   search -> propose (quote the exact total, cap it, build the transfer) -> Ledger -> funded (tx broadcast)
 *   -> Base confirms -> ordering (checkpoint) -> ordered | no purchase -> refunding -> refunded
 *
 * Rules the code enforces, whatever the model asks for: the total (item, shipping, tax) never exceeds the limit; the
 * card is charged only after the buyer's ETH is confirmed on Base; a refund goes out only on a definite no-purchase;
 * "ordering" is written before the order is placed and is never re-run, so a crash cannot order twice.
 */
import { newActionId, toFieldText } from "./actions.js";
import { formatUsdc, txLink } from "./chain.js";
import type { Account, Db, Purchase, PurchaseStatus } from "./db.js";
import { formatCents } from "./format.js";
import { type Merchant, MerchantError, type Quote, shortTitle } from "./merchant.js";
import { formatEth, type Money } from "./money.js";
import type { Treasury } from "./treasury.js";
import type { ActionStatus } from "./db.js";
import type { Action, Channel } from "./types.js";

export const DEFAULT_LIMIT_CENTS = 2_000;
/** How long the funding transaction may take on Base before a person has to look. */
const RECEIPT_TRIES = 3;

export interface PurchasesOptions {
  db: Db;
  merchant: Merchant;
  treasury: Treasury;
  /** Ethereum mode money: plans the transfer and confirms the receipt. */
  money: Money;
  channel: Pick<Channel, "send">;
  /** Per-order cap on the checkout total. Default $20.00. */
  limitCents?: number;
  /** Where Amazon ships (the operator's default address), in words: "Matt's address". */
  shipsTo?: string;
  /** The operator, texted when a purchase needs a person (an uncertain order, a failed refund). The handle is looked up when needed. */
  operator?: { name: string; handle?: () => string | undefined };
  log?: (line: string) => void;
}

export interface Purchases {
  readonly store: string;
  readonly limitCents: number;
  readonly shipsTo: string;
  readonly treasuryAddress: string;
  /** Whether the treasury can send a buyer's money back from this server. */
  readonly refunds: boolean;
  /** Products for the model, as JSON, or an "Error: ..." line. */
  search(query: string, limit?: number): Promise<string>;
  /** The BUY action for one unit of `asin` (quote, cap, ETH transfer to the treasury), or an "Error: ..." line for the model. */
  propose(owner: Account, asin: string): Promise<{ action: Action; prompt: string } | string>;
  /** A proposal that never reached the Ledger (another action was pending). */
  cancel(actionId: string): void;
  /** Approvals hook: the BUY was executed (ETH broadcast) or ended otherwise. Work continues in the background. */
  onSettled(action: Action, status: ActionStatus, extra: { txHash?: string }): void;
  /** The owner's purchases for the model. */
  list(accountId: number): Record<string, unknown>[];
  /** Picks up purchases a previous run left in flight. Call once at startup. */
  resume(): void;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
}

const BUYABLE_ASIN = /^[A-Z0-9]{10}$/;

export function createPurchases(o: PurchasesOptions): Purchases {
  const { db, merchant, treasury, money, channel } = o;
  const limitCents = o.limitCents ?? DEFAULT_LIMIT_CENTS;
  const operator = o.operator ?? { name: "the operator" };
  const shipsTo = o.shipsTo ?? `${operator.name}'s address`;
  const log = o.log ?? (() => {});
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    queue = queue.then(work).catch((err) => log(`purchase error: ${(err as Error).stack ?? err}`));
  };

  async function send(handle: string | undefined, text: string): Promise<void> {
    if (!handle) return;
    await channel.send(handle, text).catch((err: unknown) => log(`send to ${handle} failed: ${(err as Error).message}`));
  }
  const ownerHandle = (p: Purchase) => db.primaryHandle(p.account_id);
  /** A note in the owner's chat history so the next agent turn can answer "did it go through?". */
  const note = (p: Purchase, text: string) => {
    if (db.account(p.account_id)) db.addMessage(p.account_id, "system", { role: "system", content: `Amazon purchase ${shortTitle(p.title)} (${formatCents(p.total_cents)}): ${text}` });
  };
  const set = (p: Purchase, status: PurchaseStatus, extra: Parameters<Db["setPurchaseStatus"]>[2] = {}) => {
    db.setPurchaseStatus(p.action_id, status, extra);
    log(`purchase ${p.action_id.slice(0, 8)} ${shortTitle(p.title, 30)} -> ${status}${extra.error ? `: ${extra.error}` : ""}`);
  };
  // The exact amount the Ledger showed (18 decimals for ETH: usdToWei rounds to 4 significant digits, so it stays short).
  const amount = (p: Purchase) => (p.asset === "USDC" ? `${formatUsdc(BigInt(p.wei))} USDC` : `${formatEth(BigInt(p.wei), 18)} ETH`);
  const paid = (p: Purchase) => `${amount(p)} (${formatCents(p.total_cents)})`;

  /** Something a person must look at: the operator hears about it (and the owner, in `ownerText`). */
  async function escalate(p: Purchase, status: "review" | "refund_failed", why: string, ownerText: string): Promise<void> {
    set(p, status, { error: why });
    note(p, `${status === "review" ? "needs a look" : "the refund failed"}: ${why}`);
    await send(ownerHandle(p), ownerText);
    const owner = db.account(p.account_id);
    await send(operator.handle?.(), `Purchase ${p.action_id.slice(0, 8)} for ${owner?.tag ?? "a deleted account"} needs you: ${why}. Item ${shortTitle(p.title)}, paid ${paid(p)}${p.fund_tx_hash ? ` (${txLink(p.fund_tx_hash)})` : ""}.`);
  }

  /** Nothing was ordered: the ETH goes back to the buyer, gas on the treasury. */
  async function refund(p: Purchase, reason: string): Promise<void> {
    set(p, "refunding", { error: reason });
    let hash: string;
    try {
      hash = await treasury.refund(p.buyer, BigInt(p.wei), p.asset);
    } catch (err) {
      const why = `refund of ${paid(p)} to ${p.buyer} failed: ${(err as Error).message}`;
      return escalate(p, "refund_failed", why, `Amazon didn't take the order (${reason}), so nothing was charged, but I couldn't send your ${paid(p)} back automatically. ${operator.name} will sort it out.`);
    }
    set(p, "refunded", { refundTxHash: hash });
    note(p, `nothing was ordered (${reason}); refunded ${paid(p)}, tx ${hash}.`);
    await send(ownerHandle(p), `Amazon didn't take the order (${reason}), so nothing was charged. Your ${paid(p)} is on its way back: ${txLink(hash)}`);
  }

  /** From the broadcast of the buyer's ETH to the order (or the refund). Safe to run again after a restart. */
  async function settleFunded(p: Purchase): Promise<void> {
    if (!p.fund_tx_hash) return escalate(p, "review", "funded without a transaction hash", `Something went wrong on my side with your Amazon order. ${operator.name} is looking at it.`);
    let receipt: Awaited<ReturnType<Money["confirm"]>> = "timeout";
    for (let i = 0; i < RECEIPT_TRIES && receipt === "timeout"; i++) receipt = await money.confirm(p.fund_tx_hash);
    log(`purchase ${p.action_id.slice(0, 8)} funding ${p.fund_tx_hash} ${receipt}`);
    if (receipt === "failed") {
      set(p, "cancelled", { error: "the payment failed on Base" });
      note(p, "the payment failed on Base; nothing was ordered or charged.");
      return send(ownerHandle(p), `Base rejected the payment, so nothing was ordered and nothing was charged. ${txLink(p.fund_tx_hash)}`);
    }
    if (receipt === "timeout") {
      return escalate(p, "review", `the payment ${p.fund_tx_hash} did not confirm on Base`, `Base still hasn't confirmed your payment, so I haven't ordered anything. ${operator.name} is keeping an eye on it. ${txLink(p.fund_tx_hash)}`);
    }
    // The checkpoint: from here on the order may exist, so this purchase is never retried, only inspected.
    set(p, "ordering");
    const quote = JSON.parse(p.quote) as Quote;
    let outcome;
    try {
      outcome = await merchant.confirm(quote);
    } catch (err) {
      const why = `${merchant.name} did not answer clearly: ${(err as Error).message}`;
      return escalate(p, "review", why, `I couldn't tell whether ${merchant.name} took the order. Nothing more is charged; ${operator.name} is checking and you'll hear back.`);
    }
    if (outcome.status === "ordered") {
      set(p, "ordered", { orderId: outcome.orderId });
      note(p, `ordered on ${merchant.name}, order ${outcome.orderId}.`);
      return send(ownerHandle(p), `Order confirmed on ${merchant.name}: ${shortTitle(p.title, 80)}. Order ${outcome.orderId}, paid ${paid(p)}. It ships to ${shipsTo}.`);
    }
    if (outcome.status === "no_purchase") return refund(p, outcome.reason);
    return escalate(p, "review", outcome.reason, `I couldn't tell whether ${merchant.name} took the order (${outcome.reason}). Nothing more is charged; ${operator.name} is checking and you'll hear back.`);
  }

  return {
    store: merchant.name,
    limitCents,
    shipsTo,
    treasuryAddress: treasury.address,
    refunds: treasury.canRefund,

    async search(query, limit = 5) {
      const q = query.replace(/\s+/g, " ").trim();
      if (q.length < 2) return "Error: say what to search for.";
      let products;
      try {
        products = await merchant.search(q, Math.min(Math.max(limit, 1), 8));
      } catch (err) {
        if (err instanceof MerchantError) return `Error: ${err.message}`;
        log(`search failed: ${(err as Error).stack ?? err}`);
        return `Error: ${merchant.name} could not be searched right now.`;
      }
      return JSON.stringify({
        store: merchant.name,
        limit: `${formatCents(limitCents)} per order, all in (item, shipping, tax)`,
        ships_to: shipsTo,
        note: "Listed prices leave out shipping and tax. propose_action BUY with Item <asin> quotes the exact total and refuses anything over the limit.",
        results: products.map((p) => ({ asin: p.asin, title: p.title, price: p.priceCents === null ? "no price shown" : formatCents(p.priceCents), ...(p.rating ? { rating: p.rating } : {}), url: p.url })),
      });
    },

    async propose(owner, rawAsin) {
      const asin = rawAsin.trim().toUpperCase();
      if (!BUYABLE_ASIN.test(asin)) return `Error: Item must be the 10-character item id from search_${merchant.name.toLowerCase()}, like B0DEMO0001.`;
      let quote: Quote;
      try {
        quote = await merchant.prepare(asin);
      } catch (err) {
        if (err instanceof MerchantError) return `Error: ${err.message} Tell the owner; do not propose it.`;
        log(`prepare ${asin} failed: ${(err as Error).stack ?? err}`);
        return `Error: ${merchant.name} could not quote that item right now. Tell the owner to try again later.`;
      }
      if (quote.totalCents > limitCents) {
        return `Error: ${shortTitle(quote.title, 60)} costs ${formatCents(quote.totalCents)} all in (item ${formatCents(quote.itemCents)} plus shipping and tax), over the ${formatCents(limitCents)} limit. Tell the owner; do not propose it.`;
      }
      const transfer = await money.transferUsdc(owner, treasury.address, quote.totalCents);
      if (typeof transfer === "string") return transfer;
      const item = toFieldText(shortTitle(quote.title, 48));
      const action: Action = {
        code: "BUY",
        id: newActionId(),
        fields: [
          { label: "Item", value: item },
          { label: "Total", value: formatCents(quote.totalCents) },
          { label: "USDC", value: transfer.usdc },
          { label: "To", value: treasury.address },
        ],
        meta: transfer.meta,
      };
      db.insertPurchase({ action_id: action.id, account_id: owner.id, asin, title: quote.title, quote: JSON.stringify(quote), total_cents: quote.totalCents, wei: transfer.units.toString(), asset: "USDC", treasury: treasury.address, buyer: owner.pubkey });
      const back = treasury.canRefund ? ", and comes back to you if the order doesn't go through" : "";
      const prompt = `Please confirm on your Ledger: Buy on ${merchant.name}: ${item}, ${formatCents(quote.totalCents)} all in. That is ${transfer.usdc} USDC to the AgentSign treasury ${treasury.address}; it ships to ${shipsTo}${back}.`;
      return { action, prompt };
    },

    cancel(actionId) {
      const p = db.purchase(actionId);
      if (p?.status === "proposed") set(p, "cancelled", { error: "not proposed" });
    },

    onSettled(action, status, extra) {
      if (action.code !== "BUY") return;
      const p = db.purchase(action.id);
      if (!p || p.status !== "proposed") return;
      if (status !== "executed") {
        set(p, "cancelled", { error: `the action was ${status}` });
        return;
      }
      if (!extra.txHash) {
        enqueue(() => escalate(p, "review", "executed without a transaction hash", `Something went wrong on my side with your Amazon order. ${operator.name} is looking at it.`));
        return;
      }
      set(p, "funded", { fundTxHash: extra.txHash });
      enqueue(() => settleFunded(db.purchase(action.id)!));
    },

    list(accountId) {
      return db.purchases(accountId).map((p) => ({
        item: p.title,
        total: formatCents(p.total_cents),
        paid: amount(p),
        status: p.status,
        ...(p.order_id ? { order: p.order_id } : {}),
        ...(p.fund_tx_hash ? { payment: txLink(p.fund_tx_hash) } : {}),
        ...(p.refund_tx_hash ? { refund: txLink(p.refund_tx_hash) } : {}),
        ...(p.error && p.status !== "ordered" ? { note: p.error } : {}),
        at: p.created_at,
      }));
    },

    resume() {
      // The approvals layer expired every action a previous run left pending, so these proposals went nowhere.
      for (const p of db.purchasesIn(["proposed"])) set(p, "cancelled", { error: "server restarted" });
      // Funded: the receipt check and the ordering checkpoint make this safe to run again.
      for (const p of db.purchasesIn(["funded"])) enqueue(() => settleFunded(p));
      // Mid-order or mid-refund when the process died: the side effect may or may not have happened. Never redo it.
      for (const p of db.purchasesIn(["ordering", "refunding"])) {
        const what = p.status === "ordering" ? "the order" : "the refund";
        enqueue(() => escalate(p, "review", `the server restarted while ${what} was in progress`, `I lost track of your Amazon order while restarting. ${operator.name} is checking whether it went through; you'll hear back.`));
      }
    },

    async whenIdle() {
      for (;;) {
        const current = queue;
        await current;
        if (queue === current) return;
      }
    },
    close: () => merchant.close(),
  };
}

/** The line in the owner facts: what buying can do here. */
export function purchasesFact(purchases: Purchases | undefined, owner: Account): string {
  if (!purchases) return "Amazon: not available on this server, so nothing can be bought.";
  return `${purchases.store}: ${owner.tag} can buy things there through you, up to ${formatCents(purchases.limitCents)} per order all in, paid in USDC on Base from their address (plus a little ETH for the fee) to the treasury ${purchases.treasuryAddress}, shipped to ${purchases.shipsTo}.${purchases.refunds ? " The USDC comes back if the order does not go through." : ""}`;
}
