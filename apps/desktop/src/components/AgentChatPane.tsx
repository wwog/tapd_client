import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import MDEditor from "@uiw/react-md-editor";
import clsx from "clsx";
import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  FilePenLine,
  FileText,
  Globe,
  Loader2,
  Search,
  Send,
  ShieldQuestion,
  Terminal,
  Wrench,
  X,
} from "lucide-react";

import {
  agentApi,
  type AgentChat,
  type AgentChatMessage,
  type AgentChatTool,
  type AgentPendingPrompt,
  type AgentRuntimeStatus,
} from "../lib/agent";
import { describeTool, formatDuration, formatElapsed, oneLine, toolTarget } from "../lib/agentChat";
import { relativeTime } from "../lib/api";
import { AgentIcon } from "./AgentIcon";
import { Button } from "./ui";

type Props = {
  taskId: string;
  runtimeId?: string;
  runtimeName?: string;
  /** 运行中的当前动作；Working 条与权限卡片都来自这里。 */
  status?: AgentRuntimeStatus;
  /** 当前使用的模型；优先用 hook，其次 transcript。 */
  model?: string;
  chat: AgentChat | null;
  /** `agent_chat` 命令本身失败（例如任务已被删除）。 */
  chatError: string | null;
  loading: boolean;
  /** PTY 仍活着：可以发送消息。 */
  live: boolean;
  onSwitchToTerminal: () => void;
  toast: (kind: "ok" | "error", text: string) => void;
};

type PendingMessage = {
  id: string;
  text: string;
  at: number;
  failed?: boolean;
};

const normalizeText = (text?: string) => (text ?? "").replace(/\s+/g, " ").trim();

/** 统一 ticker：Working 条的已用时长和 pending 超时提示共用。 */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * 对话视图：transcript 消息流 + Working 条 + Composer。
 *
 * 消息来自 `agent_chat` 的轮询（由 AgentPage 统一持有），这里只负责展示与
 * 发送。权限 / 提问卡片直接复用 `AgentRuntimeStatus.prompt`，与胶囊一致。
 */
export function AgentChatPane({
  taskId,
  runtimeId,
  runtimeName,
  status,
  model,
  chat,
  chatError,
  loading,
  live,
  onSwitchToTerminal,
  toast,
}: Props) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);

  const messages = chat?.messages ?? [];
  const prompt = status?.prompt;
  const error = chatError ?? chat?.error ?? null;

  // transcript 出现同文本的 user 消息后移除乐观气泡。
  useEffect(() => {
    if (!chat) return;
    const confirmed = chat.messages.filter((message) => message.role === "user");
    setPending((current) => {
      if (current.length === 0) return current;
      const next = current.filter((item) => {
        const at = item.at;
        return !confirmed.some((message) => {
          if (normalizeText(message.text) !== normalizeText(item.text)) return false;
          const time = Date.parse(message.at);
          return !Number.isFinite(time) || time >= at - 5000;
        });
      });
      return next.length === current.length ? current : next;
    });
  }, [chat]);

  // 新消息到达时跟随到底部；用户主动上滚后暂停跟随。
  const messageCount = messages.length;
  const pendingCount = pending.length;
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !nearBottomRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messageCount, pendingCount, status?.updatedAt]);

  useEffect(() => {
    setDraft("");
    setPending([]);
  }, [taskId]);

  const send = async (text: string) => {
    if (!text.trim() || sending || !live) return;
    setSending(true);
    const item: PendingMessage = {
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      text,
      at: Date.now(),
    };
    setPending((current) => [...current, item]);
    setDraft("");
    try {
      await agentApi.sendMessage(taskId, text);
    } catch (cause) {
      setPending((current) =>
        current.map((entry) => (entry.id === item.id ? { ...entry, failed: true } : entry)),
      );
      toast("error", String(cause));
    } finally {
      setSending(false);
    }
  };

  const retry = (item: PendingMessage) => {
    setPending((current) => current.filter((entry) => entry.id !== item.id));
    void send(item.text);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    // 中文输入法确认候选词时的 Enter 不应发送。
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send(draft);
  };

  const empty = messages.length === 0;
  const truncated = chat?.truncated ?? false;
  // 消息数组在未变化时由 hook 复用；这里缓存 JSX，状态每秒刷新时不必重建整棵树。
  const renderedMessages = useMemo(
    () =>
      messages.map((message) => (
        <ChatMessageCard
          key={message.id}
          message={message}
          runtimeId={runtimeId}
          runtimeName={runtimeName}
        />
      )),
    [messages, runtimeId, runtimeName],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-slate-50/40">
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          nearBottomRef.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3"
      >
        {truncated ? (
          <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-ui-xs text-amber-700">
            会话记录较长，仅显示最近 2000 条消息。
          </div>
        ) : null}

        {empty ? (
          <EmptyState
            loading={loading}
            live={live}
            error={error}
            onSwitchToTerminal={onSwitchToTerminal}
          />
        ) : (
          <div className="space-y-2.5">{renderedMessages}</div>
        )}

        {pending.map((item) => (
          <PendingBubble key={item.id} item={item} onRetry={() => retry(item)} />
        ))}

        {status && live ? <WorkingBar status={status} model={model} /> : null}
      </div>

      <div className="shrink-0 border-t border-slate-100 bg-surface px-3 py-2.5">
        {prompt ? (
          <PromptCard
            taskId={taskId}
            prompt={prompt}
            toast={toast}
            onSwitchToTerminal={onSwitchToTerminal}
          />
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              disabled={!live || sending}
              rows={1}
              placeholder={
                live ? "输入要发送给 Agent 的消息…" : "任务已结束，无法继续发送"
              }
              className="max-h-40 min-h-9 flex-1 resize-none rounded-lg border border-border bg-surface px-2.5 py-1.5 text-ui-caption leading-5 text-slate-700 transition placeholder:text-slate-300 focus:border-sky-300 focus:outline-2 focus:outline-sky-200 disabled:bg-slate-50 disabled:text-slate-400"
            />
            <Button
              size="sm"
              variant="primary"
              disabled={!live || sending || !draft.trim()}
              onClick={() => void send(draft)}
              icon={
                sending ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Send size={12} />
                )
              }
            >
              发送
            </Button>
          </div>
        )}
        <p className="mt-1 text-ui-2xs text-slate-400">
          Enter 发送 · Shift+Enter 换行 · 写入当前终端
        </p>
      </div>
    </div>
  );
}

