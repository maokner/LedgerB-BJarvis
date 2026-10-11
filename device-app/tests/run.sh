#!/usr/bin/env bash
# Runs inside the ledger-app-dev-tools image (see device-app/README.md): starts Speculos with the built
# app, installs pytest (the image ships without it), runs the tests, prints the Speculos log on failure.
set -uo pipefail
cd "$(dirname "$0")/.."
export PYTHONDONTWRITEBYTECODE=1
speculos --model nanosp --display headless --apdu-port 9999 --api-port 5000 "${ELF:-target/nanosplus/release/agentsign}" >/tmp/speculos.log 2>&1 &
/opt/venv/bin/pip install -q pytest >/dev/null 2>&1
/opt/venv/bin/python -m pytest -q -p no:cacheprovider tests "$@"
status=$?
[ $status -ne 0 ] && tail -20 /tmp/speculos.log
exit $status
