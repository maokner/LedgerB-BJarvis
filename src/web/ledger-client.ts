/**
 * Browser side of /sign/<token> (bundled to /ledger.js by src/web/bundle.ts). Connects to the Ledger (src/web/ledger-connect.ts),
 * asks the Ethereum app for exactly what the server asked for (askEthApp, shared with the USB path), posts the
 * answer back, then follows the action until it is done. Holds no secrets: the token is the page's own URL.
 */
import { askEthApp, type EthAnswer, type EthRequest } from "../device/eth-tx.js";
import { messageChunks } from "./ledger-app.js";
import { connectEthereum, hid, knownLedger, NO_ANSWER, NO_HID, NOT_SECURE, Plain, plainError, rejected, release, reportsSeen } from "./ledger-connect.js";
import { TONE } from "./theme.js";

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
const DONE: Record<string, string> = { PAY: "Sent on Base", BUY: "Paid, ordering on Amazon", EAT: "Paid, ordering on DoorDash", CAL: "Added to calendar", FRQ: "Friend request sent", FAC: "Friend added", ACC: "Account created", DEL: "Account deleted" };
const HEAD: Record<string, string> = { approved: "Verified, finishing up", executed: "Done", rejected: "Rejected", expired: "Expired", failed: "Did not go through" };
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
const ON_DEVICE = "Your Ledger on the AgentSign Mac already shows this request. Approve it there; this page follows along.";

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

/** Progress line: 0 Request, 1 Ledger, 2 Verified, 3 Done (4 = all done). */
function stage(n: number, failed = false): void {
  document.querySelectorAll<HTMLElement>("#steps li").forEach((li, i) => (li.className = i < n ? "done" : i === n ? (failed ? "fail" : "now") : ""));
  $("steps").style.setProperty("--p", String(Math.min(n, 3) / 3));
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
    a.style.display = "block";
  }
}
function headline(status: string): void {
  if (!HEAD[status]) return;
  $("eyebrow").textContent = HEAD[status]!;
  $("eyebrow").className = `eyebrow ${TONE[status] ?? ""}`;
}

async function follow(code: string): Promise<void> {
  for (;;) {
    const s = await get<State>("/state").catch(() => undefined);
    if (s) headline(s.status);
    if (s?.status === "executed") return stage(4), finish(DONE[code] ?? "Done", s.link), say("You can head back to your chat.", false);
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

function sentText(request: EthRequest): string {
  if (request.kind === "message") {
    const bytes = new TextEncoder().encode(request.message).length;
    return `Sent message to Ledger (${bytes} bytes, ${messageChunks(bytes)} chunk${messageChunks(bytes) > 1 ? "s" : ""})`;
  }
  return request.kind === "tx" ? "Sent transaction to Ledger" : "Sent address check to Ledger";
}

async function approve(job: Job): Promise<void> {
  if (!hid()) return say(NO_HID);
  go.disabled = true;
  say("", false);
  const label = $("goLabel");
  label.textContent = "Connecting to your Ledger";
  step("Connecting");
  try {
    const { app, address } = await connectEthereum({ step, report });
    // An empty job address is a sign-up from a Ledger the server has not seen yet: any Ledger may answer.
    if (job.address && address !== job.address) throw new Plain(`This Ledger is not the one bound to ${job.tag}.`);
    label.textContent = "Confirm on your Ledger";
    $("hint").textContent = GUIDE[job.request.kind];
    step(sentText(job.request));
    const answer = await deviceAnswer(askEthApp(app, job.request));
    step(`Signature received (inputreport events: ${reportsSeen()})`);
    label.textContent = "Checking the signature";
    step("Posting");
    const r = await post("/result", { ...answer, address });
    step(`Server: ${r.ok ? "verified" : (r.error ?? r.status)}`);
    if (!r.ok) throw new Plain(r.error ?? "The server refused it.");
    stage(2);
    headline("approved");
    finish("Verified", undefined);
    say("Your Ledger signed it. Finishing up.", false);
    void follow(job.code);
  } catch (err) {
    const e = err as { name?: string; message?: string; statusCode?: number };
    report(`error: ${e.name ?? "Error"}: ${e.message ?? String(err)}${e.statusCode ? ` (status 0x${e.statusCode.toString(16)})` : ""}`);
    step(`Stopped: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Ended) return err.status === "expired" || err.status === "pending" ? say(EXPIRED) : void follow(job.code);
    if (rejected(err)) {
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
  const beat = setInterval(() => report(`waiting ${Math.round((Date.now() - started) / 1000)}s, inputreport events so far: ${reportsSeen()}`), 10_000);
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
  if (!hid()) say(window.isSecureContext ? NO_HID : NOT_SECURE);
  else if (await knownLedger()) step("This browser already knows your Ledger; no device picker needed.");
  go.onclick = () => void approve(job);
}

void main().catch(() => say("Could not load this request. Reload the page."));
