/**
 * What the DoorDash driver (browser.ts) reads off doordash.com: pure text parsing that unit tests cover without a
 * browser, plus the in-page readers it runs through Playwright.
 *
 * NOT VERIFIED against a signed-in session. Every selector and pattern here was written from DoorDash's known web
 * layout (store search, store pages at /store/<slug>-<id>/, the item modal with "Add to cart", the cart drawer, the
 * checkout at /checkout/ with "Place Order", the order page at /orders/<id>/), and DoorDash changes its markup often.
 * So each reader tries data attributes first and falls back to a regex over the page's visible text. Before the first
 * real order, run a signed-in dry run (DOORDASH_DRY_RUN=1) and read the screenshots in data/doordash-shots.
 */
import type { Page } from "playwright";
import type { MenuItem, Restaurant } from "./provider.js";

export const DOORDASH = "https://www.doordash.com";
export const searchUrl = (query: string): string => `${DOORDASH}/search?query=${encodeURIComponent(query)}`;
/** DoorDash redirects /store/<id>/ to the store's full /store/<slug>-<id>/ page. */
export const storeUrl = (storeId: string): string => `${DOORDASH}/store/${encodeURIComponent(storeId)}/`;
export const CHECKOUT_URL = `${DOORDASH}/checkout/`;

// ---- pure parsing ------------------------------------------------------------------------------------------

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{2}))?/;

