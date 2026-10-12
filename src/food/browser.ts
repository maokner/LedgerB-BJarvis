/**
 * DoorDash as a FoodProvider (src/food/provider.ts), driven through a headless Chromium signed in as the operator.
 *
 * NOT VERIFIED against the real site: the selectors in pages.ts come from DoorDash's known layout. Before the first
 * real order, run the server with DOORDASH_DRY_RUN=1 and a real session, order something through Jarvis, and read the
 * screenshots in data/doordash-shots. Cloudflare guards doordash.com, so plain HTTP is refused; a real browser with the
 * operator's exported session (pnpm doordash:login, DOORDASH_STORAGE_STATE) is the only way in without an API.
 *
 * The same discipline as the Amazon driver: one operation at a time; the cart must be empty before the driver fills
 * it, and the checkout must show exactly one cart with exactly the quoted items, at the delivery address, or it stops;
 * the total is checked against the hard limit on the page; DOORDASH_DRY_RUN goes all the way to "Place Order" and
 * stops; "Place Order" is pressed at most once, and after the press the outcome is "ordered" or "uncertain", never
 * "no_purchase". Every failure leaves a screenshot. The driver empties the cart it filled after a quote or a stop.
 */
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, errors, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from "playwright";
import { bodyText, desktopUserAgent, firstVisible } from "../amazon/pages.js";
import type { Outcome } from "../merchant.js";
import {
  addressMatches, CHECKOUT_URL, cartCount, cartLines, cartMatches, DOORDASH, detectBlock, isCheckoutUrl, orderIdFromUrl, orderPlacedText, parseEta,
  readMenuCards, readStoreCards, readSummary, searchUrl, signedIn, storeUrl, toMenuItems, toRestaurants,
} from "./pages.js";
import { checkLines, FoodError, type FoodOrder, type FoodProvider, type FoodQuote, type MenuItem, tipCents } from "./provider.js";

export interface DoorDashOptions {
  /** Playwright storage state (cookies, localStorage) of a signed-in DoorDash session: JSON, or base64 of it. */
  storageState: string;
  /** Hard cap on one order's total, in cents. */
  limitCents: number;
  /** Go all the way to "Place Order" but never press it. */
  dryRun?: boolean;
  /** Where failure screenshots go. Default data/doordash-shots. */
  shotsDir?: string;
  log?: (line: string) => void;
  /** Default true. */
  headless?: boolean;
  /** Per navigation step. Default 45 s. */
  timeoutMs?: number;
}

type StorageState = Exclude<NonNullable<BrowserContextOptions["storageState"]>, string>;

/** A certain reason this order cannot be placed as asked (an item needs choices, the cart is not alone). Nothing was ordered. */
class NotOrderable extends FoodError {}

const SIGNED_OUT = "DoorDash signed the server out; the operator must refresh the DoorDash session (pnpm doordash:login)";
const QUOTE_TTL_MS = 20 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Accepts the storage state as raw JSON or base64 (the form `fly secrets set` is easiest to give). */
export function parseDoorDashState(value: string): StorageState {
  const raw = value.trim();
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  let state: unknown;
  try {
    state = JSON.parse(json);
  } catch {
    throw new Error("the DoorDash storage state is not valid JSON (nor base64 of JSON); export it again with pnpm doordash:login");
  }
  if (!state || typeof state !== "object" || !Array.isArray((state as { cookies?: unknown }).cookies)) {
    throw new Error("the DoorDash storage state has no cookies list; export it again with pnpm doordash:login");
  }
  return state as StorageState;
}

