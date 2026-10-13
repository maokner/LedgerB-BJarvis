/**
 * Browser side of the account page (bundled to /dashboard.js by src/web/bundle.ts). Signs in with the Ledger
 * (a personal message over WebHID, src/web/ledger-connect.ts), then draws the app shell from GET /api/me: the
 * sidebar's sections (hash routes), the top bar, the main column for the open section and the rail at a glance.
 * Every change goes back to /api/* (contract: src/web/account-api.ts). No framework: small DOM helpers, one render.
 */
import { askEthApp } from "../device/eth-tx.js";
import type { ActivityView, ConnectionAction, ConnectionView, InfoView, LoginChallenge, MeView, PolicyChange, PolicyGuard, PolicyPreset, PolicyView } from "./account-api.js";
import { connectEthereum, hid, knownLedger, NO_HID, NOT_SECURE, Plain, plainError, rejected, release } from "./ledger-connect.js";
import { ICONS } from "./theme.js";

type Child = Node | string | null | undefined | false;
/** An element with attributes (`class`, `html` for trusted markup, on* for listeners) and children. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "html") node.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") node.className = String(v);
    else node.setAttribute(k, String(v));
  }
  for (const c of children) if (c) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}
const icon = (name: keyof typeof ICONS, cls?: string) => el("i", { class: cls, html: ICONS[name] });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const headers = { "content-type": "application/json" };

async function api<T>(path: string, body?: unknown): Promise<T & { ok?: boolean; error?: string; status: number }> {
  const res = await fetch(`/api${path}`, body === undefined ? { cache: "no-store" } : { method: "POST", headers, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  return { ...json, status: res.status };
}
const post = <T = Record<string, never>>(path: string, body: unknown = {}) => api<T>(path, body);

// ---- sections -------------------------------------------------------------------------------------------------

type Section = "home" | "activity" | "connections" | "policy" | "friends" | "soon";
const SECTIONS: { id: Section; name: string; icon: keyof typeof ICONS; group: string }[] = [
  { id: "home", name: "Home", icon: "home", group: "Overview" },
  { id: "activity", name: "Activity", icon: "activity", group: "Overview" },
  { id: "connections", name: "Connections", icon: "grid", group: "Overview" },
  { id: "policy", name: "Ledger policy", icon: "shield", group: "Account" },
  { id: "friends", name: "Friends", icon: "friends", group: "Account" },
  { id: "soon", name: "Coming soon", icon: "spark", group: "Grow" },
];
const current = (): Section => (SECTIONS.some((s) => s.id === location.hash.slice(1)) ? (location.hash.slice(1) as Section) : "home");
let me: MeView | undefined;
let query = "";

const CONNECTION_ICONS: Record<ConnectionView["id"], keyof typeof ICONS> = { chat: "chat", ledger: "ledger", google: "calendar", phone: "phone", amazon: "cart", doordash: "bowl" };
const CODE_ICONS: Record<string, keyof typeof ICONS> = { PAY: "base", BUY: "cart", EAT: "bowl", CAL: "calendar", FRQ: "friends", FAC: "friends", ACC: "ledger", DEL: "ledger" };
const STATUS_PILL: Record<ConnectionView["status"], [string, string]> = { connected: ["on", "Connected"], available: ["", "Available"], unavailable: ["off", "Not on this server"] };
const ACTIVITY_PILL: Record<ActivityView["status"], [string, string]> = {
  pending: ["wait", "Waiting on Ledger"], approved: ["wait", "Signed"], executed: ["on", "Done"], rejected: ["bad", "Rejected"], failed: ["bad", "Failed"], expired: ["off", "Expired"],
};
const GUARDS: { key: PolicyGuard; name: string; blurb: string }[] = [
  { key: "calendar", name: "Own calendar events", blurb: "Adding an event to your calendar" },
  { key: "meetings", name: "Meetings with friends", blurb: "A time both of you said yes to" },
  { key: "friends", name: "Adding friends", blurb: "Friend requests and accepts" },
];
const PRESETS: PolicyPreset[] = ["relaxed", "standard", "strict"];
const SOON: { name: string; blurb: string }[] = [
  { name: "Spending limits", blurb: "A daily cap you sign once. Under it, Jarvis pays without asking; over it, the Ledger." },
  { name: "Recurring payments", blurb: "Rent, subscriptions and allowances on a schedule, from one signature." },
  { name: "Rides", blurb: "Uber and Lyft, paid in USDC from the same treasury flow as food and Amazon." },
  { name: "Email", blurb: "Jarvis reads your inbox and drafts replies. Sending waits on you." },
  { name: "Second Ledger", blurb: "A backup device bound to the same account, for when one is at home." },
  { name: "Shared accounts", blurb: "Family and team accounts, each person with their own Ledger and policy." },
];

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { hour: "numeric", minute: "2-digit" });
const since = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const pill = (cls: string, text: string) => el("span", { class: `pill ${cls}` }, text);
const firstName = (m: MeView) => (m.displayName ?? m.tag.replace(/^@/, "")).split(/\s+/)[0]!;
const initial = (m: MeView) => firstName(m).slice(0, 1).toUpperCase();
/** "Today", "Yesterday", else "Sat, Oct 10". */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const diff = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
/** The top bar's way to reach Jarvis: Messages with its number filled in, else the Telegram bot. */
function jarvisLink(m: MeView): { href: string; label: string } | undefined {
  if (m.channel.text) return { href: `sms:${m.channel.text.replace(/[^+\d]/g, "")}`, label: "Text Jarvis" };
  const j = m.channel.jarvis;
  if (!j) return undefined;
  if (j.startsWith("@")) return { href: `https://t.me/${j.slice(1)}`, label: "Text Jarvis" };
  return { href: `sms:${j.replace(/[^+\d]/g, "")}`, label: "Text Jarvis" };
}

