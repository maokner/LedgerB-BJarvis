# AgentSign: an iMessage agent whose risky actions are clear-signed on a Ledger

Hackathon build. Bare-bones on purpose: one Node process, one SQLite file, one small Ledger app, xAI (Grok) for the model.

## The demo

1. Matt texts Jarvis on iMessage, at the number of a Photon line (`PHOTON_NUMBER`).
   Jarvis introduces itself (`INTRO` in `src/agent/persona.ts`: an always-on assistant on its own computer, what it can do today, and that risky things wait on the Ledger), then asks for the tag he wants.
   Matt says `@mokner`.
   Jarvis sends a sign-up link that works in Chrome on any computer (or, with his Ledger plugged into the server's Mac, asks the device directly).
   The device shows `Create account / Tag @mokner / Phone +14155550100`.
   Matt approves.
   His account now exists: his phone number, bound to that device's key.
   On Telegram (`CHANNEL=telegram`) the start is the same, except that Matt opens the bot and presses Start, and Jarvis offers his Telegram username as the tag: "You're @mokner on Telegram, so that's your tag here."
2. Matt texts `send $5 to @gabriel`. The agent proposes a payment and texts `Please confirm on your Ledger: Send money, To @gabriel, Amount $5.00`.
   The device shows exactly that. Matt approves. The signature is verified against his account key, the balance moves, Gabriel is texted.
3. Matt texts a photo of a receipt: `pay gabe back for lunch`. Grok reads the total from the image; same approval flow.
4. Matt texts `add @yadu as a friend`. **Friend request** is signed on Matt's Ledger. Yadu is texted. Yadu says `accept`, signs **Accept friend** on his own Ledger. Now the two agents may talk to each other, and Matt can text `send yadu a thank you note`: Yadu's Jarvis texts him `@mokner says: ...` at once.
5. Matt texts `set up a 30 minute meeting with yadu tomorrow afternoon`. Matt's agent reads both calendars (Yadu's as free/busy only, never titles), picks the first afternoon slot free for both, and Yadu's Jarvis texts him: `@mokner would like to meet: 'Meeting' Mon Oct 12 14:00-14:30. Any time Mon Oct 12 12:00-17:00 works for Matt. Reply 'yes' and it goes on both calendars, or name another time.`
   Yadu says `yes` (or `3pm works better`, which books at once because it is inside Matt's window; a time outside it goes back to Matt to approve). Both calendars get the event, Google included. No Ledger on either side: a meeting between friends moves no money, so the people's own words are the approval.

Money and deleting the account never happen without a signature from the owner's device: the agent can only *propose* those.
Everything else is the owner's call. A per-owner **Ledger policy** (`src/policy.ts`) says whether their own calendar events, meetings with friends and friend changes go to the Ledger or just happen. Presets: `relaxed` (nothing else), `standard` (the default: adding friends), `strict` (all three), and any one of the three can be flipped by asking Jarvis ("ask my Ledger for calendar events too"). Changes take effect at once.

## Identity

An account is a handle (an iMessage phone number or email on Photon, or a Telegram user) plus a Ledger.
The channel names the sender by that handle: on iMessage the address they text from, normalized to E.164 or a lowercase email; on Telegram `tg:<telegram user id>`, which never changes.
The account stores the handle, the Ledger's key or address, the tag, and on Telegram the latest `username` and `display_name` (refreshed on every message).
iMessage has no usernames, so Jarvis asks every new person for the tag they want.
On Telegram the tag defaults to `@<username>` (lowercased) when that is a valid, free tag; otherwise Jarvis asks for one.
Anywhere a person is named (`To @tag`, `With @tag`), the exact phone number or email of someone with an account works too, and so does a Telegram @username.
Neither channel can start a conversation with a stranger: on a shared Photon line Jarvis can only text a number that texted the line first, and a Telegram bot only someone who pressed Start.
So friends must text Jarvis (or open the bot) before anything can reach them.
The dev channel uses phone-number handles too; it is what the tests and the REPL use.

## Architecture

```
iMessage (Photon) ───┐                            ┌── Ledger Nano S Plus (USB HID)
Telegram (Bot API) ──┼─ Channel ─► App ─► DeviceManager ─┤
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
| `src/calendar/` | app agent | the owners' calendars: AgentSign's table plus Google Calendar (OAuth link, merged reads, mirroring approved events) |
| `src/food/` | app agent | ordering food on DoorDash: the provider seam, the demo DoorDash, the browser driver, the dd-cli adapter, the EAT tools |
| `src/index.ts` | app agent | entry: env, DB, device manager, channel, app |
| `src/channels/` | channel agent | iMessage on Photon's hosted service (the default); Telegram bot channel; local HTTP + REPL channel; iMessage on the Mac's own Messages |
| `src/agent/bot.ts` | app agent | how Jarvis names itself, the chat and the way to join, per channel (`CHANNEL`, `PHOTON_NUMBER`) |
| `README.md` | channel agent | what it is, how the Ledger plays into it, how to run it |

## Actions and clear signing

An `Action` is a short code plus 1..6 label/value pairs (see `src/types.ts`). `src/actions.ts` encodes it to bytes:

```
"AGS1" | code (3 ASCII) | id (16 bytes) | N | N x (label_len, label, value_len, value)
```

The device parses these bytes itself, shows the title for the code and every field, and after the person presses both buttons on **Approve** it signs `sha256(bytes)` with Ed25519 (SLIP-0010 path `m/44'/8008'/0'/0'/0'`). The server verifies with `verifyActionSignature()` against the pubkey stored on the account. Unknown codes are refused by the device. The action id makes every signature single-use: the server only accepts a signature for the action it is currently waiting on.

Codes: `PAY` Send money, `CAL` Add to calendar, `FRQ` Friend request, `FAC` Accept friend, `ACC` Create account, `DEL` Delete account, `BUY` Buy on Amazon, `EAT` Order food (`DEL`, `BUY` and `EAT` are Ethereum mode only: the custom app refuses codes it does not know, so the engine does not offer them there).

Field conventions (the server builds them, the device just shows them):

| Code | Fields |
|---|---|
| ACC | `Tag @mokner`, `Phone +14155550100` (the iMessage handle, an email too; Telegram: `Telegram @mokner`, or `Telegram id 123456` without a username) |
| PAY | `To @gabriel`, `Amount $5.00`, optional `Memo lunch` |
| CAL | `Title Lunch with Gabe`, `When Sat Oct 11 12:00-13:00`, optional `With @gabriel` |
| FRQ | `To @yadu` |
| FAC | `From @matt` |
| DEL | `Tag @matt`, `Address 0x...` (the full lowercase address) |
| BUY | `Item Trident Original Sugar Free Gum...` (the title, cut to one line), `Total $4.35` (item, shipping and tax), `USDC 4.35`, `To 0x...` (the treasury) |
| EAT | `From Chipotle Mexican Grill`, `Order 1x Burrito Bowl, 2x Chips`, `Deliver 1 Market St Apt 5, San Francisco` (street and city), `Total $25.82` (food, fees, tax, tip), `USDC 25.82`, `To 0x...` (the treasury) |

## Device manager

`DeviceManager.list()` returns every reachable device with the AgentSign app open and its pubkey. `DeviceManager.sign(pubkey, action)` finds the device with that key (polling until the timeout if it is not there yet), sends the action, and returns the signature or a status. The app never picks a device by USB path; it always goes by pubkey, so two people with two Nano S Pluses on one Mac both work.

For account creation the app lists devices, removes the pubkeys already bound to accounts, and signs `ACC` on the one that is left.

Devices come from `DEVICES` in the environment: `speculos:<host>:<port>` entries and `hid` for USB.

## Two device modes

`DEVICE_MODE=eth` (default, the real thing): the Ledger's own Ethereum app.
An account is the device's address at m/44'/60'/0'/0/0, verified on screen at signup.
`PAY` is a real EIP-1559 ETH transfer on Base mainnet that the Ethereum app clear-signs (amount, address, fees); the server broadcasts the signed transaction and stores the hash.
`BUY` is a USDC transfer on Base (a call on the token contract) that the app clear-signs the same way once the server hands it Ledger's signed token descriptor (`EthTxMeta.resolution`, fetched from Ledger's crypto-assets list at proposal time).
`EAT` (ordering food) is the same USDC transfer to the treasury, clear-signed the same way.
`CAL`, `FRQ`, `FAC`, `DEL` are personal messages (`actionMessage()` in `src/actions.ts`) shown in full on the device and verified with ecrecover.
`DEVICE_MODE=agentsign` (offline demo): the custom Nano S Plus app in `device-app/`, demo dollars, Speculos.

