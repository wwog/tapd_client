# 工作区（Workbench）命名与布局协议

> 面向维护者：工作台每个区域叫什么、布局树怎么存、标签怎么拖、面板怎么接。
> 产品入口与交互见 README；新增面板只需要读 §6。

## 1. 为什么有这层

缺陷属于项目，项目列/项目 tab 是主入口；查代码、看图片原来必须跳编辑器。同时右侧详情、底部终端、左侧项目列是三套各自实现的「挤压容器」：宽度/高度算法不同，相交点不能一起拖，主区打开顺序靠两个静态 grid 模板切换。

本层把「空间怎么分」和「内容是什么」彻底分开：

- **分割树**（`workbench/layout/`）只描述 Split / Group / Tab。
- **面板注册表**（`workbench/panels/registry.tsx`）只描述内容与标题。
- **视图层**（`workbench/components/`）只渲染树、分割条与拖拽。

## 2. 命名

### 2.1 区域

| 中文 | English | 代码 | 说明 |
| --- | --- | --- | --- |
| 工作台 | Workbench | `Workbench` | 标题栏以下整个应用骨架 |
| 标题栏 | Title bar | `TitleBar` | 窗口拖动区、工作流队列入口、更新徽标 |
| 活动栏 | Activity bar | `ActivityBar` | 原 `NavRail`，52px 图标栏 |
| 侧边栏 | Side bar | `SideBar` | 项目列，可折叠/拖宽，保留自动收起 |
| 侧边栏视图 | View | `SideBarView` | 侧边栏里的内容（当前只有项目） |
| 布局区 | Layout area | `LayoutArea` | 分割树占据的剩余空间 |

### 2.2 分割树

| 中文 | English | 代码 | 说明 |
| --- | --- | --- | --- |
| 分割节点 | Split | `SplitNode` | `direction: "row" \| "column"` + children + sizes |
| 组 | Group | `GroupNode` | 标签容器（旧称「挤压容器」） |
| 标签栏 | Tab strip | `TabStrip` | 组顶部 |
| 标签右侧槽 | Tab trailing slot | `ActiveTabExtra` | 标签栏右端；只渲染本组聚焦标签的声明，换标签即换内容 |
| 标签 | Tab | `TabItem` | 预览标签 / 固定标签 |
| 面板 | Panel | `PanelRef` / `PanelHost` | 标签背后的内容实例 |
| 分割条 | Sash | `Sash` | 相邻组之间的拖拽条 |
| 交叉分割条 | Corner sash | `CornerSash` | 十字/T 形交点，一次拖两个方向 |
| 投放区 | Drop zone | `TabDrop` | 整组高亮，拖入即成为该组标签 |
| 拖拽预览 | Drag ghost | `DragGhost` | 跟随指针的标签残影 |

`row` = 子项左右排列（分割条竖直）；`column` = 子项上下排列（分割条水平）。默认组角色只是初始落点，不是固定 id：

- `primary` 主组：主视图，承载页面标签，始终存在。项目页（`bugs` / `local`，带 `projectId`）每个项目一个、可关闭，本地项目标签稳定排在最前，**可被拖入任意组**（重开时在原地聚焦，不搬回主组）；全局页（设置 / Agent / MCP / 项目 / 账号）共用**一个**导航标签，左侧导航切换时替换内容而不是追加，且固定在主组。项目页与导航标签**共存**：点项目或切左侧导航都不会关掉另一边。所有页面都可关闭；主组没有标签时显示欢迎页（淡化的应用图标 + 入口），不再自动补缺陷页。项目页没有活动栏入口，统一从左侧项目列进入，因此活动栏不因项目页高亮（由项目列的行选中表示）。
- `secondary` 副组：右侧，缺陷详情 / 资源管理器 / 文件 / 工作流队列页的默认落点。
- `bottom` 底组：终端默认落点，横跨窗口下方。

标签栏右端的 `ActiveTabExtra` 属于**该组当前聚焦的标签**，而不是组或它的角色：同一个页面被拖到副组后仍带着自己的动作，切换标签就切换槽内内容，没有声明时槽位不渲染。具体声明由 `App` 的 `activeTabExtra(panel)` 决定：项目页（缺陷列表 / 本地事项）声明「新建会话」（绑定该项目的空闲会话，创建后跳到 Agent 页；TAPD 项目需已绑定仓库，规则与 Agent 页的分组一致）；TAPD 项目页另有「打开」（绑定的项目目录），本地项目页另有「新增事项」（打开该页的新建事项弹窗，页面通过 `lib/local.ts` 注册的 opener 提供）；Agent 声明「打开」（选中会话的工作目录：worktree → 仓库 → 聊天临时目录）；其他页面留空。

