/**
 * Browser side of /sign/<token> (bundled to /ledger.js by src/web/bundle.ts). Talks to the Ledger over WebHID,
 * asks the Ethereum app for exactly what the server asked for (askEthApp, shared with the USB path), posts the
 * answer back, then follows the action until it is done. Holds no secrets: the token is the page's own URL.
 */
import TransportModule from "@ledgerhq/hw-transport-webhid";
import { askEthApp, type EthAnswer, type EthRequest } from "../device/eth-tx.js";
import { appName, ethAppOver, messageChunks, type Transport } from "./ledger-app.js";

interface HidDevice {
  vendorId: number;
  opened: boolean;
  productName: string;
  collections: { usagePage: number; usage: number }[];
  close(): Promise<void>;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: unknown): void;
}
const TransportWebHID = TransportModule as unknown as { open(device: HidDevice): Promise<Transport>; request(): Promise<Transport> };
const hid = () => (navigator as unknown as { hid?: { getDevices(): Promise<HidDevice[]> } }).hid;
const LEDGER_VENDOR = 0x2c97;
/** How long to wait for the person and the device before saying the Ledger did not answer. */
const WATCHDOG_MS = 120_000;

interface Job {
  code: string;
  tag: string;
  address: string;
  request: EthRequest;
  status: string;
}
interface State {
  status: "pending" | "approved" | "executed" | "rejected" | "expired" | "failed";
  link?: string;
  /** The Ledger plugged into the server's Mac shows the request; this page only follows along. */
  onDevice?: boolean;
}

const base = location.pathname.replace(/\/+$/, "");
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const go = $("go") as HTMLButtonElement;
const DONE: Record<string, string> = { PAY: "Sent on Base", CAL: "Added to calendar", FRQ: "Friend request sent", FAC: "Friend added", ACC: "Account created" };
const HEAD: Record<string, string> = { approved: "Verified. Finishing up", executed: "Done", rejected: "Rejected", expired: "Expired", failed: "Did not go through" };
const EXPIRED = "This request expired on the server. Ask Jarvis again and open the new link.";
/** What to press while the device shows the request. */
const GUIDE: Record<EthRequest["kind"], string> = {
  message: "On your Ledger: scroll right through the message pages, then press both buttons on 'Sign message'.",
  tx: "On your Ledger: scroll right through the transaction pages, then press both buttons on 'Accept and send'.",
  address: "On your Ledger: check the address, then press both buttons on 'Approve' under the address.",
};
const ENDED: Record<string, string> = {
  rejected: "Rejected. Nothing happened.",
  expired: EXPIRED,
  failed: "It did not go through. The agent texted you why.",
};
const NO_HID = "Open this link in Chrome on the computer your Ledger is plugged into.";
const ON_DEVICE = "Your Ledger on the AgentSign Mac already shows this request. Approve it there; this page follows along.";
const WRONG_APP = "Open the Ethereum app on your Ledger.";
const HELD = "Another app is holding your Ledger (usually Ledger Live or a wallet extension). Quit it, unplug and replug the Ledger, open the Ethereum app, then try again.";
const NO_ANSWER = "No answer from the Ledger. Unplug it, plug it back in, close other wallet tabs, reload this page and try again.";

class Plain extends Error {}
/** The server stopped waiting (expired, or answered elsewhere) while the device still showed the request. */
class Ended extends Error {
  constructor(readonly status: string) {
    super(status);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const headers = { "content-type": "application/json", "ngrok-skip-browser-warning": "1" };
const get = async <T>(path: string): Promise<T> => (await fetch(base + path, { headers, cache: "no-store" })).json() as Promise<T>;
const post = async (path: string, body: unknown = {}) =>
  (await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) })).json() as Promise<{ ok: boolean; status: string; error?: string }>;

/** Timeline: 0 Request, 1 Ledger, 2 Verified, 3 Done (4 = all done). */
function stage(n: number, failed = false): void {
  document.querySelectorAll<HTMLElement>("ol li").forEach((li, i) => (li.className = i < n ? "done" : i === n ? (failed ? "fail" : "now") : ""));
  ($("steps") as HTMLElement).style.setProperty("--p", String(Math.min(n, 3) / 3));
}
function say(text: string, error = true): void {
  $("err").textContent = text;
  $("err").className = error ? "err" : "note";
}
function finish(title: string, link?: string): void {
  $("act").style.display = "none";
  $("ok").style.display = "flex";
  $("okTitle").textContent = title;
  if (link) {
    const a = $("tx") as HTMLAnchorElement;
    a.href = link;
    a.style.display = "flex";
  }
}

