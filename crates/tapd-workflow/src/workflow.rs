//! Sans-IO workflow state machine.
//!
//! The host feeds [`Input`] facts and receives [`Effect`]s to execute. The core
//! owns task state, scheduling, review/merge policy and recovery; it never
//! touches the clock, ids, the filesystem or the environment.

use crate::config::WorkflowConfig;
use crate::effect::{Effect, EffectId, NoticeLevel, RecoveryReport};
use crate::history::HistoryRecord;
use crate::input::{Input, MergeBlock, RunOutcome};
use crate::policy::{blocked, has_live_task, manual_merge_instructions, worktree_toggle_locked};
use crate::recovery::recover;
use crate::scheduler::{active_count, next_queued_index, task_counts, TaskCounts};
use crate::task::{
    ChangeSet, Snapshot, Task, TaskApproval, TaskId, TaskMerge, TaskSpec, TaskStatus, Timestamp,
    WorktreeRef,
};

const STOPPED_REVIEW_ERROR: &str = "已停止审核，改动保留在工作区";
const CANCELED_ERROR: &str = "已取消";
const CANCELED_MERGE_ERROR: &str = "已取消合并";
const MERGE_ABORTED_ERROR: &str = "合并已中止";
const COMMIT_DIRTY_ERROR: &str = "提交阶段仍有未提交改动";
const BRANCH_NOT_MERGED_ERROR: &str = "分支尚未并入主仓库";

#[derive(Clone, Debug)]
pub struct Workflow {
    tasks: Vec<Task>,
    config: WorkflowConfig,
    paused: bool,
    entered: bool,
    loaded: bool,
    entered_at: Timestamp,
    /// Last host-provided timestamp, used for receipts that carry no `now`.
    clock: Timestamp,
    recovery: Option<RecoveryReport>,
    next_effect_id: u64,
    next_report_id: u64,
    generation: u64,
    /// Reviews waiting for a host workspace inspection before deciding
    /// commit-only vs. merge, with the time of the user decision.
    pending_inspections: Vec<(TaskId, Timestamp)>,
    /// Merge requests waiting for `MergePreconditionsChecked`.
    pending_merges: Vec<(TaskId, Timestamp)>,
    /// Agent merge error kept until `BranchMergeVerified` reports.
    pending_merge_errors: Vec<(TaskId, Option<String>)>,
    /// Verification requests waiting for `BranchMergeVerified`.
    pending_verifications: Vec<(TaskId, Timestamp)>,
}

impl Default for Workflow {
    fn default() -> Self {
        Self::new()
    }
}

impl Workflow {
    pub fn new() -> Self {
        Self::with_config(WorkflowConfig::default())
    }

    pub fn with_config(config: WorkflowConfig) -> Self {
        Self {
            tasks: Vec::new(),
            config,
            paused: false,
            entered: false,
            loaded: false,
            entered_at: String::new(),
            clock: String::new(),
            recovery: None,
            next_effect_id: 1,
            next_report_id: 1,
            generation: 0,
            pending_inspections: Vec::new(),
            pending_merges: Vec::new(),
            pending_merge_errors: Vec::new(),
            pending_verifications: Vec::new(),
        }
    }

    // -- accessors ----------------------------------------------------------

    pub fn tasks(&self) -> &[Task] {
        &self.tasks
    }

    pub fn config(&self) -> &WorkflowConfig {
        &self.config
    }

    pub fn paused(&self) -> bool {
        self.paused
    }

    pub fn entered(&self) -> bool {
        self.entered
    }

    pub fn recovery_report(&self) -> Option<&RecoveryReport> {
        self.recovery.as_ref()
    }

    pub fn task(&self, id: &TaskId) -> Option<&Task> {
        self.tasks.iter().find(|task| &task.id == id)
    }

    pub fn counts(&self) -> TaskCounts {
        task_counts(&self.tasks)
    }

