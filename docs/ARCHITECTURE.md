# 架构说明

> 面向维护者：系统由哪些部分组成、一次请求怎么流动、为什么这样取舍。
> 产品介绍见 [README](../README.md)，构建与本地数据见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 1. 总览

TAPD Client 是一个 Tauri 2 桌面应用：

- **前端**：React + TypeScript + Vite，主窗口与通知胶囊两个入口。
- **后端**：Rust，负责窗口、命令、会话桥、缓存、轮询、内置 Agent 宿主与本地 HTTP。
- **`tapd-core`**：与 Tauri 无关的模型、过滤器、响应解析、媒体收集与配置存储。
- **`tapd-workspace`**：任务工作区的 git 事实（变更文件、增删行数、diff、HEAD）。单任务的主仓库与 Worktree 任务共用同一实现；worktree 目录被清理后按分支重算。
- **`tapd-local`**：纯领域类型，本地项目与事项（`WorkItem`）的校验和状态迁移；不做文件、时钟或数据库 IO。
- **`tapd-mcp`**：stdio MCP sidecar，随 App 打包，供 MCP 客户端调用。
- **`dsh-host`**：与 Tauri 无关的内置 Agent 宿主库：SDK RPC 信封、桥协议、profile 渲染、transcript 归一化、payload 清单与 Node 版本门槛。

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
│                                       MCP 客户端（opencode 等）         │
│                                                                         │
│   内置 Agent Host ── dsh 运行时（~19 MB zstd payload + 系统 Node）      │
│                      SDK RPC / 桥插件 / 胶囊                            │
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
| dsh 运行时 | 随 App（单进程多会话） | 内置 Agent，stdio JSON-RPC 控制面 + 桥插件流式面；首次启动把 `resources/dsh/payload-*.tar.zst` 解到 `<数据目录>/dsh/<version>` |

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
- `snapshots` 存列表类快照，`bugs` 存缺陷行，`notification_*` 存通知设置、条目、去重与轮询游标。

### 3.3 新缺陷通知

1. `notification.rs` 按配置轮询（范围：我的 / 当前项目）。
2. 「我的」范围跨项目轮询，每个项目独立 cursor，并与 seen 去重游标统一；cursor 缺失即视为首轮 baseline。每次启动或重新登录后，每个项目的**第一轮只记录状态、不通知**，之后才按差异提示。每轮分页拉取（单页 200，增量最多 10 页，baseline 最多 25 页，页间短暂节流）；达到上限仍未读完时保留旧 cursor，避免越过未读窗口。
3. 通知状态持久化到 `cache.sqlite3` 的 `notification_*` 表，轮询只增量 upsert 变化的行；seen 按最后观察时间保留 90 天且最多 20000 条，ignored 随 seen 一起裁剪；模拟通知不会跨重启保留。
4. 检测到新建、转移、重新打开后写入通知状态，胶囊展开自绘卡片。转移按 `assigned_time` 与上次观察值比较，因此「我的」范围转出再转回也能识别，且每次改派只提示一次。客户端自己认领（列表 / 详情「认领」、通知卡「处理」自动改派）产生的处理人变更不通知：写入成功后登记到 `self_claims`，下一轮轮询只更新 seen、不发卡片。
5. 「处理」自动改派给自己并把起始状态流转到处理中。
6. `bug_list` 返回后把当前页写入 seen：列表在前台且主窗口有焦点时，刷新（手动 / 30 秒自动 / 翻页 / 筛选）等同于一次静默轮询，屏幕上已经看到的缺陷不会再补发通知；窗口失焦（用户在其他应用）时自动刷新不观察，避免误吞通知。不创建卡片，也不推进轮询 cursor。

### 3.4 内置 Agent

外置 CLI 执行层（PTY、TUI 适配、会话 hook、transcript 解析、`tapd-workflow` 状态机与队列）已整体移除；
Agent 只跑 App 内置的 DeepSeek Harness 运行时。契约与调研结论见 [DSH.md](DSH.md)。

