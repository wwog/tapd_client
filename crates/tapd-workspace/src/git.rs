//! Git-backed implementation of [`TaskWorkspace`].
//!
//! Every number and every byte of diff text comes from a git subprocess; this
//! module only parses git's own formats. Two target shapes share the code:
//!
//! - directory target: `work_dir` exists, so git runs with `-C work_dir` and
//!   untracked files are included;
//! - reference target: the worktree directory is gone, so git runs with
//!   `-C repo_path` over `baseline..branch`.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tapd_i18n::{tr, tr_args};

use crate::types::{
    ChangeKind, ChangeSummary, ChangedFile, DiffView, TaskWorkspace, WorkspaceError, EMPTY_TREE,
    MAX_DIFF_CHARS, MAX_LISTED_FILES,
};

impl TaskWorkspace {
    pub fn new(
        repo_path: impl Into<String>,
        work_dir: impl Into<String>,
        branch: Option<String>,
        baseline: Option<String>,
        excluded: Vec<String>,
    ) -> Self {
        Self {
            repo_path: repo_path.into(),
            work_dir: work_dir.into(),
            branch,
            baseline,
            excluded,
        }
    }

    pub fn summary(&self) -> Result<ChangeSummary, WorkspaceError> {
        match self.target()? {
            Target::Dir(root) => self.dir_summary(&root),
            Target::Ref(branch) => self.ref_summary(&branch),
        }
    }

    pub fn diff(&self, file: Option<&str>) -> Result<DiffView, WorkspaceError> {
        match self.target()? {
            Target::Dir(root) => self.dir_diff(&root, file),
            Target::Ref(branch) => self.ref_diff(&branch, file),
        }
    }

    pub fn head_commit(&self) -> Result<Option<String>, WorkspaceError> {
        match self.target()? {
            Target::Dir(root) => Git::new(root).head(),
            Target::Ref(branch) => {
                let repo = Git::new(&self.repo_path);
                Ok(Some(repo.branch_tip(&branch)?))
            }
        }
    }
}

/// Which git invocation shape `summary`/`diff` use.
enum Target {
    /// The task's working directory still exists.
    Dir(PathBuf),
    /// Only the branch survives; the worktree directory is gone.
    Ref(String),
}

impl TaskWorkspace {
    fn target(&self) -> Result<Target, WorkspaceError> {
        if self.repo_path.trim().is_empty() {
            return Err(WorkspaceError::new(tr("workspace.repo.empty")));
        }
        let work_dir = self.work_dir.trim();
        if !work_dir.is_empty() {
            let path = Path::new(work_dir);
            if path.is_dir() {
                return Ok(Target::Dir(path.to_path_buf()));
            }
        }
        if let Some(branch) = self
            .branch
            .as_deref()
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
        {
            return Ok(Target::Ref(branch.to_string()));
        }
        Err(WorkspaceError::new(tr_args(
            "workspace.workdir.missing",
            &[&self.work_dir],
        )))
    }

    fn baseline_ish(&self) -> Option<&str> {
        self.baseline
            .as_deref()
            .map(str::trim)
            .filter(|baseline| !baseline.is_empty())
    }

