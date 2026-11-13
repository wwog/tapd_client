# 更新日志

# 未发布

## 新增

- 新增 `crates/tapd-workflow`：sans-IO 的工作流核心，包含任务状态机、执行单元调度、审核 / 合并策略、恢复与历史；正常依赖只有 `serde`，启用 `#![forbid(unsafe_code)]`，当前有 92 个测试。桌面端已完整接入：`AgentCore` 只持有 `workflow: Mutex<Workflow>`，`AgentTask` 只是 UI 与持久化视图。
- Agent 任务新增 `source` 字段：记录任务来源（`manual` 手动发起 / `notification` 通知卡「处理」），历史页与恢复后的记录都会展示「来源」。
- Agent 页 →「配置」新增「启动恢复排队」开关：默认开启；关闭后重启仍保留排队任务，但队列保持暂停，等用户手动「继续队列」，不会自动继续执行。
- 启动恢复：登录有效且引导完成后，前端调用 `agent_enter_system`，后端对持久化队列应用恢复规则——`queued` 保留（关闭「启动恢复排队」时保留但暂停）；`preparing/running` 重新排队并标记中断，`attempt + 1`，默认最多自动重试 3 次；`merging` 回到 `awaiting_merge` 并写入「客户端重启，合并已中止」与手动步骤；`awaiting_approval/awaiting_merge` 保留。
- 登录后恢复提示：主界面 header 下方新增 `RecoveryBanner`，展示已重新排队 / 待审核 / 待合并 / 失败数量，可「查看任务」或「知道了」；空报告不展示。
- 进入系统门禁：登录有效 + 引导完成前不加载任务、不初始化工作流；此阶段队列命令返回「工作流尚未初始化，请先进入系统」，避免在登录页后启动持久化任务。
- Agent 页 →「配置」新增「Agent 执行」卡片：Worktree 隔离开关与执行单元。默认关闭且固定单任务；开启后执行单元可调 1–8、默认 2，每个任务在独立 git worktree 中运行。
- Worktree 任务新增「待合并 / 合并中」阶段：审核通过后进入待合并，用户确认后用原 Agent 把任务分支合并回主仓库，并统一回写 TAPD；校验分支已并入当前 HEAD 后才算完成。
- 合并失败提供手动回退：原 Agent 不可用、主仓有未提交改动或同仓库已有合并时，任务保持待合并，展示 `merge.error` 与手动步骤（cd、git status、git merge、冲突解决、测试、TAPD 回写），手动合并后可点「我已手动合并」校验。
- Agent 任务记录新增 `worktreePath` / `worktreeBranch`：合并成功后删除 worktree 目录、保留分支；失败 / 取消 / 待审核 / 待合并保留目录；删除任务记录时清理，重试时新建。
- 缺陷列表右键菜单新增「复制长 ID」：短 ID 用于搜索和展示，长 ID 用于接口、日志等需要完整标识的场景，两者都能直接复制。
- 自动检测本机已安装的 Agent 与版本：启动时每天最多扫描一次，Agent 页「配置」可手动「刷新检测」，结果缓存在 `agent-scan.json`。
- 运行时目录对齐 orca：新增 Grok、Hermes、Kiro、Qoder、OpenCode 2、Droid、Jcode、DeepSeek Harness 等 30+ 个 TUI Agent，并支持检测别名与 argv `--` 终止符。
- 缺陷详情的「补充说明」面板新增「本次任务使用」选择器，可以只为当前缺陷换一个 Agent，不影响默认设置。
- MCP 自动注入扩展到 OMP（`~/.omp/agent/mcp.json`）、Kimi Code（`~/.kimi-code/mcp.json`）、Gemini CLI（`~/.gemini/settings.json`）与 Qwen Code（`~/.qwen/settings.json`），启动这些 Agent 时会像 opencode / Claude / Codex 一样幂等写入 tapd MCP。

## 修改

