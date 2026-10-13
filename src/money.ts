/**
 * What differs between the two device modes:
 *   agentsign  custom AgentSign Ledger app, Ed25519 signatures, demo dollars in SQLite
 *   eth        Ledger's Ethereum app, real ETH on Base mainnet
 */
import { formatEther, getAddress, parseEther } from "ethers";
import { describeAction, newActionId, toFieldText, verifyActionSignature } from "./actions.js";
import { centsToUsdc, erc20TransferData, formatUsdc, type Chain, USDC } from "./chain.js";
import { unsignedTx } from "./device/eth-tx.js";
import type { Account } from "./db.js";
import { verifyEthSignature } from "./device/eth.js";
import { formatCents, parseCents } from "./format.js";
import { ACTION_TITLES, type Action, type ActionField, type EthTxMeta, isTxCode } from "./types.js";

export interface PayProposal {
  action: Action;
  /** The text the owner gets before the device asks. */
  prompt: string;
}

export interface Money {
  mode: "agentsign" | "eth";
  /** The Ledger app people must open, as used in texts: "AgentSign", "the Ethereum app". */
  appName: string;
  /** Demo balance new accounts start with. */
  startingCents: number;
  balanceText(account: Account): Promise<string>;
  /** A PAY the owner can sign, or an "Error: ..." the model can act on. `to` is an account or a raw 0x address. */
  pay(owner: Account, to: Account | string, amount: string, memo?: string): Promise<PayProposal | string>;
  /**
   * eth: a transfer of `cents` worth of ETH from the owner to `address`, ready to become an action's meta, or an
   * "Error: ..." (insufficient funds). Used by purchases (BUY pays the treasury). agentsign: always an error.
   */
  transfer(owner: Account, address: string, cents: number): Promise<{ wei: bigint; eth: string; meta: EthTxMeta } | string>;
  /**
   * eth: a transfer of `cents` in USDC (Base, 6 decimals) from the owner to `address`, with Ledger's token descriptor
   * so the Ethereum app clear-signs it, or an "Error: ..." (not enough USDC, or ETH for gas). agentsign: always an error.
   */
  transferUsdc(owner: Account, address: string, cents: number): Promise<{ units: bigint; usdc: string; meta: EthTxMeta } | string>;
  verify(pubkey: string, action: Action, signature: string): boolean;
  /** The text after an account is created. */
  accountCreatedText(tag: string, pubkey: string): Promise<string>;
  /** eth: broadcasts a signed PAY or BUY and returns the hash. agentsign: nothing to do. */
  submit(action: Action, signature: string): Promise<string | undefined>;
  confirm(hash: string): Promise<"confirmed" | "failed" | "timeout">;
}

const prompt = (action: Action) => `Please confirm on your Ledger: ${describeAction(action, ACTION_TITLES)}`;

export function demoMoney(): Money {
  return {
    mode: "agentsign",
    appName: "AgentSign",
    startingCents: 25_000,
    balanceText: async (account) => `${formatCents(account.balance_cents)} (demo money)`,
    async pay(owner, to, amount, memo) {
      if (typeof to === "string") return "Error: in demo mode you can only pay an @tag.";
      const cents = parseCents(amount);
      if (!cents) return "Error: Amount must be a positive dollar amount like $5.00.";
      if (cents > owner.balance_cents) {
        return `Error: insufficient funds. The balance is ${formatCents(owner.balance_cents)}, which is less than ${formatCents(cents)}. Tell the owner; do not propose it.`;
      }
      const fields: ActionField[] = [{ label: "To", value: to.tag }, { label: "Amount", value: formatCents(cents) }];
      if (memo) fields.push({ label: "Memo", value: toFieldText(memo) });
      const action: Action = { code: "PAY", id: newActionId(), fields };
      return { action, prompt: prompt(action) };
    },
    transfer: async () => "Error: in demo mode there is no ETH to transfer.",
    transferUsdc: async () => "Error: in demo mode there is no USDC to transfer.",
    verify: verifyActionSignature,
    async accountCreatedText(tag) {
      const [pay, friend] = ["@gabriel", "@yadu", "@matt"].filter((t) => t !== tag);
      return `You're in: ${tag} is yours, with ${formatCents(25_000)} of demo money to play with. Try: send $5 to ${pay}, or add ${friend} as a friend.`;
    },
    submit: async () => undefined,
    confirm: async () => "confirmed",
  };
}

