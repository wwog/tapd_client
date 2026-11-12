# 架构说明

> 面向维护者：系统由哪些部分组成、一次请求怎么流动、为什么这样取舍。
> 产品介绍见 [README](../README.md)，构建与本地数据见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 1. 总览

TAPD Client 是一个 Tauri 2 桌面应用：

- **前端**：React + TypeScript + Vite，主窗口与通知胶囊两个入口。
- **后端**：Rust，负责窗口、命令、会话桥、缓存、轮询、Agent 与本地 HTTP。
- **`tapd-core`**：与 Tauri 无关的模型、过滤器、响应解析、Markdown 导出与配置存储。
- **`tapd-mcp`**：stdio MCP sidecar，随 App 打包，供外部 AI 客户端调用。

```
┌──────────────────────────── TAPD Client.app ────────────────────────────┐
│                                                                         │
│   React UI                         Rust Core                            │
│   主窗口 / 通知胶囊  ◄── IPC ──►   命令、状态、事件                     │
│         │                              │                                │
│         │                    ┌─────────┴──────────┐                     │
│         │                    ▼                    ▼                     │
│         │            Web Session Bridge     Local HTTP (axum)          │
│         │            隐藏 WKWebView          127.0.0.1 + token         │
│         │                    │                    ▲                     │
│         │                    ▼                    │                     │
│         │              www.tapd.cn          MCP sidecar                 │
│         │                                   (tapd-mcp, stdio)           │
│         │                                        ▲                     │
│         └── cache.sqlite3 ◄── 缓存 / 轮询         │                     │
│                                       外部 AI 客户端（opencode 等）     │
│                                                                         │
│   Agent Queue ── 通用 TUI（PTY）── 终端接管 / MCP 回报                │
└─────────────────────────────────────────────────────────────────────────┘
```

## 2. 进程与边界

| 部分 | 生命周期 | 职责 |
| --- | --- | --- |
| 主窗口 | 随 App | 项目、缺陷列表、详情、Agent、MCP、设置 |
| 隐藏 WebView | 随 App | 持有 tapd.cn 登录态；执行注入脚本抓取网页内部接口 |
| 通知胶囊 | 随 App | 自绘通知与更新进度，可拖动 |
| 本地 HTTP | 随 App | 仅监听 `127.0.0.1`，随机端口，每次启动轮换 token |
| `tapd-mcp` | 由 AI 客户端启动 | stdio MCP，反向调用本地 HTTP |
| Agent TUI | 每个任务 | 在 PTY 中运行，输出进内嵌终端，完成由 MCP 回报 |

登录页不是独立窗口：主窗口直接镜像隐藏 WebView 里的企业微信二维码，扫码完成后隐藏 WebView 保留会话。

## 3. 关键链路

### 3.1 登录与会话

1. `LoginGate` 显示二维码；`session.rs` 轮询扫码状态。
2. 扫码确认后隐藏 WebView 继续持有 Cookie，主窗口进入业务视图。
3. 会话失效时自动回到扫码页。
4. 退出登录逐条删除 TAPD Cookie 并清空 WebView 数据，避免旧页面加载后自动登回。

### 3.2 缺陷读取与离线缓存

```
React → Tauri command → feature_router → session bridge（隐藏 WebView 内注入 JS）
      → tapd-core 解析 / 过滤 → cache.sqlite3 → 前端渲染
```

- 项目、缺陷列表、详情都先读 SQLite 快照，再后台刷新。
- 缺陷列表每 30 秒静默自动刷新一次（不显示骨架屏 / 不闪「更新中」）；窗口不可见时暂停，恢复可见且快照过期时立即补一次。通知轮询是独立循环，不再承担列表刷新。
- 只有首次登录且无缓存时才显示骨架屏。
- 缓存是**按查询的按需快照**，不是完整的后台同步引擎。通知条目按会话清空，`seen` 有行数/时间上限，数据库不会随使用无限增长。
- `snapshots` 存列表类快照，`bugs` 存缺陷行，`agent_tasks` 只存任务 JSON（`payload`）与更新时间，`notification_*` 存通知设置、条目、去重与轮询游标。

### 3.3 新缺陷通知

