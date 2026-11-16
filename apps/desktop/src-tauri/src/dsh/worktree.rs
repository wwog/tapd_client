//! Git plumbing for task isolation: worktree creation, commits, merges and
//! stash. Every call is synchronous and runs on `spawn_blocking` from
//! [`super::tasks`]; this module owns no async and no state.
//!
//! Read-only summaries and diffs stay in [`tapd_workspace`]; this file only
//! mutates a repository. Failures carry git's own stderr — the caller wraps
//! them in a localized message so the UI never shows a bare English string.

use std::path::Path;
use std::process::{Command, Output};

/// A worktree created for one task. `baseline` is the commit the task started
/// from, so its changes stay computable after the directory is removed.
#[derive(Clone, Debug)]
pub struct CreatedWorktree {
    pub path: String,
    pub baseline: String,
}

/// Repository root for `dir`; fails when the directory is not inside a work
/// tree. Used to validate a project before a task touches it.
pub fn repo_root(dir: &str) -> Result<String, String> {
    let root = git(dir, &["rev-parse", "--show-toplevel"], &[])?.stdout;
    let root = String::from_utf8_lossy(&root).trim().to_string();
    if root.is_empty() {
        return Err(format!("{dir} is not inside a git work tree"));
    }
    Ok(root)
}

/// HEAD of `dir`, or `None` on an unborn branch.
pub fn head(dir: &str) -> Result<Option<String>, String> {
    let output = git(dir, &["rev-parse", "--verify", "--quiet", "HEAD"], &[1])?;
    let head = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!head.is_empty()).then_some(head))
}

/// Adds a worktree at `target` on a new `branch` starting at HEAD.
pub fn create(repo_path: &str, target: &Path, branch: &str) -> Result<CreatedWorktree, String> {
    let Some(parent) = target.parent() else {
        return Err(format!("{} has no parent directory", target.display()));
    };
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    if target.exists() {
        return Err(format!("{} already exists", target.display()));
    }
    let Some(baseline) = head(repo_path)? else {
        return Err(format!(
            "{repo_path} has no commit yet; a worktree needs a starting point"
        ));
    };
    let target_text = target.to_string_lossy().to_string();
    git(
        repo_path,
        &["worktree", "add", "-b", branch, &target_text, &baseline],
        &[],
    )?;
    Ok(CreatedWorktree {
        path: target_text,
        baseline,
    })
}

/// Removes a worktree directory. The branch is kept: it is what the merge and
/// the post-removal diff read. A path that is already gone is pruned instead of
/// reported as a failure.
pub fn remove(repo_path: &str, work_dir: &str) -> Result<(), String> {
    if !Path::new(work_dir).is_dir() {
        git(repo_path, &["worktree", "prune"], &[])?;
        return Ok(());
    }
    git(repo_path, &["worktree", "remove", "--force", work_dir], &[])?;
    Ok(())
}

