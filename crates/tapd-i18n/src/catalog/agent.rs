//! Messages for agent prompt templates, attachment labels and the built-in
//! dsh runtime's startup errors.

use crate::Message;

pub static MESSAGES: &[Message] = &[
    ("agent.attachment.file", "文件", "File"),
    ("agent.attachment.image", "图片", "Image"),
    ("agent.attachment.video", "视频", "Video"),
    (
        "agent.image.missing",
        "图片文件不在了，无法预览",
        "The image file is gone; nothing to preview",
    ),
    (
        "agent.image.tooLarge",
        "图片太大，不在这里预览",
        "The image is too large to preview here",
    ),
    (
        "agent.image.unsupported",
        "这种图片格式不支持预览",
        "This image format cannot be previewed here",
    ),
    ("agent.prompt.attachment.line", "- {}：{}", "- {}: {}"),
    ("agent.prompt.attachments.header", "\n\n用户附加资源（本地路径，请直接读取）：\n", "\n\nUser attachments (local paths, read them directly):\n"),
    (
        "agent.prompt.default",
        "请修复 TAPD 缺陷：{{title}}\n\n缺陷详情：{{json_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}} / 严重程度：{{severity}} / 优先级：{{priority}}\n\n{{coworker}}\n\n要求：\n1. 先完整阅读 bug.json 与 assets/ 下的截图、视频。\n2. 定位根因，做最小必要修改，并遵循团队代码规范。\n3. 修改后运行相关测试或构建。\n4. 不要 git commit、不要 push，也不要写 TAPD（评论与状态由客户端在审核、合并后统一处理）。\n5. 结束时用简短列表说明：根因、改动文件、验证方式、风险点。",
        "Fix TAPD bug: {{title}}\n\nBug details: {{json_path}}\nLocal repository: {{repo_path}}\nProject: {{workspace_name}} / Severity: {{severity}} / Priority: {{priority}}\n\n{{coworker}}\n\nRequirements:\n1. Read bug.json and the screenshots and videos under assets/ in full first.\n2. Find the root cause, make the smallest necessary change, and follow the team's coding conventions.\n3. Run the relevant tests or build after changing code.\n4. Do not commit, do not push, and do not write to TAPD (the client comments and updates status after review and merge).\n5. Finish with a short list: root cause, changed files, how you verified, and risks.",
    ),
    (
        "agent.prompt.local",
        "请处理这个本地事项：{{title}}\n\n事项详情：{{json_path}}\n本地仓库：{{repo_path}}\n项目：{{workspace_name}}\n\n{{coworker}}\n\n要求：\n1. 先完整阅读事项详情与 assets/ 下的截图、视频。\n2. 定位要改的地方，做最小必要修改，并遵循团队代码规范。\n3. 修改后运行相关测试或构建。\n4. 不要 git commit、不要 push（审核与合并由客户端统一处理）。\n5. 结束时用简短列表说明：改动文件、验证方式、风险点。",
        "Handle this local work item: {{title}}\n\nItem details: {{json_path}}\nLocal repository: {{repo_path}}\nProject: {{workspace_name}}\n\n{{coworker}}\n\nRequirements:\n1. Read the item details and the screenshots and videos under assets/ in full first.\n2. Find what to change, make the smallest necessary change, and follow the team's coding conventions.\n3. Run the relevant tests or build after changing code.\n4. Do not commit and do not push (the client handles review and merge).\n5. Finish with a short list: changed files, how you verified, and risks.",
    ),
    ("agent.prompt.user.notes", "\n\n用户补充说明：\n", "\n\nAdditional notes from the user:\n"),
    // 内置 DeepSeek Harness 运行时（docs/DSH.md）
    ("dsh.args.invalid", "{} 参数无效：{}", "Invalid arguments for {}: {}"),
    ("dsh.bridge.unavailable", "内置 Agent 桥接状态不可用", "The built-in agent bridge is unavailable"),
    ("dsh.call.timeout", "{} 超时", "{} timed out"),
    ("dsh.discover.baseUrl", "先填写 Base URL 才能获取模型", "Fill in the Base URL before fetching models"),
    ("dsh.discover.unsupported", "{} 协议不支持自动获取模型，请手动添加", "Models cannot be listed for the {} protocol; add them by hand"),
    ("dsh.discover.reach", "无法连接 {}", "Could not reach {}"),
    ("dsh.discover.status", "{} 返回 HTTP {}", "{} answered HTTP {}"),
    ("dsh.discover.statusAuth", "{} 返回 HTTP {}，请检查 API Key", "{} answered HTTP {}; check the API key"),
    ("dsh.discover.json", "{} 返回的不是 JSON", "{} did not answer with JSON"),
    ("dsh.discover.shape", "端点没有返回模型列表，请手动添加模型", "The endpoint did not answer with a model listing; add models by hand"),
    ("dsh.discover.oversized", "模型列表超过 4 MB，无法读取", "The model listing is larger than 4 MB"),
    ("dsh.discover.key", "API Key 含有 HTTP 头无法携带的字符", "The API key contains characters no HTTP header can carry"),
    ("dsh.model.unavailable", "这个模型是在运行时启动之后才加入的，重启运行时后才能切换", "This model was added after the runtime started; restart the runtime to switch to it"),
    ("dsh.model.unconfigured", "还没有配置模型 API，请先在「Agent → 配置」填写 API 地址与模型", "No model API is configured yet; fill in the API address and model under Agent → Settings"),
    ("dsh.node.missing", "找不到 node。内置 Agent 需要系统安装 Node.js 24.9 或更新版本（不随 App 打包）", "node was not found. The built-in agent needs Node.js 24.9 or newer installed on the system (it is not bundled)"),
    ("dsh.node.tooOld", "{}。内置 Agent 需要 Node.js 24.9 或更新版本", "{}. The built-in agent needs Node.js 24.9 or newer"),
    ("dsh.file.invalid", "这个路径无效", "That path is not valid"),
    ("dsh.file.noSession", "找不到这个会话的工作目录", "That session has no working directory"),
    ("dsh.prompt.empty", "不能发送空消息", "Cannot send an empty message"),
    ("dsh.queue.invalid", "排队消息的内容不是有效的 JSON 数组", "The queued messages are not a valid JSON array"),
    ("dsh.queue.tooLarge", "排队消息太大，无法保存", "The queued messages are too large to save"),
    ("dsh.runtime.exited", "内置 Agent 运行时已退出", "The built-in agent runtime has exited"),
    ("dsh.runtime.interrupted", "内置 Agent 运行时中断了请求", "The built-in agent runtime interrupted the request"),
    ("dsh.runtime.notStarted", "内置 Agent 运行时未启动", "The built-in agent runtime is not running"),
    ("dsh.state.unavailable", "内置 Agent 状态不可用", "The built-in agent state is unavailable"),
];
