import { describe, expect, it } from "vitest";
import { newActionId, verifyActionSignature } from "../src/actions.js";
import { createApprovals } from "../src/approvals.js";
import { OOPS } from "../src/app.js";
import { ACTION_TITLES } from "../src/types.js";
import { call, delegate, harness, isEngine, isPersona, PHONES, say } from "./helpers.js";

async function setup() {
  const h = harness(2);
  const matt = await h.onboard("matt", 0);
  const gabriel = await h.onboard("gabriel", 1);
  return { ...h, matt, gabriel, mattDevice: h.devices[0]!, gabrielDevice: h.devices[1]! };
}

describe("payments", () => {
  it("persona delegates, engine proposes, one text carries the reply and the confirm prompt, then the device", async () => {
    const h = await setup();
    h.script(
      (req) => {
        expect(isPersona(req)).toBe(true);
        expect(req.tools.map((t) => t.name)).toEqual(["delegate"]);
        expect(req.system).toContain("@matt");
        expect(req.system).toContain("$250.00");
        expect(req.messages.at(-1)).toEqual({ role: "user", content: "send $5 to gabe for lunch" });
        return delegate("pay gabe $5 for lunch");
      },
      (req) => {
        expect(isEngine(req)).toBe(true);
        expect(req.system).toContain("no direct access");
        expect(req.system).toContain("@gabriel");
        expect(req.messages).toEqual([{ role: "user", content: 'Task: pay gabe $5 for lunch\nMatt\'s latest text: "send $5 to gabe for lunch"' }]);
        return call("propose_action", { code: "PAY", fields: [{ label: "to", value: "gabe" }, { label: "Amount", value: "5" }, { label: "Memo", value: "lunch" }] });
      },
      // No engine report call after a proposal: the harness reports it.
      (req) => {
        expect(isPersona(req)).toBe(true);
        expect(req.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining("Proposed on @matt's Ledger: Send money: To @gabriel, Amount $5.00, Memo lunch. Not done") });
        return say("Got it, $5 to @gabriel for lunch. Check your Ledger to confirm.");
      },
    );
    const message = await h.send(PHONES.matt, "send $5 to gabe for lunch");

    const shown = h.mattDevice.shown.at(-1)!;
    expect(shown.code).toBe("PAY");
    expect(shown.fields).toEqual([
      { label: "To", value: "@gabriel" },
      { label: "Amount", value: "$5.00" },
      { label: "Memo", value: "lunch" },
    ]);
    const row = h.db.action(shown.id)!;
    expect(row.status).toBe("executed");
    expect(verifyActionSignature(h.matt.pubkey, shown, row.signature!)).toBe(true);
    expect(h.db.account(h.matt.id)!.balance_cents).toBe(24_500);
    expect(h.db.account(h.gabriel.id)!.balance_cents).toBe(25_500);
    // The device is asked only after the combined text went out, so the order is fixed.
    expect(h.to(PHONES.matt).slice(-2)).toEqual([
      "Got it, $5 to @gabriel for lunch.\n\nPlease confirm on your Ledger: Send money: To @gabriel, Amount $5.00, Memo lunch",
      "Sent $5.00 (lunch) to @gabriel. Your balance is $245.00.",
    ]);
    expect(h.to(PHONES.gabriel).at(-1)).toBe("@matt sent you $5.00 (lunch). Your balance is $255.00.");
    expect(h.reactions).toEqual([{ messageId: message.id, emoji: "👍" }]);
    expect(h.typing.filter((t) => t.handle === PHONES.matt).map((t) => t.on)).toEqual([true, false]);

    // Next turn: the engine report is a tool result in the persona's history, the outcome a system note after the reply.
    h.script((req) => {
      expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "system", "user"]);
      expect(req.messages[4]!.content).toBe("Action PAY (Send money: To @gabriel, Amount $5.00, Memo lunch) was approved on the device and executed.");
      return say("Yes, it went through.");
    });
    await h.send(PHONES.matt, "did it go through?");
    expect(h.to(PHONES.matt).at(-1)).toBe("Yes, it went through.");
    expect(h.reactions).toHaveLength(1); // simple chat is not a task
  });

  it("moves nothing when rejected on the device", async () => {
    const h = await setup();
    h.mattDevice.policy = "reject";
    h.script(delegate("pay @gabriel $5"), call("propose_action", { code: "PAY", fields: { To: "@gabriel", Amount: "$5.00" } }), say("Ready on your Ledger."));
    await h.send(PHONES.matt, "send $5 to @gabriel");
    expect(h.db.action(h.mattDevice.shown.at(-1)!.id)!.status).toBe("rejected");
    expect(h.db.account(h.matt.id)!.balance_cents).toBe(25_000);
    expect(h.db.account(h.gabriel.id)!.balance_cents).toBe(25_000);
    expect(h.to(PHONES.matt)).toContain("You rejected it on your Ledger, so nothing happened.");
    expect(h.to(PHONES.gabriel).filter((t) => t.includes("sent you"))).toHaveLength(0);
  });

  it("refuses to execute a signature from the wrong key", async () => {
    const h = await setup();
    h.mattDevice.policy = "wrong-key";
    h.script(delegate("pay @gabriel $5"), call("propose_action", { code: "PAY", fields: { To: "@gabriel", Amount: "$5.00" } }), say("Ready."));
    await h.send(PHONES.matt, "send $5 to @gabriel");
    const row = h.db.action(h.mattDevice.shown.at(-1)!.id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toBe("signature did not verify");
    expect(h.db.account(h.matt.id)!.balance_cents).toBe(25_000);
    expect(h.to(PHONES.matt)).toContain("That approval didn't come from the Ledger on your account, so nothing happened.");
  });

  it("handles insufficient funds at proposal time and at execution time", async () => {
    const h = await setup();
    h.script(
      delegate("pay gabriel $900"),
      call("propose_action", { code: "PAY", fields: { To: "@gabriel", Amount: "$900" } }),
      (req) => {
        expect(req.messages.at(-1)!.content).toContain("insufficient funds");
        return say("Not proposed: insufficient funds. Balance $250.00, asked $900.00.");
      },
      (req) => {
        expect(req.messages.at(-1)).toMatchObject({ role: "tool", content: "Not proposed: insufficient funds. Balance $250.00, asked $900.00." });
        return say("You only have $250.00, so I can't send $900.");
      },
    );
    await h.send(PHONES.matt, "send $900 to gabriel");
    expect(h.mattDevice.shown.filter((a) => a.code === "PAY")).toHaveLength(0);
    expect(h.to(PHONES.matt).at(-1)).toBe("You only have $250.00, so I can't send $900.");

    // Funds can also disappear between the proposal and the signature: the executor checks again.
    await h.app.approvals.request(h.matt.id, { code: "PAY", id: newActionId(), fields: [{ label: "To", value: "@gabriel" }, { label: "Amount", value: "$300.00" }] });
    await h.app.whenIdle();
    expect(h.to(PHONES.matt).at(-1)).toBe("Payment failed: your balance is $250.00, not enough to send $300.00.");
    expect(h.db.account(h.matt.id)!.balance_cents).toBe(25_000);
  });

  it("allows one pending approval per account and reports a missing device", async () => {
    const h = await setup();
    let release!: () => void;
    h.mattDevice.gate = new Promise((r) => (release = r));
    h.script(delegate("pay gabriel $1"), call("propose_action", { code: "PAY", fields: { To: "@gabriel", Amount: "$1" } }), say("Ready."));
    await h.app.handleInbound({ id: "p1", handle: PHONES.matt, text: "send $1 to gabriel", images: [], at: new Date(), service: "dev" });
    h.script(
      delegate("pay gabriel $2"),
      call("propose_action", { code: "PAY", fields: { To: "@gabriel", Amount: "$2" } }),
      (req) => {
        expect(req.messages.at(-1)!.content).toContain("wait for the pending approval (Send money: To @gabriel, Amount $1.00)");
        return say("Not proposed: $1.00 to @gabriel still waits on the Ledger.");
      },
      say("Approve or reject the $1 on your Ledger first."),
    );
    await h.app.handleInbound({ id: "p2", handle: PHONES.matt, text: "and $2 too", images: [], at: new Date(), service: "dev" });
    expect(h.to(PHONES.matt).at(-1), h.logs.join("\n")).toBe("Approve or reject the $1 on your Ledger first.");
    release();
    await h.app.whenIdle();
    expect(h.mattDevice.shown.filter((a) => a.code === "PAY")).toHaveLength(1);
    expect(h.db.account(h.gabriel.id)!.balance_cents).toBe(25_100);

    // A restart forgets in-flight approvals, so they must not block the account forever.
    h.db.insertAction(h.matt.id, { code: "PAY", id: newActionId(), fields: [{ label: "To", value: "@gabriel" }, { label: "Amount", value: "$1.00" }] });
    expect(h.db.pendingAction(h.matt.id)).toBeDefined();
    createApprovals({ db: h.db, deviceManager: h.manager, channel: h.channel, titles: ACTION_TITLES });
    expect(h.db.pendingAction(h.matt.id)).toBeUndefined();

    h.mattDevice.gate = undefined;
    h.mattDevice.connected = false;
    h.script(delegate("pay gabriel $1"), call("propose_action", { code: "PAY", fields: { To: "@gabriel", Amount: "$1" } }), say("Ready."));
    await h.send(PHONES.matt, "send $1 to gabriel");
    expect(h.to(PHONES.matt)).toContain(
      "I couldn't find your Ledger, so nothing happened. Plug it in, unlock it, open AgentSign, and ask me again. If it still shows an old request, reject that one first.",
    );
    expect(h.db.account(h.gabriel.id)!.balance_cents).toBe(25_100);
  });

  it("asks when a name is ambiguous and never lets the model propose ACC", async () => {
    const h = harness(3);
    await h.onboard("matt", 0);
    await h.onboard("gabriel", 1);
    for (const d of h.devices) d.connected = d === h.devices[2];
    await h.send("+14155550009", "@gabby");
    h.script(
      delegate("pay gab $1"),
      call("propose_action", { code: "PAY", fields: { To: "gab", Amount: "$1" } }),
      (req) => {
        expect(req.messages.at(-1)!.content).toMatch(/could be @gabriel or @gabby|could be @gabby or @gabriel/);
        return call("propose_action", { code: "ACC", fields: { Tag: "@evil", Phone: "+1" } });
      },
      (req) => {
        expect(req.messages.at(-1)!.content).toContain("code must be PAY, CAL, FRQ or FAC");
        return say("Need from the owner: gab could be @gabriel or @gabby.");
      },
      say("Which one, @gabriel or @gabby?"),
    );
    await h.send(PHONES.matt, "send $1 to gab");
    expect(h.devices[0]!.shown.filter((a) => a.code !== "ACC")).toHaveLength(0);
  });

  it("sends the engine back once when it reports a proposal it never made", async () => {
    const h = await setup();
    h.script(
      delegate("pay gabriel $5"),
      say("Proposed $5 to @gabriel."),
      (req) => {
        expect(req.messages.at(-1)).toMatchObject({ role: "system", content: expect.stringContaining("propose_action was not called") });
        return call("propose_action", { code: "PAY", fields: { To: "@gabriel", Amount: "$5" } });
      },
      say("Ready."),
    );
    await h.send(PHONES.matt, "send $5 to gabriel");
    expect(h.mattDevice.shown.filter((a) => a.code === "PAY")).toHaveLength(1);
  });

  it("sends the persona back once when it claims a proposal without delegating", async () => {
    const h = await setup();
    h.script(
      say("Done, confirm it on your Ledger."),
      (req) => {
        expect(isPersona(req)).toBe(true);
        expect(req.messages.at(-1)).toMatchObject({ role: "system", content: expect.stringContaining("Nothing was proposed this turn") });
        return delegate("pay gabriel $5");
      },
      call("propose_action", { code: "PAY", fields: { To: "@gabriel", Amount: "$5" } }),
      say("Ready, $5 to @gabriel."),
    );
    await h.send(PHONES.matt, "send $5 to gabriel");
    expect(h.mattDevice.shown.filter((a) => a.code === "PAY")).toHaveLength(1);
    expect(h.db.recentMessages(h.matt.id).some((m) => JSON.stringify(m.content).includes("Nothing was proposed"))).toBe(false);
  });

  it("commits the money move and the executed mark together", async () => {
    const h = await setup();
    const setActionStatus = h.db.setActionStatus;
    h.db.setActionStatus = (id, status, extra) => {
      if (status === "executed") throw new Error("disk full");
      return setActionStatus(id, status, extra);
    };
    await h.app.approvals.request(h.matt.id, { code: "PAY", id: newActionId(), fields: [{ label: "To", value: "@gabriel" }, { label: "Amount", value: "$5.00" }] });
    await h.app.whenIdle();
    expect(h.db.account(h.matt.id)!.balance_cents).toBe(25_000);
    expect(h.db.account(h.gabriel.id)!.balance_cents).toBe(25_000);
    expect(h.db.transactions(h.matt.id)).toHaveLength(0);
    expect(h.db.action(h.mattDevice.shown.at(-1)!.id)!.status).toBe("failed");
    expect(h.to(PHONES.matt).at(-1)).toBe("Something went wrong on my side, so nothing happened.");
  });

  it("refuses DEL with the custom app, which does not know that code", async () => {
    const h = await setup();
    h.script(delegate("delete my account"), call("propose_action", { code: "DEL", fields: [] }), (req) => {
      expect(req.messages.at(-1)!.content).toContain("not available in this mode");
      return say("I can't delete accounts here.");
    }, say("Sorry, I can't delete accounts in this setup."));
    await h.send(PHONES.matt, "delete my account");
    expect(h.db.accountByTag("@matt")).toBeDefined();
    expect(h.mattDevice.shown.filter((a) => a.code === "DEL")).toHaveLength(0);
  });

  it("never leaks errors to the phone", async () => {
    const h = await setup();
    h.script(() => {
      throw new Error("xAI 500: secret stack");
    });
    await h.send(PHONES.matt, "hello");
    expect(h.to(PHONES.matt).at(-1)).toBe(OOPS);
    expect(h.to(PHONES.matt).at(-1)).not.toContain("secret");
  });
});
