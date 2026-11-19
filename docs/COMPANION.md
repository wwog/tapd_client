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
                    │  配对码（应用运行期间有效，配对成功不消费）→ session token（Bearer）
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
  - `POST /companion/api/pair`（免鉴权）：配对码换长期 session token；简单内存限速
  - `GET /companion/api/devices`（canManage）：已配对设备、在线状态与管理权限
  - `POST /companion/api/devices/permission`（canManage）：开关其他设备的管理权限
  - `POST /companion/api/devices/unpair`（canManage）：解除其他设备
  - `GET /companion/api/state`：`{ loggedIn, version, me, workspaces 概要 }`
  - `GET /companion/api/bugs`：参数同桌面 `BugQuery` → `BugListPage`
  - `GET /companion/api/bug`：`workspace_id + bug_id → BugDetail`（含评论）
  - `GET /companion/api/media?url=`：服务端复用 `server/proxy.rs` 媒体拉取逻辑，加 TAPD 域白名单，session 鉴权
  - `GET /companion/api/notifications`：镜像桌面通知条目（复用 notification 模块现有状态，只读；判定 / 去重 / 免打扰逻辑不移动）
- **复用而非 MCP**：把 `commands.rs` 中 `bug_list`（L296）、`fetch_bug_detail`、`workspace_context` 等命令核心逻辑提取为 pub async fn（命令壳不变，行为保持拆分），companion handler 直接调；`observe=false`（手机刷新不抑制桌面通知）。

### 4.2 配对持久化（config.json）

- `tapd-core` `AppConfig` 新增 `companion: CompanionConfig`（serde default 向后兼容）：`enabled: bool` + `devices: Vec<{ id, name, token_hash, paired_at, can_manage }>`（有界小列表，按惯例进配置而非 sqlite）。`devicePermissionsInitialized` 是一次性迁移标记：老配置首次加载时把第一台设备设为 `canManage=true`，之后用户显式撤销不会被重启恢复。
- 写入一律走 `state.update_config`（state.rs:47 惯例）；`token_hash` 用已有 sha2 存 sha256；手机端 token 存 localStorage（读写兼容旧 sessionStorage，重新打开链接直接恢复会话；桌面解绑或重配对换 token 才失效）。
- 解除配对 = 删 device 项，手机下次请求 401；`RunEvent::Exit` 关 listener（内存一次性码自然消亡）。
- 配对码是「门钥匙」不是「票据」：配对成功不消费、打开弹窗重新出码时复用现有码，所以同一条链接在应用运行期间始终能重新配对（浏览器丢了 token 的设备靠它回来）；应用退出即作废（隧道也会换新域名）。

### 4.3 局域网 IP 与 QR（Tauri commands）

- 新依赖 `local-ip-address`：取首个私有 IPv4，多网卡取默认路由优先。
- lib.rs `generate_handler` 追加：
  - `companion_status` → enabled / port / lan_ip / devices（含 `canManage`）
  - `companion_enable` / `companion_disable`
  - `companion_pairing_code` → 生成一次性码 + 返回 `http://<ip>:<port>/#/pair?t=<code>`
  - `companion_unpair(device_id)`
  - `companion_set_device_manage(device_id, can_manage)`
- 一次性配对码：`opaque_token()` 生成，内存持有，应用运行期间有效、单次有效；每次配对成功后弹窗自动生成新码。

### 4.4 桌面 UI：设置页 CompanionCard

- 新 `components/CompanionCard.tsx`（照 `ui.tsx` cardClass + Switch + Button 卡片范式），`SettingsPage.tsx` 插一行。
- 内容：启用 Switch → 启用后显示 QR（npm 新依赖 `qrcode`，前端渲染 data URL）+ 地址文字 + 已配对设备列表（名称 / 时间 / 管理权限开关 / 解除）+ 多设备说明。
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