- **宿主库 `crates/dsh-host`**：SDK RPC 信封、桥协议、profile 渲染、transcript 归一化
  （`rpc` / `protocol` / `profile` / `transcript`），纯逻辑、可单测；payload 清单与 Node 版本门槛也在这里。
- **`src-tauri/src/dsh/`**：`payload`（发现 / 校验 / 原子解压）、`runtime`（进程与状态机）、
  `bridge`（回环 NDJSON + 逐帧 token）、`policy`（权限模式）、`tasks` + `task_store`（统一任务与 SQLite）、
  `team`（团队任务板）、`worktree`、`writeback`。
- **分发形态**：安装包只带 ~19 MB 的 zstd payload（`resources/dsh/payload-*.tar.zst` + `manifest.json`，
  解压后 ~233 MB / 2.5 万文件），首次启动按版本解到 `<数据目录>/dsh/<version>`；Node 由系统提供（≥ 24.9），
  不打包 Node 二进制。
- **能力接入**：自有 Cordis 插件 `dsh/plugins/{tapd-tools,tapd-bridge,tapd-policy}` 随 App 打包，profile 以
  绝对路径挂载；TAPD 工具走本机 HTTP，不走 MCP；MCP sidecar 只服务外部客户端。
- **会话、任务与审批**：控制面走官方 SDK JSON-RPC；token 级流式与任务板由桥插件推送；审批 / 提问进通知胶囊，
  手机也能回答。任务元数据持久化在 `cache.sqlite3` 的 `dsh_tasks`（当前 schema 12，见 `src-tauri/src/cache/migrate.rs`），transcript 仍由 dsh 自己保存。

### 3.5 MCP 调用

```
AI 客户端 → tapd-mcp (stdio) → POST /mcp/call → mcp.rs
          → 策略检查（写操作 / 项目白名单 / 状态白名单）
          → 会话桥读取或写回 TAPD → mcp_audit.rs 记录
```

- 工具共 10 个：whoami、项目列表、缺陷查询、我的缺陷、详情导出（含修复提示词）、状态查询、评论、状态更新、唤起胶囊通知、等待通知回执。
- 除显式 `workspace_id` 外，工具还接受 `root`（本地仓库目录）：按项目设置里的「本地文件夹」匹配项目，sidecar 默认注入自身 cwd 作为软提示。
- `tapd_get_bug` 是详情与提示词的唯一入口：导出目录只有 `bug.json` + `assets/`，返回值含 `skills`（name→SkillRef）、`projectRule`、`prompt` 与下载统计。工具集只覆盖查询、导出、评论、状态更新与通知。
- 写操作可整体关闭；审计只记录工具、客户端、结果、耗时与项目 / 缺陷 / 目录，不保存评论正文和 Cookie。
- 「接入 AI 客户端」把 sidecar 路径幂等写入 opencode / ZCode / Claude Code / Cursor / Codex / OMP / Kimi Code / Gemini CLI / Qwen Code 的用户级配置，并自动备份。

### 3.6 AI / MCP 胶囊通知

```
MCP tapd_notify_user → notification::raise_ai → 内存 ai_items → 胶囊卡片
                     ← 用户点击 / 关闭 ─ finish_ai ← 等待中的工具调用
```

- AI 通知是通用的扩展卡片：`tone` + `title` + 内容块（`text` / `code` / `fields` / `progress` / `divider`）+ 动作按钮；前端按块类型渲染，新增块类型只需扩展 schema 与渲染分支。
- 通知只存在内存（最多 20 条，重启清空），不进入 `notification_*` 表；缺陷通知仍按原逻辑持久化。
- `tapd_notify_user` 默认等待 30 秒（上限 120）后回传 `acted` / `dismissed` / `timeout` 等结果；`waitSeconds=0` 可先返回，再用 `tapd_wait_notification` 继续等待。相同 `tag` 替换旧卡片。
- 设置页可关闭「允许 AI / MCP 唤起通知」，并提供调试面板验证配色、内容块与动作回执。

### 3.7 工作区布局与文件浏览

