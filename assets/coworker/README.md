# 同事包

每位同事是一个目录，目录名就是同事 id（小写字母、数字、连字符）。打开同事页或组装
Agent 任务提示词时，客户端读取 `coworker.json`，把角色与技能包路径注入提示词。

```
assets/coworker/
  schema.json
  author/
    coworker.json
    avatar.png
    skills/
      wwog-engineering/
        SKILL.md
```

## coworker.json

```json
{
  "schemaVersion": 1,
  "name": "Author",
  "role": "程序员",
  "title": "写代码时最像同事的那位",
  "description": "我可能不是你的同事，但此刻我正在和你一起工作。",
  "avatar": "avatar.png",
  "accent": "#0ea5e9",
  "skills": ["skills/wwog-engineering"]
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schemaVersion` | 是 | 固定 `1`。格式升级时递增。 |
| `name` | 是 | 展示名，≤24 字。 |
| `role` | 是 | 角色标签，≤12 字，例如 产品 / 程序员 / 设计 / 测试。 |
| `title` | 否 | 一句话签名，≤40 字。 |
| `description` | 是 | 工作方式与口味，≤200 字；会随提示词一起注入。 |
| `avatar` | 是 | 相对本目录的图片路径；PNG/JPG/WebP/GIF/SVG，≤512KB。 |
| `accent` | 否 | 卡片主色，`#rrggbb`。 |
| `skills` | 是 | 技能包目录列表，路径相对本目录；可以为空数组。 |

约束：

- 路径一律用 `/`，不能是绝对路径，不能包含 `..`。
- `skills` 内每个目录必须有 `SKILL.md`；技能名与描述从 frontmatter 读取，不在
  `coworker.json` 里重复。
- 单个包出错只跳过该包或该技能，并在同事页显示警告。

完整校验规则见 [schema.json](./schema.json)。

## 技能包

沿用技能目录约定，`SKILL.md` 以 YAML frontmatter 开头：

```markdown
---
name: wwog-engineering
description: wwog 的个人工程规范，写代码、改 UI、设计架构时按它执行。
---

# 正文

给 Agent 的完整规范……
```

客户端只把 `SKILL.md` 的绝对路径注入提示词，Agent 在开工前自行读取；技能目录里的
脚本、模板、参考资料保持相对 `SKILL.md` 的路径即可。

## 投稿检查

1. 目录名与 id 一致，只含小写字母、数字、连字符。
2. `coworker.json` 能通过 `schema.json` 校验。
3. 头像存在且不超过 512KB。
4. 每个技能目录有 `SKILL.md`，frontmatter 至少包含 `name` 与 `description`。
5. 描述写「怎么一起工作」，不写与缺陷修复无关的寒暄。
