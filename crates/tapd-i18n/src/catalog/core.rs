//! Messages for `tapd-core`: TAPD status / priority / severity labels and the
//! fallbacks the change-history parser renders. Key format: `core.topic`.

use crate::Message;

pub static MESSAGES: &[Message] = &[
    // -- bug status --------------------------------------------------------
    ("core.status.new", "新", "New"),
    ("core.status.inprogress", "接受/处理", "Processing"),
    ("core.status.resolved", "已解决", "Resolved"),
    ("core.status.verified", "已验证", "Verified"),
    ("core.status.reopened", "重新打开", "Reopened"),
    ("core.status.rejected", "已拒绝", "Rejected"),
    ("core.status.closed", "已关闭", "Closed"),
    ("core.status.open", "未开始", "Open"),
    ("core.status.progressing", "进行中", "In progress"),
    ("core.status.done", "已完成", "Done"),
    // -- bug priority ------------------------------------------------------
    ("core.priority.urgent", "紧急", "Urgent"),
    ("core.priority.high", "高", "High"),
    ("core.priority.medium", "中", "Medium"),
    ("core.priority.low", "低", "Low"),
    ("core.priority.insignificant", "无关紧要", "Insignificant"),
    // -- bug severity ------------------------------------------------------
    ("core.severity.fatal", "致命", "Fatal"),
    ("core.severity.serious", "严重", "Serious"),
    ("core.severity.normal", "一般", "Normal"),
    ("core.severity.prompt", "提示", "Prompt"),
    ("core.severity.advice", "建议", "Advice"),
    // -- change history ----------------------------------------------------
    ("core.changes.image", "[图片]", "[Image]"),
];
