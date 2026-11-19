# ZCode 消息流渲染规则

> 分析对象：`zai-org/ZCode` 仓库主干（commit `fec9759`），并与本机安装的桌面端 3.18.2 对照。
> 依据以 `packages/ui/src` 源码为准；`docs/` 下部分规格已被后续实现取代，文中只采用与当前代码一致的结论。
> 关键文件：
> - `packages/ui/src/v4/ConversationTimeline.tsx`
> - `packages/ui/src/v4/ConversationTurnGroup.tsx`
> - `packages/ui/src/v4/ConversationRowView.tsx`
> - `packages/ui/src/v4/conversationTurnRenderUnits.ts`
> - `packages/ui/src/v4/conversationTurnWorkSegments.ts`
> - `packages/ui/src/v4/conversationTurnFlowItems.ts`
> - `packages/ui/src/v4/conversationAssistantWorkItems.ts`
> - `packages/ui/src/ToolCallBlocks/*`
> - `packages/ui/src/components/ai-elements/{message,reasoning,chat-loading}.tsx`

---

## 0. 一句话概括

ZCode 的消息流不是「消息数组逐条渲染」，而是一条派生管线：

```text
ConversationRow[]（协议事实）
  → ConversationTurnRenderUnit（按 turn 合并的渲染单元）
      → ConversationTurnWorkSegment（按 guided input 切开的视觉工作段）
          → ConversationTurnFlowItem（用户输入 / 历史工作 / 正文 / 后续工作）
              → AssistantWorkRenderItem（行 / 配对的子 agent）
                  → ConsecutiveSummaryGroup（连续过程摘要组）
                      → 具体视觉行（用户气泡 / 正文 / 思考 / 工具摘要 / 分隔线）
```

它追求的阅读语义只有一句：

> **用户在上，助手工作在下；助手的工作过程可折叠，但最终答复永远不能被折叠；过程用「一行摘要」表达，而不是一排工具卡。**

由此产生六个最显眼的效果：

1. 一轮 = 一个用户气泡 + 一个助手工作区，助手侧没有头像、没有气泡。
2. 过程默认折叠成一行「已工作 N 秒」，正文永远留在折叠区外。
3. 连续的思考与只读/命令/写文件/会话工具合并成一行统计（如「已查阅 5 项，已执行 6 命令，已修改 3 文件」），展开后才是缩进列表。
4. 运行中不显示顶部状态行，只在底部显示「Orbit + 工作中 + 计时」；结束后顶部才出现折叠入口。
5. 消息之间靠 20px / 56px 的大留白和三级前景色建立层级，不靠卡片、阴影和分隔线。
6. 流式正文从第一帧起 DOM 就是完整文本，只做透明度浮现；语法高亮和图表在完成态才启用。

---

## 1. 事实层：Row

`ConversationRow` 是 CLI 投影出的产品渲染行，不是 provider message。UI 不允许用 role + 数组下标分组。

主要 `kind`：

| kind | 含义 | 是否直接可见 |
| --- | --- | --- |
| `userInput` | 用户输入（真实输入 / steer / 后台结果等） | 是（`/compact` 等 model-only 不产生可见行） |
| `turnHeader` | 轮次头，携带状态、耗时、分段、文件变更等权威事实 | **否** |
| `assistantText` | 助手正文 | 是 |
| `reasoning` | 思考 | 取决于开关与「每轮首条」规则 |
| `toolCall` | 工具调用 | 是（部分工具被过滤或延迟） |
| `subagent` | 子 agent 生命周期行 | 与 Agent 工具行配对后不单独渲染 |
| `timelineMarker` | compact / modelChange / fork / goalVerify 等生命周期标记 | 是（画成居中的分隔线） |
| `artifact` | 轮尾产出物 | 是（轮尾单独卡片） |
| `hookInvocation` | Hook 执行记录 | 否（只进轮尾详情入口） |
| `unreadable` | 无法解析的历史行 | 是（兜底提示） |

每条 row 带 `rowId`（DOM 锚点）、`turnId`（权威轮次身份）、`order`（CLI 全序）。`turnHeader` 是协议边界与诊断事实，永不作为可见行渲染。

---

## 2. 渲染单元：Turn Render Unit

实现：`conversationTurnRenderUnits.ts`。

### 2.1 分组

按 `row.turnId` 顺序收集：

- 第一个 `turnHeader` 记为该轮 header。
- `userInput` 进 `userInputs`。
- `hookInvocation` 进 `hookInvocations`。
- 其余进 `assistantWorkRows`，同时所有非 header 行保持 `orderedRows` 原始全序。

渲染单元的 key 只取 `turnId`，不依赖首行 rowId；冷启动补页导致首行变化时，虚拟列表不会把同一轮当成新节点重挂。

### 2.2 可见性过滤

在构造可见行时剔除：

