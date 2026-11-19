//! Messages for the built-in agent's task workflow
//! (queued → running → review → finalizing → done).

use crate::Message;

pub static MESSAGES: &[Message] = &[
    (
        "dsh.bridge.rejected",
        "运行时拒绝了这次请求",
        "The runtime rejected the request",
    ),
    (
        "dsh.chat.delete.running",
        "会话还在运行，先停止再删除",
        "The conversation is still running; stop it before deleting",
    ),
    (
        "dsh.chat.worktree.dirty",
        "worktree 有未提交改动，先提交或丢弃后再关闭",
        "The worktree has uncommitted changes; commit or discard them before turning it off",
    ),
    (
        "dsh.chat.worktree.notChat",
        "只有自由会话可以切换 worktree",
        "Only a free conversation can toggle a worktree",
    ),
    (
        "dsh.chat.worktree.repo",
        "会话所属项目还没有配置本地仓库目录",
        "The conversation's project has no local repository configured",
    ),
    (
        "dsh.task.approve.busy",
        "模型还在运行，等这一轮结束后再审核",
        "The model is still running; approve after this turn ends",
    ),
    (
        "dsh.task.queued",
        "任务还在排队中，等它开始运行后再对话",
        "The task is still queued; talk to it once it starts running",
    ),
    (
        "dsh.task.busy",
        "任务正在运行，请稍后再试",
        "The task is still running; try again shortly",
    ),
    (
        "dsh.task.cancel.busy",
        "任务正在收尾，等收尾结束后再取消",
        "The task is finishing; cancel after it settles",
    ),
    (
        "dsh.task.cancel.stash",
        "储藏改动失败：{}",
        "Failed to stash the changes: {}",
    ),
    (
        "dsh.task.comment.empty",
        "评论内容不能为空",
        "The comment must not be empty",
    ),
    (
        "dsh.task.comment.tooLong",
        "评论最多 8000 个字符",
        "A comment may hold at most 8000 characters",
    ),
    (
        "dsh.task.commit.failed",
        "提交改动失败：{}",
        "Failed to commit the changes: {}",
    ),
    (
        "dsh.task.complete.pending",
        "收尾未完成：请先写评论并更新状态",
        "Finishing is incomplete: add the comment and update the status first",
    ),
    (
        "dsh.task.export.failed",
        "导出缺陷包失败：{}",
        "Failed to export the bug package: {}",
    ),
    (
        "dsh.task.finalize.busy",
        "任务正在收尾，请稍后再试",
        "The task is already finishing; try again shortly",
    ),
    (
        "dsh.task.finalize.dirty",
        "worktree 有未提交改动，目录已保留",
        "The worktree had uncommitted changes; its directory was kept",
    ),
    (
        "dsh.task.finalize.incomplete",
        "回写未完成：评论或状态尚未写完，可重试收尾",
        "The write-back is incomplete: the comment or status is missing, retry finishing",
    ),
    (
        "dsh.task.finalize.instructions.cleanup",
        "关闭占用 worktree 目录的程序后重试收尾",
        "Close anything using the worktree directory, then retry finishing",
    ),
    (
        "dsh.task.finalize.instructions.commit",
        "检查 worktree 的 git 状态后重试收尾",
        "Check the worktree's git status, then retry finishing",
    ),
    (
        "dsh.task.finalize.instructions.writeback",
        "在收尾回合完成评论与状态后重试收尾",
        "Finish the comment and status in the write-back turn, then retry",
    ),
    (
        "dsh.task.git.failed",
        "git 操作失败：{}",
        "A git operation failed: {}",
    ),
    (
        "dsh.task.host.unknown",
        "未知的宿主方法：{}",
        "Unknown host method: {}",
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
        "dsh.task.submit.summary",
        "task_submit 需要一段改动摘要",
        "task_submit needs a summary of the change",
    ),
    (
        "dsh.task.worktree.failed",
        "创建 worktree 失败：{}",
        "Failed to create the worktree: {}",
    ),
    (
        "dsh.task.writeback.failed",
        "回写 TAPD 失败：{}",
        "Failed to write back to TAPD: {}",
    ),
    (
        "dsh.task.writeback.directRepo",
        "本轮直接在主仓库工作，改动已提交到主仓库。",
        "This round worked directly in the main repository; its changes were committed there.",
    ),
    (
        "dsh.task.writeback.hostComment",
        "AI 收尾未完成，由宿主补写回写。\n摘要：{0}\n验证：{1}\n风险：{2}\n分支：{3}\n提交：{4}\n变更：{5} 个文件，+{6} / -{7}\n缺陷：{8}",
        "The AI write-back was incomplete, so the host completed it.\nSummary: {0}\nVerification: {1}\nRisks: {2}\nBranch: {3}\nCommit: {4}\nChanges: {5} files, +{6} / -{7}\nBug: {8}",
    ),
    (
        "dsh.task.writeback.hostNotice",
        "AI 未完成回写，宿主已补写评论并流转状态",
        "The AI did not finish the write-back; the host posted the comment and moved the status",
    ),
    (
        "dsh.task.writeback.prompt",
        "代码已由宿主提交到主仓库，不再改动代码。\n分支：{0}\n提交：{1}\n合并：{2}\n{3}\n变更：{4} 个文件，+{5} / -{6}\n缺陷：{7}\n\n请只做 TAPD 收尾：先调用 tapd_get_transitions 确认合法目标；再用 tapd_add_comment 写评论（根因、改动、验证、风险、分支与提交）；然后调用 tapd_update_status 置为 resolved；最后调用 task_complete。不要 push，不要再改代码；回复只报告评论与状态结果。",
        "The host committed the work to the main repository; do not change code again.\nBranch: {0}\nCommit: {1}\nMerge: {2}\n{3}\nChanges: {4} files, +{5} / -{6}\nBug: {7}\n\nOnly finish the TAPD write-back: call tapd_get_transitions to confirm the legal targets; then tapd_add_comment with the root cause, changes, verification, risks, branch and commit; then tapd_update_status to resolved; finally call task_complete. Do not push and do not change code again; reply only with the comment and status result.",
    ),
    (
        "dsh.task.writeback.worktreeKept",
        "worktree 保留在 {0}（仍有未提交改动）。",
        "The worktree was kept at {0} (it still has uncommitted changes).",
    ),
    (
        "dsh.task.writeback.worktreeRemoved",
        "worktree 已清理，会话已回到主仓库。",
        "The worktree was cleaned up and the session is back in the main repository.",
    ),
    (
        "dsh.worktree.outside",
        "只能清理应用自己创建的 worktree",
        "Only worktrees created by this app can be cleaned up here",
    ),
];
