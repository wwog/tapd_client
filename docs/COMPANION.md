# 移动端伴侣（Companion）— v1 计划

> 状态：**v1 已实现**（2026-11-13，分支 `feat/mobile-companion`，提交 10ec793 / b59f16b / 46d4812）。cargo test 243 全绿，双端 typecheck 与构建通过；§6.3 真机全链路待走查。实现与计划的差异见文末「实现记录」。
>
> 核心原则：**移动端是纯渲染终端，零执行能力**——只渲染客户端的数据与行为，所有数据获取与动作执行都由桌面客户端代理。手机↔桌面之间只传视图数据；未来的写操作也只是「动作意图」下发，由桌面端执行。

## 1. 目标与定位

- 桌面端运行时，手机扫码打开一个移动适配网页，即移动端伴侣。
- 数据链路：手机 → 桌面 companion HTTP 服务 → 与桌面 UI 同层的内部函数 → 隐藏 webview 会话桥 → TAPD。手机不直接触碰 TAPD，不共享 cookie。
- **移动端无登录功能（已定）**：手机端不做任何 TAPD 登录 UI，不持有任何 TAPD 凭据，唯一入口是扫码配对。桌面会话掉线 → 移动端呈现「桌面端掉线」态并停止取数，桌面重新登录后自动恢复，手机端无需任何操作。
- **通知（已定）**：桌面通知引擎（轮询判定 / 去重 / 免打扰）不动，胶囊通知仍是桌面形态；移动端用**自身的通知机制**镜像同一批通知条目，点通知进对应缺陷详情。形态按传输层自动切换：HTTP 局域网 → 页面内通知，HTTPS（隧道）→ 系统级 Web 通知（见 §4.5 通知行为）。
- **偏好本地自治（已定）**：移动端的设置项（主题、字号等）独立于桌面，只存手机本地，不与桌面 uiPrefs 同步。
- **不经过 MCP 工具层**：MCP（`mcp::handle`、策略门禁、审计）是外部 AI 客户端的门面，伴侣不复用。companion handler 直接调用桌面命令的核心函数，返回与桌面组件完全相同的 serde 数据形状（`BugListPage` / `BugDetail`），无工具层封装。
- 静态资源由桌面端自己 serve——手机每次加载的版本永远与桌面端一致，不需要任何外部托管（GitHub Pages 亦无必要）。

## 2. 传输层调研（v2 参考，本期不实现）

| 方案 | 费用 | 适用范围 | 说明 |
|---|---|---|---|
| 局域网直连（v1） | ¥0 | 同一 Wi-Fi | companion 服务绑 `0.0.0.0`，QR 内容为 `http://<lan-ip>:<port>` |
| Cloudflare Quick Tunnel | ¥0 | 任何网络 | `cloudflared tunnel --url http://127.0.0.1:<port>` 得随机 `trycloudflare.com` URL，无需账号；每次重启换 URL，官方定位开发用途；2026-10 起支持可选 PIN 保护 |
| Cloudflare Named Tunnel | ¥0（需域名） | 任何网络 | 固定 URL + 自动 HTTPS，需 CF 账号 |
| 国内轻量 VPS + frp | ~¥几十/年起 | 任何网络 | **延迟最低**的外网方案，速度取决于服务器带宽 |
| 花生壳 / natapp / cpolar 免费版 | ¥0 | 任何网络 | 免费额度窄（花生壳 1Mbps/1GB 月流量）、随机域名限速 |

- Quick Tunnel 国内实测：可用但延迟 100–300ms（走海外节点），部分地区运营商 QUIC（UDP）不通需 `--protocol http2` 回退。
- Tailscale 国内常走海外中转，延迟不理想。
- **结论**：个人低延迟外网访问首选国内轻量 VPS + frp；零成本兜底用 Quick Tunnel。companion 前端全用相对路径同源请求，换传输层前端零改动。

