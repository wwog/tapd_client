//! Canonical MCP tool manifest shared by the sidecar and the desktop app.
//!
//! The sidecar renders `tools/list` from this manifest and the app dispatches
//! only names declared here, so a tool cannot appear on one side and go
//! missing on the other.

/// One externally visible MCP tool.
#[derive(Debug, Clone, Copy)]
pub struct ToolSpec {
    /// JSON-RPC tool name, e.g. `tapd_list_bugs`.
    pub name: &'static str,
    /// Human-readable description sent to MCP clients.
    pub description: &'static str,
    /// `inputSchema` as JSON text. Consumers parse it before serving it.
    pub schema: &'static str,
}

/// Every MCP tool the product exposes, in `tools/list` order.
pub const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: r#"tapd_whoami"#,
        description: r#"返回当前登录的 TAPD 用户、默认项目和项目数量；传 root 时一并返回按本地目录匹配到的项目。"#,
        schema: r#"{
  "type": "object",
  "properties": {
    "root": {
      "type": "string",
      "description": "本地仓库/工作目录绝对路径；用于按项目设置里的「本地文件夹」自动匹配 TAPD 项目。省略时由客户端 cwd 自动填入"
    }
  },
  "additionalProperties": false
}"#,
    },
    ToolSpec {
        name: r#"tapd_list_projects"#,
        description: r#"列出当前账号可访问的 TAPD 项目（id、名称、最近访问时间）。"#,
        schema: r#"{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}"#,
    },
    ToolSpec {
        name: r#"tapd_list_bugs"#,
        description: r#"查询 TAPD 缺陷。默认只返回分配给自己的未解决缺陷；支持按项目、处理人、状态、优先级、严重程度、关键词与时间过滤。"#,
        schema: r#"{
  "type": "object",
  "properties": {
    "workspace_id": {
      "type": "string",
      "description": "项目 ID；省略时使用客户端上次选择的项目"
    },
    "root": {
      "type": "string",
      "description": "本地仓库/工作目录绝对路径；用于按项目设置里的「本地文件夹」自动匹配 TAPD 项目。省略时由客户端 cwd 自动填入"
    },
    "owner": {
      "type": "string",
      "description": "处理人：me（默认）、all，或精确的 TAPD 昵称"
    },
    "statuses": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "状态 key，如 new、in_progress、resolved、reopened"
    },
    "priorities": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "优先级：urgent、high、medium、low、insignificant"
    },
    "severities": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "严重程度：fatal、serious、normal、prompt、advice"
    },
    "keyword": {
      "type": "string",
      "description": "标题关键词"
    },
    "only_unresolved": {
      "type": "boolean",
      "default": true,
      "description": "仅在未指定 statuses 时生效"
    },
    "modified_after": {
      "type": "string",
      "description": "最后修改时间下界，格式 YYYY-MM-DD HH:MM:SS"
    },
    "created_after": {
      "type": "string",
      "description": "创建时间下界，格式 YYYY-MM-DD HH:MM:SS"
    },
    "page": {
      "type": "integer",
      "minimum": 1,
      "default": 1
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50,
      "default": 20
    }
  },
  "additionalProperties": false
}"#,
    },
    ToolSpec {
        name: r#"tapd_list_my_bugs"#,
        description: r#"查询分配给自己、未解决的缺陷（tapd_list_bugs 的便捷封装）。"#,
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
    "statuses": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "状态 key，如 new、in_progress、resolved、reopened"
    },
    "priorities": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "优先级：urgent、high、medium、low、insignificant"
    },
    "severities": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "严重程度：fatal、serious、normal、prompt、advice"
    },
    "keyword": {
      "type": "string",
      "description": "标题关键词"
    },
    "only_unresolved": {
      "type": "boolean",
      "default": true,
      "description": "仅在未指定 statuses 时生效"
    },
    "modified_after": {
      "type": "string",
      "description": "最后修改时间下界，格式 YYYY-MM-DD HH:MM:SS"
    },
    "created_after": {
      "type": "string",
      "description": "创建时间下界，格式 YYYY-MM-DD HH:MM:SS"
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50,
      "default": 20
    },
    "page": {
      "type": "integer",
      "minimum": 1,
      "default": 1
    }
  },
  "additionalProperties": false
}"#,
    },
    ToolSpec {
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
    },
    ToolSpec {
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
    },
    ToolSpec {
        name: r#"tapd_get_bug_prompt"#,
        description: r#"按缺陷 id 生成一份可直接使用的修复提示词：复用客户端 Agent 的 {{变量}} 渲染，包含项目规则、本地仓库与已导出的 bug.md 路径。默认使用面向外部 AI 的 MCP 模板；kind=agent 返回「设置 → Agent 修复」中的全局模板原文；也可用 template 传自定义模板。返回 prompt 以及 mdPath / repoPath 等结构化字段。"#,
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
      "description": "mcp：内置模板（无审核队列，适合外部客户端）；agent：客户端「设置 → Agent 修复」里的全局模板原文"
    },
    "template": {
      "type": "string",
      "description": "自定义模板，优先级最高。支持 {{title}} {{md_path}} {{repo_path}} {{workspace_name}} {{bug_id}} {{severity}} {{priority}} {{project_rule}} {{user_prompt}} {{attachments}} {{task_id}}"
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
    },
    ToolSpec {
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
    },
    ToolSpec {
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
    },
    ToolSpec {
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
    },
    ToolSpec {
        name: r#"tapd_claim_bug"#,
        description: r#"声明你（外部 AI）开始处理某个缺陷。桌面客户端会在列表里显示“客户端”正在使用“模型”进行处理，并禁止本地 Agent 重复入队；如果本地 Agent 正在处理会返回 conflict 并拒绝你，如果本地 Agent 只是排队则会取消它的排队任务。占用 15 分钟无心跳自动失效，处理期间请每隔几分钟再次调用本工具续约，完成后调用 tapd_release_bug。"#,
        schema: r#"{
  "type": "object",
  "properties": {
    "bug_id": {
      "type": "string",
      "description": "缺陷长 ID"
    },
    "workspace_id": {
      "type": "string",
      "description": "项目 ID；省略时按 root 匹配或使用上次选择的项目"
    },
    "root": {
      "type": "string",
      "description": "本地仓库/工作目录绝对路径；用于按项目设置里的「本地文件夹」自动匹配 TAPD 项目。省略时由客户端 cwd 自动填入"
    },
    "model": {
      "type": "string",
      "description": "你当前使用的模型名，例如 Deepseek，用于列表展示"
    },
    "status": {
      "type": "string",
      "enum": [
        "running",
        "queued"
      ],
      "default": "running",
      "description": "running=已经开始处理；queued=还在你自己的队列里排队"
    },
    "title": {
      "type": "string",
      "description": "缺陷标题（可选，接管本地排队任务时用于通知文案）"
    },
    "note": {
      "type": "string",
      "description": "可选备注"
    }
  },
  "required": [
    "bug_id"
  ],
  "additionalProperties": false
}"#,
    },
    ToolSpec {
        name: r#"tapd_release_bug"#,
        description: r#"结束你（外部 AI）对某个缺陷的占用。修复完成、放弃或需要让本地 Agent 接手时调用；只能释放自己客户端的占用。"#,
        schema: r#"{
  "type": "object",
  "properties": {
    "bug_id": {
      "type": "string",
      "description": "缺陷长 ID"
    },
    "workspace_id": {
      "type": "string",
      "description": "项目 ID；省略时按 root 匹配或使用上次选择的项目"
    },
    "root": {
      "type": "string",
      "description": "本地仓库/工作目录绝对路径；用于按项目设置里的「本地文件夹」自动匹配 TAPD 项目。省略时由客户端 cwd 自动填入"
    }
  },
  "required": [
    "bug_id"
  ],
  "additionalProperties": false
}"#,
    },
    ToolSpec {
        name: r#"tapd_notify_user"#,
        description: r#"在用户桌面顶部的胶囊窗口唤起一条通知，并等待用户操作后返回结果（默认最多 30 秒）。用于任务完成、失败、需要确认等场景。tone 决定成功/失败/提示配色；body、fields、progress 是简写内容；blocks 可精确控制内容块（text / code / fields / progress / divider）；actions 是用户可点击的按钮。返回 status：acted（附 actionId/actionLabel）、dismissed、timeout、pending 或 replaced。waitSeconds=0 时立即返回 pending，之后可用 tapd_wait_notification 继续等待。"#,
        schema: r#"{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "description": "通知标题，建议不超过 40 字"
    },
    "tone": {
      "type": "string",
      "enum": [
        "info",
        "success",
        "warning",
        "error",
        "progress"
      ],
      "default": "info",
      "description": "配色与图标：success 成功 / error 失败 / warning 警告 / progress 进行中 / info 提示"
    },
    "body": {
      "type": "string",
      "description": "正文，保留换行；与 blocks 同时提供时 blocks 优先"
    },
    "fields": {
      "type": "array",
      "maxItems": 8,
      "description": "键值对列表，最多 8 项",
      "items": {
        "type": "object",
        "properties": {
          "label": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "required": [
          "label",
          "value"
        ],
        "additionalProperties": false
      }
    },
    "progress": {
      "type": "object",
      "description": "进度条",
      "properties": {
        "percent": {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        },
        "label": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "blocks": {
      "type": "array",
      "maxItems": 8,
      "description": "结构化内容块；类型：text / code / fields / progress / divider",
      "items": {
        "type": "object",
        "properties": {
          "type": {
            "type": "string",
            "enum": [
              "text",
              "code",
              "fields",
              "progress",
              "divider"
            ]
          },
          "text": {
            "type": "string"
          },
          "language": {
            "type": "string"
          },
          "fields": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "label": {
                  "type": "string"
                },
                "value": {
                  "type": "string"
                }
              },
              "required": [
                "label",
                "value"
              ],
              "additionalProperties": false
            }
          },
          "percent": {
            "type": "number",
            "minimum": 0,
            "maximum": 100
          },
          "label": {
            "type": "string"
          }
        },
        "required": [
          "type"
        ],
        "additionalProperties": false
      }
    },
    "actions": {
      "type": "array",
      "maxItems": 4,
      "description": "可点击按钮；用户点击后调用方会收到对应的 actionId。不传时只显示「知道了」",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "回传给你的动作标识，如 confirm / cancel / retry"
          },
          "label": {
            "type": "string",
            "description": "按钮文案，建议不超过 6 字"
          },
          "style": {
            "type": "string",
            "enum": [
              "primary",
              "secondary",
              "danger"
            ],
            "default": "secondary"
          }
        },
        "required": [
          "id",
          "label"
        ],
        "additionalProperties": false
      }
    },
    "tag": {
      "type": "string",
      "description": "可选；相同 tag 的待处理通知会被替换，适合进度类更新"
    },
    "waitSeconds": {
      "type": "integer",
      "minimum": 0,
      "maximum": 120,
      "default": 30,
      "description": "等待用户操作的秒数；0 = 立即返回。最长 120 秒"
    }
  },
  "required": [
    "title"
  ],
  "additionalProperties": false
}"#,
    },
    ToolSpec {
        name: r#"tapd_wait_notification"#,
        description: r#"等待一条之前通过 tapd_notify_user 唤起的通知的决定结果（用户点击按钮或关闭）。返回 status：acted（附 actionId/actionLabel）、dismissed、timeout、pending 或 expired。"#,
        schema: r#"{
  "type": "object",
  "properties": {
    "id": {
      "type": "string",
      "description": "tapd_notify_user 返回的通知 id"
    },
    "waitSeconds": {
      "type": "integer",
      "minimum": 0,
      "maximum": 120,
      "default": 30
    }
  },
  "required": [
    "id"
  ],
  "additionalProperties": false
}"#,
    },
    ToolSpec {
        name: r#"tapd_request_review"#,
        description: r#"仅用于客户端 Agent 修复流程：改动复杂、需要用户确认后再提交时调用。它会暂停当前 Agent 任务并出现在「待审核」页；用户通过后任务重新入队并收到「审核已通过」的提交提示词，用户停止则储藏未提交改动并暂停队列。调用后请结束本轮，不要继续 commit，也不要在提交前修改 TAPD。简单改动请按提示词直接提交，不要调用本工具。"#,
        schema: r#"{
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "description": "当前 Agent 任务 id（提示词中的 {{task_id}}）"
    },
    "summary": {
      "type": "string",
      "description": "改动摘要：根因、方案与影响范围"
    },
    "files": {
      "type": "array",
      "maxItems": 50,
      "items": {
        "type": "string"
      },
      "description": "本次修改涉及的文件路径"
    },
    "risk": {
      "type": "string",
      "description": "可选；风险点或需要用户重点确认的地方"
    }
  },
  "required": [
    "taskId",
    "summary"
  ],
  "additionalProperties": false
}"#,
    },
    ToolSpec {
        name: r#"agent_task_report"#,
        description: r#"仅用于客户端 Agent 修复流程（非 ACP 运行时）：向 TAPD 客户端回报任务生命周期。status=completed 表示修复并回写完成；failed 表示无法完成；needs_review 表示需要人工确认（附带 summary/files/risk）；progress 仅追加一条进度说明。ACP 运行时不需要调用本工具。"#,
        schema: r#"{
  "type": "object",
  "properties": {
    "taskId": {
      "type": "string",
      "description": "当前 Agent 任务 id（提示词中的 {{task_id}}）"
    },
    "status": {
      "type": "string",
      "enum": [
        "completed",
        "failed",
        "needs_review",
        "progress"
      ]
    },
    "message": {
      "type": "string",
      "description": "完成/失败/进度说明；needs_review 时作为审核摘要"
    },
    "files": {
      "type": "array",
      "maxItems": 50,
      "items": {
        "type": "string"
      },
      "description": "needs_review 时本次修改涉及的文件"
    },
    "risk": {
      "type": "string",
      "description": "needs_review 时的风险说明"
    }
  },
  "required": [
    "taskId",
    "status"
  ],
  "additionalProperties": false
}"#,
    },
];

