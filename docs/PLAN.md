# TAPD 增强客户端 — 实施计划

> 目标：做一个 macOS 桌面客户端，内嵌 TAPD 登录态，重建缺陷视图，提供 MCP 服务（查询/导出 + 修复后评论与状态回写）、新缺陷弹窗通知，以及唤起 opencode 修复缺陷的串行任务队列。
>
> 版本：v1.0 计划（2026-11-09）

---

## 1. 范围

### 1.1 v1 必做

1. 隐藏 WebView 登录 tapd.cn，复用公司账号 / SSO，登录态持久化。
2. 重建 UI：项目切换（默认上次项目）、我的缺陷 / 全部缺陷、筛选、详情（描述 / 评论 / 资源 / 变更）。
3. 后台轮询同步 + 新缺陷检测（只认分配给自己的新 bug / 重新打开）。
4. 自绘通知窗口（**不用系统通知**）：处理 / 查看 / 忽略 三个按钮。
5. MD 导出：标题、详情、资源（图片 / 视频落盘）、评论，形成可交给 AI 的 bug 包。
6. MCP stdio 服务：bug 查询、详情、导出，以及评论 / 状态回写；支持处理人 / 状态 / 严重程度 / 时间等筛选；能力边界可配置；调用审计。
7. opencode 集成：PTY 内启动完整 TUI，自动注入修复任务；串行队列（并发 1）；客户端内查看终端并可直接接管输入。
8. 设置中心：MCP 边界、通知、导出、Agent、项目仓库映射。

### 1.2 v1 不做（明确非目标）

- Windows / Linux（架构预留，后续补）。
- 多 agent 并行、多任务并发（硬性串行）。
- AI 写 TAPD（评论 / 改状态 / 指派）仅预留接口，默认关闭且 v1 不实现真实写操作。
- 系统通知、云同步、多人协作。（自动更新已在 M9 补齐，改为 GitHub Releases + Tauri updater。）
- TAPD Open API 通道（按决策只做网页会话；适配器接口保留，后续可加）。

---

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        TAPD Client (Tauri 2 / macOS)             │
│                                                                  │
│  ┌────────────────────┐      IPC       ┌──────────────────────┐  │
│  │ React UI           │◄──────────────►│ Rust Core            │  │
│  │ 主窗口 / 通知窗口   │                │ 命令、状态、事件      │  │
│  │ Agent 控制台(xterm)│                └──────────┬───────────┘  │
│  └────────────────────┘                           │              │
│                                                   ▼              │
│  ┌────────────────────┐   eval/inject   ┌──────────────────────┐ │
│  │ 隐藏 WebView        │◄───────────────│ Web Session Bridge   │ │
│  │ www.tapd.cn 登录态  │───────────────►│ 队列/限速/超时/重试   │ │
│  └────────────────────┘   JSON 结果     └──────────┬───────────┘ │
│                                                   ▼              │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────┐  │
│  │ SQLite 缓存  │◄──│ Sync Engine  │──►│ 本地 HTTP (axum)     │  │
│  │ bugs/comments│   │ 轮询/增量/diff│   │ 127.0.0.1 + token    │  │
│  └──────────────┘   └──────┬───────┘   └──────────┬───────────┘  │
│                            │                      │              │
│                     ┌──────▼───────┐              │              │
│                     │ 通知判定      │              │              │
│                     └──────┬───────┘              │              │
│                            │                      │              │
│  ┌──────────────┐   ┌──────▼───────┐              │              │
│  │ MD Exporter  │◄──│ Agent Queue  │              │              │
│  │ md + assets  │   │ 串行 / PTY    │              │              │
│  └──────────────┘   └──────────────┘              │              │
└───────────────────────────────────────────────────┼──────────────┘
                                                    │ HTTP (loopback)
                                        ┌───────────▼───────────┐
                                        │ tapd-mcp (sidecar)     │
                                        │ stdio JSON-RPC / MCP   │
                                        │ 策略引擎 / 审计转发     │
                                        └───────────┬───────────┘
                                                    │ stdio
                                        ┌───────────▼───────────┐
                                        │ opencode / 其他 AI CLI │
                                        └────────────────────────┘
