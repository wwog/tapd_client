# MCP 使用说明

TAPD Client 通过一个独立的 stdio sidecar（`tapd-mcp`）向 AI 客户端提供缺陷数据。sidecar 不直接访问 TAPD，而是把工具调用转发给正在运行的桌面客户端；会话、Cookie、过滤与导出都复用客户端。

## 1. 前提

- 桌面客户端已启动并完成 TAPD 登录。
- sidecar 与客户端使用同一个用户数据目录（`~/Library/Application Support/com.tapdclient.desktop`）。
- 客户端未运行时，sidecar 会尝试拉起已安装的 App；开发模式下请先运行 `pnpm dev`。

## 2. 一键导入（推荐）

打开客户端的 **MCP tab** →「接入 AI 客户端」，每个客户端一行，直接点「一键导入」写入**用户级**全局配置：

| 客户端 | 写入位置 | 说明 |
| --- | --- | --- |
| opencode | `opencode.json[c]` 的 `mcp.tapd` | 通过 `opencode debug paths` 定位，回退 `$XDG_CONFIG_HOME/opencode` / `~/.config/opencode`；旧版 `mcp.servers` 会在导入时自动迁移 |
| ZCode | `~/.zcode/cli/config.json` 的 `mcp.servers.tapd` | `command` 是字符串（不是数组）；工作区级写 `<repo>/.zcode/config.json` |
| Claude Code | `~/.claude.json` 的 `mcpServers.tapd` | 执行 `claude mcp add --scope user --transport stdio tapd -- <路径>`；需要已安装 Claude Code CLI |
| Cursor | `~/.cursor/mcp.json` 的 `mcpServers.tapd` | 保留文件中其他 server |
| Codex | `~/.codex/config.toml` 的 `[mcp_servers.tapd]` | 优先 `$CODEX_HOME/config.toml`；保留其他配置与注释 |
| OMP | `~/.omp/agent/mcp.json` 的 `mcpServers.tapd` | 优先 `$PI_CONFIG_DIR/agent/mcp.json`；保留其他 server |
| Kimi Code | `~/.kimi-code/mcp.json` 的 `mcpServers.tapd` | 优先 `$KIMI_CODE_HOME/mcp.json`；保留其他 server |
| Gemini CLI | `~/.gemini/settings.json` 的 `mcpServers.tapd` | 保留 settings.json 里的其他配置 |
| Qwen Code | `~/.qwen/settings.json` 的 `mcpServers.tapd` | 保留 settings.json 里的其他配置 |

- 所有导入都是幂等的：重复导入返回 `changed: false`，不会重复写入。
- 写入前自动备份为 `<文件名>.bak-<时间戳>`；Claude Code 走 CLI 写入，失败时会恢复导入前的文件。
- 现有配置无法安全解析时（JSONC 注释、非法 TOML、字段类型不符）会拒绝写入并提示路径，不会覆盖。
- 之后每次启动 Agent 任务也会幂等确保注入对应客户端（opencode / ZCode / Claude Code / Cursor / Codex / OMP / Kimi Code / Gemini CLI / Qwen Code），不需要再手动改配置。
- 一键导入只改用户级配置。**只想对某个项目生效**时，展开该客户端的「手动配置」，按提示写入项目级配置（Claude Code 用 `--scope project`，Cursor/opencode 用项目内配置文件）。

## 3. 手动配置（项目级，可选）

