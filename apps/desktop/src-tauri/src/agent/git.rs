//! Git safety net: dirty-file snapshots, HEAD checks, and review stashing.
//!
//! Change summaries and diffs live in `crate::task_changes` / `tapd_workspace`;
//! what remains here are the checks the workflow host still runs itself.

use tapd_i18n::{tr, tr_args};

/// Parses `git status --porcelain` output into changed file paths.
pub(super) fn parse_porcelain_files(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim_end();
            if line.len() < 4 {
                return None;
            }
            let path = line.get(3..)?.trim();
            if path.is_empty() {
                return None;
            }
            // Renames are reported as `old -> new`; keep the new path.
            let path = path.rsplit(" -> ").next().unwrap_or(path);
            Some(path.trim_matches('"').to_string())
        })
        .take(50)
        .collect()
}

/// Files still uncommitted in the task's repository. An unavailable git is an
/// error, not an empty worktree: the caller decides whether that blocks work.
pub(super) fn uncommitted_files(repo_path: &str) -> Result<Vec<String>, String> {
    let repo_path = repo_path.trim();
    if repo_path.is_empty() {
        return Ok(Vec::new());
    }
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["status", "--porcelain"])
        .output()
        .map_err(|error| tr_args("agent.git.status.exec.failed", &[&error]))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            tr("agent.git.status.failed").to_string()
        } else {
            stderr
        });
    }
    Ok(parse_porcelain_files(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// Current HEAD of the task repository, used to tell "committed" from "left
/// uncommitted changes".
pub(super) fn git_head(repo_path: &str) -> Result<Option<String>, String> {
    let repo_path = repo_path.trim();
    if repo_path.is_empty() {
        return Ok(None);
    }
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["rev-parse", "HEAD"])
        .output()
        .map_err(|error| tr_args("agent.git.revparse.exec.failed", &[&error]))?;
    if !output.status.success() {
        // A fresh repository has no HEAD yet; that is a valid state, not a git
        // failure. Real failures surface through `uncommitted_files`.
        return Ok(None);
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!sha.is_empty()).then_some(sha))
}

/// True when `branch` is already an ancestor of the repository's current HEAD,
/// i.e. the merge actually landed.
pub(super) fn branch_merged(repo_path: &str, branch: &str) -> Result<bool, String> {
    let repo_path = repo_path.trim();
    let branch = branch.trim();
    if repo_path.is_empty() || branch.is_empty() {
        return Ok(false);
    }
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["merge-base", "--is-ancestor", branch, "HEAD"])
        .output()
        .map_err(|error| tr_args("agent.git.mergeBase.exec.failed", &[&error]))?;
    if output.status.success() {
        return Ok(true);
    }
    // `merge-base --is-ancestor` exits 1 for "not an ancestor" and >1 for
    // real errors (unknown ref, not a repository, ...).
    if output.status.code() == Some(1) {
        return Ok(false);
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        tr("agent.git.mergeBase.failed").to_string()
    } else {
        stderr
    })
}

/// Stashes the reviewed files (tracked and untracked) so a rejected review
/// never loses the agent's work. Restricting the pathspec keeps unrelated local
/// changes out of the stash. Returns a human-readable stash ref.
pub(super) fn stash_changes(
    repo_path: &str,
    label: &str,
    files: &[String],
) -> Result<String, String> {
    let mut command = std::process::Command::new("git");
    command
        .arg("-C")
        .arg(repo_path)
        .args(["stash", "push", "--include-untracked", "-m", label]);
    if !files.is_empty() {
        // Agent-supplied paths may be absolute; git pathspecs are repo-relative.
        let prefix = format!("{}/", repo_path.trim_end_matches('/'));
        command.arg("--");
        for file in files {
            let file = file.trim();
            if file.is_empty() {
                continue;
            }
            command.arg(file.strip_prefix(&prefix).unwrap_or(file));
        }
    }
    let output = command
        .output()
        .map_err(|error| tr_args("agent.git.exec.failed", &[&error]))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            tr("agent.git.stash.failed").to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.contains("No local changes") {
        return Ok(tr("agent.git.clean").to_string());
    }

    let reference = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["rev-parse", "--short", "refs/stash"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|reference| !reference.is_empty());
    Ok(match reference {
        Some(reference) => format!("stash@{{0}} ({reference})"),
        None => "stash@{0}".to_string(),
    })
}
