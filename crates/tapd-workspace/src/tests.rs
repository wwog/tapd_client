//! Real git repositories in temporary directories; one behaviour per test.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{ChangeKind, TaskWorkspace};

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(label: &str) -> Self {
        static SEQUENCE: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "tapd-workspace-{label}-{}-{nanos}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn init_repo(root: &Path) -> PathBuf {
    let repo = root.join("repo");
    fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["config", "user.email", "workspace@example.com"]);
    git(&repo, &["config", "user.name", "Workspace Tester"]);
    git(&repo, &["config", "commit.gpgsign", "false"]);
    repo
}

fn write(dir: &Path, relative: &str, contents: &[u8]) {
    let path = dir.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, contents).unwrap();
}

fn commit_all(dir: &Path, message: &str) {
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", message]);
}

fn head(dir: &Path) -> String {
    git(dir, &["rev-parse", "HEAD"]).trim().to_string()
}

fn workspace(
    repo: &Path,
    work_dir: &Path,
    branch: Option<&str>,
    baseline: Option<&str>,
    excluded: Vec<String>,
) -> TaskWorkspace {
    TaskWorkspace::new(
        repo.to_string_lossy(),
        work_dir.to_string_lossy(),
        branch.map(str::to_string),
        baseline.map(str::to_string),
        excluded,
    )
}

#[test]
fn untracked_file_is_reported_as_the_task_change() {
    let temp = TempDir::new("untracked");
    let repo = init_repo(&temp.path);
    write(&repo, "base.txt", b"one\ntwo\n");
    commit_all(&repo, "base");
    let baseline = head(&repo);
    write(&repo, "notes.txt", b"a\nb\nc\n");

    let summary = workspace(&repo, &repo, None, Some(&baseline), Vec::new())
        .summary()
        .unwrap();

    assert_eq!(summary.file_count, 1);
    assert_eq!(summary.files.len(), 1);
    assert_eq!(summary.files[0].path, "notes.txt");
    assert_eq!(summary.files[0].status, ChangeKind::Added);
    assert_eq!(summary.files[0].additions, 3);
    assert_eq!(summary.files[0].deletions, 0);
    assert!(!summary.files[0].binary);
    assert!(summary.dirty);
    assert!(!summary.committed);
    assert_eq!(
        summary.commit, None,
        "an uncommitted change has no product commit"
    );
}

#[test]
fn modified_tracked_file_shows_line_counts_and_stays_uncommitted() {
    let temp = TempDir::new("modified");
    let repo = init_repo(&temp.path);
    write(&repo, "app.txt", b"a\nb\n");
    commit_all(&repo, "base");
    let baseline = head(&repo);
    write(&repo, "app.txt", b"a\nb\nc\nd\n");

    let summary = workspace(&repo, &repo, None, Some(&baseline), Vec::new())
        .summary()
        .unwrap();

    assert_eq!(summary.file_count, 1);
    assert_eq!(summary.files[0].path, "app.txt");
    assert_eq!(summary.files[0].status, ChangeKind::Modified);
    assert_eq!(summary.files[0].additions, 2);
    assert_eq!(summary.files[0].deletions, 0);
    assert!(summary.dirty);
    assert!(!summary.committed);
    assert_eq!(
        summary.commit, None,
        "an uncommitted change has no product commit"
    );
}

#[test]
fn committed_change_is_summarised_against_the_baseline() {
    let temp = TempDir::new("committed");
    let repo = init_repo(&temp.path);
    write(&repo, "app.txt", b"a\nb\n");
    commit_all(&repo, "base");
    let baseline = head(&repo);
    write(&repo, "app.txt", b"a\nb\nc\n");
    commit_all(&repo, "task change");
    let tip = head(&repo);

    let summary = workspace(&repo, &repo, None, Some(&baseline), Vec::new())
        .summary()
        .unwrap();

    assert_eq!(summary.file_count, 1);
    assert_eq!(summary.files[0].status, ChangeKind::Modified);
    assert_eq!(summary.files[0].additions, 1);
    assert!(!summary.dirty);
    assert!(summary.committed);
    assert_eq!(summary.commit.as_deref(), Some(tip.as_str()));
}