```
LayoutState（fraction 分割树）→ SplitView（实测像素）→ GroupView（标签组）
                                                        └─ PanelHost（单一稳定层 + portal）
```

- 主内容、右侧详情、底部终端是同一种「组」：分割树只描述空间，组只持有标签，面板内容由注册表按 kind 渲染。完整命名、不变量与拖拽协议见 [WORKBENCH.md](WORKBENCH.md)。
- 每个面板只挂载一次：`PanelHost` 为每个面板建一个独立容器并 `createPortal`，标签在组间移动时只把该容器 `appendChild` 到新的组 body，React 不重挂载，终端回放、滚动与详情状态都保留。非激活标签 `invisible + inert`，xterm 仍保有真实尺寸。
- 尺寸以 fraction 持久化到 `uiPrefs["workbench.layout.v1"]`；空的标准停靠组保留自己的比例，重新打开时恢复原大小，非 role 空组由 `normalize` 回收。分割条统一 1.5px 视觉 / 8px 命中区，交叉点由实测矩形求交后同时调整两个 split。
- 文件能力：`../WORKBENCH.md` §8 的 `fs_list` / `fs_read` / `fs_stat` / `fs_write` 以项目 `repoPath` 为根，拒绝绝对路径、`..`、`.git`、NUL 与符号链接逃逸；写入只覆盖已存在的文本文件（2 MiB、临时文件 + rename、mtime 冲突），桌面用 Monaco 编辑，手机编辑由 `companion.allowFileWrite` 控制（默认关）。二进制预览走本机 `/file` 与伴侣 `/companion/api/file/raw` 流式路由。

### 3.8 本地项目与事项

```
React / 手机 → feature_command `local_*` → src/local（校验 / SQLite）
                                      → tapd-local（领域类型 / 状态迁移）
                                      → 内置 Agent 任务（kind = local_item）
```

- 本地项目只是一个本机目录，没有 TAPD workspace；事项（`WorkItem`）有 `pending` / `in_progress` / `done` 三个状态。关联 Agent 任务成功时由宿主自动置为 `done`，也可手动标记完成 / 重新打开。
- 每个本地项目有独立的 `rule`（项目规则），创建 / 编辑时写入；交给 Agent 时随 `quest.json` 导出并追加到本地修复、提交与合并提示词，TAPD 任务不受影响。
- 数据写 `<数据目录>/local.sqlite3`（`local_projects` / `local_work_items`，schema v3：v2 增加 `rule`，v3 增加 `importance`），与 `cache.sqlite3` 分开：TAPD 退出登录、清缓存和 `Cache::clear()` 都不会删除自己的项目；「清理缓存」显式保留该文件及 WAL 旁文件。
- 桌面在项目侧栏右键 / 项目页创建，移动端可浏览桌面目录后创建；文件浏览与终端共用同一目录解析：TAPD 项目配置优先，其次本地项目仓库。移动端文件 / 终端只列出有文件夹的 TAPD 项目，并加入本地项目。
- 事项交给 Agent 时以 `kind = local_item` 进入统一任务列表（DSH.md §9），准备阶段导出 `quest.json` 而不是 `bug.json`，不注入 TAPD 工具，也不回写 TAPD；任务成功由宿主把事项置为 `done`。
- 移动端文件页额外提供 `__root__` 源，从 `/` 只读浏览；写接口对根目录直接 403。项目目录选择仍限制 `$HOME` 或已配置的本地仓库；伴侣目录浏览在列目录前先校验允许根。

## 4. 已实现能力

### 窗口与交互