/** "+16282649335" -> "+1 (628) 264-9335"; other numbers stay as given. */
const prettyNumber = (n: string) => (/^\+1\d{10}$/.test(n) ? `+1 (${n.slice(2, 5)}) ${n.slice(5, 8)}-${n.slice(8)}` : n);
const smsLink = (n: string) => `sms:${n.replace(/[^+\d]/g, "")}`;

// ---- the front door ---------------------------------------------------------------------------------------------

/** Signed out: who Jarvis is, how to reach it, and the way in. */
function doorView(info: InfoView | undefined): HTMLElement {
  const text = info?.text ?? (info?.jarvis && !info.jarvis.startsWith("@") ? info.jarvis : undefined);
  const bot = !text && info?.jarvis?.startsWith("@") ? info.jarvis : undefined;
  const reach = text
    ? el("p", { class: "num" }, "Text Jarvis at", el("b", {}, prettyNumber(text)))
    : bot
      ? el("p", { class: "num" }, "Find Jarvis on Telegram", el("b", {}, bot))
      : undefined;
  const acts = el(
    "div",
    { class: "acts" },
    text ? el("a", { class: "btn text", href: smsLink(text) }, el("span", { class: "ap" }, icon("bubble")), "Text Jarvis") : undefined,
    bot ? el("a", { class: "btn text", href: `https://t.me/${bot.slice(1)}` }, el("span", { class: "ap" }, icon("bubble")), "Text Jarvis") : undefined,
    el("button", { class: "btn quiet tall", onclick: showLogin }, icon("ledger"), "Log in with Ledger"),
  );
  return el(
    "section",
    { class: "door" },
    el("img", { src: "/jarvis.png", alt: "" }),
    el("h1", {}, "Jarvis"),
    el("p", { class: "tag" }, "Your everything agent."),
    reach,
    acts,
    el("p", { class: "fine" }, "Text it what you want done. Money, and anything your policy sends there, is clear-signed on your Ledger before it happens. Log in with the same Ledger to see your account."),
  );
}

function showLogin(): void {
  $("title").replaceChildren(icon("ledger"), el("span", {}, "Sign in"));
  $("view").replaceChildren(loginView());
  void knownLedger().then((known) => known && ($("log").textContent = "This browser already knows your Ledger; no device picker needed."));
}

// ---- sign in --------------------------------------------------------------------------------------------------