function EmptyState({
  loading,
  live,
  error,
  onSwitchToTerminal,
}: {
  loading: boolean;
  live: boolean;
  error: string | null;
  onSwitchToTerminal: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-ui-caption text-slate-400">
        <Loader2 size={14} className="animate-spin" />
        正在读取会话…
      </div>
    );
  }
  return (
    <div className="grid min-h-[180px] place-items-center px-4 text-center">
      <div className="max-w-sm">
        <div className="mx-auto grid h-10 w-10 place-items-center rounded-2xl bg-slate-100 text-slate-400">
          {error ? <AlertCircle size={18} /> : <Bot size={18} />}
        </div>
        <p className="mt-2 text-ui-caption text-slate-600">
          {error ?? (live ? "等待 Agent 输出…" : "没有可展示的会话记录")}
        </p>
        {error ? (
          <p className="mt-1 text-ui-2xs text-slate-400">
            终端仍然可用，可以在终端里继续查看和操作。
          </p>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          className="mt-3"
          onClick={onSwitchToTerminal}
          icon={<Terminal size={11} />}
        >
          切换到终端
        </Button>
      </div>
    </div>
  );
}

function ChatMessageCard({
  message,
  runtimeId,
  runtimeName,
}: {
  message: AgentChatMessage;
  runtimeId?: string;
  runtimeName?: string;
}) {
  if (message.kind === "tool" && message.tool) {
    return <ToolCard tool={message.tool} />;
  }
  if (message.kind === "thinking") {
    return <ThinkingCard text={message.text ?? ""} />;
  }
  if (message.kind === "system") {
    return (
      <div className="py-0.5 text-center text-ui-xs text-slate-400">
        {oneLine(message.text, 200)}
      </div>
    );
  }
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-h-48 max-w-[80%] overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-sky-100 bg-sky-50 px-3 py-2 text-ui-caption leading-5 text-slate-700">
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-surface px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-ui-2xs text-slate-400">
        <AgentIcon runtimeId={runtimeId} name={runtimeName} size={13} />
        <span className="truncate">{runtimeName ?? "Agent"}</span>
        {message.at ? <span className="ml-auto shrink-0">{relativeTime(message.at)}</span> : null}
      </div>
      {message.text ? (
        <Markdown text={message.text} />
      ) : null}
    </div>
  );
}

