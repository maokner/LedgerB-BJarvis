import { describe, expect, it } from "vitest";
import { call, delegate, harness, PHONES, say } from "./helpers.js";

describe("friends and agent-to-agent talk", () => {
  it("FRQ and FAC are signed on each person's own device; peers talk only after acceptance and only share free/busy", async () => {
    const h = harness(2);
    const matt = await h.onboard("matt", 0);
    const yadu = await h.onboard("yadu", 1);
    h.db.addEvent(yadu.id, "Dentist (secret)", "2026-10-11T14:00", "2026-10-11T15:00", null, null);

    // Before they are friends, message_agent is refused without running a peer turn.
    h.script(
      delegate("check if yadu is free tomorrow"),
      call("message_agent", { tag: "@yadu", text: "Is Yadu free tomorrow?" }),
      (req) => {
        expect(req.messages.at(-1)!.content).toMatch(/^Refused: @yadu is not a friend/);
        return say("@yadu is not a friend, so their agent will not answer. A friend request (FRQ) would fix that.");
      },
      say("You and @yadu aren't friends yet. Want me to send a friend request?"),
    );
    await h.send(PHONES.matt, "is yadu free tomorrow?");
    expect(h.db.peerThread("@matt", "@yadu")).toHaveLength(0);

    // Friend request, signed on Matt's device.
    h.script(delegate("send @yadu a friend request"), call("propose_action", { code: "FRQ", fields: [{ label: "To", value: "yadu" }] }), say("Friend request for @yadu is ready."));
    await h.send(PHONES.matt, "add @yadu as a friend");
    expect(h.devices[0]!.shown.at(-1)).toMatchObject({ code: "FRQ", fields: [{ label: "To", value: "@yadu" }] });
    expect(h.db.friendship(matt.id, yadu.id)).toEqual({ status: "pending", requested_by: matt.id });
    expect(h.to(PHONES.yadu).at(-1)).toBe(
      "@matt wants to connect your agents (so they can schedule with each other and pass notes between you). Reply 'accept @matt' to connect.",
    );

    // "accept" skips the model and is signed on Yadu's device.
    const calls = h.requests.length;
    const accept = await h.send(PHONES.yadu, "Accept");
    expect(h.requests.length).toBe(calls);
    expect(h.reactions.at(-1)).toEqual({ messageId: accept.id, emoji: "👍" });
    expect(h.devices[1]!.shown.at(-1)).toMatchObject({ code: "FAC", fields: [{ label: "From", value: "@matt" }] });
    expect(h.db.friendship(matt.id, yadu.id)?.status).toBe("accepted");
    expect(h.to(PHONES.yadu)).toContain("Please confirm on your Ledger: Accept friend: From @matt");
    expect(h.to(PHONES.yadu).at(-1)).toBe("You and @matt are now friends. Your agents can schedule with each other and pass notes between you.");
    expect(h.to(PHONES.matt).at(-1)).toBe("@yadu accepted your friend request. Your agents can now talk to each other.");

    // Now the peer turn runs on Yadu's agent with only get_free_busy.
    h.script(
      delegate("find when yadu is free tomorrow afternoon"),
      call("message_agent", { tag: "@yadu", text: "When is Yadu free tomorrow afternoon for 30 minutes?" }),
      (req) => {
        expect(req.system).toContain("agent of @yadu");
        expect(req.system).toContain("@matt's agent");
        expect(req.tools.map((t) => t.name)).toEqual(["get_free_busy"]);
        expect(req.messages).toEqual([{ role: "user", content: "When is Yadu free tomorrow afternoon for 30 minutes?" }]);
        return call("get_free_busy", { from: "2026-10-11T12:00", to: "2026-10-11T18:00" });
      },
      (req) => {
        const result = String(req.messages.at(-1)!.content);
        expect(result).toContain('"start":"2026-10-11T14:00"');
        expect(result).not.toMatch(/dentist/i);
        return say("Free 2026-10-11 12:00-12:30, 13:00-13:30, 15:00-15:30.");
      },
      (req) => {
        expect(req.messages.at(-1)!.content).toContain("@yadu's agent replied: Free 2026-10-11 12:00-12:30, 13:00-13:30, 15:00-15:30.");
        return say("@yadu is free 2026-10-11 12:00-12:30, 13:00-13:30 and 15:00-15:30. Nothing booked.");
      },
      (req) => {
        expect(req.messages.at(-1)).toMatchObject({ role: "tool", content: "@yadu is free 2026-10-11 12:00-12:30, 13:00-13:30 and 15:00-15:30. Nothing booked." });
        return say("Yadu is free at 12:00, 13:00 or 15:00 tomorrow.");
      },
    );
    await h.send(PHONES.matt, "when is yadu free tomorrow afternoon?");
    expect(h.to(PHONES.yadu).at(-1)).toBe("@matt's agent asked when you are free. I only shared free and busy times, nothing else.");
    expect(h.to(PHONES.matt).slice(-2)).toEqual(["Checking with @yadu's agent. It only shares when Yadu is free or busy.", "Yadu is free at 12:00, 13:00 or 15:00 tomorrow."]);
    expect(h.db.peerThread("@yadu", "@matt").map((m) => m.from_tag)).toEqual(["@matt", "@yadu"]);
    expect(h.remaining()).toBe(0);
  });

  it("a thank you note reaches the friend as a text from their Jarvis, with nothing on either Ledger and no calendar talk", async () => {
    const h = harness(2);
    const matt = await h.onboard("matt", 0);
    const gabriel = await h.onboard("gabriel", 1);

    // Not friends yet: refused without reaching Matt.
    h.script(
      delegate("send @matt a thank you note"),
      call("send_note", { tag: "@matt", text: "Thanks for the dollar!" }),
      (req) => {
        expect(req.messages.at(-1)!.content).toBe("Refused: @matt is not a friend, so no note can reach them. The owner can send a friend request (FRQ) first.");
        return say("@matt is not a friend yet, so the note cannot be delivered. A friend request (FRQ) would fix that.");
      },
      say("You and @matt aren't friends yet, so I can't pass that on. Want me to send a friend request?"),
    );
    const mattTexts = h.to(PHONES.matt).length;
    await h.send(PHONES.gabriel, "send matt a thank you note");
    expect(h.to(PHONES.matt)).toHaveLength(mattTexts);

    h.befriend(matt.id, gabriel.id);
    const shown = [h.devices[0]!.shown.length, h.devices[1]!.shown.length];
    h.script(
      delegate("send @matt a thank you note for the dollar"),
      (req) => {
        expect(req.system).toContain("call send_note");
        return call("send_note", { tag: "matt", text: "Thanks for the dollar, Matt!  Lunch is on me next time." });
      },
      (req) => {
        expect(req.messages.at(-1)!.content).toBe('Delivered to @matt as a text from their Jarvis: "Thanks for the dollar, Matt! Lunch is on me next time."');
        return say('Delivered to @matt: "Thanks for the dollar, Matt! Lunch is on me next time."');
      },
      say("Sent. Matt has your thank you."),
    );
    const sent = await h.send(PHONES.gabriel, "FIRE! send him a thank you note");
    expect(h.reactions.at(-1)).toEqual({ messageId: sent.id, emoji: "👍" });
    expect(h.to(PHONES.matt).at(-1)).toBe("@gabriel says: Thanks for the dollar, Matt! Lunch is on me next time.");
    expect(h.to(PHONES.gabriel).at(-1)).toBe("Sent. Matt has your thank you.");
    // No "Checking with @matt's agent" progress text, no peer turn, nothing on a Ledger.
    expect(h.to(PHONES.gabriel).some((t) => /checking with|free or busy/i.test(t))).toBe(false);
    expect(h.to(PHONES.matt).some((t) => /asked when you are free/i.test(t))).toBe(false);
    expect(h.db.peerThread("@matt", "@gabriel")).toHaveLength(0);
    expect([h.devices[0]!.shown.length, h.devices[1]!.shown.length]).toEqual(shown);
    expect(h.db.pendingAction(matt.id)).toBeUndefined();
    expect(h.db.pendingAction(gabriel.id)).toBeUndefined();

    // Matt's next turn sees the note in his history and can answer it the same way.
    h.script(
      (req) => {
        expect(req.messages.some((m) => m.role === "system" && String(m.content).includes('@gabriel sent Matt a note, delivered as a text: "Thanks for the dollar, Matt! Lunch is on me next time."'))).toBe(true);
        return delegate("send @gabriel a note saying you're welcome");
      },
      call("send_note", { tag: "@gabriel", text: "You're welcome, any time." }),
      say('Delivered to @gabriel: "You\'re welcome, any time."'),
      say("Told him. He is welcome, any time."),
    );
    await h.send(PHONES.matt, "tell gabe you're welcome");
    expect(h.to(PHONES.gabriel).at(-1)).toBe("@matt says: You're welcome, any time.");
    expect(h.remaining()).toBe(0);
  });

  it("accept with several pending requests goes to the agent instead", async () => {
    const h = harness(3);
    const matt = await h.onboard("matt", 0);
    const gabriel = await h.onboard("gabriel", 1);
    const yadu = await h.onboard("yadu", 2);
    h.db.requestFriend(matt.id, yadu.id);
    h.db.requestFriend(gabriel.id, yadu.id);
    h.script(say("Accept @matt or @gabriel?"));
    await h.send(PHONES.yadu, "accept");
    expect(h.to(PHONES.yadu).at(-1)).toBe("Accept @matt or @gabriel?");
    await h.send(PHONES.yadu, "accept @gabriel");
    expect(h.devices[2]!.shown.at(-1)).toMatchObject({ code: "FAC", fields: [{ label: "From", value: "@gabriel" }] });
    expect(h.db.friendship(gabriel.id, yadu.id)?.status).toBe("accepted");
    expect(h.db.friendship(matt.id, yadu.id)?.status).toBe("pending");
  });
});
