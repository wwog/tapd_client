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

## 3. 首次运行

1. 启动后主窗口直接显示企业微信扫码登录页，不弹出独立登录窗口。
2. 扫码成功后隐藏 WebView 保留会话，客户端进入首启引导（可跳过）。
3. 选择左侧项目，默认展示「我负责的」缺陷；可切换「全部」。
4. 点击缺陷行打开详情；点击「导出」生成可交给 AI 的缺陷包（`bug.json` + `assets/`）。
5. Agent 页 →「配置」填写内置模型 API（地址、模型、密钥）与当前项目仓库路径；权限模式三选一。
6. 设置 → 新缺陷通知：选择范围（我的 / 项目）与是否包含转移、重新打开。
7. 打开 MCP tab →「接入 AI 客户端」，选择要用的客户端一键导入（opencode / ZCode / Claude Code / Cursor / Codex / OMP / Kimi Code / Gemini CLI / Qwen Code），并按需调整策略与审计开关；后续启动 Agent 会自动确保注入。
8. Agent tab：统一任务列表（运行中 / 待审核 / 待合并 / 已完成同一个列表），在任务条上查看 diff、通过、合并或取消；审批 / 提问可在任务页或胶囊里回答。
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
- Agent 配置：`<数据目录>/agent.json`（项目仓库与规则、提示词模板、Worktree 与同事选择、模型 API 与密钥、权限模式）；会话 transcript 由 dsh 运行时自己保存
- 本地项目 / 事项：`<数据目录>/local.sqlite3` 的 `local_projects` / `local_work_items`（纯本机数据，与 TAPD 登录无关；schema v2，项目含 `rule`；本地事项交给 Agent 时导出 `quest.json`）
- Agent worktree：开启 Worktree 隔离后，任务目录在 `<数据目录>/worktrees/<session id>`；成功后删除目录、保留分支
- 抓包导出：`<数据目录>/captures/`
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