- `turnHeader`、`hookInvocation`。
- `DeferredToolCall` 且状态为 `inputStreaming`（目标工具尚未确认，不能先画一张临时卡）。
- `reasoning` 且文本为空。
- `toolName === "EnterPlanMode"`（内部模式切换，不是用户价值工具）。
- 「显示待办」关闭时的 `todo` family 工具。

过滤只发生在 UI 渲染单元，不改写协议行；运行态、冷恢复和诊断轨迹仍看得到原始行。

### 2.3 轮顶轻边界

`timelineMarker` 且 `lane === "lightBoundary"`（典型是模型切换）先从工作行中抽出，渲染在用户气泡**之前**，不参与折叠。若该轮只有 marker（`timelineOnly`），不抽轮顶边界，直接作为独立分隔线展示。

### 2.4 轮尾拆分

从工作行尾部向前剥离两类后缀，得到 `tailRows`：

- `timelineMarker` 且 `lane === "turnTailBoundary"`（fork 通知、goal 校验等）。
- `artifact`（分享投影追加的产出物）。

它们必须排在整轮所有局部 UI（文件摘要、操作栏）之后，不能被「已工作」折叠到正文上方。

另外两类特殊行会单独抽出：

- **Browser 自动轮尾截图**：完成态工具行，最终渲染在文件 diff 摘要之后、操作栏之前。
- **Workflow 通知卡**：后台结果轮以工具卡语法的通知行开头时，替换裸标题行。

### 2.5 是否运行中

优先级：

1. 有 header：`executionKind === "controlOnly"` → 恒 false；否则取 `header.state === "running"`。
2. 无 header（冷快照裁掉 header）：session phase 已是终态 → false。
3. 再兜底：存在阻塞完成的工作行（streaming 正文/思考、非后台的 `inputStreaming`/`pendingApproval`/`running` 工具、running 子 agent、running marker）。

后台子任务不阻塞主轮完成。

### 2.6 最终正文

`latestAssistantTextRow` 的选择：

1. 优先取带 `canFork` / `canRetry` 动作的 assistant text（协议已授权的动作目标）。
2. 否则若整轮不在运行中，且 flow 的最后一行是 assistant text，则取它。
3. 否则没有最终正文。

它是整轮唯一挂 copy / fork / retry / feedback 的锚点。整轮没有最终正文时，所有工作行都进入历史并强制展开，避免出现只有「已工作」没有内容的空助手。

### 2.7 保留规则

一个 unit 只有满足以下任一条件才保留：

- 有可见用户输入；
- 有可见工作行；
- 有真正执行过的 Hook；
- 有轮顶轻边界；
- 是 workflow 直接启动轮（由 run 卡代表）；
- 仍在运行。

空轮直接消失，不产生空容器和空间距。

---

## 3. 工作段：Work Segment

实现：`conversationTurnWorkSegments.ts`。

### 3.1 切段

一个 product turn 可以包含多次用户补充（steer / guide）。切段边界**只认** `header.workSegments[].triggerEntityId`：

- 每条被接受的 guide（在 CLI 侧已确认注入）开启一个新的视觉工作段。
- 同一次 FIFO 取出的一批 guide 共用一段。
- 旧快照没有 `workSegments` 时，回退为「上一条不是 guided userInput 就开新段」。

切段不是新 turn：`turnId`、fork 目标、retry 目标都不变。

### 3.2 段内拆分

对每个段：

- `latestAssistantTextRow` 落在该段内 → 该段的 `assistantHistoryRows` 是它之前的行，`assistantFollowingRows` 是它之后的行。
- 段内没有最终正文，但段已完成且最后一行是 assistant text → 用最后一行作为该段外置正文。
- 其余工作行按原序成为 history。

### 3.3 段状态

- `running`：当前段的最后一段，且整轮 running。
- `interrupted`：整轮中断，只落在最后一段。
- `completed`：其余。

`controlOnly` 轮没有工作状态。整轮 `lightBoundary` 不能把 control-only 轮推成「工作中/已工作」。

时长来源优先级：

1. `header.workSegments[].activeMs`；
2. `endedAt - startedAt`；
3. 运行中按 `now - startedAt`；
4. 单段轮回退整轮 `activeMs` / `endedAt - startedAt`；
5. 旧 guide 快照按相邻 guide 的 `createdAt` 边界估算。

### 3.4 默认展开

段默认展开（`assistantHistoryDefaultOpen`）当且仅当：

- 异常终态（`completedInterrupted` / `failed`）：强制展开；
- 是最后一轮且段仍在运行；
- 该轮只有一个段、没有外置正文、但确实有工作行。

其余正常完成、且有最终正文的段默认收起。

---

## 4. 段内流：Flow Item

实现：`conversationTurnFlowItems.ts`。

按 `orderedRows` 原序生成：

| flow item | 内容 | 渲染位置 |
| --- | --- | --- |
| `userInput` | 用户气泡 | 段首（guide 段也是段首） |
| `assistantHistory` | 最终正文之前的工作行 | 折叠区内 |
| `assistantText` | 外置正文 | 折叠区外，永远可见 |
| `assistantWork` | 折叠区外的工作行（最终正文之后） | 折叠区外 |