function loginView(): HTMLElement {
  const log = el("p", { class: "log", id: "log" });
  const err = el("p", { class: "err", id: "err" });
  const button = el("button", { class: "btn block", id: "signin", onclick: () => void signIn(button, log, err) }, icon("ledger"), el("span", {}, "Sign in with Ledger"));
  const needs = hid() ? undefined : el("p", { class: "needs" }, window.isSecureContext ? NO_HID : NOT_SECURE);
  return el(
    "section",
    { class: "card login" },
    el("p", { class: "eyebrow" }, "Your account"),
    el("h1", {}, "Sign in with your Ledger."),
    el("p", { class: "lead" }, "No password and no email. Your Ledger signs a short message that proves it is yours. Nothing goes on chain and nothing is spent."),
    el(
      "ol",
      { class: "how" },
      el("li", {}, el("i", {}, "01"), "Plug in your Ledger and unlock it."),
      el("li", {}, el("i", {}, "02"), "Open the Ethereum app."),
      el("li", {}, el("i", {}, "03"), "Press the button below, then approve the message on the device."),
    ),
    button,
    needs,
    log,
    err,
    el("p", { class: "fine" }, "No account yet? Text Jarvis and it sets one up on your Ledger."),
  );
}

async function signIn(button: HTMLButtonElement, log: HTMLElement, err: HTMLElement): Promise<void> {
  const say = (text: string, bad = true) => {
    err.textContent = text;
    err.className = bad ? "err" : "note";
  };
  const step = (text: string) => void (log.textContent = text);
  if (!hid()) return say(window.isSecureContext ? NO_HID : NOT_SECURE);
  const label = button.querySelector("span")!;
  button.disabled = true;
  say("", false);
  try {
    label.textContent = "Connecting to your Ledger";
    const { app: eth, address } = await connectEthereum({ step });
    label.textContent = "Approve the message on your Ledger";
    const challenge = await post<LoginChallenge>("/login/challenge");
    if (!challenge.message) throw new Plain(challenge.error ?? "The server did not answer.");
    step("Sent the sign-in message to the Ledger: scroll through it and press both buttons on 'Sign message'.");
    const answer = await askEthApp(eth, { kind: "message", message: challenge.message });
    label.textContent = "Checking the signature";
    const r = await post<{ tag: string }>("/login", { nonce: challenge.nonce, address, signature: answer.value });
    if (!r.ok) throw new Plain(r.error ?? "The server refused the signature.");
    step("");
    await boot();
  } catch (e) {
    step("");
    say(rejected(e) ? "You rejected the message on the Ledger, so you are not signed in." : plainError(e));
  } finally {
    label.textContent = "Sign in with Ledger";
    button.disabled = false;
    await release();
  }
}

// ---- the shell ------------------------------------------------------------------------------------------------

function drawShell(m: MeView): void {
  const section = current();
  // Sidebar: the sections by group, with counts where they help.
  const nav = $("nav");
  nav.replaceChildren();
  let group = "";
  for (const s of SECTIONS) {
    if (s.group !== group) nav.append(el("p", { class: "navhead" }, (group = s.group)));
    const count = s.id === "friends" ? m.friends.length : s.id === "activity" ? m.activity.length : s.id === "connections" ? m.connections.filter((c) => c.status === "connected").length : 0;
    nav.append(el("a", { class: `navitem${s.id === section ? " on" : ""}`, href: `#${s.id}` }, icon(s.icon), s.name, count > 0 && el("span", { class: "count" }, String(count))));
  }
  const waiting = m.pending;
  $("sideBottom").replaceChildren(
    el("a", { class: "mini", href: "#friends" }, el("span", { class: "ic" }, icon("gift")), el("div", {}, el("b", {}, "Add a friend"), el("span", {}, "Tell Jarvis: add @tag as a friend"))),
    el(
      "a",
      { class: `mini card${waiting ? " wait" : ""}`, href: waiting ? (waiting.path ?? waiting.url ?? "#activity") : "#activity" },
      el("span", { class: "ic" }, icon("ledger")),
      el("div", {}, el("b", {}, waiting ? "Ledger waiting" : "Nothing waiting"), el("span", {}, waiting ? waiting.title : "on your Ledger right now")),
    ),
    el("div", { class: "user" }, el("span", { class: "avatar" }, initial(m)), el("div", {}, el("b", {}, m.displayName ?? m.tag), el("span", {}, m.displayName ? m.tag : `since ${since(m.createdAt)}`))),
  );
  // Top bar.
  const s = SECTIONS.find((x) => x.id === section)!;
  $("title").replaceChildren(icon(s.icon), el("span", {}, s.name));
  const jarvis = jarvisLink(m);
  const acts = el("div", {},
    el("button", { class: "btn quiet tall", onclick: async () => {
      await post("/logout");
      await boot();
    } }, icon("logout"), "Sign out"),
    waiting && (waiting.path ?? waiting.url) ? el("a", { class: "btn soft", href: waiting.path ?? waiting.url }, icon("ledger"), "Open the approval") : undefined,
    jarvis ? el("a", { class: "btn text", href: jarvis.href }, el("span", { class: "ap" }, icon("bubble")), jarvis.label) : undefined,
  );
  $("acts").replaceChildren(...acts.childNodes);
  // The two columns.
  $("view").replaceChildren(VIEWS[section](m));
  const rail = $("rail");
  rail.hidden = false;
  rail.replaceChildren(...railView(m));
  window.scrollTo({ top: 0 });
}