- Agent 工作流全量迁移到 `tapd-workflow`：`AgentCore` 只持有 `workflow: Mutex<Workflow>` 作为任务状态 / 队列 / 审核 / 合并 / 恢复的唯一 owner，`AgentTask` 只是 UI 与持久化视图；宿主执行 crate 产出的 Effect（worktree / PTY / 导出 / git / SQLite / UI）并以 Input 回执；approve、merge_start、verify_merge 需要的 git 检查在命令路径同步执行。
- 删除宿主重复状态机：`tasks`、`spawn_worker`、`take_next_queued`、`finish_task`、`apply_finish`、`recover_incomplete`、`persist_tasks`、`update_task`、`entered` / `shutting_down` 标志、`wake`，以及 `claim_entry` / `release_entry` / `ensure_entered` 门禁；`AgentCore` 只保留宿主配置、PTY runtimes、hook、scan、storage_error、worktree / persist 锁等平台职责。
- 持久化改由 Effect 驱动：`PersistChanged` / `PersistDeleted` / `PersistPaused` 写现有 `agent_tasks` / `agent_queue_state`，`AppendHistory` 也 upsert 到 `agent_tasks`；写入失败设置 `storage_error` 并在 Agent 页提示，不静默吞掉。
- 关闭语义改为「先停靠、再持久化、最后杀 PTY」：`shutdown` 对工作流应用 `Suspend`，把 `preparing/running` 停靠为 `queued`（`interrupted=true`）、`merging` 停靠为 `awaiting_merge`，`PersistChanged` / `PersistPaused` 同步写入 SQLite 后才回收进程；运行中的任务不再默认判失败，迟到的 `RunFinished` 因状态已不是 `preparing/running` 被核心忽略。
- 启动加载只加载 Agent 配置，不读任务、不启动队列；持久化状态保留到进入系统后再按恢复规则处理。
- 测试：`tapd-workflow` 增至 92 个测试（新增宿主协议 13 个），workspace 测试全部通过，前端 `typecheck` 与 `build` 通过。
- MCP 工具收敛到 10 个：删除 `tapd_export_bug_md`、`tapd_claim_bug`、`tapd_release_bug`、`tapd_request_review` 与 `agent_task_report`；导出并入 `tapd_get_bug`，外部占用与任务回报不再存在。
- `tapd_get_bug` 现在只写 `bug.json` + `assets/`，返回 `warnings` / `downloadedBytes` / `bugJson` / `assetCount` / `skills` / `projectRule` / `prompt`；不再返回缺陷详情内联、`tapdIntegration`、`coworkerSkills`、`externalClaim`，也不再写 `bug.md` / `prompt.md` / `skills/`。
- `skills` 改为 name→SkillRef 的 map：value 的 `path` 是 `SKILL.md` 绝对路径；重名先用 `<coworkerId>/<name>`，仍重名追加序号。`projectRule` 独立返回，不再作为提示词模板变量。
- 修复提示词按复杂度分流：简单任务提交后用 `tapd_add_bug_comment` 评论并用 `tapd_update_bug_status` 更新状态；复杂任务不 commit、不评论、不改 TAPD。内置 Agent 的复杂任务由未提交改动安全网自动进入待审核，审核通过后按提交模板继续。
- Worktree 开启时改为审核 → 合并闭环：所有产生改动的任务（简单或复杂）都进 `awaiting_approval`；简单任务在分支上只 commit，复杂任务保留未提交改动；审核通过后进入 `awaiting_merge`。TAPD 回写统一移到合并成功后由合并 Agent 完成，手动合并步骤也包含回写。
- 队列中存在任何非终态任务时锁定 Worktree 开关；执行单元仍可调整。Worktree 任务的待审核 / 待合并 / 合并中不阻塞新任务，非 Worktree 的待审核仍阻塞单队列。
- 非 Worktree 任务保持单执行队列与原有语义，不出现合并阶段；执行单元固定为 1。
- 删除外部 AI 占用及其在胶囊、缺陷列表、通知里的展示；Agent 完成判定改为进程退出 / 会话 hook / 输出静默兜底，不再依赖 MCP 回报。
- Agent 任务字段 `mdPath` 改为 `jsonPath`，导出目录定位同步调整；旧记录不做迁移。
- Agent 页「配置」重做为单列页面：默认 Agent 改为带检测状态与版本的下拉选择器，运行时参数、生命周期、能力与互通限制按卡片排列，不再使用窄栏长列表。
- Codex、OMP、OpenCode、Claude、Cursor、Gemini、Qwen、OpenClaude、Qoder、Qoder CN、CodeBuddy、Kimi、ZCode 启动时自动安装/刷新会话 hook：Claude 系安装完整的会话、提示词、工具、权限、子 Agent 与结束事件；Codex 同时写入 `hooks.json` 与 `config.toml` 信任哈希；OpenCode 插件上报工具/权限/提问；OMP 使用 `agent_settled` 作为真正的回合结束信号。事件 POST 到桌面端 loopback `/agent/hook`，并把 `sessionId` 写回任务记录。
- Agent 任务头新增运行时状态条：显示当前工具、等待权限/回答、最后消息、模型与子 Agent 数量；状态只存内存，通过 `agent://runtime` 实时推送，任务结束后清空。
- 「打开系统终端」按运行时续接会话：OMP / Kimi / Qwen 用 `--continue`，Gemini 用 `--resume latest`；会话 hook 捕获到 session id 时优先 `--resume <id>` 精确恢复对应的会话。

