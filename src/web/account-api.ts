/**
 * The contract between the account page (src/web/dashboard-client.ts, in the browser) and its API
 * (src/web/account.ts, on the server). Types only: this file is bundled into the browser, so nothing from Node here.
 *
 * Routes, all JSON, all under /api (the server never caches them):
 *   POST /api/login/challenge   {}                                  -> LoginChallenge
 *   POST /api/login             { nonce, address, signature }       -> { ok: true, tag } | ApiError
 *                               `signature` is the Ledger's personal-message signature over LoginChallenge.message
 *                               (ethers verifyMessage recovers `address`); the nonce is single use and short lived.
 *                               Sets the session cookie (HttpOnly, SameSite=Lax, Secure on https).
 *   POST /api/logout            {}                                  -> { ok: true }     (clears the cookie)
 *   GET  /api/me                                                    -> MeView | 401 ApiError
 *   POST /api/google/connect    {}                                  -> { ok: true, url } | ApiError
 *   POST /api/google/disconnect {}                                  -> { ok: true } | ApiError
 *   POST /api/phone/link        { number }                          -> { ok: true, handle } | ApiError
 *   POST /api/phone/unlink      { handle }                          -> { ok: true } | ApiError
 *   POST /api/policy            PolicyChange                        -> { ok: true, policy: PolicyView } | ApiError
 *   POST /api/delete            {}                                  -> { ok: true, url, path } | ApiError (409 while another approval waits)
 *                               Proposes DEL for the signed-in account exactly like the chat would: the owner is texted,
 *                               and `path` (/sign/<token>) is the approval page where their Ledger signs it.
 *
 * Every POST needs `content-type: application/json`, and an Origin header (when the browser sends one) that is the
 * server's own PUBLIC_URL or one of DASHBOARD_ORIGINS. Anything else is refused with 403.
 */

export interface LoginChallenge {
  /** What the Ledger signs (a personal message), shown on the device page by page. */
  message: string;
  /** 32 hex characters; sent back with the signature. */
  nonce: string;
  /** Unix ms. */
  expiresAt: number;
}

export interface ApiError {
  ok: false;
  /** Plain words for the person. */
  error: string;
}

export type ConnectionId = "chat" | "ledger" | "google" | "phone" | "amazon" | "doordash";

export type ConnectionStatus =
  /** Set up for this account. */
  | "connected"
  /** The server offers it and the account can connect it from the page. */
  | "available"
  /** Not set up on this server (the operator has not configured it). */
  | "unavailable";

export type ConnectionAction =
  | { kind: "connect-google" }
  | { kind: "disconnect-google" }
  /** Link a phone number for calls (the page asks for the number). */
  | { kind: "link-phone" }
  | { kind: "unlink-phone"; handle: string; label: string };

export interface ConnectionView {
  id: ConnectionId;
  /** "Google Calendar", "iMessage", "Phone calls", ... */
  name: string;
  status: ConnectionStatus;
  /** One line under the name: what it does, or why it is off. */
  summary: string;
  /** The connected thing itself when there is one: the Google email, the phone numbers, the delivery address. */
  detail?: string;
  actions: ConnectionAction[];
}

export type PolicyPreset = "relaxed" | "standard" | "strict";
export type PolicyGuard = "calendar" | "meetings" | "friends";

export interface PolicyView {
  preset: PolicyPreset;
  /** True: that kind of action goes to the Ledger. Money and deleting the account always do. */
  gates: Record<PolicyGuard, boolean>;
  /** The sentence Jarvis would say about it. */
  description: string;
}

/** A preset resets the three; single flags stack on the current preset. At least one field. */
export interface PolicyChange {
  preset?: PolicyPreset;
  calendar?: boolean;
  meetings?: boolean;
  friends?: boolean;
}

export interface FriendView {
  tag: string;
  /** accepted; pending: they asked, the owner has not answered; requested: the owner asked, they have not answered. */
  status: "accepted" | "pending" | "requested";
}

export interface ActivityView {
  id: string;
  code: string;
  /** "Send money", "Order food", ... */
  title: string;
  /** The fields in one line: "To @gabriel · Amount $5.00". */
  summary: string;
  status: "pending" | "approved" | "executed" | "rejected" | "failed" | "expired";
  /** ISO 8601, when it was proposed. */
  at: string;
  /** Basescan, for actions that went on chain. */
  link?: string;
}

export interface MeView {
  tag: string;
  /** The Ledger's Ethereum address, checksummed. */
  address: string;
  /** ISO 8601. */
  createdAt: string;
  displayName?: string;
  /** Where the owner talks to Jarvis. `handle` is the owner's own address there (a phone, an email, "tg:<id>"). */
  channel: { kind: "iMessage" | "Telegram" | "dev"; handle: string; /** Jarvis's own number or @bot, as the owner reaches it. */ jarvis?: string };
  /** "0.012 ETH ($48.20) and 12 USDC on Base"; absent when Base could not be read in time. */
  balance?: string;
  /** Where the account's chain activity is listed. */
  explorerUrl: string;
  policy: PolicyView;
  connections: ConnectionView[];
  friends: FriendView[];
  /** Newest first, at most 20. */
  activity: ActivityView[];
  /** The approval the owner's Ledger is waiting on right now, if any, with its page. */
  pending?: { code: string; title: string; summary: string; path?: string; url?: string };
}
