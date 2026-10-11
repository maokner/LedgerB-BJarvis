/**
 * A merchant the agent can buy from with the operator's own card and account (today: Amazon, see src/amazon/).
 *
 * The contract is staged, like a card authorization: `search` finds products, `prepare` runs the checkout up to the
 * last page and reads the exact total without ordering, `confirm` places the order for a saved quote. Nothing is held
 * between the two: `confirm` runs the checkout again and must find the same item at the same total, else it reports
 * `no_purchase` with reason "price changed" (the buyer's money comes back from the treasury, see src/purchases.ts).
 *
 * `confirm` may only answer `no_purchase` when it is certain nothing was ordered. Anything it cannot tell
 * (a timeout after pressing the order button, an unexpected page) is `uncertain`: a person then looks, nothing retries.
 */

export interface Product {
  /** Amazon's item id, 10 characters. */
  asin: string;
  title: string;
  /** The listed price; null when the listing shows none (out of stock, "see options"). */
  priceCents: number | null;
  url: string;
  /** "4.5 out of 5 stars, 12,345 ratings" style, when shown. */
  rating?: string;
}

export interface Quote {
  /** Opaque, unique per prepare(). */
  quoteId: string;
  asin: string;
  title: string;
  /** The item's price on the checkout page. */
  itemCents: number;
  /** The order total the checkout page shows: item, shipping, tax. What the card would be charged. */
  totalCents: number;
  /** Unix ms. confirm() after this re-quotes and compares totals. */
  expiresAt: number;
}

export type Outcome =
  | { status: "ordered"; orderId: string; totalCents: number }
  /** Certain that nothing was ordered and nothing charged. */
  | { status: "no_purchase"; reason: string }
  /** Cannot tell whether an order was placed. Never refunded automatically. */
  | { status: "uncertain"; reason: string };

/** A failure in plain words, safe to show the model (and through it the owner). */
export class MerchantError extends Error {}

export interface Merchant {
  /** "Amazon" */
  readonly name: string;
  /** Up to `limit` products for a free-text query, best match first. Throws MerchantError when the store cannot be reached. */
  search(query: string, limit?: number): Promise<Product[]>;
  /** The exact order total for one unit of `asin`, without ordering. Throws MerchantError when it cannot be bought (unavailable, needs options, cart not alone). */
  prepare(asin: string): Promise<Quote>;
  /** Places the order for a quote from prepare(). Never throws for an outcome it can name; throws only for "uncertain" bugs. */
  confirm(quote: Quote): Promise<Outcome>;
  close(): Promise<void>;
}

