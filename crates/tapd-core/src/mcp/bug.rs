//! Bug tools: detail export, transitions, comments and status changes.

use super::ToolSpec;

pub(super) const TAPD_GET_BUG: ToolSpec = ToolSpec {
    name: r#"tapd_get_bug"#,
    description: r#"获取缺陷详情并导出修复包：写入 bug.json（缺陷详情 + 已成功下载的 assets 列表）与 assets/ 下的截图、视频、附件，一次调用返回 bugJson（绝对路径）、assetCount、downloadedBytes、warnings，以及渲染好的修复提示词 prompt（可直接作为本轮任务说明）。返回的 skills 是已启用同事的技能包（name 为键，path 为 SKILL.md 绝对路径），动手前先完整读取；没有可用技能时为 {}。projectRule 是需要遵守的项目规则（可能为空字符串），随 prompt 之外的字段单独返回。"#,
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
    },
    "workspace_name": {
      "type": "string",
      "description": "项目名称，仅用于导出目录命名与提示词展示"
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
    description: r#"更新缺陷状态。status 可传 key（如 resolved）或中文名（如 已解决）。若目标不能直接到达（例如 new → 已解决），会自动先流转到处理中再执行。可先调用 tapd_get_bug_transitions 查看允许的下一步。可同时传入 comment，在状态变更前追加说明。客户端会按 TAPD 工作流配置自动填充本次流转所需的工作流字段默认值（处理人/开发人员/测试人员等，与 TAPD 网页端流转弹窗一致），可用 fields 覆盖这些默认值。"#,
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
      "type": [
        "object",
        "array",
        "null"
      ],
      "description": "可选；覆盖本次流转的工作流字段默认值。推荐用对象映射，例如 {\"current_owner\":\"张三\",\"resolution\":\"fixed\"}；也接受 [{ \"name\": \"current_owner\", \"value\": \"张三\" }] 形式的行数组（字段名也可用 field 或 key）。未提供的字段沿用 TAPD 工作流配置（如处理人取记录值或创建人）；null 或空数组 [] 都表示全部使用工作流默认值。",
      "additionalProperties": {
        "type": "string"
      },
      "items": {
        "type": "object",
        "properties": {
          "name": {
            "type": "string"
          },
          "field": {
            "type": "string"
          },
          "key": {
            "type": "string"
          },
          "value": {
            "type": "string"
          }
        },
        "additionalProperties": false
      }
    }
  },
  "required": [
    "bug_id",
    "status"
  ],
  "additionalProperties": false
}"#,
};
