/**
 * DoorDash's `dd-cli` terminal tool as a FoodProvider (FOOD_PROVIDER=cli, the binary at DOORDASH_CLI).
 *
 * BUILT AGAINST THE ANNOUNCED BETA SYNTAX, NOT YET VERIFIABLE. dd-cli is a waitlisted beta (macOS, US and Canada) and
 * its published commands are illustrative: `auth status`, `search --query "sushi" --max-results 5 --json`,
 * `cart add --item-id ITEM --quantity 2`, `cart show --json`, `checkout --confirm`. The rest of the table below is our
 * guess at the same style. Adjust the command table at the top of this file when the docs land: it is the only place
 * the syntax lives, and every reply is parsed defensively (snake or camel case, cents or dollars, nested or flat).
 *
 * The same discipline as the browser driver: one command sequence at a time; the cart must be empty before the
 * driver fills it and must then hold exactly the quoted items from the quoted store, or it stops; the total is checked
 * against the hard limit; DOORDASH_DRY_RUN stops before `checkout`; `checkout` runs at most once per order, and after
 * it the outcome is "ordered" or "uncertain", never "no_purchase". The driver empties the cart it filled.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Outcome } from "../merchant.js";
import { moneyCents, parseEta } from "./pages.js";
import { checkLines, FoodError, type FoodOrder, type FoodProvider, type FoodQuote, type MenuItem, type Restaurant, tipCents } from "./provider.js";

/** The command table: every dd-cli invocation, and nothing else in this file knows the syntax. */
export const DD_CLI = {
  /** Announced. */
  authStatus: () => ["auth", "status", "--json"],
  /** Not announced (a guess): the delivery address later commands use. */
  setAddress: (address: string) => ["address", "set", "--address", address],
  /** Announced. */
  search: (query: string, limit: number) => ["search", "--query", query, "--max-results", String(limit), "--json"],
  /** Not announced (a guess): a store's menu. */
  menu: (storeId: string) => ["store", "menu", "--store-id", storeId, "--json"],
  /** Announced. */
  cartAdd: (itemId: string, quantity: number) => ["cart", "add", "--item-id", itemId, "--quantity", String(quantity)],
  /** Announced. */
  cartShow: () => ["cart", "show", "--json"],
  /** Not announced (a guess). */
  cartClear: () => ["cart", "clear"],
  /** Not announced (a guess): the Dasher tip in dollars. */
  cartTip: (cents: number) => ["cart", "tip", "--amount", (cents / 100).toFixed(2)],
  /** Announced (--json is a guess). Places the order: run at most once per order. */
  checkout: () => ["checkout", "--confirm", "--json"],
} as const;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DoorDashCliOptions {
  /** Path to dd-cli (DOORDASH_CLI). Default "dd-cli" on PATH. */
  bin?: string;
  limitCents: number;
  /** Fill and check the cart, but never run `checkout`. */
  dryRun?: boolean;
  log?: (line: string) => void;
  /** Per command. Default 60 s. */
  timeoutMs?: number;
  /** Runs one command; tests replace it. Default: execFile, never a shell. */
  run?: (args: readonly string[]) => Promise<CliResult>;
}

// ---- defensive parsing (pure) ------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** The JSON in a command's output: the whole of it, or else its last line that parses. */
export function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    for (const line of stdout.trim().split("\n").reverse()) {
      if (!/^\s*[[{]/.test(line)) continue;
      try {
        return JSON.parse(line);
      } catch {
        // keep looking
      }
    }
    return undefined;
  }
}

/** The first of `keys` present on `o` (snake_case and camelCase both tried). */
function pick(o: Json, ...keys: string[]): unknown {
  for (const k of keys) {
    for (const variant of [k, k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())]) if (o[variant] !== undefined && o[variant] !== null) return o[variant];
  }
  return undefined;
}
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** The list in a reply: the reply itself, or the first array under one of `keys`. */
function list(v: unknown, ...keys: string[]): Json[] {
  if (Array.isArray(v)) return v.filter(isObj);
  if (!isObj(v)) return [];
  for (const k of [...keys, "results", "data", "items"]) {
    const inner = pick(v, k);
    if (Array.isArray(inner)) return inner.filter(isObj);
    if (isObj(inner)) {
      const deeper = list(inner, ...keys);
      if (deeper.length) return deeper;
    }
  }
  return [];
}

