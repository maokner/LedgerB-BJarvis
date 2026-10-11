# AgentSign: an iMessage agent whose risky actions are clear-signed on a Ledger

Hackathon build. Bare-bones on purpose: one Node process, one SQLite file, one small Ledger app, xAI (Grok) for the model.

## The demo

1. Matt texts the agent's iMessage number for the first time. The agent does not know the number.
   It asks for a tag. Matt replies `@matt`. The agent asks him to confirm **Create account** on his Ledger Nano S Plus.
   The device shows `Create account / Tag @matt / Phone +1415...`. Matt approves. His account now exists, bound to that device's key.
2. Matt texts `send $5 to @gabriel`. The agent proposes a payment and texts `Please confirm on your Ledger: Send money, To @gabriel, Amount $5.00`.
   The device shows exactly that. Matt approves. The signature is verified against his account key, the balance moves, Gabriel is texted.
3. Matt texts a photo of a receipt: `pay gabe back for lunch`. Grok reads the total from the image; same approval flow.
4. Matt texts `add @yadu as a friend`. **Friend request** is signed on Matt's Ledger. Yadu is texted. Yadu says `accept`, signs **Accept friend** on his own Ledger. Now the two agents may talk to each other.
5. Matt texts `set up a 30 minute meeting with yadu tomorrow afternoon`. Matt's agent asks Yadu's agent, which checks Yadu's calendar and answers with free slots only.
   Matt's agent proposes **Add to calendar** on Matt's Ledger. After Matt approves, Yadu is texted and asked to approve the same event on his Ledger. Both calendars get the event.

Nothing risky happens without a signature from the owner's device. The agent has no tool that can move money, write a calendar, or add a friend. It can only *propose*.

## Architecture

```
iMessage (Photon)  ──┐                            ┌── Ledger Nano S Plus (USB HID)
                     ├─ Channel ─► App ─► DeviceManager ─┤
dev HTTP/REPL ───────┘            │                      └── Speculos emulator (TCP), for development
                                  │
                        ┌─────────┴──────────┐
                        │ SQLite             │  accounts, handles, friendships, balances,
                        │ xAI agent per acct │  calendar, notes, chat history, actions log
                        └────────────────────┘
```

Source layout (TypeScript, ESM, Node 22+, `tsx` to run, `vitest` to test, `better-sqlite3`):

| Path | Owner | What |
|---|---|---|
| `src/types.ts` | shared, stable | the contracts: `Action`, `DeviceManager`, `Channel`, `App` |
| `src/actions.ts` | shared, stable | canonical action bytes, digest, Ed25519 verify, field sanitizing |
| `src/handles.ts` | shared, stable | handle normalization, tag parsing |
| `device-app/` | device agent | the Rust Ledger app (Nano S Plus), `PROTOCOL.md`, Speculos tests |
| `src/device/` | device agent | TS client: APDUs, Speculos TCP transport, USB HID transport, `createDeviceManager()`, `FakeDeviceManager` |
| `scripts/speculos.sh`, `scripts/sideload.sh` | device agent | start two emulators; load the app on a real Nano S Plus |
| `src/db.ts` | app agent | schema and queries |
| `src/agent/` | app agent | xAI client, tools, the per-account agent loop, peer turns |
| `src/approvals.ts`, `src/executors.ts` | app agent | propose, sign, verify, execute, notify |
| `src/app.ts` | app agent | `createApp()`: routing, onboarding, friend requests, everything behind `App.handleInbound` |
| `src/index.ts` | app agent | entry: env, DB, device manager, channel, app |
| `src/channels/imessage.ts`, `src/channels/dev.ts` | channel agent | Photon channel; local HTTP + REPL channel |
| `README.md` | channel agent | how to run the whole thing, permissions, demo script |

## Actions and clear signing

An `Action` is a short code plus 1..6 label/value pairs (see `src/types.ts`). `src/actions.ts` encodes it to bytes:

```
"AGS1" | code (3 ASCII) | id (16 bytes) | N | N x (label_len, label, value_len, value)
```

