//! Workflow tools: desktop notifications.

use serde_json::json;
use tapd_i18n::tr;

use super::{schema, ToolSpec, ARG_WAIT_SECONDS};

pub(super) fn notify_user() -> ToolSpec {
    ToolSpec {
        name: "tapd_notify_user",
        description: tr("mcp.tool.notifyuser"),
        schema: schema(json!({
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": tr("mcp.arg.title"),
                },
                "tone": {
                    "type": "string",
                    "enum": [
                        "info",
                        "success",
                        "warning",
                        "error",
                        "progress",
                    ],
                    "default": "info",
                    "description": tr("mcp.arg.tone"),
                },
                "body": {
                    "type": "string",
                    "description": tr("mcp.arg.body"),
                },
                "fields": {
                    "type": "array",
                    "maxItems": 8,
                    "description": tr("mcp.arg.fieldlist"),
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {
                                "type": "string",
                            },
                            "value": {
                                "type": "string",
                            },
                        },
                        "required": [
                            "label",
                            "value",
                        ],
                        "additionalProperties": false,
                    },
                },
                "progress": {
                    "type": "object",
                    "description": tr("mcp.arg.progress"),
                    "properties": {
                        "percent": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 100,
                        },
                        "label": {
                            "type": "string",
                        },
                    },
                    "additionalProperties": false,
                },
                "blocks": {
                    "type": "array",
                    "maxItems": 8,
                    "description": tr("mcp.arg.blocks"),
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
                                    "divider",
                                ],
                            },
                            "text": {
                                "type": "string",
                            },
                            "language": {
                                "type": "string",
                            },
                            "fields": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": {
                                            "type": "string",
                                        },
                                        "value": {
                                            "type": "string",
                                        },
                                    },
                                    "required": [
                                        "label",
                                        "value",
                                    ],
                                    "additionalProperties": false,
                                },
                            },
                            "percent": {
                                "type": "number",
                                "minimum": 0,
                                "maximum": 100,
                            },
                            "label": {
                                "type": "string",
                            },
                        },
                        "required": [
                            "type",
                        ],
                        "additionalProperties": false,
                    },
                },
                "actions": {
                    "type": "array",
                    "maxItems": 4,
                    "description": tr("mcp.arg.actions"),
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {
                                "type": "string",
                                "description": tr("mcp.arg.actionid"),
                            },
                            "label": {
                                "type": "string",
                                "description": tr("mcp.arg.actionlabel"),
                            },
                            "style": {
                                "type": "string",
                                "enum": [
                                    "primary",
                                    "secondary",
                                    "danger",
                                ],
                                "default": "secondary",
                            },
                        },
                        "required": [
                            "id",
                            "label",
                        ],
                        "additionalProperties": false,
                    },
                },
                "tag": {
                    "type": "string",
                    "description": tr("mcp.arg.tag"),
                },
                "waitSeconds": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 120,
                    "default": 30,
                    "description": tr(ARG_WAIT_SECONDS),
                },
            },
            "required": [
                "title",
            ],
            "additionalProperties": false,
        })),
    }
}

pub(super) fn wait_notification() -> ToolSpec {
    ToolSpec {
        name: "tapd_wait_notification",
        description: tr("mcp.tool.waitnotification"),
        schema: schema(json!({
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": tr("mcp.arg.notificationid"),
                },
                "waitSeconds": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 120,
                    "default": 30,
                },
            },
            "required": [
                "id",
            ],
            "additionalProperties": false,
        })),
    }
}
