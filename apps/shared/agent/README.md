# shared/agent — 桌面与移动端共用的 agent 聊天视图

桌面（`apps/desktop`）与伴侣端（`apps/companion`）渲染同一套会话视图：
轮次折叠块、todo 卡片、子 agent 折叠组、轨迹。组件在这里，两端的差异只留
在数据获取（桌面事件推送、移动端轮询）和注入的回调上。

## 契约

- **类型**：`types.ts` 是结构契约，字段名与
  `crates/dsh-host/src/transcript.rs` 的 serde camelCase 输出一致。desktop 的
  `lib/dsh.ts` 与本文件保持同形（结构类型，直接赋值兼容）。
- **文案**：`labels.ts` 自带 `[zh, en]` 成对目录（`agentLabel(key, locale, vars)`）。
  两端共用的文案只加在这里；单端文案留在各自 app 的 i18n 目录。
- **轮次**：`groupTurns`（`turns.ts`）是唯一的轮次切分实现；
  desktop 的 `src/agent/turns.ts` 只是 re-export。
- **宿主能力**：`host.tsx` 的 `AgentHostProvider` 注入 app 特有的能力
  （Markdown 渲染、用量 chip、本地图片读取）；不注入时全部有纯文本降级。

## 组件

| 文件 | 职责 |
| --- | --- |
| `TodoCard` | 会话级 todo 列表卡片（`todo/write`），流顶部一张，不属于任何轮次 |
| `SubagentGroup` | 一个轮次里的子 agent 折叠组；子会话轮次由宿主经 `renderTurns` 注入渲染 |
| `TurnBlock` | 一个轮次的折叠块（思考/说明/查阅/子 agent/执行/修改 分组 + 失败重试） |
| `MessageParts` | `UserBubble` / `AnswerBlock` / `MessageMeta`（气泡、回答、时间/用量/复制） |
| `TraceRows` | 轨迹行（`ActionRow` / `ReasoningRow` / `ActionIcon`） |
| `actions.ts` | `describeTool` / `runningVerb` / `reasoningPreview` 纯函数 |
| `subagents.ts` | 一个轮次的子 agent 数据纯组装（call↔notice 顺序配对、name 提取、`pending:` 占位、orphans）；宿主经 `ChildSessionInfo` 查询回调解自己的 store，两端配对结果完全一致 |
| `format.ts` | `duration(ms, locale)` / `clock(at)` |
| `clipboard.ts` | `copyText`（纯 DOM，两端的 WebView 都可用） |
| `ScrollingName` | 悬停滑动的单行文本 |
| `trajectory/` | 轨迹面板（时间轴 + 台账 + 检查器 + JSON 树） |
| `turns.ts` | `groupTurns` 轮次切分 |
| `types.ts` | 结构契约 |

## 签名（两端都按这里的路径/签名消费）

```ts
// actions.ts
export function describeTool(name: string, argsJson: string, locale: AgentLocale): ToolAction;
export function runningVerb(kind: ToolAction["kind"], locale: AgentLocale): string;
export function reasoningPreview(text: string): string;

// MessageParts.tsx — 全部接收 locale: AgentLocale，不再用 app 的 t()
export function UserBubble(props: { text: string; locale: AgentLocale });
export function AnswerBlock(props: { text: string; locale: AgentLocale });
export function MessageMeta(props: {
  at: string; text: string; align: "left" | "right"; locale: AgentLocale;
  usage?: AgentUsage; provider?: string; model?: string;
});

// TraceRows.tsx — 同样只吃 locale
export function ActionIcon(props: { action: ToolAction; failed?: boolean });
export function ActionRow(props: {
  name: string; args: string;
  status: "running" | "ok" | "error";
  result?: unknown; locale: AgentLocale; onOpenTrace?: () => void;
});
export function ReasoningRow(props: { text: string; locale: AgentLocale; live?: boolean });

// TurnBlock.tsx — 递归渲染子会话轮次也用它
export type LiveTrace = {
  text: string; reasoning: string;
  tools: Array<{ callId?: string; name: string; args: string }>;
};
export function TurnBlock(props: {
  block: AgentTurnBlock;
  running: boolean;
  live?: LiveTrace;
  locale: AgentLocale;
  /** 桌面：跳轨迹；移动端可 undefined */
  onOpenTrace?: (entry: AgentEntry) => void;
  /** 失败重试由宿主注入（桌面 = agentActions.retryTurn）；不传则不显示按钮 */
  onRetry?: () => void;
  /** 本轮的子 agent 数据，由宿主组装（见 SubagentGroup 的 AgentSubagentChild） */
  subagents?: AgentSubagentChild[];
  /** 一个子会话轮次的渲染（宿主用本组件递归实现） */
  renderTurns?: (child: AgentSubagentChild) => ReactNode;
  /** 受控子折叠；不传用组件内部 state */
  openSubagentIds?: ReadonlySet<string>;
  /** 子折叠开合回调：宿主在此懒加载子会话 transcript */
  onToggleSubagent?: (sessionId: string) => void;
  /** 找不到对应 subagent 工具行的结算通知（老日志），渲染成「收尾消息」行 */
  orphanNotices?: AgentNotice[];
});
```

宿主可以在 `block.entries` 里把 name=="subagent" 的工具行与 notice 行过滤掉，
只传 `subagents` —— TurnBlock 仍会渲染子 agent 折叠组；不过滤也行（组件内部
把这两类行路由进 agents 组，配对成功的 notice 只作为 `settled` 数据消费）。

## SubagentGroup

```ts
export function SubagentGroup(props: {
  subagents: AgentSubagentChild[];
  locale: AgentLocale;
  renderTurns: (child: AgentSubagentChild) => ReactNode;
  /** 受控子折叠；缺省非受控（内部 state） */
  openIds?: ReadonlySet<string>;
  /** 子折叠开合回调（受控/非受控都会触发） */
  onToggleChild?: (sessionId: string) => void;
});
export type AgentSubagentChild = {
  name: string; preset?: string; sessionId: string;
  running: boolean; turns: AgentTurnBlock[];
  loading?: boolean; error?: string;
  settled?: { at: string; summary: string; stopReason?: string; text: string };
};
```

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
`recordIdOf(entry)` 支持 tool 与 notice（`tool:<callId|seq>` / `notice:<seq>`）。

## 宿主 re-export

desktop 的 `src/agent/` 对应文件全部是 re-export 或薄包装（注入 locale、
`agentActions.focusTrajectory` / `retryTurn`、store 的 trajectoryFocus）；
`src/agent/turns.ts` re-export `groupTurns`。旧 import 点不变。

## 所有权与改动规则

- 本目录归「桌面视图」实现方所有；另一端只 import，不直接改这里，
  缺口（缺 prop、缺文案）写进交付报告由主会话汇合。
- 新增共用文案先加 `labels.ts`；不要把单端文案搬进来。
- 样式遵循 docs/UI_STYLE.md：真实边框 ≤2px、无阴影、无 ring、字重 ≤400。