相邻同类工作行会合并成一个 chunk。段与段之间各自维护折叠状态。

尚未被 CLI 接受的 guide（仍在队列里）不进入消息流：它们作为 pending 列表挂在 live tail 之后，被接受并投影为可见 userInput 后才开启新的工作段。

一个完成态的普通轮因此长这样：

```text
section（pt-14 / pb-5）
├─ 用户气泡
└─ assistant-turn（gap-5）
   ├─ workSegment 1
   │  ├─ 「已工作 12 秒」────────────── 折叠入口（border-b）
   │  ├─ CollapsibleContent            ← 只有这段历史被折叠
   │  │  └─ 已读取 x / 已执行 y …
   │  └─ 最终正文                       ← 永远在折叠区外
   ├─ 文件变更摘要卡
   └─ 操作栏（hover 显示）+ 时间
```

运行中的轮则等价于「折叠入口不存在、历史强制展开、底部有 loading」。

---

## 5. 轮骨架与间距

### 5.1 轮容器

`ConversationTurnGroup.tsx:1482-1491`：

```text
relative mx-auto flex w-full flex-col gap-5
px-4 @md/conversation:px-6
pb-5
pt-14（有用户气泡时） / pt-0（无气泡或首轮被状态面板清空时）
```

- `gap-5` = 20px：轮内用户、工作段、loading 之间的间距。
- `pb-5` = 20px：轮底。
- `pt-14` = 56px：给用户气泡的呼吸；无气泡轮（workflow 启动、后台结果卡）去掉，避免和上一轮 20px 叠成 76px 空白。
- 桌面容器 ≥ md 时水平内边距 16 → 24px。
- 轮内 assistant 容器再套一层 `gap-5`，把「工作流 / 完成卡 / 文件摘要 / 操作栏 / 轮尾行」排开。

### 5.2 消息列宽度

`conversationLayout.ts`：

| 容器宽度 | 宽度 | 最大宽度 |
| --- | --- | --- |
| < 864px | `w-full` | — |
| ≥ 864px | `calc(100% - 6rem)` | `max-w-4xl`（896px） |
| ≥ 1280px | `calc(100% - 24rem)` | `max-w-6xl`（1152px） |
| 新草稿 | — | `max-w-2xl`（672px） |

状态面板展开时整列再左移 168px（`-translate-x-42`），只在 ≥1280px 生效。

### 5.3 用户气泡

`ConversationRowView.tsx:1130`、`ConversationUserInputBubble.tsx:28-31`：

```text
flex flex-col items-end                 ← 整行右对齐
rounded-xl rounded-tr-xs                ← 右上角只有 2px，形成「输入框」方向感
border border-border bg-surface
px-4 py-3
text-ui-base text-foreground
max-w-full @min-[624px]/conversation:max-w-xl
```

- 气泡宽度由内容决定，宿主 ≥624px 时上限 576px。
- 气泡里是**纯文本**（不是 Markdown），但会把 mention 语法还原为 chip：文件/目录、技能、会话、插件、元素、子 agent、命令。
- 只有附件、没有可见文字时不渲染空气泡。
- 长正文默认折叠到 120px，底部 70%→100% 渐隐，居中一个圆形展开按钮；展开/收起 300ms，`prefers-reduced-motion` 下取消。

附件在气泡上方：

- 媒体卡片 80×80、`rounded-xl`，按添加顺序混排；
- 文件与上下文引用是 pill 行，顺序固定：文件 → 评论 → 网页元素 → PPT 元素 → 对话引用；
- 两个区域都右对齐、可换行。

### 5.4 助手正文

没有头像、没有名字、没有气泡，整列宽：

```text
w-full text-ui-base
MessageResponse: text-ui-base leading-[1.75] tracking-wide
```

正文与上方的间距完全由轮容器 `gap-5` 提供，不额外加 margin。

---

## 6. 思考（Reasoning）

### 6.1 可见性

两个条件：

- 设置 `messageStreamShowReasoning` 开启 → 该轮所有 reasoning 可见。
- 关闭 → **每轮第一条 reasoning 仍然可见**，其余隐藏。首条由该轮全序工作行派生出的 `rowId` 决定，不是渲染器本地状态。

隐藏的 reasoning 对「连续过程摘要组」完全透明：前后工具会跨过它继续合并。可见的 reasoning 则是摘要组的成员（参与分组，但不参与工具计数）。

### 6.2 触发器

`reasoning.tsx:270-421`：

