//! Messages for `tapd-workspace`: repository, worktree and git command errors.
//! Key format: `workspace.topic`.

use crate::Message;

pub static MESSAGES: &[Message] = &[
    ("workspace.repo.empty", "仓库路径为空", "The repository path is empty"),
    ("workspace.path.escape", "文件路径超出工作目录：{}", "The file path escapes the working directory: {}"),
    ("workspace.workdir.missing", "工作目录不存在：{}", "The working directory does not exist: {}"),
    ("workspace.git.exec", "无法执行 git：{}", "Failed to run git: {}"),
    ("workspace.git.failed", "git {} 失败：{}", "git {} failed: {}"),
];
