/**
 * The owner's delivery address (accounts.delivery_address): one saved address for every store, where DoorDash food
 * is delivered and Amazon orders ship unless the owner names another one for a single order. Jarvis checks it with the
 * owner before each order ("Deliver to ...?"), so the engine and the stores only ever see an address the owner agreed to.
 */
import { toFieldText } from "./actions.js";
import type { Account, Db } from "./db.js";

/** The engine's error when an order needs an address and none was given or saved. `verb`: "deliver" (food), "ship" (Amazon). */
export const noAddress = (verb: "deliver" | "ship"): string =>
  `Error: there is no delivery address. Ask the owner where to ${verb}; when they give their own, save it with set_delivery_address.`;

/** Whitespace collapsed; "" for nothing. */
export const cleanAddress = (address: string | null | undefined): string => (address ?? "").replace(/\s+/g, " ").trim();

/** Whether a cleaned address looks like a street address: a number and a street name, a sane length. */
export const looksLikeAddress = (address: string): boolean => address.length >= 6 && address.length <= 200 && /\d/.test(address) && /[a-z]/i.test(address);

export const NOT_AN_ADDRESS = "Error: that does not look like a street address. Ask for the full one: number, street, city (and apartment, if any).";

/** An address as the Ledger's Deliver or Ship field: the street and the city, cut to one line. */
export function shortAddress(address: string): string {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  const two = parts.slice(0, 2).join(", ");
  return toFieldText(two.length <= 48 ? two : (parts[0] ?? address));
}

/** The owner's saved address as stored now (the tools get the account as it was at the start of the turn), or undefined. */
export const savedAddress = (db: Db, owner: Account): string | undefined => cleanAddress((db.account(owner.id) ?? owner).delivery_address) || undefined;

/** Saves the owner's own delivery address (set_delivery_address); the line for the model. */
export function saveAddress(db: Db, owner: Account, address: string, log: (line: string) => void = () => {}): string {
  const clean = cleanAddress(address);
  if (!looksLikeAddress(clean)) return NOT_AN_ADDRESS;
  db.setDeliveryAddress(owner.id, clean);
  log(`delivery address for ${owner.tag} saved`);
  return `Saved ${owner.tag}'s delivery address: ${clean}.`;
}

/** The owner-facts line, once for every store. `orders`: what goes there, like "Food and Amazon orders". */
export const addressFact = (owner: Account, orders: string): string =>
  owner.delivery_address
    ? `Delivery address: ${owner.delivery_address}. ${orders} go there unless ${owner.tag} names another address for one order.`
    : `Delivery address: none saved yet; ask for it as soon as they want to order (${orders.toLowerCase()} go there).`;

/** The usual street suffixes in their short form, and the apartment words that Amazon and people write differently. */
const SUFFIXES: Record<string, string> = { street: "st", avenue: "ave", av: "ave", boulevard: "blvd", road: "rd", drive: "dr", lane: "ln", court: "ct", place: "pl", terrace: "ter", parkway: "pkwy", highway: "hwy", square: "sq" };
const UNIT_WORDS = new Set(["apt", "apartment", "unit", "ste", "suite"]);

/** Letters and digits, lowercased, whitespace collapsed, suffixes shortened, apartment words dropped ("Apt 5", "Unit 5" and "#5" are all "5"). */
const words = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w && !UNIT_WORDS.has(w)).map((w) => SUFFIXES[w] ?? w).join(" ");

/** The street line of an address (its first comma-separated part), in the form mentionsAddress compares. */
export const streetLine = (address: string): string => words(address.split(",")[0] ?? "");

/** Whether `text` names this address: its street line appears in it as whole words ("1 market st" is not in "21 market st"). */
export function mentionsAddress(text: string, address: string): boolean {
  const street = streetLine(address);
  return street.length > 0 && ` ${words(text)} `.includes(` ${street} `);
}

/** Whether `text` names the street of this address at least by number and name ("1 Market St?" for "1 Market St Apt 5, ..."). */
export function mentionsStreet(text: string, address: string): boolean {
  const head = streetLine(address).split(" ").slice(0, 2).join(" ");
  return head.includes(" ") && ` ${words(text)} `.includes(` ${head} `);
}