```

### 为什么 MCP 走 sidecar + 本地 HTTP

- AI CLI 要求 MCP 是它能 spawn 的进程；GUI 进程无法直接作为 stdio MCP。
- 会话、同步、缓存、策略只有一份，放在 App 内；sidecar 只做协议 + 策略 + 代理。
- App 未启动时：sidecar 尝试拉起 App（macOS `open -b` / `open <app>`），最多等 15s；失败则用 SQLite 只读缓存回答查询类工具，并明确标记 `stale: true`。写工具直接返回错误。
- 本地服务只绑 `127.0.0.1`，随机端口，每次启动轮换 Bearer token；运行时信息写 `runtime.json`（0600）。

---

## 3. 技术选型

| 层 | 选型 | 说明 |
|---|---|---|
| 壳 | Tauri 2.x | macOS 原生 WKWebView；隐藏 webview 与多窗口成熟 |
| 前端 | React 19 + TypeScript + Vite 7 | 生态齐全 |
| UI | Tailwind 4 + shadcn/ui (Radix) | 复刻 TAPD 深色侧栏 + 浅色内容区 |
| 状态 | TanStack Query + Zustand | 服务端数据 / 本地 UI 状态分离 |
| 列表 | TanStack Virtual | 缺陷量大时仍流畅 |
| 终端 | xterm.js + addon-fit + WebGL | PTY 输出渲染 |
| 后端 | Rust + tokio + axum | 本地 API |
| 存储 | SQLite + sqlx（runtime 查询） | 单文件、可迁移、支持 FTS5 备用 |
| HTML→MD | `htmd` + `ammonia` 清洗 | TAPD 富文本规则需自定义后处理 |
| HTTP | reqwest（rustls） | 仅用于资源下载（带 webview cookie），JSON 走 bridge |
| PTY | `portable-pty` | 全平台；macOS 上 opencode TUI 正常渲染 |
| MCP | `rmcp`（优先）或手写 JSON-RPC | stdio 传输；工具 schema 用 serde |
| 日志 | tracing + tracing-appender | 按天滚动，设置页可一键导出 |
| 安全 | Keychain（预留）+ 文件权限 0600 | v1 不落盘 cookie/token 到日志 |

包管理：pnpm workspace + cargo workspace。

---

## 4. 目录结构

```
tapd_client/
├── docs/
│   ├── PLAN.md                 # 本文件
│   └── spike.md                # M0 接口/桥接验证结论（产出）
├── apps/
│   └── desktop/
│       ├── src/                # React 前端
│       │   ├── pages/          # 主界面、设置、通知、Agent 控制台
│       │   ├── components/
│       │   ├── lib/            # tauri invoke 封装、查询 hooks、类型
│       │   └── styles/
│       └── src-tauri/
│           ├── src/
│           │   ├── main.rs
│           │   ├── commands/   # Tauri 命令
│           │   ├── windows/    # 主/通知/Agent 窗口生命周期
│           │   └── bridge/     # 隐藏 webview 注入脚本与消息通道
│           ├── tauri.conf.json
│           └── capabilities/   # 远程 URL IPC 权限（关键）
├── crates/
│   ├── tapd-core/              # 领域模型/适配器/存储/同步/导出/策略
│   └── tapd-mcp/               # stdio MCP 二进制
├── fixtures/                   # 录制下来的接口样本、HTML、Fake agent
└── scripts/
```

---

## 5. 数据通道设计（隐藏 WebView）

### 5.1 登录流程

1. 启动 → 读本地登录探测结果。
2. 未登录：弹出可见「登录 TAPD」窗口（正常窗口，加载 `https://www.tapd.cn/`），用户完成账号 / SSO 登录；检测到会话有效后关闭该窗口。
3. 已登录：不显示任何 webview，仅创建隐藏窗口作为数据桥。
4. 登录态由 WKWebView 数据存储持久化，重启无需重复登录；失效时回到步骤 2。

### 5.2 数据桥接方式（M0 已验证）

远程页面无法调用 Tauri 应用命令（`bridge_result not allowed`），`eval_with_callback` 也不 await Promise。最终采用两段式原生 eval：

- **同步查询**（`ping` / `snapshot` / `clear`）：`eval_with_callback("JSON.stringify(expr)")` 直接取回结果。返回值可能被二次编码，解析后若是字符串则再解析一次。
- **异步请求**（HTTP / 后续 MCP）：注入的 JS 在 async IIFE 中执行并把结果写入 `window.__TAPDCB_RESULTS__[token]`，Rust 每 120ms 用原生 eval 轮询该结果桶，拿到 `ok/error` 后清理。
- 不依赖远程 IPC、不依赖自定义 scheme；`tapdclient://` 导航分支保留为历史兜底但不再使用。
- 所有数据请求都由页面自身 `fetch` 发起（`__TAPDCB__.request`），天然携带登录 Cookie 和同源权限。

M0 抓包与接口结论见 `docs/spike.md`。

### 5.3 资源文件（图片 / 视频）

- JSON 数据走桥；二进制单独下载：从 webview 读取 cookie（内存中），用 reqwest 带 `Cookie` 下载到本地缓存。
- 下载失败回退：桥内 `fetch` → base64 分片（仅限图片，≤20MB）。
- 所有下载受并发 2、超时 60s、大小上限（默认单文件 200MB，可配）约束。

### 5.4 限速与稳定性

