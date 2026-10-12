# Calling Jarvis: Twilio + OpenAI realtime

You call a Twilio number and talk to Jarvis.
A call can do everything a Telegram text can: balance, payments, calendar, meetings with friends, notes, Amazon, the Ledger policy.
Anything for the Ledger still lands in your Telegram chat as the usual "Please confirm on your Ledger" message with the signing link.
Jarvis tells you on the call when it is approved.

## How a call flows

1. Twilio receives the call and POSTs it to `PUBLIC_URL/twilio/voice`, signed with your Twilio auth token.
2. The server checks the signature and answers TwiML: connect the call's audio to `wss://<PUBLIC_URL host>/twilio/media`, with a one-time token that names the caller.
3. The media stream (G.711 mu-law, 8 kHz) is piped into one OpenAI realtime session configured for `audio/pcmu` both ways, so there is no transcoding.
4. The session is the same harness a text uses (`src/agent/engine.ts` tools): read-only tools run, `propose_action` makes an approval on your Ledger.
5. If you talk over Jarvis, the server clears Twilio's playback buffer and truncates the model's last item to what you heard.
6. When you say goodbye, Jarvis calls `end_call`, says one line, and the stream closes; the TwiML's `<Hangup/>` ends the call.
7. The transcript goes into your chat history as a system note, so the next text can refer to the call.

Who is calling is the caller ID.
An account is a Telegram user plus a Ledger, so you link your phone number once:

- on Telegram: "my number is +1 415 555 0100, link it" (the engine's `link_phone` tool), or
- on a call from an unlinked number: Jarvis reads a four-digit code; text that code to the bot on Telegram and stay on the line; the call switches to your account at once.

A number belongs to at most one account.
Hidden caller IDs are declined with a spoken line.

Code: `src/voice/twilio.ts` (webhook, TwiML, the media bridge), `src/voice/session.ts` (the realtime session, OpenAI and xAI shapes), `src/voice/instructions.ts` (what Jarvis knows on a call), `src/phone.ts` (linked numbers and codes).

## Set it up

You need an OpenAI API key with access to the realtime models, and a Twilio account with a voice-capable number.

1. Buy a number in the Twilio console (Phone Numbers > Buy a number, Voice capability).
   Note the Account SID and Auth Token (Console > Account info).
2. Put these in `.env` (and on Fly as secrets):

   ```sh
   OPENAI_API_KEY=sk-...
   OPENAI_REALTIME_MODEL=gpt-realtime-2.1   # or gpt-realtime-2.1-mini (cheaper), gpt-realtime
   OPENAI_VOICE=cedar                       # alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_PHONE_NUMBER=+1...
   ADMIN_TOKEN=...                          # optional: GET /voice/calls, POST /voice/context
   ```

3. Deploy. `scripts/fly-deploy.sh` copies those secrets from `.env` to Fly and redeploys.
   By hand:

   ```sh
   fly secrets set -a agentsign-jarvis OPENAI_API_KEY=... TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... TWILIO_PHONE_NUMBER=+1...
   fly deploy -a agentsign-jarvis --ha=false
   ```

   The log shows `twilio: calls to +1... answered at https://.../twilio/voice, audio on wss://.../twilio/media, gpt-realtime-2.1 speaking as cedar`.

4. Point the number at the server:

   ```sh
   scripts/twilio-setup.sh
   ```

   It sets the number's Voice URL to `PUBLIC_URL/twilio/voice` (POST) through Twilio's REST API and checks the server answers.
   Or in the console: Phone Numbers > your number > Voice Configuration > "A call comes in": Webhook, `https://agentsign-jarvis.fly.dev/twilio/voice`, HTTP POST.

5. Link your phone: on Telegram, tell Jarvis "my number is +1 ...", or just call and text back the code.

6. Call the number.

## Try it without a phone

`pnpm voice:chat --provider openai` types to the exact session a call runs (instructions, tools, the engine), over OpenAI's realtime API in text mode, against an in-memory demo world.
`--as unlinked` plays a number no account has linked: Jarvis reads a code, and `link <code>` in the prompt does what texting it on Telegram would.

`pnpm test test/twilio.test.ts` runs the whole bridge against a fake Twilio stream and a fake OpenAI server: signature, TwiML, audio both ways, barge-in, tools, hang-up, transcript, the code flow and `link_phone`.

## Operating it

- `GET /voice/calls` with header `x-agentsign-admin: <ADMIN_TOKEN>`: the last 20 calls with transcripts and tool calls.
- `POST /voice/context` `{ "instructions": "..." }` (same header): standing instructions for every call, pushed to live calls too.
- Twilio's "A call comes in" webhook must be the exact URL the server sees (`PUBLIC_URL` + `/twilio/voice`); the signature covers it.
  Behind a different hostname the signature fails with 403 and the log says `twilio: bad signature for <url>`.
- `TWILIO_AUTH_TOKEN` unset: every call is refused (503) except on the dev channel, where unsigned webhooks are accepted and the log shouts about it.
- `OPENAI_API_KEY` unset: calling is off; `/twilio/*` answers 404 and Jarvis does not mention calls.
- A realtime session lasts at most 60 minutes.

## Costs

Twilio: a number is about $1 a month and inbound calls about a cent a minute.
OpenAI realtime audio is the expensive part: on the order of $0.10 to $0.30 per minute of conversation with `gpt-realtime-2.1`, roughly a third of that with `gpt-realtime-2.1-mini`.
