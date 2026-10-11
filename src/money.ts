/**
 * What differs between the two device modes:
 *   agentsign  custom AgentSign Ledger app, Ed25519 signatures, demo dollars in SQLite
 *   eth        Ledger's Ethereum app, real ETH on Base mainnet
 */
import { formatEther, getAddress, parseEther } from "ethers";
import { describeAction, newActionId, toFieldText, verifyActionSignature } from "./actions.js";
import type { Chain } from "./chain.js";
import type { Account } from "./db.js";
import { verifyEthSignature } from "./device/eth.js";
import { formatCents, parseCents } from "./format.js";
import { ACTION_TITLES, type Action, type ActionField } from "./types.js";

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
  verify(pubkey: string, action: Action, signature: string): boolean;
  /** The text after an account is created. */
  accountCreatedText(tag: string, pubkey: string): Promise<string>;
  /** eth: broadcasts a signed PAY and returns the hash. agentsign: nothing to do. */
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
  return {
    mode: "eth",
    appName: "the Ethereum app",
    startingCents: 0,
    balanceText: async (account) => `${await balance(account.pubkey)} on Base`,
    async pay(owner, to, amount, memo) {
      const address = getAddress(typeof to === "string" ? to : to.pubkey);
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
        wei = usdToWei(cents, usdPerEth);
      }
      if (wei <= 0n) return "Error: that amount is too small to send.";
      const plan = await chain.prepareTransfer(owner.pubkey, address, wei);
      const have = await chain.balanceWei(owner.pubkey);
      const need = wei + plan.gasLimit * plan.maxFeePerGas;
      if (need > have) {
        return `Error: insufficient funds on Base. The balance is ${await balance(owner.pubkey)}; this needs ${formatEth(need, 8)} ETH including the network fee. Tell the owner; do not propose it.`;
      }
      const eth = formatEth(wei, 18);
      const toTag = typeof to === "string" ? undefined : to.tag;
      const fields: ActionField[] = [
        { label: "To", value: toTag ?? address },
        { label: "Amount", value: formatCents(cents) },
        { label: "ETH", value: eth },
        ...(toTag ? [{ label: "Address", value: address }] : []),
        ...(memo ? [{ label: "Memo", value: toFieldText(memo) }] : []),
      ];
      const meta = {
        to: address,
        valueWei: wei.toString(),
        chainId: plan.chainId,
        nonce: plan.nonce,
        gasLimit: plan.gasLimit.toString(),
        maxFeePerGas: plan.maxFeePerGas.toString(),
        maxPriorityFeePerGas: plan.maxPriorityFeePerGas.toString(),
      };
      const action: Action = { code: "PAY", id: newActionId(), fields, meta };
      return { action, prompt: `Please confirm on your Ledger: Send ${eth} ETH (${formatCents(cents)}) to ${toTag ? `${toTag} ` : ""}${address}` };
    },
    verify: verifyEthSignature,
    async accountCreatedText(tag, address) {
      const shown = getAddress(address);
      try {
        return `You're in: ${tag} is bound to ${shown} with ${await balance(address)} on Base.`;
      } catch {
        return `You're in: ${tag} is bound to ${shown} on Base.`;
      }
    },
    submit: async (action, signature) => (action.code === "PAY" ? chain.broadcast(signature) : undefined),
    confirm: (hash) => chain.waitForReceipt(hash, 120_000),
  };
}