- 全局令牌桶：默认 2 req/s，遇到 429/风控指数退避（1s→2s→…→60s），并在状态栏显示「受限」。
- 相同查询 30s 内走内存缓存。
- 同步请求带 jitter，避免固定节奏。
- 所有接口调用统一错误分类：`auth_expired | rate_limited | not_found | schema_changed | network | unknown`；`schema_changed` 触发设置页黄色告警 + 日志采样。

### 5.5 身份识别

- 登录后通过内部接口取当前用户（昵称 / user id），写入 `me`。
- 兜底：设置页「我是谁」下拉，从项目成员中选；列表 / 通知都依赖这个值。
- 多公司 / 多团队：v1 只支持当前登录账号可见的项目。

### 5.6 接口清单（M0 抓包后填具体路径）

必须拿到的数据：

| 数据 | 关键字段 |
|---|---|
| 当前用户 | nick、user_id、头像 |
| 项目列表 | workspace_id、name、company_id、是否可访问 |
| 缺陷列表 | id、title、status、priority、severity、owner、creator、created、modified、iteration、module、version_report |
| 缺陷详情 | 上述 + description(HTML)、平台/OS/测试类型、参与人、标签 |
| 评论 | id、author、created、body(HTML)、附件 |
| 附件 | id、filename、size、mime、下载 url、所属评论 |
| 变更历史 | 字段、旧值、新值、操作人、时间 |
| 字段字典 | 状态列表、优先级、严重程度、迭代、模块 |

M0 产出 `docs/spike.md`：请求样例、响应结构、分页/total 字段、排序参数、已知坑。录制脱敏样本到 `fixtures/`，作为 mapper 单测数据。

---

## 6. 数据模型（初版设计草案）

> 以下是开工时的设计草案，用于说明数据关系；当前实现以 `apps/desktop/src-tauri/src/cache.rs` 的迁移为准：`snapshots`、`bugs`、`agent_tasks`、`agent_queue_state`、`mcp_audit`、`notification_*`。

```sql
workspaces(id TEXT PK, name, company_id, enabled INT, sort INT, last_synced_at);
users(workspace_id, user_id, nick, name, email, PRIMARY KEY(workspace_id, user_id));
bugs(workspace_id, id, title, description_html, status, priority, priority_label,
     severity, owner, creator, created, modified, iteration_id, module,
     version_report, platform, os, testtype, due, raw_json, synced_at,
     PRIMARY KEY(workspace_id, id));
bug_comments(id PK, workspace_id, bug_id, author, created, body_html, raw_json);
attachments(id PK, workspace_id, bug_id, comment_id, filename, mime, size,
            remote_url, local_path, downloaded_at);
bug_changes(id PK, workspace_id, bug_id, field, old_value, new_value, author, changed_at);
notifications(id PK, workspace_id, bug_id, trigger, state, created_at, handled_at);
agent_tasks(id PK, workspace_id, bug_id, md_path, repo_path, agent, status,
            queued_at, started_at, finished_at, exit_code, log_path);
mcp_audit(id PK, ts, client, tool, args_json, decision, reason, rows, duration_ms);
settings(key PK, value);
sync_state(workspace_id PK, last_poll_at, last_full_at, baseline_done);
```

索引：`bugs(workspace_id, owner, status, modified)`、`bug_comments(workspace_id, bug_id)`、`notifications(state, created_at)`、`agent_tasks(status, queued_at)`。

迁移：`crates/tapd-core/migrations/*.sql`，启动时自动执行；只做向前兼容迁移。

---

## 7. 功能设计

### 7.1 主界面

- **左侧图标栏**：缺陷 / Agent / MCP；底部是设置，项目栏收起时用户头像缓动到设置上方。
- **项目栏**：搜索式项目切换、拖拽调宽、窗口过窄自动收起；右键本地隐藏项目；底部用户按钮进入「账户与会话」独立视图。
- **内容头部**：当前项目名、范围（我的 / 全部）、刷新状态；刷新时标题栏居中显示「更新中」。
- **筛选栏**：处理人（我 / 全部 / 指定成员）、状态多选、优先级、严重程度、关键词、时间范围。筛选条件按项目持久化。
- **表格列**：标题、状态、优先级、严重程度、处理人、创建人、创建时间、更新时间；标题前保留 TAPD 风格 `BUG` 标签；操作列固定右侧。
- **详情面板**：与列表并排的第三列（非遮罩抽屉），可拖动宽度；含基本信息、描述、资源、变更、评论与自定义字段。
- **顶部状态胶囊**：通知与 Agent 状态的常驻入口，可拖动；不使用系统托盘。
- **空态/错误态**：未登录、登录失效、限流、项目无缺陷分别给出明确引导。

### 7.2 同步与通知判定