## 修复

- 复杂改动不再依赖模型主动调用审核工具：任务结束时有本轮新产生的未提交文件就自动进入待审核，忘记调用也不会把改动留在工作区。
- 合并完成判定改为校验分支是否已并入主仓库当前 HEAD（`git merge-base --is-ancestor`），不再以合并进程退出码为准；合并 Agent 退出但分支未并入时保持待合并，不误判成功。
- 合并失败、用户取消合并或客户端重启打断合并时，任务回到待合并并保留 worktree 与分支，不再直接判失败；重启后的合并中任务会带「客户端重启，合并已中止」错误恢复。
- Worktree 创建失败（非 git 仓库、无 HEAD、目录已存在）会明确把任务标为失败并带上 git 错误，不再继续执行。
- 项目管理页的项目卡片不再被挤坏：此前按窗口宽度排两列，详情面板一开、内容区变窄也还是两列，卡片里的「规则」被切掉。现在按内容区自身的宽度切换列数，窄了就排一列，卡片头部始终完整。
- 缺陷详情顶部显示的短 ID 与点击复制的结果一致了：TAPD 的详情接口不返回 `short_id`（只有列表接口返回），此前标题显示长 ID 末 7 位、复制却给完整 19 位。现在解析详情时用长 ID 末 7 位补齐，前端显示与复制也共用同一个取值。
- 顶部胶囊的悬停摘要卡不再时灵时不灵：窗口改尺寸时 AppKit 会重建跟踪区域并误报「指针离开」，摘要卡因此闪烁，甚至一直不再弹出（拖动一下胶囊才恢复）。现在按指针真实位置判断，只有真的移出窗口才收起，并补一次延迟复核，避免漏掉与动画同时发生的真实移出。
- 胶囊展开/收起不再抖动：尺寸和位置改成一次原子 `setFrame` 提交，胶囊固定在窗口顶部中心，不会在窗口变高时被顶上去再落回来。

# TAPD Client v1.1.5

发布日期：2026-11-12

## 新增

