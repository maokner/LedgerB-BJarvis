/**
 * The single source of truth for "did this address approve exactly this action" in Ethereum mode,
 * used for USB answers (eth.ts), browser answers (remote.ts) and again by approvals before executing.
 */
import { Transaction, verifyMessage } from "ethers";
import { actionMessage } from "../actions.js";
import { type Action, isTxCode } from "../types.js";
import { type EthAnswer, type EthRequest, unsignedTx } from "./eth-tx.js";

/**
 * What the device must do for `action`. PAY and BUY sign action.meta; CAL, FRQ, FAC sign actionMessage().
 * ACC over USB is "Verify address"; on the page it signs actionMessage() too, since the page's answer must prove the key.
 */
export function ethRequest(action: Action, via: "usb" | "page" = "usb"): EthRequest {
  if (action.code === "ACC" && via === "usb") return { kind: "address" };
  if (isTxCode(action.code)) {
    if (!action.meta) throw new Error(`${action.code} without transaction data`);
    return { kind: "tx", meta: action.meta };
  }
  return { kind: "message", message: actionMessage(action) };
}

/** True when `signature` proves `address` approved exactly `action` ("verified" or a message signature for ACC, raw tx for PAY and BUY, else a message signature). */
export function verifyEthSignature(address: string, action: Action, signature: string): boolean {
  try {
    if (action.code === "ACC" && signature === "verified") return true;
    if (isTxCode(action.code)) {
      if (!action.meta) return false;
      const tx = Transaction.from(signature);
      return tx.from?.toLowerCase() === address && tx.unsignedHash === unsignedTx(action.meta).unsignedHash;
    }
    return verifyMessage(actionMessage(action), signature).toLowerCase() === address;
  } catch {
    return false;
  }
}

/**
 * Turns what the device answered into the signature approvals stores, or an error in plain words.
 * `address` "" (ANY_DEVICE) is only allowed for a message signature: the signer is recovered and returned.
 */
export function ethProof(address: string, action: Action, answer: EthAnswer, via: "usb" | "page" = "usb"): { signature: string; address: string } | { error: string } {
  let expected: EthRequest["kind"];
  try {
    expected = ethRequest(action, via).kind;
  } catch (err) {
    return { error: (err as Error).message };
  }
  if (answer.kind !== expected || typeof answer.value !== "string") return { error: `expected a ${expected} answer` };
  if (answer.kind === "address") {
    const shown = answer.value.toLowerCase();
    return shown === address ? { signature: "verified", address } : { error: `the device verified ${shown}, expected ${address}` };
  }
  let signer = address;
  if (!address && answer.kind === "message") {
    try {
      signer = verifyMessage(actionMessage(action), answer.value).toLowerCase();
    } catch {
      return { error: "not a message signature" };
    }
  }
  return signer && verifyEthSignature(signer, action, answer.value) ? { signature: answer.value, address: signer } : { error: "the device returned a signature that does not verify" };
}
