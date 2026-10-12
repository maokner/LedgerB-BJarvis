/**
 * Shared contracts between the three parts of AgentSign:
 *
 *   - src/device/*      talks to Ledger devices (Speculos or USB) and verifies signatures
 *   - src/channels/*    moves text in and out (iMessage through Photon, or a local dev channel)
 *   - everything else   accounts, the xAI agent, approvals, executors, agent-to-agent talk
 *
 * Keep this file small and stable. Each part depends only on what is here.
 */

// ---------------------------------------------------------------------------
// Actions: the one thing a Ledger ever signs
// ---------------------------------------------------------------------------

/** Three-letter short codes shown on the device as the review title. */
export type ActionCode =
  | "PAY" // send money to a peer
  | "CAL" // add an event to the owner's calendar
  | "FRQ" // send a friend request (lets the two agents talk)
  | "FAC" // accept a friend request
  | "ACC" // create an account (bind this Ledger to a tag and a phone)
  | "DEL" // delete the owner's account (Ethereum app only; the custom app refuses it)
  | "BUY" // buy an item on Amazon: ETH to the operator's treasury, which orders with the operator's card (Ethereum app only)
  | "EAT"; // order food on DoorDash: USDC to the operator's treasury, which orders on the operator's account (Ethereum app only)

export const ACTION_TITLES: Record<ActionCode, string> = {
  PAY: "Send money",
  CAL: "Add to calendar",
  FRQ: "Friend request",
  FAC: "Accept friend",
  ACC: "Create account",
  DEL: "Delete account",
  BUY: "Buy on Amazon",
  EAT: "Order food",
};

/** Codes signed as an EIP-1559 transfer in Ethereum mode (action.meta); every other code is a personal message. */
export const TX_CODES: readonly ActionCode[] = ["PAY", "BUY", "EAT"];
export const isTxCode = (code: ActionCode): boolean => TX_CODES.includes(code);
/** Codes that pay the treasury for an order (src/purchases.ts): their own texts follow the payment, not the generic receipt. */
export const PURCHASE_CODES = ["BUY", "EAT"] as const satisfies readonly ActionCode[];
export type PurchaseCode = (typeof PURCHASE_CODES)[number];
export const isPurchaseCode = (code: string): code is PurchaseCode => (PURCHASE_CODES as readonly string[]).includes(code);

export interface ActionField {
  /** Printable ASCII, 1..16 bytes. Example: "To", "Amount", "When". */
  label: string;
  /** Printable ASCII, 1..64 bytes. Example: "@gabriel", "$5.00". */
  value: string;
}

/** What the device displays and signs. See src/actions.ts for the byte encoding. */
export interface Action {
  code: ActionCode;
  /** 16 random bytes as 32 lowercase hex characters. Unique per request; never reused. */
  id: string;
  /** 1..6 fields, shown in order. */
  fields: ActionField[];
  /** Ethereum mode only, PAY, BUY and EAT: the transaction to sign. Not shown as fields and not part of encodeAction(). */
  meta?: EthTxMeta;
}