1. `notification.rs` 按配置轮询（范围：我的 / 当前项目）。
2. 「我的」范围跨项目轮询，每个项目独立 cursor，并与 seen 去重游标统一；cursor 缺失即视为首轮 baseline。每次启动或重新登录后，每个项目的**第一轮只记录状态、不通知**，之后才按差异提示。每轮分页拉取（单页 200，增量最多 10 页，baseline 最多 25 页，页间短暂节流）；达到上限仍未读完时保留旧 cursor，避免越过未读窗口。
3. 通知状态持久化到 `cache.sqlite3` 的 `notification_*` 表，轮询只增量 upsert 变化的行；seen 按最后观察时间保留 90 天且最多 20000 条，ignored 随 seen 一起裁剪；模拟通知不会跨重启保留。
4. 检测到新建、转移、重新打开后写入通知状态，胶囊展开自绘卡片。转移按 `assigned_time` 与上次观察值比较，因此「我的」范围转出再转回也能识别，且每次改派只提示一次。客户端自己认领（列表 / 详情「认领」、通知卡「处理」自动改派）产生的处理人变更不通知：写入成功后登记到 `self_claims`，下一轮轮询只更新 seen、不发卡片。
5. 「处理」自动改派给自己并把起始状态流转到处理中，成功后进入 Agent 队列。
6. `bug_list` 返回后把当前页写入 seen：列表在前台且主窗口有焦点时，刷新（手动 / 30 秒自动 / 翻页 / 筛选）等同于一次静默轮询，屏幕上已经看到的缺陷不会再补发通知；窗口失焦（用户在其他应用）时自动刷新不观察，避免误吞通知。不创建卡片，也不推进轮询 cursor。

### 3.4 修复队列与 Agent

1. 从缺陷生成 Markdown 包（`bug.md` + `assets/` + `bug.json`）。
2. 队列固定并发 1，所有运行时都在 PTY 中启动自己的 TUI。
3. 完成由 MCP `agent_task_report`、进程退出或输出静默判定；任务结束自动回收进程并继续队列。
4. 权限确认在右侧内嵌终端里完成，桌面不代为回执。
5. 复杂改动：prompt 要求调用 `tapd_request_review`，任务进入 `awaiting_approval` 并中止本轮；工作区保留 diff，队列停住。未调用时，本轮结束若出现新的未提交文件也会自动进入待审核。
6. 待审核页「通过并提交」→ 回到 `queued`，用提交专用 prompt 重新执行；「停止并储藏」→ 按审核文件列表 `git stash`、任务取消并持久化 `queue_paused`，用户可手动继续队列。
7. 客户端在 MCP 层拒绝未提交时的 TAPD 写操作，保证 commit 先于评论/状态更新。
8. 输出不落盘，实时渲染到右侧内嵌终端；任务结束后可在历史里用系统终端续接该会话。

### 3.5 MCP 调用

```
AI 客户端 → tapd-mcp (stdio) → POST /mcp/call → mcp.rs
          → 策略检查（写操作 / 项目白名单 / 状态白名单）
          → 会话桥读取或写回 TAPD → mcp_audit.rs 记录
```

- 工具共 16 个：whoami、项目、查询、我的缺陷、详情、导出、修复提示词、状态查询、评论、状态更新、外部占用登记、外部占用释放、唤起胶囊通知、等待通知回执、Agent 改动审核、Agent 任务回报。
- 除显式 `workspace_id` 外，工具还接受 `root`（本地仓库目录）：按项目设置里的「本地文件夹」匹配项目，sidecar 默认注入自身 cwd 作为软提示。
- 外部占用存在 `AgentCore.external`（内存 + `snapshots` 表持久化，15 分钟无心跳失效）；本地排队任务让位，运行中的任务拒绝外部，列表行只保留「查看任务」（本地任务）与图标化的「取消」。
- 写操作可整体关闭；审计只记录工具、客户端、结果、耗时与项目 / 缺陷 / 目录，不保存评论正文和 Cookie。
- 「接入 AI 客户端」把 sidecar 路径幂等写入 opencode / ZCode / Claude Code / Cursor / Codex 的用户级配置，并自动备份。

### 3.6 AI / MCP 胶囊通知

```
MCP tapd_notify_user → notification::raise_ai → 内存 ai_items → 胶囊卡片
                     ← 用户点击 / 关闭 ─ finish_ai ← 等待中的工具调用
```