/// Whether the working tree (including untracked files) has any change.
pub fn is_dirty(dir: &str) -> Result<bool, String> {
    let output = git(dir, &["status", "--porcelain"], &[])?;
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

/// Stages everything and commits it. Returns the new HEAD, or `None` when the
/// tree was already clean — the approve path is retried after a failed
/// write-back, so "nothing to commit" must not fail the task.
pub fn commit_all(dir: &str, message: &str) -> Result<Option<String>, String> {
    git(dir, &["add", "-A"], &[])?;
    let staged = git(dir, &["diff", "--cached", "--quiet"], &[1])?;
    if staged.status.code() == Some(0) {
        return Ok(None);
    }
    git(dir, &["commit", "-m", message], &[])?;
    head(dir)
}

/// Merges `branch` into the main repository without fast-forwarding.
///
/// A failure while *our* merge is in progress aborts it, so the user's
/// repository is left exactly as it was found. A merge that predates this call
/// is never aborted: that would discard the user's own conflicted state.
pub fn merge_no_ff(repo_path: &str, branch: &str, message: &str) -> Result<(), String> {
    let merge_head = git(
        repo_path,
        &["rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
        &[1],
    )?;
    if !String::from_utf8_lossy(&merge_head.stdout)
        .trim()
        .is_empty()
    {
        return Err("the repository already has a merge in progress".to_string());
    }
    match git(repo_path, &["merge", "--no-ff", "-m", message, branch], &[]) {
        Ok(_) => Ok(()),
        Err(error) => {
            // Conflict markers and a half-applied index must not survive.
            let _ = git(repo_path, &["merge", "--abort"], &[]);
            Err(error)
        }
    }
}

/// True when `ancestor` is reachable from `descendant` (the merge proof).
pub fn is_ancestor(repo_path: &str, ancestor: &str, descendant: &str) -> Result<bool, String> {
    let output = git(
        repo_path,
        &["merge-base", "--is-ancestor", ancestor, descendant],
        &[1],
    )?;
    Ok(output.status.code() == Some(0))
}

/// Stashes every change, including untracked files. Cancel uses it to hand the
/// worktree back clean while keeping the work in git's stash list.
pub fn stash_all(dir: &str, message: &str) -> Result<(), String> {
    git(
        dir,
        &["stash", "push", "--include-untracked", "-m", message],
        &[],
    )?;
    Ok(())
}

/// Deterministic branch name: `<prefix>/<id>-<6 hex of the session id>`.
///
/// Parsed by humans in `git branch` output, so the id is filtered down to
/// path-safe ASCII instead of being escaped.
pub fn branch_name(prefix: &str, id: &str, session_id: &str) -> String {
    let id: String = id
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let id = id.trim_matches('-');
    let short: String = session_id
        .chars()
        .filter(|ch| ch.is_ascii_hexdigit())
        .take(6)
        .collect();
    let short = if short.is_empty() {
        "task".to_string()
    } else {
        short
    };
    if id.is_empty() {
        format!("{prefix}/{short}")
    } else {
        format!("{prefix}/{id}-{short}")
    }
}

/// One git invocation. `allowed` lists exit codes that are not failures
/// (`git diff --quiet`, `merge-base --is-ancestor` and `rev-parse --verify`
/// signal their answer through the exit code).
fn git(dir: &str, args: &[&str], allowed: &[i32]) -> Result<Output, String> {
    let mut command = Command::new("git");
    command
        .arg("-c")
        .arg("core.quotepath=false")
        .args(args)
        .current_dir(dir);
    let output = command
        .output()
        .map_err(|error| format!("failed to run git {} in {dir}: {error}", args.join(" ")))?;
    let accepted = output.status.success()
        || output
            .status
            .code()
            .is_some_and(|code| allowed.contains(&code));
    if accepted {
        return Ok(output);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "git {} failed in {dir}: {}",
        args.join(" "),
        stderr.trim()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempRepo {
        root: PathBuf,
    }

    impl TempRepo {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "tapd-dsh-worktree-{label}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&root).expect("temp root");
            let repo = root.join("repo");
            std::fs::create_dir_all(&repo).expect("repo dir");
            let repo_text = repo.to_string_lossy().to_string();
            git(&repo_text, &["init", "--quiet"], &[]).expect("git init");
            git(&repo_text, &["config", "user.name", "Test"], &[]).expect("name");
            git(
                &repo_text,
                &["config", "user.email", "test@example.com"],
                &[],
            )
            .expect("email");
            std::fs::write(repo.join("README.md"), "hello\n").expect("seed file");
            git(&repo_text, &["add", "-A"], &[]).expect("stage");
            git(&repo_text, &["commit", "-m", "seed", "--quiet"], &[]).expect("commit");
            Self { root }
        }

        fn repo(&self) -> String {
            self.root.join("repo").to_string_lossy().to_string()
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn branch_names_are_path_safe_and_deterministic() {
        let id = "11223344";
        assert_eq!(
            branch_name("tapd", id, "9f3a1c2d-0000"),
            "tapd/11223344-9f3a1c"
        );
        assert_eq!(
            branch_name("tapd", id, "9f3a1c2d-0000"),
            branch_name("tapd", id, "9f3a1c2d-0000"),
        );
        // Non-ASCII and spaces become '-' instead of breaking refs.
        assert_eq!(
            branch_name("local", "lw_中文 id", "abcdef"),
            "local/lw_---id-abcdef"
        );
        assert_eq!(branch_name("tapd", "  ", "abc123"), "tapd/abc123");
        assert!(!branch_name("tapd", "a b", "").ends_with('/'));
    }

    #[test]
    fn worktree_commits_merge_and_keep_the_branch() {
        let temp = TempRepo::new("merge");
        let repo = temp.repo();
        let target = temp.root.join("worktree");
        let branch = branch_name("tapd", "42", "abcdef123456");
        let created = create(&repo, &target, &branch).expect("create worktree");
        assert!(Path::new(&created.path).is_dir());
        assert_eq!(is_dirty(&created.path).expect("clean"), false);

        std::fs::write(target.join("app.txt"), "feature\n").expect("write");
        assert_eq!(is_dirty(&created.path).expect("dirty"), true);
        let commit = commit_all(&created.path, "tapd(42): feature")
            .expect("commit")
            .expect("a commit was created");
        assert_eq!(commit, head(&created.path).expect("head").unwrap());
        assert_eq!(
            commit_all(&created.path, "tapd(42): feature").expect("idempotent"),
            None,
            "a clean tree produces no second commit"
        );

        assert!(!is_ancestor(&repo, &branch, "HEAD").expect("ancestor check"));
        merge_no_ff(&repo, &branch, "merge task").expect("merge");
        assert!(is_ancestor(&repo, &branch, "HEAD").expect("ancestor check"));
        assert!(Path::new(&repo).join("app.txt").is_file());

        remove(&repo, &created.path).expect("remove worktree");
        assert!(!Path::new(&created.path).exists());
        // The branch outlives the worktree, which is what the diff reads.
        assert_eq!(
            String::from_utf8_lossy(
                &git(&repo, &["branch", "--list", &branch], &[])
                    .unwrap()
                    .stdout
            )
            .trim()
            .is_empty(),
            false
        );
    }

    #[test]
    fn a_conflicted_merge_is_aborted() {
        let temp = TempRepo::new("conflict");
        let repo = temp.repo();
        let target = temp.root.join("worktree");
        let branch = branch_name("tapd", "7", "abcdef");
        create(&repo, &target, &branch).expect("create worktree");

        std::fs::write(target.join("README.md"), "branch\n").expect("branch edit");
        commit_all(&target.to_string_lossy(), "branch edit").expect("commit branch");
        std::fs::write(temp.root.join("repo/README.md"), "main\n").expect("main edit");
        commit_all(&repo, "main edit").expect("commit main");

        let error = merge_no_ff(&repo, &branch, "merge").expect_err("conflict");
        assert!(error.contains("git merge"), "{error}");
        assert_eq!(is_dirty(&repo).expect("clean after abort"), false);
        assert!(
            !Path::new(&repo).join(".git/MERGE_HEAD").exists(),
            "the failed merge must not be left in progress"
        );
    }

    #[test]
    fn stash_clears_the_worktree_without_losing_the_change() {
        let temp = TempRepo::new("stash");
        let repo = temp.repo();
        let target = temp.root.join("worktree");
        let branch = branch_name("tapd", "9", "abcdef");
        create(&repo, &target, &branch).expect("create worktree");
        std::fs::write(target.join("leftover.txt"), "wip\n").expect("write");

        stash_all(&target.to_string_lossy(), "cancel").expect("stash");
        assert_eq!(is_dirty(&target.to_string_lossy()).expect("clean"), false);
    }

    #[test]
    fn a_directory_that_is_not_a_repository_is_rejected() {
        let temp = TempRepo::new("outside");
        let plain = temp.root.join("plain");
        std::fs::create_dir_all(&plain).expect("plain dir");
        assert!(repo_root(&plain.to_string_lossy()).is_err());
    }
}