#[test]
fn excluded_files_stay_out_of_the_summary_and_dirty_flag() {
    let temp = TempDir::new("excluded");
    let repo = init_repo(&temp.path);
    write(&repo, "pre-existing.txt", b"clean\n");
    commit_all(&repo, "base");
    let baseline = head(&repo);
    write(&repo, "pre-existing.txt", b"clean\nand dirty\n");
    let excluded = vec![repo.join("pre-existing.txt").to_string_lossy().into_owned()];

    let excluded_only = workspace(&repo, &repo, None, Some(&baseline), excluded.clone());
    let summary = excluded_only.summary().unwrap();
    assert_eq!(summary.file_count, 0);
    assert!(summary.files.is_empty());
    assert!(!summary.dirty);

    write(&repo, "task.txt", b"task line\n");
    let summary = excluded_only.summary().unwrap();
    assert_eq!(summary.file_count, 1);
    assert_eq!(summary.files.len(), 1);
    assert_eq!(summary.files[0].path, "task.txt");
    assert!(summary.dirty);
}

#[test]
fn binary_file_is_flagged_without_line_counts() {
    let temp = TempDir::new("binary");
    let repo = init_repo(&temp.path);
    write(&repo, "base.txt", b"base\n");
    commit_all(&repo, "base");
    let baseline = head(&repo);
    write(&repo, "blob.bin", &[0x00, 0x01, 0x02, 0x00]);

    let summary = workspace(&repo, &repo, None, Some(&baseline), Vec::new())
        .summary()
        .unwrap();

    assert_eq!(summary.file_count, 1);
    assert_eq!(summary.files[0].path, "blob.bin");
    assert_eq!(summary.files[0].status, ChangeKind::Added);
    assert!(summary.files[0].binary);
    assert_eq!(summary.files[0].additions, 0);
    assert_eq!(summary.files[0].deletions, 0);
}

#[test]
fn branch_target_still_reports_changes_after_the_worktree_is_removed() {
    let temp = TempDir::new("branch");
    let repo = init_repo(&temp.path);
    write(&repo, "base.txt", b"base\n");
    commit_all(&repo, "base");
    let baseline = head(&repo);

    let worktree = temp.path.join("feature-wt");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            worktree.to_str().unwrap(),
            &baseline,
        ],
    );
    write(&worktree, "feature.txt", b"one\ntwo\n");
    commit_all(&worktree, "feature work");
    let tip = git(&repo, &["rev-parse", "feature"]).trim().to_string();

    fs::remove_dir_all(&worktree).unwrap();

    let workspace = workspace(
        &repo,
        &worktree,
        Some("feature"),
        Some(&baseline),
        Vec::new(),
    );
    let summary = workspace.summary().unwrap();
    assert_eq!(summary.file_count, 1);
    assert_eq!(summary.files[0].path, "feature.txt");
    assert_eq!(summary.files[0].status, ChangeKind::Added);
    assert_eq!(summary.files[0].additions, 2);
    assert!(!summary.dirty);
    assert!(summary.committed);
    assert_eq!(summary.commit.as_deref(), Some(tip.as_str()));
    assert_eq!(
        workspace.head_commit().unwrap().as_deref(),
        Some(tip.as_str())
    );

    let diff = workspace.diff(None).unwrap();
    assert!(!diff.empty);
    assert!(diff.text.contains("+one"));
    assert!(diff.text.contains("+two"));
}

