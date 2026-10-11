import { describe, expect, it } from "vitest";
import { formatWhen, parseWhen } from "../src/format.js";
import { call, delegate, harness, isPersona, PHONES, say } from "./helpers.js";

const dentist = call("propose_action", { code: "CAL", fields: [{ label: "Title", value: "Dentist" }, { label: "When", value: "2026-10-11 12:00-12:30" }] });

describe("calendar", () => {
  it("the owner's own event is added at once under the default policy: no Ledger, the engine reports it done", async () => {
    const h = harness(2);
    const matt = await h.onboard("matt", 0);
    const yadu = await h.onboard("yadu", 1);
    h.befriend(matt.id, yadu.id);
    const shown = h.devices[0]!.shown.length;
    h.script(delegate("dentist tomorrow at noon"), dentist, (req) => {
      expect(isPersona(req)).toBe(true);
      expect(req.messages.at(-1)!.content).toBe("Added 'Dentist' Sun Oct 11 12:00-12:30 to your calendar. Done at once: @matt's Ledger policy does not ask the Ledger for this.");
      return say("Dentist tomorrow at noon, on the calendar.");
    });
    await h.send(PHONES.matt, "dentist tomorrow at noon");
    expect(h.to(PHONES.matt).at(-1)).toBe("Dentist tomorrow at noon, on the calendar.");
    expect(h.devices[0]!.shown).toHaveLength(shown);
    expect(h.db.events(matt.id, "2026-10-11T00:00", "2026-10-12T00:00")).toEqual([
      expect.objectContaining({ title: "Dentist", starts_at: "2026-10-11T12:00", ends_at: "2026-10-11T12:30", with_tag: null, action_id: expect.any(String) }),
    ]);
    // Logged like any action, executed with no signature: the policy let it through.
    const logged = h.db.action(h.db.events(matt.id, "2026-10-11T00:00", "2026-10-12T00:00")[0]!.action_id!)!;
    expect(logged).toMatchObject({ code: "CAL", status: "executed", signature: null, account_id: matt.id });
    expect(h.db.events(yadu.id, "2026-10-11T00:00", "2026-10-12T00:00")).toHaveLength(0);
    expect(h.to(PHONES.yadu).some((t) => /Dentist/.test(t))).toBe(false);
    expect(h.remaining()).toBe(0);
  });

  it("under a strict policy the same event is signed on the owner's Ledger, and a rejection changes nothing", async () => {
    const h = harness(1);
    const matt = await h.onboard("matt", 0);
    h.db.setPolicy(matt.id, JSON.stringify({ preset: "strict", overrides: {} }));
    h.script(delegate("dentist tomorrow at noon"), dentist, say("Dentist tomorrow at noon, coming up."));
    await h.send(PHONES.matt, "dentist tomorrow at noon");
    expect(h.devices[0]!.shown.filter((a) => a.code === "CAL")).toEqual([
      expect.objectContaining({ fields: [{ label: "Title", value: "Dentist" }, { label: "When", value: "Sun Oct 11 12:00-12:30" }] }),
    ]);
    expect(h.to(PHONES.matt).some((t) => t.startsWith("Dentist tomorrow at noon, coming up.\n\nPlease confirm on your Ledger: Add to calendar"))).toBe(true);
    expect(h.to(PHONES.matt).at(-1)).toBe("Added 'Dentist' Sun Oct 11 12:00-12:30 to your calendar.");
    const signed = h.db.events(matt.id, "2026-10-11T00:00", "2026-10-12T00:00");
    expect(signed).toEqual([expect.objectContaining({ title: "Dentist", with_tag: null, action_id: expect.any(String) })]);
    expect(h.db.action(signed[0]!.action_id!)).toMatchObject({ status: "executed", signature: expect.any(String) });

    h.devices[0]!.policy = "reject";
    h.script(delegate("gym"), call("propose_action", { code: "CAL", fields: [{ label: "Title", value: "Gym" }, { label: "When", value: "2026-10-11 18:00-19:00" }] }), say("Gym, coming up."));
    await h.send(PHONES.matt, "gym tomorrow at 6");
    expect(h.db.events(matt.id, "2026-10-11T00:00", "2026-10-12T00:00")).toHaveLength(1);
    expect(h.to(PHONES.matt).at(-1)).toBe("You rejected it on your Ledger, so nothing happened.");
  });

  it("parses and formats the When field", () => {
    const now = new Date("2026-10-10T20:00:00Z");
    expect(parseWhen("2026-10-11 12:00-12:30", now)).toEqual({ start: "2026-10-11T12:00", end: "2026-10-11T12:30" });
    expect(parseWhen("Sun Oct 11 12:00-12:30", now)).toEqual({ start: "2026-10-11T12:00", end: "2026-10-11T12:30" });
    expect(parseWhen("Oct 11 2pm-3:30pm", now)).toEqual({ start: "2026-10-11T14:00", end: "2026-10-11T15:30" });
    expect(parseWhen("2026-10-11T23:00 to 2026-10-12T01:00", now)).toEqual({ start: "2026-10-11T23:00", end: "2026-10-12T01:00" });
    expect(parseWhen("tomorrow at noon", now)).toBeUndefined();
    expect(formatWhen("2026-10-11T12:00", "2026-10-11T12:30")).toBe("Sun Oct 11 12:00-12:30");
  });
});
