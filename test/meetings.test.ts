/** Meetings between friends: agent to agent, confirmed by text, never on a Ledger (src/meetings.ts). */
import { describe, expect, it } from "vitest";
import { buildAction } from "../src/agent/tools.js";
import { addMinutes, formatWhen, localNow } from "../src/format.js";
import { cleanTitle, freeSlots, pickSlot } from "../src/meetings.js";
import { call, delegate, harness, isEngine, isPersona, PHONES, say } from "./helpers.js";

/** Tomorrow's date, so no slot is ever in the past while a test runs. */
const DAY = addMinutes(localNow(), 24 * 60).slice(0, 10);
const at = (clock: string) => `${DAY}T${clock}`;
const slot = (start: string, minutes = 30) => formatWhen(at(start), addMinutes(at(start), minutes));

async function friends() {
  const h = harness(2);
  const matt = await h.onboard("matt", 0);
  const yadu = await h.onboard("yadu", 1);
  h.befriend(matt.id, yadu.id);
  const shown = () => [h.devices[0]!.shown.length, h.devices[1]!.shown.length];
  const events = (id: number) => h.db.events(id, `${DAY}T00:00`, `${DAY}T24:00`);
  return { ...h, matt, yadu, shown, events };
}

/** Matt asks for a meeting: persona delegates, engine calls propose_meeting with `args`, persona relays the report. */
function proposal(h: ReturnType<typeof harness>, args: Record<string, unknown>, reply: string, expectReport: (report: string) => void) {
  h.script(
    delegate("set up a meeting with yadu"),
    (req) => {
      expect(isEngine(req)).toBe(true);
      expect(req.system).toContain("propose_meeting");
      return call("propose_meeting", args);
    },
    (req) => {
      // The engine stops right after the meeting tool: the next call is the persona with the tool's own line as the report.
      expect(isPersona(req)).toBe(true);
      expectReport(String(req.messages.at(-1)!.content));
      return say(reply);
    },
  );
}

