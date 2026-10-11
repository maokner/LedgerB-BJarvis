#!/usr/bin/env bash
# Start two Speculos emulators (Nano S Plus) running the AgentSign app, one per demo person.
#
#   scripts/speculos.sh          start "matt" (APDU 9999, API 5000) and "yadu" (APDU 9998, API 5001)
#   scripts/speculos.sh stop     stop both
#
# Needs the app built first (see device-app/README.md): device-app/target/nanosplus/release/agentsign
# Then: DEVICES=speculos:127.0.0.1:9999,speculos:127.0.0.1:9998
set -euo pipefail

IMAGE="${SPECULOS_IMAGE:-ghcr.io/ledgerhq/ledger-app-builder/ledger-app-dev-tools:latest}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELF_DIR="$ROOT/device-app/target/nanosplus/release"

SEED_MATT="glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle enact monster seven myth punch hobby comfort wild raise skin"
SEED_YADU="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

stop() {
  for name in matt yadu; do
    docker rm -f "agentsign-speculos-$name" >/dev/null 2>&1 || true
  done
}

start_one() { # name apdu_port api_port seed
  docker run -d --rm --name "agentsign-speculos-$1" \
    -p "127.0.0.1:$2:$2" -p "127.0.0.1:$3:$3" \
    -v "$ELF_DIR:/elf:ro" \
    "$IMAGE" \
    speculos --model nanosp --display headless --seed "$4" \
      --apdu-port "$2" --api-port "$3" /elf/agentsign >/dev/null
}

wait_ready() { # api_port
  for _ in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:$1/events" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "Speculos on API port $1 did not come up; see: docker logs agentsign-speculos-..." >&2
  return 1
}

if [[ "${1:-start}" == "stop" ]]; then
  stop
  echo "Stopped both Speculos emulators."
  exit 0
fi

if [[ ! -f "$ELF_DIR/agentsign" ]]; then
  echo "Missing $ELF_DIR/agentsign. Build it first (device-app/README.md)." >&2
  exit 1
fi

stop
start_one matt 9999 5000 "$SEED_MATT"
start_one yadu 9998 5001 "$SEED_YADU"
wait_ready 5000
wait_ready 5001

echo "matt: APDU 127.0.0.1:9999  screen and buttons: http://127.0.0.1:5000"
echo "yadu: APDU 127.0.0.1:9998  screen and buttons: http://127.0.0.1:5001"
echo "DEVICES=speculos:127.0.0.1:9999,speculos:127.0.0.1:9998"
echo "Stop with: scripts/speculos.sh stop"
