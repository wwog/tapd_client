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

共 10 个工具：1 个自检（whoami）+ 2 个项目/缺陷查询 + 1 个我的缺陷 + 1 个详情导出（含修复提示词）+ 1 个状态查询 + 2 个修复后回写（评论、状态）+ 2 个桌面胶囊通知（唤起、等待回执）。

客户端的 **MCP tab →「MCP 服务」** 会列出全部工具名；点任一工具打开「MCP 接口文档」，左侧接口列表定位到该工具，右侧显示描述、参数类型、必填项与默认值，并可直接复制 `inputSchema`。

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `tapd_whoami` | 当前用户、公司、默认项目 | — |
| `tapd_list_projects` | 可访问项目列表 | — |
| `tapd_list_bugs` | 查询缺陷 | `workspace_id`、`owner`、`statuses`、`priorities`、`severities`、`keyword`、`only_unresolved`、`limit`、`page` |
| `tapd_list_my_bugs` | 我的未解决缺陷 | `workspace_id`、`statuses`、`priorities`、`severities`、`keyword`、`only_unresolved`、`limit`、`page`、`modified_after`、`created_after` |
| `tapd_get_bug` | 导出缺陷修复包（`bug.json` + `assets/`）并返回修复提示词；同时返回 `skills`、`projectRule`、`warnings`、`downloadedBytes`、`assetCount`、`bugJson`、`prompt` | `bug_id`（必填）、`workspace_id`、`root`、`workspace_name` |
| `tapd_get_bug_transitions` | 当前状态与允许的下一步 | `bug_id`（必填）、`workspace_id`、`root` |
| `tapd_add_bug_comment` | 追加评论（纯文本自动转富文本） | `bug_id`、`comment`（必填）、`workspace_id`、`root` |
| `tapd_update_bug_status` | 更新状态，可同时评论 | `bug_id`、`status`（key 或中文名）、`comment`、`fields`、`workspace_id`、`root` |
| `tapd_notify_user` | 在顶部胶囊唤起通知，并等待用户点击后回传结果 | `title`（必填）、`tone`、`body`、`fields`、`progress`、`blocks`、`actions`、`tag`、`waitSeconds` |
| `tapd_wait_notification` | 继续等待之前通知的用户决定 | `id`（必填）、`waitSeconds` |

约定：

- `owner` 默认 `me`；可传 `all` 或精确 TAPD 昵称。
- `only_unresolved` 默认 `true`，仅在未显式传 `statuses` 时生效（`new` / `in_progress` / `reopened`）。
- `limit` 默认 20，最大 50；服务端最小页长 20，返回结果会在本地裁剪到 `limit`。
- `workspace_id` 省略时使用客户端上次选择的项目。
- `root` 是本地仓库/工作目录绝对路径：客户端会用项目设置里的「本地文件夹」做匹配（完全相同 > 根目录在仓库内 > 仓库在根目录内），命中后等同于传了 `workspace_id`。sidecar 默认把自身进程 cwd 作为软提示填入；显式传 `root` 但匹配不到时会直接报错，cwd 提示匹配不到则回退到上次选择的项目。可用 `tapd_whoami` 查看 `localProjects` 与 `matchedWorkspaceId`。
- 时间参数格式：`YYYY-MM-DD HH:MM:SS`。
- 技能包：`tapd_get_bug` 的 `skills` 是 `name → SkillRef` 的 map，未启用同事或没有技能时是 `{}`。value 含 `coworkerId`、`coworkerName`、`role`、`name`、`description` 与 `path`；`path` 是技能包 `SKILL.md` 的绝对路径，可直接读取。技能重名时先用 `<coworkerId>/<name>` 作 key，仍重名再追加 `-2`、`-3` 序号。
- 项目规则：`projectRule` 独立返回，不参与 `prompt` 渲染。`skills` 非空时以 `技能规则：按需使用 skills 对象。` 开头；项目规则非空时追加 `项目规则：\n<rule>`；两段用空行连接，都为空时返回 `""`。

示例调用（MCP 客户端内部）：

