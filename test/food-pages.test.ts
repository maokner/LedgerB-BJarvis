/** The DoorDash drivers' pure parsing (doordash.com page text, dd-cli JSON) and the dd-cli adapter over a fake binary. */
import { describe, expect, it } from "vitest";
import { createDoorDashProvider, parseDoorDashState } from "../src/food/browser.js";
import { cliCart, cliCents, cliMenu, cliOrder, cliRestaurants, createDoorDashCli, DD_CLI, parseJson, type CliResult } from "../src/food/cli.js";
import {
  addressMatches, cartCount, cartLines, cartMatches, detectBlock, isCheckoutUrl, moneyCents, orderIdFromUrl, orderPlacedText, parseDeliveryFee, parseEta, parseRating,
  readSummary, searchUrl, signedIn, storeIdFromUrl, toMenuItems, toRestaurants,
} from "../src/food/pages.js";
import { checkLines, itemsSummary } from "../src/food/provider.js";

describe("DoorDash page parsing", () => {
  it("reads money, store ids, order ids and URLs", () => {
    expect(moneyCents("$12.34")).toBe(1234);
    expect(moneyCents("Total $1,204.50")).toBe(120450);
    expect(moneyCents("$0 delivery fee")).toBe(0);
    expect(moneyCents("free")).toBeNull();
    expect(storeIdFromUrl("https://www.doordash.com/store/chipotle-mexican-grill-1234567/")).toBe("1234567");
    expect(storeIdFromUrl("/store/1234567/?pickup=false")).toBe("1234567");
    expect(storeIdFromUrl("/store/joes-pizza-2-24680/")).toBe("24680");
    expect(storeIdFromUrl("/cuisine/pizza/")).toBeUndefined();
    expect(orderIdFromUrl("https://www.doordash.com/orders/3f2a1b9c-0d4e-4a5b-9c8d-7e6f5a4b3c2d/")).toBe("3f2a1b9c-0d4e-4a5b-9c8d-7e6f5a4b3c2d");
    expect(orderIdFromUrl("https://www.doordash.com/orders/")).toBeUndefined();
    expect(isCheckoutUrl("https://www.doordash.com/checkout/")).toBe(true);
    expect(isCheckoutUrl("https://www.doordash.com/checkout-help/")).toBe(false);
    expect(searchUrl("pad thai")).toBe("https://www.doordash.com/search?query=pad%20thai");
  });

  it("reads ETAs, fees and ratings off store cards", () => {
    expect(parseEta("25-35 min")).toBe(35);
    expect(parseEta("25–35 mins")).toBe(35);
    expect(parseEta("30 min")).toBe(30);
    expect(parseEta("Closed")).toBeUndefined();
    expect(parseDeliveryFee("$0 delivery fee over $12")).toBe(0);
    expect(parseDeliveryFee("$1.99 Delivery Fee")).toBe(199);
    expect(parseDeliveryFee("4.7 ★")).toBeUndefined();
    expect(parseRating("4.7 ★ (2k+)")).toBe("4.7");
    expect(parseRating("Rated 4.5 out of 5")).toBe("4.5");
  });

  it("turns store cards into restaurants, each once", () => {
    const cards = [
      { href: "/store/chipotle-mexican-grill-1234567/", name: "Chipotle Mexican Grill", text: "Chipotle Mexican Grill\n4.7 ★ (10k+)\n0.8 mi • 20-30 min\n$0 delivery fee over $12" },
      { href: "/store/chipotle-mexican-grill-1234567/", name: "Chipotle Mexican Grill", text: "duplicate" },
      { href: "/store/joes-pizza-24680/", name: "", text: "Joe's Pizza\n4.8 ★\n35 min\n$2.99 delivery fee" },
      { href: "/promo/", name: "Deals", text: "Deals" },
    ];
    expect(toRestaurants(cards)).toEqual([
      { storeId: "1234567", name: "Chipotle Mexican Grill", url: "https://www.doordash.com/store/chipotle-mexican-grill-1234567/", rating: "4.7", etaMinutes: 30, deliveryFeeCents: 0 },
      { storeId: "24680", name: "Joe's Pizza", url: "https://www.doordash.com/store/joes-pizza-24680/", rating: "4.8", etaMinutes: 35, deliveryFeeCents: 299 },
    ]);
  });

  it("turns menu cards into items and skips the ones without an id or a price", () => {
    expect(
      toMenuItems([
        { id: "111", name: " Burrito  Bowl ", priceText: "$11.95", description: "Rice, beans", section: "Bowls" },
        { id: "111", name: "Burrito Bowl", priceText: "$11.95", description: "", section: "" },
        { id: "", name: "No id", priceText: "$1.00", description: "", section: "" },
        { id: "222", name: "Market price", priceText: "", description: "", section: "" },
        { id: "333", name: "Chips", priceText: "$2.45", description: "", section: "" },
      ]),
    ).toEqual([
      { itemId: "111", name: "Burrito Bowl", priceCents: 1195, description: "Rice, beans", section: "Bowls" },
      { itemId: "333", name: "Chips", priceCents: 245 },
    ]);
  });

  it("reads the checkout summary, with amounts on the same line or the next", () => {
    const text = "Your cart from Chipotle\n1x Burrito Bowl\n$11.95\n2x Chips\n$4.90\nSubtotal\n$16.85\nDelivery Fee\n$1.99\nService Fee\n$3.00\nEstimated Tax\n$1.45\nDasher Tip\n$2.53\nTotal\n$25.82\nPlace Order";
    expect(readSummary(text)).toEqual({ subtotalCents: 1685, feesCents: 499, taxCents: 145, tipCents: 253, totalCents: 2582 });
    // The combined line DoorDash shows on some layouts: fees and tax in one amount.
    expect(readSummary("Subtotal $16.85\nFees & Estimated Tax $6.44\nDasher Tip $2.53\nTotal $25.82")).toEqual({ subtotalCents: 1685, feesCents: 644, taxCents: 0, tipCents: 253, totalCents: 2582 });
    expect(readSummary("Subtotal $16.85").totalCents).toBeNull();
  });

  it("checks the cart holds exactly the quoted items", () => {
    const lines = cartLines("1x Burrito Bowl\n$11.95\n2 × Chips $4.90\nSubtotal $16.85");
    expect(lines).toEqual([{ quantity: 1, name: "Burrito Bowl" }, { quantity: 2, name: "Chips" }]);
    expect(cartMatches(lines, [{ name: "Chips", quantity: 2 }, { name: "Burrito Bowl", quantity: 1 }])).toBe(true);
    expect(cartMatches(lines, [{ name: "Burrito Bowl", quantity: 1 }])).toBe(false);
    expect(cartMatches(lines, [{ name: "Burrito Bowl", quantity: 1 }, { name: "Chips", quantity: 1 }])).toBe(false);
    expect(cartCount("Cart, 3 items")).toBe(3);
    expect(cartCount("0")).toBe(0);
    expect(cartCount("Your cart is empty")).toBe(0);
    expect(cartCount("Cart")).toBeNull();
  });

  it("matches the delivery address, spots walls and reads the order page", () => {
    expect(addressMatches("Deliver to 1 Market St, San Francisco", "1 Market St Apt 5, San Francisco, CA 94105")).toBe(true);
    expect(addressMatches("Deliver to 10 Market St", "1 Market St Apt 5")).toBe(false);
    expect(addressMatches("Deliver to 21 Market St", "1 Market St Apt 5")).toBe(false);
    expect(detectBlock("https://www.doordash.com/", "<title>Just a moment...</title>")).toBe("captcha");
    expect(detectBlock("https://identity.doordash.com/auth?client_id=1", "")).toBe("signin");
    expect(detectBlock("https://www.doordash.com/consumer/login/", "")).toBe("signin");
    expect(detectBlock("https://www.doordash.com/", "<title>DoorDash</title>")).toBeUndefined();
    expect(signedIn("Sign In\nSign Up")).toBe(false);
    expect(signedIn("1 Market St\nCart 0")).toBe(true);
    expect(orderPlacedText("Thanks for your order, Matt!")).toBe(true);
    expect(orderPlacedText("Checkout")).toBe(false);
  });

  it("checks order lines and summarises them", () => {
    expect(checkLines([{ itemId: "1", quantity: 1 }, { itemId: "1", quantity: 2 }, { itemId: "2", quantity: 1 }])).toEqual([{ itemId: "1", quantity: 3 }, { itemId: "2", quantity: 1 }]);
    expect(() => checkLines([])).toThrow("the order has no items");
    expect(() => checkLines([{ itemId: "1", quantity: 0 }])).toThrow("quantity must be 1 to 10");
    expect(() => checkLines([{ itemId: "1", quantity: 6 }, { itemId: "1", quantity: 6 }])).toThrow("quantity must be 1 to 10");
    expect(itemsSummary([{ name: "Burrito  Bowl", quantity: 1 }, { name: "Chips", quantity: 2 }])).toBe("1x Burrito Bowl, 2x Chips");
  });

  it("takes the session as JSON or base64 and refuses anything else", () => {
    const state = JSON.stringify({ cookies: [], origins: [] });
    expect(parseDoorDashState(state)).toEqual({ cookies: [], origins: [] });
    expect(parseDoorDashState(Buffer.from(state).toString("base64"))).toEqual({ cookies: [], origins: [] });
    expect(() => createDoorDashProvider({ storageState: "nope", limitCents: 4000 })).toThrow(/not valid JSON/);
    expect(() => createDoorDashProvider({ storageState: "{}", limitCents: 4000 })).toThrow(/no cookies/);
  });
});