- AI 通知是通用的扩展卡片：`tone` + `title` + 内容块（`text` / `code` / `fields` / `progress` / `divider`）+ 动作按钮；前端按块类型渲染，新增块类型只需扩展 schema 与渲染分支。
- 通知只存在内存（最多 20 条，重启清空），不进入 `notification_*` 表；缺陷通知仍按原逻辑持久化。
- `tapd_notify_user` 默认等待 30 秒（上限 120）后回传 `acted` / `dismissed` / `timeout` 等结果；`waitSeconds=0` 可先返回，再用 `tapd_wait_notification` 继续等待。相同 `tag` 替换旧卡片。
- 设置页可关闭「允许 AI / MCP 唤起通知」，并提供调试面板验证配色、内容块与动作回执。

## 4. 已实现能力

### 窗口与交互

- 隐藏 WebView 持有 tapd.cn 会话；登录页把企业微信二维码原样镜像进主窗口，不弹出独立登录窗口。会话失效自动回到扫码页；退出登录逐条删除 TAPD Cookie 并清空 WebView 数据。
- 项目切换（默认上次项目）、我的 / 全部缺陷、状态 / 优先级 / 严重程度 / 关键词筛选、分页。状态筛选按项目工作流配置的顺序展示（取自列表响应的 `workspace_configs.workflow_infos.bug.status_map` 键顺序）；表头支持按状态 / 创建时间排序（点击循环「升序 → 降序 → 取消」，取消后回到 TAPD 默认排序），排序交给 TAPD 服务端以保证跨页顺序正确。
- 项目 tab：独立管理项目显示、本地文件夹与 Agent 规则；文件夹支持拖入，改动自动保存。
- 缺陷表格：各列有最小宽度，窗口变窄时横向滚动；「操作」列固定在右侧（查看详情 / 在 TAPD 打开 / 复制链接 / Agent 修复）；处理人不是自己的缺陷只显示「认领」。顶部范围切换为「我负责的 / 全部」，本项目存在内部 Agent 任务或外部 AI 占用时追加「处理中」：只列出这些缺陷（详情缓存优先 + 实时详情补齐），关键词、筛选与排序在本地应用。
- 主窗口外壳：无系统标题栏（macOS Overlay），左侧图标栏 + 可拖拽项目栏 + 浮起的白色内容面板；项目栏拖到最小宽度以下或窗口过窄时自动收起；右键可本地隐藏项目，只剩一个项目时自动隐藏整个项目栏。
- 缺陷详情右侧面板：Codex 风格的第三列，从右侧滑入并与内容区并排，左缘可拖动调宽；窗口过窄时先收起项目列表，仍不够再向左扩张。打开详情只刷新这一条缺陷，不触发列表刷新；面板打开期间列表中对应的行保持高亮（面板与列表不同项目或该缺陷不在当前页时不显示）。内容含基本信息、描述、资源、变更记录、评论、自定义字段。顶部的缺陷 ID 可点击复制（就地显示对勾）。处理人 / 开发人员用项目成员下拉直接修改，底部可发表纯文本评论并按工作流流转状态；评论不受认领限制，处理人不是自己时列表操作列与面板底部只显示「认领」，认领后才开放改人与状态流转。成员目录缓存两小时，与自动更新检查同频。
- 资源查看：资源行有独立「预览」按钮（缩放 / 左右切换 / 缩略图条 / Esc 关闭，支持图片与视频），「打开」按默认应用打开，下拉只负责切换默认应用。
- 顶部状态胶囊：常驻展示通知状态；Agent 运行时切换为「Agent 运行中」，等待改动审核时变为「Agent 待审核」。可拖动并记住位置，单击展开通知 / 打开 Agent 任务，双击打开主窗口。悬停胶囊时向下展开摘要卡（项目、缺陷 ID、标题与状态），窗口尺寸由 Rust 侧 `set_peek` 调整，展开的通知卡片优先。胶囊窗口不取 key window（`island_window/macos.rs` 从窗口自身类派生一个 `canBecomeKeyWindow = NO` 的子类并换类，点击 / 拖动都不会抢走主窗口焦点，首次点击由 `accept_first_mouse` 送达），悬停也由那里的 `NSTrackingArea` 原生监听后推 `island://hover`，因为 WebKit 与 tao 默认的 tracking rect 都只给 key window 报悬停。
- 请求历史：设置底部「接口历史」自动记录网页内部接口，支持查看与导出 JSON。
- MD 导出：`bug.md` + `assets/` + `bug.json`，含 frontmatter、描述、资源、变更记录、评论；视频 / 图片 / 日志按需下载。
- 账户与会话：从设置中拆成独立视图，入口是项目栏底部的用户按钮；项目栏收起时头像缓动到左侧图标栏。

### 数据与通知

