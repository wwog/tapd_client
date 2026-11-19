# 内置 Agent 任务流（2026-11-18 决策版）

本文是 dsh 内置 Agent 任务流的实现契约。它取代 `docs/DSH.md` §9 中与非 Worktree 流程、
自动收尾、推送远端相关的描述；其余章节（桥、权限、审批、团队）仍然有效。

## 0. 一句话

**执行阶段模型只碰代码，不知道 TAPD 的存在；AI 主动提交审核；人审核通过后宿主完成
提交/合并/清理，再让模型在收尾阶段通过条件工具写 TAPD。所有工作流任务都在独立 worktree 中运行。**

## 1. 决策（2026-11-18）

1. **所有 bug / local 工作流任务都在独立 worktree 中运行**。删除非 Worktree 工作流分支。
2. **不 push 远端**。审核通过 = 提交 → 合并主仓库 → 删除 worktree，并把会话 cwd 立即交回
   主仓库；之后继续此会话进入「直接轮次」（不建 worktree、没有合并步骤，提交直接落在
   主仓库）。后续推送由用户用自由会话或未来的 git 功能完成。
3. **所有有改动的任务都必须人工审核**。删除“极简单流程自动收尾”，不做自动通过。
4. **执行阶段模型看不到任何 TAPD 工具**（连工具名都不出现在 schema/提示词里）。
   审核通过、进入收尾阶段后才通过条件工具出现，并由系统提示词说明怎么做。
5. **自由会话默认不使用 worktree**；输入框内的「同事协作 / Worktree」只在会话开始前可改，
   发送第一条消息后固定。没有项目绑定的会话不显示工作条。自由会话没有审核/合并/回写，
   worktree 只是隔离工作区。
6. **队列并行数保留**（`executionUnits`，1–8），并真正落地为工作流任务的并发上限；
   配置里的 `worktreeEnabled` 删除。
7. **会话列表按项目分组**；每个分组头可新建自由会话；默认存在“未关联项目”分组。
   手动新建的会话永远是自由会话。
8. **移动端审核**用内置资源管理器文件查看：文件列表 + `#/file?ws=__session__:<id>&path=<相对路径>`，
   不要求逐文件 diff 面板。

---

## 2. 会话模型

| | bug / local 会话 | 自由会话（chat） |
|---|---|---|
| 创建入口 | 缺陷详情 / 事项页 | 项目分组头的「+」 |
| workflow | queued → running → awaiting_review → finalizing → done | 无 workflow，只有实时状态 |
| 执行目录 | 永远独立 worktree | 默认项目仓库或 scratch；开关启用后为 worktree |
| 工具面 | 执行阶段 `task_submit`；收尾阶段 TAPD 工具 | 永远没有任务/TAPD 工具 |
| 审核界面 | 有 | 无 |
| TAPD 回写 | 有（bug 任务） | 无 |
| 列表表现 | workflow chip、排队/待审核角标 | 实时状态点、项目分组 |

`project` 字段对两类会话都可有：bug/local 是任务归属，chat 是分组 + 默认 cwd。

---

## 3. 状态机

```rust
pub enum Workflow {
    Queued,          // 等待执行槽位
    Running,         // AI 正在改代码
    AwaitingReview,  // 有改动，等用户审核
    Finalizing,      // 提交 → 合并 → 清理 → TAPD 回写
    Done,
    Failed,
    Canceled,
}
```

允许的迁移（`can_move`）：

```
Queued          -> Running | Canceled | Failed
Running         -> AwaitingReview | Done | Canceled | Failed
AwaitingReview  -> Finalizing | Canceled
Finalizing      -> Done
Done/Failed/Canceled -> 终态（用户发新消息时由 reopen_for_input 重新打开 Running）
```

`AwaitingReview → Running` 不是 `can_move` 的边：从待审核继续修改走 `reopen_for_input`，
只有接受新输入的路径会调用它，日志重放或迟到的 `turn/end` 不能把任务重新打开。

