# AgentSign

AgentSign is a Telegram agent, Jarvis, whose risky actions are clear-signed on a Ledger.
You message the bot like you would message a friend: "send $5 to @yadu", a photo of a receipt with "pay yadu back for lunch", "add @yadu as a friend", or "set up a 30 minute meeting with yadu tomorrow afternoon".
The agent (xAI Grok) understands the request, but it can only propose an action.
The action shows up on your Ledger Nano S Plus as plain text (Send money, To @yadu, Amount $5.00), and nothing happens until you approve it with both buttons.

Each person's account is their Telegram account plus their Ledger: the Telegram user id identifies them, the Ledger's address approves for them, and their Telegram @username is their tag by default.
Signing up is: open the bot, press Start, plug in the Ledger and say `go` (or say `link` for a page that works from any computer).
Friends' agents find a meeting slot together, sharing only free/busy times; the friend confirms it by replying to a text, and it lands on both calendars with no Ledger involved (nothing risky happens there).
It is a hackathon build: one Node process, one SQLite file, demo money, a small Rust Ledger app, and a dev channel plus the Speculos emulator so the whole flow runs without a phone or a physical device.
See [DESIGN.md](DESIGN.md) for the architecture.

## Prerequisites

- Node 22 or newer and pnpm.
- Docker, for the Speculos emulator and for building the Ledger app.
- A Ledger Nano S Plus for the real thing (optional; Speculos is enough for development).
- An xAI API key as `XAI_API_KEY` in `.env` at the repo root or in `~/.grok/.env`.
- For the Telegram channel: a bot token from BotFather (see [Telegram setup](#telegram-setup)).
- For the iMessage channel: a Mac signed into Messages (see [iMessage setup](#imessage-setup)).

```sh
pnpm install
cp .env.example .env   # then set XAI_API_KEY
```

## Quick start (dev channel and Speculos, no phone needed)

1. Build the Ledger app once, as described in [device-app/README.md](device-app/README.md).
   It produces `device-app/target/nanosplus/release/agentsign`.
2. Start two emulators: `scripts/speculos.sh`.
   It starts "matt" (APDU port 9999, screen at http://127.0.0.1:5000) and "yadu" (APDU port 9998, screen at http://127.0.0.1:5001).
   Open both URLs in a browser: the Speculos web UI shows the device screen and has clickable left, right and both buttons.
   Stop them later with `scripts/speculos.sh stop`.
3. Start the server with the dev channel: `pnpm dev`.
   It listens on http://127.0.0.1:7777 and, in a terminal, opens a chat prompt `you (+15550000001)> `.
4. Text the agent, either in that prompt or from a second terminal with `pnpm demo:chat`:

```sh
pnpm demo:chat --as +15550000001 'hi'
pnpm demo:chat --as yadu 'hi'
```

Use single quotes around texts that contain `$`, otherwise the shell eats `$5`.
`pnpm demo:chat` prints the agent's replies, then keeps printing everything the agent sends (to anyone) for 10 seconds, which is where approval outcomes show up.
Options: `--as <handle|matt|yadu>`, `--image <path>` (repeatable), `--wait <seconds>`, `--url <dev channel url>`.

The dev channel simulates two people:

| Who | Handle | Emulator |
|---|---|---|
| Matt | `+15550000001` | "matt", http://127.0.0.1:5000 |
| Yadu | `+15550000002` | "yadu", http://127.0.0.1:5001 |

REPL commands: `/as matt`, `/as yadu` or `/as +1555...` switches the simulated sender, `/image /path/receipt.jpg` attaches a photo to your next message, `/outbox` prints what the agent sent recently, `/help` lists the commands.
Every text the agent sends is printed as `agent -> +15550000001 (Matt): ...` as it goes out.

On a Nano S Plus, approving means stepping through the review with the right button until **Approve**, then pressing both buttons.
**Reject** works the same way.

## Demo script

The lines below are Telegram messages that Matt (@mokner) and Yadu send to the bot (`TELEGRAM_BOT_USERNAME`, for example @jarvis_agentsign_bot).
With the dev channel, send them with the REPL or `pnpm demo:chat`; dev senders have no username, so Jarvis asks for a tag instead and the device shows `Phone <handle>`.

1. **Matt signs up.**
   Matt opens the bot and presses **Start**.
   Jarvis introduces itself first (`INTRO` in `src/agent/persona.ts`: an always-on assistant on its own computer, what it can do today, and that anything risky waits on the Ledger), then offers his Telegram username as his tag (in agentsign mode it says "AgentSign" instead of the Ethereum app):
   `You're @mokner on Telegram, so that's your tag here. To bind your Ledger: plug it into the AgentSign Mac with the Ethereum app open and say 'go', or say 'link' and I'll send a page that works from any computer.`
   Jarvis answers questions too ("is this safe?"), but every reply steers back to `go`.
   Matt says `go` (any yes works; `@matt` picks a different tag instead).
   Jarvis replies `@mokner it is. Your Ledger now shows 'Verify address'. Approve it there and you're set.`, and the device shows the request with `Tag @mokner` and `Telegram @mokner` (`Telegram id 123456` for someone without a username).
   With no free Ledger on the Mac, or after `link`, Jarvis sends the sign-up page instead (see [Approve from anywhere](#approve-from-anywhere)).
   Matt approves, and Jarvis replies that the account exists.
   Jarvis picks a Ledger that is not bound to an account yet, so with two fresh devices keep an eye on both screens.
2. **Yadu signs up the same way.**
   Matt tells Yadu to open the bot; Yadu presses **Start**, says `go`, and approves on the other device.
3. **Matt pays.**
   Matt texts `send $5 to @yadu for coffee`.
   The agent answers in one text: `Very well: $5 to @yadu for coffee.`, then on the next lines `Please confirm on your Ledger: Send money: To @yadu, Amount $5.00, Memo coffee`.
   Only after that text went out does the device show **Send money**, `To @yadu`, `Amount $5.00`, `Memo coffee`.
   Matt approves; the server verifies the signature, moves the money, and messages both sides (`Sent $5.00 (coffee) to @yadu. Your balance is $245.00.`).
   The recipient needs an account, so with two devices the demo pays @yadu; "gabe" or "@gabriel" works the same once that person has signed up.
4. **Matt pays from a receipt photo.**
   Matt sends a photo of a receipt with `pay yadu back for lunch` (REPL: `/image ~/receipt.jpg`, then the text; CLI: `pnpm demo:chat --image ~/receipt.jpg 'pay yadu back for lunch'`).
   Grok reads the total from the image, the agent texts `Very well: $23.40 to @yadu for lunch.` with the confirm line under it, and the device shows **Send money** with that amount and a `Memo`.
5. **Matt and Yadu become friends.**
   Matt texts `add @yadu as a friend`, and Matt's device shows **Friend request**, `To @yadu`.
   After Matt approves, Yadu gets a message about the request (`To` also accepts a Telegram @username; someone who has not opened the bot yet is told to open it and press Start first).
   Yadu texts `accept @matt` (or just `accept`), and Yadu's device shows **Accept friend**, `From @matt`.
   Now their agents may talk to each other.
6. **Matt books a meeting with Yadu.**
   Matt texts `set up a 30 minute meeting with yadu tomorrow afternoon`.
   Matt's agent reads both calendars (Yadu's as busy times only, never titles) and picks the first afternoon slot free for both.
   Matt gets `Asked Yadu about tomorrow 2:00-2:30. I'll let you know.` and Yadu gets `@matt would like to meet: 'Meeting' Sun Oct 11 14:00-14:30. Any time Sun Oct 11 12:00-17:00 works for Matt. Reply 'yes' and it goes on both calendars, or name another time.`
   Yadu replies `yes`: both calendars get the event (Google too, where connected) and both are texted `... is on both calendars.`
   Or Yadu replies `3 works better`: inside Matt's window, so it is booked at 3 right away; a time outside the window goes back to Matt, who answers the same way.
   No Ledger on either side under the default policy: a meeting moves no money, so the two people's own replies are the approval.
7. **Matt decides what needs his Ledger.**
   Matt texts `what needs my ledger?` and Jarvis answers from his policy: by default money, deleting the account and adding friends; calendar events and meetings just happen.
   `ask my ledger for calendar events too` or `strict` tightens it at once; `relaxed` loosens it. Money always goes to the Ledger.
   Under `strict`, "dentist tomorrow at 9" shows **Add to calendar** on the device again, and a meeting a friend confirms puts `Add to calendar / Title Coffee / When ... / With @yadu` on Matt's Ledger before it lands on his calendar.
8. **Matt checks in.**
   Matt texts `did it go through?` or `thanks!`.
   The agent answers from what it already knows (the outcome notes from the Ledger), with no extra work behind the scenes.

## Telegram setup

The Telegram channel is a bot: the server long-polls the Bot API, so it needs no public URL and no webhook.
Each person is their Telegram account (`tg:<user id>`), and their Telegram username is the default tag at signup.

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
   Name it `Jarvis`, then pick a username that ends in `bot` (for example `jarvis_agentsign_bot`).
2. Copy the token BotFather replies with into `.env`:

```sh
TELEGRAM_BOT_TOKEN=123456789:AA...
```

3. Optional: `/setuserpic` in BotFather gives the bot a profile photo.
   `/setprivacy` is not needed: the agent only answers private chats and ignores groups.
4. Start the server (Telegram is the default channel once `TELEGRAM_BOT_TOKEN` is set):

```sh
CHANNEL=telegram pnpm start
```

5. Open the bot in Telegram (the server logs its `https://t.me/...` link) and press **Start**.

A bot cannot message someone first.
Friends must each open the bot and press Start once before it can text them (for a payment or a friend request); until then a send to them fails with an error that says so.
Photos and image files are downloaded into `data/telegram`, and replies longer than 4000 characters are split into several messages.
Only one process may poll a bot token at a time.

## iMessage setup

The iMessage channel uses [Photon's imessage-kit](https://github.com/photon-hq/imessage-kit): it reads `~/Library/Messages/chat.db` and sends through Messages.app on the Mac that runs the server.

1. Sign in to Messages on that Mac with a dedicated Apple ID or phone number for the agent.
   People text that address.
   Do not use your personal account: the agent reads every direct message that arrives and answers it.
2. Give **Full Disk Access** to the app that runs `pnpm start` (Terminal, iTerm, Warp, VS Code or Cursor).
   Open System Settings > Privacy & Security > Full Disk Access, click +, add the app, then quit and reopen it.
   Without it the server stops at startup with an error that names this setting.
3. Give **Automation** access to control Messages.
   macOS asks the first time the agent sends a text ("Terminal wants to control Messages"); click Allow.
   If it was denied, open System Settings > Privacy & Security > Automation, find the app, and turn on Messages.
   A send that fails with error -1743 means this permission is missing.
4. Keep Messages.app open.
5. Start the server with the iMessage channel and real devices:

```sh
CHANNEL=imessage DEVICES=hid pnpm start
```

The channel only handles direct messages: group chats, tapbacks, Focus auto-replies and your own sent messages are ignored.
Photos wait up to 10 seconds for the download to finish, and replies longer than 1500 characters are split into several texts.

## Real device setup

There are two device modes, picked with `DEVICE_MODE`.

`DEVICE_MODE=eth` (the default) uses Ledger's official Ethereum app and real ETH on Base mainnet (chain id 8453).
Install the Ethereum app with Ledger Live, plug the Nano S Plus in over USB, unlock it, open the Ethereum app, and close Ledger Live (it holds the USB device).
An account is bound to the device's address at `m/44'/60'/0'/0/0`.
With the Ledger on the server's Mac, onboarding asks you to confirm **Verify address** on the device; otherwise it texts a sign-up link (see [Approve from anywhere](#approve-from-anywhere)).
A payment is a plain ETH transfer: the device shows the amount in ETH, the full recipient address and the max fees, and the server broadcasts it after you press **Accept and send**, then texts the basescan.org link and later "Confirmed on Base".
Amounts in dollars are converted at the Coinbase spot price; "0.001 ETH" amounts are sent as is; the recipient is an @tag or a raw 0x address.
Calendar, friend request, accept and delete account are signed as personal messages ("AgentSign / Add to calendar / Title: ...").
Texting "delete my account" shows **Delete account** (`Tag`, `Address`) on the Ledger; approving it wipes the account, and they can sign up again (Ethereum mode only).
In this mode the Ledger does not have to be plugged into the server's Mac: see [Approve from anywhere](#approve-from-anywhere).

`DEVICE_MODE=agentsign` uses the custom AgentSign app with demo dollars kept in SQLite.
Load it on a Nano S Plus with `scripts/sideload.sh`; [device-app/README.md](device-app/README.md) has the details (build, sideload, and the APDU protocol).
Plug the device in over USB, unlock it, open the AgentSign app, and set `DEVICES=hid` (or keep the Speculos entries too, for example `DEVICES=speculos:127.0.0.1:9999,hid`).

In both modes two people with two Ledgers on one Mac both work: the server always picks a device by its key or address, never by USB port.
Onboarding over USB needs exactly one Ledger without an account to be connected; in eth mode, with none connected, sign-up goes through the link instead.

## Approve from anywhere

In `DEVICE_MODE=eth` every approval text ends with a link:

```
Please confirm on your Ledger: Send money: To @yadu, Amount $5.00, ...
Or approve from any computer your Ledger is plugged into: https://<your-url>/sign/<token>
```

Open it in Chrome or Edge on any computer your Ledger is plugged into, unlock the Ledger, open the Ethereum app, and press **Approve on Ledger**.
The browser asks which device to use (WebHID); pick the Ledger.
The page shows the same action as the device, the Ledger shows it and signs it, and the page sends the signature back.
The server verifies it with the same code as a USB answer (the signed transaction against the proposed one for payments, the signed message for everything else), executes, and texts you the outcome.
The page then follows the action to the end: "Sent on Base" with the basescan link, "Added to calendar", and so on.

If the Ledger is plugged into the server's Mac, the USB path works as before.
Whichever side engages first wins: once the page has loaded the request, the server stops polling its USB for it (two programs on one Mac cannot share a Ledger), and once the device shows it over USB, the page tells you to approve it there.

Sign-up works the same way, so the Ledger never has to visit the server's Mac.
When you text a tag and the server sees no Ledger without an account on its USB, it answers `To create @gabe, open this link in Chrome on the computer your Ledger is plugged into, with the Ethereum app open: <link>`.
The device shows **Sign message** with `AgentSign / Create account / Tag: @gabe / Phone: +1...`; after you approve, the server recovers the address from the signature, refuses it if that address already has an account, and binds @gabe to it.
For 2 minutes the server also watches its USB, so plugging the Ledger in there (and confirming **Verify address**) works too.
When the server does not see the Ledger on USB it texts once that it is waiting.
It stops looking on USB after 2 minutes, but a link stays valid on its own clock: 10 minutes for sign-up, 5 minutes for everything else.
A link is single use; an answer from a different Ledger is refused and the link stays open for the right one.
While the device shows the request, the page tells you which button to press and checks the server every 3 seconds, so an expired request says so instead of waiting forever.
Safari and iOS have no WebHID, so the page asks you to open the link in Chrome on the computer with the Ledger.

WebHID only works over https (or on `localhost`), so expose the page before you text from your phone:

```sh
ngrok http 7788                        # prints https://<something>.ngrok-free.app
PUBLIC_URL=https://<something>.ngrok-free.app CHANNEL=telegram pnpm start
```

`tailscale serve 7788` works too; use the https name it prints as `PUBLIC_URL`.
The page and its script (`/ledger.js`, built in memory with esbuild when the server starts; `pnpm build:web` writes the same bundle to `dist/ledger.js` as a check) contain no secrets: the token in the link is the only key, and it only lets someone show the request, submit a signature that must verify against your Ledger's address, or reject it.

## Google Calendar

Each owner can connect their own Google Calendar.
Once connected, "what's on tomorrow" reads it, friends' agents see its busy times (never titles), and every event approved on the Ledger lands on it too.
Nothing about the Ledger changes: Google is only ever written with events the owner signed, and connecting it is not a signed action because it moves nothing.

Set it up once, in `DEVICE_MODE=eth` (the OAuth callback rides on the approval page's web server):

1. In [Google Cloud Console](https://console.cloud.google.com/) create a project and enable the **Google Calendar API** (APIs & Services > Library).
2. Under **OAuth consent screen** choose External, fill in the app name and your email, and add every owner's Gmail address as a test user.
   While the app is in Testing, Google ends each connection after 7 days; the owner just connects again, or you publish the app (Google reviews calendar scopes).
3. Under **Credentials** create an **OAuth client ID** of type **Web application**, and add `<PUBLIC_URL>/google/callback` as an authorized redirect URI: `https://agentsign-jarvis.fly.dev/google/callback` on Fly, or `https://<something>.ngrok-free.app/google/callback` locally.
   The URI must match `PUBLIC_URL` exactly, so when an ngrok URL changes, update it there too.
4. Put the client id and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
   Locally, restart; on Fly, `scripts/fly-deploy.sh` stages them as secrets (or `fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... -a agentsign-jarvis`).
   The log says `google calendar: on, redirect URI ...`.

Then an owner says `connect my google calendar` (in those words it skips the model; "can you hook my calendar up to google?" goes through Jarvis and the engine's `connect_google_calendar` tool) and gets a one-time link, valid for 15 minutes.
It leads to Google's consent screen and back to `/google/callback`, which stores the connection and texts them `Google Calendar connected as <email>.`, copying any upcoming AgentSign events over.
After that:

- `get_calendar` returns Google's events (all-day ones marked) and AgentSign's own, each with its `source`; `get_free_busy` for friends' agents counts timed Google events that are not marked free or declined.
- an approved `CAL` is written to AgentSign's table as before, then mirrored to Google; the text reads `Added 'Dentist' Sun Oct 11 09:00-10:00 to your calendar. It's on your Google Calendar too.` A meeting both friends said yes to is mirrored the same way on each side, as `Lunch with @matt`.
  If Google is down the event stays on AgentSign, the text says so, and the next event retries it (event ids are derived from the row, so a retry never duplicates).
- if Google is unreachable when reading, the engine gets AgentSign's events and a warning, and says so instead of guessing.
- `disconnect google calendar` forgets the connection and revokes the token; if Google revokes it first, the owner is told and can reconnect.

Refresh tokens live in the SQLite file next to everything else, so keep `DB_PATH` private.
The scopes are `calendar.events` (read and write events) and `calendar.calendars.readonly` (to learn the primary calendar's address and time zone), nothing else.

## Buying on Amazon

Owners can buy small things on Amazon and pay in ETH: "buy me a pack of trident gum".
Amazon takes cards, not ETH, so the operator (you) fronts it: the owner's ETH goes to a **treasury** wallet you control, and the server orders with your own Amazon account and the card saved there, at most `PURCHASE_LIMIT_USD` (default $20) per order, item, shipping and tax included.
The treasury holds the ETH until Amazon confirms the order and sends it back automatically when nothing was ordered; anything unclear is flagged to you instead of retried.
The design notes in `DESIGN.md` ("Buying on Amazon") spell out the state machine.

Setup, Ethereum mode only:

1. A treasury wallet on Base: `TREASURY_PRIVATE_KEY`.
   Keep a little ETH on it for refund gas (a refund costs well under a cent on Base).
   Buyers see its address on the Ledger and in the text.
2. Your Amazon session: run `pnpm amazon:login` on your Mac.
   It opens a Chromium window on Amazon's sign-in page; sign in (tick "Keep me signed in"), press Enter in the terminal, and it writes `data/amazon-state.json`, the browser's cookies.
   That file is as sensitive as your Amazon password.
   Point the server at it with `AMAZON_STORAGE_STATE_PATH=data/amazon-state.json`, or put its contents (or their base64) in `AMAZON_STORAGE_STATE`, which is how it travels to Fly: `fly secrets set AMAZON_STORAGE_STATE="$(base64 < data/amazon-state.json)" -a agentsign-jarvis`.
   Make sure the account's default address and payment method are the ones you want used.
3. Optional: `PURCHASE_LIMIT_USD` (default 20), `PURCHASE_SHIPS_TO` (what buyers are told, default "<operator>'s address"), `OPERATOR_TAG` and `OPERATOR_NAME` (you get a text when a purchase needs a person), `AMAZON_DRY_RUN=1` (everything up to the order button, then the buyer is refunded: use this for the first real run and read `data/amazon-shots/`).

To try the flow without Amazon, set `AMAZON_MERCHANT=demo` with the dev channel: a built-in catalog, orders that never happen.

How a purchase goes: the engine searches Amazon (`search_amazon`), picks the item that fits and proposes **Buy on Amazon** with the exact checkout total; the Ledger shows the ETH transfer to the treasury; once Base confirms it the server runs the checkout with **Buy Now** (never your cart), checks that exactly one item at the quoted total is on the page, and presses Place your order.
The owner gets one text per step: the confirm prompt, "Paid ...", then "Ordered on Amazon ... Order 111-..." or "Amazon didn't take the order (...), your ETH is on its way back" with the basescan link.
Amazon's checkout pages change and the driver was written from their known layouts, so do the first run with `AMAZON_DRY_RUN=1` and a signed-in session; `data/amazon-shots/` has a screenshot of every step that did not go as expected.
The server runs headless Chromium for this, which is why the Fly machine has 1 GB.

## Deploy to Fly.io

AgentSign runs as one small Fly.io machine, so nothing has to stay running on a Mac.
The machine long-polls Telegram, serves the approval page and the voice/MCP routes at `https://<app>.fly.dev`, and keeps its SQLite database on a volume.
No Ledger is ever plugged into it: every approval and every sign-up goes through the link in the text, opened in Chrome or Edge on any computer the Ledger is plugged into (see [Approve from anywhere](#approve-from-anywhere)).

The pieces are `Dockerfile` (Node 22, the native modules built in a separate stage, runs as the unprivileged `node` user), `fly.toml` (app `agentsign-jarvis` in `sjc`, one `shared-cpu-1x` machine with 1 GB (headless Chromium for Amazon) that never auto-stops, the `agentsign_data` volume on `/data`) and `scripts/fly-deploy.sh`.

1. Install flyctl (`brew install flyctl`) and log in:

```sh
fly auth login
```

2. Stop the server on this Mac (Ctrl-C in its terminal).
   Only one process may poll a bot token, and the script refuses to deploy while something still listens on port 7788.
3. Run the script from the repo root:

```sh
scripts/fly-deploy.sh                    # app agentsign-jarvis, https://agentsign-jarvis.fly.dev
scripts/fly-deploy.sh agentsign-matt     # if that name is taken on Fly
```

It checks the bot token against `TELEGRAM_BOT_USERNAME`, then runs `fly launch --no-deploy --copy-config`, `fly volumes create agentsign_data --size 1`, stages the secrets, runs `fly deploy --ha=false`, checks that `https://<app>.fly.dev/sign/nope` answers 404, and follows the logs.
The secrets come from `.env`: `XAI_API_KEY` (or `~/.grok/.env`), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `MCP_TOKEN`, `ADMIN_TOKEN` (generated and appended to `.env` when missing), `VOICE_WEBHOOK_SECRET`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` when set, plus `PUBLIC_URL=https://<app>.fly.dev`.
Their values are never printed.
Everything else is in `[env]` in `fly.toml`.
Re-running the script is safe: an existing app and volume are kept, and the secrets and code are updated.
Use `FLY_ORG=<org>` for an organization other than `personal`.

Where things live and how to look at them:

- The database is `/data/agentsign.db` on the `agentsign_data` volume, and Telegram photos go to `/data/telegram`.
  A deploy or restart keeps both; deleting the volume (or the app) deletes them.
  Fly snapshots volumes daily; `fly volumes snapshots list <volume id>` shows them.
- Logs: `fly logs -a agentsign-jarvis` (live) or the Monitoring tab on fly.io.
- State: `fly status -a agentsign-jarvis`; a shell: `fly ssh console -a agentsign-jarvis`.
- Change a secret with `fly secrets set NAME=value -a agentsign-jarvis` (this restarts the machine).
- The voice agent's MCP server is now `https://<app>.fly.dev/mcp`; update the URL in the xAI console (Path A) or the number's webhook (Path B).

The deployed server starts with an empty database.
To carry over the accounts from this Mac, upload the local file once while nothing writes to it, then restart:

```sh
fly ssh sftp put data/agentsign-eth.db /data/import.db -a agentsign-jarvis
fly ssh console -a agentsign-jarvis -C "sh -c 'mv /data/import.db /data/agentsign.db && rm -f /data/agentsign.db-wal /data/agentsign.db-shm && chown node:node /data/agentsign.db'"
fly apps restart agentsign-jarvis
```

Stop the local server before you copy, so the file has no unwritten WAL pages (`data/agentsign-eth.db-wal` is then gone or empty).

After the deploy this Mac runs nothing for AgentSign.
Texts go to the bot from any phone, and each approval is a link opened in Chrome on whichever computer the Ledger is plugged into at that moment.
Safari and iOS have no WebHID, so the link has to be opened on a computer with Chrome or Edge.
To run locally again, stop the Fly machine first (`fly scale count 0 -a agentsign-jarvis`), then `pnpm start` as before.

## Voice

You can call Jarvis, the agent's voice (a composed, dry, male-sounding xAI voice), and get everything the text agent does.
The same tools and the same harness run behind a call: reads happen right away, and anything risky only becomes a request on the caller's own Ledger, texted to their own number.
Outcomes (approved, rejected, timed out) are texted as always.
Calls need the web server, so they work in `DEVICE_MODE=eth` (the default), and `PUBLIC_URL` must be a public https URL (ngrok, `cloudflared tunnel --url http://127.0.0.1:7788`, `tailscale funnel`).

There are two ways to wire a phone number to AgentSign.

### Path A: the console voice agent plus our MCP server (the demo path)

The xAI-provisioned number stays bound to the console agent, and the agent calls AgentSign's tools over MCP during the call.

1. Start the server with `MCP_TOKEN` set (in `.env`).
   Without it the server generates one, keeps it in the database, and prints it at startup.
2. In the xAI console, open the agent, then **Configuration > Tools > Custom MCP server**:
   - Server URL: `https://<PUBLIC_URL host>/mcp` (Streamable HTTP).
     If the dialog insists on the legacy SSE transport, use `https://<PUBLIC_URL host>/sse`; it posts to `/messages` on the same host.
   - Header: `Authorization: Bearer <MCP_TOKEN>`.
3. Turn on **Know caller's phone number**: every tool takes the caller's `phone`, and the account is looked up from it exactly like a text.
4. **Speech**: pick a male voice, such as Atlas (others: Orion, Leo, Rex, Sirius).
5. **Instructions**: paste [voice/JARVIS.md](voice/JARVIS.md).
   **Welcome message**: something short like `Jarvis speaking.`; Jarvis then calls `identify` and greets the caller by name.
   The console's "API request" and "Send SMS" tools are not needed.
6. Publish, and call +1 940 644-7419.

The MCP tools are `identify`, `onboard`, `get_balance`, `list_friends`, `get_calendar`, `get_notes`, `remember`, `list_transactions`, `send_note`, `message_agent`, `connect_google_calendar`, `disconnect_google_calendar`, `propose_action` and `delete_account`.
Their results are short and speakable: no links, and addresses shortened to `0x1234...abcd`.
`remember` and `get_notes` are the agent's own memory about each person; collections and knowledge uploads live in the console and are separate.
The caller's number comes from the console agent and could be wrong or spoofed, so treat everything a tool reads (balance, friends, notes) as visible to whoever controls that number.
Nothing can be moved that way: every risky action still needs the account's own Ledger, and its request is texted to the account's own phone.
`onboard` binds the given number to whichever unbound Ledger is plugged into the server, so only run sign-ups by phone while you watch the Mac.

### Path B: a number created with a webhook (this server joins the call)

The number is created with a `webhook` instead of an `agent_id`.
On each call xAI POSTs a signed `realtime.call.incoming` event to `PUBLIC_URL/voice/webhook`.
The server checks the signature, reads the caller from the SIP `From` header, joins the call at `wss://api.x.ai/v1/realtime?call_id=...`, and runs Jarvis with the caller's account (`src/voice/session.ts`): their tag, balance, friends, what waits on their Ledger and their recent texts.
A number without an account gets the sign-up flow: Jarvis asks for a tag, the deterministic onboarding runs, and the Ledger shows the account request, which is also texted.
If an approval lands during the call, Jarvis says so ("Approved, sent").
When the caller says goodbye, Jarvis says goodbye and hangs up; the transcript goes into the account's chat history as a note, so the text agent knows what was said on the phone.

Create the number (Matt does this; the signing secret is shown only once):

```sh
curl -s https://api.x.ai/v2/phone-numbers \
  -H "Authorization: Bearer $XAI_API_KEY" -H 'content-type: application/json' \
  -d '{"origin":"xai_provisioned","name":"Jarvis","area_code":"940","webhook":{"name":"agentsign","url":"<PUBLIC_URL>/voice/webhook"}}'
```

Put the response's `webhook.dispatch_signing_secret` (`whsec_...`) into `VOICE_WEBHOOK_SECRET` and restart.
Without it the webhook is refused, except with the dev channel, where unsigned webhooks are accepted with a loud log line.
The SIP guide on docs.x.ai says provisioning xAI numbers by API is not supported, while the API reference lists `xai_provisioned`; if the call is refused, create the number in the console with this webhook URL.

Change Jarvis's standing instructions for new calls (and push them into live calls) with:

```sh
curl -s "$PUBLIC_URL/voice/context" -H "x-agentsign-admin: $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"instructions":"Matt is demoing at a hackathon. Keep it extra short."}'
curl -s "$PUBLIC_URL/voice/calls" -H "x-agentsign-admin: $ADMIN_TOKEN"   # recent calls and transcripts
```

### Talking to Jarvis without a phone

`pnpm voice:chat` opens the exact call session over xAI's realtime API in text mode against an in-memory demo world (Matt and Yadu, fake Ledgers that approve, texts printed instead of sent).
Type to Jarvis and watch the tool calls; `--as stranger` tries the sign-up flow, `--context '...'` sets standing instructions.

| Variable | Default | What |
|---|---|---|
| `VOICE` | `atlas` | Voice for Path B. Other male-sounding voices: orion, leo, rex, sirius, perseus, kepler, castor, helios, cosmo. |
| `VOICE_WEBHOOK_SECRET` | none | The number's `dispatch_signing_secret` (Path B). |
| `MCP_TOKEN` | generated and stored | Bearer token the console agent sends to `/mcp` and `/sse` (Path A). |
| `ADMIN_TOKEN` | none | Shared secret for `POST /voice/context` and `GET /voice/calls` (header `x-agentsign-admin`). Unset: both are off. |
| `PUBLIC_URL` | `http://127.0.0.1:7788` | Must be public https for either path. |

## Environment variables

Set them in `.env` (see `.env.example`) or in the shell.

| Variable | Default | What |
|---|---|---|
| `XAI_API_KEY` | none | xAI key. Also read from `~/.grok/.env`. |
| `XAI_MODEL` | `grok-4.3` | Model for the execution engine and friends' agents. Any Grok model with tool calling and image input works. |
| `XAI_PERSONA_MODEL` | `grok-4.20-non-reasoning` | Model for the persona (the voice of the agent). Falls back to `XAI_MODEL` for a call that fails (for example 429 at capacity). Set it empty to use `XAI_MODEL` for everything. |
| `DEVICE_MODE` | `eth` | `eth` (Ethereum app, real ETH on Base) or `agentsign` (custom app, demo money). |
| `BASE_RPC_URL` | `https://mainnet.base.org` | Base JSON-RPC endpoint (eth mode). |
| `DEVICES` | `speculos:127.0.0.1:9999,speculos:127.0.0.1:9998,hid` | Comma separated: `speculos:<host>:<apdu-port>` for an emulator, `hid` for every Ledger on USB. |
| `CHANNEL` | `telegram` with a token, else `imessage` | `telegram` (bot), `imessage` (Photon) or `dev` (local HTTP and REPL). |
| `TELEGRAM_BOT_TOKEN` | none | Bot token from BotFather. Required for `CHANNEL=telegram`. |
| `TELEGRAM_BOT_USERNAME` | none | The bot's @username, which Jarvis tells people to share ("tell friends to open @..."). Unset: "the AgentSign bot". |
| `DEV_PORT` | `7777` | Port of the dev channel. |
| `WEB_PORT` | `7788` | Port of the approval page (eth mode). |
| `PUBLIC_URL` | `http://127.0.0.1:7788` | Base of the links in approval texts. Must be https (ngrok, `tailscale serve`) for other computers. |
| `WEB_HOST` | `127.0.0.1` | Interface the approval page listens on. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | none | OAuth web client that lets owners connect their Google Calendar (eth mode). Redirect URI: `PUBLIC_URL/google/callback`. See "Google Calendar". |
| `TREASURY_PRIVATE_KEY` | none | Turns on buying on Amazon (eth mode): the wallet that receives buyers' ETH and refunds them. See "Buying on Amazon". |
| `AMAZON_STORAGE_STATE`, `AMAZON_STORAGE_STATE_PATH` | none | Your Amazon session from `pnpm amazon:login`, as JSON or base64, or a path to the file. |
| `AMAZON_MERCHANT` | `browser` with a session | `browser` (amazon.com through Chromium) or `demo` (a built-in catalog, nothing is ordered). |
| `AMAZON_DRY_RUN` | unset | `1`: run the checkout but never press Place your order; the buyer is refunded. |
| `PURCHASE_LIMIT_USD` | `20` | Cap on one order's checkout total, item plus shipping and tax. |
| `PURCHASE_SHIPS_TO` | `<operator>'s address` | Where orders go, in words, as told to buyers. |
| `OPERATOR_TAG`, `OPERATOR_NAME` | none | The operator's tag (texted when a purchase needs a person) and first name as used in texts. |
| `DB_PATH` | `data/agentsign.db` | SQLite file. |

## Dev channel HTTP API

The dev channel listens on `127.0.0.1` only.
It answers 403 unless the `Host` header is `127.0.0.1`, `localhost` or `[::1]` (any port), and a `POST` must have `content-type: application/json`, so web pages cannot post texts or read the outbox.

- `POST /dev/message` with JSON `{ "handle": "+15550000001", "text": "send $5 to @gabriel", "images": ["/abs/receipt.jpg"] }` delivers one simulated text.
  It waits until the app has handled it and answers `{ "replies": [...], "since": 12 }`: every text sent to that handle meanwhile, plus an outbox cursor.
  Texts from the same handle are handled one at a time, in order; different handles do not wait for each other.
- `GET /dev/outbox?handle=+15550000001&since=12` answers `{ "messages": [{ "to", "text", "at" }], "since": 15 }` with the texts sent after the cursor, which is how you see approval outcomes that finish in the background.
  Leave out `handle` to get the texts for everyone.
  The outbox keeps the last 500 texts.

```sh
curl -s localhost:7777/dev/message -H 'content-type: application/json' -d '{"handle":"+15550000001","text":"what is my balance?"}'
curl -s 'localhost:7777/dev/outbox?since=0'
```

`devSend()` and `devOutbox()` in `src/channels/dev.ts` wrap both calls for scripts and tests.

## How the agent is structured

The agent, Jarvis, has two layers, like Poke: a personality that talks and an engine that works.
AgentSign stays the product name, on the Ledger and the approval page.

- **The persona** (`src/agent/persona.ts`) owns the conversation with the owner.
  It sounds like a clever friend over text (the Poke persona with everything Poke-specific removed): concise, direct, witty when it fits, warm when earned, mirroring the owner's casing and tone, two or three short sentences, plain text and no emoji.
  It answers greetings, thanks, "how do I get set up?", "what can you do?" and other simple questions on its own from a few facts (tag, address, balance, friends, what waits on the Ledger) and the chat history, and in roughly one reply out of five adds one offer of something it can actually do right now.
  It never mentions the engine or its tools; if something fails it apologizes in the first person.
  On the owner's first turn after sign-up it greets them and offers three things to try: send money (funded with ETH on Base at their address), add a friend, add to calendar.
  It has exactly one tool, `delegate(goal, context)`, and it never claims something happened unless a note from the Ledger says it was approved and executed.
- **The engine** (`src/agent/engine.ts`) has no access to the user.
  It gets a task from the persona, does it with the read-only tools, `send_note`, `message_agent` and `propose_action`, and reports back in plain facts, including what it needs from the owner.
  `send_note` is how friends chat through their agents: "send gabe a thank you note" lands on Gabe's phone as a text from his own Jarvis (`@matt says: ...`), right away and with nothing to sign, and Gabe can answer the same way.
  The report is stored in the persona's history as the result of `delegate`, so the next turn can use it.
- **Strangers** (people without an account) get a fixed welcome that offers their Telegram username as the tag; `go` (or any plain yes) and `link` skip the model.
  Anything else goes to a restricted persona with no engine that steers back to setup and calls `choose_tag(tag)` or `send_link()`; the deterministic onboarding in `src/app.ts` takes over from there (free Ledger check, **Create account** approval, or the sign-up page).
  Without a usable username Jarvis asks for a tag, and a message that already contains an @tag skips the model.
- **One text per proposal.**
  When the engine proposes an action, the `Please confirm on your Ledger: ...` line is appended to the persona's reply and sent as one text, and the device is asked only after that text went out.
  Outcomes (approved, rejected, timed out) arrive later as their own texts.
- **Speed.**
  A simple chat turn is one persona call (about 0.5 s on `grok-4.20-non-reasoning`).
  A payment is persona, engine, persona (about 3.5 to 4.5 s, mostly the engine on `grok-4.3`); the engine's report after a proposal comes from the harness, not another model call.
- **Typing and reactions.**
  Channels may implement optional `typing(handle, on)` and `react(messageId, emoji)`; the app shows typing while the model works and reacts 👍 when the engine takes on a request.
  The Mac's own Messages cannot send either (AppleScript has no verb for them, and Photon's local Spectrum provider refuses reactions without its cloud), so on iMessage they are no-ops for now; the dev REPL prints the reaction.

## How the harness keeps the agent honest

- Neither layer has a tool that moves money or deletes the account: those are always proposals for the Ledger.
  The engine can read its owner's balance, friends, calendar (Google's too, once connected) and notes, remember things, send the Google Calendar connect link, talk to friends' agents and arrange meetings with friends (booked only once the friend says yes by text).
  Calendar events and friend changes go to the Ledger only when the owner's Ledger policy says so (`standard` by default: friends yes, calendar and meetings no; `strict` gates all three; `relaxed` none); otherwise the same executor runs at once and the owner is told it is done.
- Its only way to make something happen is one `propose_action` tool, which creates a pending approval.
- The device parses the canonical action bytes itself, shows the title and every field, and signs those exact bytes only after the person approves on the device.
- The server verifies the Ed25519 signature against the public key stored on the account before anything is executed.
- Every action has a random id, and the server only accepts a signature for the action it is waiting on, so a signature cannot be replayed.
- The signature is stored with the action as its receipt.
