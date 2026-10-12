/**
 * Ordering food: a FoodProvider (src/food/provider.ts) behind the same treasury escrow as Amazon purchases
 * (src/purchases.ts, action code EAT). The owner pays USDC on Base to the operator's treasury, and once Base confirms,
 * the server places the order on the operator's DoorDash account.
 *
 *   search_doordash -> doordash_menu -> quote_doordash (a draft: exact total, kept here for a while under a short id)
 *   -> propose_action EAT Order <quote_id> -> prepare prices the draft again, the cap, the USDC transfer -> Ledger
 *   -> funded -> Base confirms -> ordering -> confirm places it -> ordered (with the ETA) | refunded | review
 *
 * Drafts live in memory: a restart forgets them, and the model quotes again. A draft belongs to the owner who asked
 * for it, so nobody can propose another owner's order (or their address).
 */
import { randomBytes } from "node:crypto";
import { toFieldText } from "../actions.js";
import type { Account, Db } from "../db.js";
import { formatCents } from "../format.js";
import { type Merchant, MerchantError, type Quote } from "../merchant.js";
import { createPurchases, type Purchases, type PurchasesOptions, type PurchaseWording } from "../purchases.js";
import { checkLines, DEFAULT_TIP_PERCENT, type FoodOrder, type FoodProvider, type FoodQuote, itemsSummary, type OrderLine } from "./provider.js";

export const DEFAULT_FOOD_LIMIT_CENTS = 4_000;
const DRAFT_TTL_MS = 20 * 60_000;
const MAX_TIP_PERCENT = 40;
const DRAFT_ID = /^q[0-9a-f]{6}$/;
const NO_ADDRESS = "Error: there is no delivery address. Ask the owner where to deliver; when they give their own address, save it with set_delivery_address.";

export interface FoodOptions extends Omit<PurchasesOptions, "merchant" | "wording" | "shipsTo"> {
  provider: FoodProvider;
  /** How long a quote_doordash draft can be proposed. Default 20 minutes. */
  draftTtlMs?: number;
}

/** The EAT purchases (the escrow) plus the tools that find and price the food. */
export type Food = Omit<Purchases, "search"> & {
  /** "DoorDash" */
  readonly provider: string;
  /** Restaurants for the model, as JSON, or an "Error: ..." line. Delivers to `address`, else the owner's saved one. */
  restaurants(owner: Account, query: string, address?: string): Promise<string>;
  /** A restaurant's items with ids and prices, as JSON, or an "Error: ..." line. */
  menu(storeId: string): Promise<string>;
  /** Prices an order and keeps it as a draft for EAT, as JSON with its quote_id, or an "Error: ..." line. */
  quote(owner: Account, request: { storeId: string; items: OrderLine[]; tipPercent?: number; address?: string }): Promise<string>;
  /** Saves the owner's own delivery address; the line for the model. */
  setAddress(owner: Account, address: string): string;
};

interface Draft {
  accountId: number;
  order: FoodOrder;
  expiresAt: number;
}

/** An address as the Ledger's Deliver field: the street and the city, cut to one line. */
export function shortAddress(address: string): string {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  const two = parts.slice(0, 2).join(", ");
  return toFieldText(two.length <= 48 ? two : (parts[0] ?? address));
}

const eta = (minutes: number | undefined) => (minutes ? `about ${minutes} minutes` : undefined);

