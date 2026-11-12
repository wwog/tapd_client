# Agent Workflow Core（`tapd-workflow`）

> 状态：crate 已落地并被桌面宿主完整接管。`AgentCore` 只保留 `workflow: Mutex<Workflow>` 作为任务状态 / 队列 / 审核 / 合并 / 恢复的唯一 owner；`AgentTask` 只是 UI 与持久化视图。宿主执行 crate 产出的 `Effect`（worktree / PTY / 导出 / git / 缓存 / UI），再以 `Input` 回执事实；需要同步结果的 git 检查（approve 的 `InspectWorkspace`、`merge_start` 的 `CheckMergePreconditions`、`verify_merge` 的 `VerifyBranchMerged`）在命令路径当场执行。宿主侧重复的状态机已删除。本文以代码为准，不再保留设计稿中与实现不一致的类型。

目标：把「Agent 修复任务的状态机 + 执行单元循环 + 审核 / 合并策略 + 恢复规则」抽成独立 crate，平台能力（git worktree、PTY、HTTP、SQLite、时钟、UUID）全部留在宿主。核心 sans-IO、可确定性测试。

## 1. 边界

### 放进 `tapd-workflow`

- 任务状态机：`Queued / Preparing / Running / AwaitingApproval / AwaitingMerge / Merging / Succeeded / Failed / Canceled`。
- 执行单元调度：worktree 开关、并发数、暂停、审核阻塞规则。
- 审核 / 合并决策：什么任务进审核、approve 后 commit-only 还是待合并、合并成功判定。
- 恢复规则：启动时哪些任务保留、哪些重新排队、哪些回到待合并；关闭时如何停靠。
- 历史记录的数据结构与「何时写一条终态历史」。
- 纯函数：合并手动步骤文本、合并提示词、状态标签、计数、配置锁。

### 不放进 `tapd-workflow`

- `git worktree add/remove`、`git merge`、`git status`。
- PTY / 进程启动、输出流、hook、idle 判定。
- Tauri、tokio、reqwest、rusqlite、chrono、uuid。
- TAPD 导出、下载资源、MCP 注入。
- 登录 / 引导 / 窗口 / 胶囊通知。
- 模板渲染、同事技能注入、运行时 catalog。

核心只接受「事实输入」，返回「待执行效果」。事实由宿主采集，效果由宿主执行。

## 2. 依赖与约束

- 正常依赖只有 `serde`；`serde_json` 仅作为 dev-dependency 用于兼容性测试。没有 tauri / tokio / git / reqwest / chrono / uuid。
- `src/lib.rs` 顶部 `#![forbid(unsafe_code)]`。
- 核心不出现 `Path` / `PathBuf`，路径用 `String`；宿主负责平台路径。
- 核心不读时钟、不生成 ID、不读环境、不猜目录。
- 核心不 panic 于业务输入；非法迁移返回 `Effect::Rejected`。
- 当前共 **92 个测试**（`tests/scheduler.rs` 11、`tests/review_merge.rs` 26、`tests/recovery.rs` 25、`tests/host_protocol.rs` 13、`tests/config_lock.rs` 9、`tests/compat.rs` 8）。

## 3. crate 结构

```text
crates/tapd-workflow/
├── Cargo.toml          # serde；dev-dependency 仅 serde_json
├── src/
│   ├── lib.rs          # forbid(unsafe_code)、模块与再导出、SCHEMA_VERSION = 1
│   ├── config.rs       WorkflowConfig / RecoveryPolicy / effective_units
│   ├── task.rs         Timestamp / TaskId / TaskSpec / Task / TaskStatus /
│   │                   ChangeSet / WorktreeRef / TaskApproval / TaskMerge / Snapshot
│   ├── input.rs        Input / RunOutcome / MergeBlock
│   ├── effect.rs       Effect / EffectId / NoticeLevel / RecoveryReport
│   ├── workflow.rs     Workflow::apply(Input) -> Vec<Effect>
│   ├── scheduler.rs    TaskCounts / active_count / next_queued_index / can_start_more
│   ├── policy.rs       合并提示词、手动步骤、审核阻塞、Worktree 开关锁
│   ├── recovery.rs     recover / suspend / RecoveryOutcome
│   └── history.rs      HistoryRecord / TerminalStatus
└── tests/
    ├── scheduler.rs
    ├── review_merge.rs
    ├── recovery.rs
    ├── host_protocol.rs
    ├── config_lock.rs
    └── compat.rs
```