说明：

- `task.submit` 成功且有改动 → `Running -> AwaitingReview`（立即；审核界面切换）。
  无改动 → `Running -> Done`。重复调用返回 `outcome: already`。
- `turn/end` 兜底：AI 没调用 `task_submit` 但有改动 → `AwaitingReview`；无改动 → `Done`。
  已经进入 `AwaitingReview` 时只刷新 `changes`，不重复迁移。
- 用户从 `AwaitingReview` 发消息 → `Running`（沿用 `reopen_for_input`），清空本轮待审核状态。
- **直接轮次**：已完成任务的 worktree 在收尾时已经删除，继续发消息时 `reopen_for_input`
  把本轮标记为 `direct`：baseline/start 取主仓库当前 HEAD，cwd 回到主仓库，收尾时跳过
  merge，提交直接落在主仓库。worktree 仍在（例如脏目录被保留、或任务失败）时继续沿用
  隔离轮次，baseline 改为上一轮提交，审核只显示本轮改动。
  两种轮次都会清空 `commit` / `merge` / `merged` / 回写标记。
- `Finalizing` 内的失败停在 `Finalizing`，用 `finalize_step` 标记失败步骤，`dsh_task_retry_finalize`
  从该步骤重试。`Finalizing` 不允许取消（改动已合并）。
- 子 agent 会话不参与状态机；phase 只按任务根会话设置。

---

## 4. 工具与阶段

### 4.1 阶段（phase）

每个根会话有且只有一个 phase：

| phase | 何时 | 可见工具 |
|---|---|---|
| `chat` | 自由会话 | 无 |
| `none` | 队列中 / done / failed / canceled | 无 |
| `execute` | workflow = running | `task_submit` |
| `review` | workflow = awaiting_review | 无 |
| `writeback` | workflow = finalizing 且 git 步骤已完成 | `tapd_get_transitions` / `tapd_add_comment` / `tapd_update_status` / `task_complete` |

**执行阶段不能出现任何 `tapd_*` 工具。** 现有 `tapd_ping` 删除。

### 4.2 工具定义

执行阶段（仅 bug/local）：

```ts
task_submit({
  summary: string,        // 必填，根因/改动摘要
  verification?: string,  // 怎么验证的
  risks?: string,         // 风险点
})
```

收尾阶段（仅 bug）：

```ts
tapd_get_transitions()                 // 当前状态 + 合法目标
tapd_add_comment({ comment: string })  // 评论，绑定当前会话的 bug
tapd_update_status({ status: string }) // 只允许合法目标；默认 resolved
task_complete({ note?: string })       // 校验评论+状态都完成，置 done
```

规则：

- 工具不接受 `bugId`/`workspaceId`；宿主用 session 绑定解析，防止跨 bug 写。
- 评论长度上限 8000 字符；重复调用幂等（返回 `duplicate: true`）。
- `tapd_update_status` 复用 `bug_write::perform_transition`，`new` 的 bug 会自动先受理再 resolved。
- `task_complete` 在评论或状态未完成时返回 tool error（不结束回合），AI 可在同一回合修正。
- 工具实现走宿主 RPC（见 §5），不暴露宿主 HTTP token 给 dsh 进程。

### 4.3 实现方式：条件注册

```ts
ctx.tools.register(definition, { when: ({ agent }) => phaseOf(agent.session.id) === 'execute' })
```

- `when` 每个模型 step 求值一次；false 时工具从 schema、描述、PTC bindings、执行面全部消失。
- `when` 只读内存 phase map，不做 RPC、不改注册。
- 服务端（宿主 RPC）在执行前再次校验 phase / kind / bug 绑定；即使 map 过期或模型伪造调用也写不进去。
- 不需要动态加载/卸载插件；插件常驻，工具按阶段可见即可。

---

## 5. 宿主 ↔ 插件协议

在现有 `tapd-bridge` NDJSON 通道上新增帧。

### 5.1 宿主 → 插件

`task-phase`（请求，需要 ack）：

