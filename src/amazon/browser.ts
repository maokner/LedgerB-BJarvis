/**
 * Amazon as a Merchant (see src/merchant.ts), driven through a headless Chromium signed in as the operator.
 *
 * The session comes from a Playwright storage state the operator exports once (pnpm amazon:login) and hands the server
 * as AMAZON_STORAGE_STATE. Orders always go through "Buy Now", never the cart: the operator's own cart may hold other
 * things and must never be checked out. One checkout runs at a time, and the order total is checked against the hard
 * limit here, on the page, not only by the caller.
 *
 * Once "Place your order" is pressed the outcome is "ordered" (with Amazon's order number) or "uncertain", never
 * "no_purchase", and the button is never pressed twice.
 */
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, errors, type Browser, type BrowserContext, type BrowserContextOptions, type Frame, type Page } from "playwright";
import { MerchantError, type Merchant, type Outcome, type Quote } from "../merchant.js";
import {
  AMAZON, bodyText, desktopUserAgent, detectBlock, findOrderId, firstVisible, isAsin, isCheckoutUrl, isThankYouUrl, newestOrderFor, productUrl,
  readCheckout, readProductPrice, readSearchResults, signedInName, titleShown, toProducts, usd, type CheckoutRead,
} from "./pages.js";

export interface AmazonOptions {
  /** Playwright storage state (cookies, localStorage) of a signed-in Amazon session: JSON, or base64 of it. */
  storageState: string;
  /** Hard cap on one order's total, in cents. */
  limitCents: number;
  /** Go all the way to "Place your order" but never press it. */
  dryRun?: boolean;
  /** Where failure screenshots go. Default data/amazon-shots. */
  shotsDir?: string;
  log?: (line: string) => void;
  /** Default true. */
  headless?: boolean;
  /** Per navigation step. Default 45 s. */
  timeoutMs?: number;
}

export type AmazonMerchant = Merchant & {
  /** Starts the browser, loads amazon.com and checks the session is signed in. Throws MerchantError when it is not. */
  warm(): Promise<void>;
};

type StorageState = Exclude<NonNullable<BrowserContextOptions["storageState"]>, string>;

/** A certain reason this item cannot be bought right now (unavailable, more than one item, total unreadable). Nothing was ordered. */
class NotBuyable extends MerchantError {}

const SIGNED_OUT = "Amazon signed the server out; the operator must refresh the Amazon session";
const QUOTE_TTL_MS = 30 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Accepts the storage state as raw JSON or base64 (the form `fly secrets set` is easiest to give). */
export function parseStorageState(value: string): StorageState {
  const raw = value.trim();
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  let state: unknown;
  try {
    state = JSON.parse(json);
  } catch {
    throw new Error("the Amazon storage state is not valid JSON (nor base64 of JSON); export it again with pnpm amazon:login");
  }
  if (!state || typeof state !== "object" || !Array.isArray((state as { cookies?: unknown }).cookies)) {
    throw new Error("the Amazon storage state has no cookies list; export it again with pnpm amazon:login");
  }
  return state as StorageState;
}

