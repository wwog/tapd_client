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
| 标题栏 | Title bar | `TitleBar` | 窗口拖动区、更新/审核徽标 |
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
| 标签 | Tab | `TabItem` | 预览标签 / 固定标签 |
| 面板 | Panel | `PanelRef` / `PanelHost` | 标签背后的内容实例 |
| 分割条 | Sash | `Sash` | 相邻组之间的拖拽条 |
| 交叉分割条 | Corner sash | `CornerSash` | 十字/T 形交点，一次拖两个方向 |
| 投放区 | Drop zone | `DropZone` | center / left / right / top / bottom |
| 拖拽预览 | Drag ghost | `DragGhost` | 跟随指针的标签残影 |

`row` = 子项左右排列（分割条竖直）；`column` = 子项上下排列（分割条水平）。默认组角色只是初始落点，不是固定 id：

- `primary` 主组：缺陷列表与各页面标签，始终存在，标签不可关。
- `secondary` 副组：右侧，缺陷详情 / 资源管理器 / 文件的默认落点。
- `bottom` 底组：终端默认落点，横跨窗口下方。

默认树（`defaultLayout()`）：

```
column [0.68, 0.32]                 split-root
├── row [0.66, 0.34]                split-main
│   ├── group-primary   page:bugs
│   └── group-secondary（空）
└── group-bottom（空）
```

DOM 标记（验收 / 自动化用）：`data-workbench-region="layout-area|sash|corner-sash"`、`data-workbench-group-cell`（含 `data-workbench-group` 与空组标记 `data-workbench-group-empty`）、`data-tab-id`、`data-panel-id`、`data-panel-surface`。

### 2.3 面板

| 种类 | id 约定 | 内容 | 关闭 | 单例 |
| --- | --- | --- | --- | --- |
| `page` | `page:<view>` | 缺陷/项目/Agent/同事/MCP/设置/账号 | 否 | 按 id |
| `bug` | `bug:<ws>:<bugId>` | 缺陷详情 | 是 | 全局一个，再次打开改目标 |
| `explorer` | `explorer:<ws>` | 资源管理器 | 是 | 按 id（每个项目一个） |
| `file` | `file:<ws>:<path>` | 文本/Markdown/图片/音视频/二进制 | 是 | 按 id |
| `terminal` | `terminal:<sessionId>` | 一个 PTY 一个标签 | 是 | 按 id |

## 3. 不变量

1. `SplitNode.children.length >= 2`，`sizes.length === children.length`，非空子项的比例和为 1。
2. `GroupNode.panels` 可以为空，**仅限带 `role` 的规范停靠组**；空组保留自己的比例，重新打开时恢复原尺寸。非 role 组一旦为空，`normalize` 会删除它并把空间还给兄弟。
3. `primary` 组始终至少有一个 `page` 标签；没有时补 `page:bugs`。
4. 组内 `activePanelId` 必须指向该组的面板；空组为 `null`。
5. 面板 id 由资源决定（`panelId`），重启后稳定；标签移动不改变 id。
6. 每个面板只挂载一次：`PanelHost` 用 portal 投到所属组，移动标签只换目标节点，内容不重挂载。

## 4. 尺寸与拖拽

- 尺寸以 fraction 存，渲染时按容器像素换算并套最小尺寸。组最小值 = 组内各面板 `PANEL_MIN_SIZE` 的最大值；split 最小值 = 子项最小值之和 + 分割条。空组贡献 0，因此只有有内容的子项参与分配。
- 布局区测量不能只依赖 `ResizeObserver`：主窗口是隐藏创建、首帧后才显示，首次测量可能为 0。`SplitView` 会在为 0 时按动画帧重试，并在窗口 resize / `visibilitychange` 时补测。
- 分割条统一：1.5px 视觉、8px 命中区、hover 高亮、拖动 `bg-sky-400/50`、双击复位。侧边栏复用同一组件与同一拖拽内核，只保留折叠/自动收起。
- 交叉点：测量所有分割条矩形，正交相交处渲染 8×8 `CornerSash`；一次拖动同时更新两个 split。T 形（三块交汇）同样处理。
- 拖动回报的是**相对拖动起点的总位移**；`beginSashDrag` 在开始时快照 sizes，所以重复调用不会累加误差。
- 打开面板到副组时，如果窗口放不下布局最小宽度，沿用 `ensure_window_width` 向左侧扩窗。

