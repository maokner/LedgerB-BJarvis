//! Word wrapping for the review screens. Display only: the signed bytes are never changed.
//!
//! The SDK's field page cuts a value every 17 bytes, 3 lines per page, and centers each line. We
//! wrap at word boundaries to at most 16 characters per line, then pad every line but the last to
//! exactly 17 with spaces split evenly on both sides, so the SDK's cuts land on our line breaks and
//! each line stays centered. The last line gets no padding; since it is 1..16 long, the total is
//! never a multiple of 17 * 3, which avoids the SDK showing an empty extra page.

use alloc::string::String;

const SDK_LINE: usize = 17;
const WRAP: usize = SDK_LINE - 1;

pub fn wrap_for_display(value: &str) -> String {
    let mut lines: [(usize, usize); 16] = [(0, 0); 16]; // (start, end) byte ranges into `joined`
    let mut joined = String::new(); // words separated by single spaces
    let mut count = 0;
    let mut line_start = 0;
    for word in value.split(' ').filter(|w| !w.is_empty()) {
        let mut word = word;
        while !word.is_empty() {
            let line_len = joined.len() - line_start;
            let sep = if line_len > 0 { 1 } else { 0 };
            if line_len + sep + word.len() <= WRAP {
                if sep == 1 {
                    joined.push(' ');
                }
                joined.push_str(word);
                word = "";
            } else if line_len > 0 {
                // Close this line; the word starts the next one.
                if count == lines.len() {
                    return String::from(value);
                }
                lines[count] = (line_start, joined.len());
                count += 1;
                line_start = joined.len();
            } else {
                // A single word longer than a line: hard split.
                joined.push_str(&word[..WRAP]);
                word = &word[WRAP..];
                if count == lines.len() {
                    return String::from(value);
                }
                lines[count] = (line_start, joined.len());
                count += 1;
                line_start = joined.len();
            }
        }
    }
    if joined.len() > line_start {
        if count == lines.len() {
            return String::from(value);
        }
        lines[count] = (line_start, joined.len());
        count += 1;
    }
    if count == 0 {
        return String::from(value);
    }
    let mut out = String::new();
    for (i, &(start, end)) in lines[..count].iter().enumerate() {
        let text = &joined[start..end];
        if i + 1 == count {
            out.push_str(text);
        } else {
            let pad = SDK_LINE - text.len();
            push_spaces(&mut out, pad / 2);
            out.push_str(text);
            push_spaces(&mut out, pad - pad / 2);
        }
    }
    out
}

fn push_spaces(out: &mut String, n: usize) {
    for _ in 0..n {
        out.push(' ');
    }
}