/** EAT: From, Order, Deliver, Total, USDC, To on the Ledger; "Order food on DoorDash: ..." in the texts. */
export function foodWording(store: string): PurchaseWording {
  const food = (quote: Quote): FoodQuote => {
    if (!quote.food) throw new Error("a food purchase without its food quote");
    return quote.food;
  };
  return {
    code: "EAT",
    noun: `${store} order`,
    titleLength: 120,
    id(raw) {
      const id = raw.trim().toLowerCase();
      return DRAFT_ID.test(id) ? { id } : { error: `Error: Order must be the quote_id from quote_doordash, like q1a2b3c. Quote the order first.` };
    },
    overLimit: (quote, limit) =>
      `Error: that order comes to ${formatCents(quote.totalCents)} all in (food ${formatCents(quote.itemCents)} plus fees, tax and tip), over the ${limit} limit. Tell the owner; do not propose it.`,
    fields(quote, usdc, treasury) {
      const f = food(quote);
      return [
        { label: "From", value: toFieldText(f.restaurant) },
        { label: "Order", value: toFieldText(itemsSummary(f.items)) },
        { label: "Deliver", value: shortAddress(f.address) },
        { label: "Total", value: formatCents(f.totalCents) },
        { label: "USDC", value: usdc },
        { label: "To", value: treasury },
      ];
    },
    prompt(quote, usdc, treasury, refunds) {
      const f = food(quote);
      const when = eta(f.etaMinutes);
      return (
        `Please confirm on your Ledger: Order food on ${store}: ${f.restaurant}, ${itemsSummary(f.items)}, ${formatCents(f.totalCents)} all in, delivered to ${f.address}${when ? ` in ${when}` : ""}. ` +
        `That is ${usdc} USDC to the AgentSign treasury ${treasury}${refunds ? "; it comes back to you if the order doesn't go through" : ""}.`
      );
    },
    ordered(quote, outcome, paid) {
      const f = food(quote);
      const when = eta(outcome.etaMinutes ?? f.etaMinutes);
      return `Order placed on ${store}: ${f.restaurant}, ${itemsSummary(f.items)}. Order ${outcome.orderId}, paid ${paid}. ${when ? `It arrives at ${f.address} in ${when}.` : `It's headed to ${f.address}.`}`;
    },
    fact: (owner, t) =>
      `${store}: ${owner.tag} can order food delivered through you, up to ${t.limit} per order all in (food, fees, tax and tip), paid in USDC on Base from their address (plus a little ETH for the fee) to the treasury ${t.treasury}.` +
      `${t.refunds ? " The USDC comes back if the order does not go through." : ""} ` +
      (owner.delivery_address ? `Delivery address: ${owner.delivery_address}.` : "Delivery address: none saved yet; ask for it before searching."),
  };
}

const toQuote = (draftId: string, f: FoodQuote): Quote => ({
  quoteId: f.quoteId,
  asin: draftId,
  title: `${f.restaurant}: ${itemsSummary(f.items)}`,
  itemCents: f.subtotalCents,
  totalCents: f.totalCents,
  expiresAt: f.expiresAt,
  food: f,
});

/**
 * The provider as a Merchant for createPurchases: prepare(draftId) prices the draft again (so the Ledger shows
 * today's total), confirm(quote) re-checks the cap and places it.
 */
export function foodMerchant(provider: FoodProvider, drafts: Map<string, Draft>, limitCents: number): Merchant {
  return {
    name: provider.name,
    async search() {
      throw new MerchantError(`restaurants are found with search_doordash`);
    },
    async prepare(draftId) {
      const draft = drafts.get(draftId);
      if (!draft || draft.expiresAt < Date.now()) throw new MerchantError(`The quote ${draftId} expired or does not exist; quote the order again with quote_doordash.`);
      return toQuote(draftId, await provider.quote(draft.order));
    },
    async confirm(quote) {
      if (!quote.food) return { status: "no_purchase", reason: "the order details were missing" };
      // The cap again at confirm, before anything reaches the provider.
      if (quote.food.totalCents > limitCents) return { status: "no_purchase", reason: "over the limit" };
      return provider.confirm(quote.food);
    },
    close: () => provider.close(),
  };
}

