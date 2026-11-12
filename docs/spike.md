# M0 接口验证记录

> 完成时间：2026-11-09
> 环境：macOS 

## 1. 桥接通道验证

| 项目 | 结果 | 备注 |
| --- | --- | --- |
| 初始化脚本注入 | ✅ | `window.__TAPDCB__.ping()` 可读页面信息 |
| `eval_with_callback` 同步回传 | ✅ | 返回 `JSON.stringify` 后的结果；字符串会被二次编码，需要双重解析 |
| Promise / async 表达式 | ❌ | `eval_with_callback` 不 await Promise，直接返回 `{}` |
| 远程 IPC（`__TAURI_INTERNALS__.invoke`） | ❌ | `bridge_result not allowed. Plugin not found`，Tauri 2 默认不向远程页面授权应用命令 |
| 自定义 scheme 导航兜底 | ❌ | WebKit 忽略未知 scheme，`on_navigation` 未触发（保留代码，不依赖） |
| 异步桥（最终方案） | ✅ | 异步 IIFE 写入 `window.__TAPDCB_RESULTS__[token]`，Rust 每 120ms 用原生 eval 轮询结果桶 |
| 登录态持久化 | ✅ | WKWebView 数据存储保留 Cookie；重启后仍在 `缺陷-UU` 页面 |
| 登录态自动识别 | ✅ | URL 命中 `/tapd_fe/{workspace}/...` 即标记登录并隐藏窗口 |
| 登录失效自动弹窗 | 待验证 | 监听 `/login`、`cloud_logins`、`/signin`、`/register` |

### 结论

- **所有 TAPD 数据请求都在页面内 `fetch`**，通过 `__TAPDCB__.request()` 完成；Rust 只负责发起表达式和取回结果。
- 不需要也不依赖远程 IPC；抓到页面 fetch/XHR 的请求由注入脚本自行记录。
- 异步请求耗时包含 120ms 轮询粒度，对列表/详情无感；MCP 查询后续会加缓存。

## 2. 已确认接口

### 2.1 当前用户 + 项目列表

`GET /api/aggregation/user_and_workspace_aggregation/get_user_and_workspace_basic_info?workspace_id={id}&location=/tapd_fe/my/work`

- 当前用户：`data.get_current_user_ret.data` → `user_id`、`user_nick`、`company`、`current_company_id`
- 项目列表：`data.my_workspaces.data[]` → `id`、`project_name`、`pretty_name`、`category`、`status`、`logo_color`、`last_visited_time`、`jump_url`
- 已验证当前账号 9 个项目（UU / TMM / TMM-esim / UU投票小程序 / 开放平台 / BBC / Buzz / UU / 客服系统）

### 2.2 缺陷列表

`POST /api/aggregation/bug_aggregation/get_bugs_list`

请求体（关键字段）：

```json
{
  "workspace_id": "45336192",
  "conf_id": "",
  "confIdType": "CACHE",
  "order": "desc",
  "sort_name": "created",
  "perpage": 50,
  "page": 1,
  "selected_workspace_ids": "",
  "query_token": "",
  "location": "/bugtrace/bugreports/my_view",
  "target": "45336192/bug/normal",
  "entity_types": ["bug"],
  "use_scene": "bug_list",
  "return_url": "https://www.tapd.cn/tapd_fe/45336192/bug/list",
  "identifier": "app_for_list_tools,app_for_list_operation",
  "multiple_group_location": "multiple_group/bug_list",
  "show_fields": [
    "id", "title", "status", "priority", "severity", "current_owner",
    "reporter", "created", "modified", "iteration_id", "module",
    "version_report", "short_id", "due", "lastmodify"
  ],
  "filter_expr": {
    "data": [
      {
        "fieldOption": "equal",
        "fieldType": "user_chooser",
        "entity": "bug",
        "fieldSystemName": "current_owner",
        "selectOption": [],
        "value": "张三",
        "fieldIsSystem": "1"
      }
    ],
    "optionType": "AND",
    "needInit": true
  }
}
```

响应路径：`data.bugs_list_ret.data`

- `bugs_list[]` → 每项是 `{ "Bug": { ... } }`
- `total_count`、`page`、`perpage`
- `status_map[workspace_id]` → 状态 key → 中文 label，例如 `{"new":"新","in_progress":"接受/处理","resolved":"已解决","verified":"已验证","reopened":"重新打开","rejected":"已拒绝","closed":"已关闭"}`

