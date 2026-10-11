/**
 * The page's glue between a Ledger transport and askEthApp(): the same code runs in the browser bundle and in
 * test/ledger-app.test.ts (bundled the same way, over a replayed transport).
 */
import EthModule from "@ledgerhq/hw-app-eth";
import { ETH_PATH, type EthApp, NO_RESOLUTION } from "../device/eth-tx.js";

// The packages' typings do not survive NodeNext's default-import rules; these are the parts we use.
export interface Transport {
  send(cla: number, ins: number, p1: number, p2: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
const Eth = EthModule as unknown as new (transport: Transport) => {
  getAddress(path: string, display?: boolean): Promise<{ address: string }>;
  signTransaction(path: string, rawTxHex: string, resolution: unknown): Promise<{ v: string; r: string; s: string }>;
  signPersonalMessage(path: string, messageHex: string): Promise<{ v: number; r: string; s: string }>;
};

/** hw-app-eth over `transport`, in askEthApp()'s shapes. signPersonalMessage's v is a number (27/28), signTransaction's a hex string. */
export function ethAppOver(transport: Transport): EthApp {
  const eth = new Eth(transport);
  return {
    getAddress: async (display) => (await eth.getAddress(ETH_PATH, display)).address,
    signTransaction: (hex, resolution) => eth.signTransaction(ETH_PATH, hex, resolution),
    signPersonalMessage: async (hex) => {
      const { v, r, s } = await eth.signPersonalMessage(ETH_PATH, hex);
      // Guard the shape, so a surprise surfaces as an error instead of a bad signature.
      if (typeof v !== "number" || !/^[0-9a-f]{64}$/i.test(r) || !/^[0-9a-f]{64}$/i.test(s)) throw new Error(`unexpected signature from the Ledger (v=${String(v)})`);
      return { v: v < 27 ? v + 27 : v, r, s };
    },
  };
}

/** Name of the app open on the device ("Ethereum", "BOLOS" on the dashboard). */
export async function appName(transport: Transport): Promise<string> {
  const r = await transport.send(0xb0, 0x01, 0x00, 0x00);
  return new TextDecoder().decode(r.subarray(2, 2 + (r[1] ?? 0)));
}

/** APDUs hw-app-eth sends for a personal message of `bytes` bytes (150-byte chunks, the first one carries the path and length). */
export const messageChunks = (bytes: number): number => (bytes <= 125 ? 1 : 1 + Math.ceil((bytes - 125) / 150));
