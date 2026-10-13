# Jarvis

Jarvis is a personal agent.
You send it a text message on iMessage, or you call it on the phone.
Jarvis can send money, buy items, order food and manage your calendar.
Your Ledger must sign each action before the action occurs.

## The problem

An agent that holds your key can be tricked.
A prompt injection or a wrong address can empty the account.
A spending limit in software does not help, because the same software can be tricked.

Jarvis has no key.
Jarvis has one tool only: `propose_action`.
This tool makes a proposal and waits for your signature.
The proposal shows on your Ledger with the exact amount, the recipient and the purpose.
Nothing occurs until you approve the proposal on the device.

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

The Ledger shows each action in the Ethereum app:

- A payment is a transfer on Base. The device shows the amount, the address and the fees.
- An Amazon purchase or a food order is a USDC transfer to the treasury. The device shows "4.35 USDC" and the address.
- A calendar event, a friend request or an account change is a short message. The device shows the full message.

The server compares the signature with the address of your account.
Each action has a random id, so one signature is valid for one action only.
If you reject the proposal, the server cancels it.

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

You can call Jarvis on the phone.
Jarvis speaks with the same tools a text message has.
Jarvis knows you by your caller ID.
Each Ledger action goes to your chat as usual.
Jarvis tells you on the call when you approve it.

## The account page

Each owner has a web page.
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
The engine cannot move money, write to a calendar or add a friend.
It can only propose.

## Technology

- Ledger Nano S Plus with the Ethereum app, clear signing for transactions and messages.
- Base mainnet for USDC and ETH.
- iMessage through Photon, phone calls through Twilio and OpenAI's realtime model.
- Grok from xAI as the agent.
- Google Calendar, Amazon and DoorDash as connected services.

`DESIGN.md` has the full design.
