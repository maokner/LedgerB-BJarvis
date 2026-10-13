/**
 * Buying through the operator's treasury: the buyer pays the treasury in USDC on Base (an action their Ledger signs),
 * the server then orders with the operator's own account and card, and the treasury refunds the buyer when nothing was
 * ordered. The treasury is the escrow: it holds the USDC from the Ledger's signature to the store's order confirmation,
 * and only a definite "nothing ordered" sends it back.
 *
 * One state machine for every store, one instance each: Amazon items (BUY, src/amazon/) and DoorDash food (EAT,
 * src/food/). A PurchaseWording carries what differs: the action code, the id the model passes, the Ledger's fields
 * and the texts. Each instance only reads and writes the purchase rows of its own code.
 *
 *   quote -> propose (the exact total, capped, the transfer) -> Ledger -> funded (tx broadcast)
 *   -> Base confirms -> ordering (checkpoint) -> ordered | no purchase -> refunding -> refunded
 *
 * Rules the code enforces, whatever the model asks for: the total (with shipping, fees, tax, tip) never exceeds the
 * limit; the card is charged only after the buyer's payment is confirmed on Base; a refund goes out only on a definite
 * no-purchase; "ordering" is written before the order is placed and is never re-run, so a crash cannot order twice.
 */
import { newActionId, toFieldText } from "./actions.js";
import { cleanAddress, looksLikeAddress, noAddress, savedAddress, shortAddress } from "./address.js";
import { formatUsdc, txLink } from "./chain.js";
import type { Account, Db, Purchase, PurchaseStatus } from "./db.js";
import { formatCents } from "./format.js";
import { type Merchant, MerchantError, type Outcome, type Quote, shortTitle, WrongAddress, wrongAddressText } from "./merchant.js";
import { formatEth, type Money } from "./money.js";
import type { Treasury } from "./treasury.js";
import type { ActionStatus } from "./db.js";
import type { Action, ActionField, Channel, PurchaseCode } from "./types.js";

export const DEFAULT_LIMIT_CENTS = 2_000;
/** How long the funding transaction may take on Base before a person has to look. */
const RECEIPT_TRIES = 3;

/** What differs between stores: the action code, the id the model passes, what the Ledger and the texts say. */
export interface PurchaseWording {
  /** The action the Ledger signs. */
  code: PurchaseCode;
  /** How the owner's history names one: "Amazon purchase", "DoorDash order". */
  noun: string;
  /** How much of the title the history notes and the operator's texts keep. Default 48. */
  titleLength?: number;
  /** propose()'s argument as the id merchant.prepare() takes, or an "Error: ..." line for the model. */
  id(raw: string): { id: string } | { error: string };
  /** The model's error for a total over the limit (`limit` is formatted, "$20.00"). */
  overLimit(quote: Quote, limit: string): string;
  /** Every field the Ledger shows, ending with Total, USDC and To. */
  fields(quote: Quote, usdc: string, treasury: string): ActionField[];
  /** The "Please confirm on your Ledger: ..." text. `refunds`: the treasury can send the USDC back from this server. */
  prompt(quote: Quote, usdc: string, treasury: string, refunds: boolean): string;
  /** The owner's text once the store took the order; `paid` reads "4.35 USDC ($4.35)". */
  ordered(quote: Quote, outcome: Extract<Outcome, { status: "ordered" }>, paid: string): string;
  /** The owner-facts line: what can be bought here and how. */
  fact(owner: Account, terms: { limit: string; treasury: string; refunds: boolean }): string;
  /**
   * The order ships to the owner: propose() takes the address given for this order, else the owner's saved delivery
   * address, refuses without one, and hands it to merchant.prepare() and the quote. Food quotes carry their own address.
   */
  shipsToOwner?: boolean;
}

const BUYABLE_ASIN = /^[A-Z0-9]{10}$/;