## 4. 核心类型（以代码为准）

```rust
/// 宿主提供的不透明时间字符串，通常为 RFC 3339。核心不解析也不读时钟。
pub type Timestamp = String;

/// 宿主生成的任务 ID。transparent newtype，旧 JSON 里的普通字符串可继续读取。
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TaskId(pub String);

/// 启动一次修复所需的事实。camelCase；通过 `#[serde(flatten)]` 平铺进 `Task`，
/// 因此任务 JSON 仍然是历史 `AgentTask` 的扁平结构。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskSpec {
    pub workspace_id: String,
    pub workspace_name: String,
    pub bug_id: String,
    pub title: String,
    pub severity: String,
    pub priority: String,
    pub repo_path: String,
    pub runtime_id: String,
    /// 任务来源，`manual`（缺陷详情 / 列表手动发起）或 `notification`
    /// （通知卡「处理」）。宿主写入并在历史页展示与恢复。
    pub source: String,
    pub extra_prompt: String,
    pub attachments: Vec<String>,
}
```

`Task` 的字段：

```rust
pub struct Task {
    pub id: TaskId,
    #[serde(flatten)]
    pub spec: TaskSpec,          // 平铺进任务 JSON
    pub status: TaskStatus,
    pub attempt: u32,            // 已被中断消耗的自动重试次数
    pub created_at: Timestamp,
    pub started_at: Option<Timestamp>,
    pub finished_at: Option<Timestamp>,
    pub json_path: String,       // 导出的 bug.json
    pub worktree_path: Option<String>, // 扁平字段，兼容旧 JSON
    pub worktree_branch: Option<String>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    pub prompt: String,
    pub source: String,
    pub agent_session_id: Option<String>,
    pub approval: Option<TaskApproval>,
    pub merge: Option<TaskMerge>,
    pub commit_only: bool,
    pub baseline_dirty: Vec<String>,
    pub baseline_head: Option<String>,
    pub changes: Option<ChangeSet>,
    pub interrupted: bool,
}
```

- worktree 没有单独的 `worktree: Option<WorktreeRef>` 字段；`Task::worktree()` 把两个扁平字段读成一个 `WorktreeRef`，`is_worktree()` / `work_dir()` / `branch()` 都基于它们。
- `TaskApproval` 除摘要、文件、风险与时间外，还带 `stash: Option<String>`（宿主停止审核时记录储藏）。
- `TaskMerge` 带 `error` / `instructions` / `started_at` / `finished_at`。
- `ChangeSet { files, dirty, committed }`：`dirty` 表示工作区仍有未提交文件，`committed` 表示 baseline 之后产生过 commit。
- `Snapshot { schema_version, config, paused, tasks, generation }`，`schema_version` 当前为 1；旧快照缺字段按默认值读取。

`TaskStatus` 为 snake_case 序列化（`queued`、`awaiting_approval`、`awaiting_merge` 等），并提供：

- `is_active()`：`Preparing | Running | Merging`。
- `is_terminal()`：`Succeeded | Failed | Canceled`。

## 5. 输入 / 效果协议

### Input

```rust
pub enum Input {
    // 宿主生命周期
    SystemEntered { now: Timestamp },
    SnapshotLoaded { snapshot: Snapshot },
    Suspend { now: Timestamp },
    AcknowledgeRecovery { report_id: u64 },

    // 用户 / UI
    Enqueue { task_id: TaskId, spec: TaskSpec, now: Timestamp },
    Retry { task_id: TaskId, new_id: TaskId, now: Timestamp },
    ApproveReview { task_id: TaskId, now: Timestamp },
    StopReview { task_id: TaskId, now: Timestamp, stash: Option<String>, error: Option<String> },
    StartMerge { task_id: TaskId, now: Timestamp },
    VerifyMerge { task_id: TaskId, now: Timestamp },
    Cancel { task_id: TaskId, now: Timestamp },
    DeleteTerminal { task_id: TaskId },
    ResumeQueue { now: Timestamp },
    SetConfig { config: WorkflowConfig },