- 轮询间隔默认 30s（20–600s 可配）；「我的」范围跨项目增量轮询，「项目」范围只同步当前项目。
- 首次同步某项目：分页全量拉取（最多 25 页），标记 `baseline_done`，**不弹通知**（避免首启爆炸）。
- 后续每轮：
  1. 分页拉取 `owner == me` 且 `modified >= last_poll - 2min` 的缺陷（单页 200，最多 10 页，页间短暂节流）；未读完时保留 cursor，避免越过未读窗口。
  2. 与本地 `notification_seen` 比较：新出现且状态 ∈ {新, 重新打开}；或状态变为 {新, 重新打开}；或处理人变化 / `assigned_time` 变为我（转派）。
  3. 生成 `notification_items`（新建按缺陷终身去重；转派与重新打开按状态 / 指派变化去重；已忽略的 bug 不再提示，除非重新打开）。
- `notification_seen` 按最后观察时间保留 90 天且最多 20000 条，ignored 随 seen 一起裁剪。
- 详情 / 评论按需拉取，不在轮询中批量加载，控制请求量。

### 7.3 通知窗口

- 顶部状态胶囊（独立透明 Tauri 窗口）：约 210×34，置顶、不占 Dock、可拖动并记住位置；有通知时展开为 384px 卡片。显示方式可选：默认**常驻**（空闲时只显示品牌与状态点，不再显示「待命」文案），或**仅通知**（只在通知、Agent 运行/待审核、更新、同步异常、通知暂停、连接中时出现）。表面颜色走 `bg-island` 系列 token，外观默认跟随应用主题，也可单独固定为浅色/深色。
- 卡片内容：项目名、严重程度/优先级徽章、两行标题、创建人、时间。
- 按钮：
  - **处理**：改派 + 接受 → 入队 Agent 任务；失败保持 pending 可重试。
  - **查看**：主窗口置前并打开该缺陷详情；标记 `viewed`。
  - **忽略**：标记 `ignored`，同 bug 后续不再弹；重新打开可再次通知。
- 免打扰：时间段（如 22:00–09:00）内只累计，不展开卡片。
- 不提供通知历史视图；本地状态 `pending/handled/viewed/ignored` 只是用户动作，不是 TAPD 的已读状态。TAPD 没有暴露已读/未读，因此不做托盘角标与未读计数。
- 胶囊与主窗口共用同一前端 bundle，通过 `window` 参数区分视图。

### 7.4 MD 导出规范

导出目录：

```
~/Documents/TAPDClient/exports/<workspace_name>-<workspace_id>/<bug_id>-<slug>/
├── bug.md
└── assets/
    ├── att-<id>-<filename>
    └── ...
```

`bug.md` 结构（固定模板，便于 agent 稳定解析）：

```markdown
---
id: "1145336192001234567"
workspace: "UU"
workspace_id: "45336192"
title: "【rust-会话详情】引用编辑的消息在输入框未保存草稿"
status: "新"
priority: "中"
severity: "一般"
owner: "何帅"
creator: "张芳兰"
created: "2026-11-09 19:27"
modified: "2026-11-09 19:27"
iteration: ""
module: ""
platform: "iOS/Android"
bug_url: "https://www.tapd.cn/45336192/bug/show?..."
exported_at: "2026-11-09T20:00:00+08:00"
exporter: "tapd-client/1.0"
---

# 【rust-会话详情】引用编辑的消息在输入框未保存草稿

## 基本信息

| 字段 | 值 |
| --- | --- |
| 状态 | 新 |
| 优先级 | 中 |
| 严重程度 | 一般 |
| 处理人 | 何帅 |
| 创建人 | 张芳兰 |
| 发现版本 | rust对接 |
| 创建时间 | 2026-11-09 19:27 |

## 缺陷描述

（TAPD 富文本 → Markdown；图片以相对路径内联）

## 资源

- ![截图 1](assets/att-1001-1.png)
- [复现视频](assets/att-1002-repro.mp4)（12.4 MB，需本地打开）

## 评论

### 1. 张芳兰 · 2026-11-09 19:40

（评论正文 Markdown）

#### 评论附件

- ![日志截图](assets/att-1003-log.png)

### 2. 何帅 · 2026-11-09 20:10

已定位为草稿状态未写入 store，二次修复。
```

规则：
- 图片：`<img>` → Markdown 图片；仅 http(s) 或 TAPD 相对路径；下载失败保留原始 URL 并标注。
- 视频：不内联，落盘后用链接 + 大小标注（Markdown 无法可靠内嵌视频）。
- 评论按时间正序，附作者与时间；评论内附件归属到对应评论下。
- 超长描述 / 超大附件受设置上限约束，超出部分保留链接并注明「因体积未下载」。
- 每次导出生成 `bug.json`（原始结构化数据，脱敏可选），供程序消费；`bug.md` 面向人和 agent。
- 模板可配置（标题层级、是否含变更历史、是否含评论），设置页提供预览。
- 导出为纯函数 + 文件写入两层，便于 golden test。

