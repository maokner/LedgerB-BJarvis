/**
 * What the Amazon driver (browser.ts) reads off Amazon's pages: pure text parsing that unit tests cover without a
 * browser, plus the in-page readers it runs through Playwright.
 *
 * Amazon changes its markup often and shows different checkout layouts to different accounts, so every reader tries
 * a list of selectors first and falls back to a regex over the page's visible text. The checkout selectors were written
 * from Amazon's known layouts, not verified against a signed-in session: when one misses, the screenshot in
 * data/amazon-shots shows what the page looked like.
 */
import type { Frame, Locator, Page } from "playwright";
import type { Product } from "../merchant.js";

export const AMAZON = "https://www.amazon.com";
export const productUrl = (asin: string): string => `${AMAZON}/dp/${asin}`;
export const isAsin = (s: string): boolean => /^[A-Z0-9]{10}$/.test(s);

/**
 * A desktop Chrome on macOS with the real browser's major version. The operator signs in on a Mac (amazon-login.ts),
 * so the server presents the same kind of browser the session was created in, which avoids "new device" checks.
 */
export const desktopUserAgent = (browserVersion: string): string =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion.split(".")[0] || "140"}.0.0.0 Safari/537.36`;

// ---- pure parsing ------------------------------------------------------------------------------------------

export const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

const MONEY = String.raw`\$\s?([\d,]+\.\d{2})`;

/** "$12.34", "$1,234.56", "12.34" to cents; null for anything else ("See options", "", "$12-$20"). */
export function parseCents(text: string | null | undefined): number | null {
  const m = /^\s*\$?\s?([\d,]+)\.(\d{2})\s*$/.exec(text ?? "");
  if (!m) return null;
  const cents = Number(m[1]!.replace(/,/g, "")) * 100 + Number(m[2]);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** An Amazon order number ("111-2345678-9012345") in page text. */
export function findOrderId(text: string): string | undefined {
  return /\b\d{3}-\d{7}-\d{7}\b/.exec(text)?.[0];
}

/**
 * The order total in checkout text: "Order total: $12.34", then "Grand total", then a line that is just "Total $12.34"
 * (the Buy Now side sheet). "Total before tax" and "Items total" never match.
 */
export function findOrderTotal(text: string): number | null {
  const patterns = [new RegExp(`Order total:?\\s*${MONEY}`, "i"), new RegExp(`Grand total:?\\s*${MONEY}`, "i"), new RegExp(`(?:^|\\n)[ \\t]*Total(?: \\(\\d+ items?\\))?:?\\s*${MONEY}`, "i")];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return parseCents(m[1]);
  }
  return null;
}

/** The items subtotal ("Items: $12.34", "Items (1): $12.34", "Subtotal (1 item): $12.34"); one unit, so the item's price. */
export function findItemsSubtotal(text: string): number | null {
  const m = new RegExp(`(?:^|\\n)[ \\t]*(?:Items(?: \\(\\d+\\))?|Subtotal(?: \\(\\d+ items?\\))?):?\\s*${MONEY}`, "i").exec(text);
  return m ? parseCents(m[1]) : null;
}

/** How many units the checkout says it holds ("Checkout (2 items)", "Items (2):", "Subtotal (2 items)"), or null when it doesn't say. */
export function findItemCount(text: string): number | null {
  const m = /Checkout\s*\(\s*(\d+)\s+items?\s*\)/i.exec(text) ?? /(?:^|\n)[ \t]*Items\s*\((\d+)\)/i.exec(text) ?? /Subtotal\s*\((\d+)\s+items?\)/i.exec(text);
  return m ? Number(m[1]) : null;
}

export type Block = "captcha" | "signin";

/** Amazon's robot check or a sign-in wall, from the page URL and its HTML or text. */
export function detectBlock(url: string, html: string): Block | undefined {
  if (/\/errors\/validateCaptcha|\/captcha\//i.test(url)) return "captcha";
  if (/Enter the characters you see below|Type the characters you see in this image|make sure you're not a robot|discuss automated access to Amazon data/i.test(html)) return "captcha";
  if (/\/ap\/(signin|mfa|cvf)|\/ax\/claim/i.test(url)) return "signin";
  if (/<form[^>]+name="signIn"/i.test(html)) return "signin";
  return undefined;
}

/** "Hello, Matt" (the nav greeting) to "Matt"; undefined for "Hello, sign in" or anything else. */
export function signedInName(greeting: string): string | undefined {
  const m = /Hello,\s*([^\n]+)/i.exec(greeting);
  const name = m?.[1]?.trim();
  return name && !/^sign in\b/i.test(name) ? name : undefined;
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Whether checkout text shows this title. Checkout truncates long titles, so only the first 24 characters must appear. */
export function titleShown(pageText: string, title: string): boolean {
  const head = words(title).slice(0, 24).trim();
  return head.length > 0 && words(pageText).includes(head);
}

/**
 * The order id of the newest order on Your Orders, if that order holds this title. Each order card starts with its
 * "ORDER # ..." header, so the text after the first order id and before the second is the newest order's items.
 */
export function newestOrderFor(historyText: string, title: string): string | undefined {
  const ids = [...historyText.matchAll(/\b\d{3}-\d{7}-\d{7}\b/g)];
  const first = ids[0];
  if (!first) return undefined;
  const next = ids.find((m) => m[0] !== first[0]);
  return titleShown(historyText.slice(first.index, next?.index), title) ? first[0] : undefined;
}

export const isCheckoutUrl = (url: string): boolean => /\/checkout\/|\/gp\/buy\//i.test(url) && !isThankYouUrl(url);
export const isThankYouUrl = (url: string): boolean => /thankyou/i.test(url);

export interface RawResult {
  asin: string;
  titles: string[];
  priceText: string | null;
  rating: string | null;
  ratingCount: string | null;
  sponsored: boolean;
}

/**
 * Organic results with an ASIN, each once, in page order; unpriced ones ("See options") keep priceCents null.
 * Amazon shows some brands in their own heading above the title ("Trident" / "Original Sugar Free Gum, ..."), so a
 * short separate heading is put in front of the title, as the product page itself does.
 */
export function toProducts(raw: RawResult[]): Product[] {
  const seen = new Set<string>();
  const products: Product[] = [];
  for (const r of raw) {
    if (r.sponsored || !isAsin(r.asin) || seen.has(r.asin)) continue;
    const headings = [...new Set(r.titles.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean))];
    const longest = headings.reduce((a, b) => (b.length > a.length ? b : a), "");
    if (!longest) continue;
    const brand = headings.find((h) => h !== longest && h.length <= 40);
    const title = brand && !longest.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${longest}` : longest;
    seen.add(r.asin);
    const rating = [/[\d.]+ out of 5 stars/i.exec(r.rating ?? "")?.[0], r.ratingCount?.trim()].filter(Boolean).join(", ");
    products.push({ asin: r.asin, title, priceCents: parseCents(r.priceText), url: productUrl(r.asin), ...(rating ? { rating } : {}) });
  }
  return products;
}

