/**
 * Browser side of the account page (bundled to /dashboard.js by src/web/bundle.ts). Signs in with the Ledger
 * (a personal message over WebHID, src/web/ledger-connect.ts), then draws the account from GET /api/me and sends
 * every change back to /api/* (contract: src/web/account-api.ts). No framework: small DOM helpers, one render per view.
 */
import { askEthApp } from "../device/eth-tx.js";
import type { ActivityView, ConnectionAction, ConnectionView, LoginChallenge, MeView, PolicyChange, PolicyGuard, PolicyPreset, PolicyView } from "./account-api.js";
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
const app = $("app");
const who = $("who");
const headers = { "content-type": "application/json" };

async function api<T>(path: string, body?: unknown): Promise<T & { ok?: boolean; error?: string; status: number }> {
  const res = await fetch(`/api${path}`, body === undefined ? { cache: "no-store" } : { method: "POST", headers, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  return { ...json, status: res.status };
}
const post = <T = Record<string, never>>(path: string, body: unknown = {}) => api<T>(path, body);

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

// ---- the account -----------------------------------------------------------------------------------------------

const CONNECTION_ICONS: Record<ConnectionView["id"], keyof typeof ICONS> = { chat: "chat", ledger: "ledger", google: "calendar", phone: "phone", amazon: "cart", doordash: "bowl" };
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
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const since = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const pill = (cls: string, text: string) => el("span", { class: `pill ${cls}` }, text);

function accountView(me: MeView): HTMLElement {
  const root = el("div", {});
  root.append(hero(me), connections(me), el("div", { class: "two" }, policy(me.policy), friends(me)), activity(me), comingSoon(), danger(me));
  return root;
}

function hero(me: MeView): HTMLElement {
  const copy = el("button", { class: "iconbtn", title: "Copy address", onclick: () => void navigator.clipboard?.writeText(me.address) }, icon("copy"));
  const meta = el(
    "p",
    { class: "meta" },
    me.displayName ? el("span", {}, me.displayName) : undefined,
    el("span", {}, `Ledger-bound since ${since(me.createdAt)}`),
    el("span", { class: "mono", title: me.address }, short(me.address)),
    copy,
    el("a", { class: "iconbtn", href: me.explorerUrl, target: "_blank", rel: "noopener noreferrer", title: "View on Basescan" }, icon("arrow")),
  );
  const tile = el(
    "div",
    { class: "card tile" },
    el("span", { class: "eyebrow" }, "On Base"),
    el("b", {}, me.balance ?? "Balance unavailable right now"),
    el("p", { class: "sub" }, me.balance ? "ETH pays network fees; USDC pays for orders." : "Base did not answer in time. Reload to try again."),
  );
  const head = el("div", { class: "hero" }, el("div", {}, el("p", { class: "eyebrow" }, "Account"), el("h1", {}, me.tag), meta), tile);
  const wrap = el("div", {}, head);
  if (me.pending) {
    const href = me.pending.path ?? me.pending.url;
    wrap.append(
      el(
        "div",
        { class: "banner" },
        el("div", {}, el("b", {}, `Your Ledger is waiting: ${me.pending.title}`), el("span", {}, me.pending.summary)),
        href ? el("a", { class: "btn", href }, "Open the approval") : undefined,
      ),
    );
  }
  return wrap;
}

function connections(me: MeView): HTMLElement {
  const list = el("div", { class: "card list" }, ...me.connections.map((c) => connectionRow(c)));
  return el(
    "section",
    {},
    el("header", {}, el("h2", {}, "Connections"), el("p", {}, "What Jarvis can reach on your behalf.")),
    list,
  );
}

function connectionRow(c: ConnectionView): HTMLElement {
  const [cls, text] = STATUS_PILL[c.status];
  const body = el(
    "div",
    { class: "body" },
    el("div", { class: "name" }, c.name, pill(cls, text)),
    el("p", { class: "sum" }, c.summary),
    c.detail ? el("p", { class: `det${c.id === "ledger" ? " mono" : ""}` }, c.detail) : undefined,
  );
  const row = el("div", { class: `row${c.status === "unavailable" ? " off" : ""}` }, el("span", { class: "ic" }, icon(CONNECTION_ICONS[c.id])), body);
  const acts = el("div", { class: "act" });
  for (const a of c.actions) acts.append(actionButton(a, body, row));
  if (c.actions.length) row.append(acts);
  return row;
}

function actionButton(a: ConnectionAction, body: HTMLElement, row: HTMLElement): HTMLElement {
  const busy = (b: HTMLButtonElement, on: boolean) => void (b.disabled = on);
  const fail = (text: string) => {
    body.querySelector(".err")?.remove();
    body.append(el("p", { class: "err" }, text));
  };
  switch (a.kind) {
    case "connect-google":
      return el("button", { class: "btn sm", onclick: async (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement;
        busy(b, true);
        const r = await post<{ url: string }>("/google/connect");
        if (r.ok && r.url) location.href = r.url;
        else busy(b, false), fail(r.error ?? "Could not start the connection.");
      } }, "Connect");
    case "disconnect-google":
      return el("button", { class: "btn sm quiet", onclick: async (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement;
        busy(b, true);
        const r = await post("/google/disconnect");
        r.ok ? await boot() : (busy(b, false), fail(r.error ?? "Could not disconnect."));
      } }, "Disconnect");
    case "link-phone":
      return el("button", { class: "btn sm quiet", onclick: (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement;
        b.disabled = true;
        const input = el("input", { type: "tel", placeholder: "+1 415 555 0100", autocomplete: "tel" });
        const form = el("form", { class: "form", onsubmit: async (ev: Event) => {
          ev.preventDefault();
          const r = await post("/phone/link", { number: input.value });
          r.ok ? await boot() : fail(r.error ?? "Could not link that number.");
        } }, input, el("button", { class: "btn sm", type: "submit" }, "Link"));
        body.append(form);
        input.focus();
      } }, "Link a number");
    case "unlink-phone":
      return el("button", { class: "link", title: `Unlink ${a.label}`, onclick: async (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement;
        busy(b, true);
        const r = await post("/phone/unlink", { handle: a.handle });
        r.ok ? await boot() : (busy(b, false), fail(r.error ?? "Could not unlink."));
      } }, `Unlink ${a.label}`);
  }
  return el("span", { hidden: true }, row.className);
}

function policy(p: PolicyView): HTMLElement {
  const section = el("section", {});
  const draw = (view: PolicyView) => {
    section.replaceChildren(
      el("header", {}, el("h2", {}, "Ledger policy"), el("p", {}, "What waits for your Ledger.")),
      el(
        "div",
        { class: "card list" },
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
    if (r.ok && r.policy) draw(r.policy);
    else {
      b.disabled = false;
      section.append(el("p", { class: "err" }, r.error ?? "Could not change the policy."));
    }
  };
  draw(p);
  return section;
}

function friends(me: MeView): HTMLElement {
  const label: Record<MeView["friends"][number]["status"], [string, string]> = { accepted: ["on", "Friends"], pending: ["wait", "Waiting on you"], requested: ["", "Waiting on them"] };
  const rows = me.friends.map((f) => el("div", { class: "friend" }, el("span", {}, f.tag), pill(...label[f.status])));
  return el(
    "section",
    {},
    el("header", {}, el("h2", {}, "Friends"), el("p", {}, "Agents that may talk to yours.")),
    el("div", { class: "card list" }, rows.length ? el("div", {}, ...rows) : el("p", { class: "empty" }, "No friends yet. Tell Jarvis: add @yadu as a friend.")),
  );
}

function activity(me: MeView): HTMLElement {
  const rows = me.activity.map((a) => {
    const [cls, text] = ACTIVITY_PILL[a.status];
    return el(
      "div",
      { class: "row" },
      el("div", { class: "body" }, el("div", { class: "name" }, a.title, pill(cls, text)), el("p", { class: "sum" }, a.summary)),
      el("div", { class: "act" }, el("span", { class: "when" }, when(a.at)), a.link ? el("a", { class: "iconbtn", href: a.link, target: "_blank", rel: "noopener noreferrer", title: "View on Basescan" }, icon("arrow")) : undefined),
    );
  });
  return el(
    "section",
    { class: "activity" },
    el("header", {}, el("h2", {}, "Recent activity"), el("p", {}, "Everything proposed for your account, signed or not.")),
    el("div", { class: "card list" }, rows.length ? el("div", {}, ...rows) : el("p", { class: "empty" }, "Nothing yet. Ask Jarvis for something.")),
  );
}

function comingSoon(): HTMLElement {
  return el(
    "section",
    {},
    el("header", {}, el("h2", {}, "Coming soon"), el("p", {}, "Same rule for all of it: the Ledger signs what matters.")),
    el("div", { class: "soon" }, ...SOON.map((s) => el("div", { class: "card" }, pill("soon", "Soon"), el("b", {}, s.name), el("p", {}, s.blurb)))),
  );
}

function danger(me: MeView): HTMLElement {
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
      } }, icon("ledger"), `Sign the deletion of ${me.tag}`),
      el("button", { class: "btn quiet", onclick: () => acts.replaceChildren(start()) }, "Keep my account"),
    );
  };
  const start = () => el("button", { class: "btn quiet", onclick: arm }, "Delete account");
  acts.append(start());
  return el(
    "section",
    {},
    el("header", {}, el("h2", {}, "Delete account")),
    el(
      "div",
      { class: "card danger" },
      el("p", {}, "Your Ledger signs the deletion, like everything else. Your tag, friends, calendar, notes and chat history are removed; payments already on Base stay on Base. Jarvis texts you the same link, so you can sign from either place."),
      acts,
      err,
    ),
  );
}

// ---- boot ------------------------------------------------------------------------------------------------------

async function boot(): Promise<void> {
  const me = await api<MeView>("/me");
  if (me.status === 401 || !me.tag) {
    who.replaceChildren();
    app.replaceChildren(loginView());
    if (hid() && (await knownLedger())) ($("log") as HTMLElement).textContent = "This browser already knows your Ledger; no device picker needed.";
    return;
  }
  who.replaceChildren(
    el("span", {}, me.tag),
    el("button", { class: "btn sm quiet", onclick: async () => {
      await post("/logout");
      await boot();
    } }, "Sign out"),
  );
  app.replaceChildren(accountView(me));
}

void boot().catch(() => app.replaceChildren(el("p", { class: "loading" }, "Could not load your account. Reload the page.")));