export function createFood(o: FoodOptions): Food {
  const { db, provider } = o;
  const limitCents = o.limitCents ?? DEFAULT_FOOD_LIMIT_CENTS;
  const ttl = o.draftTtlMs ?? DRAFT_TTL_MS;
  const log = o.log ?? (() => {});
  const drafts = new Map<string, Draft>();
  const { search: _search, ...purchases } = createPurchases({ ...o, limitCents, merchant: foodMerchant(provider, drafts, limitCents), wording: foodWording(provider.name) });
  const addressOf = (owner: Account, given?: string) => given?.replace(/\s+/g, " ").trim() || freshAccount(db, owner).delivery_address || undefined;
  const failed = (err: unknown, doing: string) => {
    if (err instanceof MerchantError) return `Error: ${err.message}`;
    log(`food: ${doing} failed: ${(err as Error).stack ?? err}`);
    return `Error: ${provider.name} could not ${doing} right now. Tell the owner to try again in a bit.`;
  };

  return {
    ...purchases,
    provider: provider.name,

    async propose(owner, raw) {
      // Only the owner who asked for a quote can pay for it.
      const draft = drafts.get(raw.trim().toLowerCase());
      if (draft && draft.accountId !== owner.id) return `Error: there is no quote ${raw.trim()} for ${owner.tag}. Quote the order with quote_doordash first.`;
      return purchases.propose(owner, raw);
    },

    async restaurants(owner, query, address) {
      const near = addressOf(owner, address);
      if (!near) return NO_ADDRESS;
      const q = query.replace(/\s+/g, " ").trim();
      if (q.length < 2) return "Error: say what kind of food to look for.";
      let found;
      try {
        found = await provider.searchRestaurants(q, near, 5);
      } catch (err) {
        return failed(err, "be searched");
      }
      return JSON.stringify({
        store: provider.name,
        deliver_to: near,
        limit: `${formatCents(limitCents)} per order, all in (food, fees, tax and tip)`,
        note: "Pick the restaurant that fits, then doordash_menu with its store_id.",
        results: found.map((r) => ({
          store_id: r.storeId,
          name: r.name,
          ...(r.cuisine ? { cuisine: r.cuisine } : {}),
          ...(r.rating ? { rating: r.rating } : {}),
          ...(r.etaMinutes ? { eta: eta(r.etaMinutes) } : {}),
          ...(r.deliveryFeeCents !== undefined ? { delivery_fee: formatCents(r.deliveryFeeCents) } : {}),
          url: r.url,
        })),
      });
    },

    async menu(storeId) {
      const id = storeId.trim();
      if (!id) return `Error: store_id is required; use one from search_doordash.`;
      let items;
      try {
        items = await provider.menu(id);
      } catch (err) {
        return failed(err, "show that menu");
      }
      if (!items.length) return `Error: ${provider.name} shows nothing orderable at that store right now.`;
      return JSON.stringify({
        store_id: id,
        note: `quote_doordash with the item_ids and quantities prices the whole order (fees, tax, tip) for the Ledger.`,
        items: items.slice(0, 60).map((i) => ({ item_id: i.itemId, name: i.name, price: formatCents(i.priceCents), ...(i.section ? { section: i.section } : {}), ...(i.description ? { description: i.description.slice(0, 120) } : {}) })),
      });
    },

    async quote(owner, request) {
      const address = addressOf(owner, request.address);
      if (!address) return NO_ADDRESS;
      const tipPercent = request.tipPercent ?? DEFAULT_TIP_PERCENT;
      if (!(Number.isFinite(tipPercent) && tipPercent >= 0 && tipPercent <= MAX_TIP_PERCENT)) return `Error: tip_percent must be 0 to ${MAX_TIP_PERCENT}.`;
      let order: FoodOrder;
      let quote: FoodQuote;
      try {
        order = { storeId: request.storeId.trim(), items: checkLines(request.items), address, tipPercent };
        quote = await provider.quote(order);
      } catch (err) {
        return failed(err, "price that order");
      }
      if (quote.totalCents > limitCents) {
        return `Error: that order comes to ${formatCents(quote.totalCents)} all in (food ${formatCents(quote.subtotalCents)} plus fees, tax and tip), over the ${formatCents(limitCents)} limit. Tell the owner; offer fewer items. Do not propose it.`;
      }
      const now = Date.now();
      for (const [id, d] of drafts) if (d.expiresAt < now) drafts.delete(id);
      let id: string;
      do id = `q${randomBytes(3).toString("hex")}`;
      while (drafts.has(id));
      drafts.set(id, { accountId: owner.id, order, expiresAt: now + ttl });
      log(`food: quote ${id} for ${owner.tag}: ${quote.restaurant}, ${itemsSummary(quote.items)}, ${formatCents(quote.totalCents)}`);
      return JSON.stringify({
        quote_id: id,
        restaurant: quote.restaurant,
        items: quote.items.map((i) => `${i.quantity}x ${i.name} at ${formatCents(i.unitCents)}`),
        subtotal: formatCents(quote.subtotalCents),
        fees: formatCents(quote.feesCents),
        tax: formatCents(quote.taxCents),
        tip: `${formatCents(quote.tipCents)} (${quote.tipPercent}%)`,
        total: `${formatCents(quote.totalCents)} all in`,
        deliver_to: quote.address,
        ...(quote.etaMinutes ? { eta: eta(quote.etaMinutes) } : {}),
        next: `propose_action EAT with Order ${id} (good for ${Math.round(ttl / 60_000)} minutes). The owner's Ledger shows the total; nothing is ordered before they approve it and the payment lands.`,
      });
    },

    setAddress(owner, address) {
      const clean = address.replace(/\s+/g, " ").trim();
      if (clean.length < 6 || clean.length > 200 || !/\d/.test(clean) || !/[a-z]/i.test(clean)) {
        return "Error: that does not look like a street address. Ask for the full one: number, street, city (and apartment, if any).";
      }
      db.setDeliveryAddress(owner.id, clean);
      log(`food: delivery address for ${owner.tag} saved`);
      return `Saved ${owner.tag}'s delivery address: ${clean}.`;
    },
  };
}

/** The owner's row as stored now (the tools get the account as it was at the start of the turn). */
const freshAccount = (db: Db, owner: Account): Account => db.account(owner.id) ?? owner;