The Ledger does not have to be on the server's Mac: every confirmation text carries a link to `/sign/<token>` (`src/web/`), a page that talks to the Ledger over WebHID from any Chrome, shows the action, has it signed, and posts the result back.
USB on the server Mac and the page race; the first side to engage wins (the page loaded the request, or the device shows it over USB) and the other is cancelled, so the server never polls its USB while a browser works the same Ledger. Both go through the same verification (`src/device/eth-verify.ts`).

## The agent and its harness

Two model layers per account (`src/agent/`), in the spirit of Poke:

- the **persona**, Jarvis, talks to the owner: a clever friend over text (the Poke persona, minus anything that is Poke's), concise, witty when it fits, mirroring the owner's casing and tone, plain text, no emoji. Its only tool is `delegate(goal, context)`, which it never mentions. It knows the owner's tag, address and balance, greets and offers three things to try on the first turn after sign-up, answers setup and "what can you do" questions without delegating, and adds one in-the-moment offer in roughly one reply out of five.
- the **engine** never talks to the owner. It runs the tools and reports plain facts back to the persona, never inventing anything.

Safe tools (engine, execute directly): `get_balance`, `list_friends`, `get_calendar`, `get_notes`, `remember`, `list_transactions`, `send_note`, `message_agent`, `propose_meeting`, `answer_meeting`, `set_ledger_policy`, `connect_google_calendar`, `disconnect_google_calendar`, where buying is set up `search_amazon` and `list_purchases`, and where food ordering is set up `set_delivery_address`, `search_doordash`, `doordash_menu`, `quote_doordash` and `list_purchases`.

The Ledger policy lives on the account (`accounts.policy`, JSON: a preset plus per-guard overrides) and is read by `propose_action`, by `src/meetings.ts` when a meeting is booked, and by the `accept` shortcut.
When the policy does not gate an action, `executeDirectly` runs the very same executor the Ledger path would run, in a transaction, at once; the engine's result says "Done at once", the persona tells the owner, and the task ends on that line (like a proposal does) so the model cannot embellish it.
When it does gate one, nothing changes from the original design: the action waits on the device.
A side whose policy gates meetings gets their half of a booked meeting as a `CAL` on their Ledger (with `With @friend`) at booking time; the other side's calendar is written at once and they are told the friend still has to confirm.

Google Calendar (`src/calendar/google.ts`) is a per-owner mirror, not a second source of truth.
An owner connects it through a one-time link (`/google/connect/<token>`, the OAuth state) that lands on `/google/callback`; the refresh token is stored on the account.
Reads merge Google's events with AgentSign's own table (rows already mirrored come back from Google; the rest are listed from the table), and fall back to the table with a warning when Google is unreachable.
Friends' agents get busy intervals only; all-day, "free" and declined Google events do not count.
Google is only ever written with rows AgentSign's own table already holds (a `CAL` the owner approved, or a meeting both friends said yes to): `afterEvent` pushes the row with an id derived from it (`agentsign<salt><row id>`), so a retry hits 409 instead of duplicating.

There is one `propose_action(code, fields)` tool for everything the Ledger may gate. The app turns it into a pending approval, appends "Please confirm on your Ledger: ..." plus the approval link to the persona's reply (one text), calls `deviceManager.sign`, verifies, executes through `src/executors.ts`, logs the action with its signature or transaction hash, and texts the outcome. The outcome is stored in the history so the next turn can answer "did it go through?".

A stranger (no account) with a usable username gets a fixed welcome offering `@<username>` as the tag; `go` (or any plain yes) runs onboarding with it and `link` sends the sign-up page, both without a model call.
Anything else goes to a restricted Jarvis whose only tools are `choose_tag` and `send_link`, and every reply steers back to setup.
Onboarding then runs deterministically: exactly one unbound Ledger on the Mac's USB, else (Ethereum mode) the sign-up page, and `ACC` is the address verification on the device.

`message_agent` runs a *peer turn* on the other account's engine with only `get_free_busy`, for questions like "when is yadu free". Non-friends get a refusal string without a model call.

Meetings between friends (`src/meetings.ts`) skip the Ledger on purpose: nothing about them is risky, and a Ledger prompt on each side made the demo feel like paperwork.
`propose_meeting(tag, title, from, to, duration_minutes, preferred)` takes the window the owner is open to ("around 9" is 08:30-10:00 with `preferred` 09:00; "any time 9 to 5" is 09:00-17:00), reads both calendars' free/busy, and offers the slot nearest the preferred time (else the earliest) that is free for both.
One `meetings` row holds the slot on the table, the asker's window, who offered the slot and whose answer it waits for; one open meeting per pair, a new proposal replaces the old one.
The friend gets one text and answers in their own words: a plain `yes` or `no` is a deterministic shortcut in `src/app.ts` (no model call); anything else goes through Jarvis to `answer_meeting(tag, yes | no | another time, when)`.
Yes books it: an event on each side's calendar (`with_tag` naming the other) in one transaction, then the Google mirror for each, then one text to each side.
A counter inside the asker's window books at once (the asker already said any time there works); a counter outside goes back to the asker, who answers the same way.
Busy times are checked again right before booking, so a slot that filled up in between is refused instead of double-booked.
The agents' exchange is written to the peer thread (free/busy only), and every step is a system note in both histories so "did yadu answer?" is answered from memory.

`send_note(tag, text)` is how friends talk to each other through their agents: "send gabe a thank you note" becomes a text from the friend's own Jarvis, `@matt says: Thanks for lunch!`, delivered at once (a note moves no money and touches no calendar, so there is nothing to sign).
The note is also stored as a system note in the recipient's chat history, so their next turn can quote it or answer it with a note back.
Only accepted friends can be reached; the engine composes the note in the owner's words from what they asked.

## Executors (run only after a verified signature)

- `ACC`: create account (tag, pubkey, the handle the sign-up came from), balance starts at $250.00 demo money; on Telegram the app then stores the username and display name on it.
- `PAY`: debit sender, credit recipient (recipient must exist), log a transaction, text the recipient.
- `CAL`: the owner's own event (no `With`; meetings with friends never come here): insert it, then mirror it to their Google Calendar when one is connected (a Google failure is a line in the text, not a failed action).
- `FRQ`: friendship row `pending`, text the target's handles.
- `FAC`: friendship `accepted`, text both.
- `DEL`: in one transaction remove the account, its handles, friendships, meetings, notes, events, chat history and peer threads; the actions log and transactions stay, detached from it (demo balances are forfeited). The person is a stranger again and can sign up anew.
- `BUY`: the signed transfer to the treasury is already broadcast (like an Ethereum-mode `PAY`); the executor only texts "Paid ... I'll place the Amazon order as soon as Base confirms it". `src/purchases.ts` takes it from there (below).
- `EAT`: the same for food: the transfer is already broadcast and the executor texts "Paid ... I'll place the DoorDash order as soon as Base confirms it".
  The EAT instance of `src/purchases.ts` takes it from there.

## Buying on Amazon (`src/purchases.ts`, `src/merchant.ts`, `src/amazon/`, `src/treasury.ts`)

Amazon takes cards, not crypto, so the operator fronts the purchase: owners pay USDC on Base to the operator's **treasury** address, and the server orders the item on the operator's own Amazon account with the card saved there.
With a key on the server the treasury is the escrow: it holds the USDC from the Ledger's signature until Amazon confirms the order, and sends it back when nothing was ordered.
It is custodial (a wallet the server holds the key of), not a smart contract; the on-chain record is the two token transfers.
The deployed configuration is a receive-only treasury (`TREASURY_ADDRESS`, no key), so there the escrow is a hold at an address and refunds are sent by hand.

```
owner: "buy me trident gum"
  engine: search_amazon ──► merchant.search          (anonymous read of amazon.com)
  engine: propose_action BUY Item <asin>
          ──► merchant.prepare: Buy Now, read the exact order total, leave   (nothing held)
          ──► cap: total <= PURCHASE_LIMIT_USD (default $20), else an error the model reports
          ──► money.transferUsdc: USDC units for the total, the USDC balance, gas in ETH, Ledger's token descriptor
          ──► purchases row "proposed"; BUY on the Ledger (the Ethereum app clear-signs "4.35 USDC" to the treasury)
  signed  ──► tx broadcast, row "funded", text "Paid ..."
  receipt ──► Base confirms (3 tries of 2 min; failed: "cancelled"; still pending: "review")
          ──► row "ordering"            (the checkpoint: written before the side effect, never re-run)
          ──► merchant.confirm: Buy Now again, same item, same total, Place your order
                ordered      ──► row "ordered", text "Ordered on Amazon: ..., Order 111-..."
                no_purchase  ──► row "refunding", treasury pays the USDC back (gas on the treasury), "refunded", text with the basescan link
                uncertain    ──► row "review", the owner and the operator are texted; nothing is retried or refunded
```

Rules the code enforces whatever the model asks: the cap is checked on the checkout total (item, shipping, tax) at `prepare` and again at `confirm`; the card is charged only after the owner's ETH is confirmed on Base; a refund goes out only on a definite no-purchase (`merchant.confirm` may answer `no_purchase` only when it is certain nothing was ordered, and once the order button was pressed it answers `ordered` or `uncertain`); `ordering` and `refunding` rows found at startup go to `review` instead of being redone, so a crash can neither order nor refund twice.
`funded` rows found at startup are resumed (the receipt check and the checkpoint make that safe); `proposed` rows are cancelled with the stale actions.

The `Merchant` contract (`src/merchant.ts`) is `search`, `prepare` (quote without ordering), `confirm` (order a quote; re-checks item and total, a changed total is a `no_purchase`).
`demoMerchant()` is an in-memory store for tests and for trying the flow with the dev channel (`AMAZON_MERCHANT=demo`).
The treasury can be receive-only (`TREASURY_ADDRESS`, the deployed default `0xf8381484CD2639618c690572aB35ff65E4bd7C5e`): refunds then throw and the purchase is flagged to the operator.
`src/amazon/browser.ts` is the real one: Playwright Chromium with the operator's exported Amazon session (`pnpm amazon:login` writes it; `AMAZON_STORAGE_STATE` carries it), **Buy Now** only (never the cart, which may hold the operator's own things), exactly one item on the checkout page or it stops, screenshots on every failure in `data/amazon-shots/`, and `AMAZON_DRY_RUN=1` to go through everything but the order button.
Its checkout selectors are built from Amazon's known layouts and still need a signed-in dry run against the real account.