- v1 局域网为明文 HTTP（个人工具可接受）：配对码应用运行期间有效（可重复用于重配对，出码即新码替代）+ 配对限速；session token 64hex 只存手机 localStorage，配置里只存 hash（config.json 本身 0o600）。借用设备的语义从「关标签页失效」变成「桌面解绑才失效」。
- 未登录 → 全部接口返回 `not_logged_in` 语义；桌面退出即伴侣下线，手机端呈现离线态。

## 6. 验证

1. `cargo test`：配对码单次消费、token hash 校验、device 增删（照 server.rs 内嵌 tests 风格）。
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
- **`dist-companion/` 由构建链保证**：根 `build` / `dev` / `check:rust` / `test:rust` 都先 `build:companion` 再动 cargo，release rust-embed 编译期嵌包；debug 运行时读盘、缺失时回占位页；不再用 `.gitkeep`（vite emptyOutDir 会清掉）。**CI 2026-11-13 修复**：GitHub Actions 上 `dist-companion/` 不存在导致 `RustEmbed` 编译失败，补完上述脚本前缀后 check/test job 只需 `pnpm check:rust` / `pnpm test:rust`；release job 增加显式 `pnpm build:companion` 步骤（发布包必须内嵌真实 SPA，不能落到占位页）。
- **配对细节**：一次性码应用运行期间有效（配对成功不消费，重出码时复用现有码）、每 IP 每分钟 >10 次限速；同名设备重新配对保留原 id 与管理权限，只轮换 token；`companion_status` 不返回 token_hash。**多设备权限**：第一台配对设备默认 `canManage=true`，其余默认 false；电脑端可开关任意设备（包括第一台）；手机端管理员只能开关/解除其他设备，不能改自己；不自动继承，允许暂时没有手机管理员。
- **SPA**：无 WS（30s 轮询）；HTTPS 系统通知当前为 Notification API 直发（Service Worker/PWA manifest 留 v2）；`<video>` 在 v1 清洗中禁用（无对应代理入口）。
- **联调修复（2026-11-13 真实环境）**：移动端列表改用 `/companion/api/workspaces`（state 不含项目）；项目下拉显示 `name`（TAPD `prettyName` 是数字 ID）；`fetch_tapd_media` 将站内相对路径（`/tfl/...`）补全到 `TAPD_HOME` 后再过白名单。
- **debug 调试缝**：`GET /dev/companion`（运行态快照）与 `POST /dev/companion/pairing`（生成配对码），debug-only，供自动化测试绕开设置卡。
- **真实环境交互走查（已做，IAB 移动视口 390×844 + 已登录 dev 应用 + Quick Tunnel）**：配对→列表（20 条/15 页）→搜索（关键词 2 条）→详情（信息栅格/短 ID/描述内联截图经媒体代理加载）→翻页（第 2 页）→主题浅/深/跟随系统与字号 14→16px（持久化 `companion.prefs`）→sessionStorage 标签页隔离（新标签页自动回 #/pair）→配对码独占（已消费码二次配对报「配对码无效」）→Quick Tunnel HTTPS 全链路（`isSecureContext=true`，系统通知分支就位，IAB 宿主 permission=denied 时回落页内横幅）。cargo test 全绿、双端 tsc 通过。桌面端真实手机扫码走查待用户验证。
- **配对码开关（2026-11-13）**：`CompanionConfig.requirePairingCode`（默认 true）。关闭后 `/companion/api/pair` 免码直连（知道地址即门槛，测试阶段便利性换取强度），移动端无码打开自动直连、失败提示扫码；桌面设置卡有「配对码」开关。dev 环境当前已关闭。
- **v2（2026-11-13）**：Agent 任务查看/审核/历史/入队、同事包、缺陷筛选、桌面配置（Agent 执行 + 通知）全部落地。后端 = `POST /companion/api/feature` 白名单代理（18 项：agent_tasks_list/history/enqueue/review_approve/review_stop/review_diff/merge_start/merge_verify/task_cancel/task_retry/config_get/config_set/runtimes/scan/notification_settings_get/notification_settings_set/coworker_list/coworker_select），60 次/分钟限速，白名单外 403；companion.rs 按职责拆为 companion/ 目录（行为保持）。移动端新增底部 tab 导航（缺陷/Agent/设置 + 角标）、待审核卡（summary/files/diff/通过/搁置）、待合并卡、队列/历史/任务详情、同事页多选、缺陷筛选 bottom sheet（statuses/owners 多选 + priority/severity/creator 单选，`companion.bugFilter` 持久化）、入队 sheet（extraPrompt + 运行时选择）、设置页桌面端配置区（Agent 执行含 Worktree 锁定、通知设置即时提交）。真实走查七项 + 白名单拒绝 + `{config}` 包裹形状全部通过（移动端双形状防御覆盖）。cargo test 347 全绿（+6 新增）。
- **v2 明确未做**：终端输出流（桌面无历史回放，仅 PTY 实时流）、agent_scan 安装检测 UI、队列恢复按钮（白名单外，横幅提示桌面恢复）、真机入队（走查止于表单，避免真实启动 Agent）。
- **v2.1（2026-11-13）**：对齐桌面细节 + 请求频次优化。列表默认「我的」（owners=[me]）+ Segmented 切换；筛选处理人/创建人接 `/companion/api/members`（服务端复用 2h 缓存，客户端 30min）；排序控件（created/modified 双向，入 bugFilter）；详情动作区（复制链接 bugUrl、认领=update-field owner+claim、状态流转 sheet、评论）。**请求频次优化**：reqCache SWR（列表键 30s/详情 60s/workspaces 5min/state 15s，fresh 内回列表零请求、stale 先渲染旧值后台刷新、写后精确失效）+ 轮询自适应（Agent 页 8s/其他页 30s）+ 页面隐藏全暂停恢复补一轮 + 频次预算表（reqCache.ts 注释块，后续优化事实源）。后端 6 端点复用 commands.rs 提取的 *_core（356 测试全绿 +9）。真实走查：payload/排序/动作区四入口/端点（members 27 人、transitions 只读）全过；写操作止于表单（真实项目数据不落写）。
- **v3（2026-11-13）扫码入口与隧道生命周期**：左侧栏「设置」上方新增移动端伴侣入口，仅在 `companion.enabled` 时显示；设置页只保留启用 / 配对码开关，不再出现二维码。`CompanionConfig.enabled` 默认改为 `true`（已有显式 `false` 保留）。弹窗默认外网 Quick Tunnel：`companion_cloudflared_check` 用 `shell_path::user_path()` 检测 `cloudflared`，`companion_tunnel_start` 拉起 `cloudflared tunnel --url http://127.0.0.1:<port> --protocol http2 --no-autoupdate`，后台线程解析 stderr 中的 `*.trycloudflare.com`，30 秒未就绪判失败；未安装时弹窗只显示安装教程与「我已安装」，不显示二维码。隧道在扫码 / 关闭弹窗后保持运行，仅在显式停止、停用伴侣或应用退出时清理；`companion_pairing_code(mode)` 支持 `tunnel`（隧道 URL）与 `lan`（测试）两种二维码。**握手 / 心跳**：配对成功即写入内存 presence 并 emit `companion://paired`；手机每 20 秒 `POST /companion/api/heartbeat`，桌面 60 秒内有心跳即在线，emit `companion://presence`；`companion_status.devices` 返回 `online` / `lastSeenAt`，弹窗与手机设置页各自渲染在线状态。新增 Tauri 事件 `companion://tunnel` / `companion://paired` / `companion://presence`。**扫码配对码保留（2026-11-13 修复）**：移动端无会话时不再把 URL 重写成裸 `#/pair`；未配对时 `agent_tasks_list` 轮询直接跳过；401 处理遇到带 `t=` 的扫码 URL 不改写；`PairPage` 直接从 `location.hash` 读取配对码并监听 `hashchange`，Safari 晚到 fragment 也能重新配对。
- **遗留观察**：IAB 的 Playwright click 命中目标不可靠（fill/坐标点击正常），非产品问题；临时端口重启即换 → 手机端重启后需重新扫码（固有行为）。

