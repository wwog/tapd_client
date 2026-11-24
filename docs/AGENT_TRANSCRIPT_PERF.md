# Agent 消息流性能与 60fps 验收

目标：让 Agent 对话区在长会话、流式输出和折叠动画下稳定 60fps，并让「是否卡顿」有可重复的数字，而不是靠肉眼。

## 1. 60fps 合同

| 指标 | 预算 | 说明 |
| --- | --- | --- |
| 帧间隔 p95 | ≤ 18.5ms | 60Hz 下允许一帧抖动（16.7ms 量化） |
| 单帧最大 | ≤ 34ms | 超过 33ms 视为掉 2 帧 |
| Long Task | 0 条 >50ms | 交互期间不允许主线程长任务 |
| 折叠展开起手 | ≤ 60ms | 从点击到第一次高度变化 |
| 滚动漂移 | ≤ 1px | 展开/收起不得让 `scrollTop` 自己移动 |
| 收起间距跳变 | ≤ 1.5px | 折叠卸载前后，最终说明到组头/流程头的间距不得变化 |
| React commit（整条消息流） | ≤ 8ms | 只统计 `Profiler` 的 actualDuration |

布局位移（CLS）单独记录，不参与通过/失败：展开折叠本来就会推动下方内容，这是预期位移，不是滚动抖动。

## 2. 怎么测

### 受控浏览器实验台

```bash
pnpm -C apps/desktop dev      # 终端 1
pnpm perf:agent 8             # 终端 2
```

`scripts/agent-perf-lab.mjs` 会：

1. 起一个独立的 headless Chrome（单独 profile，不碰用户浏览器）；
2. 打开 `apps/desktop/perf.html`，它用真实 `TurnBlock` / `FlowBlock` / `Markdown` 渲染一份固定夹具：
   - 3 个流程、13 条工具、1 段中间说明、1 份 9 节的长 Markdown 最终答复；
   - 容器 900×760，`overflow-anchor: none`；
3. 通过 CDP 驱动「已工作」折叠 8 次开合；
4. 采集 rAF 帧间隔、Long Animation Frame、Long Task、layout-shift、首次高度时间、`scrollTop` 漂移；
5. 按第 1 节预算输出 PASS/FAIL（退出码 1）。

夹具固定、无网络、无 Tauri，适合做「改前/改后」对比和回归。

### 真实应用内的 React commit

`apps/desktop/src/agent/perf.ts` 暴露 `window.__agentPerf`，`AgentWorkspace` 在 dev 下用 React `Profiler` 包住 `MessageStream`：

```js
window.__agentPerf.enable();
window.__agentPerf.mark("open-fold");
// 点击「已工作」
window.__agentPerf.get(); // commits: phase / actualMs / sinceMark
```

WebView 被遮挡时 rAF 会暂停，但 React commit 仍会执行；这一路专门用来区分「React 慢」和「布局/动画慢」。

## 3. 2026-11-18 基线结论

在这台机器、上述夹具、Chrome headless / DPR 2 下：

| 测量 | 结果 |
| --- | --- |
| React 整条消息流 commit | 1–2ms（`baseMs` 277ms，memo 后只重渲染必要子树） |
| 折叠高度每步强制布局 | 0–1ms（内容仅约 100–160px） |
| 帧间隔 p95 / max | 16.8ms / 16.8ms |
| Long Task / LoAF | 0 / 0 |
| 展开起手 | 20–35ms |
| `scrollTop` 漂移 | 0px |
| 收起前后间距（轮 / 流程） | 12px → 12px / 8px → 8px（跳变 0px） |

修复前真实应用里同一个折叠的 `scrollTop` 会随高度动画从 12px 一路涨到 84px：浏览器的 scroll anchoring 在补偿新插入的内容，视觉上就是整段对话往上滑。现在已经在消息滚动容器上关闭 `overflow-anchor`（`MessageStream`），并把 `Collapse` 从双 rAF 改成单 rAF，起手从约 56ms 降到约 30ms。

**结论：当前「已工作」展开不是 React 性能问题，也不是布局计算问题；是滚动锚定 + 动画起手/曲线造成的观感问题。** 已修复；如果后续仍感觉跳，优先检查是否还有别的滚动容器在参与 anchoring，而不是继续加 memo。

## 4. Pretext 能不能用

`chenglou/pretext` 是纯 JS 的多行文本测量/排版库：

- `prepare(text, font)` 用 canvas 一次性测量并缓存断行宽度；
- `layout(prepared, maxWidth, lineHeight)` 纯算术返回行数与高度，不触发 DOM reflow；
- 官方 Markdown chat demo 用它做到「绘制前精确高度 + 只挂载屏幕内消息 + 消息锚定」。

它适合的是：**自己拥有文字排版和绘制**的列表（每行一个绝对定位的 div / canvas / SVG）。

我们现在的消息流不是这个模型：

- 正文是 React + `@uiw/react-md-editor` 的 Markdown，包含表格、代码块、图片、链接、选区；
- 工具行是组件化的折叠卡，不是纯文本行；
- 还有子 agent 递归、todo、审批/提问卡等异构行。

