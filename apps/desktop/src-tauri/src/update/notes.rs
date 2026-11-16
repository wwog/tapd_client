//! Release-note and version policy: strips the forced-update marker and reads
//! the mandatory requirement persisted in `config.json`.
//!
//! Everything here is pure (except reading the config snapshot), so the state
//! machine only has to decide *when* to consult it.

use semver::Version;

use tapd_i18n::tr;

use super::model::AvailableUpdate;
use super::FORCE_UPDATE_MARKER;
use crate::state::SharedState;

/// Splits release notes into their display text and the forced-update flag.
pub(super) fn parse_notes(raw: &str) -> (String, bool) {
    let mut forced = false;
    let mut kept: Vec<&str> = Vec::new();
    for line in raw.lines() {
        if is_force_marker(line) {
            forced = true;
            continue;
        }
        kept.push(line);
    }
    let notes = kept.join("\n").trim().to_string();
    let notes = if notes.is_empty() {
        tr("notify.update.nonotes").to_string()
    } else {
        notes
    };
    (notes, forced)
}

/// Whitespace-insensitive marker match so `<!--force-update-->` also counts.
fn is_force_marker(line: &str) -> bool {
    let normalize = |text: &str| -> String {
        text.chars()
            .filter(|ch| !ch.is_whitespace())
            .collect::<String>()
            .to_ascii_lowercase()
    };
    normalize(line) == normalize(FORCE_UPDATE_MARKER)
}

/// Whether `candidate` is a strictly newer semantic version than `current`.
fn version_is_newer(candidate: &str, current: &str) -> bool {
    match (
        Version::parse(candidate.trim()),
        Version::parse(current.trim()),
    ) {
        (Ok(candidate), Ok(current)) => candidate > current,
        _ => false,
    }
}

/// The recorded mandatory update, while the running version is still older.
pub(super) fn recorded_force(
    state: &SharedState,
    current_version: &str,
) -> Option<AvailableUpdate> {
    let record = state.config_snapshot().forced_update?;
    if !version_is_newer(&record.version, current_version) {
        return None;
    }
    Some(AvailableUpdate {
        version: record.version,
        notes: String::new(),
        date: None,
        forced: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn force_marker_is_stripped_and_flagged() {
        let notes = format!("# TAPD Client v1.1.2\n\n{FORCE_UPDATE_MARKER}\n\n## 修复\n- 必须升级");
        let (display, forced) = parse_notes(&notes);
        assert!(forced);
        assert!(!display.contains("force-update"));
        assert!(display.starts_with("# TAPD Client v1.1.2"));
        assert!(display.ends_with("- 必须升级"));
    }

    #[test]
    fn force_marker_tolerates_spacing_and_case() {
        assert!(is_force_marker("  <!--force-update-->  "));
        assert!(is_force_marker("<!--  FORCE-UPDATE  -->"));
        assert!(!is_force_marker("<!-- 普通注释 -->"));
    }

    #[test]
    fn ordinary_notes_are_untouched() {
        let (display, forced) = parse_notes("# TAPD Client v1.1.2\n\n- 内容");
        assert!(!forced);
        assert_eq!(display, "# TAPD Client v1.1.2\n\n- 内容");

        let (empty, forced) = parse_notes("   ");
        assert!(!forced);
        assert_eq!(empty, "该版本没有提供更新说明。");
    }

    #[test]
    fn version_comparison_is_semver() {
        assert!(version_is_newer("1.1.2", "1.1.1"));
        assert!(!version_is_newer("1.1.1", "1.1.1"));
        assert!(!version_is_newer("1.1.0", "1.1.1"));
        assert!(!version_is_newer("not-a-version", "1.1.1"));
    }
}