```json
{ "type": "task-phase", "requestId": 12, "sessionId": "s1",
  "phase": "execute|review|writeback|chat|none", "kind": "bug|local_item|chat" }
```

插件更新内存 map 后回 `{ "requestId": 12, "ok": true }`。

`task-phases`（快照，连接/重连后）：

```json
{ "type": "task-phases", "phases": [
  { "sessionId": "s1", "phase": "writeback", "kind": "bug" }
] }
```

`host-prompt`（宿主发起的隐藏回合，收尾用）：

```json
{ "type": "host-prompt", "sessionId": "s1", "text": "代码已提交并合并……" }
```

插件用 `createUserMessage({ content: [{ type: "text", text }], source: { kind: "host" } })`
走 `agent.followup`；转录 UI 不把它渲染成用户发言。宿主先推 `task-phase` 并等 ack，再发
`host-prompt`，保证同一回合第一次组装时写回段和工具都已就绪。

### 5.2 插件 → 宿主

```json
{ "type": "host", "requestId": "p-7", "method": "task.submit",
  "sessionId": "s1", "params": { ... } }
```

宿主回：

```json
{ "type": "host-reply", "requestId": "p-7", "ok": true, "data": { ... } }
```

方法：

| method | params | data |
|---|---|---|
| `task.submit` | `{ summary, verification?, risks? }` | `{ outcome: "review" \| "done" \| "already", phase }` |
| `task.complete` | `{ note? }` | `{ done: true }`，未完成时 `ok:false, error` |
| `tapd.transitions` | `{}` | `{ current, alias, transitions: [{ key, label }] }` |
| `tapd.comment` | `{ comment }` | `{ duplicate?: boolean }` |
| `tapd.status` | `{ status }` | `{ from, to }` |

宿主校验：token、session 存在、phase、kind、bug 绑定；失败返回 `ok:false` + 可读 error。

请求 id 由插件生成并带 `p-` 前缀，避免与宿主数字 id 冲突。

---

## 6. 系统提示词

两个条件 section（`ctx.systemPrompt.section({ text: ctx => ... })`，空字符串会被丢弃）：

### 6.1 执行段（phase = execute，bug/local）

> 代码修改完成后，必须调用 `task_submit`，用 summary 说明根因与改动，用 verification 说明
> 你如何验证，用 risks 说明风险点；调用后停止继续修改。不要 git commit、不要 push、不要写
> 任何外部系统。

### 6.2 收尾段（phase = writeback，bug）

> 代码已由宿主提交并合并到主仓库，worktree 已清理；不要 push、不要修改代码。
> 现在只做 TAPD 收尾：
> 1. `tapd_get_transitions` 确认合法目标；
> 2. `tapd_add_comment` 写评论（根因、改动、验证、风险、分支、提交）；
> 3. `tapd_update_status` 置为 resolved；
> 4. `task_complete`。
> 工具失败按错误提示修正后重试。

收尾触发消息由宿主发送，`source.kind = "host"`（转录 UI 不显示为用户发言），正文带
分支、commit、变更统计和 bug 链接。

---

## 7. 任务界面

### 桌面

工作流任务的顶部固定是「任务 / 对话 / 轨迹」三个切换；任务入队后默认停在「任务」，
新提交的审核也把会话切回这里。chat 只有「对话 / 轨迹」。

「任务」页的内容：

- 任务信息：项目、bug id、branch、worktree/仓库路径（可打开）、变更统计、状态。
  worktree 不存在且本轮是直接轮次时提示「本轮在主仓库工作」；收尾清理后提示
  「worktree 已清理，继续会话在主仓库进行」。
- Hash：开始 / 提交 / 合并，短 hash 可点击复制；直接轮次没有合并。
- 审核内容：AI 摘要只在 `task.review` 存在时显示（turn-end 兜底的审核没有摘要）；
  改动文件列表按 `task.changes` 存在显示。文件列表来自 `dsh_task_changes`，
  「应用内查看」展开逐文件 diff，「IDE 打开」沿用 `open_with`。