async function follow(code: string): Promise<void> {
  for (;;) {
    const s = await get<State>("/state").catch(() => undefined);
    if (s && HEAD[s.status]) {
      $("eyebrow").textContent = HEAD[s.status]!;
      $("eyebrow").className = `eyebrow ${s.status}`;
    }
    if (s?.status === "executed") return stage(4), finish(DONE[code] ?? "Done", s.link), say("You can head back to Messages.", false);
    if (s && ENDED[s.status]) {
      stage(s.status === "failed" ? 3 : 1, true);
      go.style.display = "none";
      return say(ENDED[s.status]!);
    }
    if (s?.status === "approved") stage(2);
    if (s?.status === "pending" && s.onDevice) {
      go.style.display = "none";
      $("hint").textContent = "";
      say(ON_DEVICE, false);
    }
    await sleep(2000);
  }
}

/** The last thing that happened, in small grey text under the button, so a stuck step is visible; also sent to the server log. */
function step(text: string): void {
  $("log").textContent = text;
  report(text);
}

// Every step line goes to POST /log too (the server takes one post per second, so lines are batched).
let pending: string[] = [];
let flushing: ReturnType<typeof setTimeout> | undefined;
function report(line: string): void {
  pending.push(line);
  flushing ??= setTimeout(flush, 0);
}
async function flush(): Promise<void> {
  const lines = pending;
  pending = [];
  const ok = await fetch(base + "/log", { method: "POST", headers, body: JSON.stringify({ lines }) }).then((r) => r.status !== 429, () => true);
  if (!ok) pending = [...lines, ...pending];
  flushing = pending.length ? setTimeout(flush, 1100) : undefined;
}
const describe = (d: HidDevice) => `${d.productName} [${d.collections.map((c) => `0x${c.usagePage.toString(16)}/0x${c.usage.toString(16)}`).join(" ")}]`;
/** inputreport events seen on the open device: if the Ledger answers but this stays flat, the browser never delivered it. */
let inputReports = 0;
const countReport = () => void (inputReports += 1);
const short = (address: string) => `${address.slice(0, 6)}..${address.slice(-4)}`;

let current: Transport | undefined;
/** Drops the HID handle. transport.close() waits for a running exchange, which may never end, so close the device itself. */
async function release(): Promise<void> {
  const old = current as unknown as { device?: HidDevice; onInputReport?: unknown } | undefined;
  current = undefined;
  // Also detach the old transport, or it keeps listening on the same HIDDevice next to the new one.
  if (old?.onInputReport) old.device?.removeEventListener("inputreport", old.onInputReport);
  old?.device?.removeEventListener("inputreport", countReport);
  await old?.device?.close().catch(() => undefined);
}
/** A Ledger this site may already use is opened without the picker; any earlier handle is closed first. */
async function openLedger(): Promise<Transport> {
  await release();
  const ledgers = (await hid()!.getDevices()).filter((d) => d.vendorId === LEDGER_VENDOR);
  report(`getDevices: ${ledgers.length} Ledger device(s): ${ledgers.map(describe).join(", ") || "none"}`);
  // The APDU interface is usage page 0xffa0; never the FIDO one (0xf1d0).
  const known = ledgers.find((d) => d.collections.some((c) => c.usagePage === 0xffa0)) ?? ledgers.find((d) => !d.collections.some((c) => c.usagePage === 0xf1d0));
  if (known) report(`chose ${describe(known)}${known.opened ? " (was open, closing it first)" : ""}`);
  if (known?.opened) await known.close().catch(() => undefined);
  step(known ? "Connecting to the Ledger this browser already knows" : "Connecting: pick your Ledger in the list");
  current = known
    ? await TransportWebHID.open(known).catch((err: unknown) => {
        const held = (err as { name?: string }).name === "NotAllowedError";
        step(held ? "Could not open the Ledger: another app may be holding it. Trying the device picker" : `open(known) failed: ${String(err)}; trying the device picker`);
        return TransportWebHID.request();
      })
    : await TransportWebHID.request();
  const device = (current as unknown as { device?: HidDevice }).device;
  inputReports = 0;
  device?.addEventListener("inputreport", countReport);
  if (device) report(`opened ${describe(device)}`);
  return current;
}

function sentText(request: EthRequest): string {
  if (request.kind === "message") {
    const bytes = new TextEncoder().encode(request.message).length;
    return `Sent message to Ledger (${bytes} bytes, ${messageChunks(bytes)} chunk${messageChunks(bytes) > 1 ? "s" : ""})`;
  }
  return request.kind === "tx" ? "Sent transaction to Ledger" : "Sent address check to Ledger";
}

