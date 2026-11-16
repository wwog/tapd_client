//! Bug tools: detail export, transitions, comments and status changes.

use serde_json::json;
use tapd_i18n::tr;

use super::{schema, ToolSpec, ARG_BUG_ID, ARG_ROOT, ARG_WORKSPACE_ID};

pub(super) fn get_bug() -> ToolSpec {
    ToolSpec {
        name: "tapd_get_bug",
        description: tr("mcp.tool.getbug"),
        schema: schema(json!({
            "type": "object",
            "properties": {
                "workspace_id": {
                    "type": "string",
                    "description": tr(ARG_WORKSPACE_ID),
                },
                "root": {
                    "type": "string",
                    "description": tr(ARG_ROOT),
                },
                "bug_id": {
                    "type": "string",
                    "description": tr("mcp.arg.bugidfromlist"),
                },
                "workspace_name": {
                    "type": "string",
                    "description": tr("mcp.arg.workspacename"),
                },
            },
            "required": [
                "bug_id",
            ],
            "additionalProperties": false,
        })),
    }
}

pub(super) fn get_bug_transitions() -> ToolSpec {
    ToolSpec {
        name: "tapd_get_bug_transitions",
        description: tr("mcp.tool.getbugtransitions"),
        schema: schema(json!({
            "type": "object",
            "properties": {
                "workspace_id": {
                    "type": "string",
                    "description": tr(ARG_WORKSPACE_ID),
                },
                "root": {
                    "type": "string",
                    "description": tr(ARG_ROOT),
                },
                "bug_id": {
                    "type": "string",
                    "description": tr(ARG_BUG_ID),
                },
            },
            "required": [
                "bug_id",
            ],
            "additionalProperties": false,
        })),
    }
}

pub(super) fn add_bug_comment() -> ToolSpec {
    ToolSpec {
        name: "tapd_add_bug_comment",
        description: tr("mcp.tool.addbugcomment"),
        schema: schema(json!({
            "type": "object",
            "properties": {
                "workspace_id": {
                    "type": "string",
                },
                "root": {
                    "type": "string",
                    "description": tr(ARG_ROOT),
                },
                "bug_id": {
                    "type": "string",
                    "description": tr(ARG_BUG_ID),
                },
                "comment": {
                    "type": "string",
                    "description": tr("mcp.arg.comment"),
                },
            },
            "required": [
                "bug_id",
                "comment",
            ],
            "additionalProperties": false,
        })),
    }
}

pub(super) fn update_bug_status() -> ToolSpec {
    ToolSpec {
        name: "tapd_update_bug_status",
        description: tr("mcp.tool.updatebugstatus"),
        schema: schema(json!({
            "type": "object",
            "properties": {
                "workspace_id": {
                    "type": "string",
                },
                "root": {
                    "type": "string",
                    "description": tr(ARG_ROOT),
                },
                "bug_id": {
                    "type": "string",
                    "description": tr(ARG_BUG_ID),
                },
                "status": {
                    "type": "string",
                    "description": tr("mcp.arg.status"),
                },
                "comment": {
                    "type": "string",
                    "description": tr("mcp.arg.statuscomment"),
                },
                "fields": {
                    "type": [
                        "object",
                        "array",
                        "null",
                    ],
                    "description": tr("mcp.arg.fields"),
                    "additionalProperties": {
                        "type": "string",
                    },
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {
                                "type": "string",
                            },
                            "field": {
                                "type": "string",
                            },
                            "key": {
                                "type": "string",
                            },
                            "value": {
                                "type": "string",
                            },
                        },
                        "additionalProperties": false,
                    },
                },
            },
            "required": [
                "bug_id",
                "status",
            ],
            "additionalProperties": false,
        })),
    }
}