- `awaiting_review` 底部：`通过并收尾` / `继续修改` / `放弃`。
- `finalizing`：步骤条「提交 → 合并 → 清理 → 回写」（直接轮次隐藏「合并」），
  失败显示 `finalize.error` 与重试。
- `done`：回写结果（评论/状态）；失败/取消任务提供「打开导出目录」。

「对话」页在整轮结束后追加一张任务完成卡：完成标记、branch、变更统计、三个 hash、
TAPD 回写结果，以及「查看任务」。卡片只在任务真正完成且产生过提交/合并时出现。

### 移动端

- 同一份 `task.review` 摘要 + 文件列表。
- 文件行导航到 `#/file?ws=__session__:<sessionId>&path=<相对路径>`，由内置文件查看器展示。
- 底部：通过 / 放弃；finalizing 显示步骤与错误。
- 不要求逐文件 diff 面板。

---

## 8. 收尾（不 push）

`dsh_task_approve`（仅 `awaiting_review`，且无活跃回合）：

1. `commit`：worktree 内 `git add -A` + 确定性 message（worktree 隔离，不会混入无关改动）；
   记录提交 hash。
2. `merge`：主仓库 `git merge --no-ff`，记录 merge commit；冲突 abort 并停在 `finalizing`。
   直接轮次跳过这一步（提交已经在主仓库）。
3. `cleanup`：worktree 干净则 `git worktree remove`，随后把会话 cwd 立即交回主仓库；
   脏则保留并记 `notice`（会话留在 worktree）。直接轮次没有 worktree，也跳过这一步。
4. `writeback`：phase=writeback（推 `task-phase` 并等 ack）→ 发 `source.kind=host` 的触发消息。
5. `task_complete` 成功或回写回合结束时评论+状态都已完成 → `Done`；否则停在 `finalizing`，
   `finalize.error` 说明未完成项，可重试。

`dsh_task_retry_finalize`：从 `finalize_step` 重试（commit 幂等、merge 可重试、cleanup 可重试、
writeback 重新触发回合）。没有 `dsh_task_merge`。

回写可靠性：

- TAPD 的评论/状态接口使用长 entity id；入队时存 `detail.summary.id`，旧行如果还是短 ID，
  在回写调用时解析一次（不重写行）。
- 回写回合 5 分钟仍未结束（例如模型反复重试同一个报错工具）会被取消并计为一次失败；
  `attempts >= 2` 时宿主直接补写评论/状态，任务置 done 并在 `finalize.notice` 说明。
- 应用启动时，`finalizing(step=writeback)` 且没有 live 会话的未完成任务直接走宿主兜底，
  避免重启后丢失 host-prompt 永久卡住。

---

## 9. 队列并行

- 配置只保留 `executionUnits`（1–8，默认 2）；删除 `worktreeEnabled`。
- 入队时完成导出与 worktree 创建，任务进入 `Queued`，提示词存 `meta.pendingPrompt`。
- 调度：`active = 有 live 会话且会话 status = Running 的工作流任务数`（不看 `workflow`）。
  `task_submit` 后回合仍在跑，仍占槽位；`active < units` 时按 `createdAt` 升序启动 `Queued`。
- 释放槽位：真正的 `turn/end` 时触发调度（`finish_turn` 在 awaiting_review、finalizing、
  done/failed/canceled 各分支都会 reschedule），不是 `task_submit` 一调用就释放。
- 应用重启后，`Queued` 任务按当前 live 会话数重新调度；持久化 `Running` 但无 live 会话的任务
  不算槽位，等用户打开/恢复。
- 自由会话（含 chat worktree）不占工作流队列。

---

## 10. 输入框工作条（同事协作 / Worktree）

