/** Base mainnet access: balances (ETH and USDC), ETH/USD spot price, fee data, Ledger's token descriptors, broadcasting. */
import { Contract, Interface, JsonRpcProvider } from "ethers";
import { createRequire } from "node:module";

export const BASE_CHAIN_ID = 8453;
export const txLink = (hash: string): string => `https://basescan.org/tx/${hash}`;

/** Native USDC on Base (Circle), 6 decimals. */
export const USDC = { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" } as const;
const ERC20 = new Interface(["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address owner) view returns (uint256)"]);
/** Call data of transfer(to, units). */
export const erc20TransferData = (to: string, units: bigint): string => ERC20.encodeFunctionData("transfer", [to, units]);
/** USD cents as USDC units (6 decimals). */
export const centsToUsdc = (cents: number): bigint => BigInt(cents) * 10_000n;
/** "4.35" style, no trailing zeros. */
export function formatUsdc(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export interface TransferPlan {
  chainId: number;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface Chain {
  balanceWei(address: string): Promise<bigint>;
  /** An ERC-20 balance in the token's units. */
  tokenBalance(token: string, address: string): Promise<bigint>;
  /** USD per ETH. */
  ethUsdPrice(): Promise<number>;
  /** Nonce, gas and fees for a transfer; `data` for a contract call (a token transfer). */
  prepareTransfer(from: string, to: string, valueWei: bigint, data?: string): Promise<TransferPlan>;
  /**
   * Ledger's signed descriptors of the ERC-20 tokens an unsigned transaction touches (hex, no 0x), from Ledger's
   * crypto-assets list, so the Ethereum app can show "4.35 USDC" instead of asking for blind signing. Throws when
   * the token is unknown or the list cannot be fetched.
   */
  erc20Resolution(unsignedTxHex: string): Promise<string[]>;
  /** Sends a raw signed transaction and returns its hash. */
  broadcast(signedTx: string): Promise<string>;
  waitForReceipt(hash: string, timeoutMs: number): Promise<"confirmed" | "failed" | "timeout">;
}

export function createBaseChain(options: { rpcUrl?: string } = {}): Chain {
  const provider = new JsonRpcProvider(options.rpcUrl || "https://mainnet.base.org", BASE_CHAIN_ID, { staticNetwork: true });
  let price: { usd: number; at: number } | undefined;
  const require = createRequire(import.meta.url);
  return {
    balanceWei: (address) => provider.getBalance(address),
    tokenBalance: (token, address) => new Contract(token, ERC20, provider).getFunction("balanceOf")(address) as Promise<bigint>,
    async ethUsdPrice() {
      if (price && Date.now() - price.at < 60_000) return price.usd;
      const res = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(10_000) });
      const usd = Number(((await res.json()) as { data?: { amount?: string } }).data?.amount);
      if (!res.ok || !(usd > 0)) throw new Error(`no ETH price from Coinbase (HTTP ${res.status})`);
      price = { usd, at: Date.now() };
      return usd;
    },
    async prepareTransfer(from, to, valueWei, data = "0x") {
      const [nonce, fees, code] = await Promise.all([provider.getTransactionCount(from, "pending"), provider.getFeeData(), provider.getCode(to)]);
      // Plain accounts take exactly 21000 gas; contracts and calls get an estimate with headroom.
      const gasLimit = code === "0x" && data === "0x" ? 21_000n : ((await provider.estimateGas({ from, to, value: valueWei, data })) * 12n) / 10n;
      const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 1_000_000n;
      const maxFeePerGas = fees.maxFeePerGas && fees.maxFeePerGas > maxPriorityFeePerGas ? fees.maxFeePerGas : maxPriorityFeePerGas * 2n;
      return { chainId: BASE_CHAIN_ID, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas };
    },
    async erc20Resolution(unsignedTxHex) {
      // hw-app-eth is CommonJS; its ledgerService fetches cdn.live.ledger.com/cryptoassets/evm/<chain>/erc20-signatures.json.
      type Service = { resolveTransaction(raw: string, load: object, config: { erc20: boolean; nft: boolean; externalPlugins: boolean }): Promise<{ erc20Tokens: string[] }> };
      const { ledgerService } = require("@ledgerhq/hw-app-eth") as { ledgerService: Service };
      const { erc20Tokens } = await ledgerService.resolveTransaction(unsignedTxHex.replace(/^0x/, ""), {}, { erc20: true, nft: false, externalPlugins: false });
      if (!erc20Tokens.length) throw new Error("Ledger has no descriptor for this token on Base, so the Ledger could not show it");
      return erc20Tokens;
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