const VIEWS: Record<Section, (m: MeView) => HTMLElement> = {
  home: (m) => el("div", {}, el("h1", { class: "hey" }, `Hey ${firstName(m)}`), setupCard(m), accountCard(m), servicesSection(m, 4), recentSection(m), dangerSection(m)),
  activity: (m) => el("div", {}, activityList(m.activity, query)),
  connections: (m) => el("div", {}, servicesSection(m)),
  policy: (m) => el("div", {}, policyCard(m.policy)),
  friends: (m) => el("div", {}, friendsCard(m)),
  soon: (m) => el("div", {}, soonGrid(), el("p", { class: "note" }, `Same rule for all of it, ${firstName(m)}: the Ledger signs what matters.`)),
};

// ---- home -------------------------------------------------------------------------------------------------------

interface Step {
  icon: keyof typeof ICONS;
  name: string;
  blurb: string;
  done: boolean;
  action?: HTMLElement;
}

function setupCard(m: MeView): HTMLElement {
  const byId = Object.fromEntries(m.connections.map((c) => [c.id, c])) as Partial<Record<ConnectionView["id"], ConnectionView>>;
  const steps: Step[] = [{ icon: "ledger", name: "Bind your Ledger", blurb: "Every payment, and anything your policy sends there, is signed on it", done: true }];
  const google = byId.google;
  if (google && google.status !== "unavailable") {
    steps.push({ icon: "calendar", name: "Connect Google Calendar", blurb: "Jarvis reads your calendar and puts approved events on it", done: google.status === "connected", action: google.status === "connected" ? undefined : connectGoogleButton("dark") });
  }
  const phone = byId.phone;
  if (phone && phone.status !== "unavailable") {
    const linked = phone.status === "connected";
    const body = el("div", { class: "body" });
    steps.push({ icon: "phone", name: "Link a number for calls", blurb: linked ? `Calls from ${phone.detail ?? "your number"} are you` : "Call Jarvis and it knows it is you", done: linked, action: linked ? undefined : linkPhoneButton(body, "dark") });
  }
  // One saved address for both stores: either connection carries it as its detail.
  const stores = [byId.doordash, byId.amazon].filter((c): c is ConnectionView => !!c && c.status !== "unavailable");
  if (stores.length) {
    const address = stores.find((c) => c.detail)?.detail;
    steps.push({ icon: stores[0]!.id === "doordash" ? "bowl" : "cart", name: "Tell Jarvis your address", blurb: address ?? "Food and Amazon orders go there; Jarvis checks with you before each order", done: !!address });
  }
  const done = steps.filter((s) => s.done).length;
  const card = el("section", { class: "card setup" });
  card.append(
    el("h3", {}, done === steps.length ? "Jarvis is set up" : "Get Jarvis working for you"),
    el("p", { class: "lead" }, done === steps.length ? "Everything is connected. Text Jarvis and ask for something." : "Jarvis does more the moment these are connected."),
    el("div", { class: "prog" }, el("div", { class: "bar" }, el("i", { style: `width:${Math.round((done / steps.length) * 100)}%` })), el("span", {}, `${done} of ${steps.length} connected`)),
    ...steps.map((s) =>
      el(
        "div",
        { class: `step${s.done ? " done" : ""}` },
        el("span", { class: "ic" }, icon(s.icon)),
        el("div", { class: "body" }, el("b", {}, s.name), el("span", {}, s.blurb)),
        el("div", { class: "act" }, s.done ? el("span", { class: "ok-pill" }, icon("check"), "Connected") : (s.action ?? pill("", "Text Jarvis"))),
      ),
    ),
  );
  return card;
}