export function createAmazonMerchant(o: AmazonOptions): AmazonMerchant {
  const state = parseStorageState(o.storageState);
  const log = o.log ?? (() => {});
  const timeoutMs = o.timeoutMs ?? 45_000;
  const shotsDir = o.shotsDir ?? "data/amazon-shots";
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();

  /** One operation at a time: two checkouts in one session could mix their pages. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  async function newPage(): Promise<Page> {
    if (closed) throw new MerchantError("the Amazon browser is shut down");
    if (!context) {
      // channel "chromium" is the full browser in its new headless mode, which looks like ordinary Chrome to Amazon
      // (the default headless shell is easier to tell apart). Playwright already passes --no-sandbox unless
      // chromiumSandbox is set, which is what lets the unprivileged node user run it in the container.
      const b = await chromium.launch({ headless: o.headless ?? true, channel: "chromium" });
      b.on("disconnected", () => {
        if (browser === b) browser = context = undefined;
      });
      browser = b;
      context = await b.newContext({
        storageState: state,
        userAgent: desktopUserAgent(b.version()),
        viewport: { width: 1440, height: 900 },
        locale: "en-US",
        timezoneId: "America/Los_Angeles",
      });
      context.setDefaultTimeout(timeoutMs);
      context.setDefaultNavigationTimeout(timeoutMs);
      log(`amazon: browser up (Chromium ${b.version()})`);
    }
    return context.newPage();
  }

  async function shot(page: Page, label: string): Promise<void> {
    try {
      await mkdir(shotsDir, { recursive: true });
      const file = join(shotsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.png`);
      await page.screenshot({ path: file, fullPage: true, timeout: 10_000 });
      log(`amazon: screenshot ${file} (${page.url()})`);
    } catch (err) {
      log(`amazon: screenshot failed: ${(err as Error).message}`);
    }
  }

  /** Loads a page and stops on a robot check or a sign-in wall. */
  async function goto(page: Page, url: string, doing: string): Promise<void> {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    checkBlock(page.url(), await page.content(), doing);
  }
  function checkBlock(url: string, html: string, doing: string): void {
    const block = detectBlock(url, html);
    if (block === "captcha") throw new MerchantError(`Amazon asked for a captcha, so I couldn't ${doing}`);
    if (block === "signin") throw new MerchantError(SIGNED_OUT);
  }

  function asMerchantError(err: unknown, doing: string): MerchantError {
    if (err instanceof MerchantError) return err;
    log(`amazon: ${doing} failed: ${(err as Error).message}`);
    if (err instanceof errors.TimeoutError) return new MerchantError(`Amazon didn't answer in time, so I couldn't ${doing}`);
    return new MerchantError(`something went wrong on Amazon, so I couldn't ${doing}`);
  }

  /** Leaves the checkout without ordering. Amazon holds nothing for an abandoned Buy Now. */
  async function leave(page: Page): Promise<void> {
    await page.goto(`${AMAZON}/`, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
    await page.close().catch(() => {});
  }

  /** After Buy Now: the checkout page (classic or new), or the Buy Now side sheet's iframe. */
  async function waitForCheckout(page: Page): Promise<Page | Frame> {
    const deadline = Date.now() + timeoutMs;
    let declinedPrime = false;
    while (Date.now() < deadline) {
      checkBlock(page.url(), "", "check out");
      if (isCheckoutUrl(page.url())) {
        // A Prime sign-up page can sit between Buy Now and checkout; say no once and keep waiting.
        const noThanks = declinedPrime ? undefined : await firstVisible([page.locator("#prime-interstitial-nothanks-button, #prime-declineCTA, a.prime-nothanks-button")]);
        if (noThanks) {
          declinedPrime = true;
          log("amazon: declining the Prime offer");
          await noThanks.click();
        } else {
          await page.waitForLoadState("domcontentloaded");
          checkBlock(page.url(), await page.content(), "check out");
          return page;
        }
      }
      // The side sheet ("turbo checkout") keeps the product page and opens the order summary in an iframe.
      const frame = await (await page.$("#turbo-checkout-iframe, iframe[name='turbo-checkout-iframe']"))?.contentFrame();
      if (frame && frame.url() !== "about:blank") return frame;
      await sleep(300);
    }
    throw new NotBuyable("Buy Now didn't open a checkout page");
  }

  /** "Place your order" across the side sheet and both checkout layouts. */
  const placeOrderButton = (target: Page | Frame) =>
    firstVisible([
      target.locator("#placeYourOrder, input[name='placeYourOrder1'], #turbo-checkout-pyo-button, #bottomSubmitOrderButtonId, #submitOrderButtonId"),
      target.getByRole("button", { name: /place your order/i }),
    ]);

  /** Opens the product, presses Buy Now and reads the checkout without ordering. Throws NotBuyable for item problems. */
  async function openCheckout(page: Page, asin: string): Promise<{ target: Page | Frame; title: string; itemCents: number; read: CheckoutRead & { totalCents: number } }> {
    await goto(page, productUrl(asin), "open the item");
    // Amazon may redirect an old id to another listing; buy only what was asked for.
    const shown = await page.locator("input#ASIN, input[name='ASIN']").first().inputValue({ timeout: 3_000 }).catch(() => null);
    if (shown && shown !== asin) throw new NotBuyable(`Amazon now shows a different item (${shown}) for ${asin}`);
    const title = ((await page.locator("#productTitle").first().textContent({ timeout: 10_000 }).catch(() => null)) ?? "").replace(/\s+/g, " ").trim();
    if (!title) throw new NotBuyable("I couldn't read the item's page on Amazon");
    const listedCents = await readProductPrice(page);
    // Only an item with a plain Buy Now: anything that needs a size, color or seller choice first is refused.
    const buyNow = page.locator("#buy-now-button").first();
    if (!(await buyNow.isVisible().catch(() => false))) {
      // Grocery-style buy boxes may open on "Subscribe & Save", whose row has no Buy Now: open "One-time purchase" once.
      const oneTime = await firstVisible([page.locator("#buyBoxAccordion .a-accordion-row").filter({ hasText: /one-time purchase/i })]);
      if (oneTime) await oneTime.click().then(() => buyNow.waitFor({ state: "visible", timeout: 5_000 })).catch(() => {});
    }
    if (!(await buyNow.isVisible().catch(() => false))) throw new NotBuyable("this item needs options or is unavailable");
    await buyNow.click();
    const target = await waitForCheckout(page);
    // The summary fills in after the page loads; wait for a total and the order button together.
    const deadline = Date.now() + Math.min(timeoutMs, 20_000);
    let read = await readCheckout(target);
    while ((read.totalCents === null || !(await placeOrderButton(target))) && Date.now() < deadline) {
      await sleep(500);
      read = await readCheckout(target);
    }
    if ((read.itemCount ?? 1) > 1) throw new NotBuyable("the checkout page shows more than one item, so I stopped");
    // A quantity above one shows as an items subtotal that is a multiple of the listed price.
    if (listedCents && read.itemsCents !== null && read.itemsCents >= 2 * listedCents) throw new NotBuyable("the checkout page shows more than one item, so I stopped");
    if (!read.asins.includes(asin) && !titleShown(read.text, title)) throw new NotBuyable("the checkout page doesn't show this item, so I stopped");
    const totalCents = read.totalCents;
    if (totalCents === null) throw new NotBuyable("I couldn't read the order total on the checkout page");
    const itemCents = read.itemsCents ?? listedCents ?? totalCents;
    log(`amazon: checkout for ${asin}: item ${usd(itemCents)}, total ${usd(totalCents)} (${target === page ? page.url() : "side sheet"})`);
    return { target, title, itemCents, read: { ...read, totalCents } };
  }

  /** After the press: waits for the thank-you page and its order number. Never throws, never presses again. */
  async function awaitOrder(page: Page, target: Page | Frame, quote: Quote, totalCents: number): Promise<Outcome> {
    const deadline = Date.now() + timeoutMs;
    let thankedAt = 0;
    // Once Amazon says thanks, give the order number 10 s to render before looking it up on Your Orders.
    while (Date.now() < deadline && !(thankedAt && Date.now() - thankedAt > 10_000)) {
      await sleep(1_000);
      const text = `${await bodyText(page)}\n${target === page ? "" : await bodyText(target)}`;
      if (!thankedAt && (isThankYouUrl(page.url()) || /order placed|thank you/i.test(text))) thankedAt = Date.now();
      if (!thankedAt) continue;
      const numberCell = await firstVisible([page.locator(".order-number, #order-number"), ...(target === page ? [] : [target.locator(".order-number, #order-number")])]);
      const orderId = findOrderId(text) ?? findOrderId((await numberCell?.textContent({ timeout: 1_000 }).catch(() => null)) ?? "");
      if (orderId) return { status: "ordered", orderId, totalCents };
    }
    const thanked = thankedAt > 0;
    await shot(page, `confirm-${quote.asin}`);
    if (!thanked) return { status: "uncertain", reason: "I pressed Place your order but Amazon never showed the order confirmation" };
    // Amazon said the order was placed but the page had no number: the newest order on Your Orders, if it is this item.
    try {
      await page.goto(`${AMAZON}/gp/css/order-history`, { waitUntil: "domcontentloaded", timeout: 20_000 });
      const orderId = newestOrderFor(await bodyText(page), quote.title);
      if (orderId) return { status: "ordered", orderId, totalCents };
    } catch (err) {
      log(`amazon: reading Your Orders failed: ${(err as Error).message}`);
    }
    return { status: "uncertain", reason: "Amazon said the order was placed but I couldn't read the order number" };
  }

  return {
    name: "Amazon",

    warm: () =>
      serial(async () => {
        const page = await newPage();
        try {
          await goto(page, `${AMAZON}/`, "load Amazon");
          // The nav greeting: "Hello, Matt" when signed in, "Hello, sign in" when not.
          const greeting = await page.locator("#nav-link-accountList-nav-line-1, #nav-link-accountList").first().innerText({ timeout: 10_000 }).catch(() => "");
          const name = signedInName(greeting);
          if (!name) throw new MerchantError(SIGNED_OUT);
          log(`amazon: signed in as ${name}`);
        } catch (err) {
          await shot(page, "warm");
          throw asMerchantError(err, "load Amazon");
        } finally {
          await page.close().catch(() => {});
        }
      }),

    search: (query, limit = 5) =>
      serial(async () => {
        const page = await newPage();
        try {
          await goto(page, `${AMAZON}/s?k=${encodeURIComponent(query)}`, "search");
          // No results is a fine answer, so a missing grid is not an error.
          await page.locator('div[data-component-type="s-search-result"]').first().waitFor({ timeout: 10_000 }).catch(() => {});
          const products = toProducts(await readSearchResults(page)).slice(0, limit);
          log(`amazon: search "${query}": ${products.length} results`);
          return products;
        } catch (err) {
          await shot(page, "search");
          throw asMerchantError(err, "search");
        } finally {
          await page.close().catch(() => {});
        }
      }),

    prepare: (asin) =>
      serial(async () => {
        if (!isAsin(asin)) throw new MerchantError(`${asin} is not an Amazon item id`);
        const page = await newPage();
        try {
          const { title, itemCents, read } = await openCheckout(page, asin);
          if (read.totalCents > o.limitCents) throw new MerchantError(`costs ${usd(read.totalCents)} all in, over the ${usd(o.limitCents)} limit`);
          return { quoteId: randomBytes(8).toString("hex"), asin, title, itemCents, totalCents: read.totalCents, expiresAt: Date.now() + QUOTE_TTL_MS };
        } catch (err) {
          await shot(page, `prepare-${asin}`);
          throw asMerchantError(err, "price the item");
        } finally {
          await leave(page);
        }
      }),

    confirm: (quote) =>
      serial(async (): Promise<Outcome> => {
        const page = await newPage();
        let pressed = false;
        try {
          let checkout;
          try {
            checkout = await openCheckout(page, quote.asin);
          } catch (err) {
            await shot(page, `confirm-${quote.asin}`);
            if (err instanceof NotBuyable) return { status: "no_purchase", reason: err.message };
            // Signed out or a captcha: a setup problem for the operator, thrown. Anything else before the press is certain.
            if (err instanceof MerchantError) throw err;
            return { status: "no_purchase", reason: asMerchantError(err, "check out").message };
          }
          const { target, read } = checkout;
          if (read.totalCents > o.limitCents) return { status: "no_purchase", reason: "over the limit" };
          if (read.totalCents !== quote.totalCents) {
            log(`amazon: total for ${quote.asin} is now ${usd(read.totalCents)}, quoted ${usd(quote.totalCents)}`);
            return { status: "no_purchase", reason: "price changed" };
          }
          const button = await placeOrderButton(target);
          if (!button) {
            await shot(page, `confirm-${quote.asin}`);
            return { status: "no_purchase", reason: "I couldn't find the Place your order button" };
          }
          if (o.dryRun) {
            log(`amazon: dry run, not ordering ${quote.asin} at ${usd(read.totalCents)}`);
            return { status: "no_purchase", reason: "dry run" };
          }
          // From here on nothing may answer no_purchase: the click may have reached Amazon even if it reports an error.
          pressed = true;
          log(`amazon: placing the order for ${quote.asin} at ${usd(read.totalCents)}`);
          await button.click({ timeout: 10_000 }).catch((err: unknown) => log(`amazon: the order click reported ${(err as Error).message}`));
          const outcome = await awaitOrder(page, target, quote, read.totalCents);
          log(`amazon: ${quote.asin}: ${outcome.status}${outcome.status === "ordered" ? ` ${outcome.orderId}` : ` (${outcome.reason})`}`);
          return outcome;
        } catch (err) {
          if (!pressed) throw err;
          await shot(page, `confirm-${quote.asin}`);
          return { status: "uncertain", reason: `after pressing Place your order: ${(err as Error).message}` };
        } finally {
          await (pressed ? page.close().catch(() => {}) : leave(page));
        }
      }),

    async close() {
      closed = true;
      await queue;
      await browser?.close().catch(() => {});
      browser = context = undefined;
    },
  };
}