来源：[Quick Tunnels 官方文档](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels)、[Protected Quick Tunnels](https://blog.cloudflare.com/protected-quick-tunnels)、[国内延迟实测](https://bbs.csdn.net/weixin_34101914/article/details/100420688)、[QUIC 回退 http2](https://y4er.com/posts/cloudflare-tunnel)、[6 种方案实测](https://zhuanlan.zhihu.com/p/1979204699442935077)、[免费工具对比](https://juejin.cn/post/7481143717245288474)、[国产工具测评](https://www.cnblogs.com/kukuxjx/p/17595471.html)

## 3. 架构

```
手机浏览器 ──HTTP──> companion axum server（0.0.0.0:0 随机端口）
                    │  配对码（一次性，TTL 10min）→ session token（Bearer）
                    │  静态资源：rust-embed 内嵌 companion SPA
                    ▼
      commands.rs 内部核心函数（与桌面 UI 同层，不经过 MCP）
                    │ session_request_json（隐藏 webview 桥）
                    ▼
                  TAPD
```

## 4. 实现步骤

### 4.1 Rust：companion 服务模块（新 `src-tauri/src/companion.rs`）

- 以 `server.rs::run()`（L38）为模板起第二个 listener：`TcpListener::bind(("0.0.0.0", 0))`；仅当 `config.companion.enabled` 时在 lib.rs setup spawn（参照 lib.rs:125 `server::run` 的 spawn 写法）。
- 路由：
  - `GET /` + 资产 → rust-embed 嵌入 `dist-companion/`（debug 构建从磁盘读）
  - `POST /companion/api/pair`（免鉴权）：一次性配对码换长期 session token；简单内存限速
  - `GET /companion/api/state`：`{ loggedIn, version, me, workspaces 概要 }`
  - `GET /companion/api/bugs`：参数同桌面 `BugQuery` → `BugListPage`
  - `GET /companion/api/bug`：`workspace_id + bug_id → BugDetail`（含评论）
  - `GET /companion/api/media?url=`：服务端复用 `server/proxy.rs` 媒体拉取逻辑，加 TAPD 域白名单，session 鉴权
  - `GET /companion/api/notifications`：镜像桌面通知条目（复用 notification 模块现有状态，只读；判定 / 去重 / 免打扰逻辑不移动）
- **复用而非 MCP**：把 `commands.rs` 中 `bug_list`（L296）、`fetch_bug_detail`、`workspace_context` 等命令核心逻辑提取为 pub async fn（命令壳不变，行为保持拆分），companion handler 直接调；`observe=false`（手机刷新不抑制桌面通知）。

### 4.2 配对持久化（config.json）

- `tapd-core` `AppConfig` 新增 `companion: Option<CompanionConfig>`（serde default 向后兼容）：`enabled: bool` + `devices: Vec<{ id, name, token_hash, paired_at }>`（有界小列表，按惯例进配置而非 sqlite）。
- 写入一律走 `state.update_config`（state.rs:47 惯例）；`token_hash` 用已有 sha2 存 sha256；手机端 token 只存 localStorage。
- 解除配对 = 删 device 项，手机下次请求 401；`RunEvent::Exit` 关 listener（内存一次性码自然消亡）。

### 4.3 局域网 IP 与 QR（Tauri commands）

- 新依赖 `local-ip-address`：取首个私有 IPv4，多网卡取默认路由优先。
- lib.rs `generate_handler` 追加：
  - `companion_status` → enabled / port / lan_ip / devices
  - `companion_enable` / `companion_disable`
  - `companion_pairing_code` → 生成一次性码 + 返回 `http://<ip>:<port>/#/pair?t=<code>`
  - `companion_unpair(device_id)`
- 一次性配对码：`opaque_token()` 生成，内存持有，TTL 10min、单次有效。

### 4.4 桌面 UI：设置页 CompanionCard

- 新 `components/CompanionCard.tsx`（照 `ui.tsx` cardClass + Switch + Button 卡片范式），`SettingsPage.tsx` 插一行。
- 内容：启用 Switch → 启用后显示 QR（npm 新依赖 `qrcode`，前端渲染 data URL）+ 地址文字 + 已配对设备列表（名称 / 时间 / 解除）+「重新生成配对码」。
- 文案遵循短文案偏好，说明收进 title。

### 4.5 移动端 SPA（新 workspace 包 `apps/companion/`）

- Vite 第二应用：port 1421、`build.outDir` 指 `apps/desktop/src-tauri/dist-companion`、target safari16；React 19 + Tailwind v4。
- styles.css 自持同款 `@theme` + `[data-theme]` token 块（从 desktop `styles.css` 复制所需段落，token 命名保持一致）。
- 自研约 50 行 hash 路由（无路由库，与桌面自研风格一致）；主题跟随系统 + 手动切换存 localStorage。
- 页面（只读壳）：
  - `#/pair` 读取一次性码完成配对，存 session token（唯一入口，无任何登录页）
  - `#/bugs` 缺陷列表（搜索、状态筛选、分页）
  - `#/bug/:id` 详情：描述、评论、图片走 `/companion/api/media`
  - 设置：主题（独立于桌面）、字号、解除配对、桌面端连接状态（只读展示；无登录功能，掉线只提示等桌面恢复）
- **通知行为（已定：按传输层自动切换）**：
  - 数据：轮询 `/companion/api/notifications`，与本地 localStorage 的 last-seen 比对出「新」条目；手机本地已读状态不写回桌面。
  - 形态按 `window.isSecureContext` 运行时自动切换：**HTTP 局域网 → 页面内通知**（顶部横幅 + 列表入口红点，Android 附加 `navigator.vibrate`）；**HTTPS（隧道）→ 系统级通知**（Service Worker + Web Notification）。同一份前端，无需两套逻辑。
  - HTTPS 系统通知的已知限制：iOS 需「添加到主屏幕」（预留 PWA manifest），Android 国内 FCM 推送不可用、页面关闭时收不到（web 平台固有限制，仅 iOS 可靠）。
  - 点通知 → `#/bug/:id`；处理 / 忽略等按钮属 v1.5 意图动作。
  - 免打扰时段只作用于桌面胶囊；移动端系统通知是否沿用该时段，留 v2 决定。
- **本地偏好（独立于桌面）**：移动端设置项只存手机 localStorage（`companion.prefs`），不与桌面 uiPrefs 同步。v1 项：**主题**（跟随系统 / 浅 / 深，独立于桌面）、**字号**（复用桌面 12–17px 档位，经 `--ui-font-size` 派生 `text-ui-*`）。首帧前读取并 apply（对齐桌面 main.tsx `loadUiPrefs → initAppearance` 时机）；后续新增偏好项沿此机制扩展。
- 数据层 `lib/api.ts` 全相对路径 fetch（同源，隧道即插即用的关键）；30s 轮询（复用桌面 usePoll 思路）；离线 / 未登录有明确空态。
- 布局遵守 `docs/UI_STYLE.md` 契约：真实边框、零阴影、字重≤400、14px 基准。

### 4.6 构建集成

- `src-tauri/Cargo.toml`：+ `rust-embed`（debug 从磁盘读）、`local-ip-address`。
- 根 package.json：`build` 前置 `pnpm -C apps/companion build`；`typecheck` 加 companion。
- tauri.conf.json 不动（frontendDist 仍指桌面 dist）。

## 5. 安全要点

- v1 局域网为明文 HTTP（个人工具可接受）：一次性码 10min TTL + 单次有效 + 配对限速；session token 64hex 只存手机，配置里只存 hash（config.json 本身 0o600）。
- 未登录 → 全部接口返回 `not_logged_in` 语义；桌面退出即伴侣下线，手机端呈现离线态。

## 6. 验证

1. `cargo test`：配对码 TTL / 单次消费、token hash 校验、device 增删（照 server.rs 内嵌 tests 风格）。
2. `pnpm -C apps/companion build && pnpm dev` → 设置页启用伴侣 → QR 出现。
3. 手机同 Wi-Fi 打开（或桌面浏览器 devtools 手机仿真访问 `http://<lan-ip>:<port>`）验证全链路：配对 → 列表 → 详情 → 图片 → 通知横幅（`/companion/api/notifications` 有条目时页面内出现）→ 主题 / 字号切换（独立于桌面，刷新后保留）→ 桌面会话掉线后手机显示掉线态、恢复后自动回到列表 → 解除配对后请求 401。

## 7. 后续扩展点（本期只留缝，不实现）

- **v1.5 写操作**：手机只发「动作意图」（评论 / 状态流转 / Agent 审批），桌面端核心函数执行——与「移动端零执行能力」原则一致，接口形状即桌面命令形状。Agent 手机审批（`awaiting_approval`）是杀手级场景。
- **v2 外网**：cloudflared quick tunnel（`--protocol http2`）或国内 VPS + frp；QR 内容换成隧道 URL 即可，前端零改动；HTTPS 后启用 Service Worker 系统级通知（iOS 加主屏 PWA）。
- **WS 推送**：notification 轮询完成处引入 `tokio::sync::broadcast`，桌面 emit 与 companion WS hub 同源订阅，避免双轮询。

## 8. 实现记录（2026-11-13）

与计划的差异与集成决定（均为架构师验收时拍板）：

- **`/companion/api/notifications` 返回裸数组**（计划初稿的 `{ items, serverTime }` 中 serverTime 无消费方，砍掉；手机端本地 last-seen 即事实源）。
- **`/companion/api/media` 鉴权支持 `t` 查询参数**：`<img>`/`<video>` 无法设置 Authorization 头，会话 token 经 `t=` 传递（与桌面 `/media?token=` 的既有模式同构）；前端 `mediaUrl` 同步拼参。
- **`GET /companion/api/bug` 参数为 camelCase**（`workspaceId`/`bugId`，serde rename_all 统一）。
- **`dist-companion/` 由构建链保证**：根 `build` 先 `build:companion` 再 cargo，release rust-embed 编译期嵌包；debug 运行时读盘、缺失时回占位页；不再用 `.gitkeep`（vite emptyOutDir 会清掉）。
- **配对细节**：一次性码 TTL 10min 单次有效、每 IP 每分钟 >10 次限速；同名设备重新配对覆盖旧 token；`companion_status` 不返回 token_hash。
- **SPA**：无 WS（30s 轮询）；HTTPS 系统通知当前为 Notification API 直发（Service Worker/PWA manifest 留 v2）；`<video>` 在 v1 清洗中禁用（无对应代理入口）。
- **联调修复（2026-11-13 真实环境）**：移动端列表改用 `/companion/api/workspaces`（state 不含项目）；项目下拉显示 `name`（TAPD `prettyName` 是数字 ID）；`fetch_tapd_media` 将站内相对路径（`/tfl/...`）补全到 `TAPD_HOME` 后再过白名单。
- **debug 调试缝**：`GET /dev/companion`（运行态快照）与 `POST /dev/companion/pairing`（生成配对码），debug-only，供自动化测试绕开设置卡。
- **真实环境交互走查（已做，IAB 移动视口 390×844 + 已登录 dev 应用 + Quick Tunnel）**：配对→列表（20 条/15 页）→搜索（关键词 2 条）→详情（信息栅格/短 ID/描述内联截图经媒体代理加载）→翻页（第 2 页）→主题浅/深/跟随系统与字号 14→16px（持久化 `companion.prefs`）→sessionStorage 标签页隔离（新标签页自动回 #/pair）→配对码独占（已消费码二次配对报「配对码无效或已过期」）→Quick Tunnel HTTPS 全链路（`isSecureContext=true`，系统通知分支就位，IAB 宿主 permission=denied 时回落页内横幅）。cargo test 全绿、双端 tsc 通过。桌面端真实手机扫码走查待用户验证。
- **配对码开关（2026-11-13）**：`CompanionConfig.requirePairingCode`（默认 true）。关闭后 `/companion/api/pair` 免码直连（知道地址即门槛，测试阶段便利性换取强度），移动端无码打开自动直连、失败提示扫码；桌面设置卡有「配对码」开关。dev 环境当前已关闭。
- **v2（2026-11-13）**：Agent 任务查看/审核/历史/入队、同事包、缺陷筛选、桌面配置（Agent 执行 + 通知）全部落地。后端 = `POST /companion/api/feature` 白名单代理（18 项：agent_tasks_list/history/enqueue/review_approve/review_stop/review_diff/merge_start/merge_verify/task_cancel/task_retry/config_get/config_set/runtimes/scan/notification_settings_get/notification_settings_set/coworker_list/coworker_select），60 次/分钟限速，白名单外 403；companion.rs 按职责拆为 companion/ 目录（行为保持）。移动端新增底部 tab 导航（缺陷/Agent/设置 + 角标）、待审核卡（summary/files/diff/通过/搁置）、待合并卡、队列/历史/任务详情、同事页多选、缺陷筛选 bottom sheet（statuses/owners 多选 + priority/severity/creator 单选，`companion.bugFilter` 持久化）、入队 sheet（extraPrompt + 运行时选择）、设置页桌面端配置区（Agent 执行含 Worktree 锁定、通知设置即时提交）。真实走查七项 + 白名单拒绝 + `{config}` 包裹形状全部通过（移动端双形状防御覆盖）。cargo test 347 全绿（+6 新增）。
- **v2 明确未做**：终端输出流（桌面无历史回放，仅 PTY 实时流）、agent_scan 安装检测 UI、队列恢复按钮（白名单外，横幅提示桌面恢复）、真机入队（走查止于表单，避免真实启动 Agent）。
- **v2.1（2026-11-13）**：对齐桌面细节 + 请求频次优化。列表默认「我的」（owners=[me]）+ Segmented 切换；筛选处理人/创建人接 `/companion/api/members`（服务端复用 2h 缓存，客户端 30min）；排序控件（created/modified 双向，入 bugFilter）；详情动作区（复制链接 bugUrl、认领=update-field owner+claim、状态流转 sheet、评论）。**请求频次优化**：reqCache SWR（列表键 30s/详情 60s/workspaces 5min/state 15s，fresh 内回列表零请求、stale 先渲染旧值后台刷新、写后精确失效）+ 轮询自适应（Agent 页 8s/其他页 30s）+ 页面隐藏全暂停恢复补一轮 + 频次预算表（reqCache.ts 注释块，后续优化事实源）。后端 6 端点复用 commands.rs 提取的 *_core（356 测试全绿 +9）。真实走查：payload/排序/动作区四入口/端点（members 27 人、transitions 只读）全过；写操作止于表单（真实项目数据不落写）。
- **v3（2026-11-13）扫码入口与隧道生命周期**：左侧栏「设置」上方新增移动端伴侣入口，仅在 `companion.enabled` 时显示；设置页只保留启用 / 配对码开关，不再出现二维码。`CompanionConfig.enabled` 默认改为 `true`（已有显式 `false` 保留）。弹窗默认外网 Quick Tunnel：`companion_cloudflared_check` 用 `shell_path::user_path()` 检测 `cloudflared`，`companion_tunnel_start` 拉起 `cloudflared tunnel --url http://127.0.0.1:<port> --protocol http2 --no-autoupdate`，后台线程解析 stderr 中的 `*.trycloudflare.com`，30 秒未就绪判失败；未安装时弹窗只显示安装教程与「我已安装」，不显示二维码。隧道在扫码 / 关闭弹窗后保持运行，仅在显式停止、停用伴侣或应用退出时清理；`companion_pairing_code(mode)` 支持 `tunnel`（隧道 URL）与 `lan`（测试）两种二维码。**握手 / 心跳**：配对成功即写入内存 presence 并 emit `companion://paired`；手机每 20 秒 `POST /companion/api/heartbeat`，桌面 60 秒内有心跳即在线，emit `companion://presence`；`companion_status.devices` 返回 `online` / `lastSeenAt`，弹窗与手机设置页各自渲染在线状态。新增 Tauri 事件 `companion://tunnel` / `companion://paired` / `companion://presence`。**扫码配对码保留（2026-11-13 修复）**：移动端无会话时不再把 URL 重写成裸 `#/pair`；未配对时 `agent_tasks_list` 轮询直接跳过；401 处理遇到带 `t=` 的扫码 URL 不改写；`PairPage` 直接从 `location.hash` 读取配对码并监听 `hashchange`，Safari 晚到 fragment 也能重新配对。
- **遗留观察**：IAB 的 Playwright click 命中目标不可靠（fill/坐标点击正常），非产品问题；临时端口重启即换 → 手机端重启后需重新扫码（固有行为）。