/** Amazon: one unit of one item by its ASIN, shipped to the owner's delivery address (or the one named for the order). */
export function amazonWording(store: string): PurchaseWording {
  const item = (quote: Quote) => toFieldText(shortTitle(quote.title, 48));
  const shipTo = (quote: Quote) => {
    if (!quote.shipTo) throw new Error("an Amazon purchase without its address");
    return quote.shipTo;
  };
  return {
    code: "BUY",
    noun: `${store} purchase`,
    shipsToOwner: true,
    id(raw) {
      const asin = raw.trim().toUpperCase();
      return BUYABLE_ASIN.test(asin) ? { id: asin } : { error: `Error: Item must be the 10-character item id from search_${store.toLowerCase()}, like B0DEMO0001.` };
    },
    overLimit: (quote, limit) =>
      `Error: ${shortTitle(quote.title, 60)} costs ${formatCents(quote.totalCents)} all in (item ${formatCents(quote.itemCents)} plus shipping and tax), over the ${limit} limit. Tell the owner; do not propose it.`,
    fields: (quote, usdc, treasury) => [
      { label: "Item", value: item(quote) },
      { label: "Ship", value: shortAddress(shipTo(quote)) },
      { label: "Total", value: formatCents(quote.totalCents) },
      { label: "USDC", value: usdc },
      { label: "To", value: treasury },
    ],
    prompt: (quote, usdc, treasury, refunds) =>
      `Please confirm on your Ledger: Buy on ${store}: ${item(quote)}, ${formatCents(quote.totalCents)} all in. That is ${usdc} USDC to the AgentSign treasury ${treasury}; it ships to ${shipTo(quote)}${refunds ? ", and comes back to you if the order doesn't go through" : ""}.`,
    // A row quoted before addresses were per order has none; its text just leaves the address out.
    ordered: (quote, outcome, paid) => `Order confirmed on ${store}: ${shortTitle(quote.title, 80)}. Order ${outcome.orderId}, paid ${paid}.${quote.shipTo ? ` It ships to ${quote.shipTo}.` : ""}`,
    fact: (owner, t) =>
      `${store}: ${owner.tag} can buy things there through you, up to ${t.limit} per order all in, paid in USDC on Base from their address (plus a little ETH for the fee) to the treasury ${t.treasury}. ` +
      `Orders ship to the delivery address in these facts unless they name another one for that order.${t.refunds ? " The USDC comes back if the order does not go through." : ""}`,
  };
}

export interface PurchasesOptions {
  db: Db;
  merchant: Merchant;
  treasury: Treasury;
  /** Ethereum mode money: plans the transfer and confirms the receipt. */
  money: Money;
  channel: Pick<Channel, "send">;
  /** Per-order cap on the checkout total. Default $20.00. */
  limitCents?: number;
  /**
   * The operator's Amazon account's own address, in words (PURCHASE_SHIPS_TO, "Matt's address"). Orders ship to the
   * owner's delivery address; this only names the account's address when the store cannot ship elsewhere (WrongAddress).
   */
  shipsTo?: string;
  /** The store's code and texts. Default: Amazon (BUY), shipped to the owner's delivery address. */
  wording?: PurchaseWording;
  /** The operator, texted when a purchase needs a person (an uncertain order, a failed refund). The handle is looked up when needed. */
  operator?: { name: string; handle?: () => string | undefined };
  log?: (line: string) => void;
}

export interface Purchases {
  /** The action this instance follows: BUY or EAT. */
  readonly code: PurchaseCode;
  readonly store: string;
  readonly limitCents: number;
  readonly treasuryAddress: string;
  /** Whether the treasury can send a buyer's money back from this server. */
  readonly refunds: boolean;
  /** Products for the model, as JSON, or an "Error: ..." line. */
  search(query: string, limit?: number): Promise<string>;
  /**
   * The action for what `id` names (an ASIN, a food quote id): quote, cap, USDC transfer to the treasury. Or an
   * "Error: ..." line for the model. `shipTo`: the address for this order where the store ships to the owner
   * (Amazon); default their saved delivery address.
   */
  propose(owner: Account, id: string, options?: { shipTo?: string }): Promise<{ action: Action; prompt: string } | string>;
  /** A proposal that never reached the Ledger (another action was pending). */
  cancel(actionId: string): void;
  /** Approvals hook: the action was executed (payment broadcast) or ended otherwise. Other codes are ignored. Work continues in the background. */
  onSettled(action: Action, status: ActionStatus, extra: { txHash?: string }): void;
  /** The owner's purchases at this store for the model. */
  list(accountId: number): Record<string, unknown>[];
  /** The owner-facts line. */
  fact(owner: Account): string;
  /** Picks up purchases a previous run left in flight. Call once at startup. */
  resume(): void;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
}

