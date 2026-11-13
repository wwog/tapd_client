//! Language plumbing: OS detection at boot and the command the webview uses to
//! push its resolved language (which may differ from `LANG` inside a GUI app).

use tapd_i18n::Locale;

/// Boot-time guess. The frontend pushes the authoritative value as soon as the
/// first frame is up, so this only covers messages emitted before then.
pub fn detect() -> Locale {
    for tag in system_tags() {
        if let Some(locale) = tapd_i18n::parse_locale(&tag) {
            return locale;
        }
    }
    Locale::Zh
}

fn system_tags() -> Vec<String> {
    let mut tags = Vec::new();
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() && value != "C" && value != "POSIX" {
                tags.push(value);
            }
        }
    }
    // A bundled macOS app usually starts without `LANG`; the stored preference
    // list is the reliable source there.
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("defaults")
            .args(["read", "-g", "AppleLanguages"])
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                for tag in text.split('"').skip(1).step_by(2) {
                    tags.push(tag.to_string());
                }
            }
        }
    }
    tags
}

/// Resolves the stored UI preference: an explicit locale wins, `system` (or a
/// missing value) follows the OS.
pub fn initial_from_prefs(prefs: &serde_json::Value) -> Locale {
    prefs
        .get("appearance")
        .and_then(|appearance| appearance.get("locale"))
        .and_then(|locale| locale.as_str())
        .and_then(tapd_i18n::parse_locale)
        .unwrap_or_else(detect)
}

/// Pushed by the frontend whenever the resolved language changes.
#[tauri::command]
pub fn set_locale(locale: String) {
    if let Some(locale) = tapd_i18n::parse_locale(&locale) {
        tapd_i18n::set_locale(locale);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_resolve_explicit_locale() {
        let prefs = serde_json::json!({ "appearance": { "locale": "en" } });
        assert_eq!(initial_from_prefs(&prefs), Locale::En);
    }
}
