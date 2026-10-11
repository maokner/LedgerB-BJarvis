# AgentSign APDU protocol

Ledger Nano S Plus app "AgentSign", version 0.1.0.
Every command uses CLA `0xE0`.
Short APDUs only: `CLA INS P1 P2 Lc data`, at most 255 data bytes.
A response is `data || SW1 SW2`.

## Key

Ed25519, derived with SLIP-0010 on `m/44'/8008'/0'/0'/0'` (every level hardened, as SLIP-0010 requires for Ed25519).
The app manifest allows the curve `ed25519` and the path prefix `44'/8008'`.
The public key is the standard 32-byte RFC 8032 encoding, the same bytes as Node's `jwk.x` and Python's `public_bytes_raw()`.

## Commands

| INS | Name | P1 | P2 | Data in | Data out |
|---|---|---|---|---|---|
| `0x01` | GET_VERSION | `0x00` | `0x00` | none | 3 bytes: major, minor, patch |
| `0x02` | GET_PUBKEY | `0x00` | `0x00` | none | 32-byte Ed25519 public key (no confirmation on the device) |
| `0x03` | SIGN_ACTION | `0x00` first chunk, `0x80` next chunk | `0x80` more chunks follow, `0x00` last chunk | a chunk of the action bytes | on the last chunk: 64-byte Ed25519 signature |

The BOLOS command `B0 01 00 00 00` (app name and version) is answered by the OS/SDK, not by this app.
The TypeScript client uses it to skip devices that are in the dashboard or in another app.

### SIGN_ACTION

The action bytes are the canonical encoding from `src/actions.ts`, at most 516 bytes:

```
"AGS1" | code (3 ASCII) | id (16 bytes) | N (1..6) | N x (label_len 1..16, label, value_len 1..64, value)
```

Labels and values are printable ASCII (`0x20..0x7E`).
No trailing bytes are allowed.

Upload:

1. Split the bytes into chunks of 255 bytes (the last one may be shorter).
2. Send the first chunk with P1 `0x00`; this discards any earlier unfinished upload.
3. Send each later chunk with P1 `0x80`.
4. Every chunk but the last has P2 `0x80` and is answered `9000` with no data.
5. The last chunk has P2 `0x00`.

On the last chunk the app parses the bytes.
If they are malformed (bad magic, unknown code, 0 or more than 6 fields, a length out of range, a non-printable byte, truncated, trailing bytes, more than 516 bytes) it answers `6A80` and shows nothing.
Otherwise it shows the review and the APDU stays pending until the person answers:

1. The title for the code, with an eye icon: `PAY` Send money, `CAL` Add to calendar, `FRQ` Friend request, `FAC` Accept friend, `ACC` Create account.
2. One page per field: the label as the page title, the value as the body, 3 lines per page; longer values get pages `Label (1/2)`, `Label (2/2)`.
   Lines break between words (at most 16 characters per line); only a word longer than a line is cut.
   This is display only: the app signs the raw bytes, and a run of spaces shows as one space.
3. Approve (check icon), then Reject (cross icon).

Right and left buttons move between pages; both buttons on Approve or Reject decide.
Approve signs `sha256(action bytes)` with Ed25519 (RFC 8032, the 32-byte digest is the message) and answers the 64-byte signature with `9000`.
Reject answers `6985`.
Either way the app returns to the idle screen.

## Status words

| SW | Meaning |
|---|---|
| `9000` | OK |
| `6985` | The person rejected the action |
| `6A80` | Malformed action, chunk out of order (P1 `0x80` without a first chunk), or more than 516 bytes |
| `6A86` | P1 or P2 not allowed for this INS |
| `6D00` | Unknown INS |
| `6E00` | CLA is not `0xE0` |
| `6F00` | Internal error (key derivation or signing failed) |
| `5515` | The device is locked (answered by the SDK) |

## Examples

GET_VERSION:

```
=> E0 01 00 00 00
<= 00 01 00 90 00
```

GET_PUBKEY (Speculos default seed):

```
=> E0 02 00 00 00
<= 6d4ee313f1a650839276333bc1a5a3b94363ce32c2f28151e4539edea07d6100 90 00
```

SIGN_ACTION for `PAY` with `To @gabriel`, `Amount $5.00` (49 bytes, one chunk):

```
=> E0 03 00 00 31
   41475331                           "AGS1"
   504159                             "PAY"
   00112233445566778899aabbccddeeff   id
   02                                 2 fields
   02 546f 08 406761627269656c        "To" "@gabriel"
   06 416d6f756e74 05 24352e3030      "Amount" "$5.00"
<= <64-byte signature> 90 00          approved
<= 69 85                              rejected
```

The largest action (516 bytes) goes as `E0 03 00 80 FF ...`, `E0 03 80 80 FF ...`, `E0 03 80 00 06 ...`.

## Verifying

```ts
import { verifyActionSignature } from "./src/actions.js";
verifyActionSignature(pubkeyHex, action, signatureHex); // crypto.verify(null, sha256(bytes), key, sig)
```

## Notes

- While a review is on screen the app does not read other APDUs, so a second command to the same device hangs until the person answers.
  The TypeScript `DeviceManager` keeps one pending request per device for this reason.
- If the host gives up (timeout), the review stays on the device until someone presses Approve or Reject.