## 9. 远程终端（v4，2026-11-13）

桌面端的底部终端与手机共用同一批 PTY 会话，所以手机看到的是桌面机器上真实运行的 shell，不是独立的远程登录。

**桌面侧**（`src-tauri/src/terminal.rs`）

- `terminal_create` / `terminal_list` / `terminal_input` / `terminal_resize` / `terminal_close` / `terminal_replay` / `terminal_ticket`，全部走 `feature_command` 的 `terminal_` 前缀；会话上限 8，**到上限时先回收已退出会话**（纯移除，不 kill），因此死标签不会挡住新开。
- 每个会话一个 PTY、一个 16ms 帧批处理写线程、256 KiB 回放环与单调累计字节数 `seq`。`terminal://output` 带 `seq`，`terminal_replay` 返回快照的 `seq`，桌面视图据此丢弃已包含在快照里的实时帧。
- **回放对齐**：回放固定以「reset + 清屏」开头；环形缓冲被截断时从第一个完整行开始，避免手机/桌面重挂时左上角出现半行残字。
- **输入有界**：每个会话按排队字节封顶 1 MiB，超出返回 `terminal.busy` 并记日志；PTY 写入由会话自己的队列线程串行完成，async 路径不阻塞。
- **退出必达**：`wait()` 放在独立 waiter 线程，shell 退出即上报，孙进程仍持有 PTY 也不会让会话永远「运行中」；上报后保留 150ms 排空最后一帧输出再收尾。
- **OSC 标题与 cwd**：解析 OSC 0/2（标题）与 OSC 7（`file://host/path`，percent-decode）并更新 Tab/手机列表的标题与 cwd，序列跨帧分割也能正确拼接。
- 事件：`terminal://output` / `terminal://exit` / `terminal://sessions`；关闭面板不杀进程，退出应用统一回收进程组。

