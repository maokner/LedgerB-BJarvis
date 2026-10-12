/**
 * Talking to a Ledger from a page, shared by the approval page (src/web/ledger-client.ts) and the account page
 * (src/web/dashboard-client.ts): find the device over WebHID, open it, check the Ethereum app, read the address, and
 * turn whatever goes wrong into one plain sentence. Browser only; bundled by src/web/bundle.ts.
 */
import TransportModule from "@ledgerhq/hw-transport-webhid";
import type { EthApp } from "../device/eth-tx.js";
import { appName, ethAppOver, type Transport } from "./ledger-app.js";

export interface HidDevice {
  vendorId: number;
  opened: boolean;
  productName: string;
  collections: { usagePage: number; usage: number }[];
  close(): Promise<void>;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: unknown): void;
}
const TransportWebHID = TransportModule as unknown as { open(device: HidDevice): Promise<Transport>; request(): Promise<Transport> };
export const hid = () => (navigator as unknown as { hid?: { getDevices(): Promise<HidDevice[]> } }).hid;
export const LEDGER_VENDOR = 0x2c97;

export const NO_HID = "Open this link in Chrome on the computer your Ledger is plugged into.";
export const NOT_SECURE = "This page must be opened over https. Ask whoever runs the server to set an https PUBLIC_URL.";
export const WRONG_APP = "Open the Ethereum app on your Ledger.";
export const HELD = "Another app is holding your Ledger (usually Ledger Live or a wallet extension). Quit it, unplug and replug the Ledger, open the Ethereum app, then try again.";
export const NO_ANSWER = "No answer from the Ledger. Unplug it, plug it back in, close other wallet tabs, reload this page and try again.";

/** An error whose message is already the sentence to show. */
export class Plain extends Error {}

/** Lines about what the page is doing: `step` is shown to the person, `report` only logged. */
export interface Progress {
  step(text: string): void;
  report?(text: string): void;
}

export const describe = (d: HidDevice) => `${d.productName} [${d.collections.map((c) => `0x${c.usagePage.toString(16)}/0x${c.usage.toString(16)}`).join(" ")}]`;
export const short = (address: string) => `${address.slice(0, 6)}..${address.slice(-4)}`;
/** True when this browser was already allowed to use a Ledger (no device picker needed). */
export const knownLedger = async (): Promise<boolean> => !!hid() && (await hid()!.getDevices()).some((d) => d.vendorId === LEDGER_VENDOR);

/** inputreport events seen on the open device: if the Ledger answers but this stays flat, the browser never delivered it. */
let inputReports = 0;
export const reportsSeen = () => inputReports;
const countReport = () => void (inputReports += 1);

let current: Transport | undefined;
/** Drops the HID handle. transport.close() waits for a running exchange, which may never end, so close the device itself. */
export async function release(): Promise<void> {
  const old = current as unknown as { device?: HidDevice; onInputReport?: unknown } | undefined;
  current = undefined;
  // Also detach the old transport, or it keeps listening on the same HIDDevice next to the new one.
  if (old?.onInputReport) old.device?.removeEventListener("inputreport", old.onInputReport);
  old?.device?.removeEventListener("inputreport", countReport);
  await old?.device?.close().catch(() => undefined);
}

/** A Ledger this site may already use is opened without the picker; any earlier handle is closed first. */
export async function openLedger(p: Progress): Promise<Transport> {
  const report = p.report ?? (() => {});
  await release();
  const ledgers = (await hid()!.getDevices()).filter((d) => d.vendorId === LEDGER_VENDOR);
  report(`getDevices: ${ledgers.length} Ledger device(s): ${ledgers.map(describe).join(", ") || "none"}`);
  // The APDU interface is usage page 0xffa0; never the FIDO one (0xf1d0).
  const known = ledgers.find((d) => d.collections.some((c) => c.usagePage === 0xffa0)) ?? ledgers.find((d) => !d.collections.some((c) => c.usagePage === 0xf1d0));
  if (known) report(`chose ${describe(known)}${known.opened ? " (was open, closing it first)" : ""}`);
  if (known?.opened) await known.close().catch(() => undefined);
  p.step(known ? "Connecting to the Ledger this browser already knows" : "Connecting: pick your Ledger in the list");
  current = known
    ? await TransportWebHID.open(known).catch((err: unknown) => {
        const held = (err as { name?: string }).name === "NotAllowedError";
        p.step(held ? "Could not open the Ledger: another app may be holding it. Trying the device picker" : `open(known) failed: ${String(err)}; trying the device picker`);
        return TransportWebHID.request();
      })
    : await TransportWebHID.request();
  const device = (current as unknown as { device?: HidDevice }).device;
  inputReports = 0;
  device?.addEventListener("inputreport", countReport);
  if (device) report(`opened ${describe(device)}`);
  return current;
}

/**
 * Opens the Ledger, makes sure the Ethereum app is up, and reads the address (which also wakes the app's APDU path).
 * Throws Plain errors with the sentence to show; the caller must release() when done.
 */
export async function connectEthereum(p: Progress): Promise<{ transport: Transport; app: EthApp; address: string }> {
  const transport = await openLedger(p);
  // The first exchange: if nothing answers, another process holds the Ledger's HID interface.
  let firstTimer: ReturnType<typeof setTimeout> | undefined;
  const silent = new Promise<never>((_, reject) => (firstTimer = setTimeout(() => reject(new Plain(HELD)), 5000)));
  const name = await Promise.race([appName(transport), silent]).finally(() => clearTimeout(firstTimer));
  p.step(`App open on the Ledger: ${name}`);
  if (name !== "Ethereum") throw new Plain(WRONG_APP);
  const app = ethAppOver(transport);
  const address = (await app.getAddress(false)).toLowerCase();
  p.step(`Ethereum app found, address ${short(address)}`);
  return { transport, app, address };
}

/** One sentence for whatever the transport or the app threw. */
export function plainError(err: unknown): string {
  const e = err as { name?: string; statusCode?: number; message?: string };
  if (err instanceof Plain) return e.message!;
  if (e.name === "NotAllowedError") return HELD;
  if (e.name === "TransportOpenUserCancelled" || e.name === "NotFoundError") return "Pick your Ledger in the browser's list to continue.";
  if (e.statusCode === 0x5515 || e.name === "LockedDeviceError") return "Unlock your Ledger, then open the Ethereum app.";
  if (e.statusCode === 0x6e00 || e.statusCode === 0x6d00 || e.statusCode === 0x6e01 || e.statusCode === 0x6511) return WRONG_APP;
  if (e.name === "TransportRaceCondition" || /busy|claimed|open/i.test(e.message ?? "")) return "Your Ledger is busy. Close Ledger Live and other wallet tabs, then try again.";
  return `Could not talk to your Ledger (${e.message ?? "unknown error"}). Unlock it, open the Ethereum app, and try again.`;
}

/** The person pressed Reject on the device. */
export const rejected = (err: unknown): boolean => (err as { statusCode?: number }).statusCode === 0x6985;