    /// Directory target: baseline against the live working tree, plus
    /// untracked files.
    fn dir_summary(&self, root: &Path) -> Result<ChangeSummary, WorkspaceError> {
        let git = Git::new(root);
        let baseline = self.baseline_ish();
        let ish = baseline.unwrap_or(EMPTY_TREE);
        let excluded = self.excluded_set(root);

        let numstat = git.stdout(&["diff", "--numstat", "--no-renames", ish])?;
        let name_status = git.stdout(&["diff", "--name-status", "--no-renames", ish])?;
        let statuses = parse_name_status(&name_status);

        let mut files = Vec::new();
        let mut file_count = 0usize;
        let mut additions = 0usize;
        let mut deletions = 0usize;
        let mut seen = HashSet::new();

        for (path, stat) in parse_numstat(&numstat) {
            if !seen.insert(path.clone()) {
                continue;
            }
            if excluded.contains(&self.normalize_path(&path, root)) {
                continue;
            }
            file_count += 1;
            additions += stat.additions;
            deletions += stat.deletions;
            files.push(ChangedFile {
                status: statuses
                    .iter()
                    .find(|(status_path, _)| status_path == &path)
                    .map(|(_, kind)| *kind)
                    .unwrap_or(ChangeKind::Modified),
                path,
                additions: stat.additions,
                deletions: stat.deletions,
                binary: stat.binary,
            });
        }
        // A status entry missing from numstat still describes a real change.
        for (path, kind) in &statuses {
            if seen.contains(path) || excluded.contains(&self.normalize_path(path, root)) {
                continue;
            }
            seen.insert(path.clone());
            file_count += 1;
            files.push(ChangedFile {
                path: path.clone(),
                status: *kind,
                additions: 0,
                deletions: 0,
                binary: false,
            });
        }

        let untracked = git.stdout(&["ls-files", "--others", "--exclude-standard"])?;
        let untracked: Vec<&str> = untracked.lines().filter(|line| !line.is_empty()).collect();
        // Beyond the listing cap the per-file numstat calls would only produce
        // process noise; list the files with zero counts instead.
        let skip_untracked_stats = untracked.len() > MAX_LISTED_FILES;
        for path in untracked {
            if excluded.contains(&self.normalize_path(path, root)) {
                continue;
            }
            let stat = if skip_untracked_stats {
                Stat::default()
            } else {
                untracked_stat(&git, path)?
            };
            file_count += 1;
            additions += stat.additions;
            deletions += stat.deletions;
            files.push(ChangedFile {
                path: path.to_string(),
                status: ChangeKind::Added,
                additions: stat.additions,
                deletions: stat.deletions,
                binary: stat.binary,
            });
        }

        let porcelain = git.stdout(&["status", "--porcelain"])?;
        let dirty = status_paths(&porcelain)
            .any(|path| !excluded.contains(&self.normalize_path(path, root)));

        let head = git.head()?;
        let committed = match baseline {
            None => head.is_some(),
            Some(base) => match git.resolve(base) {
                Some(base) => head.as_deref() != Some(base.as_str()),
                // An unresolvable baseline may be a commit this clone has not
                // seen; any HEAD still counts as committed work.
                None => head.is_some(),
            },
        };

        files.truncate(MAX_LISTED_FILES);
        Ok(ChangeSummary {
            files,
            file_count,
            additions,
            deletions,
            dirty,
            committed,
            // Without a commit of its own, HEAD is still the baseline: report
            // no product commit instead of handing out the starting point.
            commit: committed.then_some(head).flatten(),
        })
    }

    /// Reference target: the worktree path is gone, so the branch supplies
    /// everything. No untracked files exist in this shape.
    fn ref_summary(&self, branch: &str) -> Result<ChangeSummary, WorkspaceError> {
        let git = Git::new(&self.repo_path);
        let baseline = self.baseline_ish();
        let ish = baseline.unwrap_or(EMPTY_TREE);
        let range = format!("{ish}..{branch}");
        let excluded = self.excluded_set(Path::new(&self.repo_path));

        let numstat = git.stdout(&["diff", "--numstat", "--no-renames", &range])?;
        let name_status = git.stdout(&["diff", "--name-status", "--no-renames", &range])?;
        let statuses = parse_name_status(&name_status);

        let mut files = Vec::new();
        let mut file_count = 0usize;
        let mut additions = 0usize;
        let mut deletions = 0usize;
        let mut seen = HashSet::new();

        for (path, stat) in parse_numstat(&numstat) {
            if !seen.insert(path.clone()) {
                continue;
            }
            if excluded.contains(&self.normalize_path(&path, Path::new(&self.repo_path))) {
                continue;
            }
            file_count += 1;
            additions += stat.additions;
            deletions += stat.deletions;
            files.push(ChangedFile {
                status: statuses
                    .iter()
                    .find(|(status_path, _)| status_path == &path)
                    .map(|(_, kind)| *kind)
                    .unwrap_or(ChangeKind::Modified),
                path,
                additions: stat.additions,
                deletions: stat.deletions,
                binary: stat.binary,
            });
        }
        for (path, kind) in &statuses {
            if seen.contains(path)
                || excluded.contains(&self.normalize_path(path, Path::new(&self.repo_path)))
            {
                continue;
            }
            seen.insert(path.clone());
            file_count += 1;
            files.push(ChangedFile {
                path: path.clone(),
                status: *kind,
                additions: 0,
                deletions: 0,
                binary: false,
            });
        }

        let tip = git.branch_tip(branch)?;
        let committed = match baseline {
            None => true,
            Some(base) => git.resolve(base).map(|base| base != tip).unwrap_or(true),
        };

        files.truncate(MAX_LISTED_FILES);
        Ok(ChangeSummary {
            files,
            file_count,
            additions,
            deletions,
            dirty: false,
            committed,
            // A branch still sitting on the baseline has no product commit.
            commit: committed.then_some(tip),
        })
    }

