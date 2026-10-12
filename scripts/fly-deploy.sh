#!/usr/bin/env bash
# Deploys AgentSign to Fly.io: creates the app and its volume (first run only), copies secrets from the local .env,
# deploys, checks the approval page answers, then tails the logs. Safe to re-run: existing pieces are skipped.
#
#   fly auth login
#   scripts/fly-deploy.sh                 # app "agentsign-jarvis"
#   scripts/fly-deploy.sh my-other-name   # if that name is taken on Fly
#
# Env: FLY_ORG (default personal), REGION (default sjc), FORCE=1 to deploy while a local server still listens on 7788.
# Secret values are never printed; only their names are.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
APP="${1:-${APP:-agentsign-jarvis}}"
ORG="${FLY_ORG:-personal}"
REGION="${REGION:-sjc}"
VOLUME="agentsign_data"
ENV_FILE="$ROOT/.env"

step() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# The value of KEY in a dotenv file (last occurrence wins, like dotenv), without quotes or trailing comment.
env_get() {
  local key="$1" file="$2" line value
  [ -f "$file" ] || return 0
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  case "$value" in
    \"*) value="${value#\"}"; value="${value%%\"*}" ;;
    \'*) value="${value#\'}"; value="${value%%\'*}" ;;
    *) value="$(printf '%s' "$value" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//')" ;;
  esac
  printf '%s' "$value"
}

# ---- checks -------------------------------------------------------------------------------------------------
step "Checking tools and .env"
command -v fly >/dev/null || die "flyctl is not installed (brew install flyctl)"
command -v curl >/dev/null || die "curl is not installed"
fly auth whoami >/dev/null 2>&1 || die "not logged in to Fly.io; run: fly auth login"
[ -f "$ENV_FILE" ] || die "no .env at $ENV_FILE (cp .env.example .env and fill it in)"
[ -f fly.toml ] && [ -f Dockerfile ] || die "fly.toml or Dockerfile missing in $ROOT"

XAI_API_KEY="$(env_get XAI_API_KEY "$ENV_FILE")"
[ -n "$XAI_API_KEY" ] || XAI_API_KEY="$(env_get XAI_API_KEY "$HOME/.grok/.env")"
# The channel is the one fly.toml deploys (CHANNEL in [env]): photon (iMessage on Photon) or telegram.
CHANNEL="$(sed -nE 's/^[[:space:]]*CHANNEL[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' fly.toml | head -n 1)"
CHANNEL="${CHANNEL:-photon}"
case "$CHANNEL" in photon|telegram) ;; *) die "fly.toml sets CHANNEL = \"$CHANNEL\"; deploy photon or telegram" ;; esac
SPECTRUM_PROJECT_ID="$(env_get SPECTRUM_PROJECT_ID "$ENV_FILE")"
SPECTRUM_PROJECT_SECRET="$(env_get SPECTRUM_PROJECT_SECRET "$ENV_FILE")"
PHOTON_NUMBER="$(env_get PHOTON_NUMBER "$ENV_FILE")"
TELEGRAM_BOT_TOKEN="$(env_get TELEGRAM_BOT_TOKEN "$ENV_FILE")"
TELEGRAM_BOT_USERNAME="$(env_get TELEGRAM_BOT_USERNAME "$ENV_FILE")"
MCP_TOKEN="$(env_get MCP_TOKEN "$ENV_FILE")"
ADMIN_TOKEN="$(env_get ADMIN_TOKEN "$ENV_FILE")"
VOICE_WEBHOOK_SECRET="$(env_get VOICE_WEBHOOK_SECRET "$ENV_FILE")"
GOOGLE_CLIENT_ID="$(env_get GOOGLE_CLIENT_ID "$ENV_FILE")"
GOOGLE_CLIENT_SECRET="$(env_get GOOGLE_CLIENT_SECRET "$ENV_FILE")"
TREASURY_PRIVATE_KEY="$(env_get TREASURY_PRIVATE_KEY "$ENV_FILE")"
AMAZON_STORAGE_STATE="$(env_get AMAZON_STORAGE_STATE "$ENV_FILE")"
AMAZON_STORAGE_STATE_PATH="$(env_get AMAZON_STORAGE_STATE_PATH "$ENV_FILE")"
AMAZON_MERCHANT="$(env_get AMAZON_MERCHANT "$ENV_FILE")"
AMAZON_DRY_RUN="$(env_get AMAZON_DRY_RUN "$ENV_FILE")"
PURCHASE_LIMIT_USD="$(env_get PURCHASE_LIMIT_USD "$ENV_FILE")"
PURCHASE_SHIPS_TO="$(env_get PURCHASE_SHIPS_TO "$ENV_FILE")"
OPERATOR_TAG="$(env_get OPERATOR_TAG "$ENV_FILE")"
OPERATOR_NAME="$(env_get OPERATOR_NAME "$ENV_FILE")"
# Calling Jarvis (voice/TWILIO.md): OpenAI's realtime model behind a Twilio number.
OPENAI_API_KEY="$(env_get OPENAI_API_KEY "$ENV_FILE")"
OPENAI_REALTIME_MODEL="$(env_get OPENAI_REALTIME_MODEL "$ENV_FILE")"
OPENAI_VOICE="$(env_get OPENAI_VOICE "$ENV_FILE")"
TWILIO_ACCOUNT_SID="$(env_get TWILIO_ACCOUNT_SID "$ENV_FILE")"
TWILIO_AUTH_TOKEN="$(env_get TWILIO_AUTH_TOKEN "$ENV_FILE")"
TWILIO_PHONE_NUMBER="$(env_get TWILIO_PHONE_NUMBER "$ENV_FILE")"
# The Amazon session travels as base64 of the exported file (see "Buying on Amazon" in DESIGN.md); a local path is read here.
if [ -z "$AMAZON_STORAGE_STATE" ] && [ -n "$AMAZON_STORAGE_STATE_PATH" ]; then
  [ -f "$AMAZON_STORAGE_STATE_PATH" ] || die "AMAZON_STORAGE_STATE_PATH points to $AMAZON_STORAGE_STATE_PATH, which does not exist (run: pnpm amazon:login)"
  AMAZON_STORAGE_STATE="$(base64 < "$AMAZON_STORAGE_STATE_PATH" | tr -d '\n')"
