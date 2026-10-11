/** The approval page path: an ethers Wallet plays the Ledger in the browser, over the real HTTP routes. */
import { Transaction, Wallet } from "ethers";
import { afterEach, describe, expect, it } from "vitest";
import { newActionId } from "../src/actions.js";
import { createApprovals } from "../src/approvals.js";
import { openDb } from "../src/db.js";
import { askEthApp, type EthRequest } from "../src/device/eth-tx.js";
import { createEthDeviceManager, type EthEndpoint } from "../src/device/eth.js";
import { verifyEthSignature } from "../src/device/eth-verify.js";
import { combineDeviceManagers, createRemoteDeviceManager, TAKEN_BY_USB } from "../src/device/remote.js";
import { baseMoney } from "../src/money.js";
import { ACTION_TITLES, type Action, type DeviceManager, type SignResult } from "../src/types.js";
import { startWebServer, type WebServer } from "../src/web/server.js";
import { fakeChannel, fakeEthApp, fakeEthDevices, stubChain } from "./helpers.js";

const matt = new Wallet(Wallet.createRandom().privateKey);
const yadu = new Wallet(Wallet.createRandom().privateKey);
const addr = (w: Wallet) => w.address.toLowerCase();
const meta = { to: yadu.address, valueWei: "1250000000000000", chainId: 8453, nonce: 7, gasLimit: "21000", maxFeePerGas: "10000000", maxPriorityFeePerGas: "1000000" };
const cal = (): Action => ({ code: "CAL", id: newActionId(), fields: [{ label: "Title", value: "Lunch <b>" }, { label: "When", value: "Sun Oct 11 12:00-12:30" }] });
const pay = (): Action => ({ code: "PAY", id: newActionId(), fields: [{ label: "To", value: "@yadu" }, { label: "Amount", value: "$5.00" }], meta });
const acc = (): Action => ({ code: "ACC", id: newActionId(), fields: [{ label: "Tag", value: "@matt" }, { label: "Phone", value: "+14155550001" }] });

let web: WebServer | undefined;
afterEach(async () => {
  await web?.close();
  web = undefined;
});

