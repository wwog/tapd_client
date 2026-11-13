//! Bug write messages. Key format: `bug.topic`.

use crate::Message;

pub static MESSAGES: &[Message] = &[
    ("bug.action.failed", "{}失败：{}", "{} failed: {}"),
    ("bug.comment.add", "添加评论", "Add comment"),
    ("bug.field.update", "修改字段", "Update field"),
    ("bug.none", "无", "None"),
    ("bug.separator", "、", ", "),
    ("bug.status.unknown", "未知状态「{}」；可用状态：{}", "Unknown status \"{}\"; available: {}"),
    ("bug.transition.blocked", "不能从「{}」流转到「{}」；当前允许的下一步：{}", "Cannot move from \"{}\" to \"{}\"; allowed next steps: {}"),
    ("bug.transition.change", "状态流转", "Change status"),
    ("bug.transition.fields", "读取流转字段", "Load transition fields"),
    ("bug.transition.form", "读取流转表单失败，未修改状态：{}", "Could not load the transition form; status unchanged: {}"),
    ("bug.transition.load", "读取状态流转信息", "Load status transitions"),
    ("bug.transition.required", "状态流转需要填写：{}", "Required to change status: {}"),
];