- 16px `BrainIcon` + 语义标签 + 可选单行流式摘要 + hover 才出现的箭头。
- 文本全部 `text-ui-base`；图标与标签 `foreground-subtle`，摘要 `foreground-subtlest`。
- 运行中且收起：标签为「正在思考」，带 `animated-gradient-text` 扫光。
- 展开或已完成：标签为「思考」+ `gap-2` + 耗时文案「持续了 N 秒」；没有时长时显示「持续了几秒」。
- 状态标签不使用 `font-medium`，靠颜色而不是字重区分。

### 6.3 流式摘要

运行中收起时，在标签右侧显示单行实时内容：

- 按非空换行边界切快照；同一行内新 token 原位更新。
- 换行时旧行向上退出、新行走「300ms 切换 + 500ms 停留」的纵向队列，最多当前项 + 两条待播项。
- 视口紧跟标签，不用 `ml-auto`；内容增长后自动滚到末尾，最新 token 始终可见。
- 横向溢出时左右各 16px mask 淡出；未溢出时不挂 mask。
- 主线程卡顿、动画关闭或 reduced motion 时直接收敛到最新行。

### 6.4 内容

- 只在用户点击后展开；`streaming → complete` 不覆盖用户的手动选择。
- 纯文本渲染（`whitespace-pre-wrap`），不走 Markdown，避免长思考每 chunk 重解析。
- 最大高度 240px（`max-h-60`），内部滚动，默认吸底；上滚后暂停吸底，回到底部恢复。
- 左侧 1px 导线 + 14px 内边距（`ml-2 border-l pl-3.5`），顶部 12px 留白。
- 内容滚动时才出现上下边缘 mask；在分组内部时去掉自身导线与缩进，由分组统一提供。

---

## 7. 工具行

### 7.1 摘要行解剖

`ToolSummaryRow.tsx` / `ToolLayout.tsx`：

```text
[16px 图标槽] [kind 标签] [类别细节] [主内容] [diff/计数] [状态] [hover 箭头]
```

- 所有字段一行，`gap-2`（8px），不换行；主内容单行截断并使用 tooltip 展示全量。
- 基础字号 `text-ui-base`，普通字重。
- 颜色层级：
  - 图标、kind、动作正文：`foreground-subtle`；
  - 命令、路径、耗时：`foreground-subtlest`；
  - 文件名：`foreground`，文件类型图标保留原色；
  - 子 agent 名称：身份色；
  - 失败/拒绝/停止：语义色。
- hover 时整行非扫光文字用 `-webkit-text-fill-color` 提到 `foreground`；子 agent 身份色除外。
- 运行中：kind 标签做水平扫光（4s 线性无限），工具图标保持静态，不换成旋转 loading。
- 箭头默认 `opacity-0`，hover 或键盘聚焦才出现；展开后旋转 90°。
- 不插入装饰性中点，字段之间只用 8px 间距。

时态文案：

- 运行中：`正在读取` / `正在执行` / `正在写入`；
- 终态：回到类别名 `读取` / `终端` / `写入`，不写「已读取」「已执行」；
- 业务结果优先于生命周期（如 TaskStop 的「已停止」、SendMessage 的「已发送」）。

### 7.2 连续过程摘要组

实现：`conversationAssistantWorkItems.ts`。

**分类**

| 类别 | 包含 |
| --- | --- |
| Explore | 读取、搜索、列目录、网页抓取、只读 shell |
| Run | 全部终端命令、CUA、Node REPL |
| Change | 写入、编辑、打补丁 |
| Session | ListSessions / ReadSession / SendToSession / WaitSessions |
| 不归类 | Workflow、Todo、交互、未识别工具 |

**成员**

- 可成组：`reasoning` + 上述四类工具。
- `reasoning` 只展示，不计数。
- `agentToolCall`（Agent/Task 子代理）不是组成员，是边界。
- 正文、用户消息、交互卡、Workflow、Todo、未归类工具都断组。

**成组阈值**

连续同类（可以混类别）成员 ≥2 才建立父组；只有一项时直接渲染原始工具行，不生成单项父组。

**组头统计**

- 计数：Explore / Run 按**调用次数**；Session 每次调用计 1 次并并入 Run 的命令数；Change 按**去重后的文件数**。
- Change 路径未知时单独计「修改 N 次（路径未知）」，不虚构文件数。
- 失败、取消仍参与计数，不把统计说成成功证明。
- 组未闭合：`查阅 5 项，执行 6 命令，修改 3 文件`。
- 组已闭合（后面出现边界，或整轮结束）：`已查阅 5 项，已执行 6 命令，已修改 3 文件`。
- 只有思考：摘要为「思考」。
- 分隔符是本地化逗号（中文「，」），不是中点。
- 只有 Change 且收起时，组头追加文件 chip：单文件省略「1 文件」，多文件按可用宽度保留前序 chip，其余显示 `+N`。

**组头图标**

按优先级复用第一个命中的工具原始图标：

```text
CUA > Node REPL > Change > Run > Explore
```

纯思考组保留思考图标。

**收起态**