- 位置：输入框卡片内、文本区上方的一行。没有项目绑定（`project == null`）时整行不显示。
- 左侧：项目名 + 当前分支，纯展示。**不提供项目切换，也不提供分支切换，没有「+」按钮。**
- 右侧：
  - 同事协作开关（chat：开始前可改；task：在缺陷/事项的 EnqueuePopover 里创建时选择，
    工作条只显示状态）。
  - Worktree 开关（chat：开始前可改；task：始终开启，只显示状态）。
  - 团队协作已开启时，多一个「会话 / 任务板」视图切换。
- “开始”的判定：chat = 已发过第一条消息或回合正在运行；task = 任务创建即开始。
  开始后两个开关禁用，title 说明「会话已经开始，不可再更改」。
- chat 启用 worktree：从项目 HEAD 创建 `worktrees/<sessionId>`，分支 `chat/<8 位 id>`；
  把会话 cwd 移到 worktree（桥 `assign` + 可写根），写回 `worktreePath` / `branch` /
  `meta.worktree=true`。禁用：worktree 干净时移除，cwd 回到项目仓库（未关联则 scratch），
  `branch` 恢复为仓库当前分支；脏则拒绝并提示。
- 自由会话没有审核/合并/回写；用户可在会话内或未来 git 功能里处理提交/推送。
- `session_root` 对带 worktree 的 chat 必须返回 worktree；`feature::prompt` 只在 chat
  没有 worktree 时分配 chat scratch。

---

## 11. 会话列表与项目分组

- 分组 = 所有已配置项目（TAPD 项目 + 本地项目）+ 默认「未关联项目」（恒在最后）。
- 每个分组头有「+」：新建自由会话。删掉列表顶部的全局「新建会话」按钮。
- 分组内：bug/local 任务 + 该项目下的自由会话；按最近活动排序；折叠偏好沿用
  `agent.collapsed-projects.v1`。
- 手动新建的会话永远 `kind=chat`；即使创建时选了项目，也没有 workflow。
- 项目分组的新会话 cwd = 项目仓库；默认分组 = chat scratch。
- `dsh_projects` 返回 `{ projects: [{ kind, id, name, repoPath }] }`，供空分组渲染。
- 顶部不再有独立的团队协作条：它和 worktree 一起收进输入框工作条（§10）。
- 列宽可拖（共享 `Sash`，200–360，双击复位），可收起；窄窗口（Agent 面板宽度
  < 列宽 + 720）自动收起，只在对话左上留一个展开控件。宽度与收起状态存
  `agent.tasklist.v1`。

---

## 12. 契约

### 12.1 前端类型

```ts
export type DshTaskWorkflow =
  | "queued"
  | "running"
  | "awaiting_review"
  | "finalizing"
  | "done"
  | "failed"
  | "canceled";

export type DshTaskReview = {
  summary: string;
  verification?: string;
  risks?: string;
  files: string[];
};

export type DshTaskFinalize = {
  step: "commit" | "merge" | "cleanup" | "writeback" | null;
  error?: string;
  instructions?: string;
  notice?: string;
};

export type DshTaskFile = {
  path: string;            // 相对 worktree 根
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  additions: number;
  deletions: number;
  binary: boolean;
};

export type DshTaskGit = {
  start?: string;          // 本轮起点（worktree baseline 或直接轮次的仓库 HEAD）
  commit?: string;         // 收尾产生的提交
  merge?: string;          // 收尾产生的 merge commit；直接轮次没有
};

export type DshTaskWriteback = {
  comment: boolean;
  statusFrom?: string;
  statusTo?: string;
};

export type DshTask = {
  id: string;
  kind: "chat" | "bug" | "local_item";
  project: { id: string; name: string; kind: "tapd" | "local" } | null;
  title: string;
  bugId?: string;
  workflow: DshTaskWorkflow;
  status: DshSessionStatus;
  repoPath: string;
  worktreePath?: string;
  branch?: string;
  jsonPath: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  changes?: { files: number; additions: number; deletions: number } | null;
  review?: DshTaskReview | null;
  finalize?: DshTaskFinalize | null;
  git: DshTaskGit;
  writeback: DshTaskWriteback;
  direct: boolean;         // 本轮在主仓库直接工作，收尾跳过 merge
};
```