fi
if [ -n "$TREASURY_PRIVATE_KEY" ] && [ -z "$AMAZON_STORAGE_STATE" ] && [ "$AMAZON_MERCHANT" != demo ]; then
  die "TREASURY_PRIVATE_KEY is set but there is no Amazon session: run pnpm amazon:login and set AMAZON_STORAGE_STATE_PATH, or AMAZON_MERCHANT=demo"
fi
PUBLIC_URL="https://${APP}.fly.dev"

required=(XAI_API_KEY MCP_TOKEN)
if [ "$CHANNEL" = telegram ]; then required+=(TELEGRAM_BOT_TOKEN TELEGRAM_BOT_USERNAME); else required+=(SPECTRUM_PROJECT_ID SPECTRUM_PROJECT_SECRET); fi
missing=()
for name in "${required[@]}"; do
  [ -n "${!name}" ] || missing+=("$name")
done
[ "${#missing[@]}" -eq 0 ] || die "missing in .env: ${missing[*]}"
if { [ -n "$GOOGLE_CLIENT_ID" ] && [ -z "$GOOGLE_CLIENT_SECRET" ]; } || { [ -z "$GOOGLE_CLIENT_ID" ] && [ -n "$GOOGLE_CLIENT_SECRET" ]; }; then
  die "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET go together in .env"
fi
if [ -n "$OPENAI_API_KEY" ]; then
  for name in TWILIO_AUTH_TOKEN TWILIO_PHONE_NUMBER; do
    [ -n "${!name}" ] || die "OPENAI_API_KEY is set (calling Jarvis) but $name is not; see voice/TWILIO.md"
  done
  case "$TWILIO_PHONE_NUMBER" in +[0-9]*) ;; *) die "TWILIO_PHONE_NUMBER must be E.164, like +14155550100" ;; esac
fi

if [ -z "$ADMIN_TOKEN" ]; then
  command -v openssl >/dev/null || die "ADMIN_TOKEN is not in .env and openssl is not available to generate one"
  ADMIN_TOKEN="$(openssl rand -hex 24)"
  printf '\n# Shared secret for /voice/context and /voice/calls (header x-agentsign-admin), generated by scripts/fly-deploy.sh\nADMIN_TOKEN=%s\n' "$ADMIN_TOKEN" >>"$ENV_FILE"
  echo "ADMIN_TOKEN was not set; generated one and appended it to .env"
fi

