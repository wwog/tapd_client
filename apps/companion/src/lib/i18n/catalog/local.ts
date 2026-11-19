/**
 * local catalogue: local projects (desktop folders), their work items, the
 * directory picker and handing an item to the Agent.
 */
import type { Catalog } from "../types";

export const local = {
  /* -- Tab ---------------------------------------------------------------- */
  "mobile.local.title": ["事项", "Items"],

  /* -- Projects ----------------------------------------------------------- */
  "mobile.local.projects": ["本地项目", "Local projects"],
  "mobile.local.newProject": ["新建项目", "New project"],
  "mobile.local.projectName": ["项目名称", "Project name"],
  "mobile.local.projectNamePlaceholder": [
    "留空则用文件夹名",
    "Leave empty to use the folder name",
  ],
  "mobile.local.projectFolder": ["项目文件夹", "Project folder"],
  "mobile.local.projectRule": ["项目规则", "Project rules"],
  "mobile.local.projectRulePlaceholder": [
    "交给 Agent 时附带的规则（可选，支持 Markdown）",
    "Rules attached to every Agent task (optional, Markdown supported)",
  ],
  "mobile.local.editProject": ["编辑项目", "Edit project"],
  "mobile.local.create": ["创建", "Create"],
  "mobile.local.creating": ["创建中…", "Creating…"],
  "mobile.local.noProjects": ["还没有本地项目", "No local projects yet"],
  "mobile.local.noProjectsHint": [
    "新建项目并选择桌面上的文件夹。",
    "Create a project and pick a folder on the desktop.",
  ],

  /* -- Work items --------------------------------------------------------- */
  "mobile.local.pending": ["待处理", "Pending"],
  "mobile.local.inProgress": ["处理中", "In progress"],
  "mobile.local.done": ["已完成", "Done"],
  "mobile.local.statusTabs": ["事项状态", "Item status"],
  "mobile.local.addItem": ["新增事项", "New item"],
  "mobile.local.add": ["添加", "Add"],
  "mobile.local.adding": ["添加中…", "Adding…"],
  "mobile.local.titlePlaceholder": ["事项标题", "Item title"],
  "mobile.local.description": ["描述", "Description"],
  "mobile.local.descriptionPlaceholder": ["补充说明（可选）", "Details (optional)"],
  "mobile.local.emptyPending": ["没有待处理事项", "No items to do"],
  "mobile.local.emptyPendingHint": [
    "点「添加」新建一条事项。",
    "Tap Add to create one.",
  ],
  "mobile.local.emptyDone": ["没有已完成事项", "No done items"],
  "mobile.local.emptyDoneHint": [
    "标记为完成的事项会出现在这里。",
    "Items marked done show up here.",
  ],
  "mobile.local.editItem": ["编辑事项", "Edit item"],

  /* -- Actions ------------------------------------------------------------ */
  "mobile.local.moveToProgress": ["移入处理中", "Move to in progress"],
  "mobile.local.moveToPending": ["移回待处理", "Move back to pending"],
  "mobile.local.markDone": ["标记完成", "Mark done"],
  "mobile.local.reopen": ["重新打开", "Reopen"],
  "mobile.local.deleteConfirm": [
    "删除后无法恢复，确定删除？",
    "This cannot be undone. Delete it?",
  ],

  /* -- Directory picker --------------------------------------------------- */
  "mobile.local.picker.title": ["选择文件夹", "Choose folder"],
  "mobile.local.picker.parent": ["上一级", "Up one level"],
  "mobile.local.picker.empty": ["没有子文件夹", "No subfolders"],
  "mobile.local.picker.confirm": ["选择此目录", "Use this folder"],
  "mobile.local.picker.forbidden": [
    "无法访问该文件夹",
    "Access to this folder is denied",
  ],
  "mobile.local.picker.notFound": ["文件夹不存在", "Folder not found"],
  "mobile.local.picker.loadFailed": ["读取目录失败", "Couldn't load the folder"],
} as const satisfies Catalog;