    // 宿主事实回执
    TaskPrepared {
        task_id: TaskId,
        prompt: String,
        json_path: String,
        baseline_dirty: Vec<String>,
        baseline_head: Option<String>,
    },
    SessionObserved { task_id: TaskId, session_id: String },
    AgentStarted { task_id: TaskId },
    AgentStartFailed { task_id: TaskId, error: String },
    RunFinished { task_id: TaskId, outcome: RunOutcome, now: Timestamp },
    WorktreeCreated { task_id: TaskId, worktree: WorktreeRef },
    WorktreeCreateFailed { task_id: TaskId, error: String },
    WorktreeRemoved { task_id: TaskId, error: Option<String> },
    WorkspaceInspected { task_id: TaskId, changes: ChangeSet },
    MergePreconditionsChecked { task_id: TaskId, result: Result<(), MergeBlock> },
    MergeAgentFinished { task_id: TaskId, outcome: RunOutcome, now: Timestamp },
    BranchMergeVerified { task_id: TaskId, merged: bool, error: Option<String> },
}

pub struct RunOutcome {
    pub canceled: bool,
    pub success: bool,
    pub error: Option<String>,
    pub changes: Option<ChangeSet>,
    pub exit_code: Option<i32>,   // 修复轮的真实退出码
}
```

`RunOutcome` 比设计稿多出 `exit_code`：修复轮写入任务的 `exit_code` 并进入历史；合并轮的退出码不覆盖修复轮，合并是否成功仍以分支校验为准。

`MergeBlock`：

```rust
pub enum MergeBlock {
    DirtyRepository { files: usize },
    RuntimeUnavailable { error: String },
    RepositoryBusy,
    WorktreeMissing,
}
```

### Effect

```rust
pub enum Effect {
    // 协议
    Rejected { message: String },
    LoadSnapshot,
    PersistChanged { tasks: Vec<Task> },
    PersistDeleted { task_id: TaskId },
    PersistPaused { paused: bool },
    PersistConfig { config: WorkflowConfig },
    AppendHistory { record: HistoryRecord },
    EmitRecoveryReport { report: RecoveryReport },
    EmitNotice { level: NoticeLevel, message: String },
    StateChanged,

    // worktree / workspace
    CreateWorktree { effect: EffectId, task_id: TaskId, repo_path: String, bug_id: String },
    InspectWorkspace { effect: EffectId, task_id: TaskId, path: String },
    RemoveWorktree { effect: EffectId, task_id: TaskId, repo_path: String, path: String },

    // 修复 Agent
    StartFixAgent {
        effect: EffectId,
        task_id: TaskId,
        runtime_id: String,
        cwd: String,
        spec: TaskSpec,
    },
    CancelAgent { task_id: TaskId },

    // 合并
    CheckMergePreconditions { effect: EffectId, task_id: TaskId, repo_path: String, branch: String },
    StartMergeAgent {
        effect: EffectId,
        task_id: TaskId,
        repo_path: String,
        branch: String,
        spec: TaskSpec,
    },
    VerifyBranchMerged { effect: EffectId, task_id: TaskId, repo_path: String, branch: String },
}
```

- `EffectId` 由核心递增分配，宿主必须在异步回执里带回同一个语义请求（回执本身通过 `Input` 的 `task_id` 关联）。
- `PersistChanged` 只带变化的任务，宿主按 `id` upsert，复杂度 O(changed)。
- `PersistDeleted` 表示记录已删除，宿主删除对应行；`PersistPaused` 表示队列暂停标记变化（关闭时也会显式发一次）。
- `StateChanged` 是轻量「快照变了」信号；删除任务、暂停 / 继续队列等不逐条持久化的场景使用。
- `Workflow::apply` 在产生 `PersistChanged` / `PersistDeleted` / `PersistPaused` / `PersistConfig` / `StateChanged` 时递增 `generation`。
- 核心不执行效果，只在 `apply` 里迁移状态并产出效果；效果顺序即状态机期望的顺序。

## 6. 状态机

```text
SystemEntered → LoadSnapshot → SnapshotLoaded → 恢复
Queued → Preparing → Running

Running(worktree, 有改动) → AwaitingApproval
Running(worktree, 无改动) → Succeeded
Running(worktree, commit_only 且 dirty) → Failed
Running(worktree, commit_only 且干净) → AwaitingMerge
Running(非 worktree, committed) → Succeeded
Running(非 worktree, dirty && !committed) → AwaitingApproval
Running(非 worktree, commit_only 且 dirty) → Failed