/** 只读 Markdown；远程图片会被置空，避免聊天记录触发外部请求。 */
function Markdown({ text }: { text: string }) {
  return (
    <div className="agent-chat-markdown text-ui-caption leading-5 text-slate-700">
      <MDEditor.Markdown
        source={text}
        wrapperElement={{ "data-color-mode": "light" }}
        urlTransform={(url) =>
          url.startsWith("http://") || url.startsWith("https://") ? "" : url
        }
      />
    </div>
  );
}

function ThinkingCard({ text }: { text: string }) {
  return (
    <details className="group rounded-lg border border-slate-200 bg-slate-50/70 px-2.5 py-1.5">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-ui-xs text-slate-500 [&::-webkit-details-marker]:hidden">
        <ChevronDown
          size={11}
          className="shrink-0 transition-transform group-open:rotate-180"
        />
        <span>思考</span>
        <span className="truncate text-slate-400">{oneLine(text, 60)}</span>
      </summary>
      <div className="mt-1.5 whitespace-pre-wrap break-words border-t border-slate-200 pt-1.5 text-ui-xs leading-5 text-slate-500">
        {text}
      </div>
    </details>
  );
}

function ToolCard({ tool }: { tool: AgentChatTool }) {
  const meta = describeTool(tool.name);
  const target = toolTarget(tool);
  const Glyph = toolGlyph(meta.category);
  const hasDetail = Boolean(tool.input || tool.output);
  return (
    <details className="group rounded-xl border border-border bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 [&::-webkit-details-marker]:hidden">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-slate-100 text-slate-500">
          <Glyph size={12} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="shrink-0 text-ui-xs text-slate-700">{meta.label}</span>
            <span className="truncate font-mono text-ui-2xs text-slate-400">
              {tool.name}
            </span>
            <ToolStatus status={tool.status} />
            {typeof tool.durationMs === "number" ? (
              <span className="ml-auto shrink-0 text-ui-2xs text-slate-400">
                {formatDuration(tool.durationMs)}
              </span>
            ) : null}
          </div>
          {target ? (
            <div className="mt-0.5 truncate font-mono text-ui-xs text-slate-500" title={target}>
              {target}
            </div>
          ) : null}
        </div>
        {hasDetail ? (
          <ChevronDown
            size={12}
            className="shrink-0 text-slate-300 transition-transform group-open:rotate-180"
          />
        ) : null}
      </summary>
      {hasDetail ? (
        <div className="space-y-2 border-t border-slate-100 px-2.5 py-2">
          {tool.input ? (
            <div>
              <div className="mb-0.5 text-ui-2xs text-slate-400">参数</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-slate-50 px-2 py-1.5 font-mono text-ui-2xs leading-4 text-slate-600">
                {tool.input}
              </pre>
            </div>
          ) : null}
          {tool.output ? (
            <div>
              <div className="mb-0.5 text-ui-2xs text-slate-400">输出</div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-950 px-2 py-1.5 font-mono text-ui-2xs leading-4 text-zinc-300">
                {tool.output}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

function ToolStatus({ status }: { status: string }) {
  if (status === "running") {
    return <Loader2 size={10} className="shrink-0 animate-spin text-sky-500" />;
  }
  if (status === "failed") {
    return <X size={10} className="shrink-0 text-rose-500" />;
  }
  return <Check size={10} className="shrink-0 text-emerald-500" />;
}

function toolGlyph(category: ReturnType<typeof describeTool>["category"]) {
  switch (category) {
    case "read":
      return FileText;
    case "write":
    case "edit":
      return FilePenLine;
    case "exec":
      return Terminal;
    case "search":
      return Search;
    case "web":
      return Globe;
    case "agent":
      return Bot;
    default:
      return Wrench;
  }
}

function PendingBubble({
  item,
  onRetry,
}: {
  item: PendingMessage;
  onRetry: () => void;
}) {
  // 每秒 ticker 只放在气泡内部，避免整条消息流跟着重渲染。
  const now = useTicker(!item.failed);
  const unconfirmed = !item.failed && now - item.at > 60_000;
  return (
    <div className="mt-2 flex justify-end">
      <div className="max-w-[80%]">
        <div className="whitespace-pre-wrap break-words rounded-xl border border-sky-100 bg-sky-50 px-3 py-2 text-ui-caption leading-5 text-slate-700 opacity-80">
          {item.text}
        </div>
        <div className="mt-0.5 flex items-center justify-end gap-1.5 text-ui-2xs">
          {item.failed ? (
            <>
              <span className="text-rose-600">未发送</span>
              <button
                type="button"
                className="text-sky-600 hover:underline"
                onClick={onRetry}
              >
                重试
              </button>
            </>
          ) : (
            <span className={unconfirmed ? "text-amber-600" : "text-slate-400"}>
              {unconfirmed ? "未确认送达" : "发送中…"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkingBar({
  status,
  model,
}: {
  status: AgentRuntimeStatus;
  model?: string;
}) {
  // 已用时长只在 Working 条内部刷新，不驱动整个 Chat 重绘。
  const now = useTicker(true);
  const waiting =
    status.phase === "waiting_permission" || status.phase === "waiting_question";
  const detail = oneLine(status.detail ?? status.tool ?? status.message, 120);
  const elapsed = formatElapsed(status.startedAt, now);
  const shownModel = status.model || model;
  return (
    <div
      className={clsx(
        "mt-2 flex items-center gap-2 rounded-xl border px-2.5 py-2",
        waiting
          ? "border-amber-200 bg-amber-50/70"
          : "border-sky-100 bg-sky-50/60",
      )}
    >
      {waiting ? (
        <ShieldQuestion size={13} className="shrink-0 text-amber-600" />
      ) : (
        <Loader2 size={13} className="shrink-0 animate-spin text-sky-500" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-ui-xs text-slate-700">
          <span className="truncate">{status.label}</span>
          {status.tool ? (
            <span className="truncate font-mono text-ui-2xs text-slate-400">
              {status.tool}
            </span>
          ) : null}
          {shownModel ? (
            <span className="truncate font-mono text-ui-2xs text-slate-400" title="当前模型">
              {shownModel}
            </span>
          ) : null}
        </div>
        {detail ? (
          <div className="truncate font-mono text-ui-2xs text-slate-400" title={detail}>
            {detail}
          </div>
        ) : null}
      </div>
      {elapsed ? (
        <span className="shrink-0 text-ui-2xs tabular-nums text-slate-400">{elapsed}</span>
      ) : null}
    </div>
  );
}

function PromptCard({
  taskId,
  prompt,
  toast,
  onSwitchToTerminal,
}: {
  taskId: string;
  prompt: AgentPendingPrompt;
  toast: (kind: "ok" | "error", text: string) => void;
  onSwitchToTerminal: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const answer = async (optionId: string) => {
    if (busy) return;
    setBusy(optionId);
    try {
      const result = await agentApi.promptAnswer(taskId, prompt.promptId, optionId);
      toast("ok", result.message);
    } catch (cause) {
      toast("error", String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2">
      <div className="flex items-center gap-1.5 text-ui-xs text-amber-800">
        <ShieldQuestion size={13} className="shrink-0" />
        <span className="font-normal">
          {prompt.kind === "approval" ? "等待权限确认" : "等待回答"}
        </span>
        {prompt.tool ? (
          <span className="truncate font-mono text-ui-2xs text-amber-700/70">
            {prompt.tool}
          </span>
        ) : null}
        {prompt.header ? (
          <span className="ml-auto truncate text-ui-2xs text-amber-700/70">
            {prompt.header}
          </span>
        ) : null}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-ui-caption leading-5 text-slate-700">
        {prompt.question ?? prompt.summary ?? "Agent 正在等待你的确认。"}
      </p>
      {prompt.canAnswer ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {prompt.options.map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant={option.id === "reject" ? "danger" : "secondary"}
              disabled={busy !== null}
              onClick={() => void answer(option.id)}
              icon={
                busy === option.id ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : undefined
              }
              title={option.description}
            >
              {option.label}
            </Button>
          ))}
          {prompt.answerHint ? (
            <span className="text-ui-2xs text-slate-400">{prompt.answerHint}</span>
          ) : null}
        </div>
      ) : (
        <div className="mt-1.5 flex items-center gap-2">
          <p className="min-w-0 flex-1 text-ui-2xs text-amber-700">
            {prompt.answerHint ?? "该问题需要在 Agent 终端中回答。"}
          </p>
          <Button
            size="sm"
            variant="secondary"
            onClick={onSwitchToTerminal}
            icon={<Terminal size={11} />}
          >
            切换到终端
          </Button>
        </div>
      )}
    </div>
  );
}
