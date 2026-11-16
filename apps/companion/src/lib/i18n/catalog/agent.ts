/** agent catalogue: built-in dsh runtime status, sessions and transcripts. */
import type { Catalog } from "../types";

export const agent = {
  /* -- Tab ---------------------------------------------------------------- */
  "mobile.agent.newSession": ["新建会话", "New session"],
  "mobile.agent.creating": ["创建中…", "Creating…"],
  "mobile.agent.loading": ["正在读取会话…", "Reading sessions…"],
  "mobile.agent.loadFailed": ["读取会话失败", "Couldn't load sessions"],
  "mobile.agent.newSessionFailed": ["新建会话失败", "Couldn't create a session"],
  "mobile.agent.empty": ["还没有会话", "No sessions yet"],
  "mobile.agent.emptyHint": ["新建一个会话开始对话。", "Start a session to begin."],

  /* -- Runtime status ----------------------------------------------------- */
  "mobile.agent.phaseStopped": ["未启动", "Stopped"],
  "mobile.agent.phaseStarting": ["启动中", "Starting"],
  "mobile.agent.phaseReady": ["已就绪", "Ready"],
  "mobile.agent.phaseFailed": ["启动失败", "Failed"],
  "mobile.agent.statusLoadFailed": [
    "读取运行时状态失败",
    "Couldn't read the runtime status",
  ],
  "mobile.agent.startFailed": ["启动运行时失败", "Couldn't start the runtime"],

  /* -- Session list ------------------------------------------------------- */
  "mobile.agent.untitledSession": ["未命名会话", "Untitled session"],
  "mobile.agent.sessionIdle": ["空闲", "Idle"],
  "mobile.agent.sessionRunning": ["运行中", "Running"],

  /* -- Session view ------------------------------------------------------- */
  "mobile.agent.syncing": ["同步中", "Syncing"],
  "mobile.agent.entriesLoadFailed": ["读取消息失败", "Couldn't load messages"],
  "mobile.agent.emptyTranscript": ["还没有消息", "No messages yet"],
  "mobile.agent.emptyTranscriptHint": [
    "在下方输入第一条消息。",
    "Type the first message below.",
  ],
  "mobile.agent.composerPlaceholder": ["给 Agent 发消息", "Message the Agent"],
  "mobile.agent.composerHint": [
    "Enter 发送，Shift+Enter 换行。",
    "Enter to send, Shift+Enter for a new line.",
  ],
  "mobile.agent.promptFailed": ["发送失败", "Couldn't send the message"],
  "mobile.agent.reasoning": ["思考过程", "Reasoning"],
  "mobile.agent.toolRunning": ["运行中", "Running"],
  "mobile.agent.toolArgs": ["参数", "Arguments"],
  "mobile.agent.toolResult": ["结果", "Result"],
  "mobile.agent.turnEnded": ["本轮结束", "Turn ended"],
  "mobile.agent.approvalTitle": [
    "审批与提问需在桌面端处理",
    "Approvals and questions are handled on the desktop",
  ],
  "mobile.agent.approvalHint": [
    "手机端暂时不能应答 Agent 的审批与提问；出现时请在桌面端处理。",
    "The phone cannot answer Agent approvals or questions in this phase; handle them on the desktop.",
  ],
} as const satisfies Catalog;