Texts to the owner, one per step: the reply with the confirm prompt (item, total all in, USDC, treasury address, where it ships, and "comes back to you if the order doesn't go through" only when the treasury can refund), "Paid ..." with the basescan link once broadcast, then "Order confirmed on Amazon ..." or "Amazon didn't take the order (...), your USDC is on its way back" or "I couldn't tell whether Amazon took the order ...".
Outcomes are also system notes in the owner's history, so the next turn can answer "did it ship?".
The operator (`OPERATOR_TAG`) is texted only for `review` and `refund_failed`.
Everything ships to the Amazon account's default address (`PURCHASE_SHIPS_TO` says so to buyers); an order is one unit of one item.

## Ordering food on DoorDash (`src/food/`, `src/purchases.ts`, `src/treasury.ts`)

Food runs through the same escrow as Amazon: the owner pays USDC on Base to the operator's treasury with an `EAT` action on their Ledger, and once Base confirms, the server places the order on the operator's own DoorDash account.
`src/purchases.ts` is one state machine for both stores, one instance each; a `PurchaseWording` holds what differs (the action code, the id the model passes, the Ledger's fields, the texts), and each instance only touches the purchase rows of its own `code` (`purchases.code`, `BUY` or `EAT`).
So every rule of the Amazon section holds here unchanged: the cap at prepare and at confirm, the order only after Base confirms, a refund only on a definite no-purchase, the `ordering` checkpoint, and the same restart recovery.

```
owner: "hey can you deliver me a burrito bowl"
  engine: (no address in the facts) ask; set_delivery_address with the one the owner gives   (accounts.delivery_address)
  engine: search_doordash "burrito"  ──► provider.searchRestaurants(query, address)
  engine: doordash_menu <store_id>   ──► provider.menu: item ids, names, prices
  engine: quote_doordash <store_id> [{item_id, quantity}] tip 15%
          ──► provider.quote: food, fees, tax, tip, total, ETA     (nothing ordered)
          ──► cap: total <= FOOD_LIMIT_USD (default $40), else an error the model reports
          ──► a draft in memory for 20 minutes under a short quote_id (q1a2b3c), bound to this owner
  engine: propose_action EAT Order <quote_id>
          ──► prepare: provider.quote again (today's total), the cap again, money.transferUsdc
          ──► purchases row "proposed" (code EAT); EAT on the Ledger (the Ethereum app clear-signs "25.82 USDC" to the treasury)
  signed  ──► tx broadcast, row "funded", text "Paid ... I'll place the DoorDash order as soon as Base confirms it"
  receipt ──► Base confirms ──► row "ordering" (the checkpoint)
          ──► confirm: the cap again, provider.confirm: same store, same items, same total, Place Order
                ordered      ──► row "ordered", text "Order placed on DoorDash: ... It arrives at <address> in about 35 minutes."
                no_purchase  ──► refund from the treasury, as for Amazon
                uncertain    ──► row "review", the owner and the operator are texted
```

`src/food/provider.ts` is the seam: `FoodProvider` with `searchRestaurants`, `menu`, `quote` (an exact `FoodQuote` without ordering) and `confirm` (an `Outcome` with the order id and the ETA, or `no_purchase` only when certain nothing was ordered, or `uncertain`).
`src/food/food.ts` presents a provider as a `Merchant` for `createPurchases` (`prepare(quoteId)` prices the draft again, `confirm(quote)` checks the cap and places it) and adds the engine's tools on top.
A draft lives in memory only: after a restart the model quotes again.
A draft belongs to the owner who asked for it, so nobody can pay for another owner's order or send food to their address.

DoorDash has no public consumer ordering API, so there are three providers behind `FOOD_PROVIDER` (off unless set; Ethereum mode and a treasury are required):

- `demo` (`src/food/demo.ts`): an in-memory DoorDash with five restaurants, real-looking menus and DoorDash-style fees (delivery fee, a 15% service fee of at least $3.00, 8.625% tax, the tip).
  Every order goes through and nothing is bought.
  It is the deployed default, so the whole flow works today.
- `browser` (`src/food/browser.ts`, `src/food/pages.ts`): doordash.com in Playwright Chromium, signed in as the operator (`pnpm doordash:login` writes the session; `DOORDASH_STORAGE_STATE` carries it).
  Cloudflare refuses plain HTTP, so a real browser with a real session is the only way in without an API.
  One operation at a time; the cart must be empty before the driver fills it, and the checkout must show exactly one cart with exactly the quoted items at the delivery address, or it stops; the driver empties only a cart it filled; screenshots on every failure in `data/doordash-shots/`; `DOORDASH_DRY_RUN=1` goes to "Place Order" and stops; the button is pressed at most once, and after the press the outcome is `ordered` (the id from `/orders/<id>/`) or `uncertain`.
  The selectors are written from DoorDash's known layout (search at `/search?query=`, stores at `/store/<slug>-<id>/`, the item modal's "Add to cart", the cart drawer, `/checkout/` with "Place Order") with regex fallbacks over the visible text, and they have not been run against a signed-in session yet: the first step is a signed-in dry run against the real account.