因此 **Pretext 不能直接替换现有渲染**。要吃到它的收益，需要把整个消息流改成「自己测量、自己排线、自己画字」的 canvas/绝对定位模型，这会失去 DOM 选区、链接可访问性、代码块交互，属于重写而不是优化。Pretext demo 自己也在「Not covered」里列了 streaming、selection/find/screen reader 的缺口。

可选的窄用法（暂不做）：

- 只对「纯文本的 assistant 段落」用 Pretext 预估高度，喂给虚拟列表的初始估算；
- 但虚拟列表一旦混合「精确文本高度 + 组件实测高度」，估算误差会让滚动条和锚点跳；Pretext demo 也明确把「估算高度」列为 Tried and dropped。

结论：**暂不引入 Pretext**。先把虚拟列表做成「实测高度」模型；如果未来把 Markdown 渲染层整体换成自绘，再考虑 Pretext。

## 5. 虚拟列表方案（长会话）

当前会话只有 2 轮、约 1.3k DOM 节点，虚拟化不会改变这次展开的手感；它的价值在 100+ 轮后的长效 60fps。

设计约束：

- 虚拟化单位是 **turn**，不是 row：用户气泡、流程、最终说明、文件摘要、操作栏不能被拆散；
- **live tail 不进虚拟列表**：正在运行的一轮留在普通文档流，结束后再迁入虚拟历史；
- 高度用 `ResizeObserver` / `measureElement` 实测，不估算；
- 保留现有滚动所有权（§7 是当前实现，虚拟化不能替换掉其中任何一条）：`overflow-anchor: none`、底部跟随、向上的滚动输入即脱离、滚动记忆、查找/轮次导航的定位型滚动；
- 滚动容器只负责纵向滚动，横向滚动留在表格/代码块内部；
- 首屏和 `content-visibility` 都不算替代方案：前者不解决 DOM 增长，后者仍会布局所有行。

推荐实现路径（与 ZCode 相同）：

1. 用 `@tanstack/react-virtual` 或等价的自研窗口，以 `turn.key` 为虚拟项；
2. 历史轮交给 virtualizer，`measureElement` 回写真实高度；
3. 当前运行轮、pending、审批/提问卡留在虚拟列表之后；
4. 历史前插用「锚定行 + 高度差补偿」，不做逐行 scrollTop 修正；
5. 验收用本实验台扩展到 100/500/2000 轮夹具，记录首屏挂载时间、DOM 节点数、滚动帧间隔、内存。

触发条件：会话轮数 > 30 或 DOM 节点 > 5k 时启用；低于阈值继续全量渲染，避免小会话为虚拟化付出锚定复杂度。

## 6. 收起后的间距跳变

折叠容器是 flex 子项，收起动画结束后会卸载；如果它和最终说明是兄弟节点，卸载会同时移除**两条** flex gap（组头→折叠、折叠→说明），说明会在最后一帧向上跳一个 gap。

修复：组头（`已工作` / 流程 header）和折叠容器放进同一个无 gap 的 wrapper，最终说明只和 wrapper 保留一条固定的 root gap：

```text
[wrapper: 组头 + Collapse]  ← root gap
最终说明
```

- 轮：说明到「已工作」始终 12px；
- 流程：说明到流程 header 始终 8px，与步骤之间的 8px 一致。

实验台同时测量收起前 230ms 与卸载后的间距，任何 >1.5px 的变化都会 FAIL。

## 7. 当前已落地的改动

- `Collapse`：单 rAF、`grid-template-rows` 高度动画 + 内容淡入/上移、收起后卸载、reduced motion 直接切换；
- `MessageStream`：`overflow-anchor: none`、`useLayoutEffect` 吸底、新 prompt 强制吸底、派生/回调 memo；
- 跟尾状态机（`shared/agent/scrollFollow.ts`，两端共用）：向上输入（滚轮上滚 / ↑ PageUp Home / 手指下拉）**在输入事件上**就脱离，不等 scroll —— 否则下一帧的 token 会在 scroll 事件前把视图钉回底部，小幅上滚等于没滚；离底后由 `released` 标记挡住 1~2px 的回弹，只有回到底部 48px 内（或点「跳到最新」、发新消息）才重新吸附。浏览器因内容变矮而夹取 `scrollTop` 不算读者移动。
- 折叠：点开/收起任意 `aria-expanded` 折叠后让位 420ms，落定后若把底部推远就停在原处（不跟），否则继续跟；「跳到最新」会清掉这个让位，不会在 420ms 后被计时器甩开。
- 24px 是「跳到最新」箭头的显示阈值；48px 是重新吸附的距离。嵌套滚动区（工具输出、diff）里的滚轮不改变跟尾状态。
- `TurnBlock` / `FlowBlock` / `LeafRow` / `ThinkingBlock` / `SubagentRow` / `AnswerBlock`：memo + 稳定引用；运行中的思考预览取整行**末尾** 80 字（省略号在前），`truncate` 只裁尾，取头部会让预览在长句上看起来卡住；
- `flows.ts`：已提交流程冻结，live 只克隆最后一个未闭合流程；
- `perf.ts` + `perf.html` + `scripts/agent-perf-lab.mjs`：本文的检测入口。注意实验台把折叠放在中部、不跑跟尾状态机，所以 §3 的 `scrollTop` 漂移预算覆盖的是「折叠自身不移动偏移」，跟尾的脱离/吸附要手工回归。
