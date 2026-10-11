/** Buying on Amazon with ETH: the demo store, a treasury wallet, fake Ledgers running the Ethereum app, and a stubbed Base. */
import { parseEther, Transaction, Wallet } from "ethers";
import { erc20TransferData, USDC } from "../src/chain.js";
import { describe, expect, it } from "vitest";
import { newActionId } from "../src/actions.js";
import { openDb } from "../src/db.js";
import { signOnEthApp, verifyEthSignature } from "../src/device/eth.js";
import { alwaysOrderedMerchant, DEMO_CATALOG, demoMerchant, type DemoItem, type Outcome } from "../src/merchant.js";
import { baseMoney } from "../src/money.js";
import { createPurchases, type Purchases } from "../src/purchases.js";
import { createTreasury } from "../src/treasury.js";
import type { Action } from "../src/types.js";
import { call, delegate, FAKE_USDC_DESCRIPTOR, fakeChannel, fakeEthApp, fakeEthDevices, harness, isEngine, PHONES, say, stubChain } from "./helpers.js";

const matt = new Wallet(Wallet.createRandom().privateKey);
const vault = new Wallet(Wallet.createRandom().privateKey);
const addr = (w: Wallet) => w.address.toLowerCase();
const OPERATOR = "+14155550099";
const GUM = DEMO_CATALOG[0]!; // $3.99, $4.35 all in
const MOUSE = DEMO_CATALOG[3]!; // $99.99

/** The whole app in Ethereum mode with one buyer (@matt), the demo store and a funded treasury. */
async function setup(options: { catalog?: DemoItem[]; treasuryEth?: string; mattUsdc?: bigint; receipt?: "confirmed" | "failed" | "timeout"; onConfirm?: (q: { asin: string }) => Outcome | undefined } = {}) {
  const { chain, sent } = stubChain(
    { [addr(matt)]: parseEther("0.05"), [addr(vault)]: parseEther(options.treasuryEth ?? "0.01") },
    4000,
    { [addr(matt)]: options.mattUsdc ?? 50_000_000n, [addr(vault)]: 10_000_000n },
  );
  if (options.receipt) chain.waitForReceipt = async () => options.receipt!;
  const devices = fakeEthDevices([matt]);
  const money = baseMoney(chain);
  const merchant = demoMerchant(options.catalog ?? DEMO_CATALOG, { onConfirm: options.onConfirm });
  const treasury = createTreasury({ privateKey: vault.privateKey }, chain);
  let purchases!: Purchases;
  const h = harness(0, undefined, {
    money,
    deviceManager: devices.manager,
    purchases: (ctx) => (purchases = createPurchases({ ...ctx, merchant, treasury, money, limitCents: 2_000, shipsTo: "Matt's address", operator: { name: "Matt", handle: () => OPERATOR } })),
  });
  await h.send(PHONES.matt, "@matt");
  const owner = h.db.accountByTag("@matt")!;
  return { ...h, sent, devices, merchant, treasury, purchases, owner, chain };
}

/** The engine's usual path: search, then BUY with the first result's id. */
const buyScript = (asin: string, afterSearch?: (json: string) => void) => [
  delegate("buy gum"),
  (req: Parameters<typeof isEngine>[0]) => {
    expect(isEngine(req)).toBe(true);
    expect(req.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["search_amazon", "list_purchases", "propose_action"]));
    expect(req.system).toContain("Amazon: @matt can buy things there through you, up to $20.00 per order all in, paid in USDC on Base");
    expect(req.system).toContain("Balance: 0.05 ETH ($200.00) and 50 USDC on Base.");
    return call("search_amazon", { query: "trident gum" });
  },
  (req: Parameters<typeof isEngine>[0]) => {
    afterSearch?.(String(req.messages.at(-1)!.content));
    return call("propose_action", { code: "BUY", fields: { Item: asin } });
  },
  say("Gum coming right up."),
];