describe("dd-cli replies", () => {
  it("parses JSON defensively: whole output, or the last JSON line after chatter", () => {
    expect(parseJson('{"ok":true}')).toEqual({ ok: true });
    expect(parseJson('Fetching...\n[{"id":1}]\n')).toEqual([{ id: 1 }]);
    expect(parseJson("no json here")).toBeUndefined();
  });

  it("reads money in every shape", () => {
    expect(cliCents({ unit_amount: 1195, currency: "USD" })).toBe(1195);
    expect(cliCents("$11.95")).toBe(1195);
    expect(cliCents("11.95")).toBe(1195);
    expect(cliCents(11.95)).toBe(1195);
    expect(cliCents(1195)).toBe(1195);
    expect(cliCents(null)).toBeNull();
    expect(cliCents(-1)).toBeNull();
  });

  it("reads stores, menus, carts and orders in snake or camel case", () => {
    expect(cliRestaurants({ results: [{ store_id: 123, name: "Sakura Sushi", rating: 4.5, eta_minutes: 40, delivery_fee: { unit_amount: 299 } }, { id: "9", name: "" }] })).toEqual([
      { storeId: "123", name: "Sakura Sushi", url: "https://www.doordash.com/store/123/", rating: "4.5", etaMinutes: 40, deliveryFeeCents: 299 },
    ]);
    expect(cliRestaurants([{ storeId: "7", storeName: "Joe's", eta: "25-35 min" }])).toEqual([{ storeId: "7", name: "Joe's", url: "https://www.doordash.com/store/7/", etaMinutes: 35 }]);
    expect(cliMenu({ categories: [{ name: "Rolls", items: [{ id: "1", name: "California Roll", price: "$8.95" }, { id: "2", name: "No price" }] }] })).toEqual([{ itemId: "1", name: "California Roll", priceCents: 895, section: "Rolls" }]);
    expect(cliMenu({ items: [{ itemId: "5", name: "Edamame", unitPrice: 5.95 }] })).toEqual([{ itemId: "5", name: "Edamame", priceCents: 595 }]);
    expect(
      cliCart({ cart: { store: { id: "123", name: "Sakura Sushi" }, items: [{ item_id: "1", name: "California Roll", quantity: 2, unit_price: 895 }], subtotal: 1790, delivery_fee: 299, service_fee: 300, tax: 154, tip: 269, total: 2812, eta: "40 min" } }),
    ).toEqual({ storeId: "123", restaurant: "Sakura Sushi", items: [{ itemId: "1", name: "California Roll", quantity: 2, unitCents: 895 }], subtotalCents: 1790, feesCents: 599, taxCents: 154, tipCents: 269, totalCents: 2812, etaMinutes: 40, carts: 1 });
    expect(cliCart({ carts: [{}, {}] }).carts).toBe(2);
    expect(cliOrder({ order: { order_uuid: "abc-123", eta_minutes: 38 } })).toEqual({ orderId: "abc-123", etaMinutes: 38 });
    expect(cliOrder({ message: "done" })).toBeUndefined();
  });
});