**手机侧**

- `GET /companion/api/terminal/ws?ticket=<ticket>&id=<sessionId>`：先 `feature("terminal_ticket", { id })` 换**一次性票据**（60s、单次、绑定会话），再在同一次加锁里取「回放 + 订阅」，回放与实时输出不重叠、不缺口。旧的 `t=<sessionToken>` 仍兼容，但手机只用票据，长期 token 不再出现在 URL 与隧道日志里。
- 下行 `{"type":"replay"|"data","data":…}`、`{"type":"exit","code":…}`、`{"type":"error","code":…}`；上行 `{"type":"input","data":…}`、`{"type":"resize","cols":…,"rows":…}`。会话不存在时在升级后回一帧 `{"type":"error","code":"not_found"}` 再关闭（浏览器拿不到握手 404）；手机显示「终端已结束」并停止重连。
- 手机页面：`#/terminal` 会话列表（10s 轮询、新建 / 关闭；新建时可选「家目录」或某个项目，选项目则由桌面解析该项目配置的 `repoPath`），`#/terminal/s/<id>` 全屏 xterm + 按键条；断线 1s→2s→4s→…≤10s 回连，页面隐藏时暂停，恢复后重连并由 replay 复位重绘。会话页按 id 独立挂载，切换会话不会残留上一个的退出/结束状态。
- 手机列表 / 新建 / 关闭 / 取票走 `/companion/api/feature` 白名单；输入与尺寸只走 WebSocket，避免逐键 HTTP，也不把 `terminal_input` 暴露成通用代理命令。
- **输入：行输入为默认，直通为全屏程序备用**。Quick Tunnel 实测往返 0.8–2s，逐字符发、逐字符回显在物理上不可能跟手，所以手机端默认「行输入」：命令在手机本机编辑（零延迟），回车时整行 + `\r` 作为一帧发出；Tab / Esc / Ctrl / 方向键会先把当前草稿提交再发送对应序列，保证 shell 行内容与本地草稿一致。标题栏可切「直通」：按键实时下发，适合 vim、less、Agent TUI 等全屏程序。直通模式下按键按 30ms 封顶合并（不是空闲去抖，持续打字也按帧发出），Enter / Tab / Ctrl / Esc 立即发送。桌面端同样按 40ms 封顶合并。服务端每个会话有一个输入队列线程串行写 PTY，逐键不再各起一个阻塞任务，输入顺序保持不变。
- 行输入细节：←/→ 移动本地光标（不发 PTY）；↑/↓ 浏览本机命令历史（`sessionStorage`，最近 50 条，第一次 ↑ 暂存草稿）；输入框可一键切换明文/遮蔽，方便在 `sudo`、`ssh` 等不回显的提示里隐藏内容；模式（行输入/直通）与每个会话的草稿都记在 `sessionStorage`，返回列表再进来不丢。键盘弹起时按键条默认收起，标题栏一个按钮可展开。
- 行输入时 xterm 的 stdin 关闭、点击终端区会聚焦输入框。终端页固定在 `visualViewport` 的 `top/left/width/height` 上（同时监听 `resize` 与 `scroll`），键盘弹起或系统平移视口时整页跟着可视区域走，标题、终端内容、输入框与按键条都不会被键盘盖住或滚出屏幕；固定页自己补 `safe-area-inset-*`，按键条不压 Home 指示条。
- **触摸滚动**：xterm 自带的触摸只用于选区，手指拖动不会滚屏，长输出在手机上无法回看。终端区自行把竖向拖动映射为 `scrollLines`（按行高换算，抬手后 200ms 内有短惯性、停顿后抬手不甩动），右侧滚动条仍归 xterm 自己拖动；滚动期间阻止默认手势与合成 click，结束后不会误聚焦输入框弹键盘。

