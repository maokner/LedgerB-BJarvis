#!/usr/bin/env bash
# Loads the AgentSign app onto a real Ledger Nano S Plus over USB. Run it on the Mac itself (Docker on
# macOS cannot reach USB devices). Not run by any test.
#
# Before: build it (device-app/build.sh). The device must be unlocked and on the dashboard (no app open).
# Plug in only the Nano you want to load (ledgerblue talks to the first one it finds).
#
# On the device you will be asked to confirm, with both buttons:
#   1. "Allow unsafe manager" (this script is not Ledger Live),
#   2. "Install app AgentSign" with an identifier: it must match device-app/target/nanosplus/release/agentsign.sha256.
# The first time you open the app the device also warns that it is not a genuine Ledger app; continue past it.
#
# The device OS must match the API level the app was built for (check Settings > About on the device):
#   device-app/build.sh     -> API level 27, the newest C SDK, for OS versions after 1.6.x
#   device-app/build.sh 26  -> API level 26, Nano S Plus OS 1.6.0 (see api_levels.json in the C SDK)
# If the API level is wrong the load fails with an error status and nothing is installed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APDU="$ROOT/device-app/target/nanosplus/release/agentsign.apdu"
VENV="${LEDGERBLUE_VENV:-$HOME/.cache/agentsign-ledgerblue}"

[[ -f "$APDU" ]] || { echo "Missing $APDU; run device-app/build.sh first." >&2; exit 1; }
if [[ ! -x "$VENV/bin/python" ]]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q "ledgerblue==0.1.58"
fi

echo "Loading AgentSign (identifier $(cat "${APDU%.apdu}.sha256" 2>/dev/null || echo unknown)). Confirm on the device."
# Same command `cargo ledger build nanosplus --load` runs (0x33100004 = Nano S Plus).
"$VENV/bin/python" -m ledgerblue.runScript --targetId 0x33100004 --fileName "$APDU" --apdu --scp
echo "Done. Open AgentSign on the device; it shows 'AgentSign / is ready'."