/** An EIP-1559 transaction, filled by the server before it asks the Ethereum app to sign. Big numbers are decimal strings. */
export interface EthTxMeta {
  to: string;
  valueWei: string;
  /** Call data, 0x hex. Unset or "0x": a plain ETH transfer. A USDC payment is transfer(to, amount) on the token contract. */
  data?: string;
  /**
   * What the Ethereum app needs to clear-sign a token transfer: Ledger's signed descriptors of the ERC-20 tokens in
   * the transaction (hw-app-eth's `erc20Tokens`), fetched by the server once at proposal time so neither the USB path
   * nor the approval page has to reach Ledger's servers.
   */
  resolution?: { erc20Tokens: string[] };
  chainId: number;
  nonce: number;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export interface DeviceInfo {
  /** Stable within a process run: "speculos:127.0.0.1:9999" or "hid:<path>". */
  id: string;
  kind: "speculos" | "hid";
  /** Ed25519 public key of the AgentSign app on that device, 64 lowercase hex characters. */
  pubkey: string;
  /** Human label for logs: "Speculos flex :9999", "Ledger Flex (USB)". */
  label: string;
}

/** As the pubkey for sign(): any device that `SignOptions.accept` allows (Ethereum-mode sign-up from an unknown Ledger). */
export const ANY_DEVICE = "";

export type SignResult =
  /** `pubkey`: the device that signed; always set when sign() was called with ANY_DEVICE. */
  | { status: "approved"; signature: string /* 128 hex chars, Ed25519 over sha256(encodeAction(action)) */; pubkey?: string }
  | { status: "rejected" } // the person pressed Reject on the device
  | { status: "no_device"; expiredLink?: true } // no connected device with that pubkey appeared before the timeout
  | { status: "timeout"; expiredLink?: true } // the device showed the request but nobody answered in time
  // expiredLink: the answer came from an approval-page link that expired (nobody opened it, or the page never answered)
  | { status: "error"; message: string };

export interface SignOptions {
  /** Total time to wait for the device to appear and the person to answer. Default 120 s. */
  timeoutMs?: number;
  /** Stops waiting: sign() resolves with "no_device" soon after, and a device that was not asked yet is not asked. */
  signal?: AbortSignal;
  /** With ANY_DEVICE: which device keys may answer (for example, not already bound to an account). */
  accept?: (pubkey: string) => boolean;
  /**
   * Call once the person is answering through this manager: the request is on a USB device, or the approval page
   * loaded it. Combined managers then stop the others, so the server's USB polling never fights a browser over
   * the same Ledger (on macOS, node-hid seizes the device and the browser stops receiving the Ledger's replies).
   */
  claim?: () => void;
}

/**
 * Finds devices and asks them to sign. Implementations: the real one over Speculos TCP and USB HID
 * (src/device/manager.ts) and a fake for tests (src/device/fake.ts).
 */
export interface DeviceManager {
  /** Devices reachable right now that have the AgentSign app open. Never throws; unreachable devices are skipped. */
  list(): Promise<DeviceInfo[]>;
  /**
   * Shows `action` on the device whose app key is `pubkey` and waits for the answer. If that device is
   * not connected yet, polls for it until the timeout. Never throws; failures come back as a status.
   */
  sign(pubkey: string, action: Action, options?: SignOptions): Promise<SignResult>;
  /**
   * Optional, called before the owner is texted: lets a manager get ready for `action` (the remote manager
   * registers a signing job) and returns a link the owner can open to sign it elsewhere.
   */
  prepare?(pubkey: string, action: Action): Promise<{ url?: string; expiresAt?: number }>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export type ChannelService = "iMessage" | "SMS" | "RCS" | "telegram" | "dev";

export interface InboundMessage {
  /** Unique per message (chat.db GUID on iMessage). The app ignores an id it has seen. */
  id: string;
  /** Raw sender address as the channel saw it. The app normalizes it with normalizeHandle(). */
  handle: string;
  /** Message text, possibly empty when only an image was sent. */
  text: string;
  /** Absolute local paths of image attachments (receipts). Non-image attachments are dropped by the channel. */
  images: string[];
  at: Date;
  service: ChannelService;
  /** The sender's public username without "@" when the channel has one (Telegram). Default tag at signup. */
  username?: string;
  /** The sender's display name when the channel has one. */
  name?: string;
}

/** Text in and out. One instance per process. */
export interface Channel {
  readonly name: string;
  /** Start delivering direct messages to `onMessage`. Group chats are ignored. Resolves once listening. */
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  /** Send one text to one handle. Resolves when the transport accepted it. */
  send(handle: string, text: string): Promise<void>;
  /** Optional: show or hide the typing indicator in the chat with `handle`. Best effort, never throws. */
  typing?(handle: string, on: boolean): Promise<void>;
  /** Optional: react to an inbound message (InboundMessage.id) with an emoji, like a tapback. Best effort, never throws. */
  react?(messageId: string, emoji: string): Promise<void>;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The app, as the channel and the entry point see it
// ---------------------------------------------------------------------------

export interface App {
  /** Handle one inbound message end to end. Replies and later notifications go out through the channel. */
  handleInbound(message: InboundMessage): Promise<void>;
  close(): Promise<void>;
}