默认树（`defaultLayout()`）：

```
column [0.68, 0.32]                 split-root
├── row [0.66, 0.34]                split-main
│   ├── group-primary（空 → 欢迎页）
│   └── group-secondary（空）
└── group-bottom（空）
```

DOM 标记（验收 / 自动化用）：`data-workbench-region="layout-area|sash|corner-sash"`、`data-workbench-group-cell`（含 `data-workbench-group` 与空组标记 `data-workbench-group-empty`）、`data-tab-id`、`data-panel-id`、`data-panel-surface`。

### 2.3 面板

| 种类 | id 约定 | 内容 | 关闭 | 单例 |
| --- | --- | --- | --- | --- |
| `page`（全局） | `page:<view>` | Agent/MCP/设置/账号/项目共用一个导航标签；队列页独立单例 | 是 | 导航标签全局一个；队列页一个（默认副组） |
| `page`（项目） | `page:<view>:<projectId>` | 缺陷列表（`bugs`）/ 事项列表（`local`） | 是 | 每个项目一个 |
| `bug` | `bug:<ws>:<bugId>` | 缺陷详情 | 是 | 全局一个，再次打开改目标 |
| `explorer` | `explorer:<ws>` | 资源管理器 | 是 | 按 id（每个项目一个） |
| `file` | `file:<ws>:<path>`（审核页签 `file-diff:<sessionId>:<ws>:<path>`） | 文本/Markdown/图片/音视频/二进制；带 `review` 资源字段时不读缓冲区，而是用 Monaco 内联 diff 对比任务起点（只读，基线取任务的 baseline 提交，当前侧取 worktree 或分支尖端） | 是 | 按 id |
| `terminal` | `terminal:<sessionId>` | 一个 PTY 一个标签 | 是 | 按 id |

## 3. 不变量

1. `SplitNode.children.length >= 2`，`sizes.length === children.length`，非空子项的比例和为 1。
2. `GroupNode.panels` 可以为空，**仅限带 `role` 的规范停靠组**；空组保留自己的比例，重新打开时恢复原尺寸。非 role 组一旦为空，`normalize` 会删除它并把空间还给兄弟。
3. 全局导航页标签固定在 `primary` 组（被拖走会移回来）；项目页与队列页可以留在任意组。项目页每个项目一个，本地项目页稳定排在主组标签栏最前；全局导航页最多一个，多余的全局页在 `normalize` 时收敛成一个。队列页是独立单例（`page:queue`）：不参与导航标签收敛，由标题栏按钮打开、默认落副组，重复打开只选中既有标签。项目页与全局导航标签可以同时在标签栏里，互不关闭。页面可以全部关闭：主组为空时保留卡片并渲染欢迎页（`groupHasBody`/`groupMinSize` 让空主组不塌缩），不再补 `page:bugs`。布局先于登录 / 项目选择写盘，所以恢复出来的旧 `page:bugs` / `page:local` 可能在选择到达后由 `retargetPage` 认领成对应项目的标签。
4. 组内 `activePanelId` 必须指向该组的面板；空组为 `null`。
5. 面板 id 由资源决定（`panelId`），重启后稳定；标签移动不改变 id。
6. 每个面板只挂载一次：`PanelHost` 用 portal 投到所属组，移动标签只换目标节点，内容不重挂载。

## 4. 尺寸与拖拽

