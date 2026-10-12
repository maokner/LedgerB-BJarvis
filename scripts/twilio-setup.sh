#!/usr/bin/env bash
# Points a Twilio number at this server so calls reach Jarvis (src/voice/twilio.ts, voice/TWILIO.md).
#
#   scripts/twilio-setup.sh                 reads .env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, PUBLIC_URL
#   PUBLIC_URL=https://x.y scripts/twilio-setup.sh
#
# What it does, through Twilio's REST API with curl (no SDK):
#   1. finds the number in the account (IncomingPhoneNumbers)
#   2. sets its Voice URL to <PUBLIC_URL>/twilio/voice (POST) and its status callback to <PUBLIC_URL>/twilio/status
#   3. checks that <PUBLIC_URL>/twilio/voice answers (403 without Twilio's signature is the expected answer)
# Run it again whenever PUBLIC_URL changes. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

# Reads KEY from .env (last occurrence wins, like dotenv) without sourcing it: values like "Matt's address" would break the shell.
env_get() {
  local line value
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" .env 2>/dev/null | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  case "$value" in
    \"*) value="${value#\"}"; value="${value%%\"*}" ;;
    \'*) value="${value#\'}"; value="${value%%\'*}" ;;
    *) value="$(printf '%s' "$value" | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//')" ;;
  esac
  printf '%s' "$value"
}
for name in TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_PHONE_NUMBER PUBLIC_URL; do
  [ -n "${!name:-}" ] || eval "$name=\"\$(env_get $name)\""
done
: "${TWILIO_ACCOUNT_SID:?set TWILIO_ACCOUNT_SID (Twilio console > Account info)}"
: "${TWILIO_AUTH_TOKEN:?set TWILIO_AUTH_TOKEN (Twilio console > Account info)}"
: "${TWILIO_PHONE_NUMBER:?set TWILIO_PHONE_NUMBER (E.164, like +14155550100)}"
: "${PUBLIC_URL:?set PUBLIC_URL (https, like https://agentsign-jarvis.fly.dev)}"
case "$PUBLIC_URL" in https://*) ;; *) die "PUBLIC_URL must be https (Twilio needs https for the webhook and wss for the audio): $PUBLIC_URL" ;; esac
PUBLIC_URL="${PUBLIC_URL%/}"
command -v curl >/dev/null || die "curl is needed"
command -v python3 >/dev/null || die "python3 is needed (to read Twilio's JSON)"

api="https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID"
auth="$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN"
json() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }

step "Finding $TWILIO_PHONE_NUMBER in account $TWILIO_ACCOUNT_SID"
found="$(curl -sS -u "$auth" "$api/IncomingPhoneNumbers.json?PhoneNumber=$(printf %s "$TWILIO_PHONE_NUMBER" | sed 's/+/%2B/')")"
sid="$(printf %s "$found" | json "(d.get('incoming_phone_numbers') or [{}])[0].get('sid','')")" || die "Twilio answered: $found"
[ -n "$sid" ] || die "no number $TWILIO_PHONE_NUMBER in this account. Buy one in the Twilio console (Phone Numbers > Buy a number, voice capable) first."
echo "ok: $sid"

step "Pointing it at $PUBLIC_URL/twilio/voice"
updated="$(curl -sS -u "$auth" -X POST "$api/IncomingPhoneNumbers/$sid.json" \
  --data-urlencode "VoiceUrl=$PUBLIC_URL/twilio/voice" \
  --data-urlencode "VoiceMethod=POST" \
  --data-urlencode "StatusCallback=$PUBLIC_URL/twilio/status" \
  --data-urlencode "StatusCallbackMethod=POST" \
  --data-urlencode "VoiceApplicationSid=" \
  --data-urlencode "FriendlyName=Jarvis")"
printf %s "$updated" | json "d['voice_url']" >/dev/null || die "Twilio answered: $updated"
echo "ok: voice url $(printf %s "$updated" | json "d['voice_url']")"

step "Checking $PUBLIC_URL/twilio/voice"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$PUBLIC_URL/twilio/voice" -d "From=%2B10000000000&CallSid=CAsetup" || true)"
case "$code" in
  403) echo "ok: the server is up and refuses unsigned calls (Twilio's are signed)" ;;
  200) echo "ok: the server answered (unsigned calls are accepted: dev mode)" ;;
  404) die "$PUBLIC_URL/twilio/voice is 404: the server runs without OPENAI_API_KEY, so calls are off. Set it (fly secrets set OPENAI_API_KEY=...) and redeploy." ;;
  503) die "$PUBLIC_URL/twilio/voice is 503: TWILIO_AUTH_TOKEN is not set on the server." ;;
  *) die "$PUBLIC_URL/twilio/voice answered ${code:-nothing}; is the server up? (fly logs -a agentsign-jarvis)" ;;
esac
echo
echo "Done. Call $TWILIO_PHONE_NUMBER. From an unlinked phone Jarvis reads a four-digit code: text it to the bot on Telegram and stay on the line."
