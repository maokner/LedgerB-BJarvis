# Jarvis

Jarvis is a personal agent.
You send it a text message on iMessage, or you call it on the phone.
Jarvis can send money, buy items, order food and manage your calendar.
Your Ledger must sign each action that moves money before the action occurs.

## What Jarvis can do

You send a text message to Jarvis.
Examples:

- "send $5 to gabe for lunch"
- "buy me a pack of trident gum"
- "get me a burrito bowl from chipotle"
- "find 30 minutes with yadu tomorrow"

Jarvis can do these actions:

- Send money on Base, as USDC or ETH.
- Buy an item on Amazon.
- Order food on DoorDash.
- Add an event to your calendar, with a copy on Google Calendar.
- Send or accept a friend request.
- Create or delete your account.

Jarvis keeps one delivery address for food and Amazon orders.
Before each order, Jarvis asks "Deliver to <address>?".
You answer yes, or you give a different address.

The agents of two friends can speak with each other.
They can find a meeting time and pass notes.

## How the Ledger protects you

Jarvis has no tool that can move money, write to a calendar or add a friend.
Jarvis has one tool only: `propose_action`.
This tool makes a proposal and waits for your signature.

The server shows the proposal on your Ledger with the exact details.
You see how much, to whom, and for what.
Nothing occurs until you approve the proposal on the device.
If you reject the proposal, the server cancels it.

The Ledger shows each action in the Ethereum app:

- A payment is a transfer on Base. The device shows the amount, the address and the fees.
- An Amazon purchase or a food order is a USDC transfer to the treasury. The device shows "4.35 USDC" and the address, not a blind-signing request.
- A calendar event, a friend request or an account change is a short message. The device shows the full message.

The server compares the signature with the address of your account.
Each action has a random id, so one signature is valid for one action only.

The Ledger does not have to connect to the server.
Each approval text has a link to a web page.
The page speaks to the Ledger through WebHID in Chrome.
It shows the same action and sends the signature to the server.

## Purchases

For an Amazon order, you pay USDC to the treasury.
The server then buys the item on Amazon and ships it to your address.
The limit is $20 for each order.

For a food order, Jarvis finds the restaurant and the items.
Jarvis gets the exact total with fees, tax and tip.
You approve the USDC payment on your Ledger.
When Base confirms the payment, the server orders on DoorDash and tells you the arrival time.
The limit is $40 for each order.

## Calls

You can call Jarvis on a Twilio number.
OpenAI's realtime model speaks as Jarvis, with the same tools a text has.
Jarvis recognizes you by your caller ID.
On iMessage, your phone number is your account, so a call from it is known at once.
Each Ledger action goes to your chat as usual.
Jarvis tells you on the call when you approve it.
See `voice/TWILIO.md`.

## The account page

Each owner has a page at `PUBLIC_URL/`.
You sign in with your Ledger.
There is no password and no email.
The Ethereum app signs a short message.
The server recovers the address and finds your account.

The page has these sections:

- Home: your balance, your connected services and the first steps.
- Activity: each action Jarvis proposed, and what occurred to it.
- Connections: the chat, the Ledger, Google Calendar, phone calls, Amazon and DoorDash.
- Ledger policy: which actions need the device. Money always needs the device.
- Friends: your friends and their requests.

## The agent

The agent is Grok, in two layers.
A persona speaks with you.
An engine does the work and makes the proposals.

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
src/food/                    food orders on DoorDash
src/calendar/, meetings.ts   calendars and meetings between friends
src/policy.ts                which actions need the Ledger, for each owner
src/db.ts                    SQLite
device-app/                  a custom Nano S Plus app for the offline demo mode
```

`DESIGN.md` has the full design.
It describes the action encoding, the device protocol, the purchase states and the agent harness.

## Run it

```sh
pnpm install
cp .env.example .env     # XAI_API_KEY, SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, PHOTON_NUMBER, PUBLIC_URL (https)
                         # calls: OPENAI_API_KEY, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER (voice/TWILIO.md)
pnpm start               # iMessage on Photon (CHANNEL=telegram for Telegram)
pnpm dev                 # local dev channel, no phone
pnpm test
```

Jarvis uses a shared iMessage number from Photon.
The Photon project id and secret are in the Photon dashboard, in the project settings.
`PHOTON_NUMBER` is the number that people send messages to.
Jarvis can send a message to a person only after that person sends a message to Jarvis.
Jarvis can also run as a Telegram bot.

## Deploy

To deploy to Fly.io, run `scripts/fly-deploy.sh`.
To point the Twilio number at the server, run `scripts/twilio-setup.sh`.

The account page is also a static site on Vercel.
`pnpm build:web` writes it to `dist/site`.
`vercel.json` sends `/api`, `/sign` and `/google` to the Fly server.
Put the Vercel origin in `DASHBOARD_ORIGINS` on the server, so the page's requests pass the origin check.
To deploy the page, run `vercel deploy --prod` in this directory.