function accountCard(m: MeView): HTMLElement {
  const copy = el("button", { class: "btn sm quiet", title: "Copy address", onclick: () => void navigator.clipboard?.writeText(m.address) }, icon("copy"), "Copy");
  const row = (ic: keyof typeof ICONS, k: string, v: Child, mono = false) => el("div", { class: "r" }, el("span", { class: "k" }, icon(ic), k), el("span", { class: `v${mono ? " mono" : ""}` }, v));
  const chatName = m.channel.kind === "dev" ? "Dev channel" : m.channel.kind;
  return el(
    "div",
    {},
    el("h2", { class: "sec" }, icon("friends"), "Your account"),
    el(
      "section",
      { class: "card rows2" },
      el(
        "div",
        { class: "who" },
        el("span", { class: "avatar" }, initial(m)),
        el("div", {}, el("b", {}, m.displayName ?? m.tag), el("span", {}, `${m.tag} · Ledger-bound since ${since(m.createdAt)}`)),
        el("div", { class: "act" }, el("a", { class: "btn quiet", href: m.explorerUrl, target: "_blank", rel: "noopener noreferrer" }, icon("arrow"), "Basescan")),
      ),
      row("ledger", "Ledger", el("span", {}, el("span", { class: "mono", title: m.address }, short(m.address)), " ", copy), true),
      row("chat", chatName, m.channel.handle),
      m.channel.jarvis ? row("bubble", "Jarvis", m.channel.jarvis) : undefined,
      row("base", "On Base", m.balance ?? "Balance unavailable right now"),
      row("shield", "Ledger policy", el("span", {}, m.policy.preset, " ", el("a", { class: "link", href: "#policy", style: "font-weight:400;font-size:13.5px;margin-left:8px" }, "Change"))),
    ),
  );
}

function servicesSection(m: MeView, limit?: number): HTMLElement {
  const list = limit ? m.connections.slice(0, limit) : m.connections;
  return el(
    "div",
    {},
    el("h2", { class: "sec" }, icon("grid"), limit ? "Connected services" : "Connections", limit && m.connections.length > limit ? el("a", { class: "more", href: "#connections" }, "All connections", icon("chevron")) : undefined),
    el("section", { class: "card" }, ...list.map(serviceRow)),
  );
}

function serviceRow(c: ConnectionView): HTMLElement {
  const [cls, text] = STATUS_PILL[c.status];
  const body = el("div", { class: "body" }, el("b", {}, c.name), el("span", { class: "sum" }, c.summary), c.detail ? el("span", { class: `det${c.id === "ledger" ? " mono" : ""}` }, c.detail) : undefined);
  const row = el("div", { class: `svc${c.status === "unavailable" ? " off" : ""}` }, el("span", { class: "logo" }, icon(CONNECTION_ICONS[c.id])), body);
  const acts = el("div", { class: "act" });
  for (const a of c.actions) acts.append(actionButton(a, body));
  if (!c.actions.some((a) => a.kind === "connect-google")) acts.append(c.status === "connected" ? el("span", { class: "ok-pill" }, icon("check"), "Connected") : pill(cls, text));
  row.append(acts);
  return row;
}

