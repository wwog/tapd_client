# 开发与运行

> 环境要求、常用命令、首次运行、本地数据位置。系统结构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 1. 前置

- macOS（发布物为 Apple Silicon arm64）
- Node 24.9+（内置 Agent 运行时要求；payload 构建也要用同一版本）
- pnpm 12
- Rust 1.85+
- Xcode Command Line Tools

## 2. 常用命令

```bash
pnpm install
pnpm prepare:dsh      # 安装/裁剪/压缩内置 Agent payload（首次或升级 dsh 后）
pnpm check:dsh        # 校验 resources/dsh 的 payload 是否存在且与钉定版本一致
pnpm verify:dsh       # 把 payload 解到临时目录，起一次运行时并过 SDK 握手冒烟
pnpm dev              # 启动 Tauri 开发窗口（先跑 check:dsh）
pnpm typecheck        # 前端类型检查
pnpm i18n:check       # 中英文案覆盖率（未翻译/缺失/重复）
pnpm check:rust       # Rust 编译检查
cargo test -p tapd-core
cargo build -p tapd-mcp
pnpm build            # 本机架构 app + dmg（自动先 prepare:dsh、构建伴侣 SPA 与 sidecar）
pnpm build:arm64      # 显式 arm64 app + dmg（与 release CI 一致）
```

打包会把 `tapd-mcp` 放进 `TAPD Client.app/Contents/MacOS/`，设置页复制的 MCP 配置会直接指向该路径。发布流程见 [RELEASE.md](RELEASE.md)。

`cargo check` / `cargo test` 需要两个 JS 侧产物先行：`apps/desktop/src-tauri/binaries/`（sidecar）与 `apps/desktop/src-tauri/dist-companion/`（移动端 SPA，rust-embed 编译期嵌包）。`pnpm check:rust` / `pnpm test:rust` 会自动先构建两者，直接跑裸 cargo 会报缺目录。

CI（`.github/workflows/ci.yml`）会依次执行前端类型检查、`pnpm check:rust` 与 `pnpm test:rust`（两者自带上述预构建）。

### 2.1 内置 Agent payload

内置运行时不是源码依赖，而是一份压缩产物：

- 构建产物：`apps/desktop/src-tauri/resources/dsh/{manifest.json,payload-<version>-<platform>-<arch>.tar.zst}`
  （约 19 MB，解压后约 233 MB / 2.5 万文件，版本来自 `vendor/dsh/package.json`）。
- 运行位置：首次启动按 `manifest.json` 校验 sha256 / 大小后，原子解压到 `<数据目录>/dsh/<version>/`；
  重装同版本不会重复解压。
- **开发运行必须有 payload**：`pnpm dev` 先跑 `pnpm check:dsh`，缺失 / 版本不匹配 / 平台不匹配时直接失败并打印
  `pnpm prepare:dsh`；用 `TAPD_DSH_PAYLOAD=<dir>` 可以指向另一份 payload（测试与调试用）。
- 调试构建优先读 `src-tauri/resources/dsh`（build 输出），可直接替换该目录迭代，不必重解压。

### 2.2 测试模型 `TestAgent`（仅调试构建）

调试构建在「配置 → 模型」里固定多出一个供应商 `TestAgent`：它由应用自己的本地 HTTP 服务提供
（`POST /test-agent/v1/chat/completions`），说的是标准 OpenAI 流式协议，所以运行时当成真实网关用，
请求里的 30 个内置工具也照常执行。回复是**脚本化**的，用来验证推理块、正文、工具行、提问卡片、
用量与错误渲染：

| 指令 | 脚本 |
| --- | --- |
| `/test all`（默认） | 推理 → 正文 → write/read/edit/read → `ls` → 提问 |
| `/test text` | 只有正文 |
| `/test reasoning` | 推理 + 正文 |
| `/test files` | 新建 → 读取 → 编辑 → 再读 |
| `/test tools` | 安全的内置工具各调一次（含 todo、目录、glob、grep） |
| `/test ask` | 只发一次提问（可选项见卡片） |
| `/test agents` | 派三个子 agent：一个 glob/read 找文件、一个 `curl` 请求本机 `/healthz`、一个 grep 检索，最后 `wait_agent` 收回 |
| `/test error` | 一条按预期失败的 `exit 3` |
| `/test long` | 长文本，看滚动与渲染 |
| `/test ping` | `task_submit`（任务提交工具） |

要点：

- 文件脚本只动**会话工作目录**下的 `tmp/test-agent/hello.txt`；相对路径是有意的，沙箱只放行工作区内写入。
- 只有显式的 `/test <名字>` 会切换脚本：运行时自己注入的上下文也以 user 消息下发（里面有
  “Ask the user to clarify…”），按关键词匹配会误命中。
