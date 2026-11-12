# 开发与运行

> 环境要求、常用命令、首次运行、本地数据位置。系统结构见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 1. 前置

- macOS（发布物为 Apple Silicon arm64）
- Node 20.19+
- pnpm 12
- Rust 1.85+
- Xcode Command Line Tools

## 2. 常用命令

```bash
pnpm install
pnpm dev              # 启动 Tauri 开发窗口
pnpm typecheck        # 前端类型检查
pnpm check:rust       # Rust 编译检查
cargo test -p tapd-core
cargo build -p tapd-mcp
pnpm build            # 本机架构 app + dmg（自动先构建 sidecar）
pnpm build:arm64      # 显式 arm64 app + dmg（与 release CI 一致）
```

打包会把 `tapd-mcp` 放进 `TAPD Client.app/Contents/MacOS/`，设置页复制的 MCP 配置会直接指向该路径。发布流程见 [RELEASE.md](RELEASE.md)。

CI（`.github/workflows/ci.yml`）会依次执行前端类型检查、构建 debug sidecar、`cargo check` 与 workspace 测试。

## 3. 首次运行

1. 启动后主窗口直接显示企业微信扫码登录页，不弹出独立登录窗口。
2. 扫码成功后隐藏 WebView 保留会话，客户端进入首启引导（可跳过）。
3. 选择左侧项目，默认展示「我负责的」缺陷；可切换「全部」。
4. 点击缺陷行打开详情；点击「导出 MD」生成可交给 AI 的缺陷包。
5. 设置 →「默认 Agent」选择运行时；点「管理全部运行时」进入 Agent 页 →「配置」填写可执行路径与当前项目仓库路径。
6. 设置 → 新缺陷通知：选择范围（我的 / 项目）与是否包含转移、重新打开。
7. 打开 MCP tab →「接入 AI 客户端」，选择要用的客户端一键导入（opencode / ZCode / Claude Code / Cursor / Codex / OMP / Kimi Code / Gemini CLI / Qwen Code），并按需调整策略与审计开关；后续启动 Agent 会自动确保注入。
8. Agent tab：运行栏查看当前任务；「待审核」时在 tab 或胶囊里批准 / 拒绝；历史子页查看执行记录、日志，或在 Terminal 恢复会话。
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
- 离线缓存：`<数据目录>/cache.sqlite3`（项目 / 缺陷快照 + `agent_tasks` / `agent_queue_state` + `notification_*` / `mcp_audit`；退出登录清 TAPD 数据与通知条目/去重状态，保留通知设置）
- Agent 配置 / 任务：`agent.json`、`cache.sqlite3` 的 `agent_tasks` / `agent_queue_state`（终端输出不落盘；旧版本遗留的 `agent-logs/`、`agent-events/` 在启动时删除）
- 抓包导出：`<数据目录>/captures/`
- 缺陷导出：`~/Documents/TAPDClient/exports/<项目>-<id>/<短ID>[-<ASCII slug>]/`（目录名不含中文，完整标题在 `bug.md` 里）
- `runtime.json`：本地 API 端口与 token（0600）

清理缓存：设置 → 本地数据 →「清理缓存」，删除上述数据目录下的全部内容并重启应用。`exports/` 与 WebView Cookie 不在数据目录内，会被保留。

## 6. 相关文档

- [ARCHITECTURE.md](ARCHITECTURE.md)：模块地图、数据流、设计取舍
- [NOTIFICATIONS.md](NOTIFICATIONS.md)：通知范围、轮询与去重
- [AGENT.md](AGENT.md)：修复队列与任务状态
- [MULTI_AGENT.md](MULTI_AGENT.md)：多 Agent TUI 适配与完成判定
- [MCP.md](MCP.md)：工具、策略、客户端接入
- [RELEASE.md](RELEASE.md)：打包、签名与发版
- [PLAN.md](PLAN.md)：阶段计划与验收
- [spike.md](spike.md)：TAPD 内部接口验证