AwaitingApproval --ApproveReview(worktree 干净)--> AwaitingMerge
AwaitingApproval --ApproveReview(仍有 dirty / 非 worktree)--> Queued + commit_only
AwaitingApproval --StopReview / Cancel--> Canceled
AwaitingApproval --ApproveReview(changes 缺失)--> 发 InspectWorkspace，状态保持

AwaitingMerge --StartMerge--> CheckMergePreconditions
  Ok  → Merging + StartMergeAgent
  失败 → 保持 AwaitingMerge + merge.error / 手动步骤
Merging --MergeAgentFinished--> VerifyBranchMerged
BranchMergeVerified{merged:true}  → Succeeded
BranchMergeVerified{merged:false} → AwaitingMerge + error
AwaitingMerge --VerifyMerge--> VerifyBranchMerged（手动合并校验）
AwaitingMerge --Cancel--> Canceled
Merging --Cancel--> AwaitingMerge（中止合并，保留分支 / 目录）
```

不可回退：

- 终态不被迟到事件改写；`RunFinished` 只接受 `Preparing | Running`。
- `AwaitingApproval / AwaitingMerge / Merging` 不被 `RunFinished` 直接降级。
- 合并完成只由一次已登记的 `BranchMergeVerified { merged: true }` 触发；没有待校验请求的迟到回执会被忽略。
- 同一缺陷只允许一个非终态任务。

## 7. 调度规则

```rust
pub fn effective_units(config: &WorkflowConfig) -> usize {
    if config.worktree_enabled {
        config.execution_units.clamp(1, 8) as usize
    } else {
        1
    }
}

// 非 worktree 的待审核阻塞单队列；worktree 模式只受显式暂停影响。
fn blocked(config, paused, tasks) -> bool {
    paused || (!config.worktree_enabled
        && tasks.iter().any(|t| t.status == TaskStatus::AwaitingApproval))
}
```

- 每次 `apply` 末尾调用 `schedule()`；只有 `loaded == true` 时才调度。
- 按 FIFO 取 `Queued`，直到 `active`（`Preparing + Running + Merging`）达到 `effective_units`。
- 每个被取中的任务：`Queued → Preparing`，记录 `started_at`；worktree 开启且没有现成 worktree 时发 `CreateWorktree`，否则发 `StartFixAgent`。
- `Preparing` 占一个执行单元；`AgentStarted → Running`，`AgentStartFailed → Failed`。
- `AwaitingApproval` / `AwaitingMerge` 不占执行单元；在 worktree 模式下不阻塞新任务，非 worktree 模式下 `AwaitingApproval` 阻塞单队列。
- 用户停止审核会把 `paused` 置为 true；`ApproveReview` 会显式清除暂停，`ResumeQueue` 恢复队列。
- 恢复时 `restore_queued = false` 也会把 `paused` 置为 true；`Queued` 任务保留在原位，不自动出队。

## 8. 审核与合并策略

### 运行结束

`RunFinished { outcome }`：

- `outcome.changes` 由宿主 git 适配层计算（`dirty` / `committed` / `files`）。
- Worktree 任务：
  - `commit_only && dirty` → `Failed`（`提交阶段仍有未提交改动`）。
  - `commit_only && 干净` → `AwaitingMerge`，写手动步骤。
  - `dirty || committed` → `AwaitingApproval`，`approval.files` 来自改动文件。
  - 无改动 → `Succeeded`。
- 非 Worktree 任务：
  - `commit_only && dirty` → `Failed`。
  - `dirty && !committed` → `AwaitingApproval`。
  - 其余 → `Succeeded`。
- 终态迁移会同时发 `RemoveWorktree`（有目录时）、`PersistChanged` 与一次 `AppendHistory`。

### ApproveReview

- Worktree 且 `changes.dirty == false` → `AwaitingMerge`，写手动步骤。
- 其余 → `Queued + commit_only=true`，由调度继续跑提交轮。
- `changes` 缺失（旧记录恢复）→ 先发 `InspectWorkspace`，宿主返回 `WorkspaceInspected` 后再决定。
- 重复 approve 被 `Rejected`；停止审核会 `paused = true`。

### StartMerge / VerifyMerge

1. `StartMerge` 发 `CheckMergePreconditions`；同仓库已有 `Merging` 任务时直接 `Rejected`。
2. `Ok` → `Merging`，`merge.started_at` 记录请求时间，发 `StartMergeAgent`。
3. `Err(MergeBlock)` → 保持 `AwaitingMerge`，写 `merge.error` + 手动步骤，并 `EmitNotice`；不判失败。
4. `MergeAgentFinished` → 发 `VerifyBranchMerged`；合并 Agent 的 `exit_code` 不写入任务。
5. `BranchMergeVerified { merged: true }` → `Succeeded`，删除 worktree 目录、保留分支，写持久化与历史。
6. `merged: false` → `AwaitingMerge` + error + 手动步骤。
7. `VerifyMerge` 走同一个校验，用于「我已手动合并」。
8. `Cancel`：`AwaitingMerge → Canceled`；`Merging → AwaitingMerge`（中止合并，保留分支 / 目录）。

### Worktree 开关锁

`SetConfig`：

- `worktree_enabled` 变化且存在任何非终态任务 → `Rejected("队列中还有未结束的任务，无法切换 Worktree")`。
- `execution_units` 永远可改；worktree 关闭时有效值仍为 1。
- `Workflow::worktree_toggle_locked(next)` / `policy::worktree_toggle_locked` 是同一份纯规则，宿主与 UI 可直接复用。

## 9. 进入系统、关闭与恢复

### 进入系统

```text
Input::SystemEntered { now }
  → Effect::LoadSnapshot