- 请求里已经有工具结果（第二轮）时只回一段收尾文字，不重复调用工具。
- 子 agent 的任务由父级在 `subagent` 的 prompt 里带标记（`[test-child:files|curl|grep]`），子 agent 按标记选自己的脚本；
  子脚本只做一件事、**不会再派子 agent**，所以任务树不会无限递归。curl 打的是本机 `/healthz`，不依赖外网。
- 该供应商在每次加载配置时按当前端口重新注入（端口每次启动都变），不会写进 `agent.json`；
  切换到它只需在模型列表里点圆圈设为默认，再重启运行时。

### 2.3 内置 Agent 的生命周期

内置 Agent 是**应用的一部分**,不是用户要管的东西:

- 应用启动时 `setup` 里的守卫异步 `dsh::feature::start`（最多 3 次、间隔 2 秒），一个子进程
  (node + payload)服务**所有会话**——不是每个会话起一个;dsh 自己就是长驻服务,会话只是它内部的一个 id。
- **启动前提是已配置可用模型**（默认供应商 + 默认模型 + Base URL）。没有模型时运行时记为
  `model_missing` 终态、不重试,界面显示「待配置模型」;在应用内保存模型后宿主会自动再拉起一次,
  不需要点「重试」。
- 「获取模型」由宿主 Rust 直接请求供应商端点（`dsh/discovery.rs`），不经过运行时，所以在运行时
  未启动 / 启动中 / 失败时都能用；这也是配置模型、打破「先有鸡还是先有蛋」的入口。
- 应用退出时子进程随进程一起结束(`kill_on_drop`)。
- 界面上没有「启动 / 停止」:配置页的运行时卡片只读,对话区只在真失败时给「重试」;
  `stopped` 只出现在启动过程中,显示为「正在准备运行时」。
- 历史与会话统计不依赖运行时是否已恢复某个会话:打开会话时按 `$DSH_HOME/sessions/` 的日志补历史,
  并把轮数 / token 一起发布给界面。

### 2.4 UI 调试探针（仅调试构建）

调试构建在回环 API 上额外挂了两组 `/dev/*` 路由（release 不注册）：一组打到隐藏的 TAPD 会话
WebView（验证 TAPD 内部接口），一组打到应用自己的 `main` 窗口（看界面）。端口与 Bearer token 每次
启动都变，统一从 `runtime.json` 读。

| 路由 | 作用 |
| --- | --- |
| `POST /dev/eval`、`/dev/call`、`/dev/feature`、`/dev/dsh` | 在会话 WebView 里执行；`call` 会 await Promise |
| `POST /dev/ui/eval` | 在 `main` 窗口执行同步表达式，返回 JSON |
| `POST /dev/ui/call` | 同上，但 await Promise（点按、等待、IPC 调用用它） |
| `GET /dev/ui/console` | 取走控制台 / 未捕获错误的环形缓冲（200 条，取走即清空） |
| `POST /dev/ui/snapshot` | 截 `main` 窗口为 PNG，返回 `path`/`width`/`height` |
| `GET /dev/ui/snapshot.png` | 同样的截图，直接返回 `image/png` |

要点：

- `el.click()` 就能触发 React 事件；改输入框要走原生 setter 再派发 `input`。`withConsole: true`
  会顺带返回本次调用期间的 `console.*` 与未捕获错误。
- 阅读界面优先 `eval` 取 DOM 文本，只有看布局 / 视觉时才截图：截图落在 `<数据目录>/screenshots/`，
  长边默认缩到 1280（`maxWidth`，`0` 为原图），保留最近 50 张。窗口最小化或隐藏时截图直接报错。
- 截图走 `screencapture -l <窗口号>`，需要系统「屏幕录制」权限；没有权限时只会得到空图。
- 命令行封装：`node scripts/dev-probe.mjs eval '<expr>'`、`call`、`console`、`shot [maxWidth]`；
  其他路由可以直接 `node scripts/dev-probe.mjs /dev/feature '{"name":"..."}'`。

## 3. 首次运行

