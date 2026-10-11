/** Runs the real xAI model through the whole app (fake devices and channel). Skipped without XAI_API_KEY. */
import { welcomeLine } from "../src/agent/persona.js";
import { config } from "dotenv";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createModel, DEFAULT_MODEL, type Model } from "../src/agent/xai.js";
import { addMinutes, localNow } from "../src/format.js";
import { harness, isEngine, isPersona, PHONES, tgInbound } from "./helpers.js";
import { receiptPng } from "./receipt.js";

config({ path: join(homedir(), ".grok", ".env"), quiet: true });
const apiKey = process.env.XAI_API_KEY;
const modelName = process.env.XAI_MODEL || DEFAULT_MODEL;

/** Wraps the real model and records each call: which layer, which model, how long. */
function timedModel(): { model: Model; calls: string[]; take: () => string } {
  const inner = createModel({ apiKey: apiKey!, model: modelName });
  const calls: string[] = [];
  let seen = 0;
  return {
    calls,
    /** The calls since the last take, like "persona grok-4.20-non-reasoning 512ms, engine grok-4.3 1830ms". */
    take: () => calls.splice(seen).join(", ") || "none",
    model: {
      async complete(request) {
        const started = Date.now();
        const layer = isPersona(request) ? "persona" : isEngine(request) ? "engine" : request.tools.some((t) => t.name === "choose_tag") ? "stranger" : "peer";
        try {
          return await inner.complete(request);
        } finally {
          calls.push(`${layer} ${request.model ?? modelName} ${Date.now() - started}ms`);
        }
      },
    },
  };
}

const CONFIRM = "Please confirm on your Ledger: Send money: To @gabriel, Amount $5.00";