- 组已经闭合：显示静态统计。
- 组仍是「整轮可见内容的末尾」，任务运行中：显示**当前活动项**的完整原始摘要，并纵向翻滚；没有活动项时保留末尾摘要；扫光表示组仍未结束。
- 统计文本单行截断，hover 出完整统计；箭头 hover 才出现。

**展开态**

- 组头永远显示统计。
- 子项列表：

```text
mt-2
ml-2 pl-4                        ← 左侧 8px 处 1px 导线，文字起点 24px
gap-2                            ← 子项间距 8px
max-h-[calc(16lh+30*var(--spacing))]   ← 约 16 行，超出内部滚动
```

- 子项隐藏行首图标与空图标槽，状态标记、文件图标、详情内图标保留。
- 默认吸底；新增子项或尺寸变化重新吸底；用户上滚超过 2px 后保留阅读位置；回到底部恢复。
- 有隐藏内容时显示 24px 上下渐隐 mask。
- 嵌套思考去掉自己的导线、缩进和顶部留白，只保留分组导线。

**间距**

- 工作项之间：4px `gap` + 后续项 12px `padding-top` = 16px。
- 组内子项：8px（`gap-2`，并取消 12px 补白）。
- 组头到子项：8px（`mt-2`）。

### 7.3 工具详情

- 摘要下方 `pt-2`，`CollapsibleContent` 负责高度动画（300ms）。
- 收起时延迟 300ms 卸载内容，先让高度动画读完 `--radix-collapsible-content-height`，避免末帧被外层高度顶成空白。
- 展开状态按 `toolId` 记在 renderer 内存中，虚拟列表卸载再挂载不丢。
- 通用兜底卡：浅底、1px 边框、12px 内边距；分区顺序「参数 → 结果/错误」，分区之间细线；每个区块最大 240px，超出滚动；标题与复制按钮同行；不以完整 JSON 作为默认阅读内容。
- 有专用 renderer 的工具不复用兜底：Read/Edit/Write、Execute、Search、WebFetch、MCP、Agent、CUA、Node REPL、Todo、Workflow、Cron、SendMessage、TaskStop、TaskOutput、RespondToCoordinator 等。

### 7.4 代表性工具形态

| 工具 | 收起态 | 展开态 |
| --- | --- | --- |
| Read | 文件图标 + 文件名（无父目录），hover 显示完整路径 | 代码预览 |
| Edit/Write | 文件 chip + `+N/-N`（数字翻页动画，`tabular-nums`） | 行内 diff / 预览 |
| Execute/Bash | 优先 `input.description`，否则命令原文；命令用 UI sans | `$ command` + 输出/错误（等宽） |
| Search | 查询词 + 结果数 | 搜索摘要卡，常不可展开（ToolSearch） |
| WebFetch | 网页图标 + URL，不展开 | — |
| MCP | `MCP  Server · Action · 终态`；source 是普通文本不是徽标 | 结果 + 二级「查看调用详情」 |
| Agent/Subagent | **单行**：16px 动态头像 + 名称 + 描述 + 状态；不展开 | 点击打开右侧只读子会话 |
| Todo | 一行待办进度摘要 | 关闭「显示待办」时整行不产生 DOM |
| CUA / Node REPL | 动作摘要，图片在展开区单列 | 结果卡 / 代码块 / 截图 |
| TaskStop / TaskOutput | 动作 + task id | 结果与截断提示 |

Agent/Subagent 的补充规则：

- 工具行与 subagent 行按 `parentToolCallId` 精确配对，不按 FIFO；配对后只渲染一条 Agent 摘要。
- 运行中只显示动态头像，不显示「运行中」字样；完成后头像左下叠一个成功勾徽标。
- 子工具生命周期不反向延长父 Agent 的运行态。
- 摘要不可展开；有 `childSessionId` 时整行可点击。

### 7.5 流式与延迟

- Shell 工具在 command 尚未到达时整行不渲染；command 到达后才按真实分类出现，避免先闪一个 Bash 再并入统计。
- `DeferredToolCall` 在 `inputStreaming` 阶段不渲染；参数完整后再按目标工具渲染。
- 运行中的工具保留静态图标 + 文字扫光，避免大量工具同时 streaming 时持续合成动画。

---

## 8. 助手正文（Markdown）

### 8.1 渲染栈

`components/ai-elements/message.tsx`：

- Streamdown 2.5 + GFM，`remark` / `rehype` 插件：
  - CJK 断行；
  - 代码高亮（Shiki，双主题）；
  - 数学（KaTeX，支持单 `$` 启发式）；
  - Mermaid；
- 流式期间关闭语法高亮和 Mermaid；完成态重新解析并开启。
- 特殊链接：`file://`、Windows 盘符路径、已知无扩展名文件名都识别为工作区文件链接，带文件类型图标。
- 渲染失败时降级为纯文本，不阻塞整条消息（错误边界按 markdown 长度重置）。

### 8.2 字号

