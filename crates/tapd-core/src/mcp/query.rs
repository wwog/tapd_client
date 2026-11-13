//! Query tools: identity, projects and bug lists.

use serde_json::json;
use tapd_i18n::tr;

use super::{
    schema, ToolSpec, ARG_CREATED_AFTER, ARG_KEYWORD, ARG_MODIFIED_AFTER, ARG_ONLY_UNRESOLVED,
    ARG_PRIORITIES, ARG_ROOT, ARG_SEVERITIES, ARG_STATUSES, ARG_WORKSPACE_ID,
};

pub(super) fn whoami() -> ToolSpec {
    ToolSpec {
        name: "tapd_whoami",
        description: tr("mcp.tool.whoami"),
        schema: schema(json!({
            "type": "object",
            "properties": {
                "root": {
                    "type": "string",
                    "description": tr(ARG_ROOT),
                },
            },
            "additionalProperties": false,
        })),
    }
}

pub(super) fn list_projects() -> ToolSpec {
    ToolSpec {
        name: "tapd_list_projects",
        description: tr("mcp.tool.listprojects"),
        schema: schema(json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false,
        })),
    }
}

pub(super) fn list_bugs() -> ToolSpec {
    ToolSpec {
        name: "tapd_list_bugs",
        description: tr("mcp.tool.listbugs"),
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
                "owner": {
                    "type": "string",
                    "description": tr("mcp.arg.owner"),
                },
                "statuses": {
                    "type": "array",
                    "items": {
                        "type": "string",
                    },
                    "description": tr(ARG_STATUSES),
                },
                "priorities": {
                    "type": "array",
                    "items": {
                        "type": "string",
                    },
                    "description": tr(ARG_PRIORITIES),
                },
                "severities": {
                    "type": "array",
                    "items": {
                        "type": "string",
                    },
                    "description": tr(ARG_SEVERITIES),
                },
                "keyword": {
                    "type": "string",
                    "description": tr(ARG_KEYWORD),
                },
                "only_unresolved": {
                    "type": "boolean",
                    "default": true,
                    "description": tr(ARG_ONLY_UNRESOLVED),
                },
                "modified_after": {
                    "type": "string",
                    "description": tr(ARG_MODIFIED_AFTER),
                },
                "created_after": {
                    "type": "string",
                    "description": tr(ARG_CREATED_AFTER),
                },
                "page": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 1,
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 50,
                    "default": 20,
                },
            },
            "additionalProperties": false,
        })),
    }
}

pub(super) fn list_my_bugs() -> ToolSpec {
    ToolSpec {
        name: "tapd_list_my_bugs",
        description: tr("mcp.tool.listmybugs"),
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
                "statuses": {
                    "type": "array",
                    "items": {
                        "type": "string",
                    },
                    "description": tr(ARG_STATUSES),
                },
                "priorities": {
                    "type": "array",
                    "items": {
                        "type": "string",
                    },
                    "description": tr(ARG_PRIORITIES),
                },
                "severities": {
                    "type": "array",
                    "items": {
                        "type": "string",
                    },
                    "description": tr(ARG_SEVERITIES),
                },
                "keyword": {
                    "type": "string",
                    "description": tr(ARG_KEYWORD),
                },
                "only_unresolved": {
                    "type": "boolean",
                    "default": true,
                    "description": tr(ARG_ONLY_UNRESOLVED),
                },
                "modified_after": {
                    "type": "string",
                    "description": tr(ARG_MODIFIED_AFTER),
                },
                "created_after": {
                    "type": "string",
                    "description": tr(ARG_CREATED_AFTER),
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 50,
                    "default": 20,
                },
                "page": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 1,
                },
            },
            "additionalProperties": false,
        })),
    }
}
