/** Base mainnet access: balances, ETH/USD spot price, fee data and broadcasting. */
import { JsonRpcProvider } from "ethers";

export const BASE_CHAIN_ID = 8453;
export const txLink = (hash: string): string => `https://basescan.org/tx/${hash}`;

export interface TransferPlan {
  chainId: number;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface Chain {
  balanceWei(address: string): Promise<bigint>;
  /** USD per ETH. */
  ethUsdPrice(): Promise<number>;
  prepareTransfer(from: string, to: string, valueWei: bigint): Promise<TransferPlan>;
  /** Sends a raw signed transaction and returns its hash. */
  broadcast(signedTx: string): Promise<string>;
  waitForReceipt(hash: string, timeoutMs: number): Promise<"confirmed" | "failed" | "timeout">;
}

export function createBaseChain(options: { rpcUrl?: string } = {}): Chain {
  const provider = new JsonRpcProvider(options.rpcUrl || "https://mainnet.base.org", BASE_CHAIN_ID, { staticNetwork: true });
  let price: { usd: number; at: number } | undefined;
  return {
    balanceWei: (address) => provider.getBalance(address),
    async ethUsdPrice() {
      if (price && Date.now() - price.at < 60_000) return price.usd;
      const res = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(10_000) });
      const usd = Number(((await res.json()) as { data?: { amount?: string } }).data?.amount);
      if (!res.ok || !(usd > 0)) throw new Error(`no ETH price from Coinbase (HTTP ${res.status})`);
      price = { usd, at: Date.now() };
      return usd;
    },
    async prepareTransfer(from, to, valueWei) {
      const [nonce, fees, code] = await Promise.all([provider.getTransactionCount(from, "pending"), provider.getFeeData(), provider.getCode(to)]);
      // Plain accounts take exactly 21000 gas; contracts get an estimate with headroom.
      const gasLimit = code === "0x" ? 21_000n : ((await provider.estimateGas({ from, to, value: valueWei })) * 12n) / 10n;
      const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 1_000_000n;
      const maxFeePerGas = fees.maxFeePerGas && fees.maxFeePerGas > maxPriorityFeePerGas ? fees.maxFeePerGas : maxPriorityFeePerGas * 2n;
      return { chainId: BASE_CHAIN_ID, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas };
    },
    async broadcast(signedTx) {
      return (await provider.broadcastTransaction(signedTx)).hash;
    },
    async waitForReceipt(hash, timeoutMs) {
      try {
        const receipt = await provider.waitForTransaction(hash, 1, timeoutMs);
        return receipt?.status === 1 ? "confirmed" : receipt ? "failed" : "timeout";
      } catch {
        return "timeout";
      }
    },
  };
}