describe("meetings", () => {
  it("offers the slot nearest the time asked that is free for both, the friend says yes, both calendars get it, no Ledger", async () => {
    const h = await friends();
    h.db.addEvent(h.yadu.id, "Dentist (secret)", at("08:30"), at("09:15"), null, null);
    const before = h.shown();
    proposal(
      h,
      { tag: "yadu", title: "Meeting with @yadu", from: `${DAY} 08:30`, to: `${DAY} 10:00`, preferred: `${DAY} 09:00` },
      "Asked Yadu about tomorrow 9:15-9:45. I'll let you know.",
      (report) => expect(report).toBe(`Proposed to @yadu: 'Meeting' ${slot("09:15")}, free for both. @yadu was texted and must say yes before it is booked; nothing is on any calendar yet. Matt will be texted when they answer.`),
    );
    const sent = await h.send(PHONES.matt, "set up a meeting with yadu tomorrow around 9");
    expect(h.reactions.at(-1)).toEqual({ messageId: sent.id, emoji: "👍" });
    expect(h.to(PHONES.matt).at(-1)).toBe("Asked Yadu about tomorrow 9:15-9:45. I'll let you know.");
    expect(h.to(PHONES.matt).some((t) => /confirm on your Ledger/.test(t))).toBe(false);
    expect(h.to(PHONES.yadu).at(-1)).toBe(
      `@matt would like to meet: 'Meeting' ${slot("09:15")}. Any time ${formatWhen(at("08:30"), at("10:00"))} works for Matt. Reply 'yes' and it goes on both calendars, or name another time.`,
    );
    // Nothing on a device, nothing on a calendar, one meeting waiting for Yadu; the agents' exchange is on the record without titles.
    expect(h.shown()).toEqual(before);
    expect(h.events(h.matt.id)).toHaveLength(0);
    expect(h.events(h.yadu.id).map((e) => e.title)).toEqual(["Dentist (secret)"]);
    expect(h.db.openMeetings(h.yadu.id)).toEqual([expect.objectContaining({ proposer_id: h.matt.id, invitee_id: h.yadu.id, title: "Meeting", starts_at: at("09:15"), ends_at: at("09:45"), awaiting: h.yadu.id, status: "proposed" })]);
    const thread = h.db.peerThread("@matt", "@yadu");
    expect(thread.map((m) => m.from_tag)).toEqual(["@matt", "@yadu"]);
    expect(thread.map((m) => m.text).join(" ")).not.toMatch(/dentist/i);
    expect(thread[1]!.text).toContain("Free for both");

    // A plain yes skips the model entirely.
    const calls = h.requests.length;
    const yes = await h.send(PHONES.yadu, "Yes!");
    expect(h.requests.length).toBe(calls);
    expect(h.reactions.at(-1)).toEqual({ messageId: yes.id, emoji: "👍" });
    expect(h.to(PHONES.yadu).at(-1)).toBe(`Done: 'Meeting' with @matt, ${slot("09:15")}, is on both calendars.`);
    expect(h.to(PHONES.matt).at(-1)).toBe(`@yadu said yes: 'Meeting' with @yadu, ${slot("09:15")}, is on both calendars.`);
    expect(h.events(h.matt.id)).toEqual([expect.objectContaining({ title: "Meeting", starts_at: at("09:15"), ends_at: at("09:45"), with_tag: "@yadu", action_id: null })]);
    expect(h.events(h.yadu.id).at(-1)).toMatchObject({ title: "Meeting", starts_at: at("09:15"), ends_at: at("09:45"), with_tag: "@matt" });
    expect(h.db.openMeetings(h.matt.id)).toHaveLength(0);
    expect(h.shown()).toEqual(before);
    for (const id of [h.matt.id, h.yadu.id]) {
      expect(h.db.recentMessages(id).some((m) => m.role === "system" && JSON.stringify(m.content).includes("is on both calendars"))).toBe(true);
    }
    expect(h.remaining()).toBe(0);
  });

  it("a different time inside the asker's window is booked at once, with one text to each side", async () => {
    const h = await friends();
    proposal(h, { tag: "@yadu", title: "Coffee", from: `${DAY} 09:00`, to: `${DAY} 17:00` }, "Asked Yadu about 9:00-9:30 tomorrow.", (report) => expect(report).toMatch(/^Proposed to @yadu: 'Coffee' .* 09:00-09:30, free for both\./));
    await h.send(PHONES.matt, "set up coffee with yadu tomorrow, any time 9 to 5");
    expect(h.to(PHONES.yadu).at(-1)).toContain(`Any time ${formatWhen(at("09:00"), at("17:00"))} works for Matt.`);
    const yaduTexts = h.to(PHONES.yadu).length;
    h.script(
      (req) => {
        expect(req.messages.some((m) => m.role === "system" && String(m.content).includes("@matt would like to meet"))).toBe(true);
        return delegate("answer @matt's meeting proposal: 10 instead of 9", "Coffee, Yadu suggests 10:00");
      },
      (req) => {
        expect(req.system).toContain(`Meetings waiting for @yadu's answer (yes, no or another time; answer_meeting): @matt: 'Coffee' ${slot("09:00")} (any time ${formatWhen(at("09:00"), at("17:00"))} works for @matt).`);
        return call("answer_meeting", { tag: "matt", answer: "another time", when: `${DAY} 10:00` });
      },
      (req) => {
        expect(isPersona(req)).toBe(true);
        expect(req.messages.at(-1)!.content).toBe(`Booked: 'Coffee' with @matt, ${slot("10:00")}, is on both calendars. @matt was texted.`);
        return say("10 it is. Coffee with Matt tomorrow 10:00-10:30 is on both calendars.");
      },
    );
    await h.send(PHONES.yadu, "10 works better for me");
    expect(h.to(PHONES.yadu).slice(yaduTexts)).toEqual(["10 it is. Coffee with Matt tomorrow 10:00-10:30 is on both calendars."]);
    expect(h.to(PHONES.matt).at(-1)).toBe(`@yadu suggested ${slot("10:00")} instead, which works for you too: 'Coffee' with @yadu, ${slot("10:00")}, is on both calendars.`);
    expect(h.events(h.matt.id)).toEqual([expect.objectContaining({ title: "Coffee", starts_at: at("10:00"), ends_at: at("10:30"), with_tag: "@yadu" })]);
    expect(h.events(h.yadu.id)).toEqual([expect.objectContaining({ title: "Coffee", starts_at: at("10:00"), ends_at: at("10:30"), with_tag: "@matt" })]);
    expect(h.db.meeting(1)).toMatchObject({ status: "confirmed", starts_at: at("10:00") });
    expect(h.remaining()).toBe(0);
  });

  it("a time outside the window goes back to the asker, whose plain yes books it", async () => {
    const h = await friends();
    proposal(h, { tag: "yadu", title: "Coffee", from: `${DAY} 09:00`, to: `${DAY} 10:00` }, "Asked Yadu about 9 tomorrow.", () => {});
    await h.send(PHONES.matt, "coffee with yadu tomorrow morning at 9ish");
    h.script(
      delegate("answer @matt's meeting: 6pm instead"),
      call("answer_meeting", { tag: "@matt", answer: "another time", when: `${DAY} 18:00-18:30` }),
      (req) => {
        expect(req.messages.at(-1)!.content).toBe(`Offered ${slot("18:00")} for 'Coffee' to @matt, free for both. They were texted and must say yes before it is booked; nothing is on any calendar yet.`);
        return say("I suggested 6pm to Matt. I'll let you know.");
      },
    );
    await h.send(PHONES.yadu, "can we do 6pm instead?");
    expect(h.to(PHONES.matt).at(-1)).toBe(`@yadu suggests ${slot("18:00")} for 'Coffee' instead. Reply 'yes' and it goes on both calendars, or name another time.`);
    expect(h.db.openMeetings(h.matt.id)).toEqual([expect.objectContaining({ starts_at: at("18:00"), offered_by: h.yadu.id, awaiting: h.matt.id })]);
    expect(h.events(h.matt.id)).toHaveLength(0);
    const calls = h.requests.length;
    await h.send(PHONES.matt, "sure, works for me");
    expect(h.requests.length).toBe(calls);
    expect(h.to(PHONES.matt).at(-1)).toBe(`Done: 'Coffee' with @yadu, ${slot("18:00")}, is on both calendars.`);
    expect(h.to(PHONES.yadu).at(-1)).toBe(`@matt said yes: 'Coffee' with @matt, ${slot("18:00")}, is on both calendars.`);
    expect(h.events(h.matt.id)).toEqual([expect.objectContaining({ starts_at: at("18:00"), with_tag: "@yadu" })]);
    expect(h.events(h.yadu.id)).toEqual([expect.objectContaining({ starts_at: at("18:00"), with_tag: "@matt" })]);
    expect(h.remaining()).toBe(0);
  });

  it("a plain no declines it and tells the asker; nothing lands anywhere", async () => {
    const h = await friends();
    proposal(h, { tag: "yadu", title: "Coffee", from: `${DAY} 09:00`, to: `${DAY} 09:30` }, "Asked Yadu.", () => {});
    await h.send(PHONES.matt, "coffee with yadu tomorrow at 9");
    expect(h.to(PHONES.yadu).at(-1)).toBe(`@matt would like to meet: 'Coffee' ${slot("09:00")}. Reply 'yes' and it goes on both calendars, or name another time.`);
    const calls = h.requests.length;
    await h.send(PHONES.yadu, "no, sorry");
    expect(h.requests.length).toBe(calls);
    expect(h.to(PHONES.yadu).at(-1)).toBe("Understood. I told @matt you can't make it. Nothing is on either calendar.");
    expect(h.to(PHONES.matt).at(-1)).toBe(`@yadu can't make 'Coffee' ${slot("09:00")}. Ask me to try another time.`);
    expect(h.db.meeting(1)!.status).toBe("declined");
    expect(h.events(h.matt.id)).toHaveLength(0);
    expect(h.events(h.yadu.id)).toHaveLength(0);
    // With nothing waiting, a yes is just a message for the model.
    h.script(say("Yes to what?"));
    await h.send(PHONES.yadu, "yes");
    expect(h.to(PHONES.yadu).at(-1)).toBe("Yes to what?");
    expect(h.remaining()).toBe(0);
  });

  it("the yes shortcut only answers the meeting text itself; after any other exchange, the model decides", async () => {
    const h = await friends();
    proposal(h, { tag: "yadu", title: "Coffee", from: `${DAY} 09:00`, to: `${DAY} 09:30` }, "Asked Yadu.", () => {});
    await h.send(PHONES.matt, "coffee with yadu tomorrow at 9");
    h.script(say("Matt is @matt, your friend here."));
    await h.send(PHONES.yadu, "who is matt again?");
    h.script(
      (req) => {
        expect(isPersona(req)).toBe(true);
        return delegate("answer @matt's meeting proposal: yes");
      },
      call("answer_meeting", { tag: "@matt", answer: "yes" }),
      (req) => {
        expect(req.messages.at(-1)!.content).toBe(`Booked: 'Coffee' with @matt, ${slot("09:00")}, is on both calendars. @matt was texted.`);
        return say("Booked: coffee with Matt tomorrow 9:00-9:30.");
      },
    );
    await h.send(PHONES.yadu, "ok");
    expect(h.to(PHONES.yadu).at(-1)).toBe("Booked: coffee with Matt tomorrow 9:00-9:30.");
    expect(h.events(h.yadu.id)).toHaveLength(1);
    expect(h.remaining()).toBe(0);
  });

  it("an exact time that is busy for the friend is refused with alternatives, and nothing is sent", async () => {
    const h = await friends();
    h.db.addEvent(h.yadu.id, "Standup", at("09:00"), at("10:00"), null, null);
    h.db.addEvent(h.matt.id, "Gym", at("08:00"), at("08:30"), null, null);
    const yaduTexts = h.to(PHONES.yadu).length;
    h.script(
      delegate("meeting with yadu tomorrow at 9"),
      call("propose_meeting", { tag: "yadu", title: "Sync", from: `${DAY} 09:00`, to: `${DAY} 09:30` }),
      (req) => {
        expect(req.messages.at(-1)!.content).toBe(
          `Error: no 30-minute slot in ${slot("09:00")} is free for both Matt and @yadu. Free for both that day: ${slot("08:30")}, ${slot("10:00")}, ${slot("10:15")}. Ask Matt which time to offer; propose_meeting again with it.`,
        );
        return say("9 is taken on Yadu's side. Free for both: 8:30, 10:00, 10:15. Which one?");
      },
      say("Yadu is busy at 9. 8:30 or 10 work for both of you; which do you want?"),
    );
    await h.send(PHONES.matt, "meeting with yadu tomorrow at 9");
    expect(h.to(PHONES.matt).at(-1)).toBe("Yadu is busy at 9. 8:30 or 10 work for both of you; which do you want?");
    expect(h.to(PHONES.yadu)).toHaveLength(yaduTexts);
    expect(h.db.openMeetings(h.matt.id)).toHaveLength(0);
    expect(h.db.peerThread("@matt", "@yadu")).toHaveLength(0);
  });

  it("a new proposal to the same friend replaces the one on the table", async () => {
    const h = await friends();
    proposal(h, { tag: "yadu", title: "Coffee", from: `${DAY} 09:00`, to: `${DAY} 09:30` }, "Asked.", () => {});
    await h.send(PHONES.matt, "coffee with yadu tomorrow at 9");
    proposal(h, { tag: "yadu", title: "Coffee", from: `${DAY} 14:00`, to: `${DAY} 14:30` }, "Asked again.", () => {});
    await h.send(PHONES.matt, "actually make it 2pm");
    expect(h.to(PHONES.yadu).at(-1)).toBe(`@matt would like to meet: 'Coffee' ${slot("14:00")} (instead of ${slot("09:00")}). Reply 'yes' and it goes on both calendars, or name another time.`);
    expect(h.db.meeting(1)!.status).toBe("cancelled");
    expect(h.db.openMeetings(h.yadu.id)).toEqual([expect.objectContaining({ id: 2, starts_at: at("14:00") })]);
  });

  it("only friends; CAL no longer takes a With field", async () => {
    const h = harness(2);
    const matt = await h.onboard("matt", 0);
    await h.onboard("yadu", 1);
    h.script(
      delegate("meeting with yadu"),
      call("propose_meeting", { tag: "yadu", from: `${DAY} 09:00`, to: `${DAY} 17:00` }),
      (req) => {
        expect(req.messages.at(-1)!.content).toBe("Refused: @yadu is not a friend, so no meeting can be arranged with them. The owner can send a friend request (FRQ) first.");
        return say("@yadu is not a friend yet.");
      },
      say("You and Yadu aren't friends yet. Want me to send a request?"),
    );
    await h.send(PHONES.matt, "meeting with yadu tomorrow");
    expect(h.db.openMeetings(matt.id)).toHaveLength(0);
    expect(await buildAction(h.db, matt, "CAL", [{ label: "Title", value: "Lunch" }, { label: "When", value: `${DAY} 12:00-12:30` }, { label: "With", value: "@yadu" }])).toBe(
      "Error: CAL is for the owner's own events only. A meeting with a friend is propose_meeting, which needs no Ledger.",
    );
  });

  it("finds slots on the grid, skips the past and busy times, keeps office hours across days, and picks the nearest", () => {
    const busy = [{ start: "2026-10-12T09:00", end: "2026-10-12T09:45" }];
    expect(freeSlots(busy, "2026-10-12T08:50", "2026-10-12T10:30", 30, "2026-10-12T08:00")).toEqual(["2026-10-12T09:45", "2026-10-12T10:00"]);
    expect(freeSlots([], "2026-10-12T09:00", "2026-10-12T10:00", 30, "2026-10-12T09:20")).toEqual(["2026-10-12T09:30"]);
    expect(freeSlots([], "2026-10-12T09:00", "2026-10-12T10:00", 60, "2026-10-12T09:01")).toEqual([]);
    const week = freeSlots([], "2026-10-12T00:00", "2026-10-14T00:00", 60, "2026-10-01T00:00");
    expect(week[0]).toBe("2026-10-12T08:00");
    expect(week.every((s) => s.slice(11) >= "08:00" && s.slice(11) <= "20:00")).toBe(true);
    expect(week.filter((s) => s.startsWith("2026-10-13"))).toHaveLength(49);
    expect(pickSlot(["2026-10-12T08:30", "2026-10-12T09:15", "2026-10-12T09:30"], "2026-10-12T09:00")).toBe("2026-10-12T09:15");
    expect(pickSlot(["2026-10-12T08:30", "2026-10-12T09:30"], "2026-10-12T09:00")).toBe("2026-10-12T08:30");
    expect(pickSlot(["2026-10-12T08:30", "2026-10-12T09:30"])).toBe("2026-10-12T08:30");
    const yadu = { tag: "@yadu", username: "yadu_k", display_name: "Yadu K" } as Parameters<typeof cleanTitle>[1];
    expect(cleanTitle("Meeting with @yadu", yadu)).toBe("Meeting");
    expect(cleanTitle("coffee w/ Yadu", yadu)).toBe("Coffee");
    expect(cleanTitle("  Project sync  ", yadu)).toBe("Project sync");
    expect(cleanTitle("", yadu)).toBe("Meeting");
  });
});