```json
{"tool": "tapd_list_bugs", "arguments": {"workspace_id": "45336192", "owner": "me", "limit": 10}}
{"tool": "tapd_list_bugs", "arguments": {"root": "/Users/you/code/app", "owner": "me", "limit": 10}}
{"tool": "tapd_get_bug", "arguments": {"workspace_id": "45336192", "bug_id": "1145336192001010606"}}
{"tool": "tapd_get_bug", "arguments": {"root": "/Users/you/code/app", "bug_id": "1145336192001010606", "workspace_name": "示例项目"}}
{"tool": "tapd_get_bug_transitions", "arguments": {"bug_id": "1145336192001010582"}}
{"tool": "tapd_add_bug_comment", "arguments": {"bug_id": "1145336192001010582", "comment": "根因：草稿状态未写入 store。\n方案：补持久化并加回归测试。\n影响范围：会话详情草稿。"}}
{"tool": "tapd_update_bug_status", "arguments": {"bug_id": "1145336192001010582", "status": "已解决", "comment": "已修复并验证。"}}
{"tool": "tapd_notify_user", "arguments": {"title": "修复完成", "tone": "success", "body": "3 个缺陷已更新并推送。", "fields": [{"label": "耗时", "value": "2m 18s"}], "actions": [{"id": "open", "label": "查看", "style": "primary"}]}}
{"tool": "tapd_wait_notification", "arguments": {"id": "0b6f…", "waitSeconds": 30}}
```

### 4.1 AI 通知格式

`tapd_notify_user` 把一条通知推到屏幕顶部的胶囊，并同步等待用户操作（默认 30 秒，最长 120 秒），因此同一个工具调用就能拿到回执。适合「任务完成 / 失败 / 需要确认」等场景。

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

### 4.2 简单任务与复杂任务

`tapd_get_bug` 的提示词要求模型按改动复杂度分流：

- 简单任务（单文件或少量文件、局部改动，不涉及公共接口 / 数据模型 / 依赖 / 构建配置，且测试通过）：直接 `git commit`（不要 push），然后用 `tapd_add_bug_comment` 说明原因、方案与影响范围，再用 `tapd_update_bug_status` 更新状态；可先调用 `tapd_get_bug_transitions` 查看允许的下一步。
- 复杂任务（多文件、跨模块、涉及公共接口 / 数据模型 / 依赖 / 构建配置，或风险较高、测试失败）：不要 commit，也不要评论或更新 TAPD；说明根因、方案、影响范围与风险，交给用户复核和测试。
- 任何情况下都不要在提交成功前评论或更新 TAPD 状态。

桌面 Agent 的复杂任务由客户端在任务结束时检查未提交改动，自动进入待审核。

写回规则：

- `status` 可传 key（`resolved`）或中文名（`已解决`）；中文会按项目状态别名映射。
- 若目标不能直接到达（例如 `new → 已解决`），客户端会自动先流转到处理中，再执行目标状态。
- `tapd_update_bug_status` 的 `comment` 会先追加评论，再进行状态流转；状态流转失败时评论仍保留，便于追溯。
- 状态流转会按 TAPD 工作流配置自动带出处理人/开发人员/测试人员等字段默认值（与网页端流转弹窗一致）。
- 需要覆盖默认值时传 `fields` 对象，例如 `{"current_owner":"张三","resolution":"fixed"}`；也支持 `[{"name":"current_owner","value":"张三"}]` 行数组。未提供的字段沿用工作流配置。
- 桌面 Agent 任务仍有本轮未提交文件时，客户端会拒绝 `tapd_add_bug_comment` / `tapd_update_bug_status` 并提示先 `git commit`。

### 4.3 修复提示词（tapd_get_bug 的 prompt）

`tapd_get_bug` 在导出修复包的同时返回渲染好的 `prompt`，一次调用即可拿到「bug.json 路径 + 本地仓库 + 修复要求」，不再单独提供提示词工具。返回值只有 `warnings`、`downloadedBytes`、`bugJson`、`assetCount`、`skills`、`projectRule`、`prompt` 七个字段；缺陷详情不再内联，旧的交付流程说明、同事技能数组与占用相关字段均已移除。