**安全与限制**

- 门槛与伴侣相同：一次性配对码换 token，解除配对立即失效；WebSocket 另用 60s 单次票据，长期 token 不再进入 URL。隧道开启时远程终端等价于公网可达的桌面 shell，只在可信设备上配对。设备管理接口额外要求 `canManage`，非管理员返回 403。
- 不做独立认证、二次确认、端口转发或可写文件传输；项目文件只有受控编辑（默认关闭，见 §10）。机型上的密码输入建议用遮蔽开关或直通模式。
- 回放是原始输出尾部，不做终端状态序列化；全屏 TUI 中途重挂只能近似重建，手机断线超过 256 KiB 的输出会丢。

## 10. 文件浏览与编辑（v5，2026-11-13；编辑 2026-11-14）

浏览桌面项目配置的本地文件夹，不镜像桌面分屏布局。编辑默认关闭。

- `GET /companion/api/files?workspaceId=&path=`（Bearer）→ `{ root, path, entries, truncated }`；一层目录、dirs-first、隐藏文件带 `hidden` 标记、单目录 5000 条截断。
- `GET /companion/api/file?workspaceId=&path=`（Bearer）→ `{ kind, path, size, mtime, mtimeMs, text, truncated }`；文本 2 MiB 截断，图片 / 音视频只给 kind，50 MiB 以上为 `tooLarge`。
- `GET /companion/api/file/raw?t=<token>&workspaceId=&path=`（查询 token，供 `<img>` / `<video>`）→ 原始字节，支持单段 `Range`。
- `GET /companion/api/file/write`（Bearer）→ `{ enabled }`；`POST /companion/api/file/write-setting { enabled }`（仅 `canManage`）切换桌面配置 `companion.allowFileWrite`，默认 false。桌面伴侣弹窗也提供同一开关。
- `POST /companion/api/file/write { workspaceId, path, text, mtimeMs?, force? }`（Bearer，需开关打开）→ `{ path, kind, size, mtime, mtimeMs }`；`text` 必填，只覆盖已存在的 UTF-8 文本文件（2 MiB），同目录 `create_new` 临时文件 + rename，`mtimeMs` 不一致返回 409 `conflict`，`force` 覆盖；二进制或超限现有文件直接拒绝。
- 路径与桌面同一套 `fs.rs` 解析：根为项目 `repoPath`，只接受相对路径，拒绝绝对路径、`..`、`.git`、NUL 与符号链接逃逸；未配置文件夹返回 `no_folder:`，手机显示「在桌面端项目设置里选择本地文件夹」。
- 手机页面：底部「文件」tab → `#/files?ws=&path=`（项目切换、面包屑、返回上级、隐藏文件开关、目录下钻）→ `#/file?ws=&path=`（文本 / Markdown、图片、音视频、二进制元信息）。预览用 highlight.js 上色（懒加载 chunk，输出经 DOMPurify 清洗后注入）；编辑开启且文件未截断时可切换等宽 textarea 编辑并保存，冲突时提示重新加载或覆盖。表单控件在手机上固定 16px，避免 iOS 聚焦时自动放大页面。