- 隐藏 WebView 持有 tapd.cn 会话；登录页把企业微信二维码原样镜像进主窗口，不弹出独立登录窗口。会话失效自动回到扫码页；退出登录逐条删除 TAPD Cookie 并清空 WebView 数据。
- 项目切换（默认上次项目）、我的 / 全部缺陷、状态 / 优先级 / 严重程度 / 关键词筛选、分页。状态筛选按项目工作流配置的顺序展示（取自列表响应的 `workspace_configs.workflow_infos.bug.status_map` 键顺序）；表头支持按状态 / 创建时间排序（点击循环「升序 → 降序 → 取消」，取消后回到 TAPD 默认排序），排序交给 TAPD 服务端以保证跨页顺序正确。
- 项目 tab：独立管理项目显示、本地文件夹与 Agent 规则；文件夹支持拖入，改动自动保存。
- 缺陷表格：各列有最小宽度，窗口变窄时横向滚动；「操作」列固定在右侧（认领）；处理人不是自己的缺陷只显示「认领」。顶部范围切换为「我负责的 / 全部」。
- 主窗口外壳：无系统标题栏（macOS Overlay），左侧图标栏 + 可拖拽项目栏 + 浮起的白色内容面板；项目栏拖到最小宽度以下或窗口过窄时自动收起，标签栏左侧的按钮可随时展开 / 收起；右键可本地隐藏项目（至少保留一个）。
- 工作区：主内容 / 右侧 / 底部统一为可拖动标签组；标签可跨组移动或在组边缘四向分裂，分割条与交叉点统一，布局持久化。入口见 [WORKBENCH.md](WORKBENCH.md)。
- 缺陷详情右侧面板：打开后落在右侧副组的标签中，与内容区并排，左缘可拖动调宽（也可把标签拖到其他组或分屏）；窗口过窄时先收起项目列表，仍不够再向左扩张。打开详情只刷新这一条缺陷，不触发列表刷新；面板打开期间列表中对应的行保持高亮（面板与列表不同项目或该缺陷不在当前页时不显示）。内容含基本信息、描述、资源、变更记录、评论、自定义字段。顶部的缺陷 ID 可点击复制（就地显示对勾）。处理人 / 开发人员用项目成员下拉直接修改，底部可发表纯文本评论并按工作流流转状态；评论不受认领限制，处理人不是自己时列表操作列与面板底部只显示「认领」，认领后才开放改人与状态流转。成员目录缓存两小时。
- 资源查看：资源行有独立「预览」按钮（缩放 / 左右切换 / 缩略图条 / Esc 关闭，支持图片与视频），「打开」按默认应用打开，下拉只负责切换默认应用。
- 顶部状态胶囊：常驻展示通知状态；通知与 AI 卡片展开显示，可拖动并记住位置。折叠态单击展开通知（无通知时打开主窗口），双击打开主窗口，按住拖动交给窗口管理器并持久化位置（`IslandWindow.tsx`）。胶囊窗口不取 key window（`island_window/macos.rs` 从窗口自身类派生一个 `canBecomeKeyWindow = NO` 的子类并换类，点击 / 拖动都不会抢走主窗口焦点，首次点击由 `accept_first_mouse` 送达）。
- 请求历史：设置底部「接口历史」自动记录网页内部接口，支持查看与导出 JSON。
- 缺陷导出：`bug.json` + `assets/`；`bug.json` 是 `BugDetail` 的 camelCase JSON，顶层 `assets` 只列成功下载的资源，视频 / 图片 / 日志按需下载。
- 媒体缓存：缺陷导出、界面 / 手机端媒体代理、打开原图共用 `<数据目录>/media-cache/` 里按 URL 哈希寻址的缓存，同一 URL 只下载一次；代理请求的 `Range` 直接由缓存文件本地切片，重复导出与重复渲染不再回源。缓存超过 2GB 时按最久未修改淘汰到 1.5GB。
- 账户与会话：从设置中拆成独立视图，入口是项目栏底部的用户按钮；项目栏收起时头像缓动到左侧图标栏。

### 数据与通知

