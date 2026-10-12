/** Ordering food on DoorDash with USDC: the demo DoorDash, a treasury wallet, fake Ledgers running the Ethereum app, and a stubbed Base. */
import { parseEther, Transaction, Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { newActionId } from "../src/actions.js";
import { erc20TransferData, USDC } from "../src/chain.js";
import { openDb } from "../src/db.js";
import { DEMO_RESTAURANTS, demoDoorDash } from "../src/food/demo.js";
import { createFood, type Food, shortAddress } from "../src/food/food.js";
import type { FoodQuote } from "../src/food/provider.js";
import type { Outcome } from "../src/merchant.js";
import { baseMoney } from "../src/money.js";
import { createPurchases, type Purchases } from "../src/purchases.js";
import { demoMerchant } from "../src/merchant.js";
import { createTreasury } from "../src/treasury.js";
import type { CompleteRequest } from "../src/agent/xai.js";
import { call, delegate, fakeChannel, fakeEthDevices, harness, isEngine, PHONES, say, stubChain } from "./helpers.js";

const matt = new Wallet(Wallet.createRandom().privateKey);
const vault = new Wallet(Wallet.createRandom().privateKey);
const addr = (w: Wallet) => w.address.toLowerCase();
const OPERATOR = "+14155550099";
const HOME = "1 Market St Apt 5, San Francisco, CA 94105";
const CHIPOTLE = DEMO_RESTAURANTS[0]!;
const BOWL = CHIPOTLE.menu[0]!; // $11.95
const CHIPS = CHIPOTLE.menu[4]!; // $2.45
// 1x Burrito Bowl + 2x Chips: food $16.85, delivery $1.99 + service $3.00 (the minimum), tax 8.625% $1.45, tip 15% $2.53.
const TOTAL = "$25.82";
const UNITS = 25_820_000n;

/** The whole app in Ethereum mode with one owner (@matt), the demo DoorDash and a funded treasury. */
async function setup(options: { address?: string | null; receipt?: "confirmed" | "failed" | "timeout"; onConfirm?: (q: FoodQuote) => Outcome | undefined } = {}) {
  const { chain, sent } = stubChain({ [addr(matt)]: parseEther("0.05"), [addr(vault)]: parseEther("0.01") }, 4000, { [addr(matt)]: 50_000_000n, [addr(vault)]: 30_000_000n });
  if (options.receipt) chain.waitForReceipt = async () => options.receipt!;
  const devices = fakeEthDevices([matt]);
  const money = baseMoney(chain);
  const provider = demoDoorDash(undefined, { onConfirm: options.onConfirm });
  const treasury = createTreasury({ privateKey: vault.privateKey }, chain);
  let food!: Food;
  const h = harness(0, undefined, {
    money,
    deviceManager: devices.manager,
    food: (ctx) => (food = createFood({ ...ctx, provider, treasury, money, operator: { name: "Matt", handle: () => OPERATOR } })),
  });
  await h.send(PHONES.matt, "@matt");
  const owner = h.db.accountByTag("@matt")!;
  if (options.address !== null) h.db.setDeliveryAddress(owner.id, options.address ?? HOME);
  return { ...h, sent, devices, provider, treasury, food, owner, chain };
}

const last = (req: CompleteRequest) => String(req.messages.at(-1)!.content);

/** The engine's usual path: search, menu, quote one bowl and two chips, then EAT with the quote id. */
function orderScript(check: { search?: (json: string) => void; quote?: (json: string) => void; beforePropose?: () => void } = {}) {
  let quoteId = "";
  return [
    delegate("order a burrito bowl and two chips from chipotle"),
    (req: CompleteRequest) => {
      expect(isEngine(req)).toBe(true);
      return call("search_doordash", { query: "chipotle" });
    },
    (req: CompleteRequest) => {
      check.search?.(last(req));
      const out = JSON.parse(last(req)) as { results: { store_id: string }[] };
      return call("doordash_menu", { store_id: out.results[0]!.store_id });
    },
    (req: CompleteRequest) => {
      const menu = JSON.parse(last(req)) as { items: { item_id: string; name: string }[] };
      const id = (name: string) => menu.items.find((i) => i.name === name)!.item_id;
      return call("quote_doordash", { store_id: CHIPOTLE.storeId, items: [{ item_id: id("Burrito Bowl"), quantity: 1 }, { item_id: id("Chips"), quantity: 2 }] });
    },
    (req: CompleteRequest) => {
      check.quote?.(last(req));
      quoteId = (JSON.parse(last(req)) as { quote_id: string }).quote_id;
      check.beforePropose?.();
      return call("propose_action", { code: "EAT", fields: [{ label: "Order", value: quoteId }] });
    },
    say("Burrito bowl and two chips from Chipotle, coming up."),
  ];
}

describe("ordering food on DoorDash with USDC", () => {
  it("searches, quotes, pays the treasury from the Ledger, waits for Base, orders, and texts each step once", async () => {
    const h = await setup({ address: null });
    h.script(
      delegate("order a burrito bowl and two chips from chipotle", `deliver to ${HOME}`),
      (req) => {
        expect(req.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["set_delivery_address", "search_doordash", "doordash_menu", "quote_doordash", "list_purchases", "propose_action"]));
        expect(req.tools.map((t) => t.name)).not.toContain("search_amazon");
        expect(req.system).toContain("DoorDash: @matt can order food delivered through you, up to $40.00 per order all in (food, fees, tax and tip), paid in USDC on Base");
        expect(req.system).toContain("Delivery address: none saved yet; ask for it before searching.");
        expect(req.system).toContain("Amazon: not available on this server");
        return call("set_delivery_address", { address: HOME });
      },
      ...orderScript({
        search: (json) => {
          const out = JSON.parse(json) as { deliver_to: string; limit: string; results: { store_id: string; name: string; eta: string; delivery_fee: string }[] };
          expect(out.deliver_to).toBe(HOME);
          expect(out.limit).toBe("$40.00 per order, all in (food, fees, tax and tip)");
          expect(out.results[0]).toMatchObject({ store_id: CHIPOTLE.storeId, name: "Chipotle Mexican Grill", eta: "about 25 minutes", delivery_fee: "$1.99" });
        },
        quote: (json) => {
          expect(JSON.parse(json)).toMatchObject({
            restaurant: "Chipotle Mexican Grill",
            items: ["1x Burrito Bowl at $11.95", "2x Chips at $2.45"],
            subtotal: "$16.85",
            fees: "$4.99",
            tax: "$1.45",
            tip: "$2.53 (15%)",
            total: `${TOTAL} all in`,
            deliver_to: HOME,
            eta: "about 25 minutes",
            quote_id: expect.stringMatching(/^q[0-9a-f]{6}$/),
          });
        },
      }).slice(1),
    );
    await h.send(PHONES.matt, `deliver me a burrito bowl and two chips from chipotle to ${HOME}`);
    expect(h.db.account(h.owner.id)!.delivery_address).toBe(HOME);

    // The Ledger saw a USDC transfer of the all-in total to the treasury.
    expect(h.sent).toHaveLength(1);
    const tx = Transaction.from(h.sent[0]!);
    expect([tx.from, tx.to, tx.value, tx.data]).toEqual([matt.address, USDC.address, 0n, erc20TransferData(h.treasury.address, UNITS)]);
    const action = h.db.action((h.db.raw.prepare("select id from actions where code = 'EAT'").get() as { id: string }).id)!;
    expect(action.fields).toEqual([
      { label: "From", value: "Chipotle Mexican Grill" },
      { label: "Order", value: "1x Burrito Bowl, 2x Chips" },
      { label: "Deliver", value: "1 Market St Apt 5, San Francisco" },
      { label: "Total", value: TOTAL },
      { label: "USDC", value: "25.82" },
      { label: "To", value: h.treasury.address },
    ]);
    expect([action.status, action.tx_hash]).toEqual(["executed", tx.hash]);

    const purchase = h.db.purchase(action.id)!;
    expect(purchase).toMatchObject({ code: "EAT", status: "ordered", total_cents: 2582, wei: "25820000", asset: "USDC", fund_tx_hash: tx.hash, buyer: addr(matt) });
    expect(h.provider.confirmed.map((q) => q.items.map((i) => `${i.quantity}x ${i.itemId}`))).toEqual([[`1x ${BOWL.itemId}`, `2x ${CHIPS.itemId}`]]);

    const link = `https://basescan.org/tx/${tx.hash}`;
    expect(h.to(PHONES.matt).slice(-3)).toEqual([
      `Burrito bowl and two chips from Chipotle, coming up.\n\nPlease confirm on your Ledger: Order food on DoorDash: Chipotle Mexican Grill, 1x Burrito Bowl, 2x Chips, ${TOTAL} all in, delivered to ${HOME} in about 25 minutes. That is 25.82 USDC to the AgentSign treasury ${h.treasury.address}; it comes back to you if the order doesn't go through.`,
      `Paid 25.82 USDC (${TOTAL}) to the treasury on Base for 1x Burrito Bowl, 2x Chips from Chipotle Mexican Grill. I'll place the DoorDash order as soon as Base confirms it. ${link}`,
      `Order placed on DoorDash: Chipotle Mexican Grill, 1x Burrito Bowl, 2x Chips. Order ${purchase.order_id}, paid 25.82 USDC (${TOTAL}). It arrives at ${HOME} in about 25 minutes.`,
    ]);
    expect(h.to(PHONES.matt).some((t) => t.startsWith("Confirmed on Base"))).toBe(false);
    expect(h.to(OPERATOR)).toEqual([]);
    const notes = h.db.recentMessages(h.owner.id).filter((m) => m.role === "system").map((m) => (m.content as { content: string }).content);
    expect(notes.at(-1)).toBe(`DoorDash order Chipotle Mexican Grill: 1x Burrito Bowl, 2x Chips (${TOTAL}): ordered on DoorDash, order ${purchase.order_id}, arriving in about 25 minutes.`);

    // The next turn can list it.
    h.script(
      delegate("did my food order go through"),
      () => call("list_purchases", {}),
      (req) => {
        expect(JSON.parse(last(req))).toEqual([expect.objectContaining({ store: "DoorDash", item: "Chipotle Mexican Grill: 1x Burrito Bowl, 2x Chips", total: TOTAL, paid: "25.82 USDC", status: "ordered", order: purchase.order_id, payment: link })]);
        return say("Ordered, arriving in about 25 minutes.");
      },
      say("Yep, it's ordered. About 25 minutes."),
    );
    await h.send(PHONES.matt, "did my food order go through?");
    expect(h.to(PHONES.matt).at(-1)).toBe("Yep, it's ordered. About 25 minutes.");
  });

  it("refuses an order over the limit, at the quote and again when the price rose before the Ledger", async () => {
    const h = await setup();
    const pies = DEMO_RESTAURANTS[2]!; // Joe's Pizza
    h.script(
      delegate("two large pepperoni pies from joe's"),
      () => call("quote_doordash", { store_id: pies.storeId, items: [{ item_id: pies.menu[3]!.itemId, quantity: 2 }] }),
      (req) => {
        expect(last(req)).toMatch(/^Error: that order comes to \$\d+\.\d{2} all in \(food \$61\.00 plus fees, tax and tip\), over the \$40\.00 limit\. Tell the owner; offer fewer items\. Do not propose it\.$/);
        return say("Two pies are over the $40 limit.");
      },
      say("Two large pies come to more than the $40 limit. One?"),
    );
    await h.send(PHONES.matt, "two large pepperoni pies from joe's");
    expect(h.sent).toHaveLength(0);

    // Quoted under the limit, then the bowl's price jumped: the re-price at propose refuses it before the Ledger.
    h.script(
      ...orderScript({ beforePropose: () => void (h.provider.restaurants[0]!.menu[0]!.priceCents = 3_500) }).slice(0, 5),
      (req) => {
        expect(last(req)).toMatch(/^Error: that order comes to \$\d+\.\d{2} all in \(food \$39\.90 plus fees, tax and tip\), over the \$40\.00 limit\. Tell the owner; do not propose it\.$/);
        return say("The price went up past the limit.");
      },
      say("Chipotle's prices just jumped past your $40 limit."),
    );
    await h.send(PHONES.matt, "burrito bowl and two chips from chipotle");
    expect(h.sent).toHaveLength(0);
    expect(h.db.raw.prepare("select count(*) as n from purchases").get()).toEqual({ n: 0 });
  });

  it("asks for an address before searching when none is saved", async () => {
    const h = await setup({ address: null });
    h.script(
      delegate("get me sushi"),
      () => call("search_doordash", { query: "sushi" }),
      (req) => {
        expect(last(req)).toBe("Error: there is no delivery address. Ask the owner where to deliver; when they give their own address, save it with set_delivery_address.");
        return call("quote_doordash", { store_id: "1000404", items: [{ item_id: "2000401", quantity: 1 }] });
      },
      (req) => {
        expect(last(req)).toMatch(/^Error: there is no delivery address/);
        return say("I need a delivery address.");
      },
      say("Where should it go?"),
    );
    await h.send(PHONES.matt, "get me sushi");
    expect(h.to(PHONES.matt).at(-1)).toBe("Where should it go?");
  });

  it("a rejected EAT cancels the order and moves nothing", async () => {
    const h = await setup();
    h.devices.options[0]!.reject = true;
    h.script(...orderScript());
    await h.send(PHONES.matt, "burrito bowl and two chips from chipotle");
    expect(h.sent).toHaveLength(0);
    expect(h.db.purchasesIn(["cancelled"], "EAT")[0]!.error).toBe("the action was rejected");
    expect(h.provider.confirmed).toEqual([]);
    expect(h.to(PHONES.matt).at(-1)).toBe("You rejected it on your Ledger, so nothing happened.");
  });

  it("a definite no-purchase refunds the owner from the treasury", async () => {
    const h = await setup({ onConfirm: () => ({ status: "no_purchase", reason: "the restaurant is closed" }) });
    h.script(...orderScript());
    await h.send(PHONES.matt, "burrito bowl and two chips from chipotle");
    expect(h.sent).toHaveLength(2);
    const refund = Transaction.from(h.sent[1]!);
    expect([refund.from, refund.to, refund.value, refund.data]).toEqual([vault.address, USDC.address, 0n, erc20TransferData(matt.address, UNITS)]);
    expect(h.db.purchasesIn(["refunded"], "EAT")[0]!.refund_tx_hash).toBe(refund.hash);
    expect(h.to(PHONES.matt).at(-1)).toBe(`DoorDash didn't take the order (the restaurant is closed), so nothing was charged. Your 25.82 USDC (${TOTAL}) is on its way back: https://basescan.org/tx/${refund.hash}`);
    expect(h.to(OPERATOR)).toEqual([]);
  });

  it("a price change between the Ledger and the order is a no-purchase too", async () => {
    const h = await setup();
    h.script(...orderScript());
    // Base confirms after the menu changed: confirm prices it again and refuses.
    h.chain.waitForReceipt = async () => {
      h.provider.restaurants[0]!.menu[4]!.priceCents = 295;
      return "confirmed";
    };
    await h.send(PHONES.matt, "burrito bowl and two chips from chipotle");
    expect(h.db.purchasesIn(["refunded"], "EAT")[0]!.error).toBe("price changed");
    expect(h.provider.confirmed).toEqual([]);
  });

  it("an uncertain outcome is never refunded: the operator and the owner both hear it needs a look", async () => {
    const h = await setup({ onConfirm: () => ({ status: "uncertain", reason: "no order page after Place Order" }) });
    h.script(...orderScript());
    await h.send(PHONES.matt, "burrito bowl and two chips from chipotle");
    expect(h.sent).toHaveLength(1);
    expect(h.db.purchasesIn(["review"], "EAT")[0]!.error).toBe("no order page after Place Order");
    expect(h.to(PHONES.matt).at(-1)).toBe("I couldn't tell whether DoorDash took the order (no order page after Place Order). Nothing more is charged; Matt is checking and you'll hear back.");
    expect(h.to(OPERATOR)).toEqual([expect.stringMatching(/^Purchase [0-9a-f]{8} for @matt needs you: no order page after Place Order\. Item Chipotle Mexican Grill: 1x Burrito Bowl, 2x Chips, paid 25\.82 USDC/)]);
  });

  it("a quote belongs to the owner who asked for it, and an unknown quote id is refused", async () => {
    const h = await setup();
    const other = h.db.createAccount("@gabriel", "0x" + "11".repeat(20), PHONES.gabriel, 0);
    const quote = JSON.parse(await h.food.quote(h.owner, { storeId: CHIPOTLE.storeId, items: [{ itemId: BOWL.itemId, quantity: 1 }] })) as { quote_id: string };
    expect(await h.food.propose(other, quote.quote_id)).toBe(`Error: there is no quote ${quote.quote_id} for @gabriel. Quote the order with quote_doordash first.`);
    expect(await h.food.propose(h.owner, "q000000")).toBe("Error: The quote q000000 expired or does not exist; quote the order again with quote_doordash. Tell the owner; do not propose it.");
    expect(await h.food.propose(h.owner, "B0DEMO0001")).toBe("Error: Order must be the quote_id from quote_doordash, like q1a2b3c. Quote the order first.");
    expect(h.food.setAddress(h.owner, "my place")).toMatch(/^Error: that does not look like a street address/);
  });

  it("is not offered where food is not set up, and demo money cannot order food", async () => {
    for (const withFood of [false, true]) {
      const { chain } = stubChain({});
      const h = harness(1, undefined, withFood ? { food: (ctx) => createFood({ ...ctx, provider: demoDoorDash(), treasury: createTreasury({ address: vault.address }, chain), money: baseMoney(chain) }) } : {});
      await h.onboard("matt", 0);
      h.script(
        delegate("order food"),
        (req) => {
          expect(req.tools.map((t) => t.name)).not.toContain("search_doordash");
          expect(req.tools.map((t) => t.name)).not.toContain("list_purchases");
          expect(req.system).toContain("DoorDash: not available on this server, so no food can be ordered.");
          return call("propose_action", { code: "EAT", fields: { Order: "q123abc" } });
        },
        (req) => {
          expect(last(req)).toBe("Error: ordering food is not available on this server. Tell the owner it cannot be done here.");
          return say("Not available here.");
        },
        say("I can't order food here, sorry."),
      );
      await h.send(PHONES.matt, "order me food");
      expect(h.to(PHONES.matt).at(-1)).toBe("I can't order food here, sorry.");
    }
  });

  it("shortens the delivery address for the Ledger", () => {
    expect(shortAddress(HOME)).toBe("1 Market St Apt 5, San Francisco");
    expect(shortAddress("1600 Amphitheatre Parkway Building 40 Floor 2, Mountain View, CA")).toBe("1600 Amphitheatre Parkway Building 40 Floor 2");
    expect(shortAddress("221B Baker Street")).toBe("221B Baker Street");
  });
});

