# shared/agent — 桌面与移动端共用的 agent 聊天视图

桌面（`apps/desktop`）与伴侣端（`apps/companion`）渲染同一套会话视图：
以「流程」为单位的对话、todo 卡片、根级子 agent、轨迹。组件在这里，两端的
差异只留在数据获取（桌面事件推送、移动端轮询）和注入的回调上。

## 契约

- **类型**：`types.ts` 是结构契约，字段名与
  `crates/dsh-host/src/transcript.rs` 的 serde camelCase 输出一致。desktop 的
  `lib/dsh.ts` 与本文件保持同形（结构类型，直接赋值兼容）。
- **文案**：`labels.ts` 自带 `[zh, en]` 成对目录（`agentLabel(key, locale, vars)`）。
  两端共用的文案只加在这里；单端文案留在各自 app 的 i18n 目录。
- **流程**：`flows.ts` 是唯一的投影：按说明（assistant text）切分流程，
  步骤状态（pending / waiting / running / ok / error）也在这里映射成文案。
- **轮次**：`groupTurns`（`turns.ts`）是唯一的轮次切分实现；
  desktop 的 `src/agent/turns.ts` 只是 re-export。
- **宿主能力**：`host.tsx` 的 `AgentHostProvider` 注入 app 特有的能力
  （Markdown 渲染、用量 chip、本地图片读取）；不注入时全部有纯文本降级。

## 组件

| 文件 | 职责 |
| --- | --- |
| `TodoCard` | 会话级 todo 列表卡片（`todo/write`），流顶部一张，不属于任何轮次 |
| `TurnBlock` | 一个轮次的壳：完成态 `已工作`（过程折叠，收起后只剩它和最后一段说明）/ 展开后的根级子 agent + 流程列表 / 运行态 `工作中` / 失败重试 |
| `FlowBlock` | 一个流程：概要行（或运行中的最新步骤）+ 按执行顺序的步骤（思考行 / 工具叶子行）+ 说明（流程自身不折叠说明；整轮 `已工作` 收起时随过程一起隐藏） |
| `SubagentRow` | 根级子 agent 行：description 单行、彩色 icon、展开即子会话 |
| `Collapse` | 折叠高度动画（grid 1fr↔0fr）；收起动画结束后卸载内容，`prefers-reduced-motion` 直接切换 |
| `TraceRows` | 叶子行（`LeafRow` / `ThinkingBlock`）与输入/输出块（可拖高） |
| `MessageParts` | `UserBubble` / `AnswerBlock` / `MessageMeta`（气泡、说明、时间/用量/复制） |
| `flows.ts` | 流程切分、思考时长、概要文案、最新步骤状态映射 |
| `actions.ts` | `describeTool` / `toolGroup` / `runningVerb` / `pendingVerb` / `waitingDetail` / `toolInput` |
| `subagents.ts` | 子 agent 根行纯组装（call↔notice 顺序配对、description、`pending:` 占位、orphans）；宿主经 `ChildSessionInfo` 查询回调解自己的 store，两端配对结果完全一致 |
| `format.ts` | `duration(ms, locale)` / `clock(at)` |
| `clipboard.ts` | `copyText`（纯 DOM，两端的 WebView 都可用） |
| `ScrollingName` | 悬停滑动的单行文本（仅思考预览/标签；工具行用省略号） |
| `trajectory/` | 轨迹面板（时间轴 + 台账 + 检查器 + JSON 树） |
| `turns.ts` | `groupTurns` 轮次切分 |
| `types.ts` | 结构契约 |

## 签名（两端都按这里的路径/签名消费）

