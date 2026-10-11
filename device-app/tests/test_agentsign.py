"""End-to-end tests for the AgentSign app against a running Speculos (Nano S Plus).

Talks raw TCP to the Speculos APDU port (4-byte big-endian length framing) and drives the buttons and
reads the screen through the Speculos REST API. See device-app/README.md for how to run it.

Environment:
  SPECULOS_HOST       default 127.0.0.1
  SPECULOS_APDU_PORT  default 9999
  SPECULOS_API_PORT   default 5000
  SPECULOS_SEED       the mnemonic Speculos runs with (default: Speculos's default seed)
"""

import hashlib
import hmac
import json
import os
import socket
import struct
import threading
import time
import urllib.request

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

HOST = os.environ.get("SPECULOS_HOST", "127.0.0.1")
APDU_PORT = int(os.environ.get("SPECULOS_APDU_PORT", "9999"))
API = f"http://{HOST}:{os.environ.get('SPECULOS_API_PORT', '5000')}"
DEFAULT_SEED = (
    "glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle "
    "enact monster seven myth punch hobby comfort wild raise skin"
)
SEED = os.environ.get("SPECULOS_SEED", DEFAULT_SEED)
PATH = [44, 8008, 0, 0, 0]  # all hardened

SW_OK, SW_DENY, SW_BAD_DATA, SW_BAD_P1P2 = 0x9000, 0x6985, 0x6A80, 0x6A86


# --- transport -----------------------------------------------------------------------------------


def exchange(apdu: bytes, timeout: float = 60) -> tuple[bytes, int]:
    """Send one APDU, return (data, status word)."""
    with socket.create_connection((HOST, APDU_PORT), timeout=timeout) as s:
        s.sendall(struct.pack(">I", len(apdu)) + apdu)

        def recv(n: int) -> bytes:
            out = b""
            while len(out) < n:
                chunk = s.recv(n - len(out))
                assert chunk, "Speculos closed the connection"
                out += chunk
            return out

        length = struct.unpack(">I", recv(4))[0]
        body = recv(length + 2)
    return body[:-2], int.from_bytes(body[-2:], "big")


def apdu(ins: int, p1: int = 0, p2: int = 0, data: bytes = b"") -> bytes:
    return bytes([0xE0, ins, p1, p2, len(data)]) + data


def sign_action(action: bytes) -> tuple[bytes, int]:
    """Upload in 255-byte chunks (P1 0x00 first / 0x80 next, P2 0x80 more / 0x00 last)."""
    chunks = [action[i : i + 255] for i in range(0, len(action), 255)] or [b""]
    for i, chunk in enumerate(chunks):
        last = i == len(chunks) - 1
        data, sw = exchange(apdu(0x03, 0x00 if i == 0 else 0x80, 0x00 if last else 0x80, chunk), timeout=120)
        if not last and sw != SW_OK:
            return data, sw
    return data, sw


# --- Speculos REST API ---------------------------------------------------------------------------


def screen_text() -> str:
    with urllib.request.urlopen(f"{API}/events?currentscreenonly=true", timeout=5) as r:
        return " | ".join(e["text"].strip() for e in json.load(r).get("events", []))


def press(button: str) -> None:
    body = json.dumps({"action": "press-and-release"}).encode()
    req = urllib.request.Request(f"{API}/button/{button}", data=body, method="POST", headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=5).read()


def wait_screen(predicate, timeout: float = 5.0) -> str:
    deadline = time.time() + timeout
    text = screen_text()
    while not predicate(text) and time.time() < deadline:
        time.sleep(0.1)
        text = screen_text()
    return text


def review(action: bytes, approve: bool) -> tuple[bytes, int, list[str]]:
    """Send the action, walk every review page with the right button, then approve or reject.
    Returns (data, sw, texts of every page seen)."""
    result: dict = {}
    worker = threading.Thread(target=lambda: result.update(r=sign_action(action)))
    worker.start()
    pages = [wait_screen(lambda t: "ready" not in t and t.strip() != "")]
    for _ in range(30):
        if "Approve" in pages[-1]:
            break
        before = pages[-1]
        press("right")
        pages.append(wait_screen(lambda t: t != before))
    assert "Approve" in pages[-1], pages
    if not approve:
        press("right")
        pages.append(wait_screen(lambda t: "Reject" in t))
    press("both")
    worker.join(timeout=30)
    assert "r" in result, "no APDU response after the decision"
    wait_screen(lambda t: "ready" in t)
    data, sw = result["r"]
    return data, sw, pages


# --- helpers -------------------------------------------------------------------------------------


def encode_action(code: str, action_id: bytes, fields: list[tuple[str, str]]) -> bytes:
    """Same layout as src/actions.ts encodeAction()."""
    out = b"AGS1" + code.encode() + action_id + bytes([len(fields)])
    for label, value in fields:
        out += bytes([len(label)]) + label.encode() + bytes([len(value)]) + value.encode()
    return out