- 缺陷详情的状态流转改为弹出工作流表单：按 TAPD 返回的字段（状态、处理人、备注、抄送等）填写，必填项未填不发请求；人员字段从项目成员目录选择，多人员字段用逗号分隔；表单只显示所选下一步的字段，处理人 / 开发人员改派也复用同一套成员目录。
- 外部 AI 占用缺陷时，顶部胶囊展示处理的应用与模型，悬停摘要卡展示对应缺陷；展开后的外部 AI 卡片与缺陷通知卡都提供「查看缺陷」。
- `tapd_export_bug_md` 导出时直接返回修复提示词：包内新增 `prompt.md`，返回值增加 `prompt` / `promptPath`（项目规则、本地仓库、同事技能包一次给全），可选 `instructions` 追加额外要求；导出同时把已启用同事的技能包复制进 `skills/`，并在 `bug.md` 末尾追加「协作同事技能包」章节。`tapd_get_bug` 也返回 `coworkerSkills` 技能包路径。此前技能只注入 `tapd_get_bug_prompt`，而外部 AI 基本不会单独调用它。

## 修改

- 「待审核」与「历史」页的左侧列表也能收起了：工具栏左侧的切换按钮按当前 tab 显示队列 / 列表名称，页面变窄时自动收起，把宽度留给审核详情与记录详情；每个 tab 各自记忆收起状态，窗口变宽不会自动弹回。
- 缺陷列表搜索支持缺陷 ID：输入完整 ID 或列表里的短 ID（可带 `#`）直接定位；纯数字关键词按 ID 精确匹配，其他关键词仍按标题模糊搜索，离线缓存与「处理中」本地筛选同步生效。
- 移除独立工具 `tapd_get_bug_prompt`（工具数 16 → 15）：修复提示词并入 `tapd_export_bug_md`，`tapdIntegration.prompt` 改为指向导出工具；自定义模板 / `kind` / `refresh` 参数一并移除。
- 外部 AI 的交付流程从提示词移到 `tapd_get_bug` 的 `tapdIntegration`：新增 `simple` / `complex` 两段复核条件（简单改动直接 commit 回写；复杂改动先请用户复核测试、确认后再 commit 与回写），`writeBack` 明确「先 commit、再评论、最后改状态」，`claim` 说明 conflict 时停止。`prompt.md` 只保留任务本身与一句指向 `tapdIntegration` 的说明，避免模型把埋在正文里的流程整段跳过。
- 运行信息弹窗改为挂载到窗口根节点，蒙层覆盖整个应用窗口。
- 「运行信息 → 导出诊断包」与「接口历史 → 导出 JSON」先让用户选择导出目录，并优先沿用上次选择的目录；导出成功不再弹 toast，仅失败时提示。
- 自动更新检查从每两小时缩短到每 30 分钟。
- 新手引导改为全屏三步：功能总览（补充同事搭伙与内部 Agent）、基础设置（主题与 MCP 一键接入可直接配置）、选择同事；底部按钮固定在页脚，窗口变小也不会看不到「下一步」。
- 引导完成状态从布尔值改为记录版本号（`onboardedVersion`）：本次引导升到第 2 版，升级后会重新展示一次；以后修改引导只要提升 `ONBOARDING_VERSION` 即可再次触发。设置里的「查看引导」仍可随时重看。

# TAPD Client v1.1.4

发布日期：2026-11-12

## 新增

- 左侧新增「同事」页：可勾选多位内置同事（角色 / 简述 / 技能包），启用后自动把角色与 `SKILL.md` 路径注入 Agent 提示词；支持 `{{coworker}}` 插槽，模板没有时整段追加。页面内附技能征集与 fork → PR 投稿入口。
- 账户与会话页在用户信息下方显示项目仓库地址，可直接在浏览器打开。
- 缺陷列表的处理人筛选支持多选，选中的处理人按任一匹配。
- Agent 运行页的执行队列可以收起：页面空间不足（例如右侧缺陷详情把页面挤窄）时自动收起，把宽度留给终端；窗口变宽不会自动弹回，可从工具栏左侧手动展开。

## 修改

- 外部 MCP 的 `tapd_get_bug_prompt` 与应用内 Agent 共用同事注入：启用的同事角色与 `SKILL.md` 路径会写入返回的提示词。
- Agent 管理从设置页移到 Agent 页的「配置」子视图：运行时选择、参数、生命周期、能力与互通限制平铺显示，不再弹窗。
- 外观主题与缺陷列表的列、筛选、排序偏好改存本地配置：退出登录清空 WebView 存储后仍然保留。

