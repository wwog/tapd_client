/**
 * chat catalogue: 对话 page (ChatPage) and the shared pickers it uses.
 *
 * The agent transcript strings live in `workbench.ts`; this file covers the
 * conversation list, the new-conversation form and the session header.
 */
import type { Catalog } from "../types";

export const chat = {
  // Session list.
  "chat.sessions": ["会话", "Sessions"],
  "chat.new": ["新建", "New"],
  "chat.noSessions": ["还没有对话记录", "No conversations yet"],
  "chat.status.starting": ["启动中", "Starting"],
  "chat.status.stopped": ["已停止", "Stopped"],

  // New conversation form.
  "chat.newChat": ["新建对话", "New conversation"],
  "chat.repoDirectHint": [
    "会话会直接在项目仓库目录运行，不创建 worktree。",
    "The session runs directly in the project repository folder; no worktree is created.",
  ],
  "chat.readingConfig": ["正在读取项目配置…", "Reading project config…"],
  "chat.noRepoHint": [
    "请先在「项目」页为 TAPD 项目配置本地仓库路径，然后回到这里开启对话。",
    "Configure a local repository path for the TAPD project on the Projects page, then return here to start a conversation.",
  ],
  "chat.noProjects": ["还没有可用的项目目录", "No project folders available yet"],
  "chat.configureProjects": ["去配置项目", "Configure projects"],
  "chat.fieldProject": ["项目", "Project"],
  "chat.selectProject": ["选择项目", "Select a project"],
  "chat.projectHint": [
    "选择已配置仓库的项目",
    "Choose a project with a configured repository",
  ],
  "chat.selectAgent": [
    "选择本次对话使用的 Agent",
    "Choose the agent for this conversation",
  ],
  "chat.fieldModel": ["模型", "Model"],
  "chat.sessionModelHint": [
    "本次对话的模型；留空使用运行时的默认模型",
    "Model for this conversation; leave empty to use the runtime default",
  ],
  "chat.fieldPermission": ["权限", "Permission"],
  "chat.noAgents": [
    "没有检测到可用的 Agent，请先在「Agent → 配置」里检查命令与安装状态。",
    "No available agent detected; check the command and install status under Agent > Config.",
  ],
  "chat.startChat": ["开始对话", "Start conversation"],

  // Session header and status.
  "chat.stop": ["停止", "Stop"],
  "chat.resume": ["继续会话", "Resume session"],
  "chat.resumeHint": [
    "用同一个 CLI 会话继续对话",
    "Continue in the same CLI session",
  ],
  "chat.resumeUnavailable": [
    "该运行时没有捕获到会话 id，无法续接",
    "This runtime did not capture a session id, so the conversation cannot be resumed",
  ],
  "chat.confirmDelete": ["确认删除", "Confirm delete"],
  "chat.startingAgent": ["正在启动 Agent…", "Starting the agent…"],
  "chat.startingHint": [
    "首次输出后即可在对话中发送消息，也可以先切换到终端查看启动过程。",
    "You can send messages once the first output arrives, or switch to the terminal to watch it start.",
  ],
  "chat.noChatView": [
    "该运行时不支持对话视图",
    "This runtime does not support the chat view",
  ],
  "chat.terminalFallback": [
    "重新开始会话后，可以在终端中继续操作。",
    "Restart the session to continue working in the terminal.",
  ],

  // Model options (lib/agentModels.ts).
  "chat.runtimeDefaultModel": [
    "使用运行时的默认模型",
    "Use the runtime default model",
  ],
  "chat.recentModels": ["最近使用", "Recently used"],
} as const satisfies Catalog;