describe("the dd-cli adapter over a fake binary", () => {
  /** A dd-cli that keeps a cart in memory and answers in the announced style. */
  function fakeCli(options: { checkout?: CliResult; startWith?: { item_id: string; quantity: number }[] } = {}) {
    const calls: string[][] = [];
    const menu = [{ id: "1", name: "California Roll", price: 895 }, { id: "2", name: "Miso Soup", price: 395 }];
    let cart: { item_id: string; quantity: number }[] = [...(options.startWith ?? [])];
    let tip = 0;
    const ok = (v: unknown): CliResult => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
    const run = async (args: readonly string[]): Promise<CliResult> => {
      calls.push([...args]);
      const key = args.slice(0, 2).join(" ");
      if (key === "store menu") return ok({ items: menu });
      if (key === "address set") return ok({ ok: true });
      if (key === "cart add") {
        cart.push({ item_id: args[args.indexOf("--item-id") + 1]!, quantity: Number(args[args.indexOf("--quantity") + 1]) });
        return ok({ ok: true });
      }
      if (key === "cart tip") {
        tip = Math.round(Number(args[args.indexOf("--amount") + 1]) * 100);
        return ok({ ok: true });
      }
      if (key === "cart clear") {
        cart = [];
        return ok({ ok: true });
      }
      if (key === "cart show") {
        const items = cart.map((c) => ({ ...c, name: menu.find((m) => m.id === c.item_id)!.name, unit_price: menu.find((m) => m.id === c.item_id)!.price }));
        const subtotal = items.reduce((s, i) => s + i.unit_price * i.quantity, 0);
        return ok({ cart: { store_id: "123", store_name: "Sakura Sushi", items, subtotal, delivery_fee: 299, service_fee: 300, tax: 100, tip, total: subtotal + 699 + tip, eta_minutes: 40 } });
      }
      if (key === "checkout --confirm") return options.checkout ?? ok({ order: { id: "dd-order-1", eta_minutes: 42 } });
      return { code: 2, stdout: "", stderr: `unknown command ${args.join(" ")}` };
    };
    return { run, calls, cart: () => cart };
  }
  const order = { storeId: "123", items: [{ itemId: "1", quantity: 2 }], address: "1 Market St, San Francisco", tipPercent: 15 };

  it("quotes exactly the asked items, empties its own cart, and orders once", async () => {
    const cli = fakeCli();
    const dd = createDoorDashCli({ limitCents: 4000, run: cli.run });
    const quote = await dd.quote(order);
    expect(quote).toMatchObject({ restaurant: "Sakura Sushi", subtotalCents: 1790, feesCents: 599, taxCents: 100, tipCents: 269, totalCents: 2758, etaMinutes: 40 });
    expect(cli.cart()).toEqual([]);
    expect(cli.calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["store menu", "cart show", "address set", "cart add", "cart tip", "cart show", "cart clear"]);
    expect(cli.calls).toContainEqual(DD_CLI.cartAdd("1", 2));
    const outcome = await dd.confirm(quote);
    expect(outcome).toEqual({ status: "ordered", orderId: "dd-order-1", totalCents: 2758, etaMinutes: 42 });
    expect(cli.calls.filter((c) => c[0] === "checkout")).toHaveLength(1);
  });

  it("stops on a cart it did not fill, and leaves that cart alone", async () => {
    const cli = fakeCli({ startWith: [{ item_id: "2", quantity: 1 }] });
    const dd = createDoorDashCli({ limitCents: 4000, run: cli.run });
    await expect(dd.quote(order)).rejects.toThrow("the DoorDash cart already holds something");
    expect(cli.cart()).toEqual([{ item_id: "2", quantity: 1 }]);
    expect(await dd.confirm({ ...(await createDoorDashCli({ limitCents: 4000, run: fakeCli().run }).quote(order)) })).toEqual({ status: "no_purchase", reason: "the DoorDash cart already holds something, so I stopped; the operator must empty it" });
    expect(cli.calls.some((c) => c[0] === "checkout" || (c[0] === "cart" && c[1] === "clear"))).toBe(false);
  });

  it("dry run, a changed price and the limit are certain no-purchases; a failed checkout is uncertain", async () => {
    const quote = await createDoorDashCli({ limitCents: 4000, run: fakeCli().run }).quote(order);
    const dry = fakeCli();
    expect(await createDoorDashCli({ limitCents: 4000, dryRun: true, run: dry.run }).confirm(quote)).toEqual({ status: "no_purchase", reason: "dry run" });
    expect(dry.calls.some((c) => c[0] === "checkout")).toBe(false);
    expect(await createDoorDashCli({ limitCents: 4000, run: fakeCli().run }).confirm({ ...quote, totalCents: quote.totalCents - 1 })).toEqual({ status: "no_purchase", reason: "price changed" });
    expect(await createDoorDashCli({ limitCents: 2000, run: fakeCli().run }).confirm(quote)).toEqual({ status: "no_purchase", reason: "over the limit" });
    const failed = fakeCli({ checkout: { code: 1, stdout: "", stderr: "payment declined?" } });
    expect(await createDoorDashCli({ limitCents: 4000, run: failed.run }).confirm(quote)).toEqual({ status: "uncertain", reason: "dd-cli checkout exited 1" });
    expect(failed.cart()).not.toEqual([]); // never touched after the checkout ran
  });
});