1. 启动后主窗口直接显示企业微信扫码登录页，不弹出独立登录窗口。
2. 扫码成功后隐藏 WebView 保留会话，客户端进入首启引导（可跳过）。
3. 选择左侧项目，默认展示「我负责的」缺陷；可切换「全部」。
4. 点击缺陷行打开详情；点击「导出」生成可交给 AI 的缺陷包（`bug.json` + `assets/`）。
5. Agent 页 →「配置」添加模型供应商（地址、协议、密钥）与模型、点模型行左侧圆圈设默认模型，并填写当前项目仓库路径；权限模式三选一。
6. 设置 → 新缺陷通知：选择范围（我的 / 项目）与是否包含转移、重新打开。
7. 打开 MCP tab →「接入 AI 客户端」，选择要用的客户端一键导入（opencode / ZCode / Claude Code / Cursor / Codex / OMP / Kimi Code / Gemini CLI / Qwen Code），并按需调整策略与审计开关；后续启动 Agent 会自动确保注入。
8. Agent tab：统一任务列表（排队 / 运行中 / 待审核 / 收尾中 / 已完成同一个列表），在任务条上查看 diff、通过、重试收尾或取消；通过后提交 / 合并 / 清理 / 回写由宿主自动完成，审批 / 提问可在任务页或胶囊里回答。
9. 遇到问题时，设置 → 运行信息 →「导出诊断包」，把生成的 zip 提供给排查者。

## 4. MCP 联调

需先 `pnpm dev` 并完成登录：

opencode v2.2+ 需要把条目直接写在 `mcp.tapd` 下（`mcp.servers` 会被启动校验拒绝）。在项目或全局 `opencode.json[c]` 中加入：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "tapd": {
      "type": "local",
      "command": ["/绝对路径/tapd_client/target/debug/tapd-mcp"]
    }
  }
}
```

然后确认：

```bash
opencode mcp list     # ✓ tapd connected
```

工具清单、策略与审计说明见 [MCP.md](MCP.md)。

## 5. 本地数据

- 数据目录：`~/Library/Application Support/com.tapdclient.desktop`
- 日志：`<数据目录>/logs/`
- 通知状态：`<数据目录>/cache.sqlite3` 的 `notification_*` 表
- MCP 审计：`<数据目录>/cache.sqlite3` 的 `mcp_audit` 表（最近 500 条，可导出到 `exports/`）
- 诊断包：`<数据目录>/diagnostics/` 下的 zip（导出后自动在 Finder 中定位目录）
- 离线缓存：`<数据目录>/cache.sqlite3`（项目 / 缺陷快照 + `notification_*` / `mcp_audit` / `dsh_tasks`；退出登录清 TAPD 数据与通知条目/去重状态，保留通知设置）
- 内置 Agent：`<数据目录>/dsh/<version>/`（payload 解压结果，可安全删除，下次启动重建）、`<数据目录>/dsh/home/`（`DSH_HOME`，dsh 自己的会话与 profile）
- Agent 配置：`<数据目录>/agent.json`（项目仓库与规则、提示词模板、Worktree 与团队协作/同事选择、模型供应商与模型目录、权限模式）；会话 transcript 由 dsh 运行时自己保存
- 本地项目 / 事项：`<数据目录>/local.sqlite3` 的 `local_projects` / `local_work_items`（纯本机数据，与 TAPD 登录无关；schema v3，项目含 `rule`，事项含 `importance`；本地事项交给 Agent 时导出 `quest.json`）
- Agent worktree：开启 Worktree 隔离后，任务目录在 `<数据目录>/worktrees/<session id>`；成功后删除目录、保留分支
- 抓包导出：`<数据目录>/captures/`
- 调试截图：`<数据目录>/screenshots/`（`/dev/ui/snapshot` 写入，最多保留 50 张）
- 缺陷导出：`~/Documents/TAPDClient/exports/<项目>-<id>/<短ID>[-<ASCII slug>]/`（目录名不含中文，完整标题在 `bug.json` 里）
- 媒体缓存：`<数据目录>/media-cache/`（`<url 哈希>` 存字节、同名 `.json` 存 URL 与 content type、`open/` 是交给系统的带扩展名硬链接）；导出、媒体代理与打开原图共用，上限 2GB
- `runtime.json`：本地 API 端口与 token（0600）

清理缓存：设置 → 本地数据 →「清理缓存」，删除上述数据目录下的全部内容并重启应用。`exports/` 与 WebView Cookie 不在数据目录内，会被保留；`local.sqlite3` 及其 `-wal` / `-shm` 也显式保留，因为本地项目是用户数据而不是 TAPD 缓存。

## 6. 相关文档

- [ARCHITECTURE.md](ARCHITECTURE.md)：模块地图、数据流、设计取舍
- [DSH.md](DSH.md)：内置 Agent 运行时契约、任务工作流与权限模式
- [COMPANION.md](COMPANION.md)：移动端伴侣、远程终端与文件浏览
- [NOTIFICATIONS.md](NOTIFICATIONS.md)：通知范围、轮询与去重
- [MCP.md](MCP.md)：工具、策略、客户端接入
- [I18N.md](I18N.md)：中英文案目录、翻译约定与覆盖检查
- [RELEASE.md](RELEASE.md)：打包、签名与发版
- [PLAN.md](PLAN.md)：阶段计划与验收
- [spike.md](spike.md)：TAPD 内部接口验证