- 尺寸以 fraction 存，渲染时按容器像素换算并套最小尺寸。组最小值 = 组内各面板 `PANEL_MIN_SIZE` 的最大值；split 最小值 = 子项最小值之和 + 分割条。空的主组按页面最小值计算（它渲染欢迎页），其他空组贡献 0，因此只有有内容的子项参与分配。
- 布局区测量不能只依赖 `ResizeObserver`：主窗口是隐藏创建、首帧后才显示，首次测量可能为 0。`SplitView` 会在为 0 时按动画帧重试，并在窗口 resize / `visibilitychange` 时补测。
- 分割条统一：静态不画线、8px 命中区、只有 hover 时才让中间的 2px 圆角线高亮（命中区本身不着色）、拖动 `bg-sky-400/60`、双击复位。组间沟槽 6px，线两端按 `GROUP_INSET` 缩进，正好占满沟槽长度、不会高出卡片顶部。侧边栏复用同一组件与同一拖拽内核，只保留折叠/自动收起。
- 交叉点：测量所有分割条矩形，正交相交处渲染 8×8 圆形 `CornerSash`；hover 时同时点亮两根线，拖动的全过程（包括指针跑出手柄）两根线保持 `bg-sky-400/60`，一次拖动同时更新两个 split。T 形（三块交汇）同样处理。
- 拖动回报的是**相对拖动起点的总位移**；`beginSashDrag` 在开始时快照 sizes，所以重复调用不会累加误差。
- 进入动效：右侧 / 底部停靠组从空变为有内容时，按存储比例从 0 展开到目标尺寸（200ms，只插值渲染 rect，不改持久化 fraction，旁边组同步平滑缩放）；页面内容另有 160ms 淡入。`prefers-reduced-motion` 下不展开。
- 打开面板到副组时，如果窗口放不下布局最小宽度，沿用 `ensure_window_width` 向左侧扩窗。扩窗由 `App` 在副组内容变化的那一次渲染里同步预留目标宽度：侧边栏按目标宽度判断自动收起，而不是先按当前窄窗口收起、等 resize 落地后再展开；只有屏幕本身装不下（`ensure_window_width` 返回被钳制的宽度）时侧边栏才真正自动收起。resize 未到达或系统拒绝时 1.2s 后释放预留。
- 侧边栏是否显示取决于 TAPD 项目数、本机隐藏项与本地项目：这三类数据由 `main.tsx` 在首帧前预读（`lib/shellBootstrap.ts`：`app_info`、缓存的项目上下文、本地项目），首帧即定，避免先隐藏再弹出。

## 5. 标签拖拽协议

`TabsDnd = { panelId, fromGroupId, clientX, clientY }`，指针事件实现（不用 HTML5 DnD）。

- **导航创建的页不可拖拽**：共用导航标签（Agent/MCP/设置/账号/项目）与队列单例页固定在各自停靠组，按下不启动拖拽会话；其余标签（项目页、缺陷/事项详情、资源管理器、文件、终端）都可拖。
- 组内：按指针 x 计算插入位置，拖动经过自身不算移动。
- 跨组：整组高亮，放入目标组标签栏末尾并成为该组 active。**没有四边分屏投放**——拖拽不会新建组，只进入已存在的组（空的标准停靠组仍可通过边界条接收投放，它保留的比例就是落位尺寸）。
- Esc / 拖出工作台：取消，不改树。
- 预览标签：单击缺陷行或文件 = `preview: true`；同组下一个同类预览会替换它。双击标签或双击行 = `pinPanel`。

## 6. 面板接入

```ts
// workbench/panels/registry.tsx
type PanelDefinition = {
  kind: PanelKind;
  title: (panel: PanelRef) => string;      // panel.label 优先
  icon: (panel: PanelRef) => ReactNode;
  minSize: PanelSize;
  closable: boolean;
  singleton: "id" | "kind";
  render: (props: { panel; active }) => ReactNode;
};
```

面板组件通过 `usePanelServices()` 取 `toast`、`open`、`copy`、`openPath`、`workspaceName`，以及 `bug` / `terminal` 两个域对象。数据仍由现有 hook 持有（`useDetailPane`、`useTerminalPanel`），面板只负责渲染。

新增一种面板：

1. `layout/types.ts` 的 `PanelKind` / `PanelResource` 加分支，`panelId` / `makePanel` 加映射。
2. `defaults.ts` 的 `PANEL_MIN_SIZE` / `defaultTarget` 加默认值。
3. `panels/registry.tsx` 加定义。
4. 写组件；需要打开别的面板就 `services.open(...)`。

## 7. 持久化

`uiPrefs["workbench.layout.v1"]`：

```ts
type LayoutPrefs = {
  version: 1;
  layout: LayoutState;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
};
```

- 启动先读该键；缺失/损坏 → `defaultLayout()`。旧信封没有 `sidebarCollapsed` 时按未收起处理。
- `sidebarCollapsed` 只记用户主动收起；窗口太窄的自动收起仍是派生态，不落盘。
- 旧 `terminal.panel.v1`（`{ open, height }`）迁移：`open` 为真时生成一个终端面板放进底组。
- 归一化：未知面板丢弃、非 role 空组删除、单子 split 提升、比例重新配平、active 指针修复。
- 资源管理器展开目录存 `uiPrefs["explorer.tree.v1"]`（`{ [workspaceId]: string[] }`）。