- `cli` (`src/food/cli.ts`): DoorDash's `dd-cli` beta (waitlist, macOS, US and Canada) driven over `child_process` with `--json`, the binary at `DOORDASH_CLI`.
  It is built against the announced beta syntax (`auth status`, `search --query --max-results --json`, `cart add --item-id --quantity`, `cart show --json`, `checkout --confirm`) and is not yet verifiable; the menu, address, tip and cart-clear commands are guesses in the same style.
  The command table at the top of the file is the only place the syntax lives, so adjusting it is the whole job when the docs land.
  Every reply is parsed defensively, and the same cart and checkout rules apply.

Engine tools, only where food ordering is set up: `set_delivery_address` (only an address the owner gives as their own), `search_doordash`, `doordash_menu`, `quote_doordash`, and `list_purchases` (both stores in one list).
Without an address, search and quote return an error that tells the engine to ask for one.
The persona tells the same three-step story as for Amazon: the Ledger, the payment lands, the order is placed with its ETA; it says the food is on its way only once the system note exists.

`EAT` fields on the Ledger and the approval page: `From Chipotle Mexican Grill`, `Order 1x Burrito Bowl, 2x Chips`, `Deliver 1 Market St Apt 5, San Francisco` (the street and the city), `Total $25.82` (food, fees, tax and tip), `USDC 25.82`, `To 0x...` (the treasury).
The texts, one per step: the reply with "Please confirm on your Ledger: Order food on DoorDash: <restaurant>, <items>, $25.82 all in, delivered to <address> in about 25 minutes. That is 25.82 USDC to the AgentSign treasury ..." (plus "it comes back to you if the order doesn't go through" only when the treasury can refund), "Paid ...", then "Order placed on DoorDash ... It arrives at <address> in about 25 minutes." or the refund or review text.
The knobs: `FOOD_PROVIDER`, `FOOD_LIMIT_USD` (default 40), `DOORDASH_STORAGE_STATE` or `DOORDASH_STORAGE_STATE_PATH`, `DOORDASH_DRY_RUN`, `DOORDASH_CLI`; the treasury and `OPERATOR_TAG` are shared with Amazon.

