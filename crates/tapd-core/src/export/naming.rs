//! Filesystem naming for export directories.
//!
//! Kept apart from the Markdown rendering: the document content must stay
//! stable even when the on-disk naming rules change.

/// Short, filesystem-safe slug used in export directory names.
///
/// ASCII-only on purpose: TAPD titles are usually Chinese, and non-ASCII paths
/// break on some Windows toolchains. The full title still lives in `bug.md`,
/// so the directory only needs to be short and unique. Returns an empty string
/// when the title has no usable ASCII characters, letting the caller fall back
/// to the bug id.
pub fn ascii_slug(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;

    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
        if slug.len() >= 40 {
            break;
        }
    }

    slug.trim_matches('-').to_string()
}
