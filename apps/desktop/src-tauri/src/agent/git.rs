//! Git safety net: dirty-file snapshots, HEAD checks, and review stashing.

use super::AgentTask;

/// The empty tree object, used as the diff base for a repository's first
/// commit. Keeping it here gives `changed_files_since` and review diff one
/// definition of "no previous HEAD".
pub(super) const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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
        .map_err(|error| format!("无法执行 git status：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git status 失败".to_string()
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
        .map_err(|error| format!("无法执行 git rev-parse：{error}"))?;
    if !output.status.success() {
        // A fresh repository has no HEAD yet; that is a valid state, not a git
        // failure. Real failures surface through `uncommitted_files`.
        return Ok(None);
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!sha.is_empty()).then_some(sha))
}

/// True when the task's repository gained a commit since the run started.
pub(super) fn committed_since_baseline(task: &AgentTask) -> Result<bool, String> {
    let Some(before) = task.baseline_head.as_deref() else {
        // A worktree created from an empty repository has no baseline HEAD;
        // any HEAD now means the agent made the first commit.
        return Ok(task.worktree_branch.is_some() && git_head(task.work_dir())?.is_some());
    };
    Ok(git_head(task.work_dir())?.is_some_and(|after| after != before))
}

/// Files changed since `baseline` (a commit-ish), including files the agent
/// committed plus anything still uncommitted. `None` diffs against the empty
/// tree so a first commit is still visible.
pub(super) fn changed_files_since(
    repo_path: &str,
    baseline: Option<&str>,
) -> Result<Vec<String>, String> {
    let baseline = baseline
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(EMPTY_TREE);
    let repo_path = repo_path.trim();
    if repo_path.is_empty() {
        return Ok(Vec::new());
    }
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["diff", "--name-only", baseline])
        .output()
        .map_err(|error| format!("无法执行 git diff：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git diff 失败".to_string()
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(50)
        .map(str::to_string)
        .collect())
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
        .map_err(|error| format!("无法执行 git merge-base：{error}"))?;
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
        "git merge-base 校验失败".to_string()
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
        .map_err(|error| format!("无法执行 git：{error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "git stash 失败".to_string()
        } else {
            stderr
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.contains("No local changes") {
        return Ok("无未提交改动".to_string());
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