/**
 * Money in any shape a JSON API uses: { unit_amount: 1234 } (cents, DoorDash's own APIs), "$12.34", "12.34", 12.34
 * (a number with a fraction is dollars), 1234 (a whole number is cents). Null when it is none of those.
 */
export function cliCents(v: unknown): number | null {
  if (isObj(v)) return cliCents(pick(v, "unit_amount", "amount", "value", "cents"));
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Number.isInteger(v) ? v : Math.round(v * 100);
  if (typeof v === "string") return moneyCents(v.includes("$") ? v : `$${v.trim()}`);
  return null;
}

const minutes = (v: unknown): number | undefined => (typeof v === "number" && v > 0 && v < 300 ? Math.round(v) : typeof v === "string" ? parseEta(/min/i.test(v) ? v : `${v} min`) : undefined);

export function cliRestaurants(reply: unknown): Restaurant[] {
  const out: Restaurant[] = [];
  for (const r of list(reply, "stores", "restaurants")) {
    const storeId = str(pick(r, "store_id", "id"));
    const name = str(pick(r, "name", "store_name", "business_name"));
    if (!storeId || !name) continue;
    const fee = cliCents(pick(r, "delivery_fee", "fee"));
    const eta = minutes(pick(r, "eta_minutes", "eta", "delivery_eta", "asap_minutes"));
    const rating = str(pick(r, "rating", "average_rating"));
    out.push({
      storeId,
      name,
      url: str(pick(r, "url", "store_url")) || `https://www.doordash.com/store/${storeId}/`,
      ...(str(pick(r, "cuisine", "cuisine_type", "category")) ? { cuisine: str(pick(r, "cuisine", "cuisine_type", "category")) } : {}),
      ...(rating ? { rating } : {}),
      ...(eta ? { etaMinutes: eta } : {}),
      ...(fee !== null ? { deliveryFeeCents: fee } : {}),
    });
  }
  return out;
}

export function cliMenu(reply: unknown): MenuItem[] {
  const out: MenuItem[] = [];
  const add = (i: Json, section: string) => {
    const itemId = str(pick(i, "item_id", "id"));
    const name = str(pick(i, "name", "title"));
    const priceCents = cliCents(pick(i, "price", "unit_price", "display_price"));
    if (!itemId || !name || priceCents === null || out.some((m) => m.itemId === itemId)) return;
    const description = str(pick(i, "description"));
    out.push({ itemId, name, priceCents, ...(description ? { description } : {}), ...(section ? { section } : {}) });
  };
  const categories = list(reply, "categories", "menus", "sections");
  for (const c of categories) {
    const items = pick(c, "items");
    if (Array.isArray(items)) items.filter(isObj).forEach((i) => add(i, str(pick(c, "name", "title"))));
    else add(c, "");
  }
  if (!out.length) list(reply, "items").forEach((i) => add(i, ""));
  return out;
}

export interface CliCart {
  storeId: string;
  restaurant: string;
  items: { itemId: string; name: string; quantity: number; unitCents: number }[];
  subtotalCents: number | null;
  feesCents: number | null;
  taxCents: number | null;
  tipCents: number | null;
  totalCents: number | null;
  etaMinutes?: number;
  /** How many carts the reply says exist (more than one: stop). */
  carts: number;
}

export function cliCart(reply: unknown): CliCart {
  const o = isObj(reply) ? ((pick(reply, "cart") as Json | undefined) ?? reply) : {};
  const carts = isObj(reply) && Array.isArray(pick(reply, "carts")) ? (pick(reply, "carts") as unknown[]).length : 1;
  const items = list(o, "items", "line_items").flatMap((i) => {
    const itemId = str(pick(i, "item_id", "id"));
    const quantity = Number(pick(i, "quantity", "qty") ?? 0);
    const total = cliCents(pick(i, "total", "line_total"));
    const unit = cliCents(pick(i, "unit_price", "price")) ?? (total !== null && quantity ? Math.round(total / quantity) : null);
    return itemId && Number.isInteger(quantity) && quantity > 0 && unit !== null ? [{ itemId, name: str(pick(i, "name", "title")), quantity, unitCents: unit }] : [];
  });
  const fee = (k: string[]) => cliCents(pick(o, ...k));
  const feeParts = [fee(["delivery_fee"]), fee(["service_fee"]), fee(["small_order_fee"])].filter((f): f is number => f !== null);
  const eta = minutes(pick(o, "eta_minutes", "eta", "delivery_eta"));
  return {
    storeId: str(pick(o, "store_id")) || str(isObj(pick(o, "store")) ? pick(pick(o, "store") as Json, "id") : ""),
    restaurant: str(pick(o, "store_name")) || str(isObj(pick(o, "store")) ? pick(pick(o, "store") as Json, "name") : ""),
    items,
    subtotalCents: fee(["subtotal"]),
    feesCents: fee(["fees", "total_fees"]) ?? (feeParts.length ? feeParts.reduce((a, b) => a + b, 0) : null),
    taxCents: fee(["tax", "taxes", "estimated_tax"]),
    tipCents: fee(["tip", "dasher_tip"]),
    totalCents: fee(["total", "order_total", "grand_total"]),
    ...(eta ? { etaMinutes: eta } : {}),
    carts,
  };
}