    fn dir_diff(&self, root: &Path, file: Option<&str>) -> Result<DiffView, WorkspaceError> {
        let git = Git::new(root);
        let ish = self.baseline_ish().unwrap_or(EMPTY_TREE);
        let file = file.map(str::trim).filter(|file| !file.is_empty());
        let text = match file {
            None => git.stdout(&["diff", "--no-color", "--no-renames", ish])?,
            Some(file) => {
                let path = self.normalize_path(file, root);
                if git.is_tracked(&path)? {
                    git.stdout(&["diff", "--no-color", "--no-renames", ish, "--", &path])?
                } else {
                    // `--no-index` exits 1 for "there is a difference", which
                    // is the normal case; only higher codes are failures.
                    git.stdout_allowed(
                        &["diff", "--no-index", "--no-color", "--", "/dev/null", &path],
                        &[1],
                    )?
                }
            }
        };
        Ok(diff_view(text))
    }

    fn ref_diff(&self, branch: &str, file: Option<&str>) -> Result<DiffView, WorkspaceError> {
        let git = Git::new(&self.repo_path);
        let ish = self.baseline_ish().unwrap_or(EMPTY_TREE);
        let range = format!("{ish}..{branch}");
        let file = file.map(str::trim).filter(|file| !file.is_empty());
        let text = match file {
            None => git.stdout(&["diff", "--no-color", "--no-renames", &range])?,
            Some(file) => {
                let path = self.normalize_path(file, Path::new(&self.repo_path));
                git.stdout(&["diff", "--no-color", "--no-renames", &range, "--", &path])?
            }
        };
        Ok(diff_view(text))
    }

    fn excluded_set(&self, root: &Path) -> HashSet<String> {
        self.excluded
            .iter()
            .map(|path| self.normalize_path(path, root))
            .filter(|path| !path.is_empty())
            .collect()
    }

    /// Turns a repo-relative or absolute path into a repo-relative path so the
    /// exclusion list and git's output compare equal.
    fn normalize_path(&self, raw: &str, root: &Path) -> String {
        let mut path = raw.trim().replace('\\', "/");
        for base in self.path_variants(root) {
            let base = base.to_string_lossy().replace('\\', "/");
            let prefix = base.trim_end_matches('/');
            if prefix.is_empty() {
                continue;
            }
            if path == prefix {
                return String::new();
            }
            if let Some(rest) = path.strip_prefix(&format!("{prefix}/")) {
                path = rest.to_string();
                break;
            }
        }
        while let Some(rest) = path.strip_prefix("./") {
            path = rest.to_string();
        }
        path
    }

    fn path_variants(&self, root: &Path) -> Vec<PathBuf> {
        let mut variants = Vec::new();
        for base in [root.to_path_buf(), PathBuf::from(&self.repo_path)] {
            if base.as_os_str().is_empty() {
                continue;
            }
            variants.push(base.clone());
            // macOS temp dirs live under /var, whose canonical form is
            // /private/var; accept either spelling of the same directory.
            if let Ok(canonical) = fs::canonicalize(&base) {
                if canonical != base {
                    variants.push(canonical);
                }
            }
        }
        variants
    }
}

/// One change's line counts; `binary` means git printed `-` for both.
#[derive(Clone, Copy, Debug, Default)]
struct Stat {
    additions: usize,
    deletions: usize,
    binary: bool,
}

struct Git {
    cwd: PathBuf,
}

impl Git {
    fn new(cwd: impl Into<PathBuf>) -> Self {
        Self { cwd: cwd.into() }
    }

    fn run(&self, args: &[&str], allowed_exit: &[i32]) -> Result<Output, WorkspaceError> {
        let output = Command::new("git")
            .arg("-c")
            .arg("core.quotepath=false")
            .args(args)
            .current_dir(&self.cwd)
            .output()
            .map_err(|err| WorkspaceError::new(tr_args("workspace.git.exec", &[&err])))?;
        let accepted = output.status.success()
            || output
                .status
                .code()
                .is_some_and(|code| allowed_exit.contains(&code));
        if accepted {
            Ok(output)
        } else {
            let command = args.join(" ");
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(WorkspaceError::new(tr_args(
                "workspace.git.failed",
                &[&command, &stderr.trim()],
            )))
        }
    }