// ---- in-page readers ---------------------------------------------------------------------------------------

/**
 * Search result cards in page order, text untouched (toProducts cleans it). The callback runs in the browser, so it
 * declares no named helpers: tsx wraps those in a __name() call that does not exist in the page.
 */
export function readSearchResults(page: Page): Promise<RawResult[]> {
  return page.$$eval('div[data-component-type="s-search-result"]', (cards) =>
    cards.map((card) => {
      // Sponsored cards: the AdHolder class, the "Sponsored" label, or the ad-feedback popover.
      const sponsored =
        card.classList.contains("AdHolder") ||
        !!card.querySelector(".puis-sponsored-label-text, .s-sponsored-label-text, [aria-label='View Sponsored information or leave ad feedback']") ||
        Array.from(card.querySelectorAll("span")).some((s) => (s.textContent ?? "").trim() === "Sponsored");
      // Some layouts put the brand in its own h2 above the title; the caller keeps the longest.
      const titles = Array.from(card.querySelectorAll("h2")).flatMap((h) => [h.getAttribute("aria-label") ?? "", h.textContent ?? ""]).filter(Boolean);
      // The selling price; .a-text-price is the struck-through list price or the per-unit price.
      const price = card.querySelector(".a-price:not(.a-text-price) .a-offscreen");
      const stars = card.querySelector('[aria-label*="out of 5 stars"]');
      const count = Array.from(card.querySelectorAll("[aria-label]")).map((e) => e.getAttribute("aria-label") ?? "").find((l) => /^[\d,.]+K?\+? ratings?$/i.test(l.trim()));
      return { asin: card.getAttribute("data-asin") ?? "", titles, priceText: price?.textContent ?? null, rating: stars?.getAttribute("aria-label")?.trim() ?? null, ratingCount: count ?? null, sponsored };
    }),
  );
}

