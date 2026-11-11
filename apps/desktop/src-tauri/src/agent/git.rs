//! Git safety net: dirty-file snapshots, HEAD checks, and review stashing.

use super::AgentTask;

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

/// Files still uncommitted in the task's repository. Empty on a clean tree or
/// when git is unavailable, so a failed check never blocks a task.
pub(super) fn uncommitted_files(repo_path: &str) -> Vec<String> {
    let repo_path = repo_path.trim();
    if repo_path.is_empty() {
        return Vec::new();
    }
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["status", "--porcelain"])
        .output();
    match output {
        Ok(output) if output.status.success() => {
            parse_porcelain_files(&String::from_utf8_lossy(&output.stdout))
        }
        _ => Vec::new(),
    }
}

/// Current HEAD of the task repository, used to tell "committed" from "left
/// uncommitted changes".
pub(super) fn git_head(repo_path: &str) -> Option<String> {
    let repo_path = repo_path.trim();
    if repo_path.is_empty() {
        return None;
    }
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!sha.is_empty()).then_some(sha)
}

/// True when the task's repository gained a commit since the run started.
pub(super) fn committed_since_baseline(task: &AgentTask) -> bool {
    let Some(before) = task.baseline_head.as_deref() else {
        return false;
    };
    git_head(&task.repo_path).is_some_and(|after| after != before)
}

/// Stashes the reviewed files (tracked and untracked) so a rejected review
/// never loses the agent's work. Restricting the pathspec keeps unrelated local
/// changes out of the stash. Returns a human-readable stash ref.
pub(super) fn stash_changes(repo_path: &str, label: &str, files: &[String]) -> Result<String, String> {
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