| 元素 | 规格 |
| --- | --- |
| 正文 | `text-ui-base`（默认 14px），`leading-[1.75]`，`tracking-wide` |
| h1 | `text-ui-xl`（+4px），`font-semibold` |
| h2 | `text-ui-lg`（+2px），`font-semibold` |
| h3–h6 | `text-ui-base`，h3–h4 semibold，h5 medium，h6 normal |
| 标题间距 | 全部 `mt-6 mb-4` |
| 行内代码 | `font-mono text-ui-sm`，背景用 `--color-markdown-inline-code`（= tag 层，不是卡片层），文字继承正文色 |
| 代码块 | 正文默认 14px，由代码预览设置覆盖 |
| 表格 | `text-ui-base`，自身内部横向滚动，不把横向滚动条泄漏到会话 |

### 8.3 链接

- 外链与工作区文件链接统一使用 `icon-blue` 语义色。
- 静止无下划线；hover 恢复细圆点下划线（`decoration-dotted underline-offset-4`）。
- 文件链接是 `inline-flex items-baseline gap-1`，图标与文字同一基线。

### 8.4 表格

- 表格永远在自身容器内横向滚动。
- 默认普通滚动槽；宽表可切换「增强滚动」把滚动区域向左借位、向右延伸到消息根可用边界。
- 长表（高度超过纵向视口 80%）的横向滚动条吸底，并避让输入区/面板/回到底部按钮。

---

## 9. 流式文字浮现

`docs/streaming-markdown-reveal.md` 与 `message.tsx`。

### 9.1 原则

**DOM 文本从第一帧就是完整的，只有透明度在变。**

```text
错误做法：visibleText 逐帧变长
  → 元素高度逐帧增长
  → ResizeObserver 持续触发
  → 虚拟滚动测高与吸底反复改写 scrollTop

ZCode：DOM 文本完整，opacity 动画
  → 高度恒定
  → 不参与测高
  → copy / 搜索 / 恢复始终拿到全文
```

### 9.2 切分

- `Intl.Segmenter` 的 word 粒度；无 Segmenter 时用正则回退。
- 拉丁文按词；含汉字/假名的片段再按码点拆成单字。
- 跳过 `pre` / `svg` / `math` 内的文本（仍计入偏移）。
- 行内 code 整个元素算一个单元，底色与文字一起淡入。
- 列表圆点通过 `li::marker` 的 color 过渡跟随第一个单元。

### 9.3 节奏

- 上游每 30ms 合并一次 delta，渲染端不二次节流。
- 每个单元包一个 `<span data-zcode-reveal>`；纯空白保留文本节点。
- 淡入固定 300ms `ease-out`；延迟按跨帧「浮现时钟」排期：
  - `lag = clamp(max(6 × 到达间隔, 1.5 × 批次间隔), 80, 250)`；
  - 单批最多铺 40ms/单元；排期最多领先当前 250ms；
  - 批次间隔超过 300ms 视为停顿，不更新速率。
- 只有纯追加（`next.startsWith(prev)`）且单帧增量 ≤600 字符才播放动画；快照回填、切会话、模型重写都视为非增量，整段直接出现，绝不裁剪正文。
- 完成时切回 `static`，所有 span 消失；尚未轮到的尾巴直接出现（最多 250ms 的视觉尾巴）。
- `prefers-reduced-motion` 下关闭。

### 9.4 效果口径

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `--zcode-reveal-duration` | 300ms | 逐字/逐词浮现、列表圆点 |
| `--zcode-reveal-ease` | `ease-out` | 同上 |
| `--zcode-enter-duration` | 260ms | 整块入场（预览卡、变更摘要、loading 行） |
| `--zcode-enter-ease` | `cubic-bezier(0.16,1,0.3,1)` | 整块入场 |

---

## 10. 时间线分隔线

`ConversationShareReadonlyTimeline.tsx:200-409`。

```text
flex w-full items-center gap-3 px-4 py-2
左边一条 1px 线（flex-1） | 图标 + 文案（居中） | 右边一条 1px 线（flex-1）
text-ui-base text-foreground-subtle
```

- 线是 `bg-border/50`，不是全宽分割线，让中间文字成为唯一焦点。
- 运行中的 marker 不显示图标，文案用扫光；可点击的 fork 分隔线 hover 变亮并给文字下划线。
- `modelChange`：`模型已切换 A → B`；只有目标没有来源时显示 `正在使用 B`。位置在用户气泡之前。
- `compact`：`正在压缩上下文` / `上下文已压缩` / `上下文已自动压缩` / `上下文压缩失败` / `上下文压缩已中断`；完成态属于 worklog，可被「已工作」折叠；运行态保持可见。
- `forkNotice`：`从对话中派生`，可跳到父会话源消息。
- `goalVerify`：`第 N 次迭代 · 目标校验中/已完成/未完成`，位于被验证轮之后，永不折叠。
- 其它 marker（retryNotice、checkpointRestored 等）默认不渲染。

---

## 11. 轮尾

