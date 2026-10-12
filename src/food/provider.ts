/**
 * The food provider seam: what the agent needs from a delivery service to order food on the operator's account.
 *
 * DoorDash has no public consumer ordering API. Three providers implement this contract, all with the same semantics:
 *   src/food/demo.ts     an in-memory DoorDash for tests and the deployed demo (FOOD_PROVIDER=demo)
 *   src/food/browser.ts  doordash.com through Playwright, signed in as the operator (FOOD_PROVIDER=browser)
 *   src/food/cli.ts      DoorDash's announced dd-cli beta over child_process (FOOD_PROVIDER=cli)
 *
 * The contract is staged like src/merchant.ts: `quote` prices an exact order (food, fees, tax, tip) without placing it,
 * and `confirm` places a quote, checking the restaurant, the items and the total again. `confirm` may answer
 * `no_purchase` only when it is certain nothing was ordered; once the order button (or command) went out it answers
 * `ordered` or `uncertain`, and nothing is ever retried.
 */
import { MerchantError, type Outcome } from "../merchant.js";

export interface Restaurant {
  /** The provider's store id (DoorDash's number in /store/<slug>-<id>/). */
  storeId: string;
  name: string;
  cuisine?: string;
  /** "4.7" style, out of 5. */
  rating?: string;
  etaMinutes?: number;
  deliveryFeeCents?: number;
  url: string;
}

export interface MenuItem {
  itemId: string;
  name: string;
  priceCents: number;
  description?: string;
  /** The menu heading it sits under ("Bowls", "Sides"). */
  section?: string;
}

export interface OrderLine {
  itemId: string;
  quantity: number;
}

/** What to price: items of one restaurant, delivered to one address. */
export interface FoodOrder {
  storeId: string;
  items: OrderLine[];
  /** The delivery address as the owner gave it. */
  address: string;
  /** Dasher tip as a percent of the subtotal. */
  tipPercent: number;
}

export interface QuotedLine {
  itemId: string;
  name: string;
  quantity: number;
  unitCents: number;
}

/** An exact price for a FoodOrder: what the checkout would charge. */
export interface FoodQuote {
  /** The provider's id for this pricing, unique per quote(). */
  quoteId: string;
  storeId: string;
  restaurant: string;
  items: QuotedLine[];
  subtotalCents: number;
  /** Delivery and service fees together. */
  feesCents: number;
  taxCents: number;
  tipCents: number;
  /** subtotal + fees + tax + tip: what the card would be charged. */
  totalCents: number;
  address: string;
  tipPercent: number;
  etaMinutes?: number;
  /** Unix ms. confirm() after this prices the order again and compares totals. */
  expiresAt: number;
}

/** A failure in plain words, safe to show the model (and through it the owner). Nothing was ordered. */
export class FoodError extends MerchantError {}

export interface FoodProvider {
  readonly name: "DoorDash";
  /** Restaurants delivering to `near` that match `query`, best first. Throws FoodError when the service cannot be reached. */
  searchRestaurants(query: string, near: string, limit?: number): Promise<Restaurant[]>;
  /** The restaurant's orderable items. Throws FoodError for an unknown or closed store. */
  menu(storeId: string): Promise<MenuItem[]>;
  /** The exact total for `order`, without ordering. Throws FoodError when it cannot be ordered as asked. */
  quote(order: FoodOrder): Promise<FoodQuote>;
  /** Places a quote from quote(). Never throws for an outcome it can name; throws only for "uncertain" bugs. */
  confirm(quote: FoodQuote): Promise<Outcome>;
  /** Optional: get ready and check the session at startup. Throws FoodError when it is not usable. */
  warm?(): Promise<void>;
  close(): Promise<void>;
}

export const MAX_QUANTITY = 10;
export const MAX_LINES = 8;
export const DEFAULT_TIP_PERCENT = 15;

/** "1x Burrito Bowl, 2x Chips". */
export const itemsSummary = (items: Pick<QuotedLine, "name" | "quantity">[]): string => items.map((i) => `${i.quantity}x ${i.name.replace(/\s+/g, " ").trim()}`).join(", ");

/** Tip in cents for `percent` of `subtotalCents`, rounded to the cent. */
export const tipCents = (subtotalCents: number, percent: number): number => Math.round((subtotalCents * percent) / 100);

/**
 * The order lines as given, merged by item id, or why they cannot be ordered. Shared by every provider so the model
 * gets the same answer from each.
 */
export function checkLines(items: OrderLine[]): OrderLine[] {
  if (!items.length) throw new FoodError("the order has no items");
  const merged = new Map<string, number>();
  for (const line of items) {
    if (!line.itemId) throw new FoodError("every item needs its item_id from doordash_menu");
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > MAX_QUANTITY) throw new FoodError(`quantity must be 1 to ${MAX_QUANTITY}`);
    merged.set(line.itemId, (merged.get(line.itemId) ?? 0) + line.quantity);
  }
  if (merged.size > MAX_LINES) throw new FoodError(`one order holds at most ${MAX_LINES} different items`);
  for (const q of merged.values()) if (q > MAX_QUANTITY) throw new FoodError(`quantity must be 1 to ${MAX_QUANTITY}`);
  return [...merged].map(([itemId, quantity]) => ({ itemId, quantity }));
}

/** Whether a quote holds exactly these lines (same items, same quantities). */
export function sameLines(quote: Pick<FoodQuote, "items">, lines: OrderLine[]): boolean {
  const want = new Map(lines.map((l) => [l.itemId, l.quantity]));
  return quote.items.length === want.size && quote.items.every((i) => want.get(i.itemId) === i.quantity);
}
