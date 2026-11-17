//! Messages for the built-in agent's task workflow (prepare → review → merge).

use crate::Message;

pub static MESSAGES: &[Message] = &[
    (
        "dsh.chat.delete.running",
        "会话还在运行，先停止再删除",
        "The conversation is still running; stop it before deleting",
    ),
    (
        "dsh.task.approve.busy",
        "模型还在运行，等这一轮结束后再审核",
        "The model is still running; approve after this turn ends",
    ),
    (
        "dsh.task.busy",
        "任务正在运行，请稍后再试",
        "The task is still running; try again shortly",
    ),
    (
        "dsh.task.cancel.busy",
        "正在合并，等合并结束后再取消",
        "A merge is in progress; cancel after it finishes",
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
        "dsh.task.merge.empty",
        "分支没有新提交，未执行合并（改动可能已被还原）",
        "The branch has no new commits; nothing was merged (the changes may have been reverted)",
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
    (
        "dsh.worktree.outside",
        "只能清理应用自己创建的 worktree",
        "Only worktrees created by this app can be cleaned up here",
    ),
    // Team mode: guidance queued to the lead session when coworkers are enabled.
    (
        "dsh.team.roster",
        "团队协作已开启。可用的同事：\n{0}\n1. 把工作拆成任务板上的任务（team_task_create）；\n2. 每部分指派给匹配的同事，并要求该子 agent 先读取对应技能包的 SKILL.md；\n3. 没有匹配的同事时，按性质派给普通子 agent。",
        "Team collaboration is on. Available coworkers:\n{0}\n1. Split the work into tasks on the shared board (team_task_create);\n2. Assign each part to a matching coworker and tell that subagent to read the matching SKILL.md first;\n3. Use a plain subagent when nobody matches.",
    ),
    (
        "dsh.team.roster.empty",
        "团队协作已开启。本轮没有启用协作同事，请把工作拆成任务板上的任务（team_task_create），再按依赖顺序推进。",
        "Team collaboration is on. No coworkers are enabled: split the work into tasks on the shared board (team_task_create), then work through them in dependency order.",
    ),
];
