//! Workflow tools: client-side claim/release, desktop notifications,
//! review and task reporting.

use super::ToolSpec;

pub(super) const TAPD_CLAIM_BUG: ToolSpec = ToolSpec {
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
};

pub(super) const TAPD_RELEASE_BUG: ToolSpec = ToolSpec {
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
};

pub(super) const TAPD_NOTIFY_USER: ToolSpec = ToolSpec {
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
};

pub(super) const TAPD_WAIT_NOTIFICATION: ToolSpec = ToolSpec {
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
};

pub(super) const TAPD_REQUEST_REVIEW: ToolSpec = ToolSpec {
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
};

pub(super) const AGENT_TASK_REPORT: ToolSpec = ToolSpec {
    name: r#"agent_task_report"#,
    description: r#"仅用于客户端 Agent 修复流程（通用 TUI 运行时）：向 TAPD 客户端回报任务生命周期。status=completed 表示修复并回写完成；failed 表示无法完成；needs_review 表示需要人工确认（附带 summary/files/risk）；progress 仅追加一条进度说明。所有运行时都应在结束本轮时调用本工具；未调用时客户端按进程退出或输出静默兜底。"#,
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
};