## 11. 本地项目与事项（v6，2026-11-16）

桌面端新增与 TAPD 无关的本地项目；手机端可创建项目、维护事项并查看 Agent 任务。

- 底部新增「事项」tab（`#/local?p=<projectId>`）：项目下拉 + 新建 / 编辑项目（名称与项目规则）、待处理 / 处理中 / 已完成三段、事项新增 / 编辑 / 删除 / 移动 / 标记完成 / 重新打开。交给 Agent 的入口在桌面事项页 / 缺陷页的 `EnqueuePopover`，手机端缺陷详情与事项 sheet 也有「交给 Agent」（补充说明 + 模型）；任务成功后桌面自动把事项置为已完成，手机通过 Agent 任务流水的签名变化静默刷新列表。
- 新建项目时用 `DirectoryPickerSheet` 浏览桌面目录：`local_browse_dirs { path? }` 只列目录，默认 `$HOME`；服务端在列目录前校验路径位于 `$HOME` 或已配置的本地仓库，其余返回 `local.browse.forbidden`。
- 项目 / 事项 CRUD 全走 `/companion/api/feature` 的 `local_*` 命令（无 TAPD 登录门禁），数据在桌面 `local.sqlite3`；手机只是渲染与动作意图，不直接持有文件或数据库。项目规则随项目保存，入队时复制到任务并写进 `quest.json` / 提示词。
- 事项入队走 `dsh_task_enqueue_local`（`EnqueuePopover`，可附加说明），任务字段 `kind: local_item`；桌面把事项置为 `in_progress` 并回传新行。任务与缺陷共用队列，任务页不显示缺陷链接，项目行显示本地项目名。
- 文件 / 终端项目列表：TAPD 项目只有在 `agentConfig().projects[id].repoPath` 非空时才显示；本地项目始终显示；终端新建仍保留「家目录」。文件页额外提供 `__root__`（根目录）源，从 `/` 只读浏览，写接口对根目录返回 403。
- 限制：交给 Agent 前桌面目录必须是带 `HEAD` 的 git 仓库，否则返回明确错误；根目录浏览只读，不能编辑系统文件。

## 12. 内置 Agent 任务（dsh P4，2026-11-16）

内置 Agent 换成 dsh 运行时后，手机端的 Agent 页按任务闭环重做（本条替换 §8 里旧的
`agent_*` 队列命令，旧的队列 / 历史 / 待审核 / 待合并四个子页合并为一个列表）。

