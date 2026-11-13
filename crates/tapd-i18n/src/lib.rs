//! Semantic-key messages. Every entry carries its key and both languages:
//!
//! ```ignore
//! ("agent.startup_timeout", "Agent 启动后 {}s 没有输出", "The agent produced no output for {}s"),
//! ```
//!
//! Keys are short, dot-namespaced ids (`common.save`, `agent.status.queued`),
//! not sentences, so the catalogue stays cheap to look up and a key survives
//! copy changes. `tr`/`tr_args` resolve the current locale, falling back to the
//! other language and finally to the key itself.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

/// The locales the app ships. Chinese is the default UI language.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Locale {
    Zh = 0,
    En = 1,
}

/// One message: key, Chinese, English.
pub type Message = (&'static str, &'static str, &'static str);

static LOCALE: AtomicU8 = AtomicU8::new(Locale::Zh as u8);
static ZH: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
static EN: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();

const BUCKETS: &[&[Message]] = &[
    catalog::common::MESSAGES,
    catalog::core::MESSAGES,
    catalog::mcp::MESSAGES,
    catalog::agent::MESSAGES,
    catalog::bug::MESSAGES,
    catalog::notification::MESSAGES,
    catalog::companion::MESSAGES,
    catalog::app::MESSAGES,
    catalog::misc::MESSAGES,
];

mod catalog;

/// Sets the process-wide locale. The frontend pushes the resolved language at
/// startup and whenever the user changes it.
pub fn set_locale(locale: Locale) {
    LOCALE.store(locale as u8, Ordering::Relaxed);
}

pub fn locale() -> Locale {
    if LOCALE.load(Ordering::Relaxed) == Locale::En as u8 {
        Locale::En
    } else {
        Locale::Zh
    }
}

pub fn is_en() -> bool {
    locale() == Locale::En
}

/// Parses a BCP-47 tag ("zh-Hans-CN", "en-US") into a supported locale.
pub fn parse_locale(tag: &str) -> Option<Locale> {
    let lower = tag.trim().replace('_', "-").to_ascii_lowercase();
    if lower.starts_with("en") {
        Some(Locale::En)
    } else if lower.starts_with("zh") {
        Some(Locale::Zh)
    } else {
        None
    }
}

/// The tag handed to `Intl`-style formatters and the webview.
pub fn tag(locale: Locale) -> &'static str {
    match locale {
        Locale::Zh => "zh-CN",
        Locale::En => "en-US",
    }
}

fn zh() -> &'static HashMap<&'static str, &'static str> {
    ZH.get_or_init(|| {
        BUCKETS
            .iter()
            .flat_map(|bucket| bucket.iter())
            .map(|(key, zh, _)| (*key, *zh))
            .collect()
    })
}

fn en() -> &'static HashMap<&'static str, &'static str> {
    EN.get_or_init(|| {
        BUCKETS
            .iter()
            .flat_map(|bucket| bucket.iter())
            .map(|(key, _, en)| (*key, *en))
            .collect()
    })
}

/// Translates one key for the active locale.
pub fn tr(key: &'static str) -> &'static str {
    let primary = if is_en() { en() } else { zh() };
    let fallback = if is_en() { zh() } else { en() };
    primary
        .get(key)
        .or_else(|| fallback.get(key))
        .copied()
        .unwrap_or(key)
}

/// Translates a template and fills its placeholders.
///
/// `format!` needs a literal format string, so a translated template cannot be
/// passed to it. This substitutes instead:
///
/// - `{}` consumes the next argument (Rust's auto-numbering),
/// - `{0}`, `{1}` address arguments by index, which lets the English template
///   reorder them,
/// - `{{` / `}}` render literal braces,
/// - a placeholder with no matching argument is left untouched.
///
/// ```ignore
/// tr_args("agent.startup_timeout", &[&secs])
/// ```
pub fn tr_args(key: &'static str, args: &[&dyn std::fmt::Display]) -> String {
    render(tr(key), args)
}

fn render(template: &str, args: &[&dyn std::fmt::Display]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    let mut next = 0usize;

    while let Some(ch) = chars.next() {
        match ch {
            '{' => {
                if chars.peek() == Some(&'{') {
                    chars.next();
                    out.push('{');
                    continue;
                }
                let mut spec = String::new();
                let mut closed = false;
                for inner in chars.by_ref() {
                    if inner == '}' {
                        closed = true;
                        break;
                    }
                    spec.push(inner);
                }
                if !closed {
                    out.push('{');
                    out.push_str(&spec);
                    continue;
                }
                let index = if spec.trim().is_empty() {
                    let index = next;
                    next += 1;
                    Some(index)
                } else {
                    spec.trim().parse::<usize>().ok()
                };
                match index.and_then(|index| args.get(index)) {
                    Some(value) => out.push_str(&value.to_string()),
                    None => {
                        out.push('{');
                        out.push_str(&spec);
                        out.push('}');
                    }
                }
            }
            '}' => {
                if chars.peek() == Some(&'}') {
                    chars.next();
                }
                out.push('}');
            }
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries() -> Vec<Message> {
        BUCKETS
            .iter()
            .flat_map(|bucket| bucket.iter().copied())
            .collect()
    }

    fn is_key(key: &str) -> bool {
        let valid = |segment: &str| {
            !segment.is_empty()
                && segment
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric())
                && segment.starts_with(|c: char| c.is_ascii_lowercase())
        };
        let segments: Vec<&str> = key.split('.').collect();
        segments.len() >= 2 && segments.iter().all(|segment| valid(segment))
    }

    #[test]
    fn keys_are_unique_and_short() {
        let mut seen = HashMap::new();
        for (key, _, _) in entries() {
            assert!(seen.insert(key, ()).is_none(), "duplicate key {key:?}");
            assert!(is_key(key), "invalid key {key:?}");
            assert!(key.len() <= 48, "key too long ({}) {key:?}", key.len());
        }
    }

    #[test]
    fn translations_are_present_and_english() {
        for (key, zh, en) in entries() {
            assert!(!zh.trim().is_empty(), "empty Chinese for {key:?}");
            assert!(!en.trim().is_empty(), "empty English for {key:?}");
            let has_cjk = en
                .chars()
                .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c));
            assert!(!has_cjk, "untranslated CJK left in {key:?} -> {en:?}");
        }
    }

    #[test]
    fn locale_parsing() {
        assert_eq!(parse_locale("zh-Hans-CN"), Some(Locale::Zh));
        assert_eq!(parse_locale("en_US"), Some(Locale::En));
        assert_eq!(parse_locale("en-US"), Some(Locale::En));
        assert_eq!(parse_locale("ja-JP"), None);
    }

    #[test]
    fn renders_sequential_placeholders() {
        let one = 1;
        let two = "two";
        assert_eq!(render("{} then {}", &[&one, &two]), "1 then two");
    }

    #[test]
    fn renders_indexed_placeholders_in_any_order() {
        let a = "A";
        let b = "B";
        assert_eq!(render("{1} before {0}", &[&a, &b]), "B before A");
    }

    #[test]
    fn keeps_unmatched_placeholders_and_escapes() {
        assert_eq!(render("{0} {1}", &[]), "{0} {1}");
        assert_eq!(render("{{}}", &[]), "{}");
        assert_eq!(render("no slots", &[]), "no slots");
    }
}