- 离线优先：项目列表、缺陷列表与详情先渲染 SQLite 缓存，再后台刷新；只有首次登录且无缓存时显示骨架屏。刷新期间标题栏居中显示「更新中」。
- 新缺陷通知：顶部胶囊展开自绘卡片（处理 / 查看 / 忽略），支持范围（我的 / 项目）、类型（新建 / 转移 / 重新打开）、轮询、免打扰、模拟通知。「我的」范围跨项目增量轮询，每个项目独立 cursor；启动/登录后的第一轮只建 baseline 不通知，旧卡片在会话开始时清空。
- AI / MCP 通知：MCP 客户端通过 `tapd_notify_user` 唤起通用卡片（tone + 内容块 + 动作），用户点击后把动作回执给同一工具调用；设置里可开关与调试。
- 处理动作：自动改派给自己，并把起始状态流转到处理中（`in_progress` / `progressing`）。

### Agent

- 一个统一任务列表：项目分组，状态 chip（`queued` / `running` / `awaiting_review` / `finalizing` / `done` /
  `failed` / `canceled`）+ 实时运行点；bug、本地事项与自由会话都在同一列表。契约见 [DSH.md](DSH.md) §9。
- 审核 / 取消 / 重试收尾 / 查看 diff 在任务条上直接操作；通过后宿主按 finalizing 链自动完成提交、合并、清理与 TAPD 回写，模型只改代码、跑测试。
- 审批与提问可在桌面与手机回答，阻塞请求可随时用 `dsh_pending` 查快照；手机没有 token 级实时流，靠轮询收齐。
- 配置页：入口是设置页顶部第一张「Agent 配置」卡片（与运行信息同款，位于外观之上；全局挂载，任何页面都能打开）。左侧分组为常规 / 模型 / 规则 / 同事 / 集成 / 内置插件。权限模式三选一（auto / notify / full）、模型供应商与模型目录（多供应商、每模型上下文窗口 / 最大输出 / 输入模态 / 推理等级映射）、团队协作开关（新任务会话默认进入任务板，同事渲染成 agent preset 供 lead 指派；团队协作开启时提示词不注入同事名单，关闭时把所选同事注入 `{{coworker}}`）、同事多选（原左侧导航「同事」页移入）、集成（运行时注册的工具）、Worktree 隔离与执行单元；
  改动即时保存，提示词模板只在桌面编辑。
- 旧的运行时选择、模型与权限 CLI 参数、TUI 终端接管、历史续接与「处理中」范围都已移除。

### MCP 与运维

- MCP tab：10 个工具（whoami / 项目 / 查询 / 我的缺陷 / 详情导出（含修复提示词与 skills）/ 状态查询 / 评论 / 状态更新 / 胶囊通知 / 等待回执）；「接入 AI 客户端」按客户端一行，一键写入 opencode / ZCode / Claude Code / Cursor 的用户级配置（自动备份、幂等）；Codex 的一键导入入口暂时隐藏（后端 spec 保留）。
- MCP 策略与审计：可关闭写操作、限制可访问项目、限制目标状态白名单；每次调用记录工具、客户端、允许 / 拒绝 / 失败、耗时与项目 / 缺陷（不保存评论正文和 Cookie），支持筛选、导出与清空。
- 首启引导：首次登录后展示三步引导（欢迎 / 基础设置 / 找同事，见 `components/Onboarding.tsx`），可跳过，完成状态写入 `config.json`。
- 自动更新：启动时立即检查 GitHub Releases，之后每 30 分钟查询一次并记录检查时间；标题栏更新图标在有新版本时变绿，hover 展示更新日志。更新期间主窗口隐藏，胶囊放大 3 倍显示下载 / 解包安装进度；失败时可手动下载或取消。发布说明带 `<!-- force-update -->` 标记时为强制更新：要求写入 `config.json` 的 `forcedUpdate`，登录页与主界面都显示不可关闭的升级模态框，直到当前版本不低于目标版本。
- 诊断包：设置 → 运行信息一键导出脱敏 zip，包含版本与系统信息、脱敏配置、通知设置、Agent 设置摘要、MCP 审计和最近日志；不包含 Cookie、本地 API token、请求 / 响应正文。
- 清理缓存：设置 → 本地数据一键删除应用数据目录下的全部内容，随后自动重启；删除在下次启动时、日志与 SQLite 打开前执行，目录来自 `AppPaths`；导出目录不受影响。
- 本地回环 API：随机端口 + 每次启动轮换 token，`runtime.json` 0600。