```ts
// actions.ts
export function describeTool(name: string, argsJson: string, locale: AgentLocale): ToolAction;
export function toolGroup(name: string, argsJson: string): "reads" | "commands" | "files";
export function runningVerb(kind: ToolAction["kind"], locale: AgentLocale): string;
export function pendingVerb(name: string, kind: ToolAction["kind"], locale: AgentLocale): string;
export function failedVerb(kind: ToolAction["kind"], locale: AgentLocale): string;
export function isWaitingTool(name: string, argsJson: string): boolean;
export function waitingDetail(name: string, argsJson: string, locale: AgentLocale): { verb: string; target: string } | null;
export function toolInput(name: string, argsJson: string): { text: string; meta?: string; diff?: boolean };
export function reasoningPreview(text: string): string;

// flows.ts
export type AgentFlow = {
  key: string; index: number; firstSeq: number;
  thinking: AgentThinking[];
  reads: ToolEntry[]; commands: ToolEntry[]; files: ToolEntry[];
  liveTools: FlowLiveTool[];
  /** 按执行顺序交错的思考/工具步骤（展开层直接渲染这个数组） */
  steps: AgentFlowStep[];
  note?: AssistantEntry; liveNote?: string;
};
export type AgentFlowStep =
  | { kind: "thinking"; key: string; thinking: AgentThinking }
  | { kind: "tool"; key: string; entry: ToolEntry }
  | { kind: "live"; key: string; tool: FlowLiveTool };
export function buildFlows(block: AgentTurnBlock, live: FlowLive | undefined, running: boolean): AgentFlow[];
export function latestStep(flow: AgentFlow, live: FlowLive | undefined, locale: AgentLocale): LatestStep | null;
export function summaryLabel(flow: AgentFlow, locale: AgentLocale): string | null;

// MessageParts.tsx — 全部接收 locale: AgentLocale，不再用 app 的 t()
export function UserBubble(props: { text: string; locale: AgentLocale });
/** `streaming` defers the Markdown pass while tokens append. */
export function AnswerBlock(props: { text: string; locale: AgentLocale; streaming?: boolean });
export function MessageMeta(props: {
  at: string; text: string; align: "left" | "right"; locale: AgentLocale;
  usage?: AgentUsage; provider?: string; model?: string;
});

// TraceRows.tsx — 同样只吃 locale
export function ActionIcon(props: { action: ToolAction; failed?: boolean });
export function LeafRow(props: {
  name: string; args: string;
  status: "running" | "ok" | "error";
  result?: unknown; locale: AgentLocale;
});
export function ThinkingBlock(props: { text: string; locale: AgentLocale });

// TurnBlock.tsx — 递归渲染子会话轮次也用它
export type LiveTrace = { text: string; reasoning: string; tools: Array<{ callId?: string; name: string; args: string }> };
export function TurnBlock(props: {
  block: AgentTurnBlock;
  running: boolean;
  live?: LiveTrace;
  locale: AgentLocale;
  /** 失败重试由宿主注入（桌面 = agentActions.retryTurn）；不传则不显示按钮 */
  onRetry?: () => void;
  /** 本轮的根级子 agent 行，由宿主组装（见 AgentSubagentRow） */
  subagents?: AgentSubagentRow[];
  /** 一个子会话轮次的渲染（宿主用本组件递归实现） */
  renderTurns?: (child: AgentSubagentRow) => ReactNode;
  /** 受控子折叠；不传用组件内部 state */
  openSubagentIds?: ReadonlySet<string>;
  /** 子折叠开合回调：宿主在此懒加载子会话 transcript */
  onToggleSubagent?: (sessionId: string) => void;
  /** 找不到对应 subagent 工具行的结算通知（老日志），渲染成「收尾消息」行 */
  orphanNotices?: AgentNotice[];
});
```

`block.entries` 里保留 `subagent` 工具行与 `notice` 行也行：`buildFlows` 会把
`subagent` 排除出流程，根行由 `subagents` 提供、notice 由 `orphanNotices` 兜底。
配对成功的 notice 只作为子 agent 行的 `settled` 数据消费。

## 完成态的 `已工作` 折叠

整轮结束后，`已工作 N` 是过程折叠项，默认收起：

```
已工作 11 分 17 秒 ▸
最后一次说明（md，始终可见）
```

展开后，根序列（子 agent 行、流程概要、中间说明）出现在 `已工作` 下方一条
左边框里；最后一次说明仍在折叠外、位于过程之后。最后一次说明所属的流程
会通过 `FlowBlock.hideNote` 隐藏自己的副本，避免重复。

运行态没有 `已工作` 折叠：已关闭流程、当前流程的最新步骤、流式说明都直接
可见，`工作中 N` 在轮块底部独立显示。

## 流程展开：按执行顺序

展开**不按类型分组**（思考/查阅/执行/修改分组会丢执行顺序），而是 `flow.steps`
的平铺列表：

```
已执行 4 命令 ▾
  已执行 Test connectivity to finance sites ▸
  已执行 Show current date and time ▸
  思考 16 秒 ▸
  已执行 Fetch today's quotes ▸
```

- 思考行：`思考 n 秒`，展开是思考正文；没有计时时只显示「思考」。
- 工具行：叶子行（verb + `description ?? 目标`），展开是输入/输出块。
- 流程概要仍按类型聚合计数（`已查阅 n 项，已执行 n 命令，已修改 n 文件`）。
- 仅思考且只有一段的流程：流程标题下直接是思考块，不再多一行 `思考 n 秒`；
  多段思考则每段一行。