export function createDoorDashProvider(o: DoorDashOptions): FoodProvider {
  const state = parseDoorDashState(o.storageState);
  const log = o.log ?? (() => {});
  const timeoutMs = o.timeoutMs ?? 45_000;
  const shotsDir = o.shotsDir ?? "data/doordash-shots";
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();

  /** One operation at a time: two orders in one session would share one cart. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  async function newPage(): Promise<Page> {
    if (closed) throw new FoodError("the DoorDash browser is shut down");
    if (!context) {
      // Full Chromium in its new headless mode, like the Amazon driver: it looks like ordinary Chrome to Cloudflare.
      const b = await chromium.launch({ headless: o.headless ?? true, channel: "chromium" });
      b.on("disconnected", () => {
        if (browser === b) browser = context = undefined;
      });
      browser = b;
      context = await b.newContext({ storageState: state, userAgent: desktopUserAgent(b.version()), viewport: { width: 1440, height: 900 }, locale: "en-US", timezoneId: "America/Los_Angeles" });
      context.setDefaultTimeout(timeoutMs);
      context.setDefaultNavigationTimeout(timeoutMs);
      log(`doordash: browser up (Chromium ${b.version()})`);
    }
    return context.newPage();
  }

  async function shot(page: Page, label: string): Promise<void> {
    try {
      await mkdir(shotsDir, { recursive: true });
      const file = join(shotsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.png`);
      await page.screenshot({ path: file, fullPage: true, timeout: 10_000 });
      log(`doordash: screenshot ${file} (${page.url()})`);
    } catch (err) {
      log(`doordash: screenshot failed: ${(err as Error).message}`);
    }
  }

  /** Loads a page and stops on Cloudflare's check or the sign-in wall. */
  async function goto(page: Page, url: string, doing: string): Promise<void> {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await checkBlock(page, doing);
  }
  async function checkBlock(page: Page, doing: string): Promise<void> {
    const block = detectBlock(page.url(), await page.content().catch(() => ""));
    if (block === "captcha") throw new FoodError(`DoorDash's bot check stopped the browser, so I couldn't ${doing}`);
    if (block === "signin") throw new FoodError(SIGNED_OUT);
  }

  function asFoodError(err: unknown, doing: string): FoodError {
    if (err instanceof FoodError) return err;
    log(`doordash: ${doing} failed: ${(err as Error).message}`);
    if (err instanceof errors.TimeoutError) return new FoodError(`DoorDash didn't answer in time, so I couldn't ${doing}`);
    return new FoodError(`something went wrong on DoorDash, so I couldn't ${doing}`);
  }

  const button = (page: Page, name: RegExp, ids: string): Promise<Locator | undefined> => firstVisible([page.locator(ids), page.getByRole("button", { name })]);
  const headerCart = (page: Page) => firstVisible([page.locator("[data-anchor-id='HeaderOrderCart'], [data-testid='OrderCartIconButton'], button[aria-label*='cart' i]")]);

  /** Items in the cart, from the header cart button; null when it cannot be read. */
  async function cartSize(page: Page): Promise<number | null> {
    const cart = await headerCart(page);
    if (!cart) return null;
    return cartCount(`${(await cart.getAttribute("aria-label").catch(() => null)) ?? ""} ${await cart.innerText({ timeout: 2_000 }).catch(() => "")}`.trim());
  }

  /** Removes everything from the cart this driver filled. Best effort: the next order stops if anything is left. */
  async function emptyCart(page: Page): Promise<void> {
    try {
      for (let i = 0; i < 30 && (await cartSize(page)) !== 0; i++) {
        if (!(await page.locator("[role='dialog'], [data-testid='OrderCart']").first().isVisible().catch(() => false))) await (await headerCart(page))?.click();
        const remove = await firstVisible([page.locator("[data-anchor-id='DeleteItemButton'], button[aria-label^='Remove' i], button[aria-label*='decrease' i]")]);
        if (!remove) break;
        await remove.click();
        await sleep(700);
      }
      const left = await cartSize(page);
      if (left) log(`doordash: WARNING the cart still holds ${left} item(s); the operator must empty it before the next order`);
    } catch (err) {
      log(`doordash: emptying the cart failed: ${(err as Error).message}`);
    }
  }

  /** Points the account's delivery address at `address` (the header address picker) and checks it took. */
  async function ensureAddress(page: Page, address: string): Promise<void> {
    if (!page.url().startsWith(DOORDASH)) await goto(page, `${DOORDASH}/`, "load DoorDash");
    const picker = () => firstVisible([page.locator("[data-anchor-id='AddressTextButton'], [data-testid='addressTextButton'], button[aria-label*='address' i]")]);
    const shown = async () => (await (await picker())?.innerText({ timeout: 3_000 }).catch(() => "")) ?? "";
    if (addressMatches(await shown(), address)) return;
    const open = await picker();
    if (!open) throw new NotOrderable("I couldn't find DoorDash's address picker");
    await open.click();
    const input = page.locator("input[placeholder*='address' i], input[aria-label*='address' i]").first();
    await input.fill(address);
    const suggestion = page.locator("[data-anchor-id='AddressAutocompleteSuggestion'], [role='option']").first();
    await suggestion.waitFor({ state: "visible", timeout: 10_000 });
    await suggestion.click();
    const save = await button(page, /^save( address)?$/i, "[data-anchor-id='AddressEditSave']");
    if (save) await save.click();
    await sleep(1_500);
    if (!addressMatches(await shown(), address)) throw new NotOrderable(`DoorDash would not take the delivery address ${address}`);
    log("doordash: delivery address set");
  }

  async function readMenu(page: Page, storeId: string): Promise<{ name: string; items: MenuItem[] }> {
    await goto(page, storeUrl(storeId), "open the restaurant");
    await page.locator("[data-anchor-id='MenuItem'], [data-testid='MenuItem'], [data-item-id]").first().waitFor({ timeout: 15_000 }).catch(() => {});
    const name = ((await page.locator("h1").first().textContent({ timeout: 5_000 }).catch(() => null)) ?? "").replace(/\s+/g, " ").trim();
    if (/currently closed|closed now|not accepting orders/i.test(await bodyText(page))) throw new NotOrderable(`${name || "that restaurant"} is closed right now`);
    return { name, items: toMenuItems(await readMenuCards(page)) };
  }

  /** Opens an item's modal and presses "Add to cart" once. Items that need choices are refused. */
  async function addOnce(page: Page, item: MenuItem): Promise<void> {
    const card = await firstVisible([page.locator(`[data-item-id='${item.itemId}']`), page.locator("[data-anchor-id='MenuItem'], [data-testid='MenuItem']").filter({ hasText: item.name })]);
    if (!card) throw new NotOrderable(`I couldn't find ${item.name} on the menu page`);
    await card.click();
    const dialog = page.locator("[role='dialog']").first();
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    if (/\brequired\b/i.test(await dialog.innerText().catch(() => ""))) throw new NotOrderable(`${item.name} needs choices (size, sides) that I can't pick for you`);
    const add = await firstVisible([dialog.locator("[data-anchor-id='AddToCartButton']"), dialog.getByRole("button", { name: /add to cart/i })]);
    if (!add) throw new NotOrderable(`${item.name} has no "Add to cart" button`);
    await add.click();
    await dialog.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
  }

  /**
   * From an empty cart to the checkout of exactly `order`: address, menu, items, checkout page, then the checks. Throws
   * NotOrderable for anything that is not exactly this order. Nothing is placed. `state.filled` turns true once this
   * driver put something in the cart, so only then is it emptied afterwards (never the operator's own cart).
   */
  async function openCheckout(page: Page, order: FoodOrder, state: { filled: boolean }): Promise<Omit<FoodQuote, "quoteId" | "expiresAt"> & { placeOrder: Locator }> {
    const lines = checkLines(order.items);
    await ensureAddress(page, order.address);
    const menu = await readMenu(page, order.storeId);
    const wanted = lines.map((l) => {
      const found = menu.items.find((m) => m.itemId === l.itemId);
      if (!found) throw new NotOrderable(`${menu.name || "the restaurant"} has no item ${l.itemId} now; check doordash_menu again`);
      return { item: found, quantity: l.quantity };
    });
    const before = await cartSize(page);
    if (before !== 0) throw new NotOrderable(before === null ? "I couldn't read DoorDash's cart, so I stopped" : "the DoorDash cart already holds something, so I stopped; the operator must empty it");
    state.filled = true;
    for (const w of wanted) for (let i = 0; i < w.quantity; i++) await addOnce(page, w.item);

    await goto(page, CHECKOUT_URL, "open the checkout");
    if (!isCheckoutUrl(page.url())) throw new NotOrderable("DoorDash didn't open the checkout");
    await selectTip(page, order.tipPercent);
    // The summary fills in after the page loads; wait for a total and the order button together.
    const deadline = Date.now() + Math.min(timeoutMs, 20_000);
    let text = await bodyText(page);
    let placeOrder = await button(page, /place order/i, "[data-anchor-id='PlaceOrderButton']");
    while ((readSummary(text).totalCents === null || !placeOrder) && Date.now() < deadline) {
      await sleep(500);
      text = await bodyText(page);
      placeOrder = await button(page, /place order/i, "[data-anchor-id='PlaceOrderButton']");
    }
    const sum = readSummary(text);
    if (/\b\d+\s+carts\b/i.test(text)) throw new NotOrderable("the checkout shows more than one cart, so I stopped");
    const expected = wanted.map((w) => ({ name: w.item.name, quantity: w.quantity }));
    if (!cartMatches(cartLines(text), expected)) throw new NotOrderable("the checkout doesn't show exactly the items asked for, so I stopped");
    const subtotal = wanted.reduce((s, w) => s + w.item.priceCents * w.quantity, 0);
    if (sum.subtotalCents !== subtotal) throw new NotOrderable(`the checkout subtotal (${sum.subtotalCents === null ? "unreadable" : usd(sum.subtotalCents)}) is not the menu's ${usd(subtotal)}, so I stopped`);
    if (!addressMatches(text, order.address)) throw new NotOrderable("the checkout shows a different delivery address, so I stopped");
    if (sum.totalCents === null) throw new NotOrderable("I couldn't read the order total on the checkout page");
    if (!placeOrder) throw new NotOrderable("I couldn't find the Place Order button");
    const etaMinutes = parseEta(text);
    log(`doordash: checkout for store ${order.storeId}: subtotal ${usd(subtotal)}, total ${usd(sum.totalCents)}`);
    return {
      storeId: order.storeId,
      restaurant: menu.name || "the restaurant",
      items: wanted.map((w) => ({ itemId: w.item.itemId, name: w.item.name, quantity: w.quantity, unitCents: w.item.priceCents })),
      subtotalCents: subtotal,
      feesCents: sum.feesCents ?? 0,
      taxCents: sum.taxCents ?? 0,
      tipCents: sum.tipCents ?? tipCents(subtotal, order.tipPercent),
      totalCents: sum.totalCents,
      address: order.address,
      tipPercent: order.tipPercent,
      ...(etaMinutes ? { etaMinutes } : {}),
      placeOrder,
    };
  }

  /** The tip button for `percent`, or "Other" with the amount. The page's own tip stays when neither shows; the quote reports what the page charges. */
  async function selectTip(page: Page, percent: number): Promise<void> {
    const preset = await firstVisible([page.getByRole("button", { name: new RegExp(`^\\s*${percent}\\s*%`) })]);
    if (preset) return void (await preset.click().catch(() => {}));
    const other = await firstVisible([page.getByRole("button", { name: /^other$/i })]);
    if (!other) return;
    const subtotal = readSummary(await bodyText(page)).subtotalCents;
    if (subtotal === null) return;
    await other.click().catch(() => {});
    const input = page.locator("input[inputmode='decimal'], input[aria-label*='tip' i]").first();
    await input.fill((tipCents(subtotal, percent) / 100).toFixed(2)).catch(() => {});
    await (await button(page, /^(save|done|apply)$/i, "[data-anchor-id='TipSave']"))?.click().catch(() => {});
  }

  /** After the press: waits for the order page. Never throws, never presses again. */
  async function awaitOrder(page: Page, quote: FoodQuote, totalCents: number): Promise<Outcome> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1_000);
      const orderId = orderIdFromUrl(page.url());
      if (orderId) {
        const etaMinutes = parseEta(await bodyText(page)) ?? quote.etaMinutes;
        return { status: "ordered", orderId, totalCents, ...(etaMinutes ? { etaMinutes } : {}) };
      }
    }
    await shot(page, `confirm-${quote.storeId}`);
    const text = await bodyText(page);
    return { status: "uncertain", reason: orderPlacedText(text) ? "DoorDash said the order went through but I couldn't read the order number" : "I pressed Place Order but DoorDash never showed the order page" };
  }

  return {
    name: "DoorDash",

    warm: () =>
      serial(async () => {
        const page = await newPage();
        try {
          await goto(page, `${DOORDASH}/`, "load DoorDash");
          const header = await page.locator("header").first().innerText({ timeout: 10_000 }).catch(() => "");
          if (!signedIn(header)) throw new FoodError(SIGNED_OUT);
          log("doordash: signed in");
        } catch (err) {
          await shot(page, "warm");
          throw asFoodError(err, "load DoorDash");
        } finally {
          await page.close().catch(() => {});
        }
      }),

    searchRestaurants: (query, near, limit = 5) =>
      serial(async () => {
        const page = await newPage();
        try {
          await ensureAddress(page, near);
          await goto(page, searchUrl(query), "search");
          // No results is a fine answer, so a missing list is not an error.
          await page.locator("a[href*='/store/']").first().waitFor({ timeout: 10_000 }).catch(() => {});
          const found = toRestaurants(await readStoreCards(page)).slice(0, limit);
          log(`doordash: search "${query}": ${found.length} restaurants`);
          return found;
        } catch (err) {
          await shot(page, "search");
          throw asFoodError(err, "search");
        } finally {
          await page.close().catch(() => {});
        }
      }),

    menu: (storeId) =>
      serial(async () => {
        if (!/^\d+$/.test(storeId)) throw new FoodError(`${storeId} is not a DoorDash store id`);
        const page = await newPage();
        try {
          return (await readMenu(page, storeId)).items;
        } catch (err) {
          await shot(page, `menu-${storeId}`);
          throw asFoodError(err, "read the menu");
        } finally {
          await page.close().catch(() => {});
        }
      }),

    quote: (order) =>
      serial(async () => {
        const page = await newPage();
        const state = { filled: false };
        try {
          const { placeOrder: _button, ...priced } = await openCheckout(page, order, state);
          if (priced.totalCents > o.limitCents) throw new FoodError(`that order costs ${usd(priced.totalCents)} all in, over the ${usd(o.limitCents)} limit`);
          return { ...priced, quoteId: randomBytes(8).toString("hex"), expiresAt: Date.now() + QUOTE_TTL_MS };
        } catch (err) {
          await shot(page, `quote-${order.storeId}`);
          throw asFoodError(err, "price the order");
        } finally {
          if (state.filled) await emptyCart(page);
          await page.close().catch(() => {});
        }
      }),

    confirm: (quote) =>
      serial(async (): Promise<Outcome> => {
        const page = await newPage();
        let pressed = false;
        const state = { filled: false };
        try {
          let checkout;
          try {
            checkout = await openCheckout(page, { storeId: quote.storeId, items: quote.items, address: quote.address, tipPercent: quote.tipPercent }, state);
          } catch (err) {
            await shot(page, `confirm-${quote.storeId}`);
            if (err instanceof NotOrderable) return { status: "no_purchase", reason: err.message };
            // Signed out or the bot check: a setup problem for the operator, thrown. Anything else before the press is certain.
            if (err instanceof FoodError) throw err;
            return { status: "no_purchase", reason: asFoodError(err, "check out").message };
          }
          if (checkout.totalCents > o.limitCents) return { status: "no_purchase", reason: "over the limit" };
          if (checkout.totalCents !== quote.totalCents) {
            log(`doordash: total for store ${quote.storeId} is now ${usd(checkout.totalCents)}, quoted ${usd(quote.totalCents)}`);
            return { status: "no_purchase", reason: "price changed" };
          }
          if (o.dryRun) {
            log(`doordash: dry run, not ordering from store ${quote.storeId} at ${usd(checkout.totalCents)}`);
            return { status: "no_purchase", reason: "dry run" };
          }
          // From here on nothing may answer no_purchase: the click may have reached DoorDash even if it reports an error.
          pressed = true;
          log(`doordash: placing the order at store ${quote.storeId} for ${usd(checkout.totalCents)}`);
          await checkout.placeOrder.click({ timeout: 10_000 }).catch((err: unknown) => log(`doordash: the order click reported ${(err as Error).message}`));
          const outcome = await awaitOrder(page, quote, checkout.totalCents);
          log(`doordash: store ${quote.storeId}: ${outcome.status}${outcome.status === "ordered" ? ` ${outcome.orderId}` : ` (${outcome.reason})`}`);
          return outcome;
        } catch (err) {
          if (!pressed) throw err;
          await shot(page, `confirm-${quote.storeId}`);
          return { status: "uncertain", reason: `after pressing Place Order: ${(err as Error).message}` };
        } finally {
          // Never touch the cart after the press: an order in flight is not ours to edit.
          if (state.filled && !pressed) await emptyCart(page);
          await page.close().catch(() => {});
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