if [ "$CHANNEL" = telegram ]; then
  # The token must belong to the bot named in TELEGRAM_BOT_USERNAME. curl reads the URL from stdin so the token stays out of ps.
  me="$(printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$TELEGRAM_BOT_TOKEN" | curl -sS --max-time 15 -K - || true)"
  case "$me" in
    *'"ok":true'*) ;;
    *) die "Telegram rejected TELEGRAM_BOT_TOKEN (getMe failed)" ;;
  esac
  bot="$(printf '%s' "$me" | sed -nE 's/.*"username":"([^"]+)".*/\1/p')"
  want="${TELEGRAM_BOT_USERNAME#@}"
  [ "$(printf '%s' "$bot" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$want" | tr '[:upper:]' '[:lower:]')" ] \
    || die "TELEGRAM_BOT_TOKEN belongs to @$bot, but TELEGRAM_BOT_USERNAME is @$want"
  where="bot @$bot"
else
  # The Spectrum credentials are checked by the server at start (it exits with a clear line in fly logs if Photon refuses them).
  [ -n "$PHOTON_NUMBER" ] || echo "warning: PHOTON_NUMBER is not in .env, so Jarvis cannot tell people which number to text"
  where="iMessage on Photon${PHOTON_NUMBER:+ at $PHOTON_NUMBER}"
fi
echo "ok: app $APP in $ORG/$REGION, $where, PUBLIC_URL $PUBLIC_URL"

# ---- app ----------------------------------------------------------------------------------------------------
step "App $APP"
if fly status -a "$APP" >/dev/null 2>&1; then
  echo "exists, skipping fly launch"
else
  # fly launch may rewrite fly.toml (and drop its comments); keep ours.
  cp fly.toml fly.toml.bak
  trap 'if [ -f fly.toml.bak ]; then mv fly.toml.bak fly.toml; fi' EXIT
  fly launch --no-deploy --copy-config --name "$APP" --org "$ORG" --region "$REGION" --yes
  mv fly.toml.bak fly.toml
  trap - EXIT
fi
if ! grep -qE "^app = \"$APP\"$" fly.toml; then
  sed -i.bak -E "s/^app = \".*\"$/app = \"$APP\"/" fly.toml && rm -f fly.toml.bak
  echo "set app = \"$APP\" in fly.toml"
fi

# ---- volume -------------------------------------------------------------------------------------------------
step "Volume $VOLUME"
# Read the list first: with pipefail, grep -q closing a pipe early would look like "no volume".
volumes="$(fly volumes list -a "$APP" 2>/dev/null || true)"
if grep -q "$VOLUME" <<<"$volumes"; then
  echo "exists, skipping"
else
  fly volumes create "$VOLUME" -a "$APP" --region "$REGION" --size 1 --yes
fi

# ---- secrets ------------------------------------------------------------------------------------------------
step "Secrets"
names=(XAI_API_KEY MCP_TOKEN PUBLIC_URL ADMIN_TOKEN)
if [ "$CHANNEL" = telegram ]; then names+=(TELEGRAM_BOT_TOKEN TELEGRAM_BOT_USERNAME); else names+=(SPECTRUM_PROJECT_ID SPECTRUM_PROJECT_SECRET); fi
[ -n "$PHOTON_NUMBER" ] && names+=(PHOTON_NUMBER)
[ -n "$VOICE_WEBHOOK_SECRET" ] && names+=(VOICE_WEBHOOK_SECRET)
# Google Calendar: the OAuth client's redirect URI must be $PUBLIC_URL/google/callback (see the Google Calendar section in DESIGN.md).
[ -n "$GOOGLE_CLIENT_ID" ] && names+=(GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET)
# Buying on Amazon (optional): the treasury key, the session, and the knobs that are set.
[ -n "$TREASURY_PRIVATE_KEY" ] && names+=(TREASURY_PRIVATE_KEY)
[ -n "$AMAZON_STORAGE_STATE" ] && names+=(AMAZON_STORAGE_STATE)
# Calling Jarvis (optional): the OpenAI key, Twilio's auth token and the number; after the deploy, scripts/twilio-setup.sh points the number here.
[ -n "$OPENAI_API_KEY" ] && names+=(OPENAI_API_KEY TWILIO_AUTH_TOKEN TWILIO_PHONE_NUMBER)
for name in OPENAI_REALTIME_MODEL OPENAI_VOICE TWILIO_ACCOUNT_SID AMAZON_MERCHANT AMAZON_DRY_RUN PURCHASE_LIMIT_USD PURCHASE_SHIPS_TO OPERATOR_TAG OPERATOR_NAME; do
  [ -n "${!name}" ] && names+=("$name")
done
# Values go through stdin, never argv or the terminal. --stage: the deploy below picks them up.
for name in "${names[@]}"; do printf '%s=%s\n' "$name" "${!name}"; done | fly secrets import -a "$APP" --stage >/dev/null
echo "staged: ${names[*]}"

# ---- deploy -------------------------------------------------------------------------------------------------
step "Deploy"
# Only one server may hold the channel (the Spectrum stream, or a bot token's long poll): the one on this Mac has to be stopped first.
if [ "${FORCE:-0}" != 1 ] && { lsof -nP -iTCP:7788 -sTCP:LISTEN >/dev/null 2>&1 || pgrep -f "tsx src/index.ts" >/dev/null 2>&1; }; then
  die "a local AgentSign server is still running (port 7788 or 'tsx src/index.ts'). Stop it first (Ctrl-C in its terminal): two servers on one channel both answer every message. FORCE=1 skips this check."
fi
fly deploy -a "$APP" --ha=false
fly scale count 1 -a "$APP" --yes

# ---- verify -------------------------------------------------------------------------------------------------
step "Checking $PUBLIC_URL"
code=""
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$PUBLIC_URL/sign/nope" || true)"
  [ "$code" = 404 ] && break
  sleep 2
done
[ "$code" = 404 ] || die "$PUBLIC_URL/sign/nope answered ${code:-nothing}, expected 404; see fly logs -a $APP"
echo "ok: the approval page answers ($PUBLIC_URL/sign/nope -> 404)"
if [ "$CHANNEL" = telegram ]; then hello="Open @$bot in Telegram and say hi."; else hello="Text Jarvis${PHOTON_NUMBER:+ at $PHOTON_NUMBER} on iMessage and say hi."; fi
echo "$hello Following the logs (Ctrl-C to stop; the app keeps running):"

step "Logs"
exec fly logs -a "$APP"
