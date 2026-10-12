import { Wallet } from "ethers";
import { afterEach, describe, expect, it } from "vitest";
import { verifyActionSignature } from "../src/actions.js";
import { resolveTag } from "../src/agent/tools.js";
import { welcomeLine } from "../src/agent/persona.js";
import { createApp, greeting } from "../src/app.js";
import { openDb } from "../src/db.js";
import { askEthApp, type EthRequest } from "../src/device/eth-tx.js";
import { combineDeviceManagers, createRemoteDeviceManager } from "../src/device/remote.js";
import { baseMoney } from "../src/money.js";
import { startWebServer, type WebServer } from "../src/web/server.js";
import { call, delegate, fakeChannel, fakeEthApp, fakeEthDevices, harness, inbound, PHONES, say, scriptedModel, stubChain, tgInbound } from "./helpers.js";

describe("onboarding", () => {
  it("creates accounts bound to the free device, one per Ledger", async () => {
    const h = harness(2);
    h.script((req) => {
      expect(req.tools.map((t) => t.name)).toEqual(["choose_tag"]);
      expect(req.system).toContain("no account yet");
      expect(req.messages).toEqual([{ role: "user", content: "hi" }]);
      return say(`${greeting("AgentSign")} 👋`);
    });
    await h.send("(415) 555-0001", "hi");
    expect(h.to(PHONES.matt)).toEqual([greeting("AgentSign")]); // emoji stripped

    // Two fresh devices: refuse rather than guess whose is whose.
    await h.send(PHONES.matt, "@Matt");
    expect(h.to(PHONES.matt).at(-1)).toBe(
      "I see more than one new Ledger and can't tell which is yours. Leave only yours plugged in with AgentSign open, then send me @matt again.",
    );
    const [d0, d1] = h.devices;
    expect(d0!.shown.length + d1!.shown.length).toBe(0);

    d1!.connected = false;
    await h.send(PHONES.matt, "@Matt");
    expect(d0!.shown.at(-1)!.code).toBe("ACC");
    expect(d0!.shown.at(-1)!.fields).toEqual([
      { label: "Tag", value: "@matt" },
      { label: "Phone", value: PHONES.matt },
    ]);
    const matt = h.db.accountByTag("@matt")!;
    expect(matt.pubkey).toBe(d0!.info.pubkey);
    expect(matt.balance_cents).toBe(25_000);
    expect(h.db.accountByHandle(PHONES.matt)?.id).toBe(matt.id);
    expect(h.to(PHONES.matt).slice(2)).toEqual([
      "@matt it is. Your Ledger now shows 'Create account'. Approve it there and you're set.",
      "You're in: @matt is yours, with $250.00 of demo money to play with. Try: send $5 to @gabriel, or add @yadu as a friend.",
    ]);
    const row = h.db.action(d0!.shown.at(-1)!.id)!;
    expect(row.status).toBe("executed");
    expect(verifyActionSignature(matt.pubkey, d0!.shown.at(-1)!, row.signature!)).toBe(true);

    // Second person: device 0 is bound, so device 1 is the only free one.
    d1!.connected = true;
    await h.send(PHONES.gabriel, "@gabriel");
    expect(h.db.accountByTag("@gabriel")!.pubkey).toBe(d1!.info.pubkey);
    expect(d1!.shown).toHaveLength(1);
    expect(h.to(PHONES.gabriel).at(-1)).toBe("You're in: @gabriel is yours, with $250.00 of demo money to play with. Try: send $5 to @yadu, or add @matt as a friend.");

    // Third person: tag taken, then no free device.
    await h.send(PHONES.yadu, "@matt");
    expect(h.to(PHONES.yadu).at(-1)).toBe("@matt is taken, I'm afraid. Which other tag would you like?");
    await h.send(PHONES.yadu, "@yadu");
    expect(h.to(PHONES.yadu).at(-1)).toBe("I don't see a Ledger without an account. Plug yours into the Mac, unlock it, open AgentSign, then send me @yadu again.");
    expect(h.db.accountByTag("@yadu")).toBeUndefined();
    expect(h.remaining()).toBe(0);
    expect(h.requests).toHaveLength(1); // only "hi": an @tag skips the model
  });

  it("refuses an address the Ledger cannot show exactly", async () => {
    const h = harness(1);
    await h.send("josé@icloud.com", "@jose");
    expect(h.to("josé@icloud.com").at(-1)).toBe("Your Ledger can't display this address exactly, so I can't use it. Please message me from another account.");
    expect(h.devices[0]!.shown).toHaveLength(0);
  });

  it("does nothing when the person rejects, and ignores duplicate message ids", async () => {
    const h = harness(1);
    h.devices[0]!.policy = "reject";
    await h.send(PHONES.matt, "@matt");
    expect(h.db.accountByTag("@matt")).toBeUndefined();
    expect(h.to(PHONES.matt).at(-1)).toBe("You rejected it on your Ledger, so nothing happened.");

    h.devices[0]!.policy = "approve";
    const msg = { id: "dup", handle: PHONES.matt, text: "@matt", images: [], at: new Date(), service: "dev" as const };
    await h.app.handleInbound(msg);
    await h.app.handleInbound(msg);
    await h.app.whenIdle();
    expect(h.devices[0]!.shown.filter((a) => a.code === "ACC")).toHaveLength(2);
    expect(h.db.accountByTag("@matt")).toBeDefined();
  });

  it("a stranger chats with the restricted persona, which picks the tag and hands it to onboarding", async () => {
    const h = harness(1);
    h.script(say("I'm AgentSign, an agent you text that only acts after you approve on your Ledger. What tag do you want?"), (req) => {
      expect(req.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      return call("choose_tag", { tag: "gabe" });
    });
    await h.send(PHONES.gabriel, "yo who are you");
    expect(h.devices[0]!.shown).toHaveLength(0);
    await h.send(PHONES.gabriel, "call me gabe");
    expect(h.devices[0]!.shown.at(-1)).toMatchObject({ code: "ACC", fields: [{ label: "Tag", value: "@gabe" }, { label: "Phone", value: PHONES.gabriel }] });
    expect(h.db.accountByTag("@gabe")?.pubkey).toBe(h.devices[0]!.info.pubkey);
    expect(h.to(PHONES.gabriel)[1]).toBe("@gabe it is. Your Ledger now shows 'Create account'. Approve it there and you're set.");
  });

  it("falls back to a fixed greeting when the model is down, and asks again for a bad tag", async () => {
    const h = harness(1);
    h.script(() => {
      throw new Error("xAI 503");
    }, call("choose_tag", { tag: "x" }));
    await h.send(PHONES.matt, "hello?");
    expect(h.to(PHONES.matt)).toEqual([greeting("AgentSign")]);
    await h.send(PHONES.matt, "x");
    expect(h.to(PHONES.matt).at(-1)).toBe("Tags are 2 to 24 letters, numbers or underscores, like @matt. Which would you like?");
    expect(h.devices[0]!.shown).toHaveLength(0);
  });
});

describe("Telegram sign-up (the @username is the default tag)", () => {
  const welcome = welcomeLine("@mokner", "AgentSign", false);

  it("welcomes with the username as the tag, 'go' signs it on the USB Ledger, and the profile follows every message", async () => {
    const h = harness(1);
    await h.deliver(tgInbound(111, "/start", "Mokner", "Matt Okner"));
    expect(h.to("tg:111")).toEqual([welcome]);
    await h.deliver(tgInbound(111, "Go!", "Mokner", "Matt Okner"));
    expect(h.devices[0]!.shown.at(-1)).toMatchObject({ code: "ACC", fields: [{ label: "Tag", value: "@mokner" }, { label: "Telegram", value: "@mokner" }] });
    expect(h.to("tg:111").slice(1)).toEqual([
      "@mokner it is. Your Ledger now shows 'Create account'. Approve it there and you're set.",
      "You're in: @mokner is yours, with $250.00 of demo money to play with. Try: send $5 to @gabriel, or add @yadu as a friend.",
    ]);
    expect(h.db.accountByHandle("tg:111")).toMatchObject({ tag: "@mokner", username: "mokner", display_name: "Matt Okner" });
    expect(h.requests).toHaveLength(0); // no model call for any of it

    h.script((req) => {
      expect(req.system).toContain("on Telegram, where they are @matt_o");
      return say("Good evening, Matt.");
    });
    await h.deliver(tgInbound(111, "hi", "Matt_O", "Matt O."));
    expect(h.db.accountByHandle("tg:111")).toMatchObject({ tag: "@mokner", username: "matt_o", display_name: "Matt O." });
    expect(h.db.accountByUsername("@Matt_O")?.tag).toBe("@mokner");
  });

  it("asks for a tag without a usable username, and the Ledger shows the Telegram id", async () => {
    const h = harness(2);
    h.db.createAccount("@gabe", "00".repeat(32), "tg:999", 0);
    h.script(say("Which tag would you like?"));
    await h.deliver(tgInbound(222, "/start", "gabe")); // @gabe is taken, so no default
    expect(h.to("tg:222")).toEqual([greeting("AgentSign")]);
    await h.deliver(tgInbound(222, "hello", "gabe"));
    expect(h.to("tg:222").at(-1)).toBe("Which tag would you like?");
    h.devices[1]!.connected = false;
    await h.deliver(tgInbound(222, "@gabriel"));
    expect(h.devices[0]!.shown.at(-1)!.fields).toEqual([{ label: "Tag", value: "@gabriel" }, { label: "Telegram", value: "id 222" }]);
    expect(h.db.accountByHandle("tg:222")).toMatchObject({ tag: "@gabriel", username: null });
  });

  it("while a USB sign-up waits, says to approve or cancel, and 'cancel' or /start cancels it", async () => {
    const h = harness(1);
    const device = h.devices[0]!;
    let press!: () => void;
    device.gate = new Promise((r) => (press = r));
    const tg = (text: string) => h.app.handleInbound(tgInbound(555, text, "mokner"));
    await tg("go");
    for (let i = 0; i < 100 && !device.shown.length; i++) await new Promise((r) => setTimeout(r, 5));
    await tg("go");
    expect(h.to("tg:555").at(-1)).toBe("Still waiting on 'Create account' for @mokner. Approve it on your Ledger, or say 'cancel' to start over.");
    await tg("/start");
    expect(h.to("tg:555").at(-1)).toBe("Cancelled. Say 'go' when you're ready.");
    expect(h.db.action(device.shown[0]!.id)).toMatchObject({ status: "expired", error: "cancelled" });
    press(); // the old request is answered late: it must not create anything
    device.gate = undefined;
    await h.app.whenIdle();
    expect(h.db.accountByHandle("tg:555")).toBeUndefined();
    await h.deliver(tgInbound(555, "go", "mokner"));
    expect(h.db.accountByHandle("tg:555")?.tag).toBe("@mokner");
    expect(h.to("tg:555").at(-1)).toMatch(/^You're in: @mokner is yours/);
  });

  it("finds people by tag or Telegram username, and says how to join when nobody matches", () => {
    const h = harness(0);
    const matt = h.db.createAccount("@matt", "01".repeat(32), "tg:1", 0);
    const yadu = h.db.createAccount("@yadu", "02".repeat(32), "tg:2", 0);
    h.db.setProfile(yadu.id, "yadu_tg", "Yadu");
    expect(resolveTag(h.db, matt, "@Yadu_TG")).toMatchObject({ tag: "@yadu" });
    process.env.TELEGRAM_BOT_USERNAME = "AgentSignBot";
    try {
      expect(resolveTag(h.db, matt, "@zelda")).toMatch(/they need to open @AgentSignBot on Telegram, press Start and set up with their own Ledger first/);
    } finally {
      delete process.env.TELEGRAM_BOT_USERNAME;
    }
  });
});

describe("people by phone number or email (iMessage handles)", () => {
  const env = { CHANNEL: process.env.CHANNEL, PHOTON_NUMBER: process.env.PHOTON_NUMBER };
  afterEach(() => {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  });

  it("resolves an exact number in any format, or an email, and never guesses from digits", () => {
    process.env.CHANNEL = "photon";
    process.env.PHOTON_NUMBER = "+14155550199";
    const h = harness(0);
    const matt = h.db.createAccount("@matt", "01".repeat(32), PHONES.matt, 0);
    h.db.createAccount("@gabriel", "02".repeat(32), PHONES.gabriel, 0);
    h.db.createAccount("@yadu", "03".repeat(32), "yadu@icloud.com", 0);
    expect(resolveTag(h.db, matt, "+1 (415) 555-0002")).toMatchObject({ tag: "@gabriel" });
    expect(resolveTag(h.db, matt, "415-555-0002")).toMatchObject({ tag: "@gabriel" });
    expect(resolveTag(h.db, matt, "Yadu@iCloud.com")).toMatchObject({ tag: "@yadu" });
    // A number nobody signed up from is not a prefix match on anyone, and the hint says how to join on iMessage.
    const missing = resolveTag(h.db, matt, "+1 415 555 0009");
    expect(missing).toMatch(/^Error: nobody on AgentSign has the number or email "\+1 415 555 0009"/);
    expect(missing).toContain("they need to text Jarvis at +14155550199 on iMessage and set up with their own Ledger first");
    expect(resolveTag(h.db, matt, "@zelda")).not.toMatch(/telegram/i);
    // Tags and the fuzzy rules still work as before.
    expect(resolveTag(h.db, matt, "gabe")).toMatchObject({ tag: "@gabriel" });
  });

  it("'send $5 to +1 415 555 0002' pays the account that signed up from that number", async () => {
    const h = harness(2);
    await h.onboard("matt", 0);
    const gabriel = await h.onboard("gabriel", 1);
    h.script(
      delegate("pay +1 415 555 0002 $5"),
      call("propose_action", { code: "PAY", fields: [{ label: "To", value: "+1 415 555 0002" }, { label: "Amount", value: "$5" }] }),
      say("$5 to @gabriel, coming right up."),
    );
    await h.send(PHONES.matt, "send $5 to +1 415 555 0002");
    expect(h.devices[0]!.shown.at(-1)?.fields).toEqual([{ label: "To", value: "@gabriel" }, { label: "Amount", value: "$5.00" }]);
    expect(h.db.account(gabriel.id)!.balance_cents).toBe(25_500);
  });
});

describe("remote onboarding (Ethereum mode, Ledger on another computer)", () => {
  const matt = new Wallet(Wallet.createRandom().privateKey);
  const gabe = new Wallet(Wallet.createRandom().privateKey);
  const yadu = new Wallet(Wallet.createRandom().privateKey);
  const addr = (w: Wallet) => w.address.toLowerCase();
  let web: WebServer | undefined;
  afterEach(async () => {
    await web?.close();
    web = undefined;
  });

  /** An eth-mode app whose USB sees `plugged` (matt's Ledger is already bound to @matt), plus the approval page. */
  async function setup(plugged: Wallet[] = [], timing: { signTimeoutMs?: number; windowMs?: number } = {}) {
    const db = openDb(":memory:");
    db.createAccount("@matt", addr(matt), PHONES.matt, 0);
    const usb = fakeEthDevices([matt, gabe]);
    usb.plugged.clear();
    for (const w of plugged) usb.plugged.add(w === matt ? 0 : 1);
    const remote = createRemoteDeviceManager({ db, publicUrl: "https://agent.example", windowMs: timing.windowMs ? () => timing.windowMs! : undefined });
    web = await startWebServer({ db, remote, port: 0 });
    const base = `http://127.0.0.1:${web.port}`;
    const ch = fakeChannel();
    const app = createApp({ db, deviceManager: combineDeviceManagers([usb.manager, remote]), channel: ch.channel, model: scriptedModel().model, money: baseMoney(stubChain({}).chain), signTimeoutMs: timing.signTimeoutMs ?? 5000 });
    /** Texts the tag and returns the token from the link the agent sent back. */
    const signUp = async (handle: string, tag: string) => {
      await app.handleInbound(inbound(handle, tag));
      for (let i = 0; i < 300; i++) {
        const token = /\/sign\/([0-9a-f]{64})$/.exec(ch.to(handle).at(-1) ?? "")?.[1];
        if (token) return token;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no link for ${handle}: ${JSON.stringify(ch.to(handle))}`);
    };
    /** The page on another computer: load the job, sign it with `wallet`, post the answer. */
    const page = async (token: string, wallet: Wallet) => {
      const job = (await (await fetch(`${base}/sign/${token}/job`)).json()) as { request: EthRequest; address: string };
      const res = await fetch(`${base}/sign/${token}/result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(await askEthApp(fakeEthApp(wallet), job.request)) });
      return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string }, job };
    };
    return { db, app, ch, usb, signUp, page };
  }

  it("binds the account to whichever Ledger signs the link, one link per person", async () => {
    const h = await setup([matt]);
    const [gabeToken, yaduToken] = [await h.signUp(PHONES.gabriel, "@gabe"), await h.signUp(PHONES.yadu, "@yadu")];
    expect(gabeToken).not.toBe(yaduToken);
    expect(h.ch.to(PHONES.gabriel)).toEqual([`To create @gabe, open this link in Chrome on the computer your Ledger is plugged into, with the Ethereum app open: https://agent.example/sign/${gabeToken}`]);
    const signed = await h.page(gabeToken, gabe);
    expect(signed.job).toMatchObject({ address: "", request: { kind: "message" } });
    expect((signed.job.request as { message: string }).message).toMatch(/^AgentSign\nCreate account\nTag: @gabe\nPhone: \+14155550002\nid: [0-9a-f]{8}$/);
    expect(signed.status).toBe(200);
    expect((await h.page(yaduToken, yadu)).status).toBe(200);
    await h.app.whenIdle();
    expect(h.db.accountByTag("@gabe")?.pubkey).toBe(addr(gabe));
    expect(h.db.accountByTag("@yadu")?.pubkey).toBe(addr(yadu));
    expect(h.ch.to(PHONES.gabriel).at(-1)).toMatch(new RegExp(`^You're in: @gabe is bound to ${gabe.address} `));
    expect((await h.page(gabeToken, gabe)).status).toBe(409);
  });

  it("refuses a Ledger that already has an account and waits for a free one", async () => {
    const h = await setup();
    const token = await h.signUp(PHONES.gabriel, "@gabe");
    const bound = await h.page(token, matt);
    expect([bound.status, bound.body.error]).toEqual([422, "This Ledger already has an account. Use a Ledger without one."]);
    expect((await h.page(token, gabe)).status).toBe(200);
    await h.app.whenIdle();
    expect(h.db.accountByTag("@gabe")?.pubkey).toBe(addr(gabe));
    expect(h.db.accountByTag("@matt")?.pubkey).toBe(addr(matt));
  });

  it("iMessage: a stranger has no username, so the greeting asks for a tag and offers the link, never Telegram", async () => {
    const before = process.env.CHANNEL;
    process.env.CHANNEL = "photon";
    try {
      const h = await setup();
      // The scripted model has no steps, so the stranger turn fails and the fixed greeting goes out.
      await h.app.handleInbound(inbound(PHONES.gabriel, "hi"));
      const [hello] = h.ch.to(PHONES.gabriel);
      expect(hello).toBe(greeting("the Ethereum app", true));
      expect(hello).toContain("tell me the tag you want, like @matt. Then you approve it on your Ledger with the Ethereum app open, from Chrome on any computer through a link I send.");
      expect(hello).not.toMatch(/telegram|press start|plug your ledger into the mac/i);
      const token = await h.signUp(PHONES.gabriel, "@gabe");
      expect((await h.page(token, gabe)).status).toBe(200);
      await h.app.whenIdle();
      expect(h.db.accountByHandle(PHONES.gabriel)).toMatchObject({ tag: "@gabe", pubkey: addr(gabe), username: null });
    } finally {
      if (before === undefined) delete process.env.CHANNEL;
      else process.env.CHANNEL = before;
    }
  });

  it("Telegram: 'link' sends the page straight away, and 'go' with no free USB Ledger falls back to it", async () => {
    const h = await setup([matt]);
    const linkIn = async (msg: ReturnType<typeof tgInbound>) => {
      await h.app.handleInbound(msg);
      for (let i = 0; i < 300 && !/\/sign\/[0-9a-f]{64}$/.test(h.ch.to(msg.handle).at(-1) ?? ""); i++) await new Promise((r) => setTimeout(r, 10));
      return /\/sign\/([0-9a-f]{64})$/.exec(h.ch.to(msg.handle).at(-1) ?? "")?.[1] ?? "";
    };
    await h.app.handleInbound(tgInbound(333, "/start", "gabe", "Gabe"));
    expect(h.ch.to("tg:333")).toEqual([welcomeLine("@gabe", "the Ethereum app", true)]);
    const token = await linkIn(tgInbound(333, "link", "gabe", "Gabe"));
    expect(h.ch.to("tg:333").at(-1)).toBe(`To create @gabe, open this link in Chrome on the computer your Ledger is plugged into, with the Ethereum app open: https://agent.example/sign/${token}`);
    const signed = await h.page(token, gabe);
    expect((signed.job.request as { message: string }).message).toMatch(/^AgentSign\nCreate account\nTag: @gabe\nTelegram: @gabe\nid: [0-9a-f]{8}$/);
    await h.app.whenIdle();
    expect(h.db.accountByHandle("tg:333")).toMatchObject({ tag: "@gabe", pubkey: addr(gabe), username: "gabe", display_name: "Gabe" });

    expect(await linkIn(tgInbound(444, "ok go", "yadu"))).toMatch(/^[0-9a-f]{64}$/);
    expect(h.ch.to("tg:444")).toHaveLength(1);
  });

  it("a slow signer: USB stops looking, but the link stays valid for its own window", async () => {
    const h = await setup([], { signTimeoutMs: 50, windowMs: 3000 });
    const token = await h.signUp(PHONES.gabriel, "@gabe");
    await new Promise((r) => setTimeout(r, 400)); // well past the USB window
    expect(h.db.signingJob(token)?.status).toBe("pending");
    expect((await h.page(token, gabe)).status).toBe(200);
    await h.app.whenIdle();
    expect(h.db.accountByTag("@gabe")?.pubkey).toBe(addr(gabe));
  });

  it("an expired sign-up link says so, and a late page answer gets a 409", async () => {
    const h = await setup([], { signTimeoutMs: 50, windowMs: 200 });
    const token = await h.signUp(PHONES.gabriel, "@gabe");
    await h.app.whenIdle();
    expect(h.ch.to(PHONES.gabriel).at(-1)).toBe("The sign-up link expired before your Ledger signed, so nothing happened. Send me @gabe again and I'll send a new one.");
    const late = await h.page(token, gabe);
    expect([late.status, late.body.error]).toEqual([409, "This request expired on the server. Ask Jarvis again and open the new link."]);
    expect(h.db.accountByTag("@gabe")).toBeUndefined();
  });

  it("while a link sign-up waits, any message gets the link again, and 'cancel' expires it", async () => {
    const h = await setup([matt]);
    const tg = (text: string) => h.app.handleInbound(tgInbound(666, text, "gabe"));
    const tokenIn = async () => {
      for (let i = 0; i < 300; i++) {
        const token = /\/sign\/([0-9a-f]{64})/.exec(h.ch.to("tg:666").at(-1) ?? "")?.[1];
        if (token) return token;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no link: ${JSON.stringify(h.ch.to("tg:666"))}`);
    };
    await tg("link");
    const token = await tokenIn();
    for (const text of ["hello?", "go", "link"]) {
      await tg(text);
      expect(h.ch.to("tg:666").at(-1)).toBe(`Still waiting on your Ledger. The link again: https://agent.example/sign/${token}\nOr say 'cancel' to start over.`);
    }
    await tg("cancel");
    expect(h.ch.to("tg:666").at(-1)).toBe("Cancelled. Say 'go' when you're ready.");
    expect(h.db.signingJob(token)?.status).not.toBe("pending");
    expect((await h.page(token, gabe)).status).toBe(409);
    expect(h.db.accountByHandle("tg:666")).toBeUndefined();

    await tg("link");
    const fresh = await tokenIn();
    expect(fresh).not.toBe(token);
    expect((await h.page(fresh, gabe)).status).toBe(200);
    await h.app.whenIdle();
    expect(h.db.accountByHandle("tg:666")).toMatchObject({ tag: "@gabe", pubkey: addr(gabe) });
  });

  it("plugging the Ledger into this Mac after the link was sent also works, and the link is then refused", async () => {
    const h = await setup([matt]);
    const token = await h.signUp(PHONES.gabriel, "@gabe");
    h.usb.plugged.add(1);
    await h.app.whenIdle();
    expect(h.db.accountByTag("@gabe")?.pubkey).toBe(addr(gabe));
    expect(h.db.signingJob(token)?.status).toBe("superseded");
    const late = await h.page(token, gabe);
    expect([late.status, late.body.error]).toEqual([409, "The Ledger plugged into the AgentSign Mac took this request over USB. Approve or reject it there."]);
  });
});