/** The order id and ETA after `checkout`, when the reply names an order. */
export function cliOrder(reply: unknown): { orderId: string; etaMinutes?: number } | undefined {
  if (!isObj(reply)) return undefined;
  const o = isObj(pick(reply, "order")) ? (pick(reply, "order") as Json) : reply;
  const orderId = str(pick(o, "order_id", "order_uuid", "id", "delivery_uuid"));
  if (!orderId) return undefined;
  const eta = minutes(pick(o, "eta_minutes", "eta", "estimated_delivery_minutes"));
  return { orderId, ...(eta ? { etaMinutes: eta } : {}) };
}

// ---- the provider ------------------------------------------------------------------------------------------

/** A certain reason this order cannot be placed as asked. Nothing was ordered. */
class NotOrderable extends FoodError {}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function createDoorDashCli(o: DoorDashCliOptions): FoodProvider {
  const bin = o.bin?.trim() || "dd-cli";
  const log = o.log ?? (() => {});
  const timeout = o.timeoutMs ?? 60_000;
  const exec =
    o.run ??
    ((args: readonly string[]) =>
      new Promise<CliResult>((resolve) =>
        execFile(bin, [...args], { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
          resolve({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : "")) }),
        ),
      ));
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  /** Runs one command from the table; a non-zero exit is a FoodError with the tool's own words (logged, not shown). */
  async function cli(args: readonly string[], doing: string): Promise<unknown> {
    const r = await exec(args);
    if (r.code !== 0) {
      log(`dd-cli ${args.slice(0, 2).join(" ")} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      if (/not (?:logged|signed) in|unauthori[sz]ed|auth(?:entication)? required/i.test(`${r.stderr}\n${r.stdout}`)) throw new FoodError("dd-cli is signed out; the operator must run dd-cli auth again");
      if (/ENOENT|not found/i.test(r.stderr)) throw new FoodError(`dd-cli is not installed at ${bin}`);
      throw new FoodError(`DoorDash's dd-cli couldn't ${doing}`);
    }
    return parseJson(r.stdout);
  }

  /**
   * From an empty cart to exactly `order` in the cart, checked. Throws NotOrderable for anything else. `state.filled`
   * turns true once this driver put something in the cart, so only then is it emptied afterwards.
   */
  async function fill(order: FoodOrder, state: { filled: boolean }): Promise<Omit<FoodQuote, "quoteId" | "expiresAt">> {
    const lines = checkLines(order.items);
    const menu = cliMenu(await cli(DD_CLI.menu(order.storeId), "read the menu"));
    const before = cliCart(await cli(DD_CLI.cartShow(), "read the cart"));
    if (before.items.length) throw new NotOrderable("the DoorDash cart already holds something, so I stopped; the operator must empty it");
    await cli(DD_CLI.setAddress(order.address), "set the delivery address");
    state.filled = true;
    for (const l of lines) await cli(DD_CLI.cartAdd(l.itemId, l.quantity), "add to the cart");
    const subtotal = lines.reduce((s, l) => s + (menu.find((m) => m.itemId === l.itemId)?.priceCents ?? 0) * l.quantity, 0);
    await cli(DD_CLI.cartTip(tipCents(subtotal, order.tipPercent)), "set the tip");
    const cart = cliCart(await cli(DD_CLI.cartShow(), "read the cart"));
    if (cart.carts > 1) throw new NotOrderable("DoorDash shows more than one cart, so I stopped");
    if (cart.storeId && cart.storeId !== order.storeId) throw new NotOrderable("the cart is from another store, so I stopped");
    const want = new Map(lines.map((l) => [l.itemId, l.quantity]));
    if (cart.items.length !== want.size || !cart.items.every((i) => want.get(i.itemId) === i.quantity)) throw new NotOrderable("the cart doesn't hold exactly the items asked for, so I stopped");
    if (cart.totalCents === null) throw new NotOrderable("dd-cli didn't show the order total");
    const items = cart.items.map((i) => ({ ...i, name: i.name || menu.find((m) => m.itemId === i.itemId)?.name || i.itemId }));
    const subtotalCents = cart.subtotalCents ?? items.reduce((s, i) => s + i.unitCents * i.quantity, 0);
    return {
      storeId: order.storeId,
      restaurant: cart.restaurant || "the restaurant",
      items,
      subtotalCents,
      feesCents: cart.feesCents ?? 0,
      taxCents: cart.taxCents ?? 0,
      tipCents: cart.tipCents ?? 0,
      totalCents: cart.totalCents,
      address: order.address,
      tipPercent: order.tipPercent,
      ...(cart.etaMinutes ? { etaMinutes: cart.etaMinutes } : {}),
    };
  }

  /** Best effort: the next order stops if anything is left. */
  const clear = () => cli(DD_CLI.cartClear(), "empty the cart").then(() => undefined, (err: unknown) => log(`dd-cli: emptying the cart failed: ${(err as Error).message}`));

  return {
    name: "DoorDash",

    warm: () =>
      serial(async () => {
        const status = await cli(DD_CLI.authStatus(), "check the session");
        if (isObj(status) && (pick(status, "authenticated", "logged_in", "signed_in") === false)) throw new FoodError("dd-cli is signed out; the operator must run dd-cli auth again");
        log("dd-cli: signed in");
      }),

    searchRestaurants: (query, near, limit = 5) =>
      serial(async () => {
        await cli(DD_CLI.setAddress(near), "set the delivery address");
        return cliRestaurants(await cli(DD_CLI.search(query, limit), "search")).slice(0, limit);
      }),

    menu: (storeId) =>
      serial(async () => {
        if (!/^[\w-]+$/.test(storeId)) throw new FoodError(`${storeId} is not a DoorDash store id`);
        return cliMenu(await cli(DD_CLI.menu(storeId), "read the menu"));
      }),

    quote: (order) =>
      serial(async () => {
        const state = { filled: false };
        try {
          const priced = await fill(order, state);
          if (priced.totalCents > o.limitCents) throw new FoodError(`that order costs ${usd(priced.totalCents)} all in, over the ${usd(o.limitCents)} limit`);
          return { ...priced, quoteId: randomBytes(8).toString("hex"), expiresAt: Date.now() + 20 * 60_000 };
        } finally {
          if (state.filled) await clear();
        }
      }),

    confirm: (quote) =>
      serial(async (): Promise<Outcome> => {
        let ran = false;
        const state = { filled: false };
        try {
          let priced;
          try {
            priced = await fill({ storeId: quote.storeId, items: quote.items, address: quote.address, tipPercent: quote.tipPercent }, state);
          } catch (err) {
            if (err instanceof NotOrderable) return { status: "no_purchase", reason: err.message };
            throw err;
          }
          if (priced.totalCents > o.limitCents) return { status: "no_purchase", reason: "over the limit" };
          if (priced.totalCents !== quote.totalCents) return { status: "no_purchase", reason: "price changed" };
          if (o.dryRun) {
            log(`dd-cli: dry run, not ordering from store ${quote.storeId} at ${usd(priced.totalCents)}`);
            return { status: "no_purchase", reason: "dry run" };
          }
          // From here on nothing may answer no_purchase: the command may have reached DoorDash whatever it printed.
          ran = true;
          log(`dd-cli: placing the order at store ${quote.storeId} for ${usd(priced.totalCents)}`);
          const r = await exec(DD_CLI.checkout());
          const placed = r.code === 0 ? cliOrder(parseJson(r.stdout)) : undefined;
          if (placed) return { status: "ordered", orderId: placed.orderId, totalCents: priced.totalCents, ...((placed.etaMinutes ?? quote.etaMinutes) ? { etaMinutes: placed.etaMinutes ?? quote.etaMinutes } : {}) };
          log(`dd-cli checkout exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
          return { status: "uncertain", reason: r.code === 0 ? "dd-cli checked out but named no order" : `dd-cli checkout exited ${r.code}` };
        } catch (err) {
          if (!ran) throw err;
          return { status: "uncertain", reason: `after dd-cli checkout: ${(err as Error).message}` };
        } finally {
          if (state.filled && !ran) await clear();
        }
      }),

    async close() {
      await queue;
    },
  };
}