### 7.5 Agent 集成（opencode）

- **仓库映射**：设置中为每个项目配置本地仓库路径；未配置时使用导出目录并在终端提示，不阻塞。
- **启动方式**：`portable-pty` 在仓库目录启动 `opencode` 完整 TUI：
  1. 创建 PTY（cols/rows 随窗口变化）。
  2. 读取输出直到 TUI 就绪（检测提示行 / 输出静默 800ms / 最长 8s）。
  3. 注入 prompt（UTF-8 文本 + 回车），prompt 由模板生成：

```text
请修复 TAPD 缺陷：{{title}}

缺陷详情文件：{{md_path}}
本地仓库：{{repo_path}}
项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}

要求：
1. 先完整阅读 bug.md 和 assets/ 下的截图、视频。
2. 定位根因，做最小必要修改。
3. 修改后运行相关测试或构建。
4. 不要自行 git commit / push，完成后在终端说明改了哪些文件。
```

  4. 若就绪检测失败：回退为 `opencode run "<prompt>"` 非交互模式，并在 UI 标注「已降级」。
- **控制台窗口**：xterm.js 全屏终端；输出实时流式（按 16ms 合批），支持键盘输入直通 PTY、复制粘贴、`Ctrl+C` 中断、窗口缩放同步 cols/rows；滚动缓冲 10k 行，并落盘 `logs/agent/<task_id>.log`。
- **队列**：严格并发 1；状态机 `queued → starting → running → succeeded | failed | canceled`；「处理」时若已有任务，入队并提示位置；控制台顶部显示队列列表，可取消未开始任务、重试失败任务。
- **结束判定**：opencode 进程退出即结束（退出码 0 视为成功）；不解析 TUI 文本做语义判断。
- **任务记录**：`agent_tasks` 保存 md 路径、仓库、日志、耗时、退出码；任务详情可「再次运行」「打开目录」「复制命令」。
- **手动导入**：主界面「用 Agent 修复」可选择本地已有 `bug.md` 文件入队，便于离线 / 他人转来的缺陷。

### 7.6 MCP 服务

#### 传输与进程

- `tapd-mcp` 实现 MCP stdio（JSON-RPC 2.0）：`initialize`、`tools/list`、`tools/call`，返回 `serverInfo`、`capabilities.tools`。
- 启动时读 `runtime.json`（端口 + token + pid），健康检查 `/healthz`；无 App 则尝试拉起，失败转只读缓存。
- 所有工具调用经 `tapd-core::policy` 校验，再转发 App `/mcp/call`；App 执行并返回统一结构：

```json
{ "ok": true, "data": {}, "meta": { "stale": false, "truncated": false, "policy_applied": ["owner=me", "max_results=20"] } }
```

#### 工具清单（v1）

| 工具 | 说明 | 默认 |
|---|---|---|
| `tapd_whoami` | 当前登录用户、可选项目列表 | ✅ |
| `tapd_list_projects` | 项目列表（仅策略允许的） | ✅ |
| `tapd_list_bugs` | 缺陷查询：workspace_id、owner（me/nick/all）、status[]、priority[]、severity[]、keyword、iteration_id、created_after、modified_after、only_unresolved、page、limit | ✅ |
| `tapd_list_my_bugs` | 我的未解决缺陷（便捷封装） | ✅ |
| `tapd_get_bug` | 详情：描述 Markdown、附件元数据、评论、变更（受策略开关） | ✅ |
| `tapd_export_bug_md` | 导出 MD 包，返回绝对路径、资源数量、字节数 | ✅ |
| `tapd_list_comments` | 单独取评论（分页） | ✅ |
| `tapd_bug_stats` | 按状态/处理人聚合计数（v1.1 可选） | ⬜ |
| `tapd_add_comment` | 追加评论 | ❌ 预留 |
| `tapd_update_bug_status` | 改状态（白名单流转） | ❌ 预留 |
| `tapd_update_bug_owner` | 改处理人 | ❌ 预留 |

#### 能力边界（策略）

- 两层过滤：**第一层**是 AI 自己的查询参数；**第二层**是策略强制范围（AND 交集，永远收窄、不可扩大）。策略范围包括：
  - 允许的项目 ID 白名单；
  - 允许的工具白名单；
  - owner 范围（`me` / 指定成员 / `all`）；
  - 状态、优先级、严重程度白名单；
  - 最大时间跨度（如 90 天）、关键词排除；
  - 结果上限（默认 20，硬上限 100）、详情字节上限、导出资源上限。