export function createPurchases(o: PurchasesOptions): Purchases {
  const { db, merchant, treasury, money, channel } = o;
  const limitCents = o.limitCents ?? DEFAULT_LIMIT_CENTS;
  const operator = o.operator ?? { name: "the operator" };
  const wording = o.wording ?? amazonWording(merchant.name);
  const { code } = wording;
  const short = (title: string) => shortTitle(title, wording.titleLength);
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
    if (db.account(p.account_id)) db.addMessage(p.account_id, "system", { role: "system", content: `${wording.noun} ${short(p.title)} (${formatCents(p.total_cents)}): ${text}` });
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
    await send(operator.handle?.(), `Purchase ${p.action_id.slice(0, 8)} for ${owner?.tag ?? "a deleted account"} needs you: ${why}. Item ${short(p.title)}, paid ${paid(p)}${p.fund_tx_hash ? ` (${txLink(p.fund_tx_hash)})` : ""}.`);
  }

  /** Nothing was ordered: the money goes back to the buyer, gas on the treasury. */
  async function refund(p: Purchase, reason: string): Promise<void> {
    set(p, "refunding", { error: reason });
    let hash: string;
    try {
      hash = await treasury.refund(p.buyer, BigInt(p.wei), p.asset);
    } catch (err) {
      const why = `refund of ${paid(p)} to ${p.buyer} failed: ${(err as Error).message}`;
      return escalate(p, "refund_failed", why, `${merchant.name} didn't take the order (${reason}), so nothing was charged, but I couldn't send your ${paid(p)} back automatically. ${operator.name} will sort it out.`);
    }
    set(p, "refunded", { refundTxHash: hash });
    note(p, `nothing was ordered (${reason}); refunded ${paid(p)}, tx ${hash}.`);
    await send(ownerHandle(p), `${merchant.name} didn't take the order (${reason}), so nothing was charged. Your ${paid(p)} is on its way back: ${txLink(hash)}`);
  }

  /** From the broadcast of the buyer's payment to the order (or the refund). Safe to run again after a restart. */
  async function settleFunded(p: Purchase): Promise<void> {
    if (!p.fund_tx_hash) return escalate(p, "review", "funded without a transaction hash", `Something went wrong on my side with your ${merchant.name} order. ${operator.name} is looking at it.`);
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
      note(p, `ordered on ${merchant.name}, order ${outcome.orderId}${outcome.etaMinutes ? `, arriving in about ${outcome.etaMinutes} minutes` : ""}.`);
      return send(ownerHandle(p), wording.ordered(quote, outcome, paid(p)));
    }
    if (outcome.status === "no_purchase") return refund(p, outcome.reason);
    return escalate(p, "review", outcome.reason, `I couldn't tell whether ${merchant.name} took the order (${outcome.reason}). Nothing more is charged; ${operator.name} is checking and you'll hear back.`);
  }

  return {
    code,
    store: merchant.name,
    limitCents,
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
        ships_to: "the owner's delivery address (in the facts), or Ship <address> on propose_action BUY for another one",
        note: "Listed prices leave out shipping and tax. propose_action BUY with Item <asin> quotes the exact total and refuses anything over the limit.",
        results: products.map((p) => ({ asin: p.asin, title: p.title, price: p.priceCents === null ? "no price shown" : formatCents(p.priceCents), ...(p.rating ? { rating: p.rating } : {}), url: p.url })),
      });
    },

    async propose(owner, raw, options = {}) {
      const parsed = wording.id(raw);
      if ("error" in parsed) return parsed.error;
      // Where it ships: the address named for this order, else the owner's saved one (read fresh: it may have been saved this turn).
      let shipTo: string | undefined;
      if (wording.shipsToOwner) {
        const given = cleanAddress(options.shipTo);
        if (given && !looksLikeAddress(given)) return "Error: Ship does not look like a street address. Ask the owner for the full one: number, street, city (and apartment, if any).";
        shipTo = given || savedAddress(db, owner);
        if (!shipTo) return noAddress("ship");
      }
      let quote: Quote;
      try {
        quote = await merchant.prepare(parsed.id, shipTo ? { shipTo } : undefined);
        if (shipTo) quote = { ...quote, shipTo };
      } catch (err) {
        // A store that cannot ship there names its account's address only in words (PURCHASE_SHIPS_TO), never the address itself.
        if (err instanceof WrongAddress) return `Error: ${wrongAddressText(err.address, o.shipsTo)}. Tell the owner; do not propose it.`;
        if (err instanceof MerchantError) return `Error: ${err.message.replace(/[^.!?]$/, "$&.")} Tell the owner; do not propose it.`;
        log(`prepare ${parsed.id} failed: ${(err as Error).stack ?? err}`);
        return `Error: ${merchant.name} could not quote that right now. Tell the owner to try again later.`;
      }
      // The cap on the exact total, here at prepare; the stores check it again at confirm.
      if (quote.totalCents > limitCents) return wording.overLimit(quote, formatCents(limitCents));
      const transfer = await money.transferUsdc(owner, treasury.address, quote.totalCents);
      if (typeof transfer === "string") return transfer;
      const action: Action = { code, id: newActionId(), fields: wording.fields(quote, transfer.usdc, treasury.address), meta: transfer.meta };
      db.insertPurchase({ action_id: action.id, code, account_id: owner.id, asin: parsed.id, title: quote.title, quote: JSON.stringify(quote), total_cents: quote.totalCents, wei: transfer.units.toString(), asset: "USDC", treasury: treasury.address, buyer: owner.pubkey });
      return { action, prompt: wording.prompt(quote, transfer.usdc, treasury.address, treasury.canRefund) };
    },

    cancel(actionId) {
      const p = db.purchase(actionId);
      if (p?.status === "proposed") set(p, "cancelled", { error: "not proposed" });
    },

    onSettled(action, status, extra) {
      if (action.code !== code) return;
      const p = db.purchase(action.id);
      if (!p || p.status !== "proposed") return;
      if (status !== "executed") {
        set(p, "cancelled", { error: `the action was ${status}` });
        return;
      }
      if (!extra.txHash) {
        enqueue(() => escalate(p, "review", "executed without a transaction hash", `Something went wrong on my side with your ${merchant.name} order. ${operator.name} is looking at it.`));
        return;
      }
      set(p, "funded", { fundTxHash: extra.txHash });
      enqueue(() => settleFunded(db.purchase(action.id)!));
    },

    list(accountId) {
      return db.purchases(accountId, 10, code).map((p) => ({
        store: merchant.name,
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

    fact: (owner) => wording.fact(owner, { limit: formatCents(limitCents), treasury: treasury.address, refunds: treasury.canRefund }),

    resume() {
      // The approvals layer expired every action a previous run left pending, so these proposals went nowhere.
      for (const p of db.purchasesIn(["proposed"], code)) set(p, "cancelled", { error: "server restarted" });
      // Funded: the receipt check and the ordering checkpoint make this safe to run again.
      for (const p of db.purchasesIn(["funded"], code)) enqueue(() => settleFunded(p));
      // Mid-order or mid-refund when the process died: the side effect may or may not have happened. Never redo it.
      for (const p of db.purchasesIn(["ordering", "refunding"], code)) {
        const what = p.status === "ordering" ? "the order" : "the refund";
        enqueue(() => escalate(p, "review", `the server restarted while ${what} was in progress`, `I lost track of your ${merchant.name} order while restarting. ${operator.name} is checking whether it went through; you'll hear back.`));
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

const UNAVAILABLE: Record<PurchaseCode, string> = {
  BUY: "Amazon: not available on this server, so nothing can be bought.",
  EAT: "DoorDash: not available on this server, so no food can be ordered.",
};

/** The line in the owner facts: what buying on Amazon (BUY) or ordering food (EAT) can do here. */
export function purchasesFact(purchases: Pick<Purchases, "fact"> | undefined, owner: Account, code: PurchaseCode = "BUY"): string {
  return purchases ? purchases.fact(owner) : UNAVAILABLE[code];
}
