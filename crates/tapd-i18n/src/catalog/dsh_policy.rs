//! Messages for the built-in agent's permission modes and capsule approvals.

use crate::Message;

pub static MESSAGES: &[Message] = &[
    ("dsh.policy.approval.allow", "允许一次", "Allow once"),
    ("dsh.policy.approval.reject", "拒绝", "Reject"),
    ("dsh.policy.approval.title", "需要授权：{}", "Approval required: {}"),
    ("dsh.policy.bridge.offline", "内置 Agent 尚未连上桥接", "The built-in agent is not connected to the bridge yet"),
    ("dsh.policy.client", "内置 Agent", "Built-in agent"),
    ("dsh.policy.field.reason", "原因", "Reason"),
    ("dsh.policy.field.target", "目标", "Target"),
    ("dsh.policy.field.tool", "工具", "Tool"),
    ("dsh.policy.notice.title", "即将执行：{}", "About to run: {}"),
    ("dsh.policy.question.open", "去处理", "Handle"),
    // `tr_args` fills positional placeholders; a named one stays literal.
    ("dsh.policy.question.summary", "需要你选择 {} 项", "{} questions need your answer"),
    ("dsh.policy.question.title", "需要你选择", "Your answer is needed"),
    ("dsh.policy.reason.hard", "命中高风险操作：{}", "High-risk operation: {}"),
    ("dsh.policy.reason.soft", "命中敏感操作：{}", "Sensitive operation: {}"),
    ("dsh.policy.unknown", "{} 不是可用的权限模式", "{} is not an available permission mode"),
];