function plainError(err: unknown): string {
  const e = err as { name?: string; statusCode?: number; message?: string };
  if (err instanceof Plain) return e.message!;
  if (e.name === "NotAllowedError") return HELD;
  if (e.name === "TransportOpenUserCancelled" || e.name === "NotFoundError") return "Pick your Ledger in the browser's list to continue.";
  if (e.statusCode === 0x5515 || e.name === "LockedDeviceError") return "Unlock your Ledger, then open the Ethereum app.";
  if (e.statusCode === 0x6e00 || e.statusCode === 0x6d00 || e.statusCode === 0x6e01 || e.statusCode === 0x6511) return WRONG_APP;
  if (e.name === "TransportRaceCondition" || /busy|claimed|open/i.test(e.message ?? "")) return "Your Ledger is busy. Close Ledger Live and other wallet tabs, then try again.";
  return `Could not talk to your Ledger (${e.message ?? "unknown error"}). Unlock it, open the Ethereum app, and try again.`;
}

async function approve(job: Job): Promise<void> {
  if (!hid()) return say(NO_HID);
  go.disabled = true;
  say("", false);
  const label = $("goLabel");
  label.textContent = "Connecting to your Ledger";
  step("Connecting");
  try {
    const transport = await openLedger();
    // The first exchange: if nothing answers, another process holds the Ledger's HID interface.
    let firstTimer: ReturnType<typeof setTimeout> | undefined;
    const silent = new Promise<never>((_, reject) => (firstTimer = setTimeout(() => reject(new Plain(HELD)), 5000)));
    const name = await Promise.race([appName(transport), silent]).finally(() => clearTimeout(firstTimer));
    step(`App open on the Ledger: ${name}`);
    if (name !== "Ethereum") throw new Plain(WRONG_APP);
    const app = ethAppOver(transport);
    // Always read the address first: it wakes the app's APDU path and gives a sanity check to send with the result.
    const address = (await app.getAddress(false)).toLowerCase();
    step(`Ethereum app found, address ${short(address)}`);
    // An empty job address is a sign-up from a Ledger the server has not seen yet: any Ledger may answer.
    if (job.address && address !== job.address) throw new Plain(`This Ledger is not the one bound to ${job.tag}.`);
    label.textContent = "Confirm on your Ledger";
    $("hint").textContent = GUIDE[job.request.kind];
    step(sentText(job.request));
    const answer = await deviceAnswer(askEthApp(app, job.request));
    step(`Signature received (inputreport events: ${inputReports})`);
    label.textContent = "Checking the signature";
    step("Posting");
    const r = await post("/result", { ...answer, address });
    step(`Server: ${r.ok ? "verified" : (r.error ?? r.status)}`);
    if (!r.ok) throw new Plain(r.error ?? "The server refused it.");
    stage(2);
    finish("Verified", undefined);
    say("Your Ledger signed it. Finishing up.", false);
    void follow(job.code);
  } catch (err) {
    const e = err as { name?: string; message?: string; statusCode?: number };
    report(`error: ${e.name ?? "Error"}: ${e.message ?? String(err)}${e.statusCode ? ` (status 0x${e.statusCode.toString(16)})` : ""}`);
    step(`Stopped: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Ended) return err.status === "expired" || err.status === "pending" ? say(EXPIRED) : void follow(job.code);
    if ((err as { statusCode?: number }).statusCode === 0x6985) {
      await post("/reject").catch(() => undefined);
      return void follow(job.code);
    }
    say(plainError(err));
  } finally {
    $("hint").textContent = "";
    label.textContent = "Approve on Ledger";
    go.disabled = false;
    await release();
  }
}

/**
 * Waits for the device, but not forever: stops when the server no longer waits (checked every 3 s) or after
 * WATCHDOG_MS without an answer.
 */
async function deviceAnswer(answer: Promise<EthAnswer>): Promise<EthAnswer> {
  let watch: ReturnType<typeof setInterval> | undefined;
  let dog: ReturnType<typeof setTimeout> | undefined;
  const started = Date.now();
  const beat = setInterval(() => report(`waiting ${Math.round((Date.now() - started) / 1000)}s, inputreport events so far: ${inputReports}`), 10_000);
  const stop = new Promise<never>((_, reject) => {
    watch = setInterval(() => void get<State>("/state").then((s) => s.status !== "pending" && reject(new Ended(s.status)), () => undefined), 3000);
    dog = setTimeout(() => reject(new Plain(NO_ANSWER)), WATCHDOG_MS);
  });
  stop.catch(() => undefined);
  try {
    return await Promise.race([answer, stop]);
  } finally {
    clearInterval(watch);
    clearInterval(beat);
    clearTimeout(dog);
  }
}

async function main(): Promise<void> {
  const [job, state] = await Promise.all([get<Job>("/job"), get<State>("/state")]);
  if (job.status !== "pending" || state.status !== "pending") return follow(job.code);
  if (!hid()) say(window.isSecureContext ? NO_HID : "This link must be opened over https. Ask whoever runs the server to set an https PUBLIC_URL.");
  else if ((await hid()!.getDevices()).some((d) => d.vendorId === LEDGER_VENDOR)) step("This browser already knows your Ledger; no device picker needed.");
  go.onclick = () => void approve(job);
}

void main().catch(() => say("Could not load this request. Reload the page."));