- 离线优先：项目列表、缺陷列表与详情先渲染 SQLite 缓存，再后台刷新；只有首次登录且无缓存时显示骨架屏。刷新期间标题栏居中显示「更新中」。
- 新缺陷通知：顶部胶囊展开自绘卡片（处理 / 查看 / 忽略），支持范围（我的 / 项目）、类型（新建 / 转移 / 重新打开）、轮询、免打扰、模拟通知。「我的」范围跨项目增量轮询，每个项目独立 cursor；启动/登录后的第一轮只建 baseline 不通知，旧卡片在会话开始时清空。
- AI / MCP 通知：外部 AI 通过 `tapd_notify_user` 唤起通用卡片（tone + 内容块 + 动作），用户点击后把动作回执给同一工具调用；设置里可开关与调试。
- 处理动作：自动改派给自己，并把起始状态流转到处理中（`in_progress` / `progressing`），成功后进入 Agent 队列。

### Agent

- Agent tab：子页为运行 / 待审核 / 历史；运行栏只显示排队 / 准备 / 运行 / 权限审核任务，待审核显示复杂改动，结束或取消的任务进入历史；右侧内嵌 xterm 实时渲染 TUI，可直接键盘接管。
- Agent 改动审核：待审核卡片展示摘要、文件与风险，通过后重新入队提交，停止则按文件 `git stash` 并暂停队列；主窗口标题栏与顶部胶囊都会提示待审核数量。
- Agent 运行时：所有运行时都在 PTY 中启动各自的 CLI（不再有 ACP / opencode 私有 server），提示词按 argv / flag / stdin 投递，完成由 MCP `agent_task_report`、进程退出或输出静默判定。任务 JSON 同步写入 `agent_tasks.payload`。
- 终端输出：后端按显示帧节拍（16ms，单次上限 32KB）合批推送，**不能**用「输出静默 N ms 才发」——TUI 的 spinner 每 ~17ms 重绘一次，静默判断永远不触发，会把几秒的输出攒在内存里，表现为输入无回显；前端 xterm 走 WebGL 渲染器（DOM 渲染器跟不上 60fps 全屏重绘），无上下文时自动回退。
- 不保留 Agent 日志：PTY 输出不落盘，面板中途打开时用一次 PTY 尺寸抖动让 TUI 整屏重绘。任务结束后在「历史」点「打开系统终端」，用运行时声明的 resume 参数（opencode/claude `--continue`、codex `resume`）在 Terminal.app 里续接同一会话；旧版本遗留的 `agent-logs/` 在启动时删除。
- 项目级配置：每个项目的本地文件夹与「项目规则」写在自己的项目卡片里；Agent 区只放 agent 参数，默认提示词模板自带 `{{project_rule}}` 段落；未配置目录时点 Agent 修复会先要求选择目录。

### MCP 与运维

- MCP tab：16 个工具（whoami / 项目 / 查询 / 我的缺陷 / 详情 / 导出 / 修复提示词 / 状态查询 / 评论 / 状态更新 / 外部占用登记 / 外部占用释放 / 胶囊通知 / 等待回执 / Agent 审核 / 任务回报）；「接入 AI 客户端」按客户端一行，一键写入 opencode / ZCode / Claude Code / Cursor 的用户级配置（自动备份、幂等）；Codex 的一键导入入口暂时隐藏（后端 spec 保留，启动 Codex Agent 时仍会幂等注入）。启动受支持的 Agent 运行时也会幂等确保注入。
- MCP 策略与审计：可关闭写操作、限制可访问项目、限制目标状态白名单；每次调用记录工具、客户端、允许 / 拒绝 / 失败、耗时与项目 / 缺陷（不保存评论正文和 Cookie），支持筛选、导出与清空。
- 首启引导：首次登录后展示三步引导（登录与离线缓存 / MCP 与 Agent / 通知与胶囊），可跳过，完成状态写入 `config.json`。
- 自动更新：启动时立即检查 GitHub Releases，之后每两小时查询一次并记录检查时间；标题栏更新图标在有新版本时变绿，hover 展示更新日志。更新期间主窗口隐藏，胶囊放大 3 倍显示下载 / 解包安装进度；失败时可手动下载或取消。发布说明带 `<!-- force-update -->` 标记时为强制更新：要求写入 `config.json` 的 `forcedUpdate`，登录页与主界面都显示不可关闭的升级模态框，直到当前版本不低于目标版本。
- 诊断包：设置 → 运行信息一键导出脱敏 zip，包含版本与系统信息、脱敏配置、通知设置、Agent 摘要、MCP 审计和最近日志；不包含 Cookie、本地 API token、请求 / 响应正文。
- 清理缓存：设置 → 本地数据一键删除应用数据目录下的全部内容，随后自动重启；删除在下次启动时、日志与 SQLite 打开前执行，目录来自 `AppPaths`；导出目录不受影响。
- 本地回环 API：随机端口 + 每次启动轮换 token，`runtime.json` 0600。