    fn stdout(&self, args: &[&str]) -> Result<String, WorkspaceError> {
        self.stdout_allowed(args, &[])
    }

    fn stdout_allowed(
        &self,
        args: &[&str],
        allowed_exit: &[i32],
    ) -> Result<String, WorkspaceError> {
        let output = self.run(args, allowed_exit)?;
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// HEAD, or `None` on an unborn branch.
    fn head(&self) -> Result<Option<String>, WorkspaceError> {
        let output = self.stdout_allowed(&["rev-parse", "--verify", "--quiet", "HEAD"], &[1])?;
        let head = output.trim();
        Ok((!head.is_empty()).then(|| head.to_string()))
    }

    fn branch_tip(&self, branch: &str) -> Result<String, WorkspaceError> {
        let output = self.stdout(&["rev-parse", "--verify", branch])?;
        Ok(output.trim().to_string())
    }

    /// Resolves a commit-ish to a full hash; `None` when git cannot.
    fn resolve(&self, rev: &str) -> Option<String> {
        let output = self
            .stdout_allowed(&["rev-parse", "--verify", "--quiet", rev], &[1])
            .ok()?;
        let sha = output.trim();
        (!sha.is_empty()).then(|| sha.to_string())
    }

    fn is_tracked(&self, path: &str) -> Result<bool, WorkspaceError> {
        let listed = self.stdout(&["ls-files", "--cached", "--", path])?;
        Ok(!listed.trim().is_empty())
    }
}

/// Parses `git diff --numstat` output. `-` means binary, not zero lines.
fn parse_numstat(text: &str) -> Vec<(String, Stat)> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let additions = parts.next()?;
            let deletions = parts.next()?;
            let path = parts.next()?;
            if path.is_empty() {
                return None;
            }
            let binary = additions == "-" || deletions == "-";
            Some((
                path.to_string(),
                Stat {
                    additions: if binary {
                        0
                    } else {
                        additions.parse().unwrap_or(0)
                    },
                    deletions: if binary {
                        0
                    } else {
                        deletions.parse().unwrap_or(0)
                    },
                    binary,
                },
            ))
        })
        .collect()
}

/// Parses `git diff --name-status`; `T` (type change) counts as modified.
fn parse_name_status(text: &str) -> Vec<(String, ChangeKind)> {
    text.lines()
        .filter_map(|line| {
            let (code, path) = line.split_once('\t')?;
            if path.is_empty() {
                return None;
            }
            let kind = match code.chars().next()? {
                'A' => ChangeKind::Added,
                'D' => ChangeKind::Deleted,
                _ => ChangeKind::Modified,
            };
            Some((path.to_string(), kind))
        })
        .collect()
}

/// `git status --porcelain` paths, taking the new name out of a rename.
fn status_paths(text: &str) -> impl Iterator<Item = &str> {
    text.lines().filter_map(|line| {
        let line = line.trim_end_matches('\r');
        if line.len() < 4 {
            return None;
        }
        let rest = &line[3..];
        let path = rest.rsplit(" -> ").next().unwrap_or(rest);
        (!path.is_empty()).then_some(path)
    })
}

/// Line counts for one untracked file via `--no-index`. The numstat path
/// column is `/dev/null => <path>`, so only the first three fields matter.
fn untracked_stat(git: &Git, path: &str) -> Result<Stat, WorkspaceError> {
    let output = git.stdout_allowed(
        &[
            "diff",
            "--no-index",
            "--numstat",
            "--no-color",
            "--",
            "/dev/null",
            path,
        ],
        &[1],
    )?;
    Ok(parse_numstat(&output)
        .into_iter()
        .next()
        .map(|(_, stat)| stat)
        .unwrap_or_default())
}

fn diff_view(text: String) -> DiffView {
    let truncated = text.chars().count() > MAX_DIFF_CHARS;
    let text = if truncated {
        text.chars().take(MAX_DIFF_CHARS).collect()
    } else {
        text
    };
    let empty = text.trim().is_empty();
    DiffView {
        text,
        truncated,
        empty,
    }
}