## 修复

- 顶部胶囊不再抢占焦点：悬停摘要卡不用先点一下胶囊，点击胶囊或卡片按钮时主窗口也保持焦点。悬停改由 AppKit 原生监听（WebKit 与 tao 的默认 tracking rect 只给 key window 报悬停），窗口本身不再成为 key window。

# TAPD Client v1.1.3

发布日期：2026-11-12

<!-- force-update -->

## 新增

- Agent 页在本地任务存储（SQLite）不可用时显示错误横幅：历史任务可能读取不到，运行中的变更只保留在内存、重启前可能丢失。

## 修改

- 移除遗留的「等待权限 / waiting_review」状态：Agent 任务状态统一为排队、准备、运行、待审核与终态，运行页的「权限」计数与标记一并删除；旧的 waiting_review 记录会被跳过。权限确认本来就在右侧终端内完成。
- 内部重构：Rust 大模块（Agent、通知、MCP、缓存、会话、服务端、TAPD API / 模型 / 导出等）按职责拆分，并删除无调用的命令、字段与重复实现；命令名、IPC 结构、SQLite 表结构与导出目录保持不变。
- 发布包不再注册 `/dev/*` 调试接口，任意 JS 求值入口只在 debug 构建可用。
- 顶部胶囊的状态刷新从每 6 秒一次放宽到 30 秒一次，与通知轮询同频；Agent 状态改由事件推送，状态没变化时不再重绘。
- 缺陷列表活动行的计时器下放到行内，只有正在处理的少数行每秒刷新；Agent 历史列表按行缓存，加载更多或切换选中不再重绘整个列表。
- Agent 任务状态前后没有变化时不再写 SQLite、不再广播，减少无效 IO 与重渲染。
- 「处理中」视图的详情请求改为串行合并：批量加载进行中收到的写回或刷新只记录一次，本轮结束后补跑，不再并发堆积。
- 缺陷详情的「打开方式」选项按资源类型只请求一次，失败后下次打开再重试。

## 修复

- Agent 在「待审核」时点取消改为「停止并储藏」：保留本轮改动并暂停队列，不再直接丢弃。
- Agent 重试会先检查外部 AI 占用与同一缺陷未结束的任务，冲突时提示而不是重复入队；外部占用期间也不再接受新的本地任务。
- 「只提交」轮次仍有未提交改动时，任务标记为失败，不再显示成功。
- 修复更新下载 / 取消在持锁时重入导致的卡死。
- MCP `agent_task_report` 对不存在或已结束的任务返回错误，不再返回成功。
- 关键词搜索在翻页后输入时不再先用旧关键词请求一次；清空筛选会同步清掉已生效的关键词。
- 表头筛选与资源「打开方式」菜单打开时按 Esc 只关闭菜单，不再连带关闭缺陷详情面板。
- 从列表或通知跳到 Agent 任务后，再次进入 Agent 页不再自动跳回上次的任务或待审核页。

# TAPD Client v1.1.2

发布日期：2026-11-11

## 新增

- 强制更新：发布说明带 `<!-- force-update -->` 标记时，登录页与主界面都会弹出不可关闭的升级模态框，只能升级、重试或退出；要求写入本地配置并跨重启保留，升级检查在启动时立即执行，之后每两小时一次。

## 修改

- MCP「接入 AI 客户端」暂时隐藏 Codex 入口（不提示；后端与 Agent 启动时的注入保持不变）。
- 刷新列表等同于一次静默轮询的前提是列表在前台且窗口有焦点；窗口失焦时的自动刷新不再吞掉通知。

## 修复

