//! Query tools: identity, projects and bug lists.

use super::ToolSpec;

pub(super) const TAPD_WHOAMI: ToolSpec = ToolSpec {
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
};

pub(super) const TAPD_LIST_PROJECTS: ToolSpec = ToolSpec {
    name: r#"tapd_list_projects"#,
    description: r#"列出当前账号可访问的 TAPD 项目（id、名称、最近访问时间）。"#,
    schema: r#"{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}"#,
};

pub(super) const TAPD_LIST_BUGS: ToolSpec = ToolSpec {
    name: r#"tapd_list_bugs"#,
    description: r#"查询 TAPD 缺陷。默认只返回分配给自己的未解决缺陷；支持按项目、处理人、状态、优先级、严重程度、关键词/ID 与时间过滤。"#,
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
      "description": "标题关键词；纯数字按缺陷 ID 精确匹配（完整 ID 或短 ID，可带 #）"
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
};

pub(super) const TAPD_LIST_MY_BUGS: ToolSpec = ToolSpec {
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
      "description": "标题关键词；纯数字按缺陷 ID 精确匹配（完整 ID 或短 ID，可带 #）"
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
};
