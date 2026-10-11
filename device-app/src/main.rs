//! AgentSign: shows an AgentSign action on a Nano S Plus and signs it with Ed25519.
//! APDU spec: PROTOCOL.md. Byte layout of an action: src/actions.ts in the repo root.

#![no_std]
#![no_main]

extern crate alloc;

mod action;
mod wrap;

use action::{parse_action, MAX_ACTION_BYTES, MAX_FIELDS};
use alloc::string::String;
use ledger_device_sdk::ecc::{make_bip32_path, Ed25519};
use ledger_device_sdk::hash::{sha2::Sha2_256, HashInit};
use ledger_device_sdk::include_gif;
use ledger_device_sdk::io::{ApduHeader, Comm, Event, Reply};
use ledger_device_sdk::ui::bitmaps::{Glyph, CHECKMARK, CROSSMARK, DASHBOARD_X, EYE};
use ledger_device_sdk::ui::gadgets::{EventOrPageIndex, Field, MultiFieldReview, MultiPageMenu, Page};

ledger_device_sdk::set_panic!(ledger_device_sdk::exiting_panic);

/// SLIP-0010 Ed25519 path m/44'/8008'/0'/0'/0' (all hardened, as SLIP-0010 requires for Ed25519).
const PATH: [u32; 5] = make_bip32_path(b"m/44'/8008'/0'/0'/0'");

const SW_OK: u16 = 0x9000;
const SW_DENY: u16 = 0x6985;
const SW_BAD_DATA: u16 = 0x6A80;
const SW_BAD_P1P2: u16 = 0x6A86;
const SW_BAD_INS: u16 = 0x6D00;
const SW_INTERNAL: u16 = 0x6F00;

/// SIGN_ACTION chunk flags (see PROTOCOL.md).
const P1_FIRST: u8 = 0x00;
const P1_NEXT: u8 = 0x80;
const P2_LAST: u8 = 0x00;
const P2_MORE: u8 = 0x80;

enum Ins {
    GetVersion,
    GetPubkey,
    SignAction { first: bool, more: bool },
}

impl TryFrom<ApduHeader> for Ins {
    type Error = Reply;
    fn try_from(h: ApduHeader) -> Result<Self, Reply> {
        match (h.ins, h.p1, h.p2) {
            (0x01, 0, 0) => Ok(Ins::GetVersion),
            (0x02, 0, 0) => Ok(Ins::GetPubkey),
            (0x03, P1_FIRST | P1_NEXT, P2_LAST | P2_MORE) => Ok(Ins::SignAction { first: h.p1 == P1_FIRST, more: h.p2 == P2_MORE }),
            (0x01..=0x03, _, _) => Err(Reply(SW_BAD_P1P2)),
            _ => Err(Reply(SW_BAD_INS)),
        }
    }
}

/// The action being uploaded. `len == None` means no upload is in progress.
struct Upload {
    data: [u8; MAX_ACTION_BYTES],
    len: Option<usize>,
}

#[no_mangle]
extern "C" fn sample_main(_arg0: u32) {
    let mut comm = Comm::new().set_expected_cla(0xE0);
    let mut upload = Upload { data: [0; MAX_ACTION_BYTES], len: None };
    loop {
        let Event::Command(ins) = idle_menu(&mut comm) else { continue };
        match handle(&mut comm, ins, &mut upload) {
            Ok(()) => comm.reply(Reply(SW_OK)),
            Err(sw) => comm.reply(Reply(sw)),
        }
    }
}

/// "AgentSign / is ready", "Version", "Quit". Returns as soon as an APDU arrives.
fn idle_menu(comm: &mut Comm) -> Event<Ins> {
    const ICON: Glyph = Glyph::from_include(include_gif!("icons/agentsign_14x14.gif"));
    let ready = Page::from((["AgentSign", "is ready"], &ICON));
    let version = Page::from((["Version", env!("CARGO_PKG_VERSION")], true, true));
    let quit = Page::from(("Quit", &DASHBOARD_X));
    let pages = [&ready, &version, &quit];
    loop {
        match MultiPageMenu::new(comm, &pages).show() {
            EventOrPageIndex::Event(event) => return event,
            EventOrPageIndex::Index(2) => ledger_device_sdk::exit_app(0),
            EventOrPageIndex::Index(_) => {}
        }
    }
}

fn handle(comm: &mut Comm, ins: Ins, upload: &mut Upload) -> Result<(), u16> {
    match ins {
        Ins::GetVersion => {
            comm.append(&[version_part(0), version_part(1), version_part(2)]);
            Ok(())
        }
        Ins::GetPubkey => {
            comm.append(&public_key()?);
            Ok(())
        }
        Ins::SignAction { first, more } => {
            let chunk = comm.get_data().map_err(|_| SW_BAD_DATA)?;
            let start = match (first, upload.len) {
                (true, _) => 0,
                (false, Some(len)) => len,
                (false, None) => return Err(SW_BAD_DATA),
            };
            upload.len = None;
            let end = start + chunk.len();
            if end > MAX_ACTION_BYTES {
                return Err(SW_BAD_DATA);
            }
            upload.data[start..end].copy_from_slice(chunk);
            if more {
                upload.len = Some(end);
                return Ok(());
            }
            let signature = review_and_sign(&upload.data[..end])?;
            comm.append(&signature);
            Ok(())
        }
    }
}

/// Parses, shows the review flow, and signs sha256(bytes) if the person approves.
fn review_and_sign(bytes: &[u8]) -> Result<[u8; 64], u16> {
    let action = parse_action(bytes).ok_or(SW_BAD_DATA)?;
    // Display copies wrapped at word boundaries; `bytes` (what gets signed) is untouched.
    let values: [String; MAX_FIELDS] = core::array::from_fn(|i| match i < action.count {
        true => wrap::wrap_for_display(action.fields[i].1),
        false => String::new(),
    });
    let mut fields: [Field; MAX_FIELDS] = core::array::from_fn(|_| Field { name: "", value: "" });
    for (i, slot) in fields.iter_mut().enumerate().take(action.count) {
        *slot = Field { name: action.fields[i].0, value: values[i].as_str() };
    }
    let title = [action.title];
    let review = MultiFieldReview::new(
        &fields[..action.count],
        &title,
        Some(&EYE),
        "Approve",
        Some(&CHECKMARK),
        "Reject",
        Some(&CROSSMARK),
    );
    if !review.show() {
        return Err(SW_DENY);
    }

    let mut digest = [0u8; 32];
    Sha2_256::new().hash(bytes, &mut digest).map_err(|_| SW_INTERNAL)?;
    let key = Ed25519::derive_from_path_slip10(&PATH);
    let (signature, _len) = key.sign(&digest).map_err(|_| SW_INTERNAL)?;
    Ok(signature)
}

/// 32-byte Ed25519 public key (RFC 8032 encoding) for PATH.
fn public_key() -> Result<[u8; 32], u16> {
    let key = Ed25519::derive_from_path_slip10(&PATH);
    let point = key.public_key().map_err(|_| SW_INTERNAL)?;
    // point.pubkey is 0x04 | X (32 bytes, big-endian) | Y (32 bytes, big-endian).
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = point.pubkey[64 - i];
    }
    if point.pubkey[32] & 1 == 1 {
        out[31] |= 0x80;
    }
    Ok(out)
}

fn version_part(index: usize) -> u8 {
    let mut parts = env!("CARGO_PKG_VERSION").split('.');
    parts.nth(index).and_then(|p| p.parse().ok()).unwrap_or(0)
}