/** Keeps a title to one device-sized line. */
export const shortTitle = (title: string, max = 48): string => {
  const clean = title.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 3).trimEnd()}...`;
};

export interface DemoItem {
  asin: string;
  title: string;
  priceCents: number;
  /** Shipping plus tax added at checkout. Default: 9% of the price. */
  extraCents?: number;
  /** What happens at confirm. Default: ordered. */
  outcome?: Outcome;
}

export const DEMO_CATALOG: DemoItem[] = [
  { asin: "B0DEMO0001", title: "Trident Original Sugar Free Gum, 14 Pieces (Pack of 3)", priceCents: 399 },
  { asin: "B0DEMO0002", title: "Anker USB-C to USB-C Cable, 6 ft, 100W, Braided", priceCents: 1299 },
  { asin: "B0DEMO0003", title: "Moleskine Classic Notebook, Pocket, Ruled, Black", priceCents: 1495 },
  { asin: "B0DEMO0004", title: "Logitech MX Master 3S Wireless Mouse", priceCents: 9999 },
  { asin: "B0DEMO0005", title: "Celsius Energy Drink, Sparkling Orange, 12 Pack", priceCents: 1799 },
];

/**
 * A store in memory, for tests and for trying the flow with the dev channel (AMAZON_MERCHANT=demo). `search` matches
 * every word of the query against the title; `confirm` answers with the item's scripted outcome.
 */
export function demoMerchant(catalog: DemoItem[] = DEMO_CATALOG, options: { quoteTtlMs?: number; onConfirm?: (quote: Quote) => Outcome | undefined } = {}): Merchant & {
  catalog: DemoItem[];
  confirmed: Quote[];
} {
  let seq = 0;
  const confirmed: Quote[] = [];
  const find = (asin: string) => catalog.find((i) => i.asin === asin);
  const total = (item: DemoItem) => item.priceCents + (item.extraCents ?? Math.round(item.priceCents * 0.09));
  return {
    name: "Amazon",
    catalog,
    confirmed,
    async search(query, limit = 5) {
      const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
      const hits = catalog.filter((i) => words.length === 0 || words.some((w) => i.title.toLowerCase().includes(w)));
      hits.sort((a, b) => words.filter((w) => b.title.toLowerCase().includes(w)).length - words.filter((w) => a.title.toLowerCase().includes(w)).length);
      return hits.slice(0, limit).map((i) => ({ asin: i.asin, title: i.title, priceCents: i.priceCents, url: `https://www.amazon.com/dp/${i.asin}`, rating: "4.6 out of 5 stars" }));
    },
    async prepare(asin) {
      const item = find(asin);
      if (!item) throw new MerchantError(`Nothing on ${this.name} has the item id ${asin}.`);
      return { quoteId: `demo-q${++seq}`, asin, title: item.title, itemCents: item.priceCents, totalCents: total(item), expiresAt: Date.now() + (options.quoteTtlMs ?? 30 * 60_000) };
    },
    async confirm(quote) {
      const item = find(quote.asin);
      if (!item) return { status: "no_purchase", reason: "the item is gone" };
      if (total(item) !== quote.totalCents) return { status: "no_purchase", reason: "price changed" };
      confirmed.push(quote);
      return options.onConfirm?.(quote) ?? item.outcome ?? { status: "ordered", orderId: `111-${String(1000000 + seq).slice(-7)}-${String(5000000 + confirmed.length).slice(-7)}`, totalCents: quote.totalCents };
    },
    async close() {},
  };
}

/**
 * A store where every order goes through: real search and listed prices from `search` (anonymous amazon.com through
 * the browser driver, or the demo catalog), a quote of the listed price plus `taxRate`, and a `confirm` that answers
 * "ordered" with a generated order number without buying anything. For demos (AMAZON_MERCHANT=mock): the owner's ETH
 * still goes to the treasury, nothing is ever refunded because nothing ever fails.
 */
export function alwaysOrderedMerchant(options: { search: Merchant["search"]; name?: string; taxRate?: number; log?: (line: string) => void }): Merchant {
  const name = options.name ?? "Amazon";
  const taxRate = options.taxRate ?? 0.09;
  const log = options.log ?? (() => {});
  /** Products seen in searches, so prepare() can quote an item by id without another page load. */
  const seen = new Map<string, Product>();
  let orders = 0;
  return {
    name,
    async search(query, limit = 5) {
      const products = await options.search(query, limit);
      for (const p of products) seen.set(p.asin, p);
      return products;
    },
    async prepare(asin) {
      const product = seen.get(asin) ?? (await options.search(asin, 3)).find((p) => p.asin === asin);
      if (!product) throw new MerchantError(`Nothing on ${name} has the item id ${asin}. Search first and use an id from the results.`);
      if (product.priceCents === null) throw new MerchantError(`${shortTitle(product.title, 60)} shows no price on ${name}, so it cannot be bought here.`);
      seen.set(asin, product);
      const totalCents = product.priceCents + Math.round(product.priceCents * taxRate);
      return { quoteId: `mock-${Date.now().toString(36)}-${asin}`, asin, title: product.title, itemCents: product.priceCents, totalCents, expiresAt: Date.now() + 30 * 60_000 };
    },
    async confirm(quote) {
      const orderId = `${100 + (++orders % 900)}-${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}-${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
      log(`mock order ${orderId} for ${quote.asin} at ${quote.totalCents} cents (nothing was bought)`);
      return { status: "ordered", orderId, totalCents: quote.totalCents };
    },
    async close() {},
  };
}