- **Agent tab = 统一任务列表 + 队列视图**：顶部「任务 / 队列」切换。「任务」按项目分组
  （TAPD / 本地 / 未关联），每行是 workflow chip（`queued` / `running` / `awaiting_review` /
  `finalizing` / `done` / `failed` / `canceled`）+ 实时运行点 + 行尾删除（bottom sheet 二次确认，
  走 `dsh_task_delete`，运行中被后端拒绝）；动作在任务条上直接给：
  通过（`dsh_task_approve`，之后的提交 / 合并 / 清理 / 回写由桌面 finalizing 链自动完成）、
  重试收尾（`dsh_task_retry_finalize`）、取消（`dsh_task_cancel`，可选 stash）、
  查看文件（`dsh_task_changes`）与 diff（`dsh_task_diff`，文件行点击就地展开，行尾按钮跳内置查看器）。
  「队列」与桌面工作流队列同构：执行中 / 已中断 / 排队中 / 待审核 / 收尾中分组，已中断可「继续」
  （`dsh_task_resume` + 续跑提示词），排队中 / 执行中可取消；入队走 `dsh_task_enqueue_bug` /
  `dsh_task_enqueue_local`（缺陷详情与本地事项的「交给 Agent」bottom sheet：补充说明 + 模型），
  恢复旧会话走 `dsh_task_resume`。失败回合与桌面一样可以重试（`dsh_session_retry`，
  引擎从自己的日志重跑，不重复发提示词）；任务页有「打开缺陷 / 打开事项」跳转与模型信息。
  队列不含 chat 会话（chat 的 workflow 恒为 running，混进来会喂给取消按钮）；queued 行点开
  是来源记录（会话还不存在）；`dsh_prompt` 对 queued 任务直接拒绝（轮次会落回 Queued，
  改动永远进不了审核/合并链）。
- **审批与提问可在手机上回答**：`dsh_pending` 返回所有阻塞请求（approval / question），
  `dsh_approval_answer` / `dsh_question_answer` 直接回执；桌面先登记再发事件，所以手机轮询
  拿到的快照与实时事件一致。Agent tab 角标显示待处理数量。
- **没有实时流**：token 级 `dsh://stream` 只在桌面端消费；手机读已提交的
  `dsh_session_entries`（打开会话时 3s 轮询）和任务列表，不渲染 live 文本。
- **新增 `dsh_*` 白名单**（仍走 `/companion/api/feature`，120 次/分钟/设备，白名单外 403；2026-11-18 由 60 提到 120——实时会话页 entries+sessions+feed+子折叠轮询合计 ~70/min，60 会把手机锁在限速外；**2026-11-20 计数键从 IP 改为设备 token hash**——隧道下所有手机共享 127.0.0.1 一个来源 IP，per-IP 预算实际是全局预算，多设备/多折叠会互相挤爆）：
  - 运行时：`dsh_status` / `dsh_start` / `dsh_stop` / `dsh_sessions` / `dsh_session_entries` /
    `dsh_pending` / `dsh_new_session` / `dsh_prompt` / `dsh_session_cancel` / `dsh_select_model` /
    `dsh_session_mode_get` / `dsh_session_mode_set` / `dsh_approval_answer` / `dsh_question_answer`
  - 任务：`dsh_tasks` / `dsh_task_enqueue_bug` / `dsh_task_enqueue_local` / `dsh_task_approve` /
    `dsh_task_retry_finalize` / `dsh_task_cancel` / `dsh_task_changes` / `dsh_task_diff` /
    `dsh_task_resume`；分组与自由会话：`dsh_projects` / `dsh_chat_worktree`
  - 权限与团队：`dsh_policy_get` / `dsh_policy_set` / `dsh_team_get` / `dsh_team_set`

  白名单以 `src-tauri/src/companion/feature.rs` 的 `ALLOWED_FEATURES` 为准；`dsh_restart`、
  `dsh_task_delete`、`dsh_worktrees`、`dsh_plugins` 等桌面命令不在其中。
- **单一 8 s 轮询**：`lib/dsh.ts` 的 `useAgentFeedPolling`（`FEED_POLL_MS = 8_000`）由 `App`
  挂载一次，同时拉 `dsh_tasks` + `dsh_pending`，用 `useSyncExternalStore` 共享给 tab 角标、
  任务列表与会话页；页面隐藏时暂停，恢复可见立即补一轮。旧的按页 8s/30s 自适应轮询不再承担
  Agent 数据。
- 设置页仍通过 `settings_agent_get` / `settings_agent_set` 改 Worktree 与执行单元；提示词模板与
  模型密钥只在桌面编辑。