- 认领缺陷、或在通知卡上点「处理」自动改派给自己后，不再收到对应 bug 的「转派」通知：客户端自己的处理人写入会被下一轮轮询静默吸收，其他人改派仍照常通知。
- 缺陷列表刷新（手动刷新、30 秒自动刷新、翻页与筛选）现在等同于一次静默轮询：列表里已经出现的缺陷会写入去重状态，之后不会再补发对应通知。
- 暗黑模式下登录页与新手引导显示错乱：`data-theme="light"` 现在会完整重置语义色板（表面、描边、主色与胶囊），固定浅色的页面不再继承暗色背景，登录页右侧二维码不再出现黑底光圈。

# TAPD Client v1.1.1

发布日期：2026-11-11

## 新增

- 缺陷详情顶部的缺陷 ID 可点击复制，反馈与项目 ID 一致：就地对勾提示，不弹 toast。
- 打开缺陷详情时，列表中对应的行保持高亮，关闭面板后恢复。
- 缺陷列表新增「处理中」视图：只有存在内部 Agent 任务或外部 AI 占用时才出现，仅列出这些缺陷，关键词、筛选与排序照常可用。
- 顶部胶囊显示「Agent 运行中 / 待审核」时，鼠标悬停会在下方展开摘要卡：正在处理的项目、缺陷 ID 与标题，移开即收起。
- Agent 执行记录支持右键删除，删除前二次确认；只删除本地记录，不影响导出目录、缺陷与已提交的代码。
- 缺陷列表操作列新增「查看 Agent 任务」图标按钮（仅本地任务），一键跳到 Agent 页对应任务；取消改为纯图标按钮。

## 修改

- 未认领的缺陷也可以发表评论，评论不再受「认领」限制；「认领」只控制修改处理人 / 开发人员与状态流转。
- 列表只有一页时，底部不再显示「上一页 / 下一页」按钮，页码与刷新保留。
- 点击缺陷列表中标题下方的 Agent 活动行不再跳转 Agent 页，行内任意位置（含活动行）都打开缺陷详情。

# TAPD Client v1.1.0

发布日期：2026-11-11

## 新增

- MCP 新增 `tapd_get_bug_prompt`：按缺陷 id 返回可直接使用的修复提示词，复用 Agent 的 `{{变量}}` 渲染、项目规则与已导出的 `bug.md`；默认模板去掉外部客户端无法使用的审核队列，`kind: "agent"` 返回设置里的全局模板，`template` 可完全自定义。默认复用已有导出，`refresh: true` 强制重新导出，导出失败只记入 `warnings`，仍返回提示词。
- MCP 新增外部占用工具 `tapd_claim_bug` / `tapd_release_bug`：外部 AI 开始处理缺陷前登记占用（客户端名 + 模型名），完成后释放；15 分钟无心跳自动失效。
- 所有带项目的 MCP 工具支持 `root` 参数：按项目设置里的「本地文件夹」自动匹配 TAPD 项目，sidecar 默认把自身 cwd 作为软提示填入；`tapd_whoami` 返回 `localProjects` 与 `matchedWorkspaceId`。
- `tapd_get_bug` 额外返回 `tapdIntegration` 提示（回写与占用流程），只作告知，不强制调用。
- MCP 工具数 12 → 16（新增提示词、外部占用与任务回报）；「MCP 服务」新增「MCP 接口文档」：点任一工具名打开，左侧接口列表、右侧显示描述、参数类型、必填项、默认值与约束，可直接复制 `inputSchema`。
- 缺陷列表在标题下方新增活动行：显示「“Zcode”正在使用“Deepseek”进行处理」、创建时间与滚动用时（最多两个单位，如「1小时 5分钟」），不遮挡标题；取消按钮对应释放外部占用、移出本地队列、中断本地任务。
- 外部占用与本地 Agent 队列互斥：本地运行中拒绝外部并通知用户；本地排队中则取消排队任务并提示「“Zcode”接管了「标题」，队列中的 Agent 任务已取消」；占用期间列表只保留查看与取消。
- 活动行 16px 加载动画按缺陷固定、六选一，包含点环与点阵聚合为「T」，支持 reduced-motion。
- 设置页新增「静默完成」配置；切换运行时时自动回填默认命令，提示词要求 Agent 结束时调用 `agent_task_report`。
- 通用 TUI 通过 MCP `agent_task_report` 回报完成；未回报时按输出静默（默认 180s）或进程退出兜底。
- 历史任务新增「打开系统终端」：在 Terminal.app 里 `cd` 到任务仓库并用运行时声明的 resume 参数（opencode/claude `--continue`、codex `resume`）续接同一会话，替代原来的日志回放。
- MCP 客户端卡片新增复制路径与「打开文件夹」，项目设置里的项目 ID 可一键复制；反馈就地显示对勾，不弹 toast。
- 开发环境右键菜单新增「开发测试」：模拟外部队列 / 外部运行 / 本地排队 #1 / 队头执行 / 清除模拟。