    pub fn worktree_toggle_locked(&self, next: bool) -> bool {
        worktree_toggle_locked(
            self.config.worktree_enabled,
            next,
            has_live_task(&self.tasks),
        )
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            schema_version: crate::SCHEMA_VERSION,
            config: self.config.clone(),
            paused: self.paused,
            tasks: self.tasks.clone(),
            generation: self.generation,
        }
    }

    // -- protocol -----------------------------------------------------------

    pub fn apply(&mut self, input: Input) -> Vec<Effect> {
        let mut effects = Vec::new();
        self.handle(input, &mut effects);
        if effects.iter().any(|effect| {
            matches!(
                effect,
                Effect::PersistChanged { .. } | Effect::PersistConfig { .. } | Effect::StateChanged
            )
        }) {
            self.generation = self.generation.wrapping_add(1);
        }
        effects
    }

    fn handle(&mut self, input: Input, effects: &mut Vec<Effect>) {
        match input {
            Input::SystemEntered { now } => self.on_system_entered(now, effects),
            Input::SnapshotLoaded { snapshot } => self.on_snapshot_loaded(snapshot, effects),
            Input::Suspend { now } => self.on_suspend(now, effects),
            Input::AcknowledgeRecovery { report_id } => {
                if self.recovery.as_ref().map(|report| report.id) == Some(report_id) {
                    self.recovery = None;
                }
            }
            Input::Enqueue { task_id, spec, now } => self.on_enqueue(task_id, spec, now, effects),
            Input::Retry {
                task_id,
                new_id,
                now,
            } => self.on_retry(task_id, new_id, now, effects),
            Input::ApproveReview { task_id, now } => self.on_approve_review(task_id, now, effects),
            Input::StopReview { task_id, now } => self.on_stop_review(task_id, now, effects),
            Input::StartMerge { task_id, now } => self.on_start_merge(task_id, now, effects),
            Input::VerifyMerge { task_id, now } => self.on_verify_merge(task_id, now, effects),
            Input::Cancel { task_id, now } => self.on_cancel(task_id, now, effects),
            Input::DeleteTerminal { task_id } => self.on_delete_terminal(task_id, effects),
            Input::ResumeQueue { now } => {
                self.clock = now;
                self.paused = false;
                effects.push(Effect::StateChanged);
            }
            Input::SetConfig { config } => self.on_set_config(config, effects),
            Input::AgentStarted { task_id } => self.on_agent_started(task_id, effects),
            Input::AgentStartFailed { task_id, error } => {
                self.on_agent_start_failed(task_id, error, effects)
            }
            Input::RunFinished {
                task_id,
                outcome,
                now,
            } => self.on_run_finished(task_id, outcome, now, effects),
            Input::WorktreeCreated { task_id, worktree } => {
                self.on_worktree_created(task_id, worktree, effects)
            }
            Input::WorktreeCreateFailed { task_id, error } => {
                self.on_worktree_create_failed(task_id, error, effects)
            }
            Input::WorktreeRemoved { task_id, error } => {
                self.on_worktree_removed(task_id, error, effects)
            }
            Input::WorkspaceInspected { task_id, changes } => {
                self.on_workspace_inspected(task_id, changes, effects)
            }
            Input::MergePreconditionsChecked { task_id, result } => {
                self.on_merge_preconditions_checked(task_id, result, effects)
            }
            Input::MergeAgentFinished {
                task_id,
                outcome,
                now,
            } => self.on_merge_agent_finished(task_id, outcome, now, effects),
            Input::BranchMergeVerified {
                task_id,
                merged,
                error,
            } => self.on_branch_merge_verified(task_id, merged, error, effects),
        }
        self.schedule(effects);
    }

    // -- lifecycle ----------------------------------------------------------

    fn on_system_entered(&mut self, now: Timestamp, effects: &mut Vec<Effect>) {
        self.clock = now.clone();
        if self.entered {
            return;
        }
        self.entered = true;
        self.loaded = false;
        self.entered_at = now;
        self.recovery = None;
        effects.push(Effect::LoadSnapshot);
    }

    fn on_snapshot_loaded(&mut self, snapshot: Snapshot, effects: &mut Vec<Effect>) {
        if !self.entered {
            effects.push(Effect::rejected("system not entered"));
            return;
        }
        if self.loaded {
            return;
        }
        self.config = snapshot.config;
        self.paused = snapshot.paused;
        self.tasks = snapshot.tasks;

        let restored_at = self.entered_at.clone();
        let outcome = recover(&mut self.tasks, &self.config, &restored_at);
        let changed: Vec<Task> = outcome
            .changed
            .iter()
            .filter_map(|index| self.tasks.get(*index).cloned())
            .collect();
        let failed: Vec<Task> = outcome
            .failed
            .iter()
            .filter_map(|index| self.tasks.get(*index).cloned())
            .collect();

        if !changed.is_empty() {
            effects.push(Effect::PersistChanged { tasks: changed });
        }
        for task in &failed {
            self.push_history(effects, task);
        }

        let report = RecoveryReport {
            id: self.next_report_id,
            restored_at,
            queued: outcome.queued,
            retried: outcome.retried,
            awaiting_approval: outcome.awaiting_approval,
            awaiting_merge: outcome.awaiting_merge,
            failed: outcome.failed.len(),
        };
        self.next_report_id = self.next_report_id.wrapping_add(1);
        self.recovery = Some(report.clone());
        effects.push(Effect::EmitRecoveryReport { report });
        self.loaded = true;
    }

    fn on_suspend(&mut self, now: Timestamp, effects: &mut Vec<Effect>) {
        self.clock = now.clone();
        let changed = crate::recovery::suspend(&mut self.tasks, &now)
            .into_iter()
            .map(|index| self.tasks[index].clone())
            .collect();
        // Stop is final for this session: the next SystemEntered must load the
        // persisted snapshot again.
        self.entered = false;
        self.loaded = false;
        self.recovery = None;
        self.pending_inspections.clear();
        self.pending_merges.clear();
        self.pending_merge_errors.clear();
        self.pending_verifications.clear();
        effects.push(Effect::PersistChanged { tasks: changed });
    }

    // -- admission ----------------------------------------------------------

    fn on_enqueue(
        &mut self,
        task_id: TaskId,
        spec: TaskSpec,
        now: Timestamp,
        effects: &mut Vec<Effect>,
    ) {
        self.clock = now.clone();
        if !self.entered {
            effects.push(Effect::rejected("system not entered"));
            return;
        }
        if self.tasks.iter().any(|task| task.id == task_id) {
            effects.push(Effect::rejected(format!("任务已存在：{task_id}")));
            return;
        }
        if let Some(existing) = self.tasks.iter().find(|task| {
            task.spec.workspace_id == spec.workspace_id
                && task.spec.bug_id == spec.bug_id
                && !task.status.is_terminal()
        }) {
            effects.push(Effect::rejected(format!(
                "该缺陷已有未结束的任务（{}）",
                status_key(existing.status)
            )));
            return;
        }
        let task = Task::new(task_id, spec, now);
        self.tasks.push(task.clone());
        self.push_persist(effects, &task);
    }

    fn on_retry(
        &mut self,
        task_id: TaskId,
        new_id: TaskId,
        now: Timestamp,
        effects: &mut Vec<Effect>,
    ) {
        self.clock = now.clone();
        if !self.entered {
            effects.push(Effect::rejected("system not entered"));
            return;
        }
        let Some(mut task) = self.task(&task_id).cloned() else {
            effects.push(Effect::rejected("任务不存在"));
            return;
        };
        if !task.status.is_terminal() {
            effects.push(Effect::rejected("任务仍在队列或运行中，不能重试"));
            return;
        }
        if self.tasks.iter().any(|other| other.id == new_id) {
            effects.push(Effect::rejected(format!("任务已存在：{new_id}")));
            return;
        }
        if self.tasks.iter().any(|other| {
            other.spec.workspace_id == task.spec.workspace_id
                && other.spec.bug_id == task.spec.bug_id
                && !other.status.is_terminal()
        }) {
            effects.push(Effect::rejected(format!(
                "该缺陷已有未结束的任务（{}）",
                task.spec.bug_id
            )));
            return;
        }

        task.id = new_id;
        task.status = TaskStatus::Queued;
        task.attempt = 0;
        task.interrupted = false;
        task.created_at = now;
        task.started_at = None;
        task.finished_at = None;
        task.exit_code = None;
        task.error = None;
        task.approval = None;
        task.merge = None;
        task.changes = None;
        task.commit_only = false;
        task.baseline_dirty.clear();
        task.baseline_head = None;
        task.worktree_path = None;
        task.worktree_branch = None;

        self.tasks.push(task.clone());
        self.push_persist(effects, &task);
    }

    // -- review -------------------------------------------------------------

    fn on_approve_review(&mut self, task_id: TaskId, now: Timestamp, effects: &mut Vec<Effect>) {
        self.clock = now.clone();
        let Some(task) = self.task(&task_id).cloned() else {
            effects.push(Effect::rejected("任务不存在"));
            return;
        };
        if task.status != TaskStatus::AwaitingApproval {
            effects.push(Effect::rejected("任务不在待审核状态"));
            return;
        }
        if task.changes.is_none() {
            self.pending_inspections.retain(|(id, _)| id != &task_id);
            self.pending_inspections.push((task_id.clone(), now));
            let effect = self.effect_id();
            effects.push(Effect::InspectWorkspace {
                effect,
                task_id,
                path: task.work_dir().to_string(),
            });
            return;
        }
        self.decide_approval(task_id, now, effects);
    }

    fn on_workspace_inspected(
        &mut self,
        task_id: TaskId,
        changes: ChangeSet,
        effects: &mut Vec<Effect>,
    ) {
        let Some(index) = self.task_index(&task_id) else {
            return;
        };
        self.tasks[index].changes = Some(changes);
        let pending = self
            .pending_inspections
            .iter()
            .position(|(id, _)| id == &task_id)
            .map(|position| self.pending_inspections.remove(position));
        if let Some((_, decided_at)) = pending {
            self.decide_approval(task_id, decided_at, effects);
        } else {
            let task = self.tasks[index].clone();
            self.push_persist(effects, &task);
        }
    }

    fn decide_approval(&mut self, task_id: TaskId, now: Timestamp, effects: &mut Vec<Effect>) {
        let Some(index) = self.task_index(&task_id) else {
            return;
        };
        if self.tasks[index].status != TaskStatus::AwaitingApproval {
            return;
        }
        // Approving is an explicit continue signal; a queue paused by an
        // earlier stop resumes unless another review still blocks it.
        self.paused = false;

        let (is_worktree, dirty, repo, branch) = {
            let task = &self.tasks[index];
            (
                task.is_worktree(),
                task.changes
                    .as_ref()
                    .map(|changes| changes.dirty)
                    .unwrap_or(false),
                task.spec.repo_path.clone(),
                task.branch().unwrap_or("").to_string(),
            )
        };
        let task = &mut self.tasks[index];
        task.finished_at = None;
        task.error = None;
        task.exit_code = None;
        task.started_at = None;
        if let Some(approval) = task.approval.as_mut() {
            approval.approved_at = Some(now);
        }
        if is_worktree && !dirty {
            task.status = TaskStatus::AwaitingMerge;
            task.commit_only = false;
            let merge = task.merge.get_or_insert_with(TaskMerge::default);
            merge.error = None;
            merge.instructions = Some(manual_merge_instructions(&repo, &branch));
            merge.started_at = None;
            merge.finished_at = None;
        } else {
            task.status = TaskStatus::Queued;
            task.commit_only = true;
            task.merge = None;
        }
        let changed = task.clone();
        self.push_persist(effects, &changed);
    }

    fn on_stop_review(&mut self, task_id: TaskId, now: Timestamp, effects: &mut Vec<Effect>) {
        self.clock = now.clone();
        let Some(task) = self.task(&task_id) else {
            effects.push(Effect::rejected("任务不存在"));
            return;
        };
        if task.status != TaskStatus::AwaitingApproval {
            effects.push(Effect::rejected("任务不在待审核状态"));
            return;
        }
        self.stop_review(task_id, now, effects);
    }

    fn stop_review(&mut self, task_id: TaskId, now: Timestamp, effects: &mut Vec<Effect>) {
        let Some(index) = self.task_index(&task_id) else {
            return;
        };
        if self.tasks[index].status != TaskStatus::AwaitingApproval {
            return;
        }
        let task = &mut self.tasks[index];
        task.status = TaskStatus::Canceled;
        task.finished_at = Some(now);
        task.exit_code = None;
        task.error = Some(STOPPED_REVIEW_ERROR.to_string());
        task.commit_only = false;
        task.interrupted = false;
        // Stopping keeps the queue halted until the user explicitly resumes.
        self.paused = true;
        let changed = task.clone();
        self.push_persist(effects, &changed);
        self.push_history(effects, &changed);
    }

    // -- merge --------------------------------------------------------------

    fn on_start_merge(&mut self, task_id: TaskId, now: Timestamp, effects: &mut Vec<Effect>) {
        self.clock = now.clone();
        let Some(task) = self.task(&task_id).cloned() else {
            effects.push(Effect::rejected("任务不存在"));
            return;
        };
        if task.status != TaskStatus::AwaitingMerge {
            effects.push(Effect::rejected("任务不在待合并状态"));
            return;
        }
        let Some(branch) = task.branch().map(str::to_string) else {
            effects.push(Effect::rejected("任务没有待合并分支"));
            return;
        };
        let repo = task.spec.repo_path.trim().to_string();
        if repo.is_empty() {
            effects.push(Effect::rejected("主仓库路径为空"));
            return;
        }
        if self.repo_is_merging(&repo, Some(&task_id)) {
            effects.push(Effect::rejected("该仓库已有任务正在合并，请稍后重试"));
            return;
        }

        self.pending_merges.retain(|(id, _)| id != &task_id);
        self.pending_merges.push((task_id.clone(), now));
        let effect = self.effect_id();
        effects.push(Effect::CheckMergePreconditions {
            effect,
            task_id,
            repo_path: repo,
            branch,
        });
    }

    fn on_merge_preconditions_checked(
        &mut self,
        task_id: TaskId,
        result: Result<(), MergeBlock>,
        effects: &mut Vec<Effect>,
    ) {
        let requested_at = self
            .pending_merges
            .iter()
            .position(|(id, _)| id == &task_id)
            .map(|position| self.pending_merges.remove(position).1)
            .unwrap_or_else(|| self.clock.clone());
        let Some(index) = self.task_index(&task_id) else {
            return;
        };
        if self.tasks[index].status != TaskStatus::AwaitingMerge {
            return;
        }
        let (repo, branch, spec) = {
            let task = &self.tasks[index];
            (
                task.spec.repo_path.clone(),
                task.branch().unwrap_or("").to_string(),
                task.spec.clone(),
            )
        };
        let Some((repo, branch, spec)) = repo_and_branch(repo, branch, spec) else {
            self.rollback_merge(
                task_id,
                MergeBlock::WorktreeMissing.message(),
                false,
                effects,
            );
            return;
        };

        match result {
            Ok(()) => {
                let task = &mut self.tasks[index];
                task.status = TaskStatus::Merging;
                task.finished_at = None;
                task.error = None;
                let merge = task.merge.get_or_insert_with(TaskMerge::default);
                merge.error = None;
                merge.instructions = None;
                merge.started_at = Some(requested_at);
                merge.finished_at = None;
                let changed = task.clone();
                self.push_persist(effects, &changed);
                let effect = self.effect_id();
                effects.push(Effect::StartMergeAgent {
                    effect,
                    task_id,
                    repo_path: repo,
                    branch,
                    spec,
                });
            }
            Err(block) => {
                let message = block.message();
                self.merge_blocked(&task_id, &repo, &branch, message, effects);
                effects.push(Effect::merge_block_notice(&task_id, &block));
            }
        }
    }

    fn on_merge_agent_finished(
        &mut self,
        task_id: TaskId,
        outcome: RunOutcome,
        now: Timestamp,
        effects: &mut Vec<Effect>,
    ) {
        self.clock = now.clone();
        let Some(index) = self.task_index(&task_id) else {
            return;
        };
        if self.tasks[index].status != TaskStatus::Merging {
            return;
        }
        // The merge runner's exit code is not the fix run's exit code, so keep
        // the task's existing value for history. The branch is the source of
        // truth for success either way.
        let (repo, branch) = {
            let task = &self.tasks[index];
            (
                task.spec.repo_path.clone(),
                task.branch().unwrap_or("").to_string(),
            )
        };
        if repo.trim().is_empty() || branch.trim().is_empty() {
            self.rollback_merge(
                task_id,
                MergeBlock::WorktreeMissing.message(),
                false,
                effects,
            );
            return;
        }

        self.pending_merge_errors.retain(|(id, _)| id != &task_id);
        self.pending_merge_errors
            .push((task_id.clone(), outcome.error.clone()));
        self.pending_verifications.retain(|(id, _)| id != &task_id);
        self.pending_verifications.push((task_id.clone(), now));

        let changed = self.tasks[index].clone();
        self.push_persist(effects, &changed);
        let effect = self.effect_id();
        effects.push(Effect::VerifyBranchMerged {
            effect,
            task_id,
            repo_path: repo,
            branch,
        });
    }

    fn on_verify_merge(&mut self, task_id: TaskId, now: Timestamp, effects: &mut Vec<Effect>) {
        self.clock = now.clone();
        let Some(task) = self.task(&task_id).cloned() else {
            effects.push(Effect::rejected("任务不存在"));
            return;
        };
        if task.status != TaskStatus::AwaitingMerge {
            effects.push(Effect::rejected("任务不在待合并状态"));
            return;
        }
        let Some(branch) = task.branch().map(str::to_string) else {
            effects.push(Effect::rejected("任务没有待合并分支"));
            return;
        };
        let repo = task.spec.repo_path.clone();
        self.pending_verifications.retain(|(id, _)| id != &task_id);
        self.pending_verifications.push((task_id.clone(), now));
        let effect = self.effect_id();
        effects.push(Effect::VerifyBranchMerged {
            effect,
            task_id,
            repo_path: repo,
            branch,
        });
    }

    fn on_branch_merge_verified(
        &mut self,
        task_id: TaskId,
        merged: bool,
        error: Option<String>,
        effects: &mut Vec<Effect>,
    ) {
        let Some(verified_at) = self
            .pending_verifications
            .iter()
            .position(|(id, _)| id == &task_id)
            .map(|position| self.pending_verifications.remove(position).1)
        else {
            // No request is outstanding: a late or duplicate receipt must not
            // decide a merge.
            return;
        };
        let pending_error = self
            .pending_merge_errors
            .iter()
            .position(|(id, _)| id == &task_id)
            .map(|position| self.pending_merge_errors.remove(position).1)
            .flatten();
        let Some(index) = self.task_index(&task_id) else {
            return;
        };
        if !matches!(
            self.tasks[index].status,
            TaskStatus::Merging | TaskStatus::AwaitingMerge
        ) {
            return;
        }

        if merged {
            let (repo, worktree_path) = {
                let task = &self.tasks[index];
                (task.spec.repo_path.clone(), task.worktree_path.clone())
            };
            let task = &mut self.tasks[index];
            task.status = TaskStatus::Succeeded;
            task.finished_at = Some(verified_at.clone());
            task.error = None;
            task.commit_only = false;
            task.interrupted = false;
            let merge = task.merge.get_or_insert_with(TaskMerge::default);
            merge.error = None;
            merge.instructions = None;
            merge.finished_at = Some(verified_at);
            let changed = task.clone();
            if let Some(path) = worktree_path.filter(|path| !path.trim().is_empty()) {
                let effect = self.effect_id();
                effects.push(Effect::RemoveWorktree {
                    effect,
                    task_id,
                    repo_path: repo,
                    path,
                });
            }
            self.push_persist(effects, &changed);
            self.push_history(effects, &changed);
        } else {
            let (repo, branch) = {
                let task = &self.tasks[index];
                (
                    task.spec.repo_path.clone(),
                    task.branch().unwrap_or("").to_string(),
                )
            };
            let message = error
                .or(pending_error)
                .unwrap_or_else(|| BRANCH_NOT_MERGED_ERROR.to_string());
            let task = &mut self.tasks[index];
            task.status = TaskStatus::AwaitingMerge;
            task.finished_at = None;
            task.error = None;
            let merge = task.merge.get_or_insert_with(TaskMerge::default);
            merge.error = Some(message.clone());
            merge.instructions = Some(manual_merge_instructions(&repo, &branch));
            merge.started_at = None;
            merge.finished_at = None;
            let changed = task.clone();
            self.push_persist(effects, &changed);
            effects.push(Effect::EmitNotice {
                level: NoticeLevel::Warning,
                message: format!("任务 {task_id} 合并失败：{message}"),
            });
        }
    }

    fn merge_blocked(
        &mut self,
        task_id: &TaskId,
        repo: &str,
        branch: &str,
        message: String,
        effects: &mut Vec<Effect>,
    ) {
        let Some(index) = self.task_index(task_id) else {
            return;
        };
        if self.tasks[index].status != TaskStatus::AwaitingMerge {
            return;
        }
        let task = &mut self.tasks[index];
        task.finished_at = None;
        let merge = task.merge.get_or_insert_with(TaskMerge::default);
        merge.error = Some(message);
        merge.instructions = Some(manual_merge_instructions(repo, branch));
        merge.started_at = None;
        merge.finished_at = None;
        let changed = task.clone();
        self.push_persist(effects, &changed);
    }

    fn rollback_merge(
        &mut self,
        task_id: TaskId,
        error: String,
        cancel_agent: bool,
        effects: &mut Vec<Effect>,
    ) {
        let Some(index) = self.task_index(&task_id) else {
            return;
        };
        if !matches!(
            self.tasks[index].status,
            TaskStatus::Merging | TaskStatus::AwaitingMerge
        ) {
            return;
        }
        let (repo, branch) = {
            let task = &self.tasks[index];
            (
                task.spec.repo_path.clone(),
                task.branch().unwrap_or("").to_string(),
            )
        };
        if cancel_agent {
            effects.push(Effect::CancelAgent {
                task_id: task_id.clone(),
            });
        }
        let task = &mut self.tasks[index];
        task.status = TaskStatus::AwaitingMerge;
        task.finished_at = None;
        task.error = None;
        let merge = task.merge.get_or_insert_with(TaskMerge::default);
        merge.error = Some(error);
        merge.instructions = Some(manual_merge_instructions(&repo, &branch));
        merge.started_at = None;
        merge.finished_at = None;
        let changed = task.clone();
        self.push_persist(effects, &changed);
    }

    fn repo_is_merging(&self, repo: &str, except: Option<&TaskId>) -> bool {
        self.tasks.iter().any(|task| {
            task.status == TaskStatus::Merging
                && Some(&task.id) != except
                && task.spec.repo_path.trim() == repo
        })
    }

    // -- cancellation / deletion --------------------------------------------

    fn on_cancel(&mut self, task_id: TaskId, now: Timestamp, effects: &mut Vec<Effect>) {
        self.clock = now.clone();
        let Some(task) = self.task(&task_id).cloned() else {
            effects.push(Effect::rejected("任务不存在"));
            return;
        };
        match task.status {
            TaskStatus::AwaitingApproval => self.stop_review(task_id, now, effects),
            TaskStatus::AwaitingMerge => {
                let Some(index) = self.task_index(&task_id) else {
                    return;
                };
                let task = &mut self.tasks[index];
                task.status = TaskStatus::Canceled;
                task.finished_at = Some(now);
                task.exit_code = None;
                task.error = Some(CANCELED_MERGE_ERROR.to_string());
                task.commit_only = false;
                task.interrupted = false;
                let changed = task.clone();
                self.push_persist(effects, &changed);
                self.push_history(effects, &changed);
            }
            TaskStatus::Merging => {
                self.rollback_merge(task_id, MERGE_ABORTED_ERROR.to_string(), true, effects);
            }
            TaskStatus::Queued | TaskStatus::Preparing | TaskStatus::Running => {
                let was_running =
                    matches!(task.status, TaskStatus::Preparing | TaskStatus::Running);
                if was_running {
                    effects.push(Effect::CancelAgent {
                        task_id: task_id.clone(),
                    });
                }
                let Some(index) = self.task_index(&task_id) else {
                    return;
                };
                let task = &mut self.tasks[index];
                task.status = TaskStatus::Canceled;
                task.finished_at = Some(now);
                task.exit_code = None;
                task.error = Some(CANCELED_ERROR.to_string());
                task.commit_only = false;
                task.interrupted = false;
                let changed = task.clone();
                self.push_persist(effects, &changed);
                self.push_history(effects, &changed);
            }
            TaskStatus::Succeeded | TaskStatus::Failed | TaskStatus::Canceled => {
                effects.push(Effect::rejected("任务已经结束，无需取消"));
            }
        }
    }

    fn on_delete_terminal(&mut self, task_id: TaskId, effects: &mut Vec<Effect>) {
        let Some(index) = self.task_index(&task_id) else {
            effects.push(Effect::rejected("任务不存在"));
            return;
        };
        if !self.tasks[index].status.is_terminal() {
            effects.push(Effect::rejected("只能删除已结束的任务"));
            return;
        }
        let task = self.tasks.remove(index);
        if let Some(path) = task
            .worktree_path
            .clone()
            .filter(|path| !path.trim().is_empty())
        {
            let effect = self.effect_id();
            effects.push(Effect::RemoveWorktree {
                effect,
                task_id: task.id,
                repo_path: task.spec.repo_path.clone(),
                path,
            });
        }
        effects.push(Effect::StateChanged);
    }

    fn on_set_config(&mut self, config: WorkflowConfig, effects: &mut Vec<Effect>) {
        if worktree_toggle_locked(
            self.config.worktree_enabled,
            config.worktree_enabled,
            has_live_task(&self.tasks),
        ) {
            effects.push(Effect::rejected(
                "队列中还有未结束的任务，无法切换 Worktree",
            ));
            return;
        }
        self.config = config.clone();
        effects.push(Effect::PersistConfig { config });
        effects.push(Effect::StateChanged);
    }

    // -- host facts ---------------------------------------------------------

    fn on_agent_started(&mut self, task_id: TaskId, effects: &mut Vec<Effect>) {
        let Some(index) = self.task_index(&task_id) else {
            return;
        };
        if self.tasks[index].status != TaskStatus::Preparing {
            return;
        }
        let task = &mut self.tasks[index];
        task.status = TaskStatus::Running;
        let changed = task.clone();
        self.push_persist(effects, &changed);
    }

    fn on_agent_start_failed(&mut self, task_id: TaskId, error: String, effects: &mut Vec<Effect>) {
        let Some(index) = self.task_index(&task_id) else {
            return;
        };
        if self.tasks[index].status != TaskStatus::Preparing {
            return;
        }
        let task = &mut self.tasks[index];
        task.status = TaskStatus::Failed;
        task.finished_at = Some(self.clock.clone());
        task.exit_code = None;
        task.error = Some(error);
        let changed = task.clone();
        self.push_persist(effects, &changed);
        self.push_history(effects, &changed);
    }

    fn on_run_finished(
        &mut self,
        task_id: TaskId,
        outcome: RunOutcome,
        now: Timestamp,
        effects: &mut Vec<Effect>,
    ) {
        self.clock = now.clone();
        let Some(index) = self.task_index(&task_id) else {
            return;
        };
        // Only a run that is actually in flight may be finished. Terminal,
        // review and merge states are never downgraded by a late event.
        if !matches!(
            self.tasks[index].status,
            TaskStatus::Preparing | TaskStatus::Running
        ) {
            return;
        }

        if outcome.canceled {
            let task = &mut self.tasks[index];
            task.status = TaskStatus::Canceled;
            task.finished_at = Some(now);
            task.exit_code = None;
            task.error = Some(CANCELED_ERROR.to_string());
            task.commit_only = false;
            let changed = task.clone();
            self.push_persist(effects, &changed);
            self.push_history(effects, &changed);
            return;
        }

        let is_worktree = self.tasks[index].is_worktree();
        let task = &mut self.tasks[index];
        task.exit_code = outcome.exit_code;
        task.changes = outcome.changes.clone();

        if !outcome.success {
            let message = outcome
                .error
                .clone()
                .unwrap_or_else(|| match outcome.exit_code {
                    Some(code) => format!("Agent 进程退出码 {code}"),
                    None => "Agent 进程异常结束".to_string(),
                });
            task.status = TaskStatus::Failed;
            task.finished_at = Some(now);
            task.error = Some(message);
            let changed = task.clone();
            self.push_persist(effects, &changed);
            self.push_history(effects, &changed);
            return;
        }

        let dirty = task
            .changes
            .as_ref()
            .map(|changes| changes.dirty)
            .unwrap_or(false);
        let committed = task
            .changes
            .as_ref()
            .map(|changes| changes.committed)
            .unwrap_or(false);

        if is_worktree {
            if task.commit_only {
                if dirty {
                    task.status = TaskStatus::Failed;
                    task.finished_at = Some(now);
                    task.error = Some(COMMIT_DIRTY_ERROR.to_string());
                } else {
                    task.status = TaskStatus::AwaitingMerge;
                    task.finished_at = None;
                    task.error = None;
                    task.commit_only = false;
                    let repo = task.spec.repo_path.clone();
                    let branch = task.branch().unwrap_or("").to_string();
                    let merge = task.merge.get_or_insert_with(TaskMerge::default);
                    merge.error = None;
                    merge.instructions = Some(manual_merge_instructions(&repo, &branch));
                    merge.started_at = None;
                    merge.finished_at = None;
                }
            } else if dirty || committed {
                let files = task
                    .changes
                    .as_ref()
                    .map(|changes| changes.files.clone())
                    .unwrap_or_default();
                task.status = TaskStatus::AwaitingApproval;
                task.finished_at = None;
                task.error = None;
                task.commit_only = false;
                task.merge = None;
                task.approval = Some(TaskApproval {
                    summary: approval_summary(&files),
                    files,
                    risk: None,
                    requested_at: now,
                    approved_at: None,
                    stash: None,
                });
            } else {
                task.status = TaskStatus::Succeeded;
                task.finished_at = Some(now);
                task.error = None;
                task.commit_only = false;
            }
        } else if task.commit_only && dirty {
            // Non-worktree commit phase: a dirty tree means the fix was not
            // persisted and TAPD was not written back.
            task.status = TaskStatus::Failed;
            task.finished_at = Some(now);
            task.error = Some(COMMIT_DIRTY_ERROR.to_string());
        } else if dirty && !committed {
            let files = task
                .changes
                .as_ref()
                .map(|changes| changes.files.clone())
                .unwrap_or_default();
            task.status = TaskStatus::AwaitingApproval;
            task.finished_at = None;
            task.error = None;
            task.commit_only = false;
            task.merge = None;
            task.approval = Some(TaskApproval {
                summary: approval_summary(&files),
                files,
                risk: None,
                requested_at: now,
                approved_at: None,
                stash: None,
            });
        } else {
            task.status = TaskStatus::Succeeded;
            task.finished_at = Some(now);
            task.error = None;
            task.commit_only = false;
        }

        let changed = task.clone();
        let terminal = changed.status.is_terminal();
        let worktree = changed
            .worktree_path
            .clone()
            .filter(|path| !path.trim().is_empty());
        if terminal {
            if let Some(path) = worktree {
                let effect = self.effect_id();
                effects.push(Effect::RemoveWorktree {
                    effect,
                    task_id: changed.id.clone(),
                    repo_path: changed.spec.repo_path.clone(),
                    path,
                });
            }
        }
        self.push_persist(effects, &changed);
        if terminal {
            self.push_history(effects, &changed);
        }
    }

    fn on_worktree_created(
        &mut self,
        task_id: TaskId,
        worktree: WorktreeRef,
        effects: &mut Vec<Effect>,
    ) {
        let Some(index) = self.task_index(&task_id) else {
            return;
        };
        if self.tasks[index].status != TaskStatus::Preparing {
            return;
        }
        let task = &mut self.tasks[index];
        task.worktree_path = Some(worktree.path.clone());
        task.worktree_branch = Some(worktree.branch.clone());
        let changed = task.clone();
        self.push_persist(effects, &changed);
        let effect = self.effect_id();
        effects.push(Effect::StartFixAgent {
            effect,
            task_id,
            runtime_id: changed.spec.runtime_id.clone(),
            cwd: worktree.path,
            spec: changed.spec,
        });
    }

    fn on_worktree_create_failed(
        &mut self,
        task_id: TaskId,
        error: String,
        effects: &mut Vec<Effect>,
    ) {
        let Some(index) = self.task_index(&task_id) else {
            return;
        };
        if self.tasks[index].status != TaskStatus::Preparing {
            return;
        }
        let task = &mut self.tasks[index];
        task.status = TaskStatus::Failed;
        task.finished_at = Some(self.clock.clone());
        task.exit_code = None;
        task.error = Some(error);
        let changed = task.clone();
        self.push_persist(effects, &changed);
        self.push_history(effects, &changed);
    }

    fn on_worktree_removed(
        &mut self,
        task_id: TaskId,
        error: Option<String>,
        effects: &mut Vec<Effect>,
    ) {
        let Some(index) = self.task_index(&task_id) else {
            return;
        };
        if error.is_some() {
            return;
        }
        if self.tasks[index].worktree_path.take().is_none() {
            return;
        }
        let changed = self.tasks[index].clone();
        self.push_persist(effects, &changed);
    }

    // -- scheduling ---------------------------------------------------------

    fn schedule(&mut self, effects: &mut Vec<Effect>) {
        if !self.loaded || blocked(&self.config, self.paused, &self.tasks) {
            return;
        }
        let limit = crate::config::effective_units(&self.config);
        let mut changed = Vec::new();
        let mut start_effects = Vec::new();
        loop {
            if active_count(&self.tasks) >= limit {
                break;
            }
            let Some(index) = next_queued_index(&self.tasks) else {
                break;
            };
            let (task_id, spec, repo_path, bug_id, runtime_id, existing_worktree) = {
                let task = &self.tasks[index];
                (
                    task.id.clone(),
                    task.spec.clone(),
                    task.spec.repo_path.clone(),
                    task.spec.bug_id.clone(),
                    task.spec.runtime_id.clone(),
                    task.worktree().map(|worktree| worktree.path),
                )
            };
            let effect_id = self.effect_id();
            let effect = if self.config.worktree_enabled && existing_worktree.is_none() {
                Effect::CreateWorktree {
                    effect: effect_id,
                    task_id: task_id.clone(),
                    repo_path,
                    bug_id,
                }
            } else {
                Effect::StartFixAgent {
                    effect: effect_id,
                    task_id: task_id.clone(),
                    runtime_id,
                    cwd: existing_worktree.unwrap_or(repo_path),
                    spec,
                }
            };
            let started_at = self.clock.clone();
            let task = &mut self.tasks[index];
            task.status = TaskStatus::Preparing;
            task.started_at = Some(started_at);
            task.finished_at = None;
            task.exit_code = None;
            task.error = None;
            changed.push(task.clone());
            start_effects.push(effect);
        }
        if !changed.is_empty() {
            effects.push(Effect::PersistChanged { tasks: changed });
            effects.extend(start_effects);
        }
    }

    // -- helpers ------------------------------------------------------------

    fn task_index(&self, id: &TaskId) -> Option<usize> {
        self.tasks.iter().position(|task| &task.id == id)
    }

    fn effect_id(&mut self) -> EffectId {
        let id = self.next_effect_id;
        self.next_effect_id = self.next_effect_id.wrapping_add(1);
        EffectId(id)
    }

    fn push_persist(&self, effects: &mut Vec<Effect>, task: &Task) {
        effects.push(Effect::PersistChanged {
            tasks: vec![task.clone()],
        });
    }

    fn push_history(&self, effects: &mut Vec<Effect>, task: &Task) {
        if let Some(record) = HistoryRecord::from_task(task) {
            effects.push(Effect::AppendHistory { record });
        }
    }
}

fn approval_summary(files: &[String]) -> String {
    if files.is_empty() {
        "Agent 完成修改，等待审核".to_string()
    } else {
        format!("Agent 完成修改，涉及 {} 个文件，等待审核", files.len())
    }
}

/// Destructures the tuple only to satisfy the borrow checker in
/// `on_merge_preconditions_checked`; returns `None` for a missing branch.
fn repo_and_branch(
    repo: String,
    branch: String,
    spec: TaskSpec,
) -> Option<(String, String, TaskSpec)> {
    if branch.trim().is_empty() {
        return None;
    }
    Some((repo, branch, spec))
}

pub fn status_key(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Queued => "queued",
        TaskStatus::Preparing => "preparing",
        TaskStatus::Running => "running",
        TaskStatus::AwaitingApproval => "awaiting_approval",
        TaskStatus::AwaitingMerge => "awaiting_merge",
        TaskStatus::Merging => "merging",
        TaskStatus::Succeeded => "succeeded",
        TaskStatus::Failed => "failed",
        TaskStatus::Canceled => "canceled",
    }
}
