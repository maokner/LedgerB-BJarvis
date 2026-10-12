/** Routing behind App.handleInbound: dedupe, onboarding, deterministic shortcuts, then the persona and its engine. */
import { newActionId, toFieldText } from "./actions.js";
import type { AgentDeps } from "./agent/agent.js";
import { runPersonaTurn, runStrangerTurn, setupLine, welcomeLine, withoutLedgerAsk, type StrangerResult, type StrangerSetup } from "./agent/persona.js";
import { DEFAULT_PERSONA_MODEL, type ChatMessage, type Model } from "./agent/xai.js";
import { createApprovals, PENDING_ERROR, type Approvals } from "./approvals.js";
import { createCalendar, type Calendar } from "./calendar/google.js";
import type { Account, Db } from "./db.js";
import { demoMoney, type Money } from "./money.js";
import type { PhoneLinks } from "./phone.js";
import type { Food } from "./food/food.js";
import type { Purchases } from "./purchases.js";
import { normalizeHandle, parseTag } from "./handles.js";
import { answerMeeting } from "./meetings.js";
import { executeDirectly, requiresLedger } from "./policy.js";
import { ACTION_TITLES, type Action, type ActionField, ANY_DEVICE, type App, type Channel, type DeviceManager, type InboundMessage } from "./types.js";

/** Said to someone new without a usable Telegram username when the model cannot be reached. */
export const greeting = setupLine;
export const OOPS = "Sorry, something broke on my side. Give it a minute and try again.";
const STRANGER_MEMORY = 12;
/** A stranger with a default tag saying yes: "go", "ok", "yes please", "plugged in". */
const GO = /^(?:(?:ok(?:ay)?|yes|yep|yeah|sure|alright)[,!. ]+)?(?:go|go ahead|let'?s go|yes|yep|yeah|yup|y|ok|okay|sure|ready|done|do it|let'?s do it|sounds good|plugged in|confirm(?:ed)?|i'?m ready)(?:[,!. ]+(?:please|thanks|go))?[.! ]*$/i;
const LINK = /^(?:send (?:me )?(?:the |a )?)?link(?: please)?[.! ]*$/i;
/** Abandons a sign-up in flight. */
const CANCEL = /^(?:\/start|\/cancel|cancel|stop|restart|start over|reset)\b/i;
/** A plain yes or no, right after a meeting text ("Reply 'yes' ... or name another time") with nothing said since. */
const YES = /^(?:(?:ok(?:ay)?|yes|sure|alright|great|perfect|cool)[,!. ]+)?(?:yes|yep|yeah|yup|y|ok|okay|sure|works|that works|works for me|sounds good|sounds great|confirm(?:ed)?|accept(?:ed)?|book it|do it|let'?s do it|deal|see you then|i'?m in|count me in)(?:[,!. ]+(?:please|thanks|thank you|see you then))?[.! ]*$/i;
const NO = /^(?:(?:no|nope|nah|sorry)[,!. ]+)?(?:no|nope|nah|can'?t|cannot|i can'?t|can'?t make it|i can'?t make it|not that time|doesn'?t work|that doesn'?t work|decline|pass|no thanks|no thank you)(?:[,!. ]+(?:sorry|thanks|thank you))?[.! ]*$/i;
/** An owner asking to connect Google Calendar in so many words. */
const GOOGLE = /^(?:please |can you |could you )?(?:connect|link|sync|hook up|add)(?: up)?(?: to)? (?:my |the )?google calendar(?: please)?[.!? ]*$/i;

/** ACC fields: the tag, and whom it is for as the Ledger can show it ("Telegram @mokner", or "Phone <handle>" off Telegram). */
export function accountFields(handle: string, tag: string, username?: string): ActionField[] {
  if (!handle.startsWith("tg:")) return [{ label: "Tag", value: tag }, { label: "Phone", value: handle }];
  const who = username && /^[a-z0-9_]{1,60}$/i.test(username) ? `@${username.toLowerCase()}` : `id ${handle.slice(3)}`;
  return [{ label: "Tag", value: tag }, { label: "Telegram", value: who }];
}

export interface AppOptions {
  db: Db;
  deviceManager: DeviceManager;
  channel: Pick<Channel, "send" | "typing" | "react">;
  model: Model;
  /** Model for the persona's calls. Default: XAI_PERSONA_MODEL, else DEFAULT_PERSONA_MODEL; "" uses `model`'s own. */
  personaModel?: string;
  log?: (line: string) => void;
  /** Passed to deviceManager.sign; the device manager's default (120 s) when unset. */
  signTimeoutMs?: number;
  /** Device mode specifics. Default: the custom AgentSign app with demo money. */
  money?: Money;
  /** The owners' calendars. Default: AgentSign's own events only (no Google). */
  calendar?: Calendar;
  /** Buying on Amazon with ETH (src/purchases.ts). Default: not available. */
  purchases?: Purchases;
  /** Phone numbers linked for calls (src/phone.ts). Default: calls are not available. */
  phone?: PhoneLinks;
  /** Ordering food on DoorDash with USDC (src/food/): a second purchases pipeline, code EAT. Default: not available. */
  food?: Food;
}

/**
 * Collects the confirm prompts of one turn so they go out in the same text as the persona's reply.
 * Approvals ask the device only after `deliver` resolves, which is after that one text was accepted.
 */
function turnOutbox(send: (text: string) => Promise<void>) {
  const prompts: string[] = [];
  let expected = 0;
  let flushed = false;
  let release!: () => void;
  const sent = new Promise<void>((resolve) => (release = resolve));
  return {
    expect: () => void expected++,
    async deliver(prompt: string): Promise<void> {
      if (flushed) return send(prompt); // arrived after the reply went out: send it on its own
      prompts.push(prompt);
      await sent;
    },
    /** Sends the reply with every prompt of this turn under it. No reply (the turn failed): the prompts alone, or OOPS. */
    async flush(reply: string | undefined): Promise<void> {
      // Approvals hand over the prompt from their queue, normally within a tick; wait a little for stragglers.
      for (const deadline = Date.now() + 10_000; prompts.length < expected && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 25));
      flushed = true;
      const words = reply === undefined ? (prompts.length ? "" : OOPS) : prompts.length ? withoutLedgerAsk(reply) : reply;
      const text = [words, ...prompts].filter(Boolean).join("\n\n");
      try {
        await send(text);
      } finally {
        release();
      }
    },
  };
}