## 8. 文件能力（读 / 写）

Rust `src-tauri/src/fs.rs`：

- 根 = `agent.json` 的 `projects[workspaceId].repoPath`；未配置直接报错。
- 两个特殊根：`__root__` = 文件系统根（只读浏览，`fs.rs` 自带凭据黑名单），`__session__:<sessionId>` = 该 Agent 会话的工作目录（自由会话的 `<data>/dsh/chats/<id>`、任务的 worktree，回退到仓库）。Agent 回复里的本地路径由 `dsh::files::resolve` 映射到项目根 / 会话根 / `__root__` 之一，桌面据此在副组打开文件标签；会话根同样走 `resolve_in_root` 的包含检查。
- 所有入参只接受**相对路径**；`resolve_in_root` 拒绝绝对路径、`..`、NUL、非 UTF-8，canonicalize 后按组件比较，拒绝符号链接逃逸；规范化后的路径再按组件（忽略大小写）拒绝 `.git`，大小写变体与 `docs -> .git` 这类符号链接别名同样挡住。
- `fs_list`（一层，dirs-first，5000 条截断）、`fs_read`（文本 2 MiB 截断；`text/markdown/image/audio/video/binary/tooLarge`）、`fs_stat`。读取返回秒级 `mtime`（展示）与毫秒级 `mtimeMs`（冲突令牌）。
- 二进制预览走本机流式路由 `GET /file?token&ws&path`（Range）；移动端 `GET /companion/api/file/raw?t&ws&path` 复用同一实现。
- `fs_write`：只覆盖**已存在的 UTF-8 文本文件**（不新建，现有文件也不能超过 2 MiB），上限 2 MiB；先写同目录临时文件（`create_new`，拒绝预置的临时文件名）、保留原文件权限再 rename，崩溃不会留下半个文件。请求带加载时的 `mtimeMs`，不一致返回 `conflict:`（HTTP 409），`force` 才覆盖。
- 桌面编辑器是 Monaco（懒加载 chunk + 本地 worker），⌘S 保存；未保存时标签显示圆点，关闭标签弹出「放弃并关闭 / 继续编辑」。保存请求在途时继续输入不会被回包覆盖；有未保存修改的预览标签会被自动固定，不会被下一个文件替换；退出登录与关闭窗口也会先确认。Markdown 预览经 `rehype-sanitize` 清洗，README 里的 `iframe`/`script` 不会进入 WebView。

## 9. 移动端

只读预览为主，编辑需显式开启：

- 底部「文件」tab：项目切换 → 面包屑目录列表（点击下钻/返回）→ 预览页（文本/Markdown/图片/二进制提示）。
- JSON 接口 `GET /companion/api/files`、`GET /companion/api/file`；二进制走 `file/raw`，鉴权与媒体一致（Bearer 或 `?t=`）。
- 编辑默认关闭：桌面伴侣弹窗或手机设置页（仅 `canManage` 设备）打开 `companion.allowFileWrite` 后，文件页才显示编辑按钮；保存走 `POST /companion/api/file/write`，同样带 `mtimeMs` 冲突校验，`text` 为必填。手机端不加载 Monaco：预览用 highlight.js（懒加载 chunk + 主题色板）上色，编辑用等宽 textarea（16px，避免 iOS 聚焦缩放）。

## 10. 文件所有权

| 范围 | 文件 |
| --- | --- |
| 契约（冻结） | `layout/types.ts`、`layout/defaults.ts`、`panels/context.tsx`、`panels/registry.tsx`、`lib/fs.ts`、`catalog/{layout,explorer}.ts` |
| 布局内核 | `layout/{ops,geometry,persist,useWorkbenchLayout}.ts`、`layout/*.test.ts` |
| 视图层 | `workbench/components/*`、`workbench/Workbench.tsx`、`App.tsx`、`ActivityBar.tsx`、`useDetailPane.ts`、`useTerminalPanel.ts`、`useSidebarLayout.ts`、`styles.css` |
| 文件能力 | `src-tauri/src/fs*`、`lib.rs`、`server.rs`、`companion/files.rs`、`companion.rs`、`panels/{ExplorerPanel,FilePanel}.tsx`、`workbench/explorer/*`、`ProjectSidebar.tsx` |
| 移动端 | `apps/companion/src/{App.tsx,pages,components,lib}` |