## 5. 模块地图

```
apps/desktop/
  src/
    App.tsx                  主窗口路由与整体布局
    components/              LoginGate、列表、详情、MCP、设置、引导、胶囊视图
    lib/                     前端 API、缓存、通知、Agent 设置、MCP、更新封装
    windows/IslandWindow.tsx 通知胶囊窗口
  src-tauri/src/
    session.rs               隐藏 WebView、同步 / 异步桥、Cookie
    inject.js                抓包与 __TAPDCB__ 请求助手
    commands.rs              Tauri 命令（会话、缺陷、MCP 配置、媒体打开方式）
    agent_settings.rs        项目仓库 / 规则、提示词、Worktree 与同事选择
    feature_router.rs        通知 / 设置 / 同事 / 终端 / 缓存 / MCP 的统一命令路由
    terminal.rs              用户终端会话（PTY、回放环、输出事件与命令面）
    cache.rs                 SQLite 离线快照缓存
    local.rs                 local_* 命令：本地项目 / 事项 SQLite、目录浏览边界
    notification.rs          轮询、分类、通知窗口调度、接受动作
    island_window.rs         胶囊窗口创建、定位、拖动持久化与尺寸动画
    notification_db.rs       通知状态 SQLite 持久化（设置 / 条目 / 去重 / 游标）
    coworker.rs              同事包注册表、技能 frontmatter、提示词注入（单人路径）与 skill map
    mcp.rs                   MCP 工具调度、策略强制与审计记录
    mcp_audit.rs             有界 MCP 调用审计（SQLite `mcp_audit` 表，脱敏摘要）
    mcp_import.rs            各 AI 客户端配置一键注入
    export.rs                bug.json / quest.json 导出、资源下载与提示词渲染
    media_cache.rs           URL 寻址的媒体缓存（导出 / 代理 / 打开原图共用）
    diagnostics.rs           脱敏诊断包
    dsh/                     内置 Agent 宿主：payload / runtime / bridge / policy / tasks /
                             team / worktree / task_store / writeback（契约见 DSH.md）
    companion/terminal.rs    远程终端 WebSocket（回放 + 实时输出 + 输入 / 尺寸）
    server.rs                本地 HTTP（/healthz、/mcp/call、/media、/file、调试端点）
    update.rs                GitHub Releases 检查与更新状态
    reset.rs / open_with.rs  本地数据清理 / 按默认应用打开资源
dsh/plugins/                 随 payload 打包的 Cordis 插件：tapd-tools、tapd-bridge、tapd-policy
crates/dsh-host/             SDK RPC / 桥协议 / profile / transcript / payload 清单（无 Tauri 依赖）
crates/tapd-core/            模型、过滤器、响应解析、媒体收集、配置与存储
crates/tapd-workspace/       工作区的 git 事实（变更 / 行数 / diff / HEAD），供内置 Agent 的 Worktree 复用
crates/tapd-local/           本地项目 / 事项领域类型、校验与状态迁移（无 IO）
crates/tapd-mcp/             MCP stdio sidecar
docs/                        架构、开发、计划、接口、通知、内置 Agent（DSH）、MCP、发版
fixtures/                    测试辅助数据
scripts/                     图标、sidecar、发版等构建工具
```

## 6. 设计取舍