## Channels

`Channel.start(onMessage)` delivers direct messages (on Telegram with the sender's `username` and `name`); `Channel.send(handle, text)` sends.
`CHANNEL` picks one: `photon` when `SPECTRUM_PROJECT_ID` is set, else `telegram` when `TELEGRAM_BOT_TOKEN` is set, else `imessage`.
`src/index.ts` writes the choice back to `CHANNEL`, and `src/agent/bot.ts` reads it to word the prompts: which app the chat is in, how a friend joins ("text Jarvis at +1... on iMessage" or "open @bot on Telegram and press Start"), and where a link lands.

The Photon channel (`src/channels/photon.ts`, the deployed default) is iMessage on Photon's hosted service through Spectrum (`@spectrum-ts/core` and `@spectrum-ts/imessage`).
Nothing runs on a Mac: the server holds one outbound stream of messages from Photon's cloud with the project's `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET`, and sends through it.
Jarvis lives on one of Photon's shared lines; `PHOTON_NUMBER` is that number as Jarvis tells people.
A shared line may only text a number after that number has texted the line first, and it opens about 50 new conversations a day.
A send that the line refuses comes back as a plain error ("they have to text Jarvis at <number> first").
Only inbound 1:1 messages reach the app; group chats, tapbacks, Jarvis's own sends and empty rows are dropped.
A photo and its words arrive as one Spectrum group and become one message; image attachments are written to `data/photon`.
Per sender the messages keep their order, and no turn waits for another person's.
Each person's chat id is kept in the `settings` table (`photon_space:<handle>`), so after a restart Jarvis can still text someone; a handle with no chat yet gets one from `space.create`.
Typing indicators, tapbacks (the app's thumbs up) and read receipts work here; all three are best effort.
If the stream ends or fails, the channel reconnects with backoff.

The Telegram channel is a bot that long-polls the Bot API (`TELEGRAM_BOT_TOKEN`); `TELEGRAM_BOT_USERNAME` is how Jarvis tells people to find it.
The local iMessage channel is Photon's `@photon-ai/imessage-kit` on a Mac (reads `~/Library/Messages/chat.db`, sends through Messages.app).
It needs Full Disk Access and Automation for the terminal that runs it; only Matt can grant those, and nothing in tests may touch Messages.app or chat.db.
The dev channel is an HTTP server (`POST /dev/message`, `GET /dev/outbox`) plus a REPL so the whole flow can be exercised with Speculos and no phone.

## Phone calls (`src/voice/`, `src/phone.ts`)

Owners can call Jarvis on a Twilio number (`voice/TWILIO.md` has the setup).
Twilio POSTs the call to `/twilio/voice` (signed with the account's auth token, checked in `src/voice/twilio.ts`); the TwiML answer connects the call's audio to the websocket `/twilio/media` with a one-time token naming the caller, so a stream can only claim a number the signed webhook saw.
The media stream (G.711 mu-law) is piped both ways into one OpenAI realtime session (`src/voice/session.ts`) configured for `audio/pcmu`, with server VAD and caller transcription; a barge-in clears Twilio's playback buffer and truncates the model's last item to what the caller heard.
The session's tools are the engine's own (`engineTools`), plus `end_call`: a call runs exactly the harness a text runs, so read-only tools run at once and anything for the Ledger becomes an approval whose text and link land in the owner's chat with Jarvis (iMessage or Telegram); the session tells the caller the outcome if it lands during the call.
Two more tools belong to the call itself (`src/voice/chat.ts`): `text_owner` sends a plain text into the owner's chat (an address, an order number, a link; the call never reads those aloud) and stores it in the chat history, and `look_at_chat` reads the latest texts and photos of the chat, running the engine on a photo with the call's own hooks, so "look at this receipt and pay gabe back" on a call becomes a PAY approval in the chat.
The transcript is stored as a system note in the chat history when the call ends.
The same session drives the older xAI realtime path (`src/voice/webhook.ts`, `provider: "xai"`), and `pnpm voice:chat` types to it in text mode.

Identity is the caller ID, looked up as a handle.
On iMessage the account's handle is already the owner's phone number, so a call from it is the owner with nothing to link.
A Telegram account's handle is its Telegram id, so the owner links their phone number once (`src/phone.ts`): by telling Jarvis the number (`link_phone`), or by calling from it: an unlinked caller hears a four-digit code, texts it to Jarvis (a deterministic shortcut in `src/app.ts`, no model call), and the live call switches to the owner's tools.
An iMessage owner can link another number (a work phone) the same way.
Linked numbers are secondary rows in `handles` (unique, so a number belongs to one account); the Phone line in the owner facts lists them and the number to call.
Hidden caller IDs are declined with a spoken line.

## Non-goals

No smart-contract escrow for purchases (the treasury is a wallet the operator controls; the refund path is code, not a contract), no buying elsewhere than Amazon and DoorDash (food), no Amazon delivery to anywhere but the operator's own address (food goes to the address the owner saved), no DoorDash API until DoorDash ships one (the providers are a demo, a browser driver and the dd-cli beta), no two-way Google Calendar sync (Google events are read and AgentSign events are mirrored there; edits made on Google are not pulled back into the table), no multi-process agent federation, no Flex/Stax UI, no tokens other than ETH and USDC yet. Keep every file short and obvious.