/** What phone calls (src/voice/) need from the app: the agent deps and the deterministic sign-up. */
export interface AppVoiceHooks {
  deps: AgentDeps;
  /** Starts sign-up for `handle` with `tag`. started: the Ledger now shows the request (texted too); else `reply` says why not. */
  onboard(handle: string, tag: string): Promise<{ started: true } | { started: false; reply: string }>;
}

export function createApp(options: AppOptions): App & AppVoiceHooks & { approvals: Approvals; whenIdle(): Promise<void> } {
  const { db, deviceManager, model } = options;
  const log = options.log ?? (() => {});
  const best = (what: string, work: Promise<void> | undefined) => work?.catch((err: unknown) => log(`${what} failed: ${(err as Error).message}`));
  const channel = {
    async send(handle: string, text: string) {
      log(`-> ${handle}: ${text}`);
      try {
        await options.channel.send(handle, text);
        log(`   sent to ${handle}`);
      } catch (err) {
        log(`   SEND FAILED to ${handle}: ${(err as Error).message}`);
        throw err;
      }
    },
    typing: (handle: string, on: boolean) => best("typing", options.channel.typing?.(handle, on)),
    react: (messageId: string, emoji: string) => best("react", options.channel.react?.(messageId, emoji)),
  };
  const money = options.money ?? demoMoney();
  const app = money.appName;
  const calendar = options.calendar ?? createCalendar({ db, log });
  const purchases = options.purchases;
  const phone = options.phone;
  const food = options.food;
  // Each pipeline follows only its own code (BUY, EAT), so every settled action goes to all of them.
  const stores = [purchases, food].filter((s) => s !== undefined);
  const approvals = createApprovals({
    db, deviceManager, channel, titles: ACTION_TITLES, log, signTimeoutMs: options.signTimeoutMs, money, calendar,
    onSettled: stores.length ? (action, status, extra) => stores.forEach((s) => s.onSettled(action, status, extra)) : undefined,
  });
  // Purchases a previous run left in flight continue now that approvals have expired their stale actions.
  for (const s of stores) s.resume();
  const personaModel = (options.personaModel ?? process.env.XAI_PERSONA_MODEL ?? DEFAULT_PERSONA_MODEL) || undefined;
  const deps: AgentDeps = { db, model, approvals, channel, log, money, personaModel, calendar, purchases, phone, food };
  const createTitle = money.mode === "eth" ? "Verify address" : "Create account";
  const turns = new Map<string, Promise<void>>();
  /** Onboarding approvals in flight, by handle: the tag and device they claimed. */
  const onboarding = new Map<string, { tag: string; pubkey: string }>();
  /** Recent chat with people who have no account yet, by handle (memory only). */
  const strangers = new Map<string, ChatMessage[]>();
  /** The latest Telegram username (lowercase) and display name seen from each handle. */
  const profiles = new Map<string, { username?: string; name?: string }>();
  /** The sign-up page can bind a Ledger on any computer (Ethereum mode with the remote device manager). */
  const canLink = money.mode === "eth" && !!deviceManager.prepare;

  /** The sender's Telegram username as a tag, when it is a valid tag nobody has yet. */
  function defaultTag(handle: string): string | undefined {
    const username = profiles.get(handle)?.username;
    const tag = username ? parseTag(username) : undefined;
    return tag && !db.accountByTag(tag) ? tag : undefined;
  }

  /** Once a sign-up settled: forget the stranger chat and store the Telegram profile on the new account. */
  function afterOnboarding(handle: string): void {
    void approvals.whenIdle(`handle:${handle}`).then(() => {
      onboarding.delete(handle);
      const account = db.accountByHandle(handle);
      if (!account) return;
      strangers.delete(handle);
      const p = profiles.get(handle);
      if (p) db.setProfile(account.id, p.username ?? null, p.name ?? null);
    });
  }

  /**
   * Deterministic sign-up once a tag is known: free USB device check, then ACC on that device; with no free one in
   * Ethereum mode, the sign-up page. `remote`: straight to the page.
   */
  async function onboard(handle: string, tag: string, remote = false, reply = (text: string) => channel.send(handle, text)): Promise<void> {
    if (db.accountByTag(tag) || [...onboarding.values()].some((o) => o.tag === tag)) {
      return reply(`${tag} is taken, I'm afraid. Which other tag would you like?`);
    }
    // Off Telegram the Ledger shows and signs the handle itself, so it must be ASCII and at most 64 bytes.
    if (!handle.startsWith("tg:") && toFieldText(handle) !== handle) {
      return reply("Your Ledger can't display this address exactly, so I can't use it. Please message me from another account.");
    }
    const again = tag === defaultTag(handle) ? "say 'go' again" : `send me ${tag} again`;
    if (remote && canLink) return onboardRemotely(handle, tag);
    if (remote) return reply(`The sign-up page isn't available here. Plug your Ledger into the Mac, unlock it, open ${app}, then ${again}.`);
    const bound = new Set([...db.accounts().map((a) => a.pubkey), ...[...onboarding.values()].map((o) => o.pubkey)]);
    const free = (await deviceManager.list()).filter((d) => !bound.has(d.pubkey));
    // Ethereum mode with the approval page: the Ledger can be on another computer; the account binds to whichever free Ledger signs.
    if (free.length === 0 && canLink) return onboardRemotely(handle, tag);
    if (free.length === 0) return reply(`I don't see a Ledger without an account. Plug yours into the Mac, unlock it, open ${app}, then ${again}.`);
    // With two fresh devices we cannot tell whose is whose, so refuse rather than guess.
    if (free.length > 1) {
      return reply(`I see more than one new Ledger and can't tell which is yours. Leave only yours plugged in with ${app} open, then ${again}.`);
    }
    const device = free[0]!;
    const action: Action = { code: "ACC", id: newActionId(), fields: accountFields(handle, tag, profiles.get(handle)?.username) };
    onboarding.set(handle, { tag, pubkey: device.pubkey });
    log(`onboarding ${handle} as ${tag} on ${device.label}`);
    try {
      const prompt = `${tag} it is. Your Ledger now shows '${createTitle}'. Approve it there and you're set.`;
      await approvals.requestAccount(handle, device.pubkey, action, { reason: "onboarding", prompt });
    } catch (err) {
      onboarding.delete(handle);
      throw err;
    }
    afterOnboarding(handle);
  }

  /** Sign-up through the link: the page signs the ACC message on a Ledger anywhere; USB on this Mac still races it. */
  async function onboardRemotely(handle: string, tag: string): Promise<void> {
    const action: Action = { code: "ACC", id: newActionId(), fields: accountFields(handle, tag, profiles.get(handle)?.username) };
    onboarding.set(handle, { tag, pubkey: ANY_DEVICE });
    log(`onboarding ${handle} as ${tag} through the approval page`);
    try {
      await approvals.requestAccount(handle, ANY_DEVICE, action, {
        reason: "remote onboarding",
        prompt: `${tag} it is. Plug your Ledger into the Mac, unlock it and open ${app}.`,
        linkPrompt: (url) => `To create ${tag}, open this link in Chrome on the computer your Ledger is plugged into, with the Ethereum app open: ${url}`,
        expiredText: `The sign-up link expired before your Ledger signed, so nothing happened. ${tag === defaultTag(handle) ? "Say 'go' or 'link'" : `Send me ${tag} again`} and I'll send a new one.`,
      });
    } catch (err) {
      onboarding.delete(handle);
      throw err;
    }
    afterOnboarding(handle);
  }

  /** A message while a sign-up waits on the Ledger: cancel it, or repeat the link (a cleared chat must not strand anyone). */
  async function pendingSignUp(handle: string, tag: string, text: string): Promise<void> {
    const key = `handle:${handle}`;
    if (CANCEL.test(text)) {
      approvals.cancel(key);
      await approvals.whenIdle(key);
      onboarding.delete(handle);
      return channel.send(handle, `Cancelled. ${tag === defaultTag(handle) ? "Say 'go'" : `Send me ${tag}`} when you're ready.`);
    }
    const url = approvals.link(key);
    if (url) return channel.send(handle, `Still waiting on your Ledger. The link again: ${url}\nOr say 'cancel' to start over.`);
    return channel.send(handle, `Still waiting on '${createTitle}' for ${tag}. Approve it on your Ledger, or say 'cancel' to start over.`);
  }

  /** Sends a stranger reply and keeps it in their short memory. */
  function tellStranger(handle: string, past: ChatMessage[], text: string, reply: string): Promise<void> {
    strangers.set(handle, [...past, { role: "user" as const, content: text }, { role: "assistant" as const, content: reply }].slice(-STRANGER_MEMORY));
    return channel.send(handle, reply);
  }

  /**
   * No account yet: an exact @tag skips the model. With a Telegram username as the default tag, the first message gets
   * a fixed welcome, "go" (or any yes) signs up with it and "link" sends the page. Anything else: the restricted persona.
   */
  async function stranger(message: InboundMessage, handle: string): Promise<void> {
    const pending = onboarding.get(handle);
    if (pending) return pendingSignUp(handle, pending.tag, message.text.trim());
    // The first @word in the message ("@gabe would be fire" -> @gabe). A bare word is never a tag, so "hi" stays a greeting.
    const exact = parseTag(/(?:^|\s)(@[a-z0-9_]{2,24})\b/i.exec(message.text)?.[1] ?? "");
    if (exact) return onboard(handle, exact);
    const text = message.text.trim();
    const setup: StrangerSetup = { appName: app, defaultTag: defaultTag(handle), link: canLink };
    const opener = setup.defaultTag ? welcomeLine(setup.defaultTag, app, canLink) : greeting(app);
    const past = strangers.get(handle) ?? [];
    if (setup.defaultTag && LINK.test(text)) return onboard(handle, setup.defaultTag, true);
    if (setup.defaultTag && GO.test(text)) return onboard(handle, setup.defaultTag);
    // "First contact" means no chat as a stranger yet, not "never messaged": a deleted account messaged before.
    if ((setup.defaultTag && !past.length) || /^\/start\b/i.test(text)) return tellStranger(handle, past, message.text, opener);
    let result: StrangerResult;
    await channel.typing(handle, true);
    try {
      result = await runStrangerTurn(deps, setup, past, text);
    } catch (err) {
      log(`stranger turn for ${handle} failed: ${(err as Error).message}`);
      const nudge = setup.defaultTag
        ? `Say 'go' with your Ledger plugged into the Mac and ${app} open${canLink ? ", or 'link' for a page that works from any computer" : ""}.`
        : `Tell me the tag you want, like @matt, with your Ledger plugged into the Mac and ${app} open.`;
      result = { reply: !past.length ? opener : nudge };
    } finally {
      await channel.typing(handle, false);
    }
    if ("tag" in result) {
      const tag = parseTag(result.tag) ?? (result.link ? setup.defaultTag : undefined);
      if (tag) return onboard(handle, tag, !!result.link);
      result = { reply: result.link ? "Tell me the tag you want first, like @matt, and I'll send the link." : "Tags are 2 to 24 letters, numbers or underscores, like @matt. Which would you like?" };
    }
    return tellStranger(handle, past, message.text, result.reply);
  }

  /** "accept" or "accept @matt" with a matching incoming request skips the model and proposes FAC. */
  async function acceptShortcut(account: Account, message: InboundMessage, handle: string): Promise<boolean> {
    const m = /^accept(?:\s+(@?[a-z0-9_]+))?[.!]*$/i.exec(message.text.trim());
    if (!m) return false;
    const incoming = db.friendsOf(account.id).filter((f) => f.status === "pending" && f.requested_by === f.id);
    const wanted = m[1] ? parseTag(m[1]) : undefined;
    const from = wanted ? incoming.find((f) => f.tag === wanted) : incoming.length === 1 ? incoming[0] : undefined;
    if (!from) return false;
    db.addMessage(account.id, "user", { role: "user", content: message.text });
    const action: Action = { code: "FAC", id: newActionId(), fields: [{ label: "From", value: from.tag }] };
    if (!requiresLedger(account, "friends")) {
      await channel.react(message.id, "👍");
      const r = await executeDirectly({ db, calendar, channel, log }, account, action);
      const reply = r.line.replace(/^Error: /, "");
      await channel.send(handle, reply);
      db.addMessage(account.id, "assistant", { role: "assistant", content: reply });
      return true;
    }
    try {
      await approvals.request(account.id, action, { reason: "accept shortcut" });
    } catch (err) {
      if ((err as Error).message !== PENDING_ERROR) throw err;
      await channel.send(handle, "Your Ledger has something else waiting. Approve or reject that first, then say 'accept' again.");
      return true;
    }
    await channel.react(message.id, "👍");
    db.addMessage(account.id, "assistant", { role: "assistant", content: `I asked their Ledger to accept ${from.tag}'s friend request.` });
    return true;
  }

  /**
   * A plain yes or no skips the model and books or declines at once, but only as the direct answer: exactly one meeting
   * waits for this person and the meeting text is the last thing they got. Anything said in between goes through Jarvis.
   */
  async function meetingShortcut(account: Account, message: InboundMessage, handle: string): Promise<boolean> {
    const text = message.text.trim();
    const yes = YES.test(text);
    if ((!yes && !NO.test(text)) || message.images.length) return false;
    const waiting = db.openMeetings(account.id).filter((m) => m.awaiting === account.id);
    if (waiting.length !== 1) return false;
    const last = db.recentMessages(account.id, 1)[0];
    if (last?.role !== "system" || !JSON.stringify(last.content).includes("Reply 'yes'")) return false;
    db.addMessage(account.id, "user", { role: "user", content: message.text });
    await channel.react(message.id, yes ? "👍" : "👌");
    const result = await answerMeeting({ db, calendar, channel, log, approvals }, account, waiting[0]!, yes ? { kind: "yes" } : { kind: "no" });
    const reply = result.ok ? result.reply : result.reply.replace(/^Error: /, "");
    // An empty reply: their own Ledger prompt is their text (their policy sends meetings there).
    if (reply) await channel.send(handle, reply);
    db.addMessage(account.id, "assistant", { role: "assistant", content: reply || "Their side of the meeting now waits on their Ledger." });
    return true;
  }

  /** "connect google calendar" (link, sync, hook up) skips the model: the link goes out at once. */
  async function googleShortcut(account: Account, message: InboundMessage, handle: string): Promise<boolean> {
    if (!GOOGLE.test(message.text.trim()) || !calendar.available) return false;
    db.addMessage(account.id, "user", { role: "user", content: message.text });
    const current = calendar.connection(account.id);
    const reply = current
      ? `Your Google Calendar is already connected as ${current.email}. Say 'disconnect google calendar' first if you want a different account.`
      : `Here's the link to connect your Google Calendar. Open it and pick the account.\n\nConnect your Google Calendar here (the link works for 15 minutes): ${calendar.connectLink(account.id)}`;
    await channel.send(handle, reply);
    db.addMessage(account.id, "assistant", { role: "assistant", content: current ? reply : "I sent the link to connect their Google Calendar." });
    return true;
  }

  /** A four-digit code read out on a call from an unknown number: texting it here links that number to this account. */
  async function phoneCodeShortcut(account: Account, message: InboundMessage, handle: string): Promise<boolean> {
    const code = message.text.trim();
    if (!phone || !/^\d{4}$/.test(code) || !phone.pending(code)) return false;
    db.addMessage(account.id, "user", { role: "user", content: message.text });
    const r = phone.claim(account.id, code);
    const reply = r.ok ? `Linked ${r.handle} to your account. Calls from it are you now${phone.number ? `; call me at ${phone.number} any time` : ""}.` : `Couldn't link that number: ${r.reason}`;
    await channel.react(message.id, r.ok ? "👍" : "🤔");
    await channel.send(handle, reply);
    db.addMessage(account.id, "assistant", { role: "assistant", content: reply });
    return true;
  }

  /** An owner turn: the persona answers, delegating to the engine; proposals ride along in the same text. */
  async function ownerTurn(account: Account, message: InboundMessage, handle: string): Promise<void> {
    const out = turnOutbox((text) => channel.send(handle, text));
    let reacted = false;
    let reply: string | undefined;
    await channel.typing(handle, true);
    try {
      reply = await runPersonaTurn(deps, account, message.text.trim(), message.images, {
        deliver: out.deliver,
        onProposed: out.expect,
        attach: async (text) => {
          out.expect();
          void out.deliver(text);
        },
        onDelegate: () => {
          if (!reacted) void channel.react(message.id, "👍");
          reacted = true;
        },
      });
    } catch (err) {
      log(`turn for ${handle} failed: ${(err as Error).stack ?? err}`);
    } finally {
      await channel.typing(handle, false);
      await out.flush(reply);
    }
  }

  async function route(message: InboundMessage, handle: string): Promise<void> {
    const account = db.accountByHandle(handle);
    if (!account) return stranger(message, handle);
    if (await acceptShortcut(account, message, handle)) return;
    if (await meetingShortcut(account, message, handle)) return;
    if (await googleShortcut(account, message, handle)) return;
    if (await phoneCodeShortcut(account, message, handle)) return;
    return ownerTurn(account, message, handle);
  }

  return {
    approvals,
    deps,
    async onboard(handle, tag) {
      const pending = onboarding.get(handle);
      if (pending) return { started: false, reply: `Still waiting for '${createTitle}' for ${pending.tag} on their Ledger.` };
      let said: string | undefined;
      await onboard(handle, tag, false, async (text) => void (said = text));
      return said === undefined ? { started: true } : { started: false, reply: said };
    },
    async handleInbound(message) {
      const handle = normalizeHandle(message.handle);
      if (!db.markSeen(message.id, handle)) return;
      log(`<- ${handle}${message.username ? ` (@${message.username})` : ""}: ${message.text}${message.images.length ? ` [+${message.images.length} image(s)]` : ""}`);
      // Telegram usernames and names change: keep the latest on the account (and for sign-up, before there is one).
      if (message.service === "telegram" || message.username || message.name) {
        const profile = { username: message.username?.replace(/^@/, "").toLowerCase() || undefined, name: message.name?.trim() || undefined };
        profiles.set(handle, profile);
        const account = db.accountByHandle(handle);
        if (account) db.setProfile(account.id, profile.username ?? null, profile.name ?? null);
      }
      const key = String(db.accountByHandle(handle)?.id ?? handle);
      const run = async () => {
        try {
          await route(message, handle);
        } catch (err) {
          log(`error handling ${message.id} from ${handle}: ${(err as Error).stack ?? err}`);
          await channel.send(handle, OOPS).catch((e) => log(`send failed: ${(e as Error).message}`));
        }
      };
      const next = (turns.get(key) ?? Promise.resolve()).then(run);
      turns.set(key, next);
      await next;
    },
    async whenIdle() {
      await Promise.all(turns.values());
      await approvals.whenIdle();
      for (const s of stores) await s.whenIdle();
    },
    async close() {
      await Promise.all(turns.values());
    },
  };
}