## 5. 模块地图

```
apps/desktop/
  src/
    App.tsx                  主窗口路由与整体布局
    components/              LoginGate、列表、详情、Agent、MCP、设置、引导、胶囊视图
    lib/                     前端 API、缓存、通知、Agent、MCP、更新封装
    windows/IslandWindow.tsx 通知胶囊窗口
  src-tauri/src/
    session.rs               隐藏 WebView、同步 / 异步桥、Cookie
    inject.js                抓包与 __TAPDCB__ 请求助手
    commands.rs              Tauri 命令（会话、缺陷、MCP 配置、媒体打开方式）
    feature_router.rs        通知 / Agent / 同事 / 缓存 / MCP 的统一命令路由
    cache.rs                 SQLite 离线快照缓存
    notification.rs          轮询、分类、通知窗口调度、接受动作
    island_window.rs         胶囊窗口创建、定位、拖动持久化与尺寸动画
    notification_db.rs       通知状态 SQLite 持久化（设置 / 条目 / 去重 / 游标）
    agent.rs                 Agent 队列、运行时目录、PTY、任务持久化
    coworker.rs              同事包注册表、技能 frontmatter 与提示词注入
    mcp.rs                   MCP 工具调度、策略强制与审计记录
    mcp_audit.rs             有界 MCP 调用审计（SQLite `mcp_audit` 表，脱敏摘要）
    mcp_import.rs            各 AI 客户端配置一键注入
    export.rs                MD 导出与资源下载
    diagnostics.rs           脱敏诊断包
    server.rs                本地 HTTP（/healthz、/mcp/call、调试端点）
    update.rs                GitHub Releases 检查与更新状态
    reset.rs / open_with.rs  本地数据清理 / 按默认应用打开资源
crates/tapd-core/            模型、过滤器、响应解析、Markdown、配置与存储
crates/tapd-mcp/             MCP stdio sidecar
docs/                        架构、开发、计划、接口、通知、Agent、MCP、发版
fixtures/                    假 agent 等测试辅助
scripts/                     图标、sidecar、发版等构建工具
```

## 6. 设计取舍

- **复用网页会话，不走 Open API**：保持与公司账号 / SSO 一致，代价是依赖未公开的内部接口，改版时需要更新 `tapd-core` 适配层。
- **缓存是快照**：优先保证打开即见，不做全量后台同步与离线搜索。
- **Agent 并发固定 1**：同一时间只有一个任务占用仓库，避免互相踩踏。
- **通知自绘**：不使用系统通知，才能承载处理 / 查看 / 忽略三个动作与更新进度。
- **写操作收窄**：MCP 只开放评论与状态更新，不提供删除、改处理人、批量操作。
- **本地 API 最小暴露**：随机端口 + 每次启动轮换 token，`runtime.json` 权限 0600。
- **不做未读与托盘角标**：TAPD 没有提供缺陷通知的已读状态，客户端不自行发明计数。

## 7. 当前限制

- 仅 macOS（发布物为 Apple Silicon arm64）。
- 通知的「项目」范围仍只轮询当前项目；「我的」范围已跨项目轮询。
- `assigned_time` 缺失时“转移”判定偏保守。
- Agent 就绪检测与完成判定是启发式的；取消按进程组回收，仍可能有极端情况下的孙进程残留。
- 发布包默认未签名、未公证；首次打开需在「系统设置 → 隐私与安全性」中允许。
- TAPD 网页内部接口未公开，改版时需要更新适配层。

## 8. 下一步

1. 完整的跨项目缓存同步与离线搜索。
2. 如确有需要，再扩展「项目」范围的多项目轮询与更细的游标策略。
3. 签名 / 公证发布，以及 MCP 调用限流与按 `clientInfo.name` 的独立策略档案。
4. 多 Agent / 并发队列（当前固定并发 1，是刻意约束）。

更完整的阶段计划与验收记录见 [PLAN.md](PLAN.md)，接口验证见 [spike.md](spike.md)。