在项目的 `opencode.json` 中加入（opencode v2.2+ 直接写在 `mcp` 下）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "tapd": {
      "type": "local",
      "command": ["/Users/user9527/projects/tapd_client/target/debug/tapd-mcp"]
    }
  }
}
```

> opencode v2.2.6 的 `mcp add` 会把条目写到 `mcp.servers.tapd`，该结构会被启动校验拒绝（`Missing key mcp.servers.enabled`）。请直接编辑上面的 JSON，把 `tapd` 放在 `mcp` 下。

打包安装后的路径通常是：

```text
/Applications/TAPD Client.app/Contents/MacOS/tapd-mcp
```

验证：

```bash
opencode mcp list
# ✓ tapd  connected
```

> 注意：`opencode mcp list` 第一次执行时可能尚未加载项目配置，重跑一次即可；新增/修改工具后需要重启 opencode 让它重新拉取 `tools/list`。

## 4. 工具

共 15 个工具：6 个查询/导出（导出即含修复提示词）+ 2 个修复后回写（评论、状态）+ 2 个外部 AI 占用（登记、释放）+ 2 个桌面胶囊通知（唤起、等待回执）+ 2 个 Agent 改动审核/任务回报 + 1 个接入前自检（whoami）。

客户端的 **MCP tab →「MCP 服务」** 会列出全部工具名；点任一工具打开「MCP 接口文档」，左侧接口列表定位到该工具，右侧显示描述、参数类型、必填项与默认值，并可直接复制 `inputSchema`。

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `tapd_whoami` | 当前用户、公司、默认项目 | — |
| `tapd_list_projects` | 可访问项目列表 | — |
| `tapd_list_bugs` | 查询缺陷 | `workspace_id`、`owner`、`statuses`、`priorities`、`severities`、`keyword`、`only_unresolved`、`limit`、`page` |
| `tapd_list_my_bugs` | 我的未解决缺陷 | `workspace_id`、`statuses`、`priorities`、`severities`、`keyword`、`only_unresolved`、`limit`、`page`、`modified_after`、`created_after` |
| `tapd_get_bug` | 完整详情（含 `embeddedMedia` 内嵌图片/视频、`changes` 变更记录；启用同事时附带 `coworkerSkills` 技能包路径） | `bug_id`（必填）、`workspace_id` |
| `tapd_export_bug_md` | 导出 MD 包并返回修复提示词 `prompt`（同时写入 `prompt.md`；启用同事时连同技能包复制到 `skills/`） | `bug_id`（必填）、`workspace_id`、`workspace_name`、`root`、`instructions` |
| `tapd_get_bug_transitions` | 当前状态与允许的下一步 | `bug_id`（必填）、`workspace_id` |
| `tapd_add_bug_comment` | 追加评论（纯文本自动转富文本） | `bug_id`、`comment`（必填） |
| `tapd_update_bug_status` | 更新状态，可同时评论 | `bug_id`、`status`（key 或中文名）、`comment`、`fields` |
| `tapd_claim_bug` | 登记外部 AI 占用（列表显示处理方与用时，阻止本地 Agent 重复入队） | `bug_id`（必填）、`workspace_id`、`root`、`model`、`status`、`title`、`note` |
| `tapd_release_bug` | 释放自己的外部占用 | `bug_id`（必填）、`workspace_id`、`root` |
| `tapd_notify_user` | 在顶部胶囊唤起通知，并等待用户点击后回传结果 | `title`（必填）、`tone`、`body`、`fields`、`progress`、`blocks`、`actions`、`tag`、`waitSeconds` |
| `tapd_wait_notification` | 继续等待之前通知的用户决定 | `id`（必填）、`waitSeconds` |
| `tapd_request_review` | 复杂改动暂停，等待用户审核后再提交（仅 Agent 任务） | `taskId`（必填）、`summary`（必填）、`files`、`risk` |
| `agent_task_report` | 通用 TUI 运行时的任务生命周期回报（仅 Agent 任务） | `taskId`、`status`（均必填）、`message`、`files`、`risk` |

约定：

- `owner` 默认 `me`；可传 `all` 或精确 TAPD 昵称。
- `only_unresolved` 默认 `true`，仅在未显式传 `statuses` 时生效（`new` / `in_progress` / `reopened`）。
- `limit` 默认 20，最大 50；服务端最小页长 20，返回结果会在本地裁剪到 `limit`。
- `workspace_id` 省略时使用客户端上次选择的项目。
- `root` 是本地仓库/工作目录绝对路径：客户端会用项目设置里的「本地文件夹」做匹配（完全相同 > 根目录在仓库内 > 仓库在根目录内），命中后等同于传了 `workspace_id`。sidecar 默认把自身进程 cwd 作为软提示填入；显式传 `root` 但匹配不到时会直接报错，cwd 提示匹配不到则回退到上次选择的项目。可用 `tapd_whoami` 查看 `localProjects` 与 `matchedWorkspaceId`。
- 时间参数格式：`YYYY-MM-DD HH:MM:SS`。
- 同事技能包：在「同事」页启用同事后，`tapd_get_bug` 会额外返回 `coworkerSkills`（`instruction` + `skills[]`，每项含 `path` 绝对路径），`tapd_export_bug_md` 会把技能包复制到导出目录的 `skills/`、在 `bug.md` 末尾列出，并在返回的 `prompt` 里带上技能包路径。未启用同事时 `coworkerSkills` 不出现、`skills` 为空数组。

示例调用（MCP 客户端内部）：

```json
{"tool": "tapd_list_bugs", "arguments": {"workspace_id": "45336192", "owner": "me", "limit": 10}}
{"tool": "tapd_list_bugs", "arguments": {"root": "/Users/you/code/app", "owner": "me", "limit": 10}}
{"tool": "tapd_get_bug", "arguments": {"workspace_id": "45336192", "bug_id": "1145336192001010606"}}
{"tool": "tapd_export_bug_md", "arguments": {"workspace_id": "45336192", "bug_id": "1145336192001010582"}}
{"tool": "tapd_get_bug_transitions", "arguments": {"bug_id": "1145336192001010582"}}
{"tool": "tapd_add_bug_comment", "arguments": {"bug_id": "1145336192001010582", "comment": "根因：草稿状态未写入 store。\n方案：补持久化并加回归测试。\n影响范围：会话详情草稿。"}}
{"tool": "tapd_update_bug_status", "arguments": {"bug_id": "1145336192001010582", "status": "已解决", "comment": "已修复并验证。"}}
{"tool": "tapd_claim_bug", "arguments": {"bug_id": "1145336192001010582", "model": "Deepseek", "title": "登录页按钮错位"}}
{"tool": "tapd_release_bug", "arguments": {"bug_id": "1145336192001010582"}}
{"tool": "tapd_notify_user", "arguments": {"title": "修复完成", "tone": "success", "body": "3 个缺陷已更新并推送。", "fields": [{"label": "耗时", "value": "2m 18s"}], "actions": [{"id": "open", "label": "查看", "style": "primary"}]}}
{"tool": "tapd_wait_notification", "arguments": {"id": "0b6f…", "waitSeconds": 30}}
```

### 4.1 AI 通知格式

`tapd_notify_user` 把一条通知推到屏幕顶部的胶囊，并同步等待用户操作（默认 30 秒，最长 120 秒），因此同一个工具调用就能拿到回执。适合「任务完成 / 失败 / 需要确认」等场景，外部 AI 客户端也可以用它提示用户。

- `tone`：`info` / `success` / `warning` / `error` / `progress`，控制图标与配色。
- `body`：正文，保留换行。
- `fields`：键值对列表（最多 8 项），渲染为两列。
- `progress`：`{ "percent": 0-100, "label": "…" }`，渲染进度条。
- `blocks`：需要更精细排版时使用，支持 `text` / `code` / `fields` / `progress` / `divider`；传了非空 `blocks` 就不再使用上面的简写。
- `actions`：最多 4 个按钮，`{ "id", "label", "style" }`；用户点击后返回 `actionId` 与 `actionLabel`。不传时只显示「知道了」。
- `tag`：相同 tag 的待处理通知会被替换，适合反复更新的进度卡片。
- `waitSeconds`：0 表示立即返回；之后可用 `tapd_wait_notification` 继续等待。

返回 `status`：

| status | 含义 |
| --- | --- |
| `acted` | 用户点击了按钮，附 `actionId` / `actionLabel` |
| `dismissed` | 用户点了关闭 |
| `timeout` | 等待超时，卡片仍留在胶囊里；可再次等待 |
| `pending` | `waitSeconds=0`，立即返回 |
| `replaced` | 被相同 `tag` 的新通知替换 |
| `expired` | 卡片已被清理或客户端重启 |

AI 通知只存在于内存，不写入 SQLite，也不会跨重启保留；设置 → 通知里可以关闭「允许 AI / MCP 唤起通知」，或用调试面板发一条自定义卡片验证效果。

### 4.2 Agent 改动审核（tapd_request_review）

只有客户端 Agent 修复流程会用到：

- 简单改动按默认提示词直接 `git commit`，提交成功后再回写 TAPD。
- 复杂改动调用 `tapd_request_review`，参数 `taskId` 来自提示词中的 `{{task_id}}`；`summary` 写根因/方案/影响，`files` 列出改动文件，`risk` 说明风险点。
- 调用后任务进入 `awaiting_approval`，Agent 本轮被中止，工作区保留未提交的 diff，队列停住。
- 「待审核」页选择：
  - **通过并提交**：任务重新入队，使用「审核已通过」提示词，只做核对、提交与 TAPD 回写。
  - **停止并储藏**：把本次涉及的文件 `git stash`（含未跟踪），任务取消并暂停队列。
- 如果模型忘记调用该工具，本轮结束时新出现的未提交文件也会自动进入待审核，避免代码被遗忘。
- 客户端会拒绝未提交时的 TAPD 写操作：任务仍有本轮新产生的未提交文件时，`tapd_add_bug_comment` / `tapd_update_bug_status` 返回“请先 git commit”。

写回规则：

- `tapd_get_bug` 额外返回 `tapdIntegration`，它是对外交付流程的唯一说明（不强制调用，客户端可直接展示或忽略）：`claim` 认领与续约；`simple` / `complex` 两种改动的复核条件——简单改动直接 commit 并回写，复杂改动先请用户复核测试、确认后再 commit 与回写（判断不了按复杂处理）；`writeBack` 固定「先 commit，再评论，最后改状态」。流程不再塞进提示词，避免模型跳过。
- `status` 可传 key（`resolved`）或中文名（`已解决`）；中文会按项目状态别名映射。
- 若目标不能直接到达（例如 `new → 已解决`），客户端会自动先流转到处理中，再执行目标状态。
- `tapd_update_bug_status` 的 `comment` 会先追加评论，再进行状态流转；状态流转失败时评论仍保留，便于追溯。
- 状态流转会按 TAPD 工作流配置自动带出处理人/开发人员/测试人员等字段默认值（与网页端流转弹窗一致）。
- 需要覆盖默认值时传 `fields` 对象，例如 `{"current_owner":"张三","resolution":"fixed"}`；也支持 `[{"name":"current_owner","value":"张三"}]` 行数组。未提供的字段沿用工作流配置。

### 4.3 修复提示词（随 tapd_export_bug_md 返回）

`tapd_export_bug_md` 在导出包的同时生成修复提示词：写到包内 `prompt.md`，并把同一份文本放进返回值的 `prompt`，因此「导出 + 取提示词」只要一次调用，不再单独提供提示词工具。

提示词只描述任务本身（读取 bug.md / assets、最小必要修改、跑测试），结构对齐桌面端 Agent 收到的那份，但去掉了只属于桌面 Agent 的 `tapd_request_review` 审核队列；认领、复核与回写这些流程统一放在 `tapd_get_bug` 的 `tapdIntegration`，提示词末尾只留一句指路：

- 项目规则：该项目的「项目规则」；`repo_path` 取项目「本地文件夹」，否则用调用方 `root`，都没有时写「（当前工作目录）」。
- 同事：复用「同事」页启用的同事，角色与技能包 `SKILL.md` 绝对路径会写入提示词（模板中的 `{{coworker}}` 位置），与包内 `skills/` 副本一致。
- `instructions`：补充说明，追加到提示词末尾作为本轮额外要求。
- 外部客户端没有活动 Agent 任务，不提供 `task_id` / `tapd_request_review` / `agent_task_report`。

返回（只列与提示词相关的字段，其余见「导出产物」）：

```json
{
  "prompt": "请修复 TAPD 缺陷：…\n缺陷详情文件：/…/bug.md\n…",
  "promptPath": "/Users/you/Documents/TAPDClient/exports/UU-45336192/…/prompt.md",
  "dir": "/Users/you/Documents/TAPDClient/exports/UU-45336192/…",
  "markdownPath": "/Users/you/Documents/TAPDClient/exports/UU-45336192/…/bug.md",
  "skills": [
    {
      "coworkerId": "author",
      "coworkerName": "Author",
      "role": "程序员",
      "name": "wwog-engineering",
      "description": "wwog 的个人工程规范…",
      "path": "/Applications/TAPD Client.app/Contents/Resources/coworker/author/skills/wwog-engineering/SKILL.md",
      "relativePath": "skills/author/wwog-engineering/SKILL.md"
    }
  ],
  "warnings": []
}
```

典型用法：AI 在自己的仓库里先用 `tapd_list_bugs`（按 cwd 自动匹配项目）找到缺陷，再调用 `tapd_export_bug_md`，把返回的 `prompt` 当作本轮任务说明。

### 4.4 外部 AI 占用（tapd_claim_bug / tapd_release_bug）

外部 AI 开始处理缺陷前先登记占用，桌面端列表会显示「“Zcode”正在使用“Deepseek”进行处理」、创建时间与滚动用时，并禁止本地 Agent 重复入队。

```json
{"tool": "tapd_claim_bug", "arguments": {"bug_id": "1145336192001010582", "model": "Deepseek", "status": "running"}}
```

- 客户端名取自 MCP 握手的 `clientInfo.name`；`model` 由调用方传入，缺省时列表只显示客户端名。
- 占用 15 分钟无心跳自动失效；处理期间请每隔几分钟再次调用 `tapd_claim_bug` 续约（保留首次 `claimedAt`），完成后调用 `tapd_release_bug`。
- 与本地 Agent 队列互斥：
  - 本地 Agent 正在运行 / 等权限 / 待审核 → 返回 `claimed: false`，`conflict.kind = "desktop_agent"`，请勿修改该缺陷。
  - 本地 Agent 只是排队 → 客户端取消该排队任务并在胶囊通知用户「“Zcode”接管了「标题」，队列中的 Agent 任务已取消」，占用登记成功。
  - 另一个外部客户端已占用 → 返回 `conflict.kind = "external"`。
- 列表里该缺陷只保留「查看（点行）」与「取消（释放占用）」；取消后外部 AI 下次心跳会收到冲突。
- `tapd_get_bug` 返回 `externalClaim`，`tapd_list_bugs` 返回当前项目的 `externalClaims`，AI 可据此跳过已被占用的缺陷。

返回示例：

```json
{
  "claimed": true,
  "claim": {
    "workspaceId": "45336192",
    "bugId": "1145336192001010582",
    "client": "Zcode",
    "model": "Deepseek",
    "status": "running",
    "claimedAt": "2026-11-11T08:12:00Z",
    "lastSeenAt": "2026-11-11T08:12:00Z"
  },
  "conflict": null,
  "message": "已登记占用；请每 15 分钟内再次调用 tapd_claim_bug 续约，完成后调用 tapd_release_bug"
}
```

## 5. 策略与审计

MCP tab 的「MCP 策略」与「调用审计」是客户端的第二层权限边界：sidecar 只负责转发，所有策略都在 App 内执行，AI 无法绕过。

### 5.1 策略

| 策略 | 默认 | 说明 |
| --- | --- | --- |
| 允许写操作 | 开 | 关闭后 `tapd_add_bug_comment` / `tapd_update_bug_status` 直接拒绝，查询与导出不受影响 |
| 允许访问的项目 | 全部 | 选择项目后，工具只能访问这些 workspace；未显式传 `workspace_id` 时也只会在白名单内回退 |
| 允许的目标状态 | 不限制 | 逗号分隔的状态 key 或中文名；为空时完全交给 TAPD 工作流 |
| 记录调用审计 | 开 | 关闭后只写应用日志，不落 `mcp_audit` 表 |

策略只会收窄范围，不会扩大 TAPD 账号本身的权限。

### 5.2 审计

- 存储：`~/Library/Application Support/com.tapdclient.desktop/cache.sqlite3` 的 `mcp_audit` 表，最多保留 500 条；每次写入只插入一行并裁剪最旧行。
- 字段：时间、工具、客户端、决策（允许 / 拒绝 / 失败）、耗时、项目 ID、缺陷 ID、错误摘要、参数摘要。
- 不保存：评论正文、请求/响应正文、Cookie、token。参数摘要只记录 id、status、limit 等标量与评论长度。
- MCP tab 支持按「全部 / 被拒绝 / 失败」筛选，导出为 `~/Documents/TAPDClient/exports/mcp-audit-<时间>.json`，也可清空。

## 6. 导出产物

`tapd_export_bug_md` 返回：

```json
{
  "dir": "/Users/<you>/Documents/TAPDClient/exports/UU-45336192/<short-id>-<ascii-slug>",
  "markdownPath": ".../bug.md",
  "assetCount": 1,
  "downloadedBytes": 2420002,
  "prompt": "请修复 TAPD 缺陷：…",
  "promptPath": ".../prompt.md",
  "skills": [
    {
      "coworkerId": "author",
      "coworkerName": "Author",
      "role": "程序员",
      "name": "wwog-engineering",
      "description": "wwog 的个人工程规范…",
      "path": "/…/coworker/author/skills/wwog-engineering/SKILL.md",
      "relativePath": "skills/author/wwog-engineering/SKILL.md"
    }
  ],
  "warnings": []
}
```

目录结构：

```
<bug-id>-<slug>/
├── bug.md        # 标题、基本信息、描述、资源（附件 + 内嵌）、变更记录、评论、自定义字段、协作同事技能包
├── bug.json      # 结构化数据
├── prompt.md     # 修复提示词（与返回的 prompt 相同）
├── skills/       # 启用的同事技能包（按同事 id / 技能目录复制，未启用时不创建）
└── assets/       # 图片、视频、日志等原件
```

`skills/` 由「同事」页启用的同事决定：每个技能包整目录复制（跳过符号链接，单包上限 400 个文件 / 4MB），`bug.md` 末尾的「协作同事技能包」章节列出包内相对路径，重复导出会替换该章节而不是叠加。应用内 Agent 任务导出时只写 `bug.md` / `bug.json` / `skills/`，不写 `prompt.md`（任务提示词由 Agent 自己组装）。

图片以内联 Markdown 引用，视频以链接引用；下载失败时保留 TAPD 原始 URL 并在 `warnings` 中说明。

## 7. 安全与边界

- sidecar 只能访问 `127.0.0.1` 上的客户端，使用每次启动轮换的 Bearer token（`runtime.json`，权限 0600）。
- Cookie 不写入文件、不返回给 AI；资源下载在客户端进程内完成。
- 写回仅开放「追加评论」和「更新状态」，不提供删除、改处理人、批量操作等工具。
- `tapd_notify_user` / `tapd_wait_notification` 只操作本地胶囊窗口，不读写 TAPD；「允许 AI / MCP 唤起通知」关闭时调用会直接失败。
- `tapd_request_review` 只接受当前正在运行的 Agent 任务 id；外部 AI 没有活动任务时会被拒绝，不能暂停桌面队列。
- 写操作使用当前 TAPD 会话 Cookie + `dsc-token`，受 TAPD 工作流与权限约束；非法流转会被拒绝并把允许的下一步返回给 AI。
- 所有工具调用（含写操作）记录在客户端日志（数据目录 `logs/`）与 MCP 审计（`cache.sqlite3` 的 `mcp_audit` 表）；审计包含工具名、客户端、策略决策、耗时、项目/缺陷与错误摘要，不保存评论正文。

## 8. 常见问题

**`TAPD Client 未运行`**
启动桌面客户端，确认已登录，然后重试。开发模式需先 `pnpm dev`。

**`unauthorized`**
客户端重启后 token 会轮换。sidecar 会自动重读 `runtime.json` 并重试一次；仍失败时重启 AI 客户端。

**返回 0 条**
默认 `owner=me` 且只查未解决缺陷。可显式传 `"owner": "all"`、`"statuses": []`、`"only_unresolved": false` 验证权限与项目是否正确。

**`opencode mcp list` 显示未配置**
确认配置直接写在 `mcp.tapd` 下（opencode v2.2+ 不再接受 `mcp.servers` 包装），并从项目根目录执行命令。