- **复用网页会话，不走 Open API**：保持与公司账号 / SSO 一致，代价是依赖未公开的内部接口，改版时需要更新 `tapd-core` 适配层。
- **缓存是快照**：优先保证打开即见，不做全量后台同步与离线搜索。
- **Agent 默认串行，Worktree 开启后并行**：默认关闭 Worktree，同一时间只有一个任务使用主仓库；开启后每个任务在独立 worktree 中运行，执行单元可调到 1–8，避免互相踩踏。改动先审核、合并回主仓后才算完成，TAPD 回写集中在合并阶段，避免分支旁的中间状态污染缺陷。
- **通知自绘**：不使用系统通知，才能承载处理 / 查看 / 忽略三个动作与更新进度。
- **终端会话归后端，视图可丢弃**：PTY、输出环形缓冲和订阅广播都在 `terminal.rs`，关面板 / 切页面只销毁 xterm 视图，shell 继续运行；重开时回放尾部 256 KiB 并按累计字节数去重，手机与桌面可以同时挂同一会话。
- **右 / 下容器先开者优先**：主视图区是一个 Grid（`main` / `term` / `detail` 三个稳定节点），先打开的容器保持整幅跨度，后打开者让出空间；只切 `grid-template-areas`，不重建 React 树，所以切换时缺陷列表、详情与终端都不丢状态。
- **Agent 内核不 fork**：内置运行时钉死上游版本，只通过 profile 组合与自有插件扩展；差异集中在 `docs/DSH.md` 记录的扩展点，升级是改版本号 + 跑契约测试，不做 rebase。
- **变更事实只有一个来源**：文件列表、增删行数、二进制、diff 与 commit 全部由 `tapd-workspace` 调 git 子命令产出，不在应用里数行或解析文件内容；目录被清理后自动改用 `baseline..branch`，因此审核、收尾与历史使用同一套计算。diff 在打开 / 审核时按需计算（含未跟踪文件、超长截断并标注），git 在阻塞线程执行，不阻塞 async 路径。
- **写操作收窄**：MCP 只开放评论与状态更新，不提供删除、改处理人、批量操作。
- **本地 API 最小暴露**：随机端口 + 每次启动轮换 token，`runtime.json` 权限 0600。
- **不做未读与托盘角标**：TAPD 没有提供缺陷通知的已读状态，客户端不自行发明计数。
- **本地项目与 TAPD 分开存储**：本地项目是用户数据而不是 TAPD 缓存，单独用 `local.sqlite3` 并跳过清缓存；本地事项不伪装成缺陷，用 `WorkItem` 与任务 `kind: local_item` 复用 Agent 队列。

## 7. 当前限制

- 仅 macOS（发布物为 Apple Silicon arm64）。
- 通知的「项目」范围仍只轮询当前项目；「我的」范围已跨项目轮询。
- `assigned_time` 缺失时“转移”判定偏保守。
- Agent 的 token 级流式只在桌面端；手机收任务列表与阻塞请求，没有 live 文本。
- 团队任务板的写作用域按会话投影，成员共用当前 checkout（不建独立工作目录）。
- 终端回放是原始输出尾部（不做终端状态序列化），全屏 TUI 中途重挂只能近似重建；手机断线期间超出 256 KiB 的输出会丢。
- 远程终端与伴侣共用配对 token，没有独立的二次确认；隧道开启时等价于把桌面用户的 shell 暴露到公网，只在可信设备上配对。
- 发布包默认未签名、未公证；首次打开需在「系统设置 → 隐私与安全性」中允许。
- 本地事项交给 Agent 后随任务进入 `in_progress`，任务 `done` 自动写 `done`；取消或删除未完成任务会恢复 attach 前的状态并清掉任务链接。桌面事项页不轮询，靠 `local://items` 事件静默刷新页签与计数（`itemId/status` 用于跟随当前可见事项）。「已完成」也可手动标记 / 重新打开；交给 Agent 前目录必须是带 `HEAD` 的 git 仓库。移动端文件页的根目录只读，不能编辑系统文件。
- TAPD 网页内部接口未公开，改版时需要更新适配层。

## 8. 下一步

1. 完整的跨项目缓存同步与离线搜索。
2. 如确有需要，再扩展「项目」范围的多项目轮询与更细的游标策略。
3. 签名 / 公证发布，以及 MCP 调用限流与按 `clientInfo.name` 的独立策略档案。
4. 更细的并发调度与资源限制（当前按执行单元限制并行数，Worktree 关闭时固定 1）。

更完整的阶段计划与验收记录见 [PLAN.md](PLAN.md)，接口验证见 [spike.md](spike.md)。