- 客户档案：按 MCP `clientInfo.name` 匹配档案（`opencode` 等），默认档案兜底；便于将来给不同 AI 不同权限。
- 写能力：默认开启，可在 MCP 策略中关闭；支持「允许的项目」与「允许的目标状态」白名单，命中写操作时仍强制审计。
- 频率限制：令牌桶（默认 30 次/分钟、2 并发），超限返回结构化错误（尚未实现）。
- 审计：每次调用记录工具、参数摘要、决策（允许/拒绝/错误）、耗时、客户端、项目/缺陷；MCP tab 可筛选、导出、清空。

> 当前实现：写开关、项目白名单、状态白名单与审计已落地；工具白名单、owner 范围、时间跨度、按 `clientInfo.name` 的独立档案与限流仍在待办。

策略示例：

```json
{
  "enabled": true,
  "defaultProfile": "readonly",
  "profiles": {
    "readonly": {
      "workspaces": ["45336192"],
      "tools": ["tapd_whoami", "tapd_list_projects", "tapd_list_bugs",
                "tapd_list_my_bugs", "tapd_get_bug", "tapd_export_bug_md",
                "tapd_list_comments"],
      "scope": {
        "owners": ["me"],
        "statuses": ["新", "重新打开", "接受/处理"],
        "severities": ["致命", "严重", "一般"],
        "maxAgeDays": 90,
        "excludeKeywords": []
      },
      "limits": {
        "maxResults": 20,
        "maxDetailBytes": 200000,
        "maxExportAssetsMB": 50,
        "callsPerMinute": 30
      },
      "include": { "comments": true, "commentAttachments": true, "changes": false },
      "writes": { "enabled": false, "allowedTools": [], "allowedTransitions": [] }
    }
  },
  "clientProfiles": { "opencode": "readonly", "*": "readonly" }
}
```

#### 客户端配置