function fail(body: HTMLElement, text: string): void {
  body.querySelector(".err")?.remove();
  body.append(el("p", { class: "err" }, text));
}
function connectGoogleButton(style = "sm"): HTMLElement {
  return el("button", { class: `btn ${style}`, onclick: async (e: Event) => {
    const b = e.currentTarget as HTMLButtonElement;
    b.disabled = true;
    const r = await post<{ url: string }>("/google/connect");
    if (r.ok && r.url) location.href = r.url;
    else {
      b.disabled = false;
      fail(b.parentElement!, r.error ?? "Could not start the connection.");
    }
  } }, "Connect");
}
function linkPhoneButton(body: HTMLElement, style = "sm quiet"): HTMLElement {
  return el("button", { class: `btn ${style}`, onclick: (e: Event) => {
    const b = e.currentTarget as HTMLButtonElement;
    b.disabled = true;
    const input = el("input", { type: "tel", placeholder: "+1 415 555 0100", autocomplete: "tel" });
    const form = el("form", { class: "form", onsubmit: async (ev: Event) => {
      ev.preventDefault();
      const r = await post("/phone/link", { number: input.value });
      r.ok ? await boot() : fail(form, r.error ?? "Could not link that number.");
    } }, input, el("button", { class: "btn sm", type: "submit" }, "Link"));
    // The form goes under the row's text, wherever the button lives.
    (b.closest(".svc, .step")?.querySelector(".body") ?? body).append(form);
    input.focus();
  } }, "Link a number");
}
function actionButton(a: ConnectionAction, body: HTMLElement): HTMLElement {
  switch (a.kind) {
    case "connect-google":
      return connectGoogleButton();
    case "disconnect-google":
      return el("button", { class: "btn sm quiet", onclick: async (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement;
        b.disabled = true;
        const r = await post("/google/disconnect");
        r.ok ? await boot() : (b.disabled = false, fail(body, r.error ?? "Could not disconnect."));
      } }, "Disconnect");
    case "link-phone":
      return linkPhoneButton(body);
    case "unlink-phone":
      return el("button", { class: "link", title: `Unlink ${a.label}`, onclick: async (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement;
        b.disabled = true;
        const r = await post("/phone/unlink", { handle: a.handle });
        r.ok ? await boot() : (b.disabled = false, fail(body, r.error ?? "Could not unlink."));
      } }, `Unlink ${a.label}`);
  }
}

function recentSection(m: MeView): HTMLElement {
  return el(
    "div",
    {},
    el("h2", { class: "sec" }, icon("activity"), "Recent activity", m.activity.length > 5 ? el("a", { class: "more", href: "#activity" }, "All activity", icon("chevron")) : undefined),
    activityCard(m.activity.slice(0, 5)),
  );
}

function activityRow(a: ActivityView): HTMLElement {
  const [cls, text] = ACTIVITY_PILL[a.status];
  return el(
    "div",
    { class: "act-row" },
    el("span", { class: "logo" }, icon(CODE_ICONS[a.code] ?? "activity")),
    el("div", { class: "body" }, el("b", {}, a.title), el("span", { class: "sum" }, a.summary)),
    el("div", { class: "meta" }, el("span", { class: "when" }, when(a.at)), pill(cls, text), a.link ? el("a", { href: a.link, target: "_blank", rel: "noopener noreferrer" }, "Basescan", icon("arrow")) : undefined),
  );
}
function activityCard(items: ActivityView[]): HTMLElement {
  return el("section", { class: "card" }, items.length ? el("div", {}, ...items.map(activityRow)) : el("p", { class: "empty" }, "Nothing yet. Ask Jarvis for something."));
}
/** The whole list, grouped by day, filtered by the sidebar's search. */
function activityList(items: ActivityView[], q: string): HTMLElement {
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((a) => `${a.title} ${a.summary} ${a.status}`.toLowerCase().includes(needle)) : items;
  const wrap = el("div", {});
  wrap.append(el("h2", { class: "sec", style: "margin-top:0" }, icon("activity"), needle ? `Activity matching "${q.trim()}"` : "Everything proposed for your account"));
  if (!shown.length) return wrap.append(el("section", { class: "card" }, el("p", { class: "empty" }, needle ? "Nothing matches." : "Nothing yet. Ask Jarvis for something."))), wrap;
  let day = "";
  let card: HTMLElement | undefined;
  for (const a of shown) {
    const label = dayLabel(a.at);
    if (label !== day) {
      wrap.append(el("p", { class: "dayhead" }, (day = label)), (card = el("section", { class: "card" })));
    }
    card!.append(activityRow(a));
  }
  return wrap;
}

