/**
 * The operator's treasury: the Base wallet that receives what buyers pay for Amazon orders and refunds them when no
 * order was placed. Its key, when the server has one, is TREASURY_PRIVATE_KEY in the environment; nothing else ever
 * holds it. The treasury pays the gas of a refund itself, so the buyer gets back exactly what they sent.
 */
import { getAddress, Wallet } from "ethers";
import type { Chain } from "./chain.js";
import { unsignedTx } from "./device/eth-tx.js";

export interface Treasury {
  /** Checksummed 0x address buyers pay. */
  readonly address: string;
  balanceWei(): Promise<bigint>;
  /** Sends `wei` from the treasury to `to` and returns the transaction hash. Throws when Base refuses it (no gas money, bad address). */
  refund(to: string, wei: bigint): Promise<string>;
}

export class TreasuryError extends Error {}

/**
 * With a private key the treasury can refund; with only an address (TREASURY_ADDRESS, for example a Ledger the operator
 * holds) it only receives, and a refund throws so the purchase is flagged to the operator instead.
 */
export function createTreasury(source: { privateKey?: string; address?: string }, chain: Chain): Treasury {
  let wallet: Wallet | undefined;
  if (source.privateKey?.trim()) {
    try {
      wallet = new Wallet(source.privateKey.trim());
    } catch {
      throw new TreasuryError("TREASURY_PRIVATE_KEY is not a valid private key (64 hex characters, 0x optional)");
    }
  }
  let address: string;
  try {
    address = getAddress(wallet?.address ?? source.address?.trim() ?? "");
  } catch {
    throw new TreasuryError("TREASURY_ADDRESS is not a valid 0x address");
  }
  if (wallet && source.address?.trim() && getAddress(source.address.trim()) !== address) throw new TreasuryError("TREASURY_ADDRESS does not match TREASURY_PRIVATE_KEY");
  return {
    address,
    balanceWei: () => chain.balanceWei(address),
    async refund(to, wei) {
      if (!wallet) throw new TreasuryError(`the treasury ${address} has no key on this server, so refunds are sent by hand`);
      if (wei <= 0n) throw new TreasuryError("nothing to refund");
      const recipient = getAddress(to);
      const plan = await chain.prepareTransfer(address, recipient, wei);
      const have = await chain.balanceWei(address);
      const need = wei + plan.gasLimit * plan.maxFeePerGas;
      if (need > have) throw new TreasuryError(`the treasury holds ${have} wei, less than the ${need} wei the refund needs with gas`);
      const tx = unsignedTx({
        to: recipient,
        valueWei: wei.toString(),
        chainId: plan.chainId,
        nonce: plan.nonce,
        gasLimit: plan.gasLimit.toString(),
        maxFeePerGas: plan.maxFeePerGas.toString(),
        maxPriorityFeePerGas: plan.maxPriorityFeePerGas.toString(),
      });
      return chain.broadcast(await wallet.signTransaction(tx));
    },
  };
}
