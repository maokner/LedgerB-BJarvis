# Jarvis

Jarvis is a personal agent on Telegram.
You can also call it on the phone.
It can send your money, manage your calendar and buy things for you.
It can also order food for delivery.
Your Ledger must sign each risky action before the action occurs.

## What it does

You send text messages to Jarvis, for example "send $5 to gabe for lunch", "find 30 minutes with yadu tomorrow" or "buy me a pack of trident gum".
For food, send "can you deliver me food" or "get me a burrito bowl from chipotle".
The agent is Grok, in two layers: a persona that speaks with you and an engine that does the work.
The engine makes a proposal for an action.
The action shows on your Ledger with its exact fields.
Nothing occurs until you approve the action on the device.
If you reject the action, the server cancels it.

The actions are: send ETH on Base, buy an item on Amazon with USDC, order food on DoorDash with USDC, add a calendar event (with a copy on Google Calendar), send or accept a friend request, and create or delete the account.
The agents of two friends can speak with each other to find a meeting time and to pass notes.

You can also call Jarvis on a Twilio number and speak.
OpenAI's realtime model speaks as Jarvis with the same tools a text has.
The call is recognised by your caller ID after you link your number once.
Each action for the Ledger goes to your Telegram chat as usual, and Jarvis tells you on the call when you approve it.
See `voice/TWILIO.md`.

## The Ledger

The agent has no tool that can move money, write to a calendar or add a friend.
It has one tool, `propose_action`, which makes an approval that waits for a signature.
The server changes the proposal into a request that the Ethereum app on the Ledger can show and sign:

- A payment is an EIP-1559 transfer on Base. The device shows the amount, the address and the fees.
- An Amazon purchase is a USDC transfer to the treasury of the operator. The server first gets the token descriptor from Ledger, so the device shows "4.35 USDC" and the address, not a blind-signing request.
- A food order is the same USDC transfer to the treasury. The approval page also shows the restaurant, the items and the delivery address.
- All other actions (calendar, friends, account) are a personal message, for example `AgentSign / Add to calendar / Title: ... / id: ...`. The device shows the full message.

The server compares the signature with the address of your account before it does the action.
Each action has a random id, so a signature is valid for one action only.
An account is a Telegram user and a Ledger address.
At sign-up, you verify the address on the device.

The Ledger does not have to be connected to the server.
Each approval message has a link to a web page.
The page speaks to the Ledger through WebHID in Chrome, shows the same action and sends the signature to the server.

Amazon: the owner pays USDC to a treasury address, and the server buys the item with the Amazon account and card of the operator.
The limit is $20 for each order.
The deployed build uses a treasury with no key on the server.
The refund path is available with `TREASURY_PRIVATE_KEY`.

Food: Jarvis finds the restaurant and the items and gets the exact total, with fees, tax and tip.
You approve the USDC payment to the treasury on your Ledger.
When Base confirms the payment, the server orders on the DoorDash account of the operator and tells you the time of arrival.
The limit is $40 for each order.
DoorDash has no public API for orders.
The deployed build uses a demo DoorDash: the flow is complete, but no food comes.
The code also has a browser driver for doordash.com and an adapter for the DoorDash `dd-cli` beta.
Both need a test with a real DoorDash account before they place real orders.

## Codebase

```
src/types.ts, actions.ts     the Action contract and its canonical bytes
src/approvals.ts             propose -> Ledger -> verify -> execute -> send the result
src/executors.ts             what each action does after the signature
src/device/                  the Ledger: Ethereum app over USB, signature verification
src/web/                     the approval page (WebHID in the browser)
src/agent/                   persona, engine, tools, the xAI client
src/channels/                Telegram (and a local dev channel for tests)
src/voice/, src/phone.ts     phone calls: Twilio audio into OpenAI's realtime model, linked phone numbers
src/money.ts, chain.ts       ETH and USDC on Base
src/purchases.ts, merchant.ts, amazon/, treasury.ts   purchases on Amazon
src/food/                    food orders on DoorDash: the provider seam, a demo, a browser driver, dd-cli
src/calendar/, meetings.ts   calendars and meetings between friends
src/policy.ts                which actions need the Ledger, for each owner
src/db.ts                    SQLite
device-app/                  a custom Nano S Plus app for the offline demo mode
```

`DESIGN.md` has the full design: the action encoding, the device protocol, the purchase states and the agent harness.

## Run it

```sh
pnpm install
cp .env.example .env     # XAI_API_KEY, TELEGRAM_BOT_TOKEN, PUBLIC_URL (https, for the approval page)
                         # calls: OPENAI_API_KEY, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER (voice/TWILIO.md)
                         # food: FOOD_PROVIDER=demo, or browser after pnpm doordash:login
pnpm start               # Telegram
pnpm dev                 # local dev channel, no phone
pnpm test
```

To deploy to Fly.io, run `scripts/fly-deploy.sh`.
The live bot is `agentsign-jarvis`.
To point the Twilio number at it, run `scripts/twilio-setup.sh`.