function dangerSection(m: MeView): HTMLElement {
  const acts = el("div", { class: "act" });
  const err = el("p", { class: "err" });
  const arm = () => {
    acts.replaceChildren(
      el("button", { class: "btn danger", onclick: async (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement;
        b.disabled = true;
        const r = await post<{ url: string; path?: string }>("/delete");
        if (r.ok && (r.path || r.url)) location.href = r.path ?? r.url;
        else {
          b.disabled = false;
          err.textContent = r.error ?? "Could not start the deletion.";
        }
      } }, icon("ledger"), `Sign the deletion of ${m.tag}`),
      el("button", { class: "btn quiet", onclick: () => acts.replaceChildren(start()) }, "Keep my account"),
    );
  };
  const start = () => el("button", { class: "btn quiet", onclick: arm }, "Delete account");
  acts.append(start());
  return el(
    "div",
    {},
    el("h2", { class: "sec" }, icon("ledger"), "Delete account"),
    el(
      "section",
      { class: "card danger" },
      el("p", {}, "Your Ledger signs the deletion, like everything else. Your tag, friends, calendar, notes and chat history are removed; payments already on Base stay on Base. Jarvis texts you the same link, so you can sign from either place."),
      acts,
      err,
    ),
  );
}

// ---- the other sections -------------------------------------------------------------------------------------------

function policyCard(p: PolicyView): HTMLElement {
  const wrap = el("div", {});
  const draw = (view: PolicyView) => {
    wrap.replaceChildren(
      el("h2", { class: "sec", style: "margin-top:0" }, icon("shield"), "What waits for your Ledger"),
      el(
        "section",
        { class: "card" },
        el("div", { class: "switchrow" }, el("div", {}, el("b", {}, "Preset"), el("span", {}, view.description)), segmented(view)),
        ...GUARDS.map((g) =>
          el(
            "div",
            { class: "switchrow" },
            el("div", {}, el("b", {}, g.name), el("span", {}, g.blurb)),
            el("button", { class: `switch${view.gates[g.key] ? " on" : ""}`, role: "switch", "aria-checked": String(view.gates[g.key]), "aria-label": g.name, onclick: (e: Event) => void change({ [g.key]: !view.gates[g.key] }, e.currentTarget as HTMLButtonElement) }),
          ),
        ),
        el("p", { class: "always" }, icon("shield"), "Money and deleting the account always need your Ledger."),
      ),
    );
  };
  const segmented = (view: PolicyView) =>
    el("div", { class: "seg" }, ...PRESETS.map((preset) => el("button", { class: preset === view.preset ? "on" : "", onclick: (e: Event) => void change({ preset }, e.currentTarget as HTMLButtonElement) }, preset)));
  const change = async (c: PolicyChange, b: HTMLButtonElement) => {
    b.disabled = true;
    const r = await post<{ policy: PolicyView }>("/policy", c);
    if (r.ok && r.policy) {
      if (me) me.policy = r.policy;
      draw(r.policy);
    } else {
      b.disabled = false;
      wrap.append(el("p", { class: "err" }, r.error ?? "Could not change the policy."));
    }
  };
  draw(p);
  return wrap;
}

function friendsCard(m: MeView): HTMLElement {
  const label: Record<MeView["friends"][number]["status"], [string, string]> = { accepted: ["on", "Friends"], pending: ["wait", "Waiting on you"], requested: ["", "Waiting on them"] };
  const rows = m.friends.map((f) => el("div", { class: "friend" }, el("span", { class: "avatar" }, f.tag.slice(1, 2).toUpperCase()), el("span", {}, f.tag), pill(...label[f.status])));
  return el(
    "div",
    {},
    el("h2", { class: "sec", style: "margin-top:0" }, icon("friends"), "Agents that may talk to yours"),
    el("section", { class: "card" }, rows.length ? el("div", {}, ...rows) : el("p", { class: "empty" }, "No friends yet. Tell Jarvis: add @yadu as a friend.")),
    el("p", { class: "note" }, "A friend request is signed on your Ledger when your policy says so; accepting one is the friend's own Ledger. Once friends, the two agents can schedule with each other and pass notes."),
  );
}

function soonGrid(): HTMLElement {
  return el("div", { class: "soon" }, ...SOON.map((s) => el("div", { class: "card" }, pill("soon", "Soon"), el("b", {}, s.name), el("p", {}, s.blurb))));
}

// ---- the rail --------------------------------------------------------------------------------------------------------

