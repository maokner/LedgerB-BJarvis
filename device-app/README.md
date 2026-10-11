# AgentSign Ledger app (Nano S Plus)

A small Rust app built on `ledger_device_sdk` 1.41 with the BAGL button UI.
It shows an AgentSign action (title, then one page per field, then Approve and Reject) and signs `sha256(action bytes)` with Ed25519 on `m/44'/8008'/0'/0'/0'`.
The APDU spec is in [PROTOCOL.md](PROTOCOL.md).

| File | What |
|---|---|
| `src/main.rs` | APDU loop, idle menu, review flow, key derivation and signing |
| `src/action.rs` | parser for the action bytes (same layout as `src/actions.ts`) |
| `Cargo.toml` | app metadata: name, curve `ed25519`, path `44'/8008'`, flags, icon |
| `icons/agentsign_14x14.gif` | 14x14 1-bit app icon |
| `tests/test_agentsign.py` | pytest against Speculos |

Everything runs in the Ledger dev-tools image, so nothing needs installing on the Mac:

```sh
docker pull ghcr.io/ledgerhq/ledger-app-builder/ledger-app-dev-tools:latest
```

## Build

```sh
device-app/build.sh
```

This runs `cargo ledger build nanosplus` in the image.
The ELF is always at `device-app/target/nanosplus/release/agentsign`, next to `agentsign.hex`, `agentsign.apdu` (for sideloading) and `agentsign.sha256` (the app identifier the device shows when installing).

The image's C SDK targets API level 27.
A Nano S Plus on OS 1.6.x needs API level 26: build with `device-app/build.sh 26` (same output path).

## Run in Speculos

```sh
scripts/speculos.sh        # "matt" APDU 9999 / http://127.0.0.1:5000, "yadu" APDU 9998 / http://127.0.0.1:5001
scripts/speculos.sh stop
```

The web UI on the API port shows the screen and has buttons.
Use `DEVICES=speculos:127.0.0.1:9999,speculos:127.0.0.1:9998` for the Node app.

| Emulator | Seed | AgentSign pubkey |
|---|---|---|
| matt | Speculos default (`glory promote mansion ...`) | `6d4ee313f1a650839276333bc1a5a3b94363ce32c2f28151e4539edea07d6100` |
| yadu | `abandon x11 about` | `da6892c50bd7d9caebf97b4a5296a081cb843278251e790f34ae48750d37c6ec` |

## Test

The pytest starts its own Speculos inside one container, installs pytest (the image does not ship it), and runs:

```sh
cd device-app
docker run --rm -v "$PWD:/app" -w /app ghcr.io/ledgerhq/ledger-app-builder/ledger-app-dev-tools:latest bash tests/run.sh
```

It checks the version, that the pubkey equals an independent SLIP-0010 derivation from the seed, an approved `PAY` (screen text read through `/events`, signature verified with `cryptography`), the largest 516-byte action in three chunks, a rejection (`6985`), eleven malformed actions (`6A80`, nothing displayed) and protocol errors.

The TypeScript client has its own test against `scripts/speculos.sh`; it verifies the signature with Node's `crypto.verify` through `verifyActionSignature`:

```sh
scripts/speculos.sh
SPECULOS_APDU_PORT=9999 SPECULOS_API_PORT=5000 pnpm vitest run test/device-speculos.test.ts
```

## Real device

`scripts/sideload.sh` loads the app over USB from the Mac (Docker cannot reach USB on macOS).
The device must be unlocked on the dashboard, and the person confirms "Allow unsafe manager" and "Install app" on it.
Read the script header before running it.
