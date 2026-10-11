/** The Ledger policy: presets, per-owner changes, and what each one sends to the Ledger or does at once (src/policy.ts). */
import { describe, expect, it } from "vitest";
import { newActionId } from "../src/actions.js";
import { addMinutes, formatWhen, localNow } from "../src/format.js";
import { changePolicy, describePolicy, gates, policyOf, requiresLedger } from "../src/policy.js";
import { call, delegate, harness, isPersona, PHONES, say } from "./helpers.js";

const DAY = addMinutes(localNow(), 24 * 60).slice(0, 10);
const at = (clock: string) => `${DAY}T${clock}`;
const slot = (start: string) => formatWhen(at(start), addMinutes(at(start), 30));
const strict = JSON.stringify({ preset: "strict", overrides: {} });
const relaxed = JSON.stringify({ preset: "relaxed", overrides: {} });

async function friends() {
  const h = harness(2);
  const matt = await h.onboard("matt", 0);
  const yadu = await h.onboard("yadu", 1);
  h.befriend(matt.id, yadu.id);
  const events = (id: number) => h.db.events(id, `${DAY}T00:00`, `${DAY}T24:00`);
  return { ...h, matt, yadu, events };
}

/** Matt proposes coffee at 9 tomorrow; Yadu's answer is what each test is about. */
async function coffeeProposed(h: Awaited<ReturnType<typeof friends>>) {
  h.script(delegate("coffee with yadu"), call("propose_meeting", { tag: "yadu", title: "Coffee", from: `${DAY} 09:00`, to: `${DAY} 09:30` }), say("Asked Yadu."));
  await h.send(PHONES.matt, "coffee with yadu tomorrow at 9");
  expect(h.db.openMeetings(h.yadu.id)).toHaveLength(1);
}