function railView(m: MeView): HTMLElement[] {
  const eth = /([\d.]+) ETH(?: \(([^)]+)\))?/.exec(m.balance ?? "");
  const usdc = /([\d.]+) USDC/.exec(m.balance ?? "");
  const weekAgo = Date.now() - 7 * 86_400_000;
  const thisWeek = m.activity.filter((a) => Date.parse(a.at) > weekAgo).length;
  const waiting = m.pending;
  const stat = (ic: keyof typeof ICONS, title: string, sub: string, href: string, live = false) =>
    el("a", { class: `stat${live ? " live" : ""}`, href }, el("span", { class: "ic" }, icon(ic)), el("div", {}, el("b", {}, title), el("span", {}, sub)), el("span", { class: "go" }, icon("arrow")));
  return [
    el("h3", {}, icon("eye"), "At a glance"),
    el(
      "div",
      { class: "glance" },
      el("div", { class: "l" }, el("span", { class: "lab" }, "ETH on Base"), el("span", { class: "val" }, eth ? eth[1]! : "–"), el("span", { class: "sub" }, eth?.[2] ? eth[2] : m.balance ? "pays network fees" : "Base did not answer")),
      el("div", { class: "r" }, el("span", { class: "lab" }, "USDC"), el("span", { class: "val" }, usdc ? usdc[1]! : "0"), el("span", { class: "sub" }, "pays for orders")),
    ),
    el(
      "div",
      { class: "stats" },
      stat("ledger", waiting ? `Waiting: ${waiting.title}` : "Nothing waiting on your Ledger", waiting ? waiting.summary : "Jarvis asks here when something needs you", waiting ? (waiting.path ?? waiting.url ?? "#activity") : "#activity", !!waiting),
      stat("friends", `${m.friends.filter((f) => f.status === "accepted").length} friend${m.friends.filter((f) => f.status === "accepted").length === 1 ? "" : "s"}`, m.friends.some((f) => f.status === "pending") ? "A request is waiting on you" : "Agents that may talk to yours", "#friends"),
      stat("activity", `${thisWeek} action${thisWeek === 1 ? "" : "s"} this week`, "Proposed in the last 7 days", "#activity"),
    ),
    el("hr"),
    el("h3", {}, icon("spark"), "More to explore"),
    el(
      "div",
      { class: "stats" },
      stat("shield", "Ledger policy", `${m.policy.preset}: pick what waits for your Ledger`, "#policy"),
      stat("grid", "Connections", "Google Calendar, calls, Amazon, DoorDash", "#connections"),
      stat("spark", "Coming soon", "Spending limits, recurring payments and more", "#soon"),
    ),
  ];
}

// ---- boot ----------------------------------------------------------------------------------------------------------

function signedOut(info: InfoView | undefined): void {
  me = undefined;
  $("nav").replaceChildren();
  $("sideBottom").replaceChildren();
  $("acts").replaceChildren(el("button", { class: "btn quiet tall", onclick: showLogin }, icon("ledger"), "Log in"));
  $("title").replaceChildren(icon("home"), el("span", {}, "Jarvis"));
  $("rail").hidden = true;
  (document.querySelector(".search") as HTMLElement).hidden = true;
  $("view").replaceChildren(doorView(info));
}

async function boot(): Promise<void> {
  const r = await api<MeView>("/me");
  if (r.status === 401 || !r.tag) {
    const info = await api<InfoView>("/info").catch(() => undefined);
    signedOut(info?.ok ? info : undefined);
    return;
  }
  me = r;
  (document.querySelector(".search") as HTMLElement).hidden = false;
  drawShell(r);
}

// The sidebar's search filters the activity list (and opens it).
$("nav").insertAdjacentElement("beforebegin", el("label", { class: "search" }, icon("search"), el("input", { type: "search", placeholder: "Search activity", oninput: (e: Event) => {
  query = (e.target as HTMLInputElement).value;
  if (!me) return;
  if (current() !== "activity") location.hash = "#activity";
  else $("view").replaceChildren(VIEWS.activity(me));
} })));
window.addEventListener("hashchange", () => void (me ? drawShell(me) : undefined));
void boot().catch(() => $("view").replaceChildren(el("p", { class: "loading" }, "Could not load your account. Reload the page.")));
