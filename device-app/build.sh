#!/usr/bin/env bash
# Builds the app for the Nano S Plus in the Ledger dev-tools image.
#
#   device-app/build.sh        build against the image's C SDK (API level 27)
#   device-app/build.sh 26     build against the C SDK branch API_LEVEL_26 (Nano S Plus OS 1.6.x)
#
# Output (always the same place): device-app/target/nanosplus/release/agentsign  (+ .hex, .apdu, .sha256)
set -euo pipefail
cd "$(dirname "$0")"
IMAGE="${IMAGE:-ghcr.io/ledgerhq/ledger-app-builder/ledger-app-dev-tools:latest}"
API_LEVEL="${1:-}"

if [[ -z "$API_LEVEL" ]]; then
  script='cargo ledger build nanosplus'
else
  script="git clone -q --depth 1 -b API_LEVEL_$API_LEVEL https://github.com/LedgerHQ/ledger-secure-sdk.git /tmp/c-sdk && LEDGER_SDK_PATH=/tmp/c-sdk cargo ledger build nanosplus"
fi

# The named volume caches crates.io downloads between runs.
docker run --rm -v agentsign-cargo:/opt/.cargo/registry -v "$PWD:/app" -w /app "$IMAGE" bash -c "$script" 2>&1 | grep -v 'cargo:warning'
echo "ELF: $PWD/target/nanosplus/release/agentsign"