/// Looks up a tool by its external name.
pub fn tool(name: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|tool| tool.name == name)
}

/// Iterates over every external tool name in manifest order.
pub fn names() -> impl Iterator<Item = &'static str> {
    TOOLS.iter().map(|tool| tool.name)
}

#[cfg(test)]
mod tests {
    use super::{names, tool, TOOLS};

    #[test]
    fn manifest_exposes_sixteen_unique_tool_names() {
        assert_eq!(TOOLS.len(), 16);

        let mut seen = std::collections::HashSet::new();
        for name in names() {
            assert!(!name.is_empty());
            assert!(seen.insert(name), "duplicate tool name: {name}");
        }
        assert_eq!(seen.len(), TOOLS.len());
    }

    #[test]
    fn every_schema_is_a_valid_object_schema() {
        for spec in TOOLS {
            let schema: serde_json::Value = serde_json::from_str(spec.schema)
                .unwrap_or_else(|error| panic!("{}: invalid schema JSON: {error}", spec.name));
            let object = schema
                .as_object()
                .unwrap_or_else(|| panic!("{}: schema is not a JSON object", spec.name));
            assert_eq!(
                object.get("type").and_then(serde_json::Value::as_str),
                Some("object"),
                "{}: inputSchema type must be object",
                spec.name
            );
        }
    }

    #[test]
    fn lookup_finds_every_declared_name() {
        for spec in TOOLS {
            let found = tool(spec.name).unwrap_or_else(|| panic!("missing {}", spec.name));
            assert_eq!(found.name, spec.name);
        }
        assert!(tool("tapd_does_not_exist").is_none());
    }
}