已验证过滤写法（全部服务端生效）：

| 场景 | fieldSystemName | fieldOption | fieldType | value |
| --- | --- | --- | --- | --- |
| 处理人 | `current_owner` | `equal` | `user_chooser` | `"张三"`（字符串） |
| 处理人（多选） | `current_owner` | `in` | `user_chooser` | `["张三","李四"]`（数组，任一匹配） |
| 状态 | `status` | `in` | `multi_select` | `["new"]` |
| 优先级 | `priority` | `in` | `select` | `["high"]` |
| 严重程度 | `severity` | `in` | `select` | `["normal","serious"]` |
| 标题关键词 | `name` | `like` | `input` | `"草稿"` |
| 修改时间 | `modified` | `between` | `datetime` | `"2026-11-09 00:00:00,"`（开放区间） |

其他结论：

- `perpage` 最小 20；`5` 会被当作 20，`50`/`100` 正常。
- `dsc_token` 对本读接口可选；Cookie 中有 `dsc-token`（域名 `www.tapd.cn`），写操作时补上。
- 视图复用：`conf_id=1145336192001004651` 为「我负责的」，`1145336192001004650` 为「所有的」。

### 2.3 缺陷详情

`POST /api/aggregation/workitem_aggregation/common_get_info`

请求体要点：`workspace_id`、`entity_id`、`entity_type: "bug"`、`is_detail: 1`、`enable_description: "true"`、`identifier` 列表、`installed_app_entity`、`dsc_token`。

响应路径：`data.get_info_ret.data`

- `Bug`：完整字段（约 300 个），含 `description`（HTML，视频/图片内联）、`markdown_description`、`status`、`priority`、`severity`、`current_owner`、`reporter`、`created`、`modified`、`iteration_name`、`module`、`version_report`、`platform`、`os`、`resolution`、`resolved`、`closed`、`reopen_time`、`fixer`、`de`、`te`、`participator`、`cc`、`follower`、`workspace_name`
- `comment_list.comments[]`：`id`、`author`、`user_id`、`created`、`description`（HTML）、`plain_text`、`markdown_description`、`replies[]`、`type`、`is_delete`
- `attachment_list.attachments[]`：`id`、`filename`、`content_type`、`size`、`filetype`、`video_poster`、`video_origin_file`、`video_origin_vcodec`、`dimensions`、`created`、`owner`、`entry_id`
- `file_list[]`：附件字段（本例为空）
- 工作流：`GET /api/aggregation/bug_aggregation/get_bug_transition_info?...`（状态流转配置，只读阶段暂不使用）

补充（2026-11-10 抓包确认）：

- `get_info` 响应里的 `description` 用的是新版编辑器路径，例如 `<img src="/tfl/captures/2026-11/tapd_45336192_base64_1794213543_843.png">`；相对路径按 `https://www.tapd.cn` 补全即可下载（116 KB，带 Cookie）。
- 这些内嵌图片/视频**不会**出现在 `attachment_list.attachments` 里，所以详情页「资源」为 0 是数据源问题，不是解析问题。`parse_bug_detail` 现在会额外扫描 HTML，写入 `embeddedMedia`。
- 详情页额外调用了 `POST /api/aggregation/workitem_aggregation/get_info`，其 `get_tab_setting_ret.data` 里有 tab 清单和计数（`变更历史` tab 的 `count`），可用于显示数量。

### 2.4 附件与资源

URL 规律（`workspace_id` 替换为项目 id）：

- 原件下载：`https://file.tapd.cn/{workspace_id}/attachments/download/{attachment_id}/{filename}`
- 预览：`https://file.tapd.cn/{workspace_id}/attachments/preview_attachments/{attachment_id}/{filename}`
- 视频封面：`https://file.tapd.cn/{workspace_id}/attachments/preview_video_poster/{attachment_id}`
- 描述内媒体：下载时把 `preview_attachments` 替换为 `download` 即可

验证结果：

