/**
 * The page's device code (src/web/ledger-app.ts + askEthApp), bundled exactly like /ledger.js (browser platform,
 * the injected Buffer polyfill), run in Node over a replayed transport with captured-format Ledger responses.
 */
import { build } from "esbuild";
import { Signature, Transaction, Wallet } from "ethers";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { actionMessage, newActionId } from "../src/actions.js";
import { type EthAnswer, type EthRequest, unsignedTx } from "../src/device/eth-tx.js";
import { ethProof, ethRequest } from "../src/device/eth-verify.js";
import type { Action } from "../src/types.js";
import { BROWSER_BUILD } from "../src/web/bundle.js";

type Run = (records: string, request: EthRequest) => Promise<{ name: string; address: string; answer: EthAnswer }>;
let run: Run;

beforeAll(async () => {
  const entry = `
    import { openTransportReplayer, RecordStore } from "@ledgerhq/hw-transport-mocker";
    import { askEthApp } from "../device/eth-tx.js";
    import { appName, ethAppOver } from "./ledger-app.js";
    // The page's order: app name, address, then the request.
    export async function run(records, request) {
      const transport = await openTransportReplayer(RecordStore.fromString(records));
      const name = await appName(transport);
      const app = ethAppOver(transport);
      const address = (await app.getAddress(false)).toLowerCase();
      return { name, address, answer: await askEthApp(app, request) };
    }`;
  const out = await build({
    ...BROWSER_BUILD,
    inject: [...BROWSER_BUILD.inject],
    stdin: { contents: entry, resolveDir: fileURLToPath(new URL("../src/web/", import.meta.url)), loader: "ts" },
    format: "esm",
    write: false,
  });
  ({ run } = (await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0]!.text).toString("base64")}`)) as { run: Run });
}, 30_000);

const wallet = new Wallet(Wallet.createRandom().privateKey);
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const PATH = "058000002c8000003c800000000000000000000000";
const u32 = (n: number) => n.toString(16).padStart(8, "0");
const apdu = (ins: string, p1: string, data: string) => `e0${ins}${p1}00${(data.length / 2).toString(16).padStart(2, "0")}${data}`;

/** App name, then getAddress(false), as the Ethereum app answers them. */
function preamble(): string {
  const pub = wallet.signingKey.publicKey.slice(2);
  const addr = hex(wallet.address.slice(2));
  return [
    `=> b001000000`,
    `<= 0108${hex("Ethereum")}06${hex("1.13.1")}01029000`,
    `=> ${apdu("02", "00", PATH)}`,
    `<= 41${pub}28${addr}9000`,
  ].join("\n");
}

/** The APDUs hw-app-eth sends for a personal message (150-byte chunks), and the device's final 65-byte answer. */
function messageRecords(message: string, v: number, r: string, s: string): string {
  const bytes = Buffer.from(message, "utf8");
  const lines: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const size = Math.min(offset === 0 ? 125 : 150, bytes.length - offset);
    const chunk = bytes.subarray(offset, offset + size).toString("hex");
    offset += size;
    lines.push(`=> ${apdu("08", offset === size ? "00" : "80", offset === size ? PATH + u32(bytes.length) + chunk : chunk)}`);
    lines.push(offset < bytes.length ? "<= 9000" : `<= ${v.toString(16).padStart(2, "0")}${r}${s}9000`);
  }
  return lines.join("\n");
}

/** The single APDU hw-app-eth sends for a short EIP-1559 transfer (path + raw tx fit one 255-byte chunk), and the device's yParity/r/s answer. */
function txRecords(unsignedHex: string, yParity: number, r: string, s: string): string {
  return `=> ${apdu("04", "00", PATH + unsignedHex)}\n<= ${yParity.toString(16).padStart(2, "0")}${r}${s}9000`;
}

const pay = (): Action => ({
  code: "PAY",
  id: newActionId(),
  fields: [{ label: "To", value: "@gabe" }, { label: "Amount", value: "$1.00" }, { label: "Memo", value: "thank you" }],
  meta: { to: "0x2739A73B06090A5342b27C47b21ee2578fa84937", valueWei: "399500000000000", chainId: 8453, nonce: 3, gasLimit: "21000", maxFeePerGas: "20000000", maxPriorityFeePerGas: "1000000" },
});

const signUp = (phone = "+14155550002"): Action => ({ code: "ACC", id: newActionId(), fields: [{ label: "Tag", value: "@gabe" }, { label: "Phone", value: phone }] });

describe("the page's Ledger code, bundled for the browser", () => {
  it("turns a sign-up signature (v = 27/28) into one the server accepts, and reads the address first", async () => {
    const action = signUp();
    const request = ethRequest(action, "page");
    const sig = Signature.from(await wallet.signMessage(actionMessage(action)));
    const out = await run(`${preamble()}\n${messageRecords(actionMessage(action), sig.v, sig.r.slice(2), sig.s.slice(2))}`, request);
    expect(out.name).toBe("Ethereum");
    expect(out.address).toBe(wallet.address.toLowerCase());
    expect(Signature.from(out.answer.value).v).toBe(sig.v);
    expect(ethProof("", action, out.answer, "page")).toEqual({ signature: out.answer.value, address: wallet.address.toLowerCase() });
  });

  it("signs a payment through hw-app-eth's signTransaction, with the empty resolution it iterates over", async () => {
    const action = pay();
    const tx = unsignedTx(action.meta!);
    const sig = wallet.signingKey.sign(tx.unsignedHash);
    const out = await run(`${preamble()}\n${txRecords(tx.unsignedSerialized.slice(2), sig.yParity, sig.r.slice(2), sig.s.slice(2))}`, ethRequest(action, "page"));
    expect(out.answer.kind).toBe("tx");
    expect(Transaction.from(out.answer.value).from).toBe(wallet.address);
    expect(ethProof(wallet.address.toLowerCase(), action, out.answer, "page")).toEqual({ signature: out.answer.value, address: wallet.address.toLowerCase() });
  });

  it("normalizes a v of 0/1 and handles multi-chunk messages", async () => {
    const action: Action = { code: "CAL", id: newActionId(), fields: [{ label: "Title", value: "x".repeat(64) }, { label: "When", value: "y".repeat(64) }, { label: "With", value: "z".repeat(64) }, { label: "Note", value: "w".repeat(64) }] };
    const message = actionMessage(action);
    expect(Buffer.byteLength(message)).toBeGreaterThan(275); // three chunks
    const sig = Signature.from(await wallet.signMessage(message));
    const out = await run(`${preamble()}\n${messageRecords(message, sig.yParity, sig.r.slice(2), sig.s.slice(2))}`, ethRequest(action, "page"));
    expect("signature" in ethProof(wallet.address.toLowerCase(), action, out.answer, "page")).toBe(true);
  });

  it("a rejection or a malformed answer is an error, never a hang", async () => {
    const action = signUp();
    const message = actionMessage(action);
    const reject = messageRecords(message, 27, "00".repeat(32), "00".repeat(32)).replace(/<= [0-9a-f]+$/, "<= 6985");
    await expect(run(`${preamble()}\n${reject}`, ethRequest(action, "page"))).rejects.toMatchObject({ statusCode: 0x6985 });
    const short = messageRecords(message, 27, "00".repeat(32), "00".repeat(32)).replace(/<= [0-9a-f]+$/, "<= 1b9000");
    await expect(run(`${preamble()}\n${short}`, ethRequest(action, "page"))).rejects.toThrow(/unexpected signature/);
  });
});