宿主读取 SQLite → Input::SnapshotLoaded { snapshot }
  → recover() 改写任务、发 PersistChanged / AppendHistory / EmitRecoveryReport
```

- `SystemEntered` 幂等：已经进入时再次调用不会重复加载。
- 这是 crate 的完整生命周期路径，桌面宿主已经完整接入（见 §12）。
- `SnapshotLoaded` 在未进入系统时返回 `Rejected("system not entered")`；已加载后再次收到会被忽略。
- `Suspend` 会把 `entered` / `loaded` 置回 false，下一次 `SystemEntered` 会重新加载持久化快照。

### 恢复规则（`recovery::recover`）

| 持久化状态 | 启动后 |
|---|---|
| `Queued` | 保留，计数 `queued`，按 FIFO 继续 |
| `Preparing` / `Running` | `attempt += 1`、`interrupted = true`、清空 `started_at/finished_at/exit_code/error`；默认重新入队（计数 `retried`） |
| `AwaitingApproval` | 保留，计数 `awaiting_approval` |
| `AwaitingMerge` | 保留，计数 `awaiting_merge` |
| `Merging` | → `AwaitingMerge`，`merge.error = "客户端重启，合并已中止"`，写手动步骤，计数 `awaiting_merge` |
| `Succeeded / Failed / Canceled` | 不参与恢复 |

- `RecoveryPolicy { auto_retry_interrupted: bool, max_auto_retry: u32, restore_queued: bool }`，默认 `true` / `3` / `true`。
- `restore_queued = false` 时 `Queued` 仍然保留，不丢弃任务；队列在恢复后保持暂停（`RecoveryReport.queue_paused = true`），等用户手动「继续队列」。宿主把这个配置项暴露为「启动恢复排队」。
- 只有 `next_attempt <= max_auto_retry` 才重新入队；超过上限 → `Failed`，错误为 `客户端重启，自动重试次数已用尽`。`auto_retry_interrupted = false` 时直接用 `客户端重启，已停止自动重试` 失败。默认配置下最多 3 次自动重试。
- 恢复只会改写 `Preparing / Running / Merging`；`RecoveryOutcome.changed` 给出被改写的索引，`failed` 给出恢复阶段失败的索引。

```rust
pub struct RecoveryReport {
    pub id: u64,
    pub restored_at: Timestamp,
    pub queued: usize,
    pub retried: usize,
    pub awaiting_approval: usize,
    pub awaiting_merge: usize,
    pub failed: usize,
}
```

### 关闭（`recovery::suspend` / `Input::Suspend`）

- `Preparing / Running` → `Queued`，`interrupted = true`，清空运行时间与退出码；`attempt` 不在这里消耗，留到下次 `recover` 再 +1。
- `Merging` → `AwaitingMerge`，`merge.error = "客户端重启，合并已中止"`，写手动步骤。
- `Queued / AwaitingApproval / AwaitingMerge` 原样保留。
- 返回被改写的索引并发出 `PersistChanged`；宿主必须在杀进程之前把这份状态同步写入 SQLite。
- 运行中的任务不再默认 `Failed`；失败只来自真实执行失败、worktree / 启动失败或恢复重试超限。

## 10. 持久化与历史

核心只定义数据与时机，宿主实现读写。

```rust
pub struct HistoryRecord {
    pub task_id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub bug_id: String,
    pub title: String,
    pub status: TerminalStatus, // Succeeded | Failed | Canceled
    pub started_at: Option<Timestamp>,
    pub finished_at: Timestamp,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    pub worktree_branch: Option<String>,
    pub merge: Option<TaskMerge>,
}
```

- `PersistChanged { tasks }` 只带变化任务，宿主按 `id` upsert。
- 终态迁移发一次 `AppendHistory`；`HistoryRecord::key()` 返回 `(task_id, finished_at)`，宿主可用它做幂等写入。桌面宿主把历史 upsert 到已有的 `agent_tasks` 表（`payload` 存完整任务 JSON），不额外建历史表。
- 配置变更发 `PersistConfig`。
- 宿主继续使用 SQLite `agent_tasks` 表存任务（`payload` 存 `Task` JSON），`agent_queue_state` 存队列暂停标记；`PersistChanged` / `PersistDeleted` / `PersistPaused` 都写这两张现有表。
- 写入失败会设置 `storage_error` 并在 Agent 页展示存储错误横幅，不会静默吞掉；任务状态仍在内存中，下一次写入重试。
- 不做旧格式主动迁移；可选字段使用 `serde(default)`，缺字段按 `None/0/空` 读取（`id`、`status` 仍是必需字段）。

## 11. 与早期设计稿的差异

以下是实际实现与旧版设计文档不一致的地方，文档与代码统一以本节为准：

1. **`Timestamp = String`**：时间是不透明字符串（通常 RFC 3339），由宿主传入；不是整数毫秒时间戳，核心也不解析时间。
2. **`TaskId` 是 transparent newtype**：`pub struct TaskId(pub String)` + `#[serde(transparent)]`，旧 JSON 的裸字符串可继续反序列化；提供 `new` / `as_str` / `Display` / `From<&str>` / `From<String>`。
3. **`TaskSpec` 通过 `#[serde(flatten)]` 平铺进 `Task`**：任务 JSON 仍是扁平 camelCase，没有嵌套 `spec` 对象。
4. **`RunOutcome` 带 `exit_code`**：修复轮退出码写入任务与历史；合并轮退出码不覆盖修复轮。
5. **worktree 存成扁平字段**：`Task.worktree_path` / `worktree_branch`，通过 `Task::worktree()` 组合成 `WorktreeRef`；没有 `Task.worktree: Option<WorktreeRef>`。
6. **审核 / 合并类型改名**：`TaskApproval`（含 `stash`）与 `TaskMerge`，不再是 `Approval` / `MergeState`。
7. **`Task` 字段调整**：使用 `created_at` 而不是 `queued_at`；另有 `json_path`、`prompt`、`source`、`agent_session_id`、`baseline_dirty`、`baseline_head`、`exit_code`。没有独立 `queued_at`。
8. **`Input` / `Effect` 以 `src/input.rs`、`src/effect.rs` 为准**：`Effect` 包含 `EmitNotice` / `StateChanged`，`Input` 包含 `AcknowledgeRecovery` / `AgentStartFailed` / `WorkspaceInspected` 等；没有代码中不存在的变体。
9. **没有 `testing.rs` / `TestWorld`**：测试直接用 `Workflow::apply` 与公开类型，集成测试位于 `tests/`。
10. **`TaskSpec.source` 是宿主元数据**：`manual` / `notification`，随任务 JSON 持久化；桌面历史页读它恢复「来源」。`Retry` 复制原任务 spec，因此重试任务保留来源。
11. **`StopReview` 带宿主事实**：`stash: Option<String>` 与 `error: Option<String>` 由宿主在 `git stash` 之后回执，核心只负责迁移到终态并记录。

