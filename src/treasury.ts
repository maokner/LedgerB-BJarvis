/**
 * The operator's treasury: the Base wallet that receives what buyers pay for Amazon orders and refunds them when no
 * order was placed. Its key, when the server has one, is TREASURY_PRIVATE_KEY in the environment; nothing else ever
 * holds it. The treasury pays the gas of a refund itself, so the buyer gets back exactly what they sent.
 */
import { getAddress, Wallet } from "ethers";
import { type Chain, erc20TransferData, formatUsdc, USDC } from "./chain.js";
import { unsignedTx } from "./device/eth-tx.js";

export type Asset = "ETH" | "USDC";

export interface Treasury {
  /** Checksummed 0x address buyers pay. */
  readonly address: string;
  /** False for a receive-only treasury (no key on this server): refunds are then sent by hand. */
  readonly canRefund: boolean;
  balanceWei(): Promise<bigint>;
  /** Sends `amount` (wei, or USDC units) from the treasury to `to` and returns the transaction hash. Throws when it cannot (no key, no funds, bad address). */
  refund(to: string, amount: bigint, asset: Asset): Promise<string>;
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
    canRefund: !!wallet,
    balanceWei: () => chain.balanceWei(address),
    async refund(to, amount, asset) {
      if (!wallet) throw new TreasuryError(`the treasury ${address} has no key on this server, so refunds are sent by hand`);
      if (amount <= 0n) throw new TreasuryError("nothing to refund");
      const recipient = getAddress(to);
      const usdc = asset === "USDC";
      if (usdc) {
        const have = await chain.tokenBalance(USDC.address, address);
        if (have < amount) throw new TreasuryError(`the treasury holds ${formatUsdc(have)} USDC, less than the ${formatUsdc(amount)} USDC refund`);
      }
      const plan = await chain.prepareTransfer(address, usdc ? USDC.address : recipient, usdc ? 0n : amount, usdc ? erc20TransferData(recipient, amount) : undefined);
      const have = await chain.balanceWei(address);
      const need = (usdc ? 0n : amount) + plan.gasLimit * plan.maxFeePerGas;
      if (need > have) throw new TreasuryError(`the treasury holds ${have} wei, less than the ${need} wei the refund needs with gas`);
      const tx = unsignedTx({
        to: usdc ? USDC.address : recipient,
        valueWei: usdc ? "0" : amount.toString(),
        data: usdc ? erc20TransferData(recipient, amount) : undefined,
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
