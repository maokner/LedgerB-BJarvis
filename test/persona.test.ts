import { describe, expect, it } from "vitest";
import { INTRO, personaSystemPrompt, plain, setupLine, welcomeLine } from "../src/agent/persona.js";
import type { Account } from "../src/db.js";

const matt = { id: 1, tag: "@matt", pubkey: "0x" + "ab".repeat(20), balance_cents: 25_000, username: "mokner", display_name: "Matt Okner" } as Account;

describe("persona", () => {
  it("opens every sign-up with the intro, then the setup step", () => {
    expect(welcomeLine("@mokner", "the Ethereum app", true)).toBe(
      `${INTRO}\n\nYou're @mokner on Telegram, so that's your tag here. To bind your Ledger: plug it into the AgentSign Mac with the Ethereum app open and say 'go', or say 'link' and I'll send a page that works from any computer.`,
    );
    expect(setupLine("AgentSign")).toBe(`${INTRO}\n\nFirst, let's set up your account: plug your Ledger into the Mac, open AgentSign, and tell me the tag you want, like @matt.`);
    expect(INTRO).not.toMatch(/\u2014|email|remind/i); // no em dashes, nothing we have not built
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

  it("plain() leaves chat text clean for Telegram", () => {
    expect(plain("hey matt, glad you're here. \nwhat's up? \n\n\ntry it")).toBe("hey matt, glad you're here.\nwhat's up?\n\ntry it");
    expect(plain("anything else i *can* do for @gabe_live and @matt_o?")).toBe("anything else i can do for @gabe_live and @matt_o?");
    expect(plain("nope, _not_ gpt 👀 Just me.")).toBe("nope, not gpt. Just me.");
    expect(plain("2 * 3 = 6 and **bold** and `code`")).toBe("2 * 3 = 6 and bold and code");
    expect(plain("one thing — another")).toBe("one thing - another");
  });
});
