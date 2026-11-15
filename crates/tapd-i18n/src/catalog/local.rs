//! Local-only projects and work items. Key format: `local.topic`.

use crate::Message;

pub static MESSAGES: &[Message] = &[
    (
        "local.browse.forbidden",
        "只能浏览主目录或已存在的本地项目目录",
        "Only the home folder or a local project folder can be browsed",
    ),
    ("local.item.notfound", "事项不存在", "Work item not found"),
    (
        "local.item.status",
        "未知的事项状态：{}",
        "Unknown work item status: {}",
    ),
    (
        "local.item.task",
        "Agent 任务 ID 不能为空",
        "Agent task id cannot be empty",
    ),
    (
        "local.item.title",
        "事项标题不能为空",
        "Work item title cannot be empty",
    ),
    (
        "local.project.duplicate",
        "该仓库路径已被其他本地项目使用",
        "Another local project already uses this repository path",
    ),
    (
        "local.project.name",
        "项目名称不能为空",
        "Project name cannot be empty",
    ),
    (
        "local.project.notfound",
        "本地项目不存在",
        "Local project not found",
    ),
    (
        "local.project.path",
        "仓库路径不能为空",
        "Repository path cannot be empty",
    ),
    (
        "local.project.pathInvalid",
        "仓库路径不存在或不是文件夹：{}",
        "Repository path does not exist or is not a folder: {}",
    ),
    (
        "local.request.missing",
        "缺少参数：{}",
        "Missing parameter: {}",
    ),
    (
        "local.store.failed",
        "本地数据访问失败：{}",
        "Could not access local data: {}",
    ),
    (
        "local.store.unavailable",
        "本地数据存储不可用",
        "The local data store is unavailable",
    ),
];