## 12. 宿主接入（Tauri 桌面，已完成）

桌面宿主已经完整接入 crate：`Workflow::apply` 是任务状态的唯一入口，宿主不再维护自己的队列 / 审核 / 合并状态机。

### 12.1 所有权

`AgentCore` 只持有：

```rust
workflow: Mutex<Workflow>  // 任务状态 / 队列 / 审核 / 合并 / 恢复的唯一 owner
```

- `AgentTask` 只是 UI 与持久化视图：由 `workflow_bridge::from_workflow_task` 从 crate 任务转换，命令返回和 `agent://state` 推送都读它；宿主不再保存一份可变的 `Vec<AgentTask>` 任务集合。
- `agent/workflow_bridge.rs` 只做 `serde_json` 整条往返（camelCase、扁平 spec、transparent id、字符串时间戳），不手写字段映射；`AgentTask` 仍是唯一持久化格式。
- 所有任务迁移都经过 `AgentCore::apply_input(Input)`；`apply` 返回的 `Effect` 由 `dispatch_effect` 执行。
- 宿主执行平台副作用：导出 `bug.json`、创建 / 删除 worktree、启动 / 终止 PTY、`git status` / `git diff` / 分支祖先检查、SQLite 写入、UI 事件。
- 每个副作用完成后以 `Input` 回执（`WorktreeCreated`、`WorkspaceInspected`、`AgentStarted`、`RunFinished`、`MergePreconditionsChecked`、`BranchMergeVerified` 等）；迟到回执由核心按状态忽略。
- 命令路径对需要同步结果的 git 检查当场执行，保证命令返回最终视图：
  - `agent_review_approve`：把 `InspectWorkspace` 从 effect 列表取出，同步检查后回执 `WorkspaceInspected`。
  - `agent_merge_start`：同步执行 `CheckMergePreconditions`，回执 `MergePreconditionsChecked`，再返回 `agent` / `manual`。
  - `agent_merge_verify`：同步执行 `VerifyBranchMerged`，回执 `BranchMergeVerified` 后才返回成功或错误。
