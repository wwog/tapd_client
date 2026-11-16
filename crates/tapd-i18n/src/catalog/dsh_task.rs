//! Messages for the built-in agent's task workflow (prepare → review → merge).

use crate::Message;

pub static MESSAGES: &[Message] = &[
    (
        "dsh.task.busy",
        "任务正在运行，请稍后再试",
        "The task is still running; try again shortly",
    ),
    (
        "dsh.task.cancel.stash",
        "储藏改动失败：{}",
        "Failed to stash the changes: {}",
    ),
    (
        "dsh.task.commit.failed",
        "提交改动失败：{}",
        "Failed to commit the changes: {}",
    ),
    (
        "dsh.task.export.failed",
        "导出缺陷包失败：{}",
        "Failed to export the bug package: {}",
    ),
    (
        "dsh.task.git.failed",
        "git 操作失败：{}",
        "A git operation failed: {}",
    ),
    (
        "dsh.task.local.repo",
        "事项所在项目的目录不是 git 仓库",
        "The item's project folder is not a git repository",
    ),
    (
        "dsh.task.merge.ancestor",
        "分支还没有并入当前 HEAD",
        "The branch is not merged into the current HEAD yet",
    ),
    (
        "dsh.task.merge.dirty",
        "主仓库有未提交改动，请先提交或储藏",
        "The main repository has uncommitted changes; commit or stash them first",
    ),
    (
        "dsh.task.merge.failed",
        "合并分支失败：{}",
        "Failed to merge the branch: {}",
    ),
    (
        "dsh.task.merge.instructions",
        "在主仓库执行 git merge --no-ff {0} 后重试",
        "Run `git merge --no-ff {0}` in the main repository, then retry",
    ),
    (
        "dsh.task.no.changes",
        "任务没有产生改动",
        "The task produced no changes",
    ),
    ("dsh.task.notFound", "任务不存在：{}", "Task not found: {}"),
    (
        "dsh.task.prompt.rule",
        "\n\n项目规则：\n",
        "\n\nProject rules:\n",
    ),
    (
        "dsh.task.resume.failed",
        "恢复会话失败：{}",
        "Failed to resume the session: {}",
    ),
    (
        "dsh.task.repo.missing",
        "项目还没有配置本地仓库目录",
        "The project has no local repository configured",
    ),
    (
        "dsh.task.state.invalid",
        "任务当前状态不允许该操作",
        "The task is not in a state that allows this action",
    ),
    (
        "dsh.task.store",
        "任务记录不可用",
        "The task record store is unavailable",
    ),
    (
        "dsh.task.worktree.failed",
        "创建 worktree 失败：{}",
        "Failed to create the worktree: {}",
    ),
    (
        "dsh.task.writeback.branch",
        "\n\n分支：{0}",
        "\n\nBranch: {0}",
    ),
    (
        "dsh.task.writeback.comment",
        "内置 Agent 已完成：{0} 个文件，+{1} / -{2}",
        "The built-in agent finished: {0} files, +{1} / -{2}",
    ),
    (
        "dsh.task.writeback.failed",
        "回写 TAPD 失败：{}",
        "Failed to write back to TAPD: {}",
    ),
];