#[test]
fn diff_can_be_scoped_to_a_single_file() {
    let temp = TempDir::new("scope");
    let repo = init_repo(&temp.path);
    write(&repo, "one.txt", b"first\n");
    write(&repo, "two.txt", b"second\n");
    commit_all(&repo, "base");
    let baseline = head(&repo);
    write(&repo, "one.txt", b"first\nmore first\n");
    write(&repo, "two.txt", b"second\nmore second\n");

    let workspace = workspace(&repo, &repo, None, Some(&baseline), Vec::new());
    let all = workspace.diff(None).unwrap();
    assert!(!all.empty);
    assert!(all.text.contains("+more first"));
    assert!(all.text.contains("+more second"));

    let one = workspace.diff(Some("one.txt")).unwrap();
    assert!(!one.empty);
    assert!(one.text.contains("+more first"));
    assert!(!one.text.contains("two.txt"));
}

#[test]
fn untracked_file_diff_comes_from_no_index() {
    let temp = TempDir::new("untracked-diff");
    let repo = init_repo(&temp.path);
    write(&repo, "base.txt", b"base\n");
    commit_all(&repo, "base");
    let baseline = head(&repo);
    write(&repo, "new.txt", b"fresh line\n");

    let workspace = workspace(&repo, &repo, None, Some(&baseline), Vec::new());
    let diff = workspace.diff(Some("new.txt")).unwrap();

    assert!(!diff.empty);
    assert!(diff.text.contains("+fresh line"));
}

#[test]
fn whole_tree_diff_includes_untracked_files() {
    let temp = TempDir::new("untracked-all");
    let repo = init_repo(&temp.path);
    write(&repo, "base.txt", b"base\n");
    commit_all(&repo, "base");
    let baseline = head(&repo);
    write(&repo, "new.txt", b"fresh line\n");
    write(&repo, "sub/other.txt", b"other\n");

    let workspace = workspace(&repo, &repo, None, Some(&baseline), Vec::new());
    let diff = workspace.diff(None).unwrap();

    // The review must show what `summary()` counts: two untracked files.
    assert!(diff.text.contains("+fresh line"), "{}", diff.text);
    assert!(diff.text.contains("+other"), "{}", diff.text);
    assert!(!diff.empty);
}

#[test]
fn clean_working_tree_has_an_empty_diff() {
    let temp = TempDir::new("clean");
    let repo = init_repo(&temp.path);
    write(&repo, "app.txt", b"a\nb\n");
    commit_all(&repo, "base");
    let baseline = head(&repo);

    let workspace = workspace(&repo, &repo, None, Some(&baseline), Vec::new());
    let diff = workspace.diff(None).unwrap();

    assert!(diff.empty);
    assert!(diff.text.trim().is_empty());
    assert!(!diff.truncated);
}

#[test]
fn diff_rejects_files_outside_the_work_tree() {
    let temp = TempDir::new("escape");
    let repo = init_repo(&temp.path);
    write(&repo, "app.txt", b"a\n");
    commit_all(&repo, "base");
    let baseline = head(&repo);
    // A secret next to the repository, not inside it.
    write(&temp.path, "outside.txt", b"secret\n");

    let workspace = workspace(&repo, &repo, None, Some(&baseline), Vec::new());

    for path in ["../outside.txt", "/etc/passwd", "..\\outside.txt"] {
        let error = workspace
            .diff(Some(path))
            .expect_err("a path outside the work tree must be rejected");
        assert!(
            error.message().contains(path),
            "the error names the rejected path: {}",
            error.message()
        );
    }
}

#[test]
fn an_excluded_untracked_directory_hides_every_file_inside_it() {
    let temp = TempDir::new("excluded-dir");
    let repo = init_repo(&temp.path);
    write(&repo, "base.txt", b"base\n");
    commit_all(&repo, "base");
    let baseline = head(&repo);
    // Pre-existing user files: git status reports the directory as `newdir/`.
    write(&repo, "newdir/keep.txt", b"user file\n");
    write(&repo, "newdir/nested/keep.txt", b"user file\n");
    let excluded = vec!["newdir/".to_string()];

    let summary = workspace(&repo, &repo, None, Some(&baseline), excluded)
        .summary()
        .unwrap();

    assert_eq!(summary.file_count, 0);
    assert!(summary.files.is_empty());
    assert!(!summary.dirty);
}

