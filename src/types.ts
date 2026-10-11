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
  | "ACC"; // create an account (bind this Ledger to a tag and a phone)

export const ACTION_TITLES: Record<ActionCode, string> = {
  PAY: "Send money",
  CAL: "Add to calendar",
  FRQ: "Friend request",
  FAC: "Accept friend",
  ACC: "Create account",
};

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

export type SignResult =
  | { status: "approved"; signature: string /* 128 hex chars, Ed25519 over sha256(encodeAction(action)) */ }
  | { status: "rejected" } // the person pressed Reject on the device
  | { status: "no_device" } // no connected device with that pubkey appeared before the timeout
  | { status: "timeout" } // the device showed the request but nobody answered in time
  | { status: "error"; message: string };

export interface SignOptions {
  /** Total time to wait for the device to appear and the person to answer. Default 120 s. */
  timeoutMs?: number;
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
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export type ChannelService = "iMessage" | "SMS" | "RCS" | "dev";

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
}

/** Text in and out. One instance per process. */
export interface Channel {
  readonly name: string;
  /** Start delivering direct messages to `onMessage`. Group chats are ignored. Resolves once listening. */
  start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void>;
  /** Send one text to one handle. Resolves when the transport accepted it. */
  send(handle: string, text: string): Promise<void>;
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
