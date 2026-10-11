//! Parser for the canonical action bytes. Must match src/actions.ts exactly:
//!
//!   "AGS1" | code (3 ASCII) | id (16 bytes) | N (1..6) | N x (label_len 1..16, label, value_len 1..64, value)
//!
//! Labels and values are printable ASCII (0x20..0x7E). No trailing bytes.

pub const MAX_FIELDS: usize = 6;
const MAX_LABEL: usize = 16;
const MAX_VALUE: usize = 64;
pub const MAX_ACTION_BYTES: usize = 24 + MAX_FIELDS * (1 + MAX_LABEL + 1 + MAX_VALUE);

const TITLES: [(&[u8; 3], &str); 5] = [
    (b"PAY", "Send money"),
    (b"CAL", "Add to calendar"),
    (b"FRQ", "Friend request"),
    (b"FAC", "Accept friend"),
    (b"ACC", "Create account"),
];

pub struct Action<'a> {
    pub title: &'static str,
    pub count: usize,
    /// (label, value) pairs; only the first `count` are set.
    pub fields: [(&'a str, &'a str); MAX_FIELDS],
}

/// Returns None for anything malformed: bad magic, unknown code, bad counts or lengths, non-printable text.
pub fn parse_action(bytes: &[u8]) -> Option<Action<'_>> {
    let mut reader = Reader { bytes, offset: 0 };
    if reader.take(4)? != b"AGS1" {
        return None;
    }
    let code = reader.take(3)?;
    let title = TITLES.iter().find(|(c, _)| &c[..] == code)?.1;
    reader.take(16)?; // action id: opaque, only hashed
    let count = reader.take(1)?[0] as usize;
    if count == 0 || count > MAX_FIELDS {
        return None;
    }
    let mut fields = [("", ""); MAX_FIELDS];
    for field in fields.iter_mut().take(count) {
        let label = reader.text(MAX_LABEL)?;
        let value = reader.text(MAX_VALUE)?;
        *field = (label, value);
    }
    if reader.offset != bytes.len() {
        return None;
    }
    Some(Action { title, count, fields })
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let out = self.bytes.get(self.offset..self.offset + n)?;
        self.offset += n;
        Some(out)
    }

    /// A length-prefixed printable ASCII string of 1..=max bytes.
    fn text(&mut self, max: usize) -> Option<&'a str> {
        let len = self.take(1)?[0] as usize;
        if len == 0 || len > max {
            return None;
        }
        let raw = self.take(len)?;
        if !raw.iter().all(|b| (0x20..=0x7E).contains(b)) {
            return None;
        }
        core::str::from_utf8(raw).ok()
    }
}