## 修改

- Agent 运行时改为 orca 式的通用 TUI 适配：Claude Code、Codex、Cursor、ZCode、Gemini、Qwen、Copilot、Cline、Aider、Goose 都通过 PTY 启动，按 argv / flag / stdin 投递提示词；移除 ACP 传输与 opencode 私有 server，权限确认在右侧内嵌终端完成。
- 不再保留 Agent 日志：终端输出只走实时通道、不落盘，其他临时产物同样不再保留，旧 `agent-logs/` 启动时删除；面板中途打开时用一次 PTY 尺寸抖动让 TUI 整屏重绘。
- Agent 任务改存 `cache.sqlite3`：完整任务在 `agent_tasks.payload`，状态变化只增量 upsert 变化的行；队列暂停标记存 `agent_queue_state`。MCP 审计改存 `mcp_audit` 表，每次调用只插入一行并裁剪到最近 500 条，导出与诊断包仍生成 JSON。
- 任务历史改为服务端分页（每页 50 条，按项目/状态/关键词筛选）；实时状态只推送非终态任务，历史增长后不再全量传输。
- 窗口默认不可拖选，像原生桌面应用；缺陷描述、评论、变更值、diff、配置片段、发布说明与报错等内容区仍可正常选择与复制。

## 修复

- 终端输出改为按显示帧（16ms，单次上限 32KB）合批推送并启用 WebGL 渲染器，修复 TUI 持续重绘时输入延迟数秒的问题。
- 当前用户头像改为每次读取身份信息时从 TAPD 的 `img_src` 重新同步，启动、进入账户页和手动刷新都会更新，不再依赖企业微信扫码面板的缓存；TAPD 域名下的头像统一走本地媒体代理（带会话 Cookie），`viper.tapd.cn` 等子域也能正常显示。
- opencode v2.2+ 的 MCP 配置改为直接写在 `mcp.tapd`，导入时自动把旧的 `mcp.servers` 包装迁移成直接条目，修复启动时的 `Missing key mcp.servers.enabled`。
- 主窗口改为就绪后再显示：几何位置先静默恢复，等首帧绘制完成才显示窗口，暗色主题下启动不再先闪一屏白；原生窗口底色跟随主题，极端情况下（前端加载失败）2 秒后兜底显示。
- `pnpm dev` 下 MCP sidecar 拉起客户端时直接启动同目录的 debug 二进制，不再通过 bundle id 打开已安装版本，修复抢走会话、写到另一份数据目录的问题。

# TAPD Client v1.0.0

发布日期：2026-11-10

首个正式版本，包含 TAPD 工作台、Agent 修复队列、MCP 接入与自动更新。

## AI 胶囊通知