describe("ledger policy", () => {
  it("presets, single changes on top of them, and how they read", () => {
    expect(policyOf({ policy: null })).toEqual({ preset: "standard", overrides: {} });
    expect(policyOf({ policy: "garbage" })).toEqual({ preset: "standard", overrides: {} });
    expect(gates(policyOf({ policy: null }))).toEqual({ calendar: false, meetings: false, friends: true });
    expect(gates(policyOf({ policy: strict }))).toEqual({ calendar: true, meetings: true, friends: true });
    expect(requiresLedger({ policy: relaxed }, "friends")).toBe(false);
    const tightened = changePolicy(policyOf({ policy: null }), { calendar: true });
    expect(tightened).toEqual({ preset: "standard", overrides: { calendar: true } });
    expect(gates(tightened)).toEqual({ calendar: true, meetings: false, friends: true });
    // A change that matches the preset is no change; a new preset drops the changes.
    expect(changePolicy(tightened, { calendar: false })).toEqual({ preset: "standard", overrides: {} });
    expect(changePolicy(tightened, { preset: "relaxed" })).toEqual({ preset: "relaxed", overrides: {} });
    expect(changePolicy(tightened, { preset: "relaxed", friends: true })).toEqual({ preset: "relaxed", overrides: { friends: true } });
    expect(describePolicy(policyOf({ policy: null }))).toBe("standard: the Ledger confirms money, deleting the account and adding friends; own calendar events and meetings with friends happen at once.");
    expect(describePolicy(policyOf({ policy: strict }))).toBe("strict: the Ledger confirms money, deleting the account, own calendar events, meetings with friends and adding friends; nothing happens without it.");
    expect(describePolicy(policyOf({ policy: relaxed }))).toBe("relaxed: the Ledger confirms money and deleting the account; own calendar events, meetings with friends and adding friends happen at once.");
    expect(describePolicy(tightened)).toBe("standard with changes: the Ledger confirms money, deleting the account, own calendar events and adding friends; meetings with friends happens at once.");
  });

  it("the owner changes the policy by asking; the facts show it and the next calendar event follows it", async () => {
    const h = harness(1);
    const matt = await h.onboard("matt", 0);
    h.script(
      (req) => {
        expect(req.system).toContain("Ledger policy, standard: the Ledger confirms money, deleting the account and adding friends; own calendar events and meetings with friends happen at once.");
        return delegate("ask the Ledger for calendar events too");
      },
      (req) => {
        expect(req.system).toContain("set_ledger_policy");
        return call("set_ledger_policy", { calendar: true });
      },
      (req) => {
        expect(isPersona(req)).toBe(true);
        expect(req.messages.at(-1)!.content).toBe("Ledger policy is now standard with changes: the Ledger confirms money, deleting the account, own calendar events and adding friends; meetings with friends happens at once. Takes effect right away.");
        return say("Done: calendar events go to your Ledger from now on.");
      },
    );
    await h.send(PHONES.matt, "i want my ledger to confirm calendar events too");
    expect(h.to(PHONES.matt).at(-1)).toBe("Done: calendar events go to your Ledger from now on.");
    expect(policyOf(h.db.account(matt.id)!)).toEqual({ preset: "standard", overrides: { calendar: true } });
    h.script(delegate("dentist"), call("propose_action", { code: "CAL", fields: [{ label: "Title", value: "Dentist" }, { label: "When", value: `${DAY} 12:00-12:30` }] }), say("Dentist, coming up."));
    await h.send(PHONES.matt, "dentist tomorrow at noon");
    expect(h.devices[0]!.shown.at(-1)).toMatchObject({ code: "CAL" });
    expect(h.to(PHONES.matt).at(-1)).toBe(`Added 'Dentist' ${slot("12:00")} to your calendar.`);
    // Back to a preset.
    h.script(delegate("relaxed"), call("set_ledger_policy", { preset: "relaxed" }), say("Relaxed it is."));
    await h.send(PHONES.matt, "make it relaxed");
    expect(policyOf(h.db.account(matt.id)!)).toEqual({ preset: "relaxed", overrides: {} });
    h.script(
      delegate("bad"),
      call("set_ledger_policy", {}),
      (req) => {
        expect(req.messages.at(-1)!.content).toBe("Error: give a preset (relaxed, standard, strict) or one of calendar, meetings, friends as true or false.");
        return say("Need a preset or one item.");
      },
      say("Which part: calendar, meetings or friends? Or relaxed, standard, strict?"),
    );
    await h.send(PHONES.matt, "change my policy");
    expect(h.remaining()).toBe(0);
  });

  it("friends: on the Ledger by default, at once under relaxed, on both sides of the request", async () => {
    const h = harness(3);
    const matt = await h.onboard("matt", 0);
    const yadu = await h.onboard("yadu", 1);
    h.db.setPolicy(matt.id, relaxed);
    const shown = [h.devices[0]!.shown.length, h.devices[1]!.shown.length];
    h.script(delegate("add yadu"), call("propose_action", { code: "FRQ", fields: [{ label: "To", value: "yadu" }] }), (req) => {
      expect(req.messages.at(-1)!.content).toBe("Friend request sent to @yadu. I will tell you when they accept. Done at once: @matt's Ledger policy does not ask the Ledger for this.");
      return say("Sent Yadu a friend request.");
    });
    await h.send(PHONES.matt, "add @yadu as a friend");
    expect(h.db.friendship(matt.id, yadu.id)).toEqual({ status: "pending", requested_by: matt.id });
    expect(h.to(PHONES.yadu).at(-1)).toBe("@matt wants to connect your agents (so they can schedule with each other and pass notes between you). Reply 'accept @matt' to connect.");
    expect(h.devices[0]!.shown).toHaveLength(shown[0]!);
    // Yadu is on the default policy: accept goes to his Ledger.
    await h.send(PHONES.yadu, "accept");
    expect(h.devices[1]!.shown.at(-1)).toMatchObject({ code: "FAC", fields: [{ label: "From", value: "@matt" }] });
    expect(h.db.friendship(matt.id, yadu.id)?.status).toBe("accepted");
    expect(h.to(PHONES.matt).at(-1)).toBe("@yadu accepted your friend request. Your agents can now talk to each other.");
    // Relaxed on the accepting side: no model, no Ledger, done in one text.
    const gabriel = await h.onboard("gabriel", 2);
    h.db.setPolicy(gabriel.id, relaxed);
    h.db.requestFriend(yadu.id, gabriel.id);
    const calls = h.requests.length;
    const sent = await h.send(PHONES.gabriel, "accept @yadu");
    expect(h.requests.length).toBe(calls);
    expect(h.reactions.at(-1)).toEqual({ messageId: sent.id, emoji: "👍" });
    expect(h.devices[1]!.shown.filter((a) => a.code === "FAC")).toHaveLength(1); // Yadu's earlier one only
    expect(h.db.friendship(yadu.id, gabriel.id)?.status).toBe("accepted");
    expect(h.to(PHONES.gabriel).at(-1)).toBe("You and @yadu are now friends. Your agents can schedule with each other and pass notes between you.");
    expect(h.to(PHONES.yadu).at(-1)).toBe("@gabriel accepted your friend request. Your agents can now talk to each other.");
    expect(h.remaining()).toBe(0);
  });

  it("a strict friend's side of a meeting waits on their Ledger; the other side is told, and their calendar fills on approval", async () => {
    const h = await friends();
    h.db.setPolicy(h.yadu.id, strict);
    await coffeeProposed(h);
    const yaduTexts = h.to(PHONES.yadu).length;
    await h.send(PHONES.yadu, "yes");
    // One text to Yadu: his Ledger prompt. The event is on Matt's calendar now and on Yadu's once he approves.
    expect(h.to(PHONES.yadu).slice(yaduTexts, yaduTexts + 1)).toEqual([
      `Done: 'Coffee' with @matt, ${slot("09:00")}, is on @matt's calendar. Your Ledger policy asks you to confirm it before it goes on your calendar: Add to calendar: Title Coffee, When ${slot("09:00")}, With @matt`,
    ]);
    expect(h.to(PHONES.matt).at(-1)).toBe(`@yadu said yes: 'Coffee' with @yadu, ${slot("09:00")}, is on your calendar; @yadu's side goes on theirs once they confirm it on their Ledger.`);
    expect(h.devices[1]!.shown.at(-1)).toMatchObject({ code: "CAL", fields: [{ label: "Title", value: "Coffee" }, { label: "When", value: slot("09:00") }, { label: "With", value: "@matt" }] });
    expect(h.to(PHONES.yadu).at(-1)).toBe(`Added 'Coffee' with @matt ${slot("09:00")} to your calendar.`);
    expect(h.events(h.matt.id)).toEqual([expect.objectContaining({ title: "Coffee", with_tag: "@yadu", action_id: null })]);
    expect(h.events(h.yadu.id)).toEqual([expect.objectContaining({ title: "Coffee", with_tag: "@matt", action_id: expect.any(String) })]);
    expect(h.db.meeting(1)!.status).toBe("confirmed");
  });

  it("a strict asker gets their own Ledger prompt when the friend says yes, and through Jarvis the prompt rides under the reply", async () => {
    const h = await friends();
    h.db.setPolicy(h.matt.id, strict);
    await coffeeProposed(h);
    await h.send(PHONES.yadu, "yes");
    expect(h.to(PHONES.yadu).at(-1)).toBe(`Done: 'Coffee' with @matt, ${slot("09:00")}, is on @matt's calendar.`.replace("is on @matt's calendar", "is on your calendar; @matt's side goes on theirs once they confirm it on their Ledger"));
    expect(h.to(PHONES.matt).at(-1)).toBe(`Added 'Coffee' with @yadu ${slot("09:00")} to your calendar.`);
    expect(h.to(PHONES.matt).at(-2)).toBe(`@yadu said yes: 'Coffee' with @yadu, ${slot("09:00")}, is on @yadu's calendar. Your Ledger policy asks you to confirm it before it goes on your calendar: Add to calendar: Title Coffee, When ${slot("09:00")}, With @yadu`);
    expect(h.events(h.matt.id)).toEqual([expect.objectContaining({ with_tag: "@yadu", action_id: expect.any(String) })]);
    expect(h.events(h.yadu.id)).toEqual([expect.objectContaining({ with_tag: "@matt", action_id: null })]);

    // Now Yadu proposes and strict Matt answers through Jarvis: the engine line says it waits, the prompt goes out under the persona's words.
    h.script(delegate("lunch with matt"), call("propose_meeting", { tag: "matt", title: "Lunch", from: `${DAY} 12:00`, to: `${DAY} 12:30` }), say("Asked Matt."));
    await h.send(PHONES.yadu, "lunch with matt tomorrow at noon");
    h.script(
      delegate("answer @yadu's lunch: yes"),
      call("answer_meeting", { tag: "@yadu", answer: "yes" }),
      (req) => {
        expect(isPersona(req)).toBe(true);
        expect(req.messages.at(-1)!.content).toContain(`Booked: 'Lunch' with @yadu, ${slot("12:00")}: waits on Matt's Ledger (their policy asks for that; the prompt goes out with the reply); on @yadu's calendar. @yadu was texted.`);
        return say("Lunch with Yadu at noon, on your Ledger.");
      },
    );
    await h.send(PHONES.matt, "yes please, lunch works");
    expect(h.to(PHONES.matt).at(-2)).toBe(`Lunch with Yadu at noon, on your Ledger.\n\nDone: 'Lunch' with @yadu, ${slot("12:00")}, is on @yadu's calendar. Your Ledger policy asks you to confirm it before it goes on your calendar: Add to calendar: Title Lunch, When ${slot("12:00")}, With @yadu`);
    expect(h.to(PHONES.matt).at(-1)).toBe(`Added 'Lunch' with @yadu ${slot("12:00")} to your calendar.`);
    expect(h.to(PHONES.yadu).at(-1)).toBe(`@matt said yes: 'Lunch' with @matt, ${slot("12:00")}, is on your calendar; @matt's side goes on theirs once they confirm it on their Ledger.`);
    expect(h.events(h.matt.id).map((e) => e.title)).toEqual(["Coffee", "Lunch"]);
    expect(h.remaining()).toBe(0);
  });

  it("a strict side whose Ledger is already busy cannot be booked yet; nothing changes", async () => {
    const h = await friends();
    h.db.setPolicy(h.yadu.id, strict);
    await coffeeProposed(h);
    let release!: () => void;
    h.devices[1]!.gate = new Promise((r) => (release = r));
    await h.app.approvals.request(h.yadu.id, { code: "PAY", id: newActionId(), fields: [{ label: "To", value: "@matt" }, { label: "Amount", value: "$1.00" }] });
    await h.app.handleInbound({ id: "busy1", handle: PHONES.yadu, text: "yes", images: [], at: new Date(), service: "dev" });
    expect(h.to(PHONES.yadu).at(-1)).toBe("Yadu's Ledger already has something waiting, and their policy asks it to confirm meetings, so this cannot be booked right now. Try again once that is done.");
    expect(h.db.meeting(1)!.status).toBe("proposed");
    expect(h.events(h.matt.id)).toHaveLength(0);
    release();
    await h.app.whenIdle();
    // The meeting text is no longer the last thing Yadu got, so the next yes goes through Jarvis.
    h.script(delegate("answer @matt's coffee: yes"), call("answer_meeting", { tag: "@matt", answer: "yes" }), say("Coffee with Matt at 9 is on your Ledger."));
    await h.send(PHONES.yadu, "yes");
    expect(h.db.meeting(1)!.status).toBe("confirmed");
    expect(h.events(h.matt.id)).toHaveLength(1);
    expect(h.devices[1]!.shown.at(-1)).toMatchObject({ code: "CAL", fields: expect.arrayContaining([{ label: "With", value: "@matt" }]) });
    expect(h.events(h.yadu.id)).toHaveLength(1);
    expect(h.remaining()).toBe(0);
  });
});
