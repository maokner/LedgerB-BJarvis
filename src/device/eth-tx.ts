/**
 * The Ethereum app calls shared by the USB path (src/device/eth.ts) and the browser page (src/web/ledger-client.ts).
 * Only ethers and types here, so it bundles for the browser.
 */
import type { LedgerEthTransactionResolution } from "@ledgerhq/hw-app-eth/lib/services/types";
import { hexlify, Signature, toUtf8Bytes, Transaction } from "ethers";
import type { EthTxMeta } from "../types.js";

export const ETH_PATH = "44'/60'/0'/0/0";
/**
 * Empty resolution: the app shows a plain ETH transfer, and no network lookups happen. Typed against hw-app-eth, which
 * iterates every key, so a misspelled one fails to compile instead of throwing "x is not iterable" on the page.
 */
export const NO_RESOLUTION: LedgerEthTransactionResolution = { erc20Tokens: [], nfts: [], externalPlugin: [], plugin: [], domains: [] };

/** The three calls we need from the Ethereum app, in hw-app-eth's shapes (hex without 0x). */
export interface EthApp {
  getAddress(display: boolean): Promise<string>;
  /** `resolution`: token descriptors for clear signing (NO_RESOLUTION for a plain transfer). */
  signTransaction(unsignedTxHex: string, resolution: LedgerEthTransactionResolution): Promise<{ v: string; r: string; s: string }>;
  signPersonalMessage(messageHex: string): Promise<{ v: number; r: string; s: string }>;
}

/** What the device must do for one action: verify the address, sign a transfer, or sign a personal message. */
export type EthRequest = { kind: "address" } | { kind: "tx"; meta: EthTxMeta } | { kind: "message"; message: string };
/** What came back: the address the device verified, the raw signed tx, or the 65-byte message signature. */
export interface EthAnswer {
  kind: EthRequest["kind"];
  value: string;
}

export function unsignedTx(meta: EthTxMeta): Transaction {
  return Transaction.from({
    type: 2,
    chainId: meta.chainId,
    nonce: meta.nonce,
    to: meta.to,
    value: BigInt(meta.valueWei),
    gasLimit: BigInt(meta.gasLimit),
    maxFeePerGas: BigInt(meta.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(meta.maxPriorityFeePerGas),
    data: meta.data ?? "0x",
  });
}

/** The resolution the app signs `meta` with: the token descriptors the server fetched, else none. */
export const resolutionOf = (meta: EthTxMeta): LedgerEthTransactionResolution => ({ ...NO_RESOLUTION, erc20Tokens: meta.resolution?.erc20Tokens ?? [] });

/** Asks the open Ethereum app to do `request`. Throws what hw-app-eth throws (statusCode 0x6985 when rejected). */
export async function askEthApp(app: EthApp, request: EthRequest): Promise<EthAnswer> {
  if (request.kind === "address") return { kind: "address", value: (await app.getAddress(true)).toLowerCase() };
  if (request.kind === "tx") {
    const tx = unsignedTx(request.meta);
    const { v, r, s } = await app.signTransaction(tx.unsignedSerialized.slice(2), resolutionOf(request.meta));
    tx.signature = Signature.from({ r: `0x${r}`, s: `0x${s}`, v: parseInt(v, 16) });
    return { kind: "tx", value: tx.serialized };
  }
  const { v, r, s } = await app.signPersonalMessage(hexlify(toUtf8Bytes(request.message)).slice(2));
  return { kind: "message", value: Signature.from({ r: `0x${r}`, s: `0x${s}`, v }).serialized };
}
