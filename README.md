# Jarvis

Jarvis is a personal agent on iMessage.
You can also call it on the phone.
It can send your money, manage your calendar and buy things for you.
It can also order food for delivery.
Your Ledger must sign each risky action before the action occurs.

Jarvis uses a shared iMessage number from Photon.
Jarvis can send a message to a person only after that person sends a message to Jarvis.
Jarvis can also run as a Telegram bot.

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
The call is recognised by your caller ID.
On iMessage, your phone number is your account, so a call from it is recognised at once.
On Telegram, you link your number one time.
Each action for the Ledger goes to your chat with Jarvis as usual, and Jarvis tells you on the call when you approve it.
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
An account is an iMessage phone number or email (or a Telegram user) and a Ledger address.
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
src/web/                     the approval page and the account page (WebHID in the browser), one theme
src/agent/                   persona, engine, tools, the xAI client
src/channels/                iMessage on Photon, Telegram, and a local dev channel for tests
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
cp .env.example .env     # XAI_API_KEY, SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, PHOTON_NUMBER, PUBLIC_URL (https)
                         # calls: OPENAI_API_KEY, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER (voice/TWILIO.md)
                         # food: FOOD_PROVIDER=demo, or browser after pnpm doordash:login
pnpm start               # iMessage on Photon (CHANNEL=telegram for Telegram)
pnpm dev                 # local dev channel, no phone
pnpm test
```

The Photon project id and secret are in the Photon dashboard, in the project settings.
`PHOTON_NUMBER` is the number that people send messages to.

To deploy to Fly.io, run `scripts/fly-deploy.sh`.
The live app is `agentsign-jarvis`.
To point the Twilio number at it, run `scripts/twilio-setup.sh`.

## The account page

Owners have a page for their account at `PUBLIC_URL/`.
They sign in with their Ledger: the Ethereum app signs a short message, the server recovers the address and finds the account bound to it.
There is no password and no email.
The page shows the connections (the chat, the Ledger, Google Calendar, phone calls, Amazon, DoorDash), with one click to connect Google Calendar or link a number for calls, the Ledger policy with switches, friends, recent activity, what is coming, and a delete button.
Deleting proposes the same `DEL` action the chat would, and the Ledger signs it on the approval page.

The same page is also a static site for Vercel.
`pnpm build:web` writes it to `dist/site`, and `vercel.json` sends `/api`, `/sign` and `/google` to the Fly server.
Put the Vercel origin in `DASHBOARD_ORIGINS` on the server, so the page's requests pass the origin check.
To deploy: `vercel deploy --prod` in this directory, with the project's build settings taken from `vercel.json`.