一轮完成后的固定收尾顺序（`ConversationTurnGroup.tsx:1553-1656`）：

```text
1. Workflow 完成卡
2. Workflow 运行摘要（本轮留下的 run）
3. Cron 自动化成功卡（CronDelete 会撤销对应卡）
4. Off-peak 任务成功卡
5. 文件变更摘要卡（非 Office 模式）
6. Browser 自动轮尾截图
7. 操作栏（hover 显示）
8. Highspeed 页脚
9. turnTailBoundary / artifact（fork 通知、goal 校验等）
```

### 11.1 文件变更摘要卡

- 只在 `header.fileChanges.files > 0` 时出现。
- 40px 高单行卡：折叠箭头 + 「N 个文件已更改」+ `+N`（绿）/`-N`（红）+ 撤销按钮。
- 展开后列出每个文件：路径、增删行数、打开预览/差异。
- `+N/-N` 数字变化使用短字符槽翻页，符号静态，`tabular-nums`；reduced motion 下直接显示目标值。

### 11.2 操作栏

- 默认 `opacity-0`，hover 整轮或 `focus-within` 时出现；手机远控常显。
- 内容：复制 → 赞/踩 → 分叉 → Hook 详情 → 时间 → Bot 投递。
- 复制的是整轮所有 assistant 文本合并后的内容（不是单段）。
- 时间 `text-ui-sm text-foreground-subtlest`，不单独占一行。
- 整轮没有正文但有 Hook 动作或已结束时，操作栏仍可能只含 Hook 入口。

### 11.3 后台结果轮

- 轮首无用户气泡，标题来自 `originMeta.title`（bash / subagent / workflow 白名单）。
- 有 workflow 结构化通知时，标题行替换成工具卡语法的通知行；没有时是 `text-ui-base foreground-subtle` 的裸标题。
- 其余折叠语义与普通轮一致；后台等待时间不计入本轮耗时。

### 11.4 Workflow 直接启动轮

- 用户行是写给模型的规范句，不渲染；整轮由 run 卡代表。
- 无用户气泡 → 顶部 `pt-0`。

---

## 12. 运行反馈

`chat-loading.tsx`、`chatLoadingVisibility.ts`。

- 只在最后一轮、running、且没有阻塞交互时出现。
- 阻塞条件：
  - 等待权限确认或 `AskUserQuestion`；
  - active work 中存在 `compact` 或 `goalVerifier`；
  - 行级兜底：存在 `pendingApproval` 工具、running 的 compact/goalVerify marker。
- 形态：

```text
[16px 图标槽: 20px 点阵 Orbit] [「工作中」扫光] [等宽 tabular 计时]
```

- 计时 1 秒刷新，按权威 `workStatus.durationMs` 起步，本地时钟只做展示插值；一分钟以上显示分秒。
- Orbit 是 105 个点组成的球体，5 秒球体 → 1.3 秒变形为 Z → 停留 → 变回；reduced motion 下直接定格 Z。
- 运行中顶部不显示「工作中」历史状态行，避免重复。

历史状态行（`AssistantHistoryStatus`）：

| 段状态 | 文案 |
| --- | --- |
| running | 顶部不显示；底部 ChatLoading |
| completed + 有时长 | `已工作 12 秒` |
| completed + 无时长 | `已处理` |
| interrupted | `已停止` / `已被新消息中断`（不带耗时） |

形态：整行 `border-b border-border/50 pb-2`，`text-ui-base text-foreground-subtle`，右侧 hover 才出现的箭头；默认展开时箭头不显示。

---

## 13. 滚动与虚拟化

`ConversationTimeline.tsx`、`chat-scroll-bottom-pinning.md`。

- 虚拟滚动单位是 **turn render unit**，不是 raw row；用户和它的助手工作不能被拆散。
- 正在运行的那一轮不进虚拟列表，作为 live tail 留在普通文档流；终态后迁入虚拟历史。
- 只有一个滚动容器；`overflow-x-hidden overflow-y-auto`，`scrollbar-gutter: stable both-edges`。
- 消息层不使用渐隐遮罩；底部 16px 留白在滚动视口之外。
- 吸底是显式状态机：

```text
FOLLOWING（贴底） ⇄ DETACHED（离底）
  离底 > 48px          → DETACHED
  回到底部 / 点按钮 / 发送新消息 → FOLLOWING
  live delta / 折叠 / 测高      → 保持当前意图
  查找 / 导航 / fork 定位        → 先 DETACHED 再定位
```

- 「回到底部」按钮：离底且存在渲染单元时显示，锚定在输入区上方 8px。
- 滚动记忆按 workspace + pane + session 隔离，最多 200 项，只活在当前 renderer 生命周期。
- 会话内容宽度变化时：跟随态同步批量测高并重新贴底；离底态保持阅读位置。
- 左侧轮次导航 rail：容器 ≥864px 且存在 ≥2 条真实用户 query 时显示；每根横条是一条 query，hover 显示 query + 该轮助手摘要，点击按 `rowId` 精确定位。

