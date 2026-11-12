//! Workflow tools: desktop notifications.

use super::ToolSpec;

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