/** Visible text of a page or frame; "" when it cannot be read (a frame mid-navigation). */
export async function bodyText(target: Page | Frame): Promise<string> {
  return target.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
}

/** The first candidate with a visible match. */
export async function firstVisible(candidates: Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) {
    const loc = candidate.first();
    if (await loc.isVisible().catch(() => false)) return loc;
  }
  return undefined;
}

/** The product page's own price for one unit, when it shows one. */
export async function readProductPrice(page: Page): Promise<number | null> {
  // The "price to pay" in the buy box across Amazon's current and older product layouts.
  for (const selector of ["#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen", "#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen", "#apex_desktop .priceToPay .a-offscreen", "#price_inside_buybox", "#priceblock_ourprice"]) {
    const cents = parseCents(await page.locator(selector).first().textContent({ timeout: 1_000 }).catch(() => null));
    if (cents !== null) return cents;
  }
  return null;
}

export interface CheckoutRead {
  text: string;
  totalCents: number | null;
  itemsCents: number | null;
  /** Units on the page: from "Checkout (n items)" style text, else the distinct product ids linked. */
  itemCount: number | null;
  asins: string[];
}

/** Reads the order summary of a checkout page or the Buy Now side sheet. */
export async function readCheckout(target: Page | Frame): Promise<CheckoutRead> {
  const text = await bodyText(target);
  // Structured first: the grand total cell (classic checkout), then each summary row on its own, so a regex over one row
  // cannot pick up a number from the next.
  let totalCents = parseCents(await target.locator(".grand-total-price").first().textContent({ timeout: 1_000 }).catch(() => null));
  if (totalCents === null) {
    const rows = await target
      .locator("#subtotals-marketplace-table tr, #subtotals li, .order-summary-line-item, [id*='order-summary'] .a-row, #turbo-checkout-panel-container .a-row")
      .allInnerTexts()
      .catch(() => [] as string[]);
    for (const row of rows) if ((totalCents = findOrderTotal(row.replace(/\s+/g, " "))) !== null) break;
  }
  totalCents ??= findOrderTotal(text);
  // Every product the page links or tags: one line item means one id.
  const asins = await target
    .$$eval("[data-asin], a[href*='/dp/'], a[href*='/gp/product/']", (els) =>
      els.map((e) => e.getAttribute("data-asin") || /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/.exec(e.getAttribute("href") ?? "")?.[1] || "").filter((a) => /^[A-Z0-9]{10}$/.test(a)),
    )
    .catch(() => [] as string[]);
  const distinct = [...new Set(asins)];
  return { text, totalCents, itemsCents: findItemsSubtotal(text), itemCount: findItemCount(text) ?? (distinct.length || null), asins: distinct };
}