- 命令路径之外的后台 effect（工作区检查、worktree、合并 Agent 等）通过 `dispatch_effect` 异步执行并 `feed` 回执。

### 12.2 启动加载

- `AgentCore::load()` 只加载宿主配置、同步工作流配置、读取安装检测缓存并清理旧日志；**不在登录页加载任务，也不启动队列**。
- 任务在 `agent_enter_system` 时从 SQLite 读取：`SystemEntered → LoadSnapshot → cache.load_agent_tasks → SnapshotLoaded`，由核心运行恢复规则。
- 未进入系统时所有队列命令返回「工作流尚未初始化，请先进入系统」（核心的 `Rejected("system not entered")` 由 `apply_input` 转成该文案）。
- 恢复报告通过命令返回并 emit `agent://recovery`；主界面 header 下方的 `RecoveryBanner` 展示已重新排队 / 待审核 / 待合并 / 失败数量。

### 12.3 进入系统（`agent_enter_system`）

前端在「登录有效 + 引导完成」后才调用；重复调用幂等。

- `Queued` 保留；`RecoveryPolicy.restore_queued = false`（设置里的「启动恢复排队」关闭）时仍保留任务，但队列恢复为暂停，等待用户手动继续。
- `Preparing / Running` → `Queued` + `interrupted` + `attempt + 1`，默认最多自动重试 3 次，超限 → `Failed`。
- `Merging` → `AwaitingMerge` + 「客户端重启，合并已中止」+ 手动步骤。
- `AwaitingApproval / AwaitingMerge` 保留。
- 恢复改写由 `PersistChanged` 持久化；`restore_queued=false` 导致队列暂停时，宿主在收到 `RecoveryReport.queue_paused` 后额外写一次暂停标记（核心只在 `Suspend` / `ResumeQueue` 等显式变化时发 `PersistPaused`）。
- 读取 SQLite 失败或任务 JSON 无法解析时不伪造空队列：设置 `storage_error`、`Suspend` 复位并返回错误，允许下次登录重试。

### 12.4 关闭（`shutdown`）

- 未进入系统时直接返回，不写 suspend 快照，避免覆盖持久化的暂停标记。
- 已进入系统时应用 `Input::Suspend`：`Preparing / Running → Queued`（`interrupted = true`），`Merging → AwaitingMerge`（写「客户端重启，合并已中止」与手动步骤）。
- `Suspend` 产生的 `PersistChanged` / `PersistPaused` 在关闭路径**内联**执行并同步写 SQLite，全部持久化完成后才逐个 `teardown_task` 杀 PTY。
- 运行中的任务不再默认 `Failed`；失败只来自真实执行失败、worktree / 启动失败或恢复重试超限。
- 迟到的 `RunFinished` 因为任务状态已经是 `Queued` / `AwaitingMerge`（不再是 `Preparing` / `Running`）被核心忽略，不会把已停靠的任务覆盖成 `Failed` / `Succeeded`。