## 5. 标签拖拽协议

`TabsDnd = { panelId, fromGroupId, clientX, clientY }`，指针事件实现（不用 HTML5 DnD）。

- 组内：按指针 x 计算插入位置，拖动经过自身不算移动。
- 跨组 center：插入目标组标签栏，成为该组 active。
- 跨组边缘（四边各 25%）：在目标组该方向新建组并放入标签；新组比例用 `defaultSplitSizes(direction)`。
- 拖到空的标准停靠组：直接放入并恢复它原来的比例；如果该组已不存在，按角色位置重建（`ensureRoleGroup`）。
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
type LayoutPrefs = { version: 1; layout: LayoutState; sidebarWidth: number };
```

- 启动先读该键；缺失/损坏 → `defaultLayout()`。
- 旧 `terminal.panel.v1`（`{ open, height }`）迁移：`open` 为真时生成一个终端面板放进底组。
- 归一化：未知面板丢弃、非 role 空组删除、单子 split 提升、比例重新配平、active 指针修复。
- 资源管理器展开目录存 `uiPrefs["explorer.tree.v1"]`（`{ [workspaceId]: string[] }`）。

## 8. 文件能力（只读）

Rust `src-tauri/src/fs.rs`：

- 根 = `agent.json` 的 `projects[workspaceId].repoPath`；未配置直接报错。
- 所有入参只接受**相对路径**；`resolve_in_root` 拒绝绝对路径、`..`、NUL、非 UTF-8，canonicalize 后按组件比较，拒绝符号链接逃逸。
- `fs_list`（一层，dirs-first，5000 条截断）、`fs_read`（文本 2 MiB 截断；`text/markdown/image/audio/video/binary/tooLarge`）、`fs_stat`。
- 二进制预览走本机流式路由 `GET /file?token&ws&path`（Range）；移动端 `GET /companion/api/file/raw?t&ws&path` 复用同一实现。
- 不提供写入。

## 9. 移动端

只读适配，不镜像桌面的分割树：

- 底部新增「文件」tab：项目切换 → 面包屑目录列表（点击下钻/返回）→ 预览页（文本/Markdown/图片/二进制提示）。
- JSON 接口 `GET /companion/api/files`、`GET /companion/api/file`；二进制走 `file/raw`，鉴权与媒体一致（Bearer 或 `?t=`）。

## 10. 文件所有权

| 范围 | 文件 |
| --- | --- |
| 契约（冻结） | `layout/types.ts`、`layout/defaults.ts`、`panels/context.tsx`、`panels/registry.tsx`、`lib/fs.ts`、`catalog/{layout,explorer}.ts` |
| 布局内核 | `layout/{ops,geometry,persist,useWorkbenchLayout}.ts`、`layout/*.test.ts` |
| 视图层 | `workbench/components/*`、`workbench/Workbench.tsx`、`App.tsx`、`ActivityBar.tsx`、`useDetailPane.ts`、`useTerminalPanel.ts`、`useSidebarLayout.ts`、`styles.css` |
| 文件能力 | `src-tauri/src/fs*`、`lib.rs`、`server.rs`、`companion/files.rs`、`companion.rs`、`panels/{ExplorerPanel,FilePanel}.tsx`、`workbench/explorer/*`、`ProjectSidebar.tsx` |
| 移动端 | `apps/companion/src/{App.tsx,pages,components,lib}` |