The device parses these bytes itself, shows the title for the code and every field, and after the person presses both buttons on **Approve** it signs `sha256(bytes)` with Ed25519 (SLIP-0010 path `m/44'/8008'/0'/0'/0'`). The server verifies with `verifyActionSignature()` against the pubkey stored on the account. Unknown codes are refused by the device. The action id makes every signature single-use: the server only accepts a signature for the action it is currently waiting on.

Codes: `PAY` Send money, `CAL` Add to calendar, `FRQ` Friend request, `FAC` Accept friend, `ACC` Create account.

Field conventions (the server builds them, the device just shows them):

| Code | Fields |
|---|---|
| ACC | `Tag @matt`, `Phone +14155551234` |
| PAY | `To @gabriel`, `Amount $5.00`, optional `Memo lunch` |
| CAL | `Title Lunch with Gabe`, `When Sat Oct 11 12:00-13:00`, optional `With @gabriel` |
| FRQ | `To @yadu` |
| FAC | `From @matt` |

## Device manager

`DeviceManager.list()` returns every reachable device with the AgentSign app open and its pubkey. `DeviceManager.sign(pubkey, action)` finds the device with that key (polling until the timeout if it is not there yet), sends the action, and returns the signature or a status. The app never picks a device by USB path; it always goes by pubkey, so two people with two Nano S Pluses on one Mac both work.

For account creation the app lists devices, removes the pubkeys already bound to accounts, and signs `ACC` on the one that is left.

Devices come from `DEVICES` in the environment: `speculos:<host>:<port>` entries and `hid` for USB.

## The agent and its harness

One agent per account (system prompt with the owner's tag, the date, their balance, friends, and notes). Conversation history is persisted per account and the last ~30 turns are sent to the model. Model: xAI chat completions with tool calling (`XAI_MODEL`, default a fast non-reasoning Grok); images (receipts) go in as base64 data URLs.

Safe tools (execute directly): `get_balance`, `list_friends`, `get_calendar(from,to)`, `get_notes`, `remember(note)`, `list_transactions`, `message_agent(tag, text)`.

Risky tools do not exist. There is one `propose_action(code, fields)` tool. The app turns it into a pending approval: it texts the owner what will be shown on the device, calls `deviceManager.sign`, verifies, executes through `src/executors.ts`, logs the action with its signature, and texts the outcome. The model is told the outcome on its next turn (as a system note in history) so it can answer "did it go through?".

`message_agent` runs a *peer turn* on the other account's agent: a separate system prompt ("you are @yadu's agent talking to @matt's agent"), the persisted peer thread, and only `get_free_busy(from,to)` (busy intervals, no titles) plus `get_notes_shareable`... keep it to free/busy. Non-friends get a refusal string instead of a peer turn. Each owner is texted a one-line note the first time their agent talks to a peer in a thread.

## Executors (run only after a verified signature)

- `ACC`: create account (tag, pubkey, handle), balance starts at $250.00 demo money.
- `PAY`: debit sender, credit recipient (recipient must exist), log a transaction, text the recipient.
- `CAL`: insert the event for the owner. If `With @tag` names an accepted friend, create a `CAL` approval for that friend too (same title and time, `With` = the proposer) and text them; their calendar gets the event only after their own signature.
- `FRQ`: friendship row `pending`, text the target's handles.
- `FAC`: friendship `accepted`, text both.

## Channels

`Channel.start(onMessage)` delivers direct messages; `Channel.send(handle, text)` sends. The iMessage channel is Photon's `@photon-ai/imessage-kit` (reads `~/Library/Messages/chat.db`, sends through Messages.app). It needs Full Disk Access and Automation for the terminal that runs it; only Matt can grant those, and nothing in tests may touch Messages.app or chat.db. The dev channel is an HTTP server (`POST /dev/message`, `GET /dev/outbox`) plus a REPL so the whole flow can be exercised with Speculos and no phone.

## Non-goals

No web UI, no real money, no Google Calendar, no multi-process agent federation, no Flex/Stax UI. Keep every file short and obvious.