def slip10_ed25519(mnemonic: str, path: list[int]) -> bytes:
    seed = hashlib.pbkdf2_hmac("sha512", mnemonic.encode(), b"mnemonic", 2048)
    digest = hmac.new(b"ed25519 seed", seed, hashlib.sha512).digest()
    key, chain = digest[:32], digest[32:]
    for index in path:
        data = b"\x00" + key + struct.pack(">I", index | 0x80000000)
        digest = hmac.new(chain, data, hashlib.sha512).digest()
        key, chain = digest[:32], digest[32:]
    return key


@pytest.fixture(scope="session")
def pubkey() -> bytes:
    deadline = time.time() + 30
    while True:
        try:
            data, sw = exchange(apdu(0x02))
            break
        except OSError:
            if time.time() > deadline:
                raise
            time.sleep(0.5)
    assert sw == SW_OK and len(data) == 32
    wait_screen(lambda t: "ready" in t, timeout=10)
    return data


PAY = encode_action("PAY", bytes(range(16)), [("To", "@gabriel"), ("Amount", "$5.00"), ("Memo", "lunch")])


# --- tests ---------------------------------------------------------------------------------------


def test_version():
    assert exchange(apdu(0x01)) == (bytes([0, 1, 0]), SW_OK)


def test_pubkey_is_slip10_on_agentsign_path(pubkey):
    expected = Ed25519PrivateKey.from_private_bytes(slip10_ed25519(SEED, PATH)).public_key().public_bytes_raw()
    assert pubkey == expected


def test_pay_approved_and_signature_verifies(pubkey):
    signature, sw, pages = review(PAY, approve=True)
    assert sw == SW_OK and len(signature) == 64
    Ed25519PublicKey.from_public_bytes(pubkey).verify(signature, hashlib.sha256(PAY).digest())
    seen = " | ".join(pages)
    for text in ["Send money", "To", "@gabriel", "Amount", "$5.00", "Memo", "lunch", "Approve"]:
        assert text in seen, f"{text!r} not shown; pages: {seen}"


def test_largest_action_uses_three_chunks(pubkey):
    fields = [(f"Label{i}".ljust(16, "x"), chr(ord("a") + i) * 64) for i in range(6)]
    action = encode_action("CAL", bytes([0xAB] * 16), fields)
    assert len(action) == 516
    signature, sw, pages = review(action, approve=True)
    assert sw == SW_OK
    Ed25519PublicKey.from_public_bytes(pubkey).verify(signature, hashlib.sha256(action).digest())
    assert "Add to calendar" in pages[0]


def test_values_wrap_between_words(pubkey):
    action = encode_action("CAL", bytes(16), [("Title", "Dentist appointment"), ("When", "Sun Oct 11 13:00-14:00")])
    signature, sw, pages = review(action, approve=True)
    assert sw == SW_OK
    Ed25519PublicKey.from_public_bytes(pubkey).verify(signature, hashlib.sha256(action).digest())
    seen = " | ".join(pages)
    assert "Dentist | appointment" in seen, seen  # one word per line, not "Dentist appointme | nt"
    assert "Oct 11 | 13:00-14:00" in seen, seen


def test_reject_returns_6985(pubkey):
    data, sw, pages = review(encode_action("FRQ", bytes(16), [("To", "@yadu")]), approve=False)
    assert (data, sw) == (b"", SW_DENY)
    assert "Friend request" in pages[0] and "@yadu" in " ".join(pages) and "Reject" in pages[-1]


MALFORMED = {
    "bad magic": b"AGS2" + PAY[4:],
    "unknown code": PAY[:4] + b"XYZ" + PAY[7:],
    "zero fields": encode_action("PAY", bytes(16), []),
    "seven fields": encode_action("PAY", bytes(16), [("To", "@x")] * 7),
    "empty label": encode_action("PAY", bytes(16), [("", "@x")]),
    "label too long": encode_action("PAY", bytes(16), [("L" * 17, "@x")]),
    "value too long": encode_action("PAY", bytes(16), [("To", "v" * 65)]),
    "non printable": encode_action("PAY", bytes(16), [("To", "@x\n")]),
    "trailing byte": PAY + b"\x00",
    "truncated": PAY[:-1],
    "too short": b"AGS1PAY",
}


@pytest.mark.parametrize("name", MALFORMED)
def test_malformed_action_is_refused_without_display(pubkey, name):
    data, sw = sign_action(MALFORMED[name])
    assert (data, sw) == (b"", SW_BAD_DATA)
    assert "ready" in screen_text()


def test_protocol_errors(pubkey):
    assert exchange(apdu(0x03, 0x80, 0x00, PAY))[1] == SW_BAD_DATA  # continuation without a first chunk
    assert exchange(apdu(0x03, 0x01, 0x00, PAY))[1] == SW_BAD_P1P2
    assert exchange(apdu(0x7F))[1] == 0x6D00
    assert exchange(bytes([0xE1, 0x01, 0, 0, 0]))[1] == 0x6E00
