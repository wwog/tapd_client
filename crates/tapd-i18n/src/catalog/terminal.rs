//! Terminal session messages. Key format: `terminal.topic`.

use crate::Message;

pub static MESSAGES: &[Message] = &[
    ("terminal.createFailed", "无法启动终端：{}", "Couldn't start a terminal: {}"),
    ("terminal.exited", "终端进程已退出", "The terminal process has exited"),
    ("terminal.inputTooLarge", "输入内容过大", "Input is too large"),
    ("terminal.limit", "终端数量已达上限（{}）", "Terminal limit reached ({})"),
    ("terminal.notFound", "终端不存在", "Terminal not found"),
    ("terminal.busy", "终端输入排队过多，请稍后重试", "Too much terminal input is queued; try again"),
    (
        "terminal.ticketInvalid",
        "终端连接票据无效或已过期",
        "The terminal ticket is invalid or expired",
    ),
];