describe.skipIf(!apiKey)(`live xAI (${modelName})`, () => {
  it("proposes PAY from text and from a receipt photo, in one text with the confirm prompt", { timeout: 120_000 }, async () => {
    const timed = timedModel();
    const h = harness(2, timed.model);
    await h.onboard("matt", 0);
    await h.onboard("gabriel", 1);
    const device = h.devices[0]!;
    device.policy = "reject"; // keep balances simple; we only care what was proposed
    const errors = () => h.logs.filter((l) => /error|failed/i.test(l)).join("\n");

    const before = h.to(PHONES.matt).length;
    await h.send(PHONES.matt, "send $5 to @gabriel");
    const texts = h.to(PHONES.matt).slice(before);
    console.log(`text turn: ${timed.take()}; texts: ${JSON.stringify(texts)}`);
    const first = device.shown.filter((a) => a.code === "PAY");
    expect(first, errors()).toHaveLength(1);
    expect(first[0]!.fields.slice(0, 2)).toEqual([
      { label: "To", value: "@gabriel" },
      { label: "Amount", value: "$5.00" },
    ]);
    // One text: the persona's words, then the confirm prompt. Then the outcome.
    const combined = texts.filter((t) => t.includes("Please confirm on your Ledger"));
    expect(combined).toHaveLength(1);
    expect(combined[0]).toContain(`\n\n${CONFIRM}`);
    expect(combined[0]!.indexOf(CONFIRM)).toBeGreaterThan(5);
    expect(texts.indexOf(combined[0]!)).toBe(0);
    expect(texts.at(-1)).toBe("You rejected it on your Ledger, so nothing happened.");

    const dir = mkdtempSync(join(tmpdir(), "agentsign-receipt-"));
    const image = join(dir, "receipt.png");
    writeFileSync(image, receiptPng(["CAFE ROMA", "", "BURRITO   $12.50", "TACOS      $8.00", "TAX        $2.90", "", "TOTAL     $23.40"]));
    await h.send(PHONES.matt, "pay gabe back for lunch", [image]);
    const second = device.shown.filter((a) => a.code === "PAY").slice(1);
    console.log(`image turn: ${timed.take()}; fields: ${JSON.stringify(second[0]?.fields)}; reply: ${JSON.stringify(h.to(PHONES.matt).at(-2))}`);
    expect(second, errors()).toHaveLength(1);
    expect(second[0]!.fields.slice(0, 2)).toEqual([
      { label: "To", value: "@gabriel" },
      { label: "Amount", value: "$23.40" },
    ]);

    await h.send(PHONES.matt, "how do I get set up?");
    const setupTurn = timed.take();
    console.log(`setup question: ${setupTurn}; reply: ${JSON.stringify(h.to(PHONES.matt).at(-1))}`);
    expect(setupTurn).not.toMatch(/engine/); // answered from the facts, no delegation
    expect(h.to(PHONES.matt).at(-1)).toMatch(/@matt/);

    await h.send(PHONES.matt, "thanks!");
    console.log(`chat turn: ${timed.take()}; reply: ${JSON.stringify(h.to(PHONES.matt).at(-1))}`);
    expect(device.shown.filter((a) => a.code === "PAY")).toHaveLength(2);
  });

  it("sets up a meeting with a friend: a slot free for both goes to the friend by text, their yes books it, no Ledger", { timeout: 180_000 }, async () => {
    const timed = timedModel();
    const h = harness(2, timed.model);
    const matt = await h.onboard("matt", 0);
    const yadu = await h.onboard("yadu", 1);
    h.befriend(matt.id, yadu.id);
    const tomorrow = addMinutes(localNow(), 24 * 60).slice(0, 10);
    h.db.addEvent(yadu.id, "Therapy", `${tomorrow}T12:00`, `${tomorrow}T14:00`, null, null);
    h.db.addEvent(yadu.id, "Interview", `${tomorrow}T14:30`, `${tomorrow}T16:00`, null, null);
    const shown = [h.devices[0]!.shown.length, h.devices[1]!.shown.length];

    await h.send(PHONES.matt, "set up a 30 minute meeting with yadu tomorrow afternoon");
    const peer = h.db.peerThread("@matt", "@yadu");
    const open = h.db.openMeetings(yadu.id);
    console.log(`schedule turn: ${timed.take()}`);
    console.log(`peer thread: ${JSON.stringify(peer.map((m) => `${m.from_tag}: ${m.text}`))}`);
    console.log(`meeting: ${JSON.stringify(open[0])}; to Matt: ${JSON.stringify(h.to(PHONES.matt).slice(2))}; to Yadu: ${JSON.stringify(h.to(PHONES.yadu).slice(2))}`);
    expect(peer.length).toBeGreaterThanOrEqual(2);
    expect(peer.map((m) => m.text).join(" ")).not.toMatch(/therapy|interview/i);
    expect(open).toHaveLength(1);
    const m = open[0]!;
    expect(m.starts_at.slice(0, 10)).toBe(tomorrow);
    expect(m.starts_at.slice(11)).toBe("14:00"); // the first free half hour of the afternoon
    expect(addMinutes(m.starts_at, 30)).toBe(m.ends_at);
    expect(m.awaiting).toBe(yadu.id);
    expect(h.to(PHONES.yadu).at(-1)).toMatch(/^@matt would like to meet: '.*' .* 14:00-14:30\. Any time .* works for Matt\. Reply 'yes'/);
    expect(h.to(PHONES.matt).some((t) => /confirm on your Ledger/.test(t))).toBe(false);
    expect([h.devices[0]!.shown.length, h.devices[1]!.shown.length]).toEqual(shown);

    await h.send(PHONES.yadu, "yes");
    expect(h.to(PHONES.yadu).at(-1)).toMatch(/^Done: '.*' with @matt, .* 14:00-14:30, is on both calendars\.$/);
    expect(h.to(PHONES.matt).at(-1)).toMatch(/^@yadu said yes: '.*' with @yadu, .* 14:00-14:30, is on both calendars\.$/);
    expect(h.db.events(matt.id, m.starts_at, m.ends_at)).toEqual([expect.objectContaining({ with_tag: "@yadu" })]);
    expect(h.db.events(yadu.id, m.starts_at, m.ends_at).map((e) => e.with_tag)).toEqual(["@matt"]);

    // Matt can ask what happened, from the history alone.
    await h.send(PHONES.matt, "did yadu answer?");
    console.log(`check turn: ${timed.take()}; reply: ${JSON.stringify(h.to(PHONES.matt).at(-1))}`);
    expect(h.to(PHONES.matt).at(-1)).toMatch(/yes|booked|on both|calendar/i);
  });

  it("a thank you note after a payment goes to the friend as a text, not to their agent's calendar", { timeout: 180_000 }, async () => {
    const timed = timedModel();
    const h = harness(2, timed.model);
    const matt = await h.onboard("matt", 0);
    const gabriel = await h.onboard("gabriel", 1);
    h.befriend(matt.id, gabriel.id);
    await h.send(PHONES.matt, "send $1 to @gabriel for thank you");
    expect(h.to(PHONES.gabriel).at(-1)).toMatch(/^@matt sent you \$1\.00/);
    timed.take();

    const mattBefore = h.to(PHONES.matt).length;
    const gabeBefore = h.to(PHONES.gabriel).length;
    const shown = [h.devices[0]!.shown.length, h.devices[1]!.shown.length];
    await h.send(PHONES.gabriel, "FIRE! send him a thank you node");
    const toMatt = h.to(PHONES.matt).slice(mattBefore);
    const toGabe = h.to(PHONES.gabriel).slice(gabeBefore);
    console.log(`note turn: ${timed.take()}; to Matt: ${JSON.stringify(toMatt)}; to Gabe: ${JSON.stringify(toGabe)}`);
    expect(toMatt).toHaveLength(1);
    expect(toMatt[0]).toMatch(/^@gabriel says: .*thank/i);
    expect(toGabe.join(" ")).not.toMatch(/checking with|free or busy/i);
    expect(h.db.peerThread("@matt", "@gabriel")).toHaveLength(0);
    expect([h.devices[0]!.shown.length, h.devices[1]!.shown.length]).toEqual(shown);

    await h.send(PHONES.matt, "tell him you're welcome");
    console.log(`reply turn: ${timed.take()}; to Gabe: ${JSON.stringify(h.to(PHONES.gabriel).at(-1))}; to Matt: ${JSON.stringify(h.to(PHONES.matt).at(-1))}`);
    expect(h.to(PHONES.gabriel).at(-1)).toMatch(/^@matt says: .*welcome/i);
  });

  it("a Telegram stranger asks who this is, then agrees to their username as the tag", { timeout: 60_000 }, async () => {
    const timed = timedModel();
    const h = harness(2, timed.model);
    h.devices[1]!.connected = false;
    const gabe = (text: string) => h.deliver(tgInbound(7001, text, "Gabe_Live", "Gabe"));
    await gabe("yo who are you");
    expect(h.to("tg:7001")).toEqual([welcomeLine("@gabe_live", "AgentSign", false)]);
    expect(timed.take()).toBe("none"); // the welcome is fixed
    await gabe("is this safe?");
    console.log(`stranger question: ${timed.take()}; reply: ${JSON.stringify(h.to("tg:7001").at(-1))}`);
    expect(h.to("tg:7001").at(-1)).toMatch(/'go'|\btag\b/i); // steers back to setup
    await gabe("alright sounds good, it's plugged in now");
    console.log(`confirm turn: ${timed.take()}; texts: ${JSON.stringify(h.to("tg:7001").slice(2))}`);
    expect(h.devices[0]!.shown.at(-1)?.fields).toEqual([{ label: "Tag", value: "@gabe_live" }, { label: "Telegram", value: "@gabe_live" }]);
    expect(h.db.accountByHandle("tg:7001")).toMatchObject({ tag: "@gabe_live", username: "gabe_live", display_name: "Gabe" });

    // Without a username, the restricted persona extracts the tag with choose_tag.
    h.devices[1]!.connected = true;
    await h.deliver(tgInbound(7002, "hey! can I be yadu?"));
    console.log(`choose_tag turn: ${timed.take()}; texts: ${JSON.stringify(h.to("tg:7002"))}`);
    expect(h.devices[1]!.shown.at(-1)?.fields).toEqual([{ label: "Tag", value: "@yadu" }, { label: "Telegram", value: "id 7002" }]);
  });
});
