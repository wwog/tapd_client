//! Per-task git worktrees.
//!
//! The worktree isolates a task's edits from the user's checkout, so several
//! tasks (and the user's own work) can share one repository. Branches survive a
//! successful run; only the directory is cleaned up.

use std::{
    path::{Path, PathBuf},
    process::Command,
};

use tapd_i18n::{tr, tr_args};

pub(super) struct Worktree {
    pub(super) path: PathBuf,
    pub(super) branch: String,
}

/// Keeps only ASCII letters/digits so branch names and paths stay portable.
fn ascii_token(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect()
}

/// `tapd/<bug tail 8>-<task head 8>`. A component with no ASCII characters
/// becomes `agent` instead of producing a dangling separator.
pub(super) fn branch_name(bug_id: &str, task_id: &str) -> String {
    let bug = ascii_token(bug_id);
    let bug = if bug.is_empty() {
        "agent".to_string()
    } else {
        let start = bug.len().saturating_sub(8);
        bug[start..].to_string()
    };
    let task = ascii_token(task_id);
    let task = if task.is_empty() {
        "agent".to_string()
    } else {
        task[..task.len().min(8)].to_string()
    };
    format!("tapd/{bug}-{task}")
}

/// `<worktrees_dir>/<ascii(workspace_id)>/<task_id>`.
pub(super) fn worktree_path(worktrees_dir: &Path, workspace_id: &str, task_id: &str) -> PathBuf {
    let workspace = ascii_token(workspace_id);
    let workspace = if workspace.is_empty() {
        "workspace".to_string()
    } else {
        workspace
    };
    worktrees_dir.join(workspace).join(task_id)
}

fn run_git(repo: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|error| tr_args("agent.git.exec.failed", &[&error]))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            tr_args(
                "agent.git.command.failed",
                &[&args.first().copied().unwrap_or("")],
            )
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Creates a worktree at `HEAD` on a task-owned branch. Synchronous: callers
/// must run this off the async runtime.
pub(super) fn create(
    worktrees_dir: &Path,
    repo: &str,
    workspace_id: &str,
    bug_id: &str,
    task_id: &str,
) -> Result<Worktree, String> {
    let repo = repo.trim();
    if repo.is_empty() {
        return Err(tr("agent.worktree.repo.unconfigured").to_string());
    }
    if !Path::new(repo).is_dir() {
        return Err(tr_args("agent.worktree.repo.invalid", &[&repo]));
    }

    let path = worktree_path(worktrees_dir, workspace_id, task_id);
    if path.exists() {
        return Err(tr_args("agent.worktree.dir.exists", &[&path.display()]));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| tr_args("agent.worktree.parent.failed", &[&error]))?;
    }

    // Fail early with a readable message instead of letting `worktree add`
    // report a generic error for a plain directory or an empty repository.
    run_git(repo, &["rev-parse", "--verify", "HEAD"])
        .map_err(|error| tr_args("agent.worktree.head.missing", &[&error]))?;

    let branch = branch_name(bug_id, task_id);
    let path_text = path.to_string_lossy().to_string();
    run_git(
        repo,
        &["worktree", "add", "-b", &branch, &path_text, "HEAD"],
    )
    .map_err(|error| tr_args("agent.worktree.add.failed", &[&error]))?;

    Ok(Worktree { path, branch })
}

/// Removes one worktree directory; its branch is intentionally kept. Safe to
/// call when the directory is already gone (the stale registration is pruned).
pub(super) fn remove(repo: &str, path: &str) -> Result<(), String> {
    let repo = repo.trim();
    let path = path.trim();
    if repo.is_empty() {
        return Err(tr("agent.worktree.repo.unconfigured").to_string());
    }
    if path.is_empty() {
        return Ok(());
    }

    if Path::new(path).exists() {
        run_git(repo, &["worktree", "remove", "--force", path])
            .map_err(|error| tr_args("agent.worktree.remove.failed", &[&error]))?;
    }
    run_git(repo, &["worktree", "prune"])
        .map_err(|error| tr_args("agent.worktree.prune.failed", &[&error]))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_name_keeps_ascii_tail_and_head() {
        assert_eq!(
            branch_name("1145336192001234567", "abcdef0123456789"),
            "tapd/01234567-abcdef01"
        );
        // 非 ASCII 字符被丢弃，仍按剩余字符截取。
        assert_eq!(
            branch_name("bug-中文-987654321", "task-ABC-123"),
            "tapd/87654321-taskABC1"
        );
        assert_eq!(branch_name("", ""), "tapd/agent-agent");
    }

    #[test]
    fn worktree_path_is_scoped_by_workspace_and_task() {
        assert_eq!(
            worktree_path(Path::new("/data/worktrees"), "45-33/6192", "abc123"),
            PathBuf::from("/data/worktrees/45336192/abc123")
        );
        assert_eq!(
            worktree_path(Path::new("/data/worktrees"), "  ", "abc123"),
            PathBuf::from("/data/worktrees/workspace/abc123")
        );
    }

    #[test]
    fn create_and_remove_round_trip() {
        let root = std::env::temp_dir().join(format!(
            "tapd-agent-worktree-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let repo = root.join("repo");
        let data = root.join("data");
        std::fs::create_dir_all(&repo).unwrap();

        let git = |args: &[&str]| {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(["-c", "user.email=test@example.com", "-c", "user.name=Test"])
                .args(args)
                .status()
                .expect("git");
            assert!(status.success(), "git {args:?}");
        };
        git(&["init", "-q"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "init"]);

        let repo_text = repo.to_str().unwrap();
        let created = create(
            &data.join("worktrees"),
            repo_text,
            "45336192",
            "1145336192001234567",
            "task0001",
        )
        .expect("create worktree");
        assert_eq!(created.branch, "tapd/01234567-task0001");
        assert!(created.path.is_dir());

        remove(repo_text, created.path.to_str().unwrap()).expect("remove worktree");
        assert!(!created.path.exists());
        // The branch is kept for the committed fix.
        let branch = run_git(
            repo_text,
            &["rev-parse", "--verify", "refs/heads/tapd/01234567-task0001"],
        )
        .expect("branch kept");
        assert!(!branch.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }
}