设置页「MCP」提供 opencode 配置片段与「复制」按钮：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "tapd": {
      "type": "local",
      "command": ["/Applications/TAPD Client.app/Contents/MacOS/tapd-mcp"],
      "enabled": true
    }
  }
}
```

同时给出 Claude Code / Codex 的等价配置说明（文本模板）。

### 7.7 设置中心

1. **账户与项目**：账户与会话是独立视图；项目独立成一个 tab，管理显示、本地文件夹与 Agent 规则。
2. **通知**：总开关、轮询间隔、只提示新分配 / 重新打开、免打扰时段、弹窗位置与数量、声音（可选）。
3. **MCP**：总开关、写开关、项目/状态白名单、审计日志、客户端配置复制（已落地）；工具勾选、二级过滤规则、限额、策略模拟器（输入一次查询 → 显示命中数量与命中规则）仍待办。
4. **导出**：根目录、模板选项（评论/变更/资源）、视频下载开关、单文件与总量上限、清理缓存。
5. **Agent**：opencode 路径（自动探测 + 手动选择）、版本显示、每项目仓库映射、prompt 模板、就绪检测参数、队列策略（固定并发 1）、日志目录。
6. **高级**：轮询/限速、桥接通道（A/B）、数据目录、打开日志、导出诊断包（已落地）、重置登录态。

---

## 8. 里程碑

| 阶段 | 内容 | 预估 | 验收标准 |
|---|---|---|---|
| **M0 技术验证** | 最小 Tauri 窗口登录 tapd.cn；抓当前用户/项目/缺陷/评论/附件接口；验证桥接通道 A/B；验证 opencode TUI 在 PTY 启动与注入；采样富文本 | 1–2 天 | `docs/spike.md` 完成；fixtures 可用于单测；桥接能稳定取到一页缺陷 |
| **M1 骨架与登录** | 工程初始化、窗口体系、配置/日志/运行时文件、登录窗口 → 隐藏桥、项目列表与记忆 | 1–2 天 | 重启后保持登录与上次项目；隐藏桥可取数据 |
| **M2 数据层与同步** | schema/migrations、mapper、同步引擎、增量轮询、我的/全部查询、限速与错误分类 | 2–3 天 | 列表抽样与网页一致；断网/限流状态可见；首轮不弹通知 |
| **M3 主界面** | 侧栏、表格、筛选、详情抽屉、顶部状态胶囊、空态 | 3–4 天 | 日常浏览闭环，不需要打开网页 |
| **M4 MD 导出** | HTML→MD、资源下载、评论/变更、模板、golden test | 1–2 天 | 含图片+视频+多评论的缺陷导出可读；资源路径全部可用 |
| **M5 MCP** | sidecar、stdio 协议、本地 HTTP、策略引擎、审计、自动拉起、客户端配置 | 2–3 天 | opencode 可列出我的未解决缺陷并导出 MD；越权调用被拒并留痕 |
| **M6 通知** | 判定、去重、忽略、免打扰、自绘胶囊卡片 | 1–2 天 | 模拟新分配 1 轮内展开卡片；三按钮行为正确；忽略不再弹 |
| **M7 Agent** | 仓库映射、PTY TUI、prompt 注入、队列、xterm 控制台、失败降级 | 3–4 天 | 点击处理 → 导出 → 排队 → 终端可见 → 完成/失败可重试；并发恒为 1 |
| **M8 打包收尾** | arm64 dmg、sidecar 打包、首启引导、README、诊断包 | 1–2 天 | 新机器安装可用；MCP 配置照抄即可用 |

合计约 15–22 人日（不含反复联调与 TAPD 改版应对）。

---

## 9. 测试策略

- **单元测试**：策略引擎（收窄、拒绝、默认值）、HTML→MD、MD 渲染 golden、同步 diff、队列状态机、mapper（使用 fixtures）。
- **集成测试**：axum 路由 + 临时 SQLite；MCP 二进制启动后跑 `initialize → tools/list → tools/call` 脚本；越权与限流用例。
- **Fake Agent**：`fixtures/fake-agent.sh` 模拟 TUI 输出与交互，保证 Agent 链路可离线测试（不依赖 opencode 版本）。
- **手工清单**：登录/失效、项目切换、限流恢复、通知三按钮、导出大视频、Agent 中断/重试、MCP 配置复制。
- 不做 macOS WebDriver E2E（成本高、稳定性差），以集成 + 手工清单覆盖。

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 网页内部接口未公开、可能改版 | 数据层失效 | M0 固化接口映射；集中适配层 + fixtures 回归；`schema_changed` 告警；接口清单支持配置热修 |
| 远程 webview IPC 权限受限 | 桥接不可用 | M0 同时验证通道 B（自定义 scheme）；桥接接口抽象，可切换 |
| 公司 SSO / 验证码 / 扫码登录 | 登录失败 | 登录窗口保持可见且可重载；不注入凭据；失败给出明确指引；登录态持久化减少频次 |
| 富文本结构复杂（表格/代码/视频） | MD 质量差 | 转换规则单测 + golden；未知标签降级为保留原 HTML 的 details 块；导出后预览确认 |
| TAPD 限流 / 风控 | 同步失败或封禁风险 | 低频轮询、令牌桶、指数退避、查询缓存、可暂停轮询 |
| opencode TUI 就绪检测不稳定 | prompt 注入失败 | 多重就绪信号 + 超时降级到 `run`；命令模板可配置；Fake agent 覆盖 |
| 队列并发误开 | 违反串行要求 | 数据库层唯一运行锁 + 互斥状态机 + 启动时清理孤儿任务 |
| App 未运行时 MCP 不可用 | agent 拿不到数据 | sidecar 自动拉起 + 等待健康检查；只读缓存兜底并标记 stale；可选开机自启 |
| 大视频/大附件拖垮导出 | 磁盘与耗时 | 默认只下载图片，视频可开关；单文件与总量上限；后台任务与进度提示 |
| 凭据泄露 | 安全 | 仅内存持有 cookie；不写日志；本地 API 仅 loopback + 每次启动轮换 token；诊断包脱敏 |

---

## 11. 验收标准（v1）

1. 首次运行：登录一次后重启无需再登录，自动进入上次项目。
2. 列表默认「我的缺陷」，可一键切「全部」；筛选条件与网页结果抽样一致。
3. 详情包含描述、评论、资源、变更；图片可直接预览。
4. 新分配给我的缺陷在一轮轮询内弹出自绘通知；处理/查看/忽略行为符合定义；首启不轰炸。
5. 导出 MD 包含 frontmatter、基本信息、描述、资源（图片内联）、评论（含评论附件），路径可被 agent 直接读取。
6. opencode 通过 MCP 能查询缺陷、读取详情、导出 MD；只读边界外的调用被拒绝并记录审计。
7. 点击「处理」后：导出 → 入队 → 打开 opencode TUI 并自动提交任务 → 客户端可实时查看/接管终端；第二个任务等待而非并行。
8. 关闭 App 后，AI 再次调用 MCP 能自动拉起 App 或返回明确 stale 缓存，不崩溃。

---

## 12. 后续版本（v2+）

- Windows 支持与平台适配层。
- Open API（PAT）适配器，用于无 GUI / CI 场景。
- 多 agent CLI（Claude Code、Codex）与并发队列。
- 写回 TAPD：修复完成后自动评论、流转状态（带白名单与审批）。
- 缺陷变更历史时间线与相似缺陷检索（FTS5 / 向量）。
- 团队共享策略模板。


---

## 13. 实施进度（2026-11-09）

### 已完成

| 里程碑 | 状态 | 说明 |
| --- | --- | --- |
| M0 技术验证 | ✅ | 登录、隐藏会话、同步/异步桥、接口抓包；结论见 `docs/spike.md` |
| M1 骨架与登录 | ✅ | Tauri 2 + React、配置/日志、本地 HTTP、runtime 握手 |
| M2 数据层 | ✅ | 模型、过滤器、响应解析、Tauri 命令；SQLite 离线快照缓存（项目/缺陷列表/详情）已接入 |
| M3 主界面 | ✅ | 项目切换、我的/全部、状态/优先级/严重度/关键词、分页、并排详情面板、离线优先渲染与骨架屏 |
| M4 MD 导出 | ✅ | `bug.md` + `assets/` + `bug.json`；带 Cookie 下载图片/视频/日志 |
| M5 MCP | ✅ | stdio sidecar、查询/导出 + 评论/状态写回共 9 个工具、opencode v2 联调通过；MCP tab 一键导入、策略（写/项目/状态）与审计 |
| M6 通知 | ✅ | 可配置范围（我的/项目、新建/转移/重新打开）、顶部胶囊卡片、忽略/查看、处理=改派+接受；「我的」跨项目增量轮询 |
| M7 Agent | ✅ | Agent tab（运行/审核/历史）、串行队列、server 事件完成/审核、胶囊状态、日志与 Terminal 恢复 |
| M8 打包 | ✅ | `tapd-mcp` 作为 externalBin 打进 App；`pnpm build:arm64` 本地出 arm64 dmg；`main` 合并进 `release` 后由 GitHub Actions 出 arm64 dmg 与 artifact，tag 额外发 Release。MCP 策略/审计 UI、首启引导、诊断包已补齐 |
| M9 自动更新 | ✅ | Tauri updater + GitHub Releases（`latest.json`）；启动后检查、之后每两小时轮询并持久化检查时间；标题栏更新图标 hover 展示日志；主窗口/账户页查看更新说明；更新时隐藏主窗口、胶囊 4 倍显示下载/解包进度；失败可手动下载或取消返回；`scripts/release.sh` 统一版本、日志、合并 `release` 与打 tag |

### 与计划的偏差

1. **异步桥改为结果桶轮询**：远程页面不允许调用应用 IPC 命令（`bridge_result not allowed`），`eval_with_callback` 又不 await Promise。最终用 `window.__TAPDCB_RESULTS__` + 120ms 原生 eval 轮询，稳定且不需要远程权限。
2. **SQLite 已接入**：`cache.sqlite3` 保存项目、缺陷列表快照与详情；UI 先读缓存再后台刷新，只有首次登录无缓存时显示骨架屏。通知轮询在「我的」范围下已跨项目增量执行，每个项目独立 cursor / baseline；「项目」范围保持单项目轮询，避免过量请求。
3. **MCP 写回已开放**：在查询/导出之外新增评论与状态更新（含自动先接受再流转）；删除/改处理人/批量操作仍未开放。客户端已提供策略档案（写开关、项目白名单、状态白名单）与调用审计（允许 / 拒绝 / 失败、耗时、客户端、项目/缺陷），审计不保存评论正文。
4. **opencode v2 配置结构**：使用 `mcp.servers.<name>`，而不是旧文档里的 `mcp.<name>`；已实测 `opencode mcp list` 显示 connected；MCP tab 可一键合并到全局配置并自动备份。
5. **通知采用自绘窗口 + SQLite 状态**：`cache.sqlite3` 的 `notification_*` 表保存设置、seen、ignored、cursor 与 baseline；首轮只建 baseline，避免历史缺陷轰炸。轮询分页拉取，未读完时保留 cursor；seen/ignored 按时间与条数裁剪。
6. **处理动作会写 TAPD**：点击「处理」自动改派给自己，并把 `new`/`open`/`reopened` 流转到 `in_progress`/`progressing`；成功后通过 `agent://enqueue` 交给 Agent。
7. **Agent 严格串行 + server 旁路**：单 worker；每个任务启动私有 `opencode serve`，TUI 通过 `--server` 连接，Rust 订阅 `/event` 判断 idle/权限请求；终端内嵌在 Agent tab，不再创建独立窗口。

### 已知待办

- 完整跨项目缓存同步与离线搜索（当前缓存是按查询的按需快照）。
- 「项目」范围的多项目轮询（当前保持单项目）与更细的游标策略。
- 签名 / 公证发布；MCP 调用限流与按 `clientInfo.name` 的独立策略档案。
- 多 Agent / 并发队列（当前固定并发 1，属刻意设计约束）；进程树彻底回收（已按进程组 kill）。
- 明确不做：通知历史视图、托盘角标 / 未读计数（TAPD 无缺陷已读状态）、独立 Agent 常驻面板（Agent 已在 tab 内）。