describe("buying on Amazon with ETH", () => {
  it("quotes, caps, pays the treasury from the Ledger, waits for Base, orders, and texts each step once", async () => {
    const h = await setup();
    h.script(
      ...buyScript(GUM.asin, (json) => {
        const out = JSON.parse(json) as { limit: string; ships_to: string; results: { asin: string; price: string }[] };
        expect(out.limit).toBe("$20.00 per order, all in (item, shipping, tax)");
        expect(out.ships_to).toBe("Matt's address");
        expect(out.results[0]).toMatchObject({ asin: GUM.asin, price: "$3.99" });
      }),
    );
    await h.send(PHONES.matt, "buy me some trident gum");

    // The Ledger saw a USDC transfer of the all-in total to the treasury: a call on the token contract, no ETH.
    expect(h.sent).toHaveLength(1);
    const tx = Transaction.from(h.sent[0]!);
    expect([tx.from, tx.to, tx.value, tx.data]).toEqual([matt.address, USDC.address, 0n, erc20TransferData(h.treasury.address, 4_350_000n)]);
    const action = h.db.action((h.db.raw.prepare("select id from actions where code = 'BUY'").get() as { id: string }).id)!;
    expect(action.fields).toEqual([
      { label: "Item", value: "Trident Original Sugar Free Gum, 14 Pieces (P..." },
      { label: "Total", value: "$4.35" },
      { label: "USDC", value: "4.35" },
      { label: "To", value: h.treasury.address },
    ]);
    expect([action.status, action.tx_hash]).toEqual(["executed", tx.hash]);

    const purchase = h.db.purchase(action.id)!;
    expect(purchase).toMatchObject({ status: "ordered", asin: GUM.asin, total_cents: 435, wei: "4350000", asset: "USDC", fund_tx_hash: tx.hash, buyer: addr(matt), treasury: h.treasury.address });
    expect(purchase.order_id).toMatch(/^\d{3}-\d{7}-\d{7}$/);
    expect(h.merchant.confirmed.map((q) => q.asin)).toEqual([GUM.asin]);

    const link = `https://basescan.org/tx/${tx.hash}`;
    expect(h.to(PHONES.matt).slice(-3)).toEqual([
      `Gum coming right up.\n\nPlease confirm on your Ledger: Buy on Amazon: Trident Original Sugar Free Gum, 14 Pieces (P..., $4.35 all in. That is 4.35 USDC to the AgentSign treasury ${h.treasury.address}; it ships to Matt's address, and comes back to you if the order doesn't go through.`,
      `Paid 4.35 USDC ($4.35) to the treasury on Base for Trident Original Sugar Free Gum, 14 Pieces (P.... I'll place the Amazon order as soon as Base confirms it. ${link}`,
      `Order confirmed on Amazon: ${GUM.title}. Order ${purchase.order_id}, paid 4.35 USDC ($4.35). It ships to Matt's address.`,
    ]);
    // No generic "Confirmed on Base" text: the order text is the confirmation.
    expect(h.to(PHONES.matt).some((t) => t.startsWith("Confirmed on Base"))).toBe(false);
    expect(h.to(OPERATOR)).toEqual([]);
    // The next turn knows about it.
    const notes = h.db.recentMessages(h.owner.id).filter((m) => m.role === "system").map((m) => (m.content as { content: string }).content);
    expect(notes.at(-1)).toBe(`Amazon purchase Trident Original Sugar Free Gum, 14 Pieces (P... ($4.35): ordered on Amazon, order ${purchase.order_id}.`);
    expect(h.purchases.list(h.owner.id)).toEqual([expect.objectContaining({ item: GUM.title, total: "$4.35", paid: "4.35 USDC", status: "ordered", order: purchase.order_id, payment: link })]);
  });

  it("refuses anything over the limit before the Ledger is involved", async () => {
    const h = await setup();
    h.script(
      ...buyScript(MOUSE.asin).slice(0, 3),
      (req) => {
        expect(req.messages.at(-1)!.content).toBe("Error: Logitech MX Master 3S Wireless Mouse costs $108.99 all in (item $99.99 plus shipping and tax), over the $20.00 limit. Tell the owner; do not propose it.");
        return say("The mouse is $108.99 all in, over the $20 limit.");
      },
      say("That mouse is over the $20 limit, sorry."),
    );
    await h.send(PHONES.matt, "buy me a logitech mouse");
    expect(h.sent).toHaveLength(0);
    expect(h.db.raw.prepare("select count(*) as n from purchases").get()).toEqual({ n: 0 });
    expect(h.to(PHONES.matt).at(-1)).toBe("That mouse is over the $20 limit, sorry.");
  });

  it("refuses when the owner has no USDC, before the Ledger is involved", async () => {
    const h = await setup({ mattUsdc: 1_000_000n });
    h.script(
      ...buyScript(GUM.asin).slice(0, 3),
      (req) => {
        expect(req.messages.at(-1)!.content).toBe(`Error: not enough USDC on Base. The balance is 1 USDC at ${matt.address}; this needs 4.35 USDC. Tell the owner to send USDC on Base to their address; do not propose it.`);
        return say("Not enough USDC.");
      },
      say("You need 4.35 USDC on Base for that; you have 1."),
    );
    await h.send(PHONES.matt, "buy me gum");
    expect(h.sent).toHaveLength(0);
    expect(h.db.purchasesIn(["proposed", "cancelled"])).toEqual([]);
  });

  it("a rejected BUY cancels the quote and moves nothing", async () => {
    const h = await setup();
    h.devices.options[0]!.reject = true;
    h.script(...buyScript(GUM.asin));
    await h.send(PHONES.matt, "buy me gum");
    expect(h.sent).toHaveLength(0);
    const purchase = h.db.purchasesIn(["cancelled"])[0]!;
    expect(purchase.error).toBe("the action was rejected");
    expect(h.merchant.confirmed).toEqual([]);
    expect(h.to(PHONES.matt).at(-1)).toBe("You rejected it on your Ledger, so nothing happened.");
  });

  it("a definite no-purchase refunds the buyer from the treasury, gas on the treasury", async () => {
    const h = await setup({ onConfirm: () => ({ status: "no_purchase", reason: "price changed" }) });
    h.script(...buyScript(GUM.asin));
    await h.send(PHONES.matt, "buy me gum");
    expect(h.sent).toHaveLength(2);
    const refund = Transaction.from(h.sent[1]!);
    expect([refund.from, refund.to, refund.value, refund.data]).toEqual([vault.address, USDC.address, 0n, erc20TransferData(matt.address, 4_350_000n)]);
    const purchase = h.db.purchasesIn(["refunded"])[0]!;
    expect([purchase.refund_tx_hash, purchase.error, purchase.order_id]).toEqual([refund.hash, "price changed", null]);
    expect(h.to(PHONES.matt).at(-1)).toBe(`Amazon didn't take the order (price changed), so nothing was charged. Your 4.35 USDC ($4.35) is on its way back: https://basescan.org/tx/${refund.hash}`);
    expect(h.to(OPERATOR)).toEqual([]);
  });

  it("an uncertain outcome is never refunded: the operator and the buyer both hear it needs a look", async () => {
    const h = await setup({ onConfirm: () => ({ status: "uncertain", reason: "no confirmation page after the order button" }) });
    h.script(...buyScript(GUM.asin));
    await h.send(PHONES.matt, "buy me gum");
    expect(h.sent).toHaveLength(1);
    const purchase = h.db.purchasesIn(["review"])[0]!;
    expect(purchase.error).toBe("no confirmation page after the order button");
    expect(h.to(PHONES.matt).at(-1)).toBe("I couldn't tell whether Amazon took the order (no confirmation page after the order button). Nothing more is charged; Matt is checking and you'll hear back.");
    expect(h.to(OPERATOR)).toEqual([expect.stringMatching(/^Purchase [0-9a-f]{8} for @matt needs you: no confirmation page after the order button\. Item Trident/)]);
  });

  it("a store error during the order is treated as uncertain too", async () => {
    const h = await setup({
      onConfirm: () => {
        throw new Error("browser crashed");
      },
    });
    h.script(...buyScript(GUM.asin));
    await h.send(PHONES.matt, "buy me gum");
    expect(h.sent).toHaveLength(1);
    expect(h.db.purchasesIn(["review"])[0]!.error).toBe("Amazon did not answer clearly: browser crashed");
    expect(h.to(OPERATOR)).toHaveLength(1);
  });

  it("a refund the treasury cannot pay is flagged, not retried", async () => {
    const h = await setup({ treasuryEth: "0", onConfirm: () => ({ status: "no_purchase", reason: "out of stock" }) });
    h.script(...buyScript(GUM.asin));
    await h.send(PHONES.matt, "buy me gum");
    expect(h.sent).toHaveLength(1);
    const purchase = h.db.purchasesIn(["refund_failed"])[0]!;
    expect(purchase.error).toMatch(/^refund of 4\.35 USDC \(\$4\.35\) to 0x[0-9a-f]{40} failed: the treasury holds 0 wei/);
    expect(h.to(PHONES.matt).at(-1)).toBe("Amazon didn't take the order (out of stock), so nothing was charged, but I couldn't send your 4.35 USDC ($4.35) back automatically. Matt will sort it out.");
    expect(h.to(OPERATOR)).toHaveLength(1);
  });

  it("a payment Base rejects orders nothing and charges nothing", async () => {
    const h = await setup({ receipt: "failed" });
    h.script(...buyScript(GUM.asin));
    await h.send(PHONES.matt, "buy me gum");
    expect(h.merchant.confirmed).toEqual([]);
    expect(h.db.purchasesIn(["cancelled"])[0]!.error).toBe("the payment failed on Base");
    expect(h.to(PHONES.matt).at(-1)).toMatch(/^Base rejected the payment, so nothing was ordered and nothing was charged\. https:\/\/basescan\.org\/tx\//);
  });

  it("a payment that does not confirm in time waits for a person instead of ordering", async () => {
    const h = await setup({ receipt: "timeout" });
    h.script(...buyScript(GUM.asin));
    await h.send(PHONES.matt, "buy me gum");
    expect(h.merchant.confirmed).toEqual([]);
    expect(h.db.purchasesIn(["review"])[0]!.error).toMatch(/^the payment 0x[0-9a-f]{64} did not confirm on Base$/);
    expect(h.to(PHONES.matt).at(-1)).toMatch(/^Base still hasn't confirmed your payment, so I haven't ordered anything\. Matt is keeping an eye on it\./);
  });

  it("BUY is signed as a transfer by the Ethereum app and verified against the transaction", async () => {
    const meta = { to: vault.address, valueWei: "1087500000000000", chainId: 8453, nonce: 7, gasLimit: "21000", maxFeePerGas: "10000000", maxPriorityFeePerGas: "1000000" };
    const buy: Action = { code: "BUY", id: newActionId(), fields: [{ label: "Item", value: "Gum" }, { label: "Total", value: "$4.35" }], meta };
    const result = await signOnEthApp(fakeEthApp(matt), addr(matt), buy);
    if (result.status !== "approved") throw new Error(JSON.stringify(result));
    const tx = Transaction.from(result.signature);
    expect([tx.from, tx.to, tx.value]).toEqual([matt.address, vault.address, 1_087_500_000_000_000n]);
    expect(verifyEthSignature(addr(matt), buy, result.signature)).toBe(true);
    expect(verifyEthSignature(addr(matt), { ...buy, meta: { ...meta, valueWei: "1" } }, result.signature)).toBe(false);
    expect(verifyEthSignature(addr(vault), buy, result.signature)).toBe(false);

    // A USDC transfer: call data on the token contract, no ETH, and Ledger's token descriptor handed to the app.
    const usdcMeta = { ...meta, to: USDC.address, valueWei: "0", data: erc20TransferData(vault.address, 4_350_000n), gasLimit: "60000", resolution: { erc20Tokens: [FAKE_USDC_DESCRIPTOR] } };
    const usdcBuy: Action = { ...buy, id: newActionId(), meta: usdcMeta };
    const resolutions: string[][] = [];
    const app = fakeEthApp(matt);
    const signTx = app.signTransaction.bind(app);
    app.signTransaction = (hex, resolution) => {
      resolutions.push(resolution.erc20Tokens);
      return signTx(hex, resolution);
    };
    const usdcResult = await signOnEthApp(app, addr(matt), usdcBuy);
    if (usdcResult.status !== "approved") throw new Error(JSON.stringify(usdcResult));
    const usdcTx = Transaction.from(usdcResult.signature);
    expect([usdcTx.to, usdcTx.value, usdcTx.data]).toEqual([USDC.address, 0n, usdcMeta.data]);
    expect(resolutions).toEqual([[FAKE_USDC_DESCRIPTOR]]);
    expect(verifyEthSignature(addr(matt), usdcBuy, usdcResult.signature)).toBe(true);
    expect(verifyEthSignature(addr(matt), { ...usdcBuy, meta: { ...usdcMeta, data: erc20TransferData(vault.address, 1n) } }, usdcResult.signature)).toBe(false);
  });

  it("is not offered where buying is not set up, and demo money cannot buy", async () => {
    const h = harness(1);
    await h.onboard("matt", 0);
    h.script(
      delegate("buy gum"),
      (req) => {
        expect(req.tools.map((t) => t.name)).not.toContain("search_amazon");
        expect(req.system).toContain("Amazon: not available on this server, so nothing can be bought.");
        return call("propose_action", { code: "BUY", fields: { Item: "B0DEMO0001" } });
      },
      (req) => {
        expect(req.messages.at(-1)!.content).toBe("Error: buying on Amazon is not available on this server. Tell the owner it cannot be done here.");
        return say("Not available here.");
      },
      say("I can't buy things here, sorry."),
    );
    await h.send(PHONES.matt, "buy me gum");
    expect(h.to(PHONES.matt).at(-1)).toBe("I can't buy things here, sorry.");
  });
});

describe("a store where every order is confirmed, and a treasury without a key", () => {
  it("quotes from the listed price, confirms every order, and cannot refund", async () => {
    const demo = demoMerchant();
    const store = alwaysOrderedMerchant({ search: (q, l) => demo.search(q, l), taxRate: 0.1 });
    const [gum] = await store.search("trident gum", 1);
    const quote = await store.prepare(gum!.asin);
    expect(quote).toMatchObject({ asin: GUM.asin, itemCents: 399, totalCents: 439 });
    const outcome = await store.confirm(quote);
    expect(outcome.status).toBe("ordered");
    if (outcome.status === "ordered") expect(outcome.orderId).toMatch(/^\d{3}-\d{7}-\d{7}$/);
    await expect(store.prepare("B0NOPE0000")).rejects.toThrow("Nothing on Amazon has the item id B0NOPE0000");

    const { chain } = stubChain({});
    const receiveOnly = createTreasury({ address: "0xf8381484CD2639618c690572aB35ff65E4bd7C5e" }, chain);
    expect(receiveOnly.address).toBe("0xf8381484CD2639618c690572aB35ff65E4bd7C5e");
    expect(receiveOnly.canRefund).toBe(false);
    await expect(receiveOnly.refund(matt.address, 1n, "USDC")).rejects.toThrow("has no key on this server");
    expect(() => createTreasury({ address: "nope" }, chain)).toThrow("TREASURY_ADDRESS is not a valid 0x address");
  });
});

describe("purchase recovery after a restart", () => {
  function bare(statusRows: { status: "funded" | "ordering" | "refunding" | "proposed"; hash?: string }[]) {
    const db = openDb(":memory:");
    const owner = db.createAccount("@matt", addr(matt), PHONES.matt, 0);
    const { chain, sent: broadcasts } = stubChain({ [addr(vault)]: parseEther("0.01") });
    const merchant = demoMerchant();
    const ch = fakeChannel();
    const purchases = createPurchases({ db, merchant, treasury: createTreasury({ privateKey: vault.privateKey }, chain), money: baseMoney(chain), channel: ch.channel, operator: { name: "Matt", handle: () => OPERATOR } });
    const quote = { quoteId: "q1", asin: GUM.asin, title: GUM.title, itemCents: 399, totalCents: 435, expiresAt: Date.now() + 60_000 };
    const ids = statusRows.map((row, i) => {
      const id = newActionId();
      db.insertAction(owner.id, { code: "BUY", id, fields: [{ label: "Item", value: "Gum" }] });
      db.insertPurchase({ action_id: id, account_id: owner.id, asin: GUM.asin, title: GUM.title, quote: JSON.stringify(quote), total_cents: 435, wei: "4350000", asset: "USDC", treasury: vault.address, buyer: addr(matt) });
      if (row.status !== "proposed") db.setPurchaseStatus(id, row.status, { fundTxHash: row.hash ?? `0x${String(i).padStart(64, "0")}` });
      return id;
    });
    return { db, purchases, ids, merchant, broadcasts, ...ch };
  }

  it("finishes a funded purchase, flags one that was mid-order or mid-refund, and drops stale proposals", async () => {
    const r = bare([{ status: "funded" }, { status: "ordering" }, { status: "refunding" }, { status: "proposed" }]);
    r.purchases.resume();
    await r.purchases.whenIdle();
    expect(r.ids.map((id) => r.db.purchase(id)!.status)).toEqual(["ordered", "review", "review", "cancelled"]);
    expect(r.merchant.confirmed).toHaveLength(1);
    expect(r.broadcasts).toEqual([]); // nothing refunded on a guess
    expect(r.to(OPERATOR)).toEqual([
      expect.stringContaining("needs you: the server restarted while the order was in progress"),
      expect.stringContaining("needs you: the server restarted while the refund was in progress"),
    ]);
    expect(r.to(PHONES.matt)[0]).toMatch(/^Order confirmed on Amazon: Trident/);
  });
});