`git` / `writeback` / `direct` 由宿主在返回任务时从内部 `TaskMeta`
派生，不重复落库；旧行读出来是空对象 / `false`。

### 12.2 命令

| 名称 | 入参 | 返回 |
|---|---|---|
| `dsh_tasks` | — | `{ tasks }` |
| `dsh_task_enqueue_bug` | `{ workspaceId, bugId, extraPrompt?, attachments?, team?, model? }` | `{ task }`（可能 `queued`） |
| `dsh_task_enqueue_local` | `{ projectId, itemId, extraPrompt?, attachments?, team?, model? }` | `{ task }` |

`model` 是弹窗里选的 `{ provider, model, reasoningEffort? }`：入队时就记到会话上，
调度器第一次发提示词前生效；同一次选择也会成为后续新会话的默认路由。
| `dsh_task_approve` | `{ sessionId }` | `{ task }` |
| `dsh_task_retry_finalize` | `{ sessionId }` | `{ task }` |
| `dsh_task_cancel` | `{ sessionId, stash? }` | `{ task }` |
| `dsh_task_changes` | `{ sessionId }` | `{ files: DshTaskFile[], truncated }` |
| `dsh_task_diff` | `{ sessionId, file? }` | `{ diff, truncated }` |
| `dsh_task_resume` | `{ sessionId }` | `{ task }` |
| `dsh_task_delete` | `{ sessionId }` | `{ sessionId }` |
| `dsh_new_session` | `{ project?: { kind, id } }` | `{ sessionId }` |
| `dsh_projects` | — | `{ projects }` |
| `dsh_chat_worktree` | `{ sessionId, enabled }` | `{ task }` |
| `dsh_session_dir` | `{ sessionId }` | `{ path, exists }` |

事件：`dsh://tasks { tasks }`。

### 12.3 配置

- 删除 `worktreeEnabled`。
- 保留 `executionUnits`（1–8，默认 2），用于工作流任务并发。
- 旧配置里的 `worktreeEnabled` 读入时忽略。

---

## 13. 迁移

**不迁移旧数据。** 当前仍是小规模使用，升级时直接清空应用数据目录；代码只读当前 shape。

- `cache.sqlite3` 没有升级路径：版本不一致时只创建当前表，不 drop/搬移旧表。
- `dsh_tasks` 只反序列化当前 payload；旧 `workflow`（如 `awaiting_merge`）、旧 `merge`
  字段、旧非 worktree 任务都不做转换，读不出来的行按不可读行跳过。
- `agent.json` 的旧字段（`worktreeEnabled`、单供应商模型、旧 repo 映射）不再读取或迁移。
- 旧表（`agent_tasks`、`agent_queue_state`、`chat_sessions` 等）不再创建；已有数据库由用户清空。

---

## 14. 实施分工（文件所有权）

- **Rust 工作流核心**：`dsh/tasks.rs`、`task_store.rs`、`worktree.rs`、`writeback.rs`、
  `feature.rs`、`runtime.rs`、`bridge.rs`、`agent_settings.rs`、`crates/tapd-i18n/src/catalog/dsh_task.rs`。
- **插件**：`dsh/plugins/tapd-bridge/index.js`、`dsh/plugins/tapd-tools/index.js`。
- **桌面 UI**：`apps/desktop/src/agent/*`、`apps/desktop/src/lib/dsh.ts`、
  `apps/desktop/src/lib/i18n/catalog/agent.ts`、`AgentConfigTab.tsx`。
- **移动端**：`apps/companion/src/**`、`apps/desktop/src-tauri/src/companion/feature.rs`、
  移动端 i18n 目录。

验收：`pnpm typecheck`、`pnpm i18n:check`、`cargo check --workspace`、`pnpm test:policy`、
相关 cargo 测试；TestAgent 走一遍 queued → running → review → finalizing → done。