提示词只包含任务本身的变量（`title`、`json_path`、`repo_path`、`workspace_name`、`severity`、`priority`），并要求先阅读 `bug.json` 与 `assets/`、定位根因做最小必要修改、遵循团队代码规范：

- `repo_path` 取项目「本地文件夹」；没有配置时用调用方 `root`；两者都没有时写「（当前工作目录）」。
- 项目规则不再作为模板变量。它通过独立的 `projectRule` 字段返回，由 AI 按需遵守；`prompt` 里不包含项目规则、同事技能段或 `tapdIntegration` 字段，简单/复杂任务分流与回写步骤已经内联在提示词里。
- 同事技能通过独立的 `skills` map 返回，不再写入提示词，也不会复制到导出目录。

返回（只列与提示词相关的字段，导出目录见「导出产物」）：

```json
{
  "bugJson": "/Users/you/Documents/TAPDClient/exports/UU-45336192/…/bug.json",
  "assetCount": 1,
  "downloadedBytes": 2420002,
  "skills": {
    "wwog-engineering": {
      "coworkerId": "author",
      "coworkerName": "Author",
      "role": "程序员",
      "name": "wwog-engineering",
      "description": "wwog 的个人工程规范…",
      "path": "/Applications/TAPD Client.app/Contents/Resources/coworker/author/skills/wwog-engineering/SKILL.md"
    }
  },
  "projectRule": "技能规则：按需使用 skills 对象。\n\n项目规则：\n<项目规则>",
  "prompt": "请修复 TAPD 缺陷：…\n缺陷详情：/…/bug.json\n…",
  "warnings": []
}
```

典型用法：AI 在自己的仓库里先用 `tapd_list_bugs`（按 cwd 自动匹配项目）找到缺陷，再调用 `tapd_get_bug`，把返回的 `prompt` 当作本轮任务说明，按需读取 `skills` 与 `projectRule`。

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

桌面端「导出」返回完整结果（含 `dir`）；`tapd_get_bug` 返回同一导出结果的 `bugJson`、`assetCount`、`downloadedBytes` 与 `warnings`。

```json
{
  "dir": "/Users/<you>/Documents/TAPDClient/exports/UU-45336192/<short-id>-<ascii-slug>",
  "bugJson": ".../bug.json",
  "assetCount": 1,
  "downloadedBytes": 2420002,
  "warnings": []
}
```

目录结构：

```
<bug-id>-<slug>/
├── bug.json      # BugDetail 的 camelCase JSON，顶层 assets 为已成功下载的 MediaAsset
└── assets/       # 图片、视频、日志等原件
```

- 导出目录只保留 `bug.json` 与 `assets/`；不再生成 Markdown 文件、提示词文件或技能包副本。
- `bug.json` 在资源下载完成后写入，`assets` 只列出成功落盘的资源。
- `assetCount` 是成功写入的资源数；`downloadedBytes` 只统计成功下载的字节。下载失败或超过总大小上限时写入 `warnings`，不影响其余资源。
- 目录命名：`<exports>/<workspace-slug>-<workspace_id>/<bug_ref>[-<title-slug>]`，目录名不含中文。
- 应用内 Agent 任务复用同一导出结果；任务提示词由客户端组装，不写入导出目录。

## 7. 安全与边界

- sidecar 只能访问 `127.0.0.1` 上的客户端，使用每次启动轮换的 Bearer token（`runtime.json`，权限 0600）。
- Cookie 不写入文件、不返回给 AI；资源下载在客户端进程内完成。
- 写回仅开放「追加评论」和「更新状态」，不提供删除、改处理人、批量操作等工具。
- `tapd_notify_user` / `tapd_wait_notification` 只操作本地胶囊窗口，不读写 TAPD；「允许 AI / MCP 唤起通知」关闭时调用会直接失败。
- MCP 只提供查询、导出、评论、状态更新与通知工具；任务完成由客户端按进程退出、会话 hook 或输出静默判定，不依赖 MCP 回报。
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