/** "0.0012345 ETH" style, at most `decimals` decimals, no trailing zeros. */
export function formatEth(wei: bigint, decimals = 6): string {
  const [whole, frac = ""] = formatEther(wei).split(".");
  const cut = frac.slice(0, decimals).replace(/0+$/, "");
  return cut ? `${whole}.${cut}` : whole!;
}

/** USD cents -> wei at `usdPerEth`, rounded to 4 significant digits so the device shows a short, exact amount. */
export function usdToWei(cents: number, usdPerEth: number): bigint {
  const [mantissa = "0", exponent = "0"] = (cents / 100 / usdPerEth).toExponential(3).split("e");
  const shift = 18 + Number(exponent) - 3; // "1.234e-3" ETH = 1234 * 10^(18 - 3 - 3) wei
  return shift < 0 ? 0n : BigInt(mantissa.replace(".", "")) * 10n ** BigInt(shift);
}

export function baseMoney(chain: Chain): Money {
  const balance = async (address: string) => {
    const [wei, usd] = await Promise.all([chain.balanceWei(address), chain.ethUsdPrice()]);
    return `${formatEth(wei)} ETH (${formatCents(Math.round((Number(formatEther(wei)) * usd) * 100))})`;
  };
  const usdcBalance = (address: string) => chain.tokenBalance(USDC.address, address).catch(() => undefined);
  /** Fees and nonce for a transfer, checked against the balance; the meta the Ethereum app signs. */
  const plan = async (owner: Account, address: string, wei: bigint): Promise<{ wei: bigint; eth: string; meta: EthTxMeta } | string> => {
    const p = await chain.prepareTransfer(owner.pubkey, address, wei);
    const have = await chain.balanceWei(owner.pubkey);
    const need = wei + p.gasLimit * p.maxFeePerGas;
    if (need > have) {
      return `Error: insufficient funds on Base. The balance is ${await balance(owner.pubkey)}; this needs ${formatEth(need, 8)} ETH including the network fee. Tell the owner; do not propose it.`;
    }
    const meta: EthTxMeta = {
      to: address,
      valueWei: wei.toString(),
      chainId: p.chainId,
      nonce: p.nonce,
      gasLimit: p.gasLimit.toString(),
      maxFeePerGas: p.maxFeePerGas.toString(),
      maxPriorityFeePerGas: p.maxPriorityFeePerGas.toString(),
    };
    return { wei, eth: formatEth(wei, 18), meta };
  };
  /** A transfer of `cents` in USDC with Ledger's token descriptor, or an "Error: ..." line (not enough USDC, or ETH for the fee). */
  async function transferUsdc(owner: Account, address: string, cents: number): Promise<{ units: bigint; usdc: string; meta: EthTxMeta } | string> {
    const units = centsToUsdc(cents);
    if (units <= 0n) return "Error: that amount is too small to send.";
    const have = await chain.tokenBalance(USDC.address, owner.pubkey);
    if (have < units) {
      return `Error: not enough USDC on Base. The balance is ${formatUsdc(have)} USDC at ${getAddress(owner.pubkey)}; this needs ${formatUsdc(units)} USDC. Tell the owner to send USDC on Base to their address; do not propose it.`;
    }
    // The ETH leg of plan() is the gas check: a token transfer carries no ETH but still needs some for the fee.
    const data = erc20TransferData(getAddress(address), units);
    const p = await chain.prepareTransfer(owner.pubkey, USDC.address, 0n, data);
    const ethHave = await chain.balanceWei(owner.pubkey);
    const fee = p.gasLimit * p.maxFeePerGas;
    if (fee > ethHave) return `Error: not enough ETH on Base for the network fee (${formatEth(fee, 8)} ETH); the balance is ${await balance(owner.pubkey)}. Tell the owner; do not propose it.`;
    const meta: EthTxMeta = {
      to: USDC.address,
      valueWei: "0",
      data,
      chainId: p.chainId,
      nonce: p.nonce,
      gasLimit: p.gasLimit.toString(),
      maxFeePerGas: p.maxFeePerGas.toString(),
      maxPriorityFeePerGas: p.maxPriorityFeePerGas.toString(),
    };
    let erc20Tokens: string[];
    try {
      erc20Tokens = await chain.erc20Resolution(unsignedTx(meta).unsignedSerialized);
    } catch (err) {
      return `Error: could not fetch Ledger's USDC descriptor for Base (${(err as Error).message}), so the Ledger could not show this clearly. Tell the owner to try again in a moment; do not propose it.`;
    }
    return { units, usdc: formatUsdc(units), meta: { ...meta, resolution: { erc20Tokens } } };
  }
  return {
    mode: "eth",
    appName: "the Ethereum app",
    startingCents: 0,
    async balanceText(account) {
      const [eth, usdc] = await Promise.all([balance(account.pubkey), usdcBalance(account.pubkey)]);
      // USDC only once there is some: most accounts hold ETH alone, and "0 USDC" is noise.
      return `${eth}${usdc ? ` and ${formatUsdc(usdc)} USDC` : ""} on Base`;
    },
    async pay(owner, to, amount, memo) {
      const address = getAddress(typeof to === "string" ? to : to.pubkey);
      const toTag = typeof to === "string" ? undefined : to.tag;
      const usdPerEth = await chain.ethUsdPrice();
      const ethMatch = /^\s*(\d+(?:\.\d+)?)\s*eth\s*$/i.exec(amount);
      let wei: bigint;
      let cents: number;
      if (ethMatch) {
        wei = parseEther(ethMatch[1]!);
        cents = Math.round(Number(ethMatch[1]) * usdPerEth * 100);
      } else {
        const parsed = parseCents(amount);
        if (!parsed) return "Error: Amount must be dollars like $5.00 or ETH like 0.001 ETH.";
        cents = parsed;
        // Dollars go as USDC when the owner holds enough of it (ETH then only pays the small fee); otherwise as ETH.
        const usdc = await usdcBalance(owner.pubkey);
        if (usdc !== undefined && usdc >= centsToUsdc(cents)) {
          const planned = await transferUsdc(owner, address, cents);
          if (typeof planned === "string") return planned;
          const fields: ActionField[] = [
            { label: "To", value: toTag ?? address },
            { label: "Amount", value: formatCents(cents) },
            { label: "USDC", value: planned.usdc },
            ...(toTag ? [{ label: "Address", value: address }] : []),
            ...(memo ? [{ label: "Memo", value: toFieldText(memo) }] : []),
          ];
          const action: Action = { code: "PAY", id: newActionId(), fields, meta: planned.meta };
          return { action, prompt: `Please confirm on your Ledger: Send ${planned.usdc} USDC (${formatCents(cents)}) to ${toTag ? `${toTag} ` : ""}${address}` };
        }
        wei = usdToWei(cents, usdPerEth);
      }
      const planned = await plan(owner, address, wei);
      if (typeof planned === "string") return planned;
      const { eth, meta } = planned;
      const fields: ActionField[] = [
        { label: "To", value: toTag ?? address },
        { label: "Amount", value: formatCents(cents) },
        { label: "ETH", value: eth },
        ...(toTag ? [{ label: "Address", value: address }] : []),
        ...(memo ? [{ label: "Memo", value: toFieldText(memo) }] : []),
      ];
      const action: Action = { code: "PAY", id: newActionId(), fields, meta };
      return { action, prompt: `Please confirm on your Ledger: Send ${eth} ETH (${formatCents(cents)}) to ${toTag ? `${toTag} ` : ""}${address}` };
    },
    async transfer(owner, address, cents) {
      const wei = usdToWei(cents, await chain.ethUsdPrice());
      if (wei <= 0n) return "Error: that amount is too small to send.";
      return plan(owner, getAddress(address), wei);
    },
    transferUsdc,
    verify: verifyEthSignature,
    async accountCreatedText(tag, address) {
      const shown = getAddress(address);
      try {
        return `You're in: ${tag} is bound to ${shown} with ${await balance(address)} on Base.`;
      } catch {
        return `You're in: ${tag} is bound to ${shown} on Base.`;
      }
    },
    submit: async (action, signature) => (isTxCode(action.code) ? chain.broadcast(signature) : undefined),
    confirm: (hash) => chain.waitForReceipt(hash, 120_000),
  };
}