async function setup(windowMs?: number) {
  const db = openDb(":memory:");
  const account = db.createAccount("@matt", addr(matt), "+14155550001", 0);
  const remote = createRemoteDeviceManager({ db, publicUrl: "https://agent.example/", windowMs: windowMs ? () => windowMs : undefined });
  const logs: string[] = [];
  web = await startWebServer({ db, remote, port: 0, log: (l) => logs.push(l) });
  const base = `http://127.0.0.1:${web.port}`;
  const http = async (path: string, init?: RequestInit) => {
    const res = await fetch(base + path, init);
    return { status: res.status, headers: res.headers, body: res.headers.get("content-type")?.includes("json") ? ((await res.json()) as Record<string, unknown>) : await res.text() };
  };
  const post = (path: string, body: unknown = {}) => http(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  /** prepare() as approvals does, then the token from the link. */
  const link = async (action: Action, pubkey = addr(matt)) => {
    const { url } = await remote.prepare(pubkey, action);
    expect(url).toMatch(/^https:\/\/agent\.example\/sign\/[0-9a-f]{64}$/);
    db.insertAction(action.code === "ACC" ? null : account.id, action);
    return url.split("/").pop()!;
  };
  /** The browser: load the job, have the "Ledger" do what it asks, post the answer. */
  const signInBrowser = async (token: string, wallet: Wallet) => {
    const job = (await http(`/sign/${token}/job`)).body as { request: EthRequest; address: string; tag: string };
    return post(`/sign/${token}/result`, await askEthApp(fakeEthApp(wallet), job.request));
  };
  return { db, account, remote, http, post, link, signInBrowser, logs };
}

describe("remote signing over the approval page", () => {
  it("signs a personal message, verifies it, and refuses a second use of the link", async () => {
    const { remote, http, link, signInBrowser } = await setup();
    const action = cal();
    const token = await link(action);
    const page = await http(`/sign/${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.body).toContain("Add to calendar");
    expect(page.body).toContain("Lunch &lt;b&gt;");
    expect(page.body).toContain("Approve on Ledger");
    const job = (await http(`/sign/${token}/job`)).body;
    expect(job).toMatchObject({ code: "CAL", title: "Add to calendar", tag: "@matt", address: addr(matt), status: "pending", request: { kind: "message" } });
    const signing = remote.sign(addr(matt), action, { timeoutMs: 5000 });
    expect((await signInBrowser(token, matt)).body).toEqual({ ok: true, status: "signed" });
    const result = await signing;
    expect(result.status).toBe("approved");
    expect(verifyEthSignature(addr(matt), action, (result as { signature: string }).signature)).toBe(true);
    const again = await signInBrowser(token, matt);
    expect([again.status, again.body]).toEqual([409, { ok: false, status: "signed", error: "This request was already approved." }]);
  });

  it("assembles the signed transaction like the USB path and checks it against the meta", async () => {
    const { remote, link, signInBrowser, http } = await setup();
    const action = pay();
    const token = await link(action);
    expect((await http(`/sign/${token}`)).body).toContain("$5.00");
    const signing = remote.sign(addr(matt), action, { timeoutMs: 5000 });
    expect((await signInBrowser(token, matt)).status).toBe(200);
    const result = (await signing) as { status: string; signature: string };
    const tx = Transaction.from(result.signature);
    expect([tx.from, tx.to, tx.value, tx.chainId, tx.nonce]).toEqual([matt.address, yadu.address, 1_250_000_000_000_000n, 8453n, 7]);
    expect(verifyEthSignature(addr(matt), action, result.signature)).toBe(true);
  });

  it("ACC on the page is a signed message, not a bare address", async () => {
    const { remote, link, signInBrowser, post, http } = await setup();
    const action = acc();
    const token = await link(action);
    expect((await http(`/sign/${token}/job`)).body).toMatchObject({ request: { kind: "message", message: "AgentSign\nCreate account\nTag: @matt\nPhone: +14155550001\nid: " + action.id.slice(0, 8) } });
    const signing = remote.sign(addr(matt), action, { timeoutMs: 5000 });
    const bare = await post(`/sign/${token}/result`, { kind: "address", value: addr(matt) });
    expect([bare.status, (bare.body as { status: string }).status]).toEqual([422, "pending"]);
    expect((await signInBrowser(token, yadu)).status).toBe(422);
    expect((await signInBrowser(token, matt)).status).toBe(200);
    const result = (await signing) as { signature: string };
    expect(verifyEthSignature(addr(matt), action, result.signature)).toBe(true);
  });

  it("refuses an answer from the wrong Ledger but keeps the link open for the right one", async () => {
    const { remote, link, signInBrowser, post } = await setup();
    const action = cal();
    const token = await link(action);
    const signing = remote.sign(addr(matt), action, { timeoutMs: 5000 });
    const wrong = await signInBrowser(token, yadu);
    expect(wrong.status).toBe(422);
    expect(wrong.body).toEqual({ ok: false, status: "pending", error: "That did not come from the Ledger bound to @matt, so nothing happened." });
    const tampered = await post(`/sign/${token}/result`, { kind: "message", value: await matt.signMessage("something else") });
    expect(tampered.status).toBe(422);
    expect((await post(`/sign/${token}/result`, { kind: "tx", value: "0x00" })).status).toBe(422);
    expect((await signInBrowser(token, matt)).status).toBe(200);
    expect((await signing).status).toBe("approved");
  });

  it("a rejection on the device settles the job as rejected", async () => {
    const { remote, link, post, http } = await setup();
    const action = cal();
    const token = await link(action);
    const signing = remote.sign(addr(matt), action, { timeoutMs: 5000 });
    expect((await post(`/sign/${token}/reject`)).body).toEqual({ ok: true, status: "rejected" });
    expect(await signing).toEqual({ status: "rejected" });
    expect((await http(`/sign/${token}/job`)).body).toMatchObject({ status: "rejected" });
    expect((await post(`/sign/${token}/reject`)).status).toBe(409);
  });

  it("expires with its own window: no_device when nobody opened the link, timeout when the page was open; late answers are refused", async () => {
    const { remote, link, signInBrowser, http } = await setup(150);
    const unopened = cal();
    const token1 = await link(unopened);
    // timeoutMs bounds the USB side only; the link keeps its window.
    expect(await remote.sign(addr(matt), unopened, { timeoutMs: 1 })).toEqual({ status: "no_device", expiredLink: true });
    const opened = cal();
    const token2 = await link(opened);
    const signing = remote.sign(addr(matt), opened, { timeoutMs: 1 });
    await http(`/sign/${token2}/job`);
    expect(await signing).toEqual({ status: "timeout", expiredLink: true });
    for (const token of [token1, token2]) {
      const late = await signInBrowser(token, matt);
      expect([late.status, late.body]).toEqual([409, { ok: false, status: "expired", error: "This request expired on the server. Ask Jarvis again and open the new link." }]);
    }
  });

  it("unknown links, non-JSON posts and a restart", async () => {
    const { db, remote, link, http } = await setup();
    const missing = "ab".repeat(32);
    expect((await http(`/sign/${missing}`)).status).toBe(404);
    expect((await http(`/sign/${missing}/job`)).body).toEqual({ ok: false, error: "This link is not valid." });
    expect((await http("/sign/nothex")).status).toBe(404);
    const action = cal();
    const token = await link(action);
    expect((await http(`/sign/${token}/result`, { method: "POST", body: "{}" })).status).toBe(415);
    expect((await http(`/sign/${token}/state`)).body).toEqual({ status: "pending", code: "CAL" });
    // A new process on the same database: the link still opens, as expired.
    createRemoteDeviceManager({ db, publicUrl: "https://agent.example" });
    expect(db.signingJob(token)?.status).toBe("expired");
  });

  it("USB answers first: the remote job is superseded and a late page answer is refused", async () => {
    const { db, remote, link, signInBrowser } = await setup();
    const action = cal();
    const token = await link(action);
    const usb: DeviceManager = {
      list: async () => [{ id: "usb", kind: "hid", pubkey: addr(matt), label: "USB" }],
      sign: async (): Promise<SignResult> => ({ status: "approved", signature: await matt.signMessage("from usb") }),
      close: async () => {},
    };
    const combined = combineDeviceManagers([usb, remote]);
    expect((await combined.list()).map((d) => d.id)).toEqual(["usb"]);
    expect((await combined.sign(addr(matt), action, { timeoutMs: 5000 })).status).toBe("approved");
    expect(db.signingJob(token)?.status).toBe("superseded");
    const late = await signInBrowser(token, matt);
    expect([late.status, late.body]).toEqual([409, { ok: false, status: "superseded", error: "The Ledger plugged into the AgentSign Mac took this request over USB. Approve or reject it there." }]);
  });

  it("the page answers first: USB stops waiting and the page's signature wins", async () => {
    const { remote, link, signInBrowser } = await setup();
    const usb = fakeEthDevices([matt]);
    usb.plugged.clear();
    const combined = combineDeviceManagers([usb.manager, remote]);
    const action = cal();
    const { url } = (await combined.prepare!(addr(matt), action)) as { url: string };
    expect(url).toBe(`https://agent.example/sign/${await link(action)}`);
    const signing = combined.sign(addr(matt), action, { timeoutMs: 5000 });
    await signInBrowser(url.split("/").pop()!, matt);
    const result = await signing;
    expect(result.status).toBe("approved");
  });

  it("the page loads the request: the USB side stops probing this Mac's Ledgers, so it never fights the browser for one", async () => {
    const { remote, link, http, signInBrowser } = await setup();
    let probes = 0;
    const usb = createEthDeviceManager({ discover: async () => (probes++, []), pollIntervalMs: 5 });
    const combined = combineDeviceManagers([usb, remote]);
    const action = cal();
    const token = await link(action);
    const signing = combined.sign(addr(matt), action, { timeoutMs: 5000 });
    for (let i = 0; i < 200 && probes < 3; i++) await new Promise((r) => setTimeout(r, 5));
    expect(probes).toBeGreaterThanOrEqual(3);
    expect((await http(`/sign/${token}/job`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const after = probes;
    await new Promise((r) => setTimeout(r, 100));
    expect(probes).toBe(after);
    expect((await signInBrowser(token, matt)).body).toEqual({ ok: true, status: "signed" });
    expect((await signing).status).toBe("approved");
  });

  it("a USB Ledger shows the request first: the page is told to approve there, and a late page answer is refused", async () => {
    const { db, remote, link, http, signInBrowser } = await setup();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const app = fakeEthApp(matt);
    const slow: EthEndpoint = {
      id: "slow",
      kind: "hid",
      label: "Slow Ledger",
      open: async () => ({ app: { ...app, signPersonalMessage: (hex) => held.then(() => app.signPersonalMessage(hex)) }, close: async () => {} }),
    };
    const usb = createEthDeviceManager({ discover: async () => [slow], pollIntervalMs: 5 });
    const combined = combineDeviceManagers([usb, remote]);
    const action = cal();
    const token = await link(action);
    const signing = combined.sign(addr(matt), action, { timeoutMs: 5000 });
    for (let i = 0; i < 200 && db.signingJob(token)?.status === "pending"; i++) await new Promise((r) => setTimeout(r, 5));
    expect(db.signingJob(token)?.status).toBe("superseded");
    expect((await http(`/sign/${token}/state`)).body).toEqual({ status: "pending", code: "CAL", onDevice: true });
    const late = await signInBrowser(token, matt);
    expect([late.status, late.body]).toEqual([409, { ok: false, status: "superseded", error: TAKEN_BY_USB }]);
    release();
    const result = await signing;
    expect(result.status).toBe("approved");
    expect(verifyEthSignature(addr(matt), action, (result as { signature: string }).signature)).toBe(true);
  });

  it("windows: sign-up links last 10 minutes, everything else 5", async () => {
    const { remote } = await setup();
    const now = Date.now();
    const signUp = (await remote.prepare(addr(matt), acc())).expiresAt - now;
    const other = (await remote.prepare(addr(matt), cal())).expiresAt - now;
    expect([Math.round(signUp / 60_000), Math.round(other / 60_000)]).toEqual([10, 5]);
  });

  it("takes the page's step log: printed with the token prefix, one post per second, ignored once the job is final", async () => {
    const { remote, link, post, logs } = await setup();
    const action = cal();
    const token = await link(action);
    expect((await post(`/sign/${token}/log`, { lines: ["Connecting", "bad\u0007char"] })).status).toBe(200);
    expect((await post(`/sign/${token}/log`, { lines: ["too soon"] })).status).toBe(429);
    expect(logs).toEqual([`page ${token.slice(0, 8)}: Connecting`, `page ${token.slice(0, 8)}: bad?char`]);
    remote.reject(token);
    await new Promise((r) => setTimeout(r, 1000));
    expect((await post(`/sign/${token}/log`, { lines: ["late"] })).body).toEqual({ ok: true, ignored: true });
    expect(logs).toHaveLength(2);
  });

  it("serves the browser bundle", async () => {
    const { http } = await setup();
    const js = await http("/ledger.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect((js.body as string).length).toBeGreaterThan(10_000);
  }, 30_000);
});

describe("approvals with the approval page", () => {
  it("texts the link once, nothing more, then executes what the page signed", async () => {
    const { db, account, remote, http, signInBrowser } = await setup();
    const usb = fakeEthDevices([matt]);
    usb.plugged.clear();
    const { chain } = stubChain({});
    const ch = fakeChannel();
    const approvals = createApprovals({ db, deviceManager: combineDeviceManagers([usb.manager, remote]), channel: ch.channel, titles: ACTION_TITLES, money: baseMoney(chain), signTimeoutMs: 5000 });
    await approvals.request(account.id, cal());
    let token: string | undefined;
    for (let i = 0; i < 200 && !token; i++) {
      token = /\/sign\/([0-9a-f]{64})/.exec(ch.sent.map((s) => s.text).join("\n"))?.[1];
      if (!token) await new Promise((r) => setTimeout(r, 10));
    }
    expect(ch.sent[0]!.text).toMatch(/^Please confirm on your Ledger: Add to calendar.*\nOr approve from any computer your Ledger is plugged into: https:\/\/agent\.example\/sign\/[0-9a-f]{64}$/);
    // No "I don't see your Ledger" nag after the link: the link line already says where to approve.
    await new Promise((r) => setTimeout(r, 50));
    expect(ch.sent).toHaveLength(1);
    expect((await signInBrowser(token!, matt)).status).toBe(200);
    await approvals.whenIdle();
    expect((await http(`/sign/${token}/state`)).body).toMatchObject({ status: "executed", code: "CAL" });
    expect(db.events(account.id, "2000", "3000")).toHaveLength(1);
    expect(ch.sent.filter((s) => /don't see your Ledger|I'll wait/.test(s.text))).toHaveLength(0);
  });
});
