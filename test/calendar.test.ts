import { describe, expect, it } from "vitest";
import { formatWhen, parseWhen } from "../src/format.js";
import { call, delegate, harness, PHONES, say } from "./helpers.js";

describe("calendar", () => {
  it("CAL is the owner's own event: signed on their Ledger, nobody else involved", async () => {
    const h = harness(2);
    const matt = await h.onboard("matt", 0);
    const yadu = await h.onboard("yadu", 1);
    h.befriend(matt.id, yadu.id);
    h.script(
      delegate("dentist tomorrow at noon"),
      call("propose_action", { code: "CAL", fields: [{ label: "Title", value: "Dentist" }, { label: "When", value: "2026-10-11 12:00-12:30" }] }),
      say("Dentist tomorrow at noon, coming up."),
    );
    await h.send(PHONES.matt, "dentist tomorrow at noon");
    expect(h.devices[0]!.shown.filter((a) => a.code === "CAL")).toEqual([
      expect.objectContaining({ fields: [{ label: "Title", value: "Dentist" }, { label: "When", value: "Sun Oct 11 12:00-12:30" }] }),
    ]);
    expect(h.devices[1]!.shown.filter((a) => a.code === "CAL")).toEqual([]);
    expect(h.to(PHONES.matt).some((t) => t.startsWith("Dentist tomorrow at noon, coming up.\n\nPlease confirm on your Ledger: Add to calendar"))).toBe(true);
    expect(h.to(PHONES.matt).at(-1)).toBe("Added 'Dentist' Sun Oct 11 12:00-12:30 to your calendar.");
    expect(h.db.events(matt.id, "2026-10-11T00:00", "2026-10-12T00:00")).toEqual([
      expect.objectContaining({ title: "Dentist", starts_at: "2026-10-11T12:00", ends_at: "2026-10-11T12:30", with_tag: null }),
    ]);
    expect(h.db.events(yadu.id, "2026-10-11T00:00", "2026-10-12T00:00")).toHaveLength(0);
    expect(h.to(PHONES.yadu).some((t) => /Dentist/.test(t))).toBe(false);
  });

  it("a rejected CAL changes nothing", async () => {
    const h = harness(1);
    const matt = await h.onboard("matt", 0);
    h.devices[0]!.policy = "reject";
    h.script(delegate("dentist"), call("propose_action", { code: "CAL", fields: [{ label: "Title", value: "Dentist" }, { label: "When", value: "2026-10-11 12:00-12:30" }] }), say("Dentist, coming up."));
    await h.send(PHONES.matt, "dentist tomorrow at noon");
    expect(h.db.events(matt.id, "2026-10-11T00:00", "2026-10-12T00:00")).toHaveLength(0);
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