---

## 14. 影响消息流的设置

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| `messageStreamShowReasoning` | 新用户开启 | 关闭后每轮仍显示第一条 reasoning，其余隐藏 |
| `messageStreamShowTodos` | 关闭 | 关闭时 Todo 工具行完全不产生 DOM |
| 代码预览设置 | 14px | 代码块字号、换行、主题 |

工具聚合不是设置项：当前实现始终按跨类型连续摘要组展示，单项不建组。

---

## 15. 视觉层口径

### 15.1 颜色

- 三级前景：`foreground` → `foreground-subtle` → `foreground-subtlest`。
- 直线与卡片边界：`border` 用中性色 10% 透明度；没有阴影。
- 用户气泡/卡片：`bg-surface`（3%–5% 中性）。
- 运行扫光：`foreground` 在 22% 透明度之间流动；Highspeed 轮改用紫色。
- 语义色只给状态：成功/警告/失败、diff 增删、子 agent 身份色。

### 15.2 圆角与边框

- 用户气泡 `rounded-xl`（12px），右上 `rounded-xs`（2px）。
- 文件卡、工具详情、媒体卡 `rounded-xl`/`rounded-lg`。
- 结构分隔只用 1px 边框或 1px 线；不用 ring、不用阴影伪装边框。

### 15.3 字重

- 正文、工具摘要、思考标签都是 400。
- 仅 Markdown 标题、少量强调使用 600；用户气泡的 mention 名称可使用 500。
- 层级主要靠字号、颜色、留白，不靠加粗。

### 15.4 动效

- 折叠/展开 300ms；整块入场 260ms；逐字浮现 300ms；扫光 4s 循环。
- 所有动效在 `prefers-reduced-motion: reduce` 下关闭。
- 运行态动画只作用于文字/图标，不改变布局高度。

---

## 16. 复刻时必须守住的不变量

1. **最终答复永不折叠**：只要存在最终 assistant text，它必须在折叠区外；没有最终正文时才整轮展开。
2. **一轮一个折叠边界**：折叠入口在轮结束时才出现；运行中只有底部 loading。
3. **过程摘要一行化**：连续思考/工具合并成一行统计；单项不建组；展开后才是列表。
4. **正文和过程分离**：过程在 `CollapsibleContent` 内，正文、文件摘要、操作栏、轮尾 marker 在折叠区外。
5. **状态只表达一次**：运行中顶部不显示「工作中」；结束后顶部显示「已工作」，底部 loading 消失。
6. **异常强制展开**：中断、失败、没有最终正文的轮不得默认收起。
7. **流式不改高度**：正文逐字效果只能是透明度层，DOM 文本始终完整。
8. **代码高亮和图表只在完成态开启**：流式期间保持纯文本块，避免反复重解析。
9. **间距分层**：轮与轮 56/20px，轮内 20px，工作项 16px，组内 8px；不要用卡片和分隔线替代留白。
10. **颜色分层代替字重分层**：三级前景 + 语义色；不加粗、不投影、不堆容器。
11. **隐藏内容不制造空壳**：过滤后的行、空的折叠区、只有 Todo 的历史都不得留下 margin、border 或空 Collapsible。
12. **滚动权归用户**：离底后任何流式更新、折叠、测高都不许把视口拉回底部。

---

## 17. 端到端示意图

```text
┌──────────────────────────────────────────────────────────────┐
│  用户气泡（右对齐，1px 边框 + surface，右上角 2px）           │
│  附件在气泡上方：媒体 80px / pill 行                          │
└──────────────────────────────────────────────────────────────┘
                         ↕ 20px
┌──────────────────────────────────────────────────────────────┐
│ 已工作 12 秒                                            ˅    │  ← 仅完成态
│ ──────────────────────────────────────────────────────────── │
│   ┌ 折叠区（默认收起）                                       │
│   │  查阅 42 项，执行 43 命令                                 │  ← 组头
│   │  ├ 思考 持续了 5 秒                                       │
│   │  ├ 已读取 file.ts                                         │
│   │  ├ 已执行 pnpm test                                       │
│   │  └ …                                                     │
│   └                                                          │
│                                                              │
│  最终答复正文（Markdown，永远可见）                            │
│                                                              │
│  ┌ 文件变更摘要 8 files  +184 -96            撤销 ┐          │
│  └────────────────────────────────────────────────┘          │
│  复制  赞  踩  分叉                              14:32       │  ← hover
└──────────────────────────────────────────────────────────────┘
                         ↕ 20px + 下一轮 56px
```

运行中：

```text
用户气泡
  ┌ 折叠区（强制展开，无顶部状态行）
  │  思考 正在思考 ……
  │  已读取 a.ts
  │  已执行 pnpm test
  └
  ◉ 工作中 8 分 37 秒        ← 唯一运行反馈
```
