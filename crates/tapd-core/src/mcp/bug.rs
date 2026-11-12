//! Bug tools: detail, Markdown export, prompt rendering, transitions,
//! comments and status changes.

use super::ToolSpec;

pub(super) const TAPD_GET_BUG: ToolSpec = ToolSpec {
    name: r#"tapd_get_bug"#,
    description: r#"获取缺陷完整详情：描述（含内联图片/视频链接）、评论、附件、元数据与自定义字段。"#,
    schema: r#"{
  "type": "object",
  "properties": {
    "workspace_id": {
      "type": "string",
      "description": "项目 ID；省略时使用上次选择的项目"
    },
    "root": {
      "type": "string",
      "description": "本地仓库/工作目录绝对路径；用于按项目设置里的「本地文件夹」自动匹配 TAPD 项目。省略时由客户端 cwd 自动填入"
    },
    "bug_id": {
      "type": "string",
      "description": "缺陷长 ID（列表返回的 id）"
    }
  },
  "required": [
    "bug_id"
  ],
  "additionalProperties": false
}"#,
};

pub(super) const TAPD_EXPORT_BUG_MD: ToolSpec = ToolSpec {
    name: r#"tapd_export_bug_md"#,
    description: r#"把缺陷导出为可直接交给 AI 的 Markdown 包：bug.md + assets/ + bug.json。返回本地绝对路径。"#,
    schema: r#"{
  "type": "object",
  "properties": {
    "workspace_id": {
      "type": "string",
      "description": "项目 ID；省略时使用上次选择的项目"
    },
    "root": {
      "type": "string",
      "description": "本地仓库/工作目录绝对路径；用于按项目设置里的「本地文件夹」自动匹配 TAPD 项目。省略时由客户端 cwd 自动填入"
    },
    "bug_id": {
      "type": "string",
      "description": "缺陷长 ID"
    },
    "workspace_name": {
      "type": "string",
      "description": "项目名称，仅用于目录命名"
    }
  },
  "required": [
    "bug_id"
  ],
  "additionalProperties": false
}"#,
};

pub(super) const TAPD_GET_BUG_PROMPT: ToolSpec = ToolSpec {
    name: r#"tapd_get_bug_prompt"#,
    description: r#"按缺陷 id 生成一份可直接使用的修复提示词：复用客户端 Agent 的 {{变量}} 渲染，包含项目规则、已启用同事、本地仓库与已导出的 bug.md 路径。默认使用面向外部 AI 的 MCP 模板；kind=agent 返回客户端 Agent 页「配置」中的全局模板原文；也可用 template 传自定义模板。返回 prompt 以及 mdPath / repoPath 等结构化字段。"#,
    schema: r#"{
  "type": "object",
  "properties": {
    "workspace_id": {
      "type": "string",
      "description": "项目 ID；省略时按 root 匹配或使用上次选择的项目"
    },
    "root": {
      "type": "string",
      "description": "本地仓库/工作目录绝对路径；用于按项目设置里的「本地文件夹」自动匹配 TAPD 项目。省略时由客户端 cwd 自动填入"
    },
    "bug_id": {
      "type": "string",
      "description": "缺陷长 ID"
    },
    "kind": {
      "type": "string",
      "enum": [
        "mcp",
        "agent"
      ],
      "default": "mcp",
      "description": "mcp：内置模板（无审核队列，适合外部客户端）；agent：客户端 Agent 页「配置」里的全局模板原文"
    },
    "template": {
      "type": "string",
      "description": "自定义模板，优先级最高。支持 {{title}} {{md_path}} {{repo_path}} {{workspace_name}} {{bug_id}} {{severity}} {{priority}} {{project_rule}} {{coworker}} {{user_prompt}} {{attachments}} {{task_id}}"
    },
    "instructions": {
      "type": "string",
      "description": "补充说明，渲染到 {{user_prompt}}"
    },
    "refresh": {
      "type": "boolean",
      "default": false,
      "description": "强制重新导出 MD 包（默认复用已有导出）"
    }
  },
  "required": [
    "bug_id"
  ],
  "additionalProperties": false
}"#,
};

pub(super) const TAPD_GET_BUG_TRANSITIONS: ToolSpec = ToolSpec {
    name: r#"tapd_get_bug_transitions"#,
    description: r#"读取缺陷的当前状态、状态别名和允许的下一步状态。修改状态前先调用它，避免使用非法的流转目标。"#,
    schema: r#"{
  "type": "object",
  "properties": {
    "workspace_id": {
      "type": "string",
      "description": "项目 ID；省略时使用上次选择的项目"
    },
    "root": {
      "type": "string",
      "description": "本地仓库/工作目录绝对路径；用于按项目设置里的「本地文件夹」自动匹配 TAPD 项目。省略时由客户端 cwd 自动填入"
    },
    "bug_id": {
      "type": "string",
      "description": "缺陷长 ID"
    }
  },
  "required": [
    "bug_id"
  ],
  "additionalProperties": false
}"#,
};

pub(super) const TAPD_ADD_BUG_COMMENT: ToolSpec = ToolSpec {
    name: r#"tapd_add_bug_comment"#,
    description: r#"在缺陷下追加评论（纯文本，自动转换为 TAPD 富文本）。修复完成后用它说明原因、解决方案与影响范围。"#,
    schema: r#"{
  "type": "object",
  "properties": {
    "workspace_id": {
      "type": "string"
    },
    "root": {
      "type": "string",
      "description": "本地仓库/工作目录绝对路径；用于按项目设置里的「本地文件夹」自动匹配 TAPD 项目。省略时由客户端 cwd 自动填入"
    },
    "bug_id": {
      "type": "string",
      "description": "缺陷长 ID"
    },
    "comment": {
      "type": "string",
      "description": "评论正文，可包含换行"
    }
  },
  "required": [
    "bug_id",
    "comment"
  ],
  "additionalProperties": false
}"#,
};

pub(super) const TAPD_UPDATE_BUG_STATUS: ToolSpec = ToolSpec {
    name: r#"tapd_update_bug_status"#,
    description: r#"更新缺陷状态。status 可传 key（如 resolved）或中文名（如 已解决）。若目标不能直接到达（例如 new → 已解决），会自动先流转到处理中再执行。可先调用 tapd_get_bug_transitions 查看允许的下一步。可同时传入 comment，在状态变更前追加说明。"#,
    schema: r#"{
  "type": "object",
  "properties": {
    "workspace_id": {
      "type": "string"
    },
    "root": {
      "type": "string",
      "description": "本地仓库/工作目录绝对路径；用于按项目设置里的「本地文件夹」自动匹配 TAPD 项目。省略时由客户端 cwd 自动填入"
    },
    "bug_id": {
      "type": "string",
      "description": "缺陷长 ID"
    },
    "status": {
      "type": "string",
      "description": "目标状态 key 或中文名，如 resolved / 已解决 / verified / 已验证"
    },
    "comment": {
      "type": "string",
      "description": "可选；状态变更前追加的评论"
    },
    "fields": {
      "description": "可选；透传给 TAPD 流转接口的额外字段，通常为空数组"
    }
  },
  "required": [
    "bug_id",
    "status"
  ],
  "additionalProperties": false
}"#,
};