/** The first dollar amount in `text` as cents ("$12.34", "$0", "$1,204.50"); null when there is none. */
export function moneyCents(text: string | null | undefined): number | null {
  const m = MONEY.exec(text ?? "");
  if (!m) return null;
  const cents = Number(m[1]!.replace(/,/g, "")) * 100 + Number(m[2] ?? 0);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** The store id in a store link: /store/chipotle-mexican-grill-1234567/ or /store/1234567/. */
export function storeIdFromUrl(url: string): string | undefined {
  return /\/store\/(?:[^/?#]*?-)?(\d{2,})\/?(?:[?#]|$)/i.exec(url)?.[1];
}

/** The order id on the page after Place Order: /orders/<id>/ (a UUID today). */
export function orderIdFromUrl(url: string): string | undefined {
  return /\/orders\/([A-Za-z0-9-]{6,})\/?(?:[?#]|$)/.exec(url)?.[1];
}

export const isCheckoutUrl = (url: string): boolean => /\/checkout\/?(?:[?#]|$)/i.test(url);

/** "25-35 min" -> 35 (the later end, so "about N minutes" does not overpromise), "30 min" -> 30; undefined without one. */
export function parseEta(text: string): number | undefined {
  const m = /(\d{1,3})\s*(?:-|–|to)\s*(\d{1,3})\s*min/i.exec(text) ?? /(\d{1,3})\s*min/i.exec(text);
  if (!m) return undefined;
  const minutes = Number(m[2] ?? m[1]);
  return minutes > 0 && minutes < 300 ? minutes : undefined;
}

/** "$0 delivery fee", "$1.99 Delivery Fee over $12" -> cents of the fee; undefined when the text names none. */
export function parseDeliveryFee(text: string): number | undefined {
  const m = /\$\s?(\d+(?:\.\d{2})?)\s*delivery fee/i.exec(text);
  if (m) return Math.round(Number(m[1]) * 100);
  return /free delivery|\$0 delivery/i.test(text) ? 0 : undefined;
}

/** "4.7" from "4.7 ★ (2k+)" or "Rated 4.7 out of 5"; undefined without one. */
export function parseRating(text: string): string | undefined {
  return /\b([1-5]\.\d)\s*(?:★|stars?|out of 5|\()/i.exec(text)?.[1];
}

export interface RawStore {
  href: string;
  /** The store name element's text, when the card has one. */
  name: string;
  /** The whole card's visible text: name, rating, ETA, fee. */
  text: string;
}

/** Store cards to restaurants, each store once, in page order. A card without a store id or a name is skipped. */
export function toRestaurants(raw: RawStore[]): Restaurant[] {
  const seen = new Set<string>();
  const out: Restaurant[] = [];
  for (const r of raw) {
    const storeId = storeIdFromUrl(r.href);
    const lines = r.text.split("\n").map((l) => l.trim()).filter(Boolean);
    const name = (r.name || lines[0] || "").replace(/\s+/g, " ").trim();
    if (!storeId || !name || seen.has(storeId)) continue;
    seen.add(storeId);
    const etaMinutes = parseEta(r.text);
    const deliveryFeeCents = parseDeliveryFee(r.text);
    const rating = parseRating(r.text);
    const url = r.href.startsWith("http") ? r.href.split("?")[0]! : `${DOORDASH}${r.href.split("?")[0]}`;
    out.push({ storeId, name, url, ...(rating ? { rating } : {}), ...(etaMinutes ? { etaMinutes } : {}), ...(deliveryFeeCents !== undefined ? { deliveryFeeCents } : {}) });
  }
  return out;
}

export interface RawMenuItem {
  /** data-item-id, or the id in the item's link (?itemId= or /item/<id>). */
  id: string;
  name: string;
  priceText: string;
  description: string;
  section: string;
}

/** Menu cards to items, each id once; an item without an id, a name or a price is skipped (not orderable as is). */
export function toMenuItems(raw: RawMenuItem[]): MenuItem[] {
  const seen = new Set<string>();
  const out: MenuItem[] = [];
  for (const r of raw) {
    const name = r.name.replace(/\s+/g, " ").trim();
    const priceCents = moneyCents(r.priceText);
    if (!/^\d+$/.test(r.id) || !name || priceCents === null || seen.has(r.id)) continue;
    seen.add(r.id);
    const description = r.description.replace(/\s+/g, " ").trim();
    const section = r.section.replace(/\s+/g, " ").trim();
    out.push({ itemId: r.id, name, priceCents, ...(description ? { description } : {}), ...(section ? { section } : {}) });
  }
  return out;
}

export interface CheckoutSummary {
  subtotalCents: number | null;
  /** Delivery, service and other fees together (a "Fees & Estimated Tax" line counts as fees plus tax). */
  feesCents: number | null;
  taxCents: number | null;
  tipCents: number | null;
  totalCents: number | null;
}

/** The amount on the line that starts with `label`, or on the next line (label and amount are separate elements). */
function lineAmount(lines: string[], label: RegExp): number | null {
  for (let i = 0; i < lines.length; i++) {
    if (!label.test(lines[i]!)) continue;
    const here = moneyCents(lines[i]!.replace(label, ""));
    if (here !== null) return here;
    const next = lines[i + 1] ?? "";
    if (/^\s*-?\$/.test(next)) return moneyCents(next);
  }
  return null;
}

/**
 * The checkout's order summary from its visible text: "Subtotal", the fee lines ("Delivery Fee", "Service Fee",
 * "Fees & Estimated Tax", "Small Order Fee", "Expanded Range Fee", "Regulatory Response Fee"), "Estimated Tax",
 * "Dasher Tip" and "Total". "Subtotal" never counts as the total.
 */
export function readSummary(text: string): CheckoutSummary {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const subtotalCents = lineAmount(lines, /^subtotal\b/i);
  const combined = lineAmount(lines, /^fees\s*&\s*estimated tax\b/i);
  const fees = [/^delivery fee\b/i, /^service fee\b/i, /^small order fee\b/i, /^expanded range fee\b/i, /^regulatory response fee\b/i, /^long distance fee\b/i].map((re) => lineAmount(lines, re));
  const taxCents = lineAmount(lines, /^(?:estimated )?tax(?:es)?\b/i);
  const listed = fees.filter((f): f is number => f !== null);
  const feesCents = combined !== null && !listed.length ? combined - (taxCents ?? 0) : listed.length ? listed.reduce((a, b) => a + b, 0) : null;
  return {
    subtotalCents,
    feesCents,
    taxCents: taxCents ?? (combined !== null && !listed.length ? 0 : null),
    tipCents: lineAmount(lines, /^dasher tip\b|^tip\b/i),
    totalCents: lineAmount(lines, /^(?:order )?total\b(?!\s*before)/i),
  };
}

/** Item lines on the checkout or in the cart: "1x Burrito Bowl", "2 × Chips". */
export function cartLines(text: string): { name: string; quantity: number }[] {
  const out: { name: string; quantity: number }[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d{1,2})\s*[x×]\s+(.+?)\s*(?:\$\s?[\d,.]+)?\s*$/i.exec(line);
    if (m) out.push({ quantity: Number(m[1]), name: m[2]!.replace(/\s+/g, " ").trim() });
  }
  return out;
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Whether the cart lines are exactly these items in these quantities: nothing missing, nothing extra. */
export function cartMatches(lines: { name: string; quantity: number }[], want: { name: string; quantity: number }[]): boolean {
  if (lines.length !== want.length) return false;
  const left = [...lines];
  for (const w of want) {
    const i = left.findIndex((l) => words(l.name) === words(w.name) && l.quantity === w.quantity);
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return true;
}

/** The number in the header cart button ("Cart, 3 items", "3"); null when it shows none. */
export function cartCount(label: string): number | null {
  const m = /(\d+)\s*items?\b/i.exec(label) ?? /^\s*(\d+)\s*$/.exec(label);
  return m ? Number(m[1]) : /empty/i.test(label) ? 0 : null;
}

/** Whether the address DoorDash shows is the one wanted: the house number and the street's first word must appear. */
export function addressMatches(shown: string, wanted: string): boolean {
  const head = words(wanted).split(" ").slice(0, 2).join(" ");
  return head.length > 2 && ` ${words(shown)} `.includes(` ${head} `);
}

export type Block = "captcha" | "signin";

/** Cloudflare's bot check or DoorDash's sign-in wall, from the URL and the page's HTML or text. */
export function detectBlock(url: string, html: string): Block | undefined {
  if (/\/cdn-cgi\/challenge-platform|challenges\.cloudflare\.com/i.test(url)) return "captcha";
  if (/<title>\s*Just a moment\.\.\.\s*<\/title>|Verify you are human|cf-chl-|Checking if the site connection is secure/i.test(html)) return "captcha";
  if (/\/consumer\/login|identity\.doordash\.com\/auth|\/auth\/user\/login/i.test(url)) return "signin";
  return undefined;
}

/** The header of a signed-out doordash.com offers "Sign In" and "Sign Up"; a signed-in one shows neither. */
export const signedIn = (headerText: string): boolean => !/\bsign (?:in|up)\b/i.test(headerText);

/** The page after Place Order says the order went through. */
export const orderPlacedText = (text: string): boolean => /order (?:placed|received|confirmed)|thanks for your order|preparing your order|your order is (?:on|being)|track (?:your )?order/i.test(text);

// ---- in-page readers ---------------------------------------------------------------------------------------
// The callbacks run in the browser, so they declare no named helpers: tsx wraps those in a __name() call that does
// not exist in the page.

/** Store cards on the search page, text untouched (toRestaurants cleans it). */
export function readStoreCards(page: Page): Promise<RawStore[]> {
  return page.$$eval("a[href*='/store/']", (links) =>
    links.map((a) => ({
      href: a.getAttribute("href") ?? "",
      name: (a.querySelector("[data-telemetry-id='store.name'], [data-testid='StoreName'], h3, h2")?.textContent ?? "").trim(),
      text: (a as HTMLElement).innerText ?? a.textContent ?? "",
    })),
  );
}

/** Menu item cards on a store page, with the menu heading each sits under. */
export function readMenuCards(page: Page): Promise<RawMenuItem[]> {
  return page.$$eval("[data-anchor-id='MenuItem'], [data-testid='MenuItem'], [data-item-id]", (cards) =>
    cards.map((card) => {
      const link = card.querySelector("a[href]")?.getAttribute("href") ?? card.getAttribute("href") ?? "";
      const id = card.getAttribute("data-item-id") || /[?&]itemId=(\d+)/.exec(link)?.[1] || /\/item\/(\d+)/.exec(link)?.[1] || "";
      const text = (card as HTMLElement).innerText ?? "";
      const name = card.querySelector("[data-telemetry-id='storeMenuItem.title'], [data-testid='MenuItemTitle'], h3")?.textContent ?? text.split("\n")[0] ?? "";
      const price = card.querySelector("[data-telemetry-id='storeMenuItem.price'], [data-testid='MenuItemPrice']")?.textContent ?? /\$\s?[\d,]+(?:\.\d{2})?/.exec(text)?.[0] ?? "";
      const description = card.querySelector("[data-telemetry-id='storeMenuItem.description'], [data-testid='MenuItemDescription']")?.textContent ?? "";
      const section = card.closest("section, [data-anchor-id='MenuCategory']")?.querySelector("h2, h3")?.textContent ?? "";
      return { id, name, priceText: price, description, section };
    }),
  );
}