## 渲染性能：冻结历史，只重算 live

流式 delta 每条都会让宿主重渲染。视图按下面的边界把成本锁在当前轮：

- `buildFlows` 把已提交部分按 `block` 身份缓存；live 只复制最后一个未闭合流程，
  其余流程保持引用不变（见 `flows.ts` 的 `committedFlowCache` / `applyLive`）。
- `TurnBlock`、`FlowBlock`、`LeafRow`、`ThinkingBlock`、`SubagentRow`、`AnswerBlock`
  都是 `memo` 组件；已结束的轮次拿到的 block、流程、行和回调引用不变，直接 bail。
- `MessageStream` 把分组、子 agent 装配、live 过滤和滚动签名都 memo 化；子折叠与
  子会话渲染用稳定回调（ref 读最新状态），避免每个 token 产生新函数击穿 memo。
- 流式正文的 Markdown 走 `useDeferredValue`：store 仍然逐 token 更新，长文解析不堵
  住当前帧；完成态立即切回真实文本。

因此每条 delta 的成本 ≈ 当前流程的新步骤，而不是整条 transcript。

## SubagentRow

```ts
export function SubagentRow(props: {
  row: AgentSubagentRow;
  locale: AgentLocale;
  renderTurns?: (child: AgentSubagentRow) => ReactNode;
  open: boolean;
  /** Receives the child session id, so the parent can pass one stable callback. */
  onToggle: (sessionId: string) => void;
});

export type AgentSubagentRow = {
  name: string;
  /** args.description — the row's single-line title. */
  description: string;
  preset?: string;
  sessionId: string;
  callId?: string;
  /** Root ordering anchor: call seq, or a tail anchor for a live call. */
  callSeq: number;
  running: boolean;
  turns: AgentTurnBlock[];
  loading?: boolean;
  error?: string;
  settled?: { at: string; summary: string; stopReason?: string; text: string };
};
```

子 agent 行属于轮次根序列，不进入任何流程的概要或分组；展开是子会话
transcript，递归同一套 `TurnBlock`。

## trajectory/TrajectoryView.tsx（定稿签名）

```ts
export type TrajectoryViewProps = {
  entries: readonly AgentEntry[];
  locale: AgentLocale;
  /** 实时尾迹（流式中的回复与在途调用）；缺省无 */
  live?: { text: string; reasoning: string; tools: Array<{ callId?: string; name: string; args: string }> };
  /** 加载/失败态；缺省 false。failed 时若给了 onRetry 会显示重试按钮 */
  loading?: boolean;
  failed?: boolean;
  onRetry?: () => void;
  /** 宿主的「从会话跳转到轨迹某行」请求（桌面 = store 的 trajectoryFocus 已按 sessionId 过滤） */
  focus?: { recordId: string; nonce: number } | null;
  /** 检查器形态："panel"（桌面默认，内联右侧栏，可拖宽）| "sheet"（已实现：
   *  position:fixed 底部弹层，圆角上缘、半透明黑 backdrop 点击关闭、上滑入场
   *  动效（prefers-reduced-motion 时停用）、面板与滚动体均 overscroll-contain，
   *  z 层级高于台账）。"sheet" 下选中记录会额外通知 onOpenTrace。 */
  inspectorVariant?: "panel" | "sheet";
  /** inspectorVariant === "sheet" 时选中一条记录的宿主回调 */
  onOpenTrace?: (id: string) => void;
};
export function TrajectoryView(props: TrajectoryViewProps);
```

轨迹子模块同样收 `locale`：`Ledger`（loading/failed/onRetry 可选）、
`Timeline`、`Inspector`（`variant?: "panel" | "sheet"`；`width`/`onWidthChange`
可选，仅 panel 的拖宽需要）、`JsonTree`；
`model.ts` / `projection.ts` 是纯函数（产出文案的函数带尾参 `locale`）。

## 宿主 re-export

desktop 的 `src/agent/` 对应文件全部是 re-export 或薄包装（注入 locale、
`agentActions.retryTurn`、store 的 trajectoryFocus）；`src/agent/turns.ts`
re-export `groupTurns`。旧 import 点不变。

## 所有权与改动规则

- 本目录归「桌面视图」实现方所有；另一端只 import，不直接改这里，
  缺口（缺 prop、缺文案）写进交付报告由主会话汇合。
- 新增共用文案先加 `labels.ts`；不要把单端文案搬进来。
- 样式遵循 docs/UI_STYLE.md：真实边框 ≤2px、无阴影、无 ring、字重 ≤400。