### 12.5 已删除的宿主重复状态机

以下字段与函数已从 `AgentCore` 删除，状态改由 crate 拥有：

`tasks`、`spawn_worker`、`take_next_queued`、`finish_task`、`apply_finish`、`recover_incomplete`、`persist_tasks`、`update_task`、`entered` / `shutting_down` 标志、`wake`、`claim_entry` / `release_entry` / `ensure_entered` 门禁。

### 12.6 `AgentCore` 仍保留的宿主职责

- 宿主配置（`agent.json`：运行时、提示词、Worktree / 执行单元、启动恢复排队、同事）。
- PTY runtimes（`runtimes`）、终端尺寸（`sizes`）、会话 hook token / 事件、运行时状态。
- 本机安装检测（`scan` / `scan_lock`）、存储错误（`storage_error`）。
- `worktree_lock` 与 `persist_lock`：分别串行化 git worktree 操作和 SQLite 写入。

### 12.7 纯策略复用

宿主复用 crate 的以下纯逻辑，避免核心与宿主各写一份：

- `tapd_workflow::worktree_toggle_locked`：Worktree 开关锁。
- `tapd_workflow::merge_prompt`：合并 Agent 提示词。
- `tapd_workflow::manual_merge_instructions`：合并失败 / 手动合并步骤。
- `tapd_workflow::ChangeSet`：`AgentTask.changes` 的类型。

`worktree_enabled` / `execution_units` / `restore_queued_tasks` 仍由桌面 `AgentConfig` 持有，通过 `workflow_bridge::workflow_config` 转成 `WorkflowConfig`，其余恢复策略使用 crate 默认值。

## 13. 迁移状态

迁移已完成，宿主侧没有第二份审核 / 合并实现：

- 队列出队、执行单元、审核阻塞、审核 / 合并决策、恢复与关闭全部由 `Workflow::apply` 决定。
- 宿主只保留平台适配器：导出、worktree、PTY、git 检查、SQLite、Tauri 事件与窗口。
- 新增或修改规则时只需要改 crate 与对应测试；宿主不复制状态迁移。

## 14. 测试矩阵（当前 92 个）

- **调度（11）**：worktree 开 2 单元并行、关时串行；FIFO；待审核阻塞规则；暂停；重复缺陷拒绝；执行单元 clamp 与计数。
- **审核 / 合并（26）**：worktree 简单 / 复杂都进审核；commit-only 成功 / 脏失败；非 worktree 语义；approve 前补一次 workspace 检查；重复 approve 拒绝；停止审核暂停队列；迟到 `RunFinished` 不改终态；合并 Agent 成功 / 失败 / 取消；手动校验；主仓脏、运行时不可用、同仓库串行；取消待合并 / 合并中；历史只写一次。
- **恢复（25）**：Queued 保留、Preparing/Running 重排队并带 attempt/interrupted、Merging 回待合并、审核 / 合并保留、重试上限、关闭自动重试、`restore_queued=false` 保留队列但暂停、报告 id / 时间、suspend 纯函数、重启后重新加载快照、迟到最后事件不改恢复结果。
- **宿主协议（13）**：`TaskPrepared` / `SessionObserved` 只作用于 Preparing/Running、终态与未知任务被忽略；停止审核记录 stash / error 并暂停队列；取消走同一条终态路径且只写一次历史；删除发 `PersistDeleted`；继续 / 关闭队列发 `PersistPaused`；`active_task_id` 优先级与历史排序。
- **配置锁（9）**：有 live task 时拒绝切换 worktree；执行单元可改；无 live task 时允许；相同值不算切换；快照暴露锁；提示词包含仓库与分支。
- **兼容（8）**：旧任务 JSON 缺新字段可读、新任务序列化为扁平 camelCase、`TaskSpec.source` 保留、旧快照缺 `generation` 可读、状态 snake_case、approval / merge 缺字段默认、配置默认值与桌面设置一致。