- 新增 MCP 工具 `tapd_notify_user` / `tapd_wait_notification`：AI 可在顶部胶囊唤起通知，并把用户的按钮点击或关闭结果回传给同一工具调用。
- 通用通知格式：`tone`（成功 / 失败 / 警告 / 提示 / 进行中）+ 标题 + 内容块（text / code / fields / progress / divider）+ 最多 4 个动作按钮；支持 `tag` 替换进度卡片。
- AI 通知仅存在于内存，最多 20 条，不写入 SQLite；设置页新增「允许 AI / MCP 唤起通知」与调试面板，可预览配色、内容和动作回执。
- 通知测试数据库升级到 v4（新增 `ai_enabled` 设置列）。

## Agent 审核与提交

- 默认提示词改为「简单改动直接提交，复杂改动先审核」：复杂时 Agent 调用新增的 MCP 工具 `tapd_request_review`，任务进入 `awaiting_approval` 并保留工作区 diff。
- Agent 视图新增「待审核」页：通过后重新入队，使用专用提示词只做核对、提交与 TAPD 回写；停止则按涉及文件 `git stash`（含未跟踪文件），任务取消并持久化暂停队列，可手动「继续队列」。
- 安全网：本轮结束仍有新出现的未提交文件时自动进入待审核；任务未提交时客户端拒绝 `tapd_add_bug_comment` / `tapd_update_bug_status`，确保提交先于 TAPD 回写。
- 主窗口标题栏（更新图标旁）与顶部胶囊显示待审核数量/状态，避免改动被忘记；待审核与队列暂停状态跨重启保留。
- 新增 `{{task_id}}` 提示词变量；MCP 工具数 11 → 12。

## 自动更新

- 启动后检查 GitHub Releases，之后每两小时查询一次，并记录最近检查时间。
- 标题栏更新图标在有新版本时变绿，hover 展示更新日志；账户页是唯一查看完整日志、立即更新或手动下载的入口，点击图标直达该页。
- 更新期间主窗口隐藏且不可打开，顶部胶囊放大 4 倍，依次显示下载进度、解包安装与重启。
- 更新失败时胶囊提供「手动下载 / 取消」；取消后主窗口恢复，可再次重试。
- 顶部更新图标只在检测到新版本时显示（绿色），没有新版本时不占用标题栏。

## 客户端

- 隐藏 WebView 复用 TAPD 登录态，支持企业微信扫码登录、会话失效回退与逐条清理 Cookie。
- 项目切换、我的/全部缺陷、状态/优先级/严重程度/关键词筛选与分页。
- 缺陷列表每 30 秒静默自动刷新，窗口不可见时暂停，恢复可见后立即补一次。
- 离线优先：项目、缺陷列表与详情先读 SQLite 缓存再后台刷新。
- 并排缺陷详情面板：描述、评论、变更记录、附件与内嵌图片/视频预览。
- 顶部胶囊通知：新缺陷/转派/重新打开，默认 30 秒轮询，支持处理、查看、忽略与免打扰；通知设置、去重与游标持久化到 SQLite。
- Agent tab：opencode 串行修复队列、权限审核、复杂改动先审核、日志查看与 Terminal 恢复。
- MCP tab：12 个工具、一键接入 opencode / ZCode / Claude Code / Cursor / Codex，支持策略与调用审计。
- 首启引导、脱敏诊断包、本地数据一键清理。

## 会话与稳定性

- `pnpm dev`（debug 构建）使用独立的 `com.tapdclient.desktop_dev` 数据目录，开发登录态与缓存不再影响已安装版本。
- 任意 TAPD 请求返回 401 或跳转到登录页时，自动退出登录：清理登录标记、离线缓存与 Cookie，隐藏会话窗口并回到扫码登录页。
- 会话 watcher 在 TAPD 退回登录页时同步清除用户身份与缓存；退出保护期结束后会重新评估当前 URL，避免扫码登录被吞掉。

## 构建与发布

- macOS arm64 dmg，`tapd-mcp` sidecar 随 App 打包。
- GitHub Actions 在 `release` 分支产出 dmg artifact；推送 `v*` tag 时发布签名更新包与 `latest.json`。
- 新增 `scripts/release.sh`：版本号、更新日志、合并 `release` 与打 tag 一步完成。
