//! Export directory layout: where a bug package lives and how an existing one
//! is found again. Pure path logic, no HTTP.

use std::path::PathBuf;

use tapd_core::{
    export::ascii_slug,
    paths::AppPaths,
    tapd::{BugDetail, BugSummary},
};

pub(crate) fn workspace_label(
    workspace_name: Option<String>,
    detail: &BugDetail,
    workspace_id: &str,
) -> String {
    workspace_name
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            let name = detail.workspace_name.trim().to_string();
            (!name.is_empty()).then_some(name)
        })
        .unwrap_or_else(|| workspace_id.to_string())
}

/// Directory that receives `bug.json` and `assets/` for one bug.
///
/// Layout: `<exports>/<workspace>-<workspace_id>/<bug_ref>[-<ascii-slug>]`.
/// `bug_ref` is the short id TAPD shows in its UI, and the slug is ASCII-only
/// so the path stays short and portable.
pub(crate) fn bug_export_dir(
    paths: &AppPaths,
    workspace_id: &str,
    workspace_label: &str,
    bug_ref: &str,
    title: &str,
) -> PathBuf {
    let workspace_slug = ascii_slug(workspace_label);
    let workspace_dir = if workspace_slug.is_empty() {
        workspace_id.to_string()
    } else {
        format!("{workspace_slug}-{workspace_id}")
    };
    let title_slug = ascii_slug(title);
    let bug_dir = if title_slug.is_empty() {
        bug_ref.to_string()
    } else {
        format!("{bug_ref}-{title_slug}")
    };
    paths.exports_dir.join(workspace_dir).join(bug_dir)
}

/// Stable, filesystem-friendly bug reference: TAPD's short id when present.
pub(crate) fn bug_reference(summary: &BugSummary) -> String {
    let short = summary.short_id.trim();
    if !short.is_empty() {
        return short.to_string();
    }
    let id = summary.id.trim();
    // The long id is numeric; the last 10 digits keep it distinguishable
    // without a 19-digit directory name.
    id.chars()
        .rev()
        .take(10)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tapd_core::tapd::BugSummary;

    fn paths() -> AppPaths {
        AppPaths {
            data_dir: PathBuf::from("/tmp/tapd"),
            logs_dir: PathBuf::from("/tmp/tapd/logs"),
            captures_dir: PathBuf::from("/tmp/tapd/captures"),
            exports_dir: PathBuf::from("/exports"),
            worktrees_dir: PathBuf::from("/tmp/tapd/worktrees"),
            runtime_file: PathBuf::from("/tmp/tapd/runtime.json"),
            config_file: PathBuf::from("/tmp/tapd/config.json"),
        }
    }

    fn summary(id: &str, short_id: &str, title: &str) -> BugSummary {
        BugSummary {
            id: id.to_string(),
            short_id: short_id.to_string(),
            title: title.to_string(),
            ..BugSummary::default()
        }
    }

    #[test]
    fn export_dir_is_short_and_ascii() {
        let summary = summary(
            "1145336192001010643",
            "1010643",
            "rust-设置-通话记录-清空通话",
        );
        let dir = bug_export_dir(
            &paths(),
            "45336192",
            "UU",
            &bug_reference(&summary),
            &summary.title,
        );
        assert_eq!(dir.to_string_lossy(), "/exports/UU-45336192/1010643-rust");
    }

    #[test]
    fn export_dir_falls_back_to_the_bug_reference() {
        let summary = summary("1145336192001010643", "1010643", "通话记录清空");
        let dir = bug_export_dir(
            &paths(),
            "45336192",
            "项目",
            &bug_reference(&summary),
            &summary.title,
        );
        assert_eq!(dir.to_string_lossy(), "/exports/45336192/1010643");
    }

    #[test]
    fn bug_reference_uses_short_id_or_long_id_tail() {
        assert_eq!(
            bug_reference(&summary("1145336192001010643", "1010643", "")),
            "1010643"
        );
        assert_eq!(
            bug_reference(&summary("1145336192001010643", " ", "")),
            "2001010643"
        );
    }
}
