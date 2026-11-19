/** local catalogue: local-only projects and their work items. */
import type { Catalog } from "../types";

export const local = {
  // Navigation and page heading
  "app.nav.local": ["事项", "Items"],

  // Local project list, dialog and section
  "local.projects.title": ["本地项目", "Local projects"],
  "local.projects.hint": [
    "本地项目只保存在本机，不连接 TAPD",
    "Local projects stay on this machine and never touch TAPD",
  ],
  "local.projects.create": ["新建本地项目", "New local project"],
  "local.projects.edit": ["编辑本地项目", "Edit local project"],
  "local.projects.delete": ["删除本地项目", "Delete local project"],
  "local.projects.deleteConfirm": [
    "删除「{name}」及其全部事项？",
    "Delete \"{name}\" and all its items?",
  ],
  "local.projects.empty": ["还没有本地项目", "No local projects yet"],
  "local.projects.name": ["名称", "Name"],
  "local.projects.nameHint": ["留空则使用目录名", "Leave empty to use the folder name"],
  "local.projects.folder": ["目录", "Folder"],
  "local.projects.chooseFolder": ["选择目录", "Choose folder"],
  "local.projects.folderRequired": ["请先选择目录", "Choose a folder first"],
  "local.projects.rule": ["项目规则", "Project rules"],
  "local.projects.rulePlaceholder": [
    "追加到本地 Agent 提示词的规则（可选）",
    "Rules appended to local Agent prompts (optional)",
  ],
  "local.projects.ruleHint": [
    "保存后会追加到该项目交给 Agent 的任务提示词",
    "Appended to Agent task prompts handed over from this project",
  ],

  // Work items
  "local.items.pending": ["待处理", "Pending"],
  "local.items.inProgress": ["处理中", "In progress"],
  "local.items.done": ["已完成", "Done"],
  "local.items.create": ["新增事项", "New item"],
  "local.items.edit": ["编辑事项", "Edit item"],
  "local.items.menu": ["事项操作", "Item actions"],
  "local.items.toAgent": ["交给 Agent", "Hand to Agent"],
  "local.items.toAgentHint": [
    "交给内置 Agent 处理这个事项",
    "Hand this item to the built-in agent",
  ],
  "local.items.moveToProgress": ["移入处理中", "Move to in progress"],
  "local.items.moveToPending": ["移回待处理", "Move back to pending"],
  "local.items.markDone": ["标记完成", "Mark done"],
  "local.items.reopen": ["重新打开", "Reopen"],
  "local.items.delete": ["删除事项", "Delete item"],
  "local.items.deleteConfirm": ["删除事项「{title}」？", "Delete \"{title}\"?"],
  "local.items.emptyPending": ["没有待处理的事项", "No pending items"],
  "local.items.emptyInProgress": ["没有处理中的事项", "No items in progress"],
  "local.items.emptyDone": ["没有已完成的事项", "No completed items"],
  "local.items.emptyHint": [
    "点「新增事项」创建；交给 Agent 后会显示任务状态",
    "Use \"New item\" to add one; a linked Agent task shows its status here",
  ],
  "local.items.noProject": ["还没有选择本地项目", "No local project selected"],
  "local.items.noProjectHint": [
    "在项目页新建或选择一个本地项目",
    "Create or select a local project on the Projects page",
  ],
  "local.items.titlePlaceholder": ["事项标题", "Item title"],
  "local.items.description": ["描述", "Description"],
  "local.items.descriptionPlaceholder": ["补充说明（可选）", "Details (optional)"],
  "local.items.titleRequired": ["请填写标题", "Enter a title"],
  "local.items.loadFailed": ["事项加载失败", "Couldn't load items"],
} as const satisfies Catalog;
