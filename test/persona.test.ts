import { describe, expect, it } from "vitest";
import { botMention, channelLabel, chatName, joinHint } from "../src/agent/bot.js";
import { INTRO, personaSystemPrompt, plain, setupLine, strangerSystemPrompt, welcomeLine } from "../src/agent/persona.js";
import type { Account } from "../src/db.js";

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
    expect(eth).toContain("ETH on Base at their address above; give the address");
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
});
