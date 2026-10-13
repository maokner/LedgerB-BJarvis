import { parseEther, Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { botMention, channelLabel, chatName, joinHint } from "../src/agent/bot.js";
import { confirmedAddress, INTRO, personaSystemPrompt, plain, setupLine, strangerSystemPrompt, welcomeLine } from "../src/agent/persona.js";
import type { CompleteRequest } from "../src/agent/xai.js";
import { openDb, type Account } from "../src/db.js";
import { demoDoorDash } from "../src/food/demo.js";
import { createFood } from "../src/food/food.js";
import { baseMoney } from "../src/money.js";
import { createTreasury } from "../src/treasury.js";
import { call, delegate, fakeEthDevices, harness, isEngine, isPersona, PHONES, say, stubChain } from "./helpers.js";

const matt = { id: 1, tag: "@matt", pubkey: "0x" + "ab".repeat(20), balance_cents: 25_000, username: "mokner", display_name: "Matt Okner" } as Account;

describe("persona", () => {
  it("opens every sign-up with the intro, then the setup step", () => {
    expect(welcomeLine("@mokner", "the Ethereum app", true)).toBe(
      `${INTRO}\n\nYou're @mokner on Telegram, so that's your tag here. Plug your Ledger into the AgentSign Mac with the Ethereum app open and say 'go', or say 'link' for a page that works from any computer.`,
    );
    expect(setupLine("AgentSign")).toBe(`${INTRO}\n\nTo set up your account, plug your Ledger into the Mac, open ${"AgentSign"}, and tell me the tag you want, like @matt.`);
    expect(INTRO).not.toMatch(/\u2014|email|remind/i); // no em dashes, nothing we have not built
    // Texts stay short: the whole first message fits in one iMessage bubble, well under the old wall of text.
    expect(INTRO.length).toBeLessThan(300);
    expect(setupLine("the Ethereum app", true).length).toBeLessThan(450);
    expect(personaSystemPrompt([], matt, false, true)).toContain("One to three short sentences, under about 240 characters");
  });

  it("tells the first-turn greeting how money works in each mode", () => {
    const demo = personaSystemPrompt([], matt, true, true);
    const eth = personaSystemPrompt([], matt, true, false);
    expect(demo).toContain("first message since their account was created");
    expect(demo).toContain("demo money to play with");
    expect(demo).not.toContain("give the address");
    expect(eth).toContain("USDC, plus a little ETH for the fee, on Base at their address above; give the address");
    expect(personaSystemPrompt([], matt, false, true)).not.toContain("first message since their account was created");
  });

  it("keeps the voice rules and never names the engine as something to mention", () => {
    const prompt = personaSystemPrompt([], matt, false, true);
    expect(prompt).toContain("Never mention the engine, delegate, tools, agents or anything behind the curtain");
    expect(prompt).toContain("swear only if they do");
    expect(prompt).toContain("Do not end every text with \"anything else?\"");
    expect(prompt).toContain('Never the pattern "not just X, but Y"');
  });

  it("speaks of iMessage on Photon: the chat, how friends join, and no Telegram anywhere", () => {
    const before = { CHANNEL: process.env.CHANNEL, PHOTON_NUMBER: process.env.PHOTON_NUMBER };
    process.env.CHANNEL = "photon";
    process.env.PHOTON_NUMBER = "+14155550199";
    try {
      const imessageOwner = { ...matt, username: null, display_name: null } as Account;
      const prompt = personaSystemPrompt([], imessageOwner, false, false);
      expect(prompt).toContain("You text with Matt on iMessage.");
      expect(prompt).toContain("friends join when they text Jarvis at +14155550199 on iMessage and set up with their own Ledger");
      expect(prompt).toContain("say they need to text Jarvis at +14155550199 on iMessage and set up with their own Ledger first");
      expect(prompt).not.toMatch(/telegram|press start/i);
      const stranger = strangerSystemPrompt({ appName: "the Ethereum app", link: true }, true);
      expect(stranger).toContain("an agent on AgentSign that people text on iMessage");
      expect(stranger).not.toMatch(/telegram|press start/i);
      expect([botMention(), chatName("+14155550001"), chatName(undefined), chatName("tg:1")]).toEqual([
        "Jarvis at +14155550199",
        "their iMessage chat with you",
        "their iMessage chat with you",
        "their Telegram chat with you",
      ]);
      delete process.env.PHOTON_NUMBER;
      expect(joinHint()).toBe("text Jarvis on iMessage and set up with their own Ledger");
      process.env.CHANNEL = "dev";
      expect([chatName("+14155550001"), channelLabel()]).toEqual(["their texts", undefined]);
    } finally {
      for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("plain() leaves chat text clean for Telegram", () => {
    expect(plain("hey matt, glad you're here. \nwhat's up? \n\n\ntry it")).toBe("hey matt, glad you're here.\nwhat's up?\n\ntry it");
    expect(plain("anything else i *can* do for @gabe_live and @matt_o?")).toBe("anything else i can do for @gabe_live and @matt_o?");
    expect(plain("nope, _not_ gpt 👀 Just me.")).toBe("nope, not gpt. Just me.");
    expect(plain("2 * 3 = 6 and **bold** and `code`")).toBe("2 * 3 = 6 and bold and code");
    expect(plain("one thing — another")).toBe("one thing - another");
  });

  describe("checks the delivery address before every order", () => {
    const HOME = "1 Market St Apt 5, San Francisco, CA 94105";

    /** @matt in Ethereum mode with the demo DoorDash and HOME saved as the delivery address. */
    async function setup() {
      const wallet = new Wallet(Wallet.createRandom().privateKey);
      const vault = new Wallet(Wallet.createRandom().privateKey);
      const { chain } = stubChain({ [wallet.address.toLowerCase()]: parseEther("0.05") }, 4000, { [wallet.address.toLowerCase()]: 50_000_000n });
      const money = baseMoney(chain);
      const h = harness(0, undefined, {
        money,
        deviceManager: fakeEthDevices([wallet]).manager,
        food: (ctx) => createFood({ ...ctx, provider: demoDoorDash(), treasury: createTreasury({ privateKey: vault.privateKey }, chain), money, operator: { name: "Matt" } }),
      });
      await h.send(PHONES.matt, "@matt");
      const owner = h.db.accountByTag("@matt")!;
      h.db.setDeliveryAddress(owner.id, HOME);
      return h;
    }
    const engineTask = (req: CompleteRequest) => String(req.messages[0]!.content);

    it("asks \"Deliver to <address>?\" without delegating, then a yes delegates with that address", async () => {
      const h = await setup();
      h.script((req) => {
        expect(isPersona(req)).toBe(true);
        expect(req.system).toContain(`Delivery address: ${HOME}. Food orders go there unless @matt names another address for one order.`);
        expect(req.system).toContain('With one, and no address in their message: ask in one short line "Deliver to <that address>?" (for Amazon "Ship to <that address>?") and wait; do not delegate yet.');
        return say(`Deliver to ${HOME}?`);
      });
      await h.send(PHONES.matt, "get me a burrito bowl from chipotle");
      expect(h.to(PHONES.matt).at(-1)).toBe(`Deliver to ${HOME}?`);
      expect(h.requests.some(isEngine)).toBe(false);

      h.script(
        (req) => {
          // The question is in the history, so "yes" reads as the answer to it.
          expect(req.messages.slice(-2).map((m) => [m.role, m.content])).toEqual([["assistant", `Deliver to ${HOME}?`], ["user", "yes"]]);
          return delegate("order a burrito bowl from chipotle", undefined, HOME);
        },
        (req) => {
          expect(isEngine(req)).toBe(true);
          expect(engineTask(req)).toContain(`Delivery address for this order, confirmed by Matt: ${HOME}`);
          expect(req.system).toContain("is checked with Matt before the task reaches you");
          return say("Chipotle is open; quoting next.");
        },
        say("on it."),
      );
      await h.send(PHONES.matt, "yes");
      expect(h.remaining()).toBe(0);
      expect(h.logs.filter((l) => /failed/.test(l))).toEqual([]); // an assertion inside an engine step would surface here
    });

    it("delegates at once when the message already names an address", async () => {
      const h = await setup();
      const WORK = "500 Howard St, San Francisco, CA 94105";
      h.script(
        (req) => {
          expect(isPersona(req)).toBe(true);
          expect(req.system).toContain("An address in their message settles it at once, whether they asked with it or answered with it: delegate right away with that address as address, no question");
          return delegate("order a burrito bowl from chipotle", undefined, WORK);
        },
        (req) => {
          expect(engineTask(req)).toContain(`Delivery address for this order, confirmed by Matt: ${WORK}`);
          return say("Chipotle is open; quoting next.");
        },
        say("on it."),
      );
      await h.send(PHONES.matt, `get me a burrito bowl from chipotle to ${WORK}`);
      expect(h.remaining()).toBe(0);
      expect(h.logs.filter((l) => /failed/.test(l))).toEqual([]); // an assertion inside an engine step would surface here
      expect(h.requests.filter(isEngine)).toHaveLength(1);
    });
  
    it("counts the persona's address as confirmed only when the owner gave it or answered about it", async () => {
      const db = openDb(":memory:");
      const owner = db.createAccount("@matt", "0x" + "ab".repeat(20), PHONES.matt, 0);
      const WORK = "500 Howard St, San Francisco, CA 94105";
      // Nothing saved yet: the address they gave is theirs from now on.
      expect(confirmedAddress({ db }, owner, HOME, "1 market st apt 5. a burrito bowl")).toBe(HOME);
      expect(db.account(owner.id)!.delivery_address).toBe(HOME);
      // The saved one, unasked: not confirmed. Named in their text, or another address: confirmed.
      expect(confirmedAddress({ db }, owner, HOME, "get me a burrito bowl")).toBeNull();
      expect(confirmedAddress({ db }, owner, HOME, "a burrito bowl to 1 Market St Apt 5")).toBe(HOME);
      expect(confirmedAddress({ db }, owner, WORK, "send it to work")).toBe(WORK);
      expect(confirmedAddress({ db }, owner, "my place", "send it home")).toBeNull();
      expect(confirmedAddress({ db }, owner, undefined, "get me a burrito bowl")).toBeNull();
      // Asked about it ("Deliver to 1 Market St?"): a yes, or a pick later in the same order, counts; a no does not.
      db.addMessage(owner.id, "assistant", { role: "assistant", content: "Deliver to 1 Market St?" });
      expect(confirmedAddress({ db }, owner, HOME, "yes")).toBe(HOME);
      expect(confirmedAddress({ db }, owner, HOME, "the second one")).toBe(HOME);
      expect(confirmedAddress({ db }, owner, HOME, "no, somewhere else")).toBeNull();
      // The persona left the address out: the conversation still says the saved one was confirmed.
      expect(confirmedAddress({ db }, owner, undefined, "yes")).toBe(HOME);
      db.raw.prepare("update messages set created_at = datetime('now', '-3 hours')").run();
      expect(confirmedAddress({ db }, owner, HOME, "yes")).toBeNull();
    });

    it("an order the persona sends to the saved address unasked comes back as the question", async () => {
      const h = await setup();
      h.script(
        () => delegate("order a burrito bowl from chipotle", undefined, HOME),
        (req) => {
          expect(engineTask(req)).not.toContain("confirmed by Matt");
          // Copying the saved address from the facts is no way around the question.
          return call("search_doordash", { query: "chipotle", address: HOME });
        },
        (req) => {
          // The engine stops on the refusal, and the persona gets the question to ask.
          expect(isPersona(req)).toBe(true);
          expect(String(req.messages.at(-1)!.content)).toBe(`Nothing searched or ordered yet: Matt has to confirm the address first. Ask them exactly: "Deliver to ${HOME}?"`);
          return say(`Deliver to ${HOME}?`);
        },
      );
      await h.send(PHONES.matt, "get me a burrito bowl from chipotle");
      expect([h.remaining(), h.to(PHONES.matt).at(-1)]).toEqual([0, `Deliver to ${HOME}?`]);
      expect(h.logs.filter((l) => /failed/.test(l))).toEqual([]);
    });
  });
});
