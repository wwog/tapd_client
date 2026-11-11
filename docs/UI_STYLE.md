# UI 样式规范

> 目标：页面干净、层级清楚、长期不脏。所有新组件必须遵守本文，评审时按「禁止清单」逐条检查。
>
> 实现入口：[`apps/desktop/src/styles.css`](../apps/desktop/src/styles.css) 中的 `@theme`、`[data-theme]` 与文本/色彩 token。

## 1. 三条硬规则

1. **边框就是边框。** 结构分隔只用 `border`，默认 1px，最大 2px。不要用 `ring-*` 或 `box-shadow` 伪装边框。
2. **没有阴影。** 不写 `shadow-*`，不写装饰性 `box-shadow`。全局已强制 `box-shadow: none !important`，深度只来自边框和背景色。
3. **字重不超过 400。** 禁止 `font-medium`（500）、`font-semibold`（600）、`font-bold`（700）。主次用颜色、字号区分；需要更轻时用 `font-light`（300）。

## 2. 色彩

所有颜色走语义 token，不直接写色值（主题切换、暗色适配都依赖它）。

| Token | 用途 |
| --- | --- |
| `bg-canvas` | 窗口底色、侧栏、页面背景 |
| `bg-surface` | 卡片、面板、输入框、弹层表面 |
| `bg-selected` | 选中态底色（Segmented 指示块等） |
| `bg-overlay` / `bg-overlay-soft` | 悬停/按下遮罩 |
| `border-border` | 结构边框、输入框、卡片 |
| `bg-primary` / `text-primary-foreground` | 主按钮 |
| `text-slate-900` | 页面标题、主要文字 |
| `text-slate-500/400` | 次要文字、说明 |
| `text-sky-*` / `bg-sky-50` | 选中、链接、焦点 |
| `text-emerald/amber/rose-*` + 同色 `bg-*-50` | 状态、风险、结果 |
| `bg-island` / `bg-island-hover` | 顶部胶囊与通知卡的中性玻璃表面（浅色为浅灰、深色为石墨灰，不随 slate 反转） |
| `border-island-line` | 胶囊描边 |
| `text-island-ink` / `text-island-muted` | 胶囊主/次文字 |
| `bg-island-soft` / `bg-island-soft-hover` | 胶囊内次级按钮、代码块、进度槽 |

规则：

- 重要度优先用颜色。状态用 Badge 色，不用加粗。
- 不要新增硬编码颜色（`bg-[#...]`、`text-[#...]`），除非是品牌插画或主题缩略图。
- 深色模式不要写 `dark:`：在 `[data-theme="dark"]` 里覆盖 token 即可。

## 3. 字体与字号

- 字体栈：系统 UI 字体，不打包字体文件。
- 基准字号：`--ui-font-size`，默认 14px，设置页可在 12–17px 调整。
- 所有字号走 `text-ui-*`，不要写 `text-[11px]`、`text-xs`、`text-sm`。

| Class | 计算 | 典型用途 |
| --- | --- | --- |
| `text-ui-2xs` | base − 4 | 角标、极次要信息 |
| `text-ui-xs` | base − 3 | 元数据、表格副行 |
| `text-ui-sm` | base − 2 | 标签、表头、按钮 |
| `text-ui-caption` | base − 1 | 正文、列表标题 |
| `text-ui-base` | base | 页面标题、重点正文 |
| `text-ui-lg` | base + 2 | 大标题、空状态标题 |

规则：

- 字重只用 `font-normal`（默认）或 `font-light`。不要为了「突出」加粗。
- 不用 `uppercase`、`tracking-wide` 装饰表头。
- 行高用 `leading-*` 或 token 自带行高，不手写像素行高。

## 4. 边框、圆角、间距

- 边框：`border border-border`；需要强调时 `border-2 border-sky-400`，**最大 2px**。
- 圆角：卡片 `rounded-xl` / `rounded-2xl`；输入框、按钮 `rounded-lg`；小标签 `rounded-md`。
- 阴影：0。焦点用 `outline-2 outline-sky-200`，不要用 `ring` / `shadow`。
- 卡片嵌套不要超过两层边框：外层容器负责边框，内层用背景色或间距分组。

文本选择：

- 窗口默认不可拖选（`styles.css` 中 `body { user-select: none }`），像原生桌面应用；只有可复制的内容区（缺陷描述、评论、变更值、日志与 diff、配置片段、发布说明、报错）加 `select-text`。
- 输入类控件（`input` / `textarea` / `select` / `contenteditable`）已在全局恢复原生选择，不要再单独加。
- 元数据（ID、标题、版本、路径）不靠拖选复制，用复制按钮或右键菜单。

## 5. 层级