| 资源 | 无 Cookie | 带 Cookie |
| --- | --- | --- |
| `.ips` 原件（398 KB） | 200 + `text/html` 2 字节占位 | ✅ 398145 B，`Content-Disposition` 正确 |
| `.mp4` 附件（2.4 MB） | 占位 | ✅ `video/mp4`，magic `ftypisom` |
| 描述内视频（3.8 MB） | 占位 | ✅ `video/mp4` |
| 视频封面 PNG | — | ✅ `image/png` 131 KB |
| `preview_attachments`（非图片） | — | ❌ 返回 `preview error`，下载一律走 `download` |

Cookie 来源：`window.cookies()`（Tauri 2，含 HttpOnly），共 16 个，关键项：

- `tapdsession`、`t_u`、`t_i_token`、`_wt`（HttpOnly）
- `dsc-token`（非 HttpOnly，16 位）、`sso-login-token`

Rust 侧下载策略：读取 webview cookie → 手工拼 `Cookie` 头 → reqwest GET `download` URL，保存时使用 `Content-Disposition` 的 `filename*`。

### 2.5 字段字典

`POST /api/new_filter/new_filter/get_options_batch`

```json
{
  "workspace_ids": ["45336192"],
  "fields": [
    {"field": "status", "entity_type": "bug", "is_system": "1", "html_type": "select", "menu_workitem_type_id": ""},
    {"field": "priority", "entity_type": "bug", "is_system": "1", "html_type": "select", "menu_workitem_type_id": ""},
    {"field": "severity", "entity_type": "bug", "is_system": "1", "html_type": "select", "menu_workitem_type_id": ""}
  ],
  "use_scene": "bug_list",
  "app_id": "1",
  "filter_status": "",
  "include_in_process": false,
  "dsc_token": "kpxWvnRFhyaW4DZd"
}
```

- 状态（label）：新 / 接受/处理 / 已解决 / 已验证 / 重新打开 / 已拒绝 / 已关闭
- 优先级：`urgent` 紧急、`high` 高、`medium` 中、`low` 低、`insignificant` 无关紧要
- 严重程度：`fatal` 致命、`serious` 严重、`normal` 一般、`prompt` 提示、`advice` 建议

### 2.6 变更历史

变更历史 tab 是一个服务端渲染的老页面，没有 JSON 接口：

`GET https://www.tapd.cn/{workspace_id}/bugtrace/bugs/changes_list?perpage=10&page=1&bug_id={bug_id}&only_content=1&microapp=1`

- 返回整页 HTML；`only_content=1&microapp=1` 只是给微前端用，内容仍是完整页面。
- 表格结构：外层 `table.bug-history` 每次变更一行（`序号` / `变更时间` / `变更人` / `变更类型`），`colspan=3` 单元格里再嵌一张表，每行是 `变更字段` / `变更前` / `变更后`。
- 总条数：`var _revisionsCount = N;`，表头也有 `序号(N)`。
- 分页：服务端每页最多 10 条；`page=2` 可取下一页，`perpage` 不放大返回量。
- 解析实现：`crates/tapd-core/src/tapd/changes.rs::parse_changes_html`，用真实响应做回归测试（`crates/tapd-core/tests/fixtures/changes_list.html`）。


## 3. 已知坑

1. `filter_expr` 是对象，不是 JSON 字符串；`value` 对处理人是字符串，对状态/优先级/严重程度是数组。
2. `perpage < 20` 会被静默提升到 20，不要用它探测总数。
3. `eval_with_callback` 返回的字符串会被二次 JSON 编码，需要「解析后若是字符串再解析一次」。
4. 远程页面调用应用命令会被 ACL 拒绝，报 `bridge_result not allowed. Plugin not found`。
5. `preview_attachments` 只适合图片/封面；文件下载必须用 `download` 路径 + Cookie。
6. 列表接口默认字段由视图决定，必须显式传 `show_fields` 才能拿到 `modified`（通知增量同步依赖它）。
7. 详情页 URL 已从经典路径重定向为 `https://www.tapd.cn/tapd_fe/{workspace}/bug/detail/{id}`。

## 4. 下一步

- 把上述接口固化到 `crates/tapd-core/src/tapd/`：模型、过滤器、请求体、响应解析。
- SQLite 落库与增量轮询（`owner=me` + `modified >= last_poll - 5min`）。
- 主界面接入项目列表、我的/全部缺陷、详情抽屉。