#[test]
fn several_untracked_files_keep_their_own_line_counts() {
    let temp = TempDir::new("untracked-batch");
    let repo = init_repo(&temp.path);
    write(&repo, "base.txt", b"base\n");
    commit_all(&repo, "base");
    let baseline = head(&repo);
    write(&repo, "a.txt", b"one\ntwo\n");
    write(&repo, "b.txt", b"one\ntwo\nthree\n");
    write(&repo, "dir/c.txt", b"one\n");

    let summary = workspace(&repo, &repo, None, Some(&baseline), Vec::new())
        .summary()
        .unwrap();

    assert_eq!(summary.file_count, 3);
    let counts: Vec<(String, usize, ChangeKind)> = summary
        .files
        .iter()
        .map(|file| (file.path.clone(), file.additions, file.status))
        .collect();
    assert!(counts.contains(&("a.txt".to_string(), 2, ChangeKind::Added)));
    assert!(counts.contains(&("b.txt".to_string(), 3, ChangeKind::Added)));
    assert!(counts.contains(&("dir/c.txt".to_string(), 1, ChangeKind::Added)));
}

#[test]
fn file_sides_carry_the_baseline_and_the_working_copy() {
    let temp = TempDir::new("sides");
    let repo = init_repo(&temp.path);
    write(&repo, "note.txt", b"one\ntwo\n");
    commit_all(&repo, "base");
    let baseline = head(&repo);
    write(&repo, "note.txt", b"one\nTWO\n");
    write(&repo, "added.txt", b"fresh\n");

    let workspace = workspace(&repo, &repo, None, Some(&baseline), Vec::new());

    let edited = workspace.file_sides("note.txt").unwrap();
    assert_eq!(edited.base.as_deref(), Some("one\ntwo\n"));
    assert_eq!(edited.current.as_deref(), Some("one\nTWO\n"));
    assert!(!edited.truncated);
    assert!(!edited.binary);

    // A file the baseline never had: no base side, not an error.
    let added = workspace.file_sides("added.txt").unwrap();
    assert_eq!(added.base, None);
    assert_eq!(added.current.as_deref(), Some("fresh\n"));
}

#[test]
fn file_sides_report_a_deleted_file_and_a_binary_one() {
    let temp = TempDir::new("sides-bin");
    let repo = init_repo(&temp.path);
    write(&repo, "gone.txt", b"bye\n");
    write(&repo, "pixel.bin", b"\x00\x01\x02binary\n");
    commit_all(&repo, "base");
    let baseline = head(&repo);
    fs::remove_file(repo.join("gone.txt")).unwrap();

    let workspace = workspace(&repo, &repo, None, Some(&baseline), Vec::new());

    let gone = workspace.file_sides("gone.txt").unwrap();
    assert_eq!(gone.base.as_deref(), Some("bye\n"));
    assert_eq!(gone.current, None);

    let binary = workspace.file_sides("pixel.bin").unwrap();
    assert!(binary.binary);
    assert_eq!(binary.base, None);
    assert_eq!(binary.current, None);
}

#[test]
fn file_sides_read_the_branch_tip_after_the_worktree_is_gone() {
    let temp = TempDir::new("sides-branch");
    let repo = init_repo(&temp.path);
    write(&repo, "base.txt", b"base\n");
    commit_all(&repo, "base");
    let baseline = head(&repo);
    let worktree = temp.path.join("feature-wt");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            worktree.to_str().unwrap(),
            &baseline,
        ],
    );
    write(&worktree, "base.txt", b"base\nmore\n");
    commit_all(&worktree, "feature work");
    fs::remove_dir_all(&worktree).unwrap();

    // The worktree directory is gone, so only the branch carries the change.
    let workspace = workspace(&repo, &worktree, Some("feature"), Some(&baseline), Vec::new());
    let sides = workspace.file_sides("base.txt").unwrap();
    assert_eq!(sides.base.as_deref(), Some("base\n"));
    assert_eq!(sides.current.as_deref(), Some("base\nmore\n"));
}