固定层叠顺序，新增浮层不要随手写 `z-[999]`：

| 层 | z-index | 例子 |
| --- | --- | --- |
| 表头 | `z-20` | `th.sticky top-0` |
| 表格右侧固定操作列 | `z-30` | `th.sticky right-0` |
| 行内浮层 / 下拉菜单 | `z-50` | 项目打开方式、右键菜单 |
| 全屏媒体预览 | `z-60` | MediaPreview |
| Agent 底部面板 | `z-65` | Compose sheet |
| 文件夹选择器 | `z-70` | FolderPicker |
| 通用弹窗 | `z-80` | Dialog |
| 首次引导 | `z-90` | Onboarding |

表格固定列规则：

- 固定列必须有与行一致的背景；悬停时行和固定列使用同一个背景色和同一个 transition 时长。
- 固定列不要加竖直分割边框；它属于表格，不是独立面板。
- 任何下拉/浮层要高于表头固定列，否则会被表格盖住。
- 表头的排序 / 筛选控件默认不显示，悬停表头或已应用时出现；可排序列先放排序按钮，再放筛选按钮。
- 排序按钮按「升序 → 降序 → 取消」循环，取消后回到默认排序；已应用筛选或排序的列，表头用 `bg-sky-50` + `text-sky-700` 轻微强调，不额外加粗或描边。
- 多选筛选在弹层内暂存，点「完成」才应用并刷新；直接关闭或点遮罩丢弃改动，避免结果为空时弹层随表格一起卸载。

## 6. 文案

- 页面级只保留标题，不写副标题、卖点、功能说明。
- 元素能自解释就不写说明文字。确实需要解释的，放进 `title`：
  ```tsx
  <h2 title="策略只会在 TAPD 权限之上进一步收窄范围。">MCP 策略</h2>
  ```
- 空状态只保留一句标题；操作指引放 `title`。
- 保留动态数据（版本、路径、数量、时间）和破坏性操作警告。
- 首次引导、登录页的品牌文案属于内容本身，可以保留。
- 缺陷标题来自测试同学，常带全角符号；展示时统一走 `bugTitle()`（`lib/bug.ts`）转成英文标点，并把 `[] () {}` 与正文用空格隔开（标题开头不加前导空格），复制与导出仍保留原文。

## 7. 组件写法

卡片：

```tsx
<section className="rounded-2xl border border-border bg-surface p-5">
  <h2 className="flex items-center gap-2 text-ui-base text-slate-900">标题</h2>
  {/* 内容 */}
</section>
```

选中行：

```tsx
<button
  className={clsx(
    "w-full rounded-lg px-2.5 py-2 text-left transition",
    selected
      ? "border border-sky-200 bg-sky-50"
      : "hover:bg-slate-50",
  )}
>
```

输入框：

```tsx
<input
  className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-ui-caption text-slate-700 transition focus:border-sky-300 focus:outline-2 focus:outline-sky-200"
/>
```

主按钮：

```tsx
<Button variant="primary">保存</Button>
// ui.tsx 内部使用 bg-primary text-primary-foreground
```

弹窗滚动：

- 单栏内容流交给 `Dialog` 自己滚（默认）。
- 列表 + 详情两栏时传 `bodyScroll={false}`，两栏各自 `overflow-y-auto overscroll-contain`：滚动列表不会带走右侧内容，标题栏也始终固定。

## 8. 禁止清单

提交前在仓库根目录执行：

```bash
# 不允许阴影
grep -rn "shadow" apps/desktop/src --include='*.tsx'

# 不允许 500 及以上字重
grep -rn "font-medium\|font-semibold\|font-bold" apps/desktop/src

# 不允许 ring 伪装边框 / 焦点
grep -rn "ring-" apps/desktop/src --include='*.tsx'

# 边框最大 2px
grep -rn "border-[3-9]\|border-\[[3-9]px\]" apps/desktop/src --include='*.tsx'

# 不允许手写字号
grep -rn "text-\[[0-9]*px\]\|text-xs\|text-sm" apps/desktop/src --include='*.tsx'

# 不允许硬编码颜色（品牌插画/主题缩略图除外）
grep -rn "bg-\[#\|text-\[#\|border-\[#" apps/desktop/src --include='*.tsx'
```

以上命令应全部无输出（或仅剩已批准的插画/主题缩略图例外）。

## 9. 评审顺序

1. 页面是否有副标题、说明段、重复信息？删掉或移到 `title`。
2. 是否有阴影、`ring`、超过 2px 的边框？改成边框/背景。
3. 是否有 500+ 字重？改成 400/300，用颜色表达重点。
4. 颜色是否走 token？深色模式是否正常？
5. 字号是否走 `text-ui-*`？在 12–17px 基准下是否溢出？
