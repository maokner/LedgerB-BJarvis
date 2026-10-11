import { getAddress, parseEther, Transaction, Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { actionMessage, newActionId } from "../src/actions.js";
import { greeting } from "../src/app.js";
import { signOnEthApp, verifyEthSignature } from "../src/device/eth.js";
import { baseMoney, formatEth, usdToWei } from "../src/money.js";
import type { Action } from "../src/types.js";
import { call, delegate, fakeEthApp, fakeEthDevices, harness, PHONES, say, stubChain } from "./helpers.js";

const matt = new Wallet(Wallet.createRandom().privateKey);
const yadu = new Wallet(Wallet.createRandom().privateKey);
const addr = (w: Wallet) => w.address.toLowerCase();
const meta = { to: yadu.address, valueWei: "1250000000000000", chainId: 8453, nonce: 7, gasLimit: "21000", maxFeePerGas: "10000000", maxPriorityFeePerGas: "1000000" };
const pay: Action = { code: "PAY", id: newActionId(), fields: [{ label: "To", value: "@yadu" }], meta };
const cal: Action = { code: "CAL", id: "00112233445566778899aabbccddeeff", fields: [{ label: "Title", value: "Lunch" }, { label: "When", value: "Sun Oct 11 12:00-12:30" }] };

describe("Ethereum app signing", () => {
  it("builds the personal message the device shows", () => {
    expect(actionMessage(cal)).toBe("AgentSign\nAdd to calendar\nTitle: Lunch\nWhen: Sun Oct 11 12:00-12:30\nid: 00112233");
  });

  it("ACC is an address verification on the device", async () => {
    const acc: Action = { code: "ACC", id: newActionId(), fields: [{ label: "Tag", value: "@matt" }] };
    expect(await signOnEthApp(fakeEthApp(matt), addr(matt), acc)).toEqual({ status: "approved", signature: "verified" });
    expect(await signOnEthApp(fakeEthApp(matt, { reject: true }), addr(matt), acc)).toEqual({ status: "rejected" });
    expect((await signOnEthApp(fakeEthApp(yadu), addr(matt), acc)).status).toBe("error");
  });

  it("PAY returns a signed transaction that matches the meta and the sender", async () => {
    const result = await signOnEthApp(fakeEthApp(matt), addr(matt), pay);
    if (result.status !== "approved") throw new Error(JSON.stringify(result));
    const tx = Transaction.from(result.signature);
    expect([tx.from, tx.to, tx.value, tx.chainId, tx.nonce]).toEqual([matt.address, yadu.address, 1_250_000_000_000_000n, 8453n, 7]);
    expect(verifyEthSignature(addr(matt), pay, result.signature)).toBe(true);
    // Wrong sender, tampered value in the meta, or a device that signs something else: all refused.
    expect(verifyEthSignature(addr(yadu), pay, result.signature)).toBe(false);
    expect(verifyEthSignature(addr(matt), { ...pay, meta: { ...meta, valueWei: "1250000000000001" } }, result.signature)).toBe(false);
    expect((await signOnEthApp(fakeEthApp(matt, { tamper: true }), addr(matt), pay)).status).toBe("error");
    expect((await signOnEthApp(fakeEthApp(yadu), addr(matt), pay)).status).toBe("error");
    expect(await signOnEthApp(fakeEthApp(matt, { reject: true }), addr(matt), pay)).toEqual({ status: "rejected" });
  });

  it("CAL, FRQ and FAC are personal messages verified against the address", async () => {
    const result = await signOnEthApp(fakeEthApp(matt), addr(matt), cal);
    if (result.status !== "approved") throw new Error(JSON.stringify(result));
    expect(verifyEthSignature(addr(matt), cal, result.signature)).toBe(true);
    expect(verifyEthSignature(addr(yadu), cal, result.signature)).toBe(false);
    expect(verifyEthSignature(addr(matt), { ...cal, fields: [{ label: "Title", value: "Dinner" }] }, result.signature)).toBe(false);
  });

  it("converts USD to wei at the spot price, rounded to 4 significant digits", () => {
    expect(usdToWei(500, 4000)).toBe(parseEther("0.00125"));
    expect(usdToWei(10, 3954.12)).toBe(parseEther("0.00002529"));
    expect(usdToWei(2340, 2600)).toBe(parseEther("0.009"));
    expect(formatEth(parseEther("0.012345678"))).toBe("0.012345");
  });
});

describe("Ethereum mode end to end (fake Ledgers, stubbed Base)", () => {
  async function setup() {
    const { chain, sent } = stubChain({ [addr(matt)]: parseEther("0.01"), [addr(yadu)]: parseEther("0.002") });
    const devices = fakeEthDevices([matt, yadu]);
    const h = harness(0, undefined, { money: baseMoney(chain), deviceManager: devices.manager });
    devices.plugged.delete(1);
    await h.send(PHONES.matt, "@matt");
    devices.plugged.add(1);
    await h.send(PHONES.yadu, "@yadu");
    return { ...h, sent, devices };
  }

  it("onboards by address verification and reports the address and balance", async () => {
    const h = await setup();
    expect(h.db.accountByTag("@matt")!.pubkey).toBe(addr(matt));
    expect(h.to(PHONES.matt)).toEqual([
      "@matt it is. Your Ledger now shows 'Verify address'. Approve it there and you're set.",
      `You're in: @matt is bound to ${matt.address} with 0.01 ETH ($40.00) on Base.`,
    ]);
    expect(h.db.accountByTag("@yadu")!.pubkey).toBe(addr(yadu));
  });

  it("pays a tag: device signs the transfer, it is broadcast, both are texted with the link", async () => {
    const h = await setup();
    h.script(delegate("send $5 to yadu"), call("propose_action", { code: "PAY", fields: { To: "yadu", Amount: "$5" } }), (req) => {
      expect(req.messages.at(-1)!.content).toContain("Proposed on @matt's Ledger: Send money: To @yadu");
      return say("Set up $5.00 to @yadu.");
    });
    await h.send(PHONES.matt, "send $5 to yadu");
    expect(h.sent).toHaveLength(1);
    const tx = Transaction.from(h.sent[0]!);
    expect([tx.from, tx.to, tx.value, tx.chainId]).toEqual([matt.address, yadu.address, parseEther("0.00125"), 8453n]);
    const link = `https://basescan.org/tx/${tx.hash}`;
    expect(h.to(PHONES.matt)).toEqual(
      expect.arrayContaining([
        `Set up $5.00 to @yadu.\n\nPlease confirm on your Ledger: Send 0.00125 ETH ($5.00) to @yadu ${yadu.address}`,
        `Sent 0.00125 ETH ($5.00) to @yadu on Base. ${link}`,
        `Confirmed on Base: 0.00125 ETH to @yadu. ${link}`,
      ]),
    );
    expect(h.to(PHONES.yadu)).toContain(`@matt sent you 0.00125 ETH ($5.00) on Base. ${link}`);
    const row = h.db.sentPayments(h.db.accountByTag("@matt")!.id)[0]!;
    expect([row.status, row.tx_hash]).toEqual(["executed", tx.hash]);
  });

  it("sends ETH amounts to a raw address (even your own), and refuses what the balance cannot cover", async () => {
    const h = await setup();
    h.script(delegate("send 0.0001 ETH to my address"), call("propose_action", { code: "PAY", fields: { To: matt.address, Amount: "0.0001 ETH" } }), say("Ready."));
    await h.send(PHONES.matt, `send 0.0001 ETH to ${matt.address}`);
    expect(Transaction.from(h.sent[0]!).to).toBe(getAddress(matt.address));
    expect(h.to(PHONES.matt)).toContain(`Ready.\n\nPlease confirm on your Ledger: Send 0.0001 ETH ($0.40) to ${matt.address}`);

    h.script(delegate("send $100 to yadu"), call("propose_action", { code: "PAY", fields: { To: "@yadu", Amount: "$100" } }), (req) => {
      expect(req.messages.at(-1)!.content).toMatch(/^Error: insufficient funds on Base/);
      return say("Insufficient funds on Base for $100.");
    }, say("Not enough ETH."));
    await h.send(PHONES.matt, "send $100 to yadu");
    expect(h.sent).toHaveLength(1);
  });

  it("FRQ is a signed message; a tampering device gets nothing broadcast", async () => {
    const h = await setup();
    h.script(delegate("add yadu"), call("propose_action", { code: "FRQ", fields: { To: "@yadu" } }), say("Ready."));
    await h.send(PHONES.matt, "add yadu");
    expect(h.db.friendship(h.db.accountByTag("@matt")!.id, h.db.accountByTag("@yadu")!.id)?.status).toBe("pending");

    h.devices.options[0]!.tamper = true;
    h.script(delegate("send $1 to yadu"), call("propose_action", { code: "PAY", fields: { To: "@yadu", Amount: "$1" } }), say("Ready."));
    await h.send(PHONES.matt, "send $1 to yadu");
    expect(h.sent).toHaveLength(0);
    expect(h.to(PHONES.matt).at(-1)).toBe("I lost the connection to your Ledger, so nothing happened. Try again in a moment.");
  });

  it("the persona knows the address, and welcomes the owner only on their first turn", async () => {
    const h = await setup();
    h.script((req) => {
      expect(req.system).toContain(`You are Jarvis, @matt's (Matt) personal agent`);
      expect(req.system).toContain(`Account: @matt at ${matt.address} on Base.`);
      expect(req.system).toContain("0.01 ETH ($40.00) on Base");
      expect(req.system).toContain("first message since their account was created");
      return say(`Welcome, Matt. Your address is ${matt.address}.`);
    }, (req) => {
      expect(req.system).not.toContain("first message since their account was created");
      return say(`You're set up as @matt at ${matt.address} with 0.01 ETH.`);
    });
    await h.send(PHONES.matt, "hi");
    await h.send(PHONES.matt, "how do I get set up?");
    expect(h.requests.filter((r) => r.tools.some((t) => t.name === "propose_action"))).toHaveLength(0);
  });

  it("DEL wipes the account after a signed message, and the same number can sign up again", async () => {
    const h = await setup();
    const me = h.db.accountByTag("@matt")!;
    const them = h.db.accountByTag("@yadu")!;
    h.befriend(me.id, them.id);
    h.db.addNote(me.id, "likes tacos");
    h.db.addEvent(me.id, "Dentist", "2026-10-12T09:00", "2026-10-12T10:00", null, null);
    h.db.addPeerMessage("@matt", "@yadu", "free tomorrow?");
    h.script(delegate("delete my account"), call("propose_action", { code: "DEL", fields: [] }), say("Done when you approve it on your Ledger."));
    await h.send(PHONES.matt, "delete my account");

    const del = h.db.action((h.db.raw.prepare("select id from actions where code = 'DEL'").get() as { id: string }).id)!;
    expect(del.fields).toEqual([{ label: "Tag", value: "@matt" }, { label: "Address", value: addr(matt) }]);
    expect([del.status, del.account_id]).toEqual(["executed", null]);
    expect(h.to(PHONES.matt)).toContain(`Done when you approve it on your Ledger.\n\nPlease confirm on your Ledger: Delete account: Tag @matt, Address ${addr(matt)}`);
    expect(h.to(PHONES.matt).at(-1)).toBe("Your account @matt is gone. Message me again any time to start over.");
    expect(h.db.accountByTag("@matt")).toBeUndefined();
    expect(h.db.accountByHandle(PHONES.matt)).toBeUndefined();
    expect(h.db.friendsOf(them.id)).toEqual([]);
    expect(h.db.peerThread("@matt", "@yadu")).toEqual([]);
    expect(h.db.recentMessages(me.id)).toEqual([]);
    for (const table of ["notes", "events"]) expect(h.db.raw.prepare(`select count(*) as n from ${table} where account_id = ?`).get(me.id)).toEqual({ n: 0 });

    // A stranger again: the persona for people without an account answers, then the tag starts a fresh sign-up.
    h.script((req) => {
      expect(req.system).toContain("has no account yet");
      return say("Welcome back.");
    });
    await h.send(PHONES.matt, "hi again");
    // The first stranger reply always leads with setup, whatever the model said.
    expect(h.to(PHONES.matt).at(-1)).toBe(`${greeting("the Ethereum app")} Welcome back.`);
    await h.send(PHONES.matt, "@matt");
    expect(h.db.accountByTag("@matt")?.pubkey).toBe(addr(matt));
    expect(h.db.recentMessages(h.db.accountByTag("@matt")!.id)).toEqual([]);
  });
});