describe("food order recovery after a restart", () => {
  it("finishes a funded order, flags one mid-order or mid-refund, drops stale proposals, and leaves Amazon's rows alone", async () => {
    const db = openDb(":memory:");
    const owner = db.createAccount("@matt", addr(matt), PHONES.matt, 0);
    const { chain, sent: broadcasts } = stubChain({ [addr(vault)]: parseEther("0.01") });
    const provider = demoDoorDash();
    const ch = fakeChannel();
    const treasury = createTreasury({ privateKey: vault.privateKey }, chain);
    const operator = { name: "Matt", handle: () => OPERATOR };
    const food = createFood({ db, provider, treasury, money: baseMoney(chain), channel: ch.channel, operator });
    const amazon: Purchases = createPurchases({ db, merchant: demoMerchant(), treasury, money: baseMoney(chain), channel: ch.channel, operator });
    const fq = { ...(await provider.quote({ storeId: CHIPOTLE.storeId, items: [{ itemId: BOWL.itemId, quantity: 1 }], address: HOME, tipPercent: 15 })) };
    const quote = { quoteId: fq.quoteId, asin: "q0a0a0a", title: "Chipotle Mexican Grill: 1x Burrito Bowl", itemCents: fq.subtotalCents, totalCents: fq.totalCents, expiresAt: fq.expiresAt, food: fq };
    const row = (code: "BUY" | "EAT", status: "funded" | "ordering" | "refunding" | "proposed", i: number) => {
      const id = newActionId();
      db.insertAction(owner.id, { code, id, fields: [{ label: "Order", value: "x" }] });
      db.insertPurchase({ action_id: id, code, account_id: owner.id, asin: quote.asin, title: quote.title, quote: JSON.stringify(quote), total_cents: fq.totalCents, wei: String(fq.totalCents * 10_000), asset: "USDC", treasury: vault.address, buyer: addr(matt) });
      if (status !== "proposed") db.setPurchaseStatus(id, status, { fundTxHash: `0x${String(i).padStart(64, "0")}` });
      return id;
    };
    const ids = [row("EAT", "funded", 1), row("EAT", "ordering", 2), row("EAT", "refunding", 3), row("EAT", "proposed", 4)];
    const amazonRow = row("BUY", "ordering", 5);
    food.resume();
    await food.whenIdle();
    expect(ids.map((id) => db.purchase(id)!.status)).toEqual(["ordered", "review", "review", "cancelled"]);
    expect(db.purchase(amazonRow)!.status).toBe("ordering"); // Amazon's own resume handles it, not food's
    expect(provider.confirmed).toHaveLength(1);
    expect(broadcasts).toEqual([]);
    expect(ch.to(OPERATOR)).toEqual([
      expect.stringContaining("needs you: the server restarted while the order was in progress"),
      expect.stringContaining("needs you: the server restarted while the refund was in progress"),
    ]);
    expect(ch.to(PHONES.matt)[0]).toMatch(/^Order placed on DoorDash: Chipotle Mexican Grill, 1x Burrito Bowl\. Order [0-9A-F]{8}, paid/);
    expect(food.list(owner.id)).toHaveLength(4);
    expect(amazon.list(owner.id)).toHaveLength(1);
  });
});
