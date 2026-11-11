//! Shared helpers for fetching and naming TAPD media.
//!
//! TAPD serves captures and attachments behind the web session, so every
//! downloader sends the same browser identity, referer and cookie. The
//! consumers differ in how they deliver the bytes: `commands::download_media`
//! and `export::download_one` buffer a file to disk, while `server::media_proxy`
//! buffers in memory and forwards `Range`/`206` responses. Keep those streaming
//! paths separate; only the constants and pure helpers are shared here.

use std::path::Path;

use tapd_core::export::MediaKind;

/// Browser identity TAPD expects for its HTML-scraped download endpoints.
pub const USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

/// TAPD rejects download requests without a same-site referer.
pub const REFERER: &str = "https://www.tapd.cn/";

/// Ceiling for downloads that are written straight to disk (`media-cache` and
/// bug exports). `commands` used 300 MB and `export` used 200 MB; both now use
/// the larger limit so an export can save the same video `open_media` caches.
pub const MAX_FILE_BYTES: u64 = 300 * 1024 * 1024;

/// The media proxy buffers the whole body in memory (it forwards `Range` and
/// sniffs the content type), so it keeps the lower 200 MB ceiling to bound peak
/// memory. Do not raise this without changing the proxy to stream.
pub const MAX_PROXY_BYTES: u64 = 200 * 1024 * 1024;

/// 64-bit FNV-1a, used to derive stable cache names from URLs and paths.
pub fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Turns a remote filename into an ASCII-only, filesystem-friendly one.
///
/// The extension is kept (also ASCII-only, max 8 characters) and the stem is
/// capped at 60 bytes so paths stay short and portable. A fully non-ASCII name
/// returns an empty string; callers substitute their own fallback.
pub fn sanitize_filename(value: &str) -> String {
    let path = Path::new(value);
    let extension: String = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(8)
        .collect();
    let stem_source = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(value);

    let mut stem = String::new();
    for character in stem_source.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
            stem.push(character);
        } else if character == ' ' {
            stem.push('_');
        }
        if stem.len() >= 60 {
            break;
        }
    }

    let stem = stem.trim_matches(['-', '_']).to_string();
    if stem.is_empty() {
        return String::new();
    }
    if extension.is_empty() {
        stem
    } else {
        format!("{stem}.{extension}")
    }
}

/// File extension for a `Content-Type` (parameters such as `; charset=...` are
/// ignored). The table is the union of the media-cache and export mappings;
/// `bmp`, `svg`, `webm` and `text/plain` were export-only before.
///
/// Unknown types fall back to the [`MediaKind`] (`png`/`mp4`), or to no
/// extension for [`MediaKind::File`].
pub fn extension_for_content_type(content_type: &str, kind: MediaKind) -> &'static str {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    match mime.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "application/pdf" => "pdf",
        "application/zip" => "zip",
        "text/plain" => "txt",
        _ => match kind {
            MediaKind::Image => "png",
            MediaKind::Video => "mp4",
            MediaKind::File => "",
        },
    }
}

/// Appends the content-type extension when `filename` has none.
pub fn with_extension(filename: &str, content_type: &str, kind: MediaKind) -> String {
    let has_extension = Path::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| !extension.is_empty());
    if has_extension {
        return filename.to_string();
    }

    let extension = extension_for_content_type(content_type, kind);
    if extension.is_empty() {
        filename.to_string()
    } else {
        format!("{filename}.{extension}")
    }
}

/// True when the response is HTML rather than the requested media. TAPD
/// answers with a login/permission page instead of failing the request, so
/// callers must not save it as an image or video.
pub fn content_type_is_html(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .eq_ignore_ascii_case("text/html")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a_is_stable_and_distinguishes_inputs() {
        assert_eq!(fnv1a(b"abc"), fnv1a(b"abc"));
        assert_ne!(fnv1a(b"abc"), fnv1a(b"abd"));
    }

    #[test]
    fn sanitize_filename_drops_non_ascii() {
        assert_eq!(sanitize_filename("截图 2024.png"), "2024.png");
        assert_eq!(sanitize_filename("截图.png"), "");
        assert_eq!(sanitize_filename("shot 1.png"), "shot_1.png");
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("-_-"), "");
    }

    #[test]
    fn extensions_cover_both_former_tables() {
        assert_eq!(
            extension_for_content_type("image/png", MediaKind::File),
            "png"
        );
        assert_eq!(
            extension_for_content_type("image/jpeg; q=1", MediaKind::File),
            "jpg"
        );
        assert_eq!(
            extension_for_content_type("image/bmp", MediaKind::File),
            "bmp"
        );
        assert_eq!(
            extension_for_content_type("image/svg+xml", MediaKind::File),
            "svg"
        );
        assert_eq!(
            extension_for_content_type("video/webm", MediaKind::File),
            "webm"
        );
        assert_eq!(
            extension_for_content_type("text/plain", MediaKind::File),
            "txt"
        );
        assert_eq!(
            extension_for_content_type("application/pdf", MediaKind::File),
            "pdf"
        );
        assert_eq!(
            extension_for_content_type("IMAGE/PNG", MediaKind::File),
            "png"
        );
    }

    #[test]
    fn unknown_types_fall_back_to_the_media_kind() {
        assert_eq!(
            extension_for_content_type("application/octet-stream", MediaKind::Image),
            "png"
        );
        assert_eq!(
            extension_for_content_type("application/octet-stream", MediaKind::Video),
            "mp4"
        );
        assert_eq!(
            extension_for_content_type("application/octet-stream", MediaKind::File),
            ""
        );
    }

    #[test]
    fn with_extension_only_appends_when_missing() {
        assert_eq!(
            with_extension("shot", "image/png", MediaKind::Image),
            "shot.png"
        );
        assert_eq!(
            with_extension("shot.PNG", "image/png", MediaKind::Image),
            "shot.PNG"
        );
        assert_eq!(
            with_extension("shot", "application/octet-stream", MediaKind::File),
            "shot"
        );
        assert_eq!(
            with_extension("shot", "video/mp4", MediaKind::File),
            "shot.mp4"
        );
    }

    #[test]
    fn html_detection_ignores_parameters_and_case() {
        assert!(content_type_is_html("text/html"));
        assert!(content_type_is_html("text/html; charset=utf-8"));
        assert!(content_type_is_html("Text/HTML"));
        assert!(!content_type_is_html("image/png"));
        assert!(!content_type_is_html("text/htmlx"));
    }
}
