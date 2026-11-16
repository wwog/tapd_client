//! Messages for MCP: `tapd-core`'s tool manifest (descriptions and schema
//! argument descriptions) and the sidecar's command errors. Key format:
//! `mcp.topic`. Tool names, argument names and JSON fields are not translated.

use crate::Message;

pub static MESSAGES: &[Message] = &[
    // -- tool descriptions -------------------------------------------------
    ("mcp.tool.whoami", "返回当前登录的 TAPD 用户、默认项目和项目数量；传 root 时一并返回按本地目录匹配到的项目。", "Returns the signed-in TAPD user, default project and project count. Passing root also returns the project matched by local folder."),
    ("mcp.tool.listprojects", "列出当前账号可访问的 TAPD 项目（id、名称、最近访问时间）。", "Lists the TAPD projects this account can access (id, name, last visited)."),
    ("mcp.tool.listbugs", "查询 TAPD 缺陷。默认只返回分配给自己的未解决缺陷；支持按项目、处理人、状态、优先级、严重程度、关键词/ID 与时间过滤。", "Lists TAPD bugs. Defaults to unresolved bugs assigned to you; filter by project, owner, status, priority, severity, keyword/ID and time."),
    ("mcp.tool.listmybugs", "查询分配给自己、未解决的缺陷（tapd_list_bugs 的便捷封装）。", "Lists unresolved bugs assigned to you (shorthand for tapd_list_bugs)."),
    ("mcp.tool.getbug", "获取缺陷详情并导出修复包：写入 bug.json（缺陷详情 + 已成功下载的 assets 列表）与 assets/ 下的截图、视频、附件，一次调用返回 bugJson（绝对路径）、assetCount、downloadedBytes、warnings，以及渲染好的修复提示词 prompt（可直接作为本轮任务说明）。返回的 skills 是已启用同事的技能包（name 为键，path 为 SKILL.md 绝对路径），动手前先完整读取；没有可用技能时为 {}。projectRule 是需要遵守的项目规则（可能为空字符串），随 prompt 之外的字段单独返回。", "Fetches a bug and exports a fix package: writes bug.json (bug details plus the successfully downloaded asset list) and the screenshots, videos and attachments under assets/, then returns bugJson (absolute path), assetCount, downloadedBytes, warnings and the rendered fix prompt (usable as this turn's task description). The returned skills are enabled teammates' skill packs (keyed by name, with path as the absolute SKILL.md); read them fully before starting. {} when no skills are available. projectRule is the project rule to follow (may be an empty string) and is returned separately from prompt."),
    ("mcp.tool.getbugtransitions", "读取缺陷的当前状态、状态别名和允许的下一步状态。修改状态前先调用它，避免使用非法的流转目标。", "Reads a bug's current status, status aliases and allowed next statuses. Call it before changing status to avoid invalid transitions."),
    ("mcp.tool.addbugcomment", "在缺陷下追加评论（纯文本，自动转换为 TAPD 富文本）。修复完成后用它说明原因、解决方案与影响范围。", "Appends a comment to a bug (plain text, converted to TAPD rich text automatically). Use it after a fix to explain the cause, solution and impact."),
    ("mcp.tool.updatebugstatus", "更新缺陷状态。status 可传 key（如 resolved）或中文名（如 已解决）。若目标不能直接到达（例如 new → 已解决），会自动先流转到处理中再执行。可先调用 tapd_get_bug_transitions 查看允许的下一步。可同时传入 comment，在状态变更前追加说明。客户端会按 TAPD 工作流配置自动填充本次流转所需的工作流字段默认值（处理人/开发人员/测试人员等，与 TAPD 网页端流转弹窗一致），可用 fields 覆盖这些默认值。", "Updates a bug's status. status accepts a key (such as resolved) or a Chinese status name. If the target is not directly reachable (for example new to resolved), it first moves to the in-progress status. Call tapd_get_bug_transitions first to see the allowed next statuses. An optional comment is added before the status change. The client fills the workflow field defaults for this transition from the TAPD workflow configuration (owner/developer/tester and so on, matching TAPD's web transition dialog); fields overrides them."),
    ("mcp.tool.notifyuser", "在用户桌面顶部的胶囊窗口唤起一条通知，并等待用户操作后返回结果（默认最多 30 秒）。用于任务完成、失败、需要确认等场景。tone 决定成功/失败/提示配色；body、fields、progress 是简写内容；blocks 可精确控制内容块（text / code / fields / progress / divider）；actions 是用户可点击的按钮。返回 status：acted（附 actionId/actionLabel）、dismissed、timeout、pending 或 replaced。waitSeconds=0 时立即返回 pending，之后可用 tapd_wait_notification 继续等待。", "Shows a notification in the capsule at the top of the user's desktop and waits for the user before returning (30 seconds by default). Use it for task completion, failure or confirmation. tone sets the success/failure/hint colors; body, fields and progress are shorthand content; blocks give precise content blocks (text / code / fields / progress / divider); actions are the buttons the user can click. Returns status: acted (with actionId/actionLabel), dismissed, timeout, pending or replaced. waitSeconds=0 returns pending immediately; continue waiting with tapd_wait_notification."),
    ("mcp.tool.waitnotification", "等待一条之前通过 tapd_notify_user 唤起的通知的决定结果（用户点击按钮或关闭）。返回 status：acted（附 actionId/actionLabel）、dismissed、timeout、pending 或 expired。", "Waits for the decision on a notification raised earlier by tapd_notify_user (the user clicks a button or dismisses it). Returns status: acted (with actionId/actionLabel), dismissed, timeout, pending or expired."),
    // -- shared schema arguments ------------------------------------------
    ("mcp.arg.root", "本地仓库/工作目录绝对路径；用于按项目设置里的「本地文件夹」自动匹配 TAPD 项目。省略时由客户端 cwd 自动填入", "Absolute path of the local repository/working directory; used to match a TAPD project by the local folder in project settings. Defaults to the client's cwd."),
    ("mcp.arg.workspaceid", "项目 ID；省略时使用上次选择的项目", "Project ID; defaults to the last selected project."),
    ("mcp.arg.workspacename", "项目名称，仅用于导出目录命名与提示词展示", "Project name; only used for the export folder name and the prompt."),
    ("mcp.arg.bugid", "缺陷长 ID", "Long bug ID."),
    ("mcp.arg.bugidfromlist", "缺陷长 ID（列表返回的 id）", "Long bug ID (the id returned by the list)."),
    ("mcp.arg.owner", "处理人：me（默认）、all，或精确的 TAPD 昵称", "Owner: me (default), all, or an exact TAPD nickname."),
    ("mcp.arg.statuses", "状态 key，如 new、in_progress、resolved、reopened", "Status keys, such as new, in_progress, resolved, reopened."),
    ("mcp.arg.priorities", "优先级：urgent、high、medium、low、insignificant", "Priorities: urgent, high, medium, low, insignificant."),
    ("mcp.arg.severities", "严重程度：fatal、serious、normal、prompt、advice", "Severities: fatal, serious, normal, prompt, advice."),
    ("mcp.arg.keyword", "标题关键词；纯数字按缺陷 ID 精确匹配（完整 ID 或短 ID，可带 #）", "Title keyword; all digits match a bug ID exactly (full or short ID, # allowed)."),
    ("mcp.arg.onlyunresolved", "仅在未指定 statuses 时生效", "Only applies when statuses is not set."),
    ("mcp.arg.modifiedafter", "最后修改时间下界，格式 YYYY-MM-DD HH:MM:SS", "Lower bound for last modified time, format YYYY-MM-DD HH:MM:SS."),
    ("mcp.arg.createdafter", "创建时间下界，格式 YYYY-MM-DD HH:MM:SS", "Lower bound for creation time, format YYYY-MM-DD HH:MM:SS."),
    ("mcp.arg.comment", "评论正文，可包含换行", "Comment body; may contain line breaks."),
    ("mcp.arg.status", "目标状态 key 或中文名，如 resolved / 已解决 / verified / 已验证", "Target status key or Chinese status name, such as resolved or verified."),
    ("mcp.arg.statuscomment", "可选；状态变更前追加的评论", "Optional; comment added before the status change."),
    ("mcp.arg.fields", "可选；覆盖本次流转的工作流字段默认值。推荐用对象映射，例如 {\"current_owner\":\"张三\",\"resolution\":\"fixed\"}；也接受 [{ \"name\": \"current_owner\", \"value\": \"张三\" }] 形式的行数组（字段名也可用 field 或 key）。未提供的字段沿用 TAPD 工作流配置（如处理人取记录值或创建人）；null 或空数组 [] 都表示全部使用工作流默认值。", "Optional; overrides the workflow field defaults for this transition. An object map is preferred, for example {\"current_owner\":\"owner-name\",\"resolution\":\"fixed\"}; a row array such as [{ \"name\": \"current_owner\", \"value\": \"owner-name\" }] is also accepted (the field name may be field or key). Fields you omit keep the TAPD workflow configuration (for example the owner falls back to the record value or the creator); null or an empty [] means all fields use the workflow defaults."),
    // -- notification arguments -------------------------------------------
    ("mcp.arg.title", "通知标题，建议不超过 40 字", "Notification title; 40 characters or fewer recommended."),
    ("mcp.arg.tone", "配色与图标：success 成功 / error 失败 / warning 警告 / progress 进行中 / info 提示", "Color and icon: success done / error failed / warning warning / progress in progress / info hint."),
    ("mcp.arg.body", "正文，保留换行；与 blocks 同时提供时 blocks 优先", "Body text; line breaks are kept. blocks takes precedence when both are given."),
    ("mcp.arg.fieldlist", "键值对列表，最多 8 项", "List of label/value pairs; at most 8."),
    ("mcp.arg.progress", "进度条", "Progress bar."),
    ("mcp.arg.blocks", "结构化内容块；类型：text / code / fields / progress / divider", "Structured content blocks; types: text / code / fields / progress / divider."),
    ("mcp.arg.actions", "可点击按钮；用户点击后调用方会收到对应的 actionId。不传时只显示「知道了」", "Clickable buttons; the caller receives the matching actionId when clicked. Without them only \"Got it\" is shown."),
    ("mcp.arg.actionid", "回传给你的动作标识，如 confirm / cancel / retry", "Action id returned to you, such as confirm / cancel / retry."),
    ("mcp.arg.actionlabel", "按钮文案，建议不超过 6 字", "Button label; 6 characters or fewer recommended."),
    ("mcp.arg.tag", "可选；相同 tag 的待处理通知会被替换，适合进度类更新", "Optional; a pending notification with the same tag is replaced, which suits progress updates."),
    ("mcp.arg.waitseconds", "等待用户操作的秒数；0 = 立即返回。最长 120 秒", "Seconds to wait for user action; 0 returns immediately. Maximum 120 seconds."),
    ("mcp.arg.notificationid", "tapd_notify_user 返回的通知 id", "Notification id returned by tapd_notify_user."),
    // -- sidecar -----------------------------------------------------------
    ("mcp.cli.appnotrunning", "TAPD Client 未运行。请先打开桌面客户端，或确认 MCP 配置指向正确的安装位置。", "TAPD Client is not running. Open the desktop app first, or check that the MCP configuration points to the right installation."),
];
