import { Profiler, useMemo } from "react";

import { Segmented } from "../components/Segmented";
import { Markdown } from "../components/Markdown";
import { t, useLocale } from "../lib/i18n";
import { api } from "../lib/api";
import type { FileTabTarget } from "../lib/fs";
import { AgentHostProvider, type AgentHost } from "../../../shared/agent/host";
import { StreamHud, type StreamHudItem } from "../../../shared/agent/StreamHud";
import { TodoHud } from "../../../shared/agent/TodoHud";
import type { AgentTodo } from "../../../shared/agent/types";
import { AgentConfigTab } from "./AgentConfigTab";
import { Composer } from "./Composer";
import { MessageStream } from "./MessageStream";
import { ReviewView } from "./ReviewView";
import { RuntimeNotice } from "./RuntimeNotice";
import { TaskActions } from "./TaskActions";
import { TaskList } from "./TaskList";
import { TeamBoard } from "./TeamBoard";
import { openAgentPath, resolveAgentImage } from "./localOpen";
import { installAgentPerf, recordAgentCommit } from "./perf";
import { MessageUsageChip } from "./usage/MessageUsageChip";
import { TrajectoryView } from "./trajectory/TrajectoryView";
import {
  agentActions,
  agentReviewView,
  agentStore,
  agentTaskView,
  agentTeamView,
  isSessionRunning,
  taskReviewable,
} from "./store";

type Props = {
  toast: (kind: "ok" | "error", text: string) => void;
  /** Opens a local path from the transcript in a workbench file tab. */
  onOpenFile: (target: FileTabTarget) => void;
};

if (import.meta.env.DEV) installAgentPerf();

/** Dev-only: commit timing for the transcript subtree (see `perf.ts`). */
function onStreamRender(
  id: string,
  phase: "mount" | "update" | "nested-update",
  actualDuration: number,
  baseDuration: number,
  _startTime: number,
  commitTime: number,
) {
  recordAgentCommit({
    id,
    phase,
    actualMs: actualDuration,
    baseMs: baseDuration,
    commitTime,
  });
}

/** Usage chip under one answer; the shared view hides it without a host. */
function renderUsage(
  usage: Parameters<typeof MessageUsageChip>[0]["usage"],
  provider?: string,
  model?: string,
) {
  return <MessageUsageChip usage={usage} provider={provider} model={model} />;
}

/**
 * The host capabilities the shared agent view may use: rich Markdown for
 * answers, the usage chip under messages, image bytes for `read_image`
 * results. Rebuilt when the session changes because Markdown links resolve
 * relative paths against that session's working directory.
 */
function useAgentHost(
  sessionId: string | null,
  io: {
    toast: (kind: "ok" | "error", text: string) => void;
    onOpenFile: (target: FileTabTarget) => void;
  },
): AgentHost {
  const { toast, onOpenFile } = io;
  return useMemo(() => {
    const links = sessionId
      ? {
          open: (path: string) => {
            void openAgentPath(sessionId, path, { toast, openFile: onOpenFile });
          },
          image: (path: string) => resolveAgentImage(sessionId, path),
        }
      : undefined;
    return {
      renderMarkdown: (source: string) => <Markdown source={source} links={links} />,
      renderUsage,
      loadImage: (path: string) => api.imageDataUrl(path),
    };
  }, [sessionId, toast, onOpenFile]);
}

/** Stable empties: the workspace re-renders per streaming token. */
const NO_TODOS: AgentTodo[] = [];
const NO_HUD: StreamHudItem[] = [];

/**
 * Task list + stream. The page has no header of its own: the window tab already
 * names it, so the conversation starts at the top. Settings live in a dialog
 * opened from the task column's footer (and from the runtime notice / model
 * picker); the pane explains why it cannot send right now plus the workflow
 * actions of the selected task.
 *
 * The pane bar switches between the conversation and the trajectory ledger;
 * a task waiting for review swaps both for the review surface（审核 / 对话).
 * The transcript stays mounted (hidden) so a round trip keeps its scroll
 * position; the ledger keeps its own folds, selection and search.
 */
export function AgentWorkspace({ toast, onOpenFile }: Props) {
  const state = agentStore.use();
  const locale = useLocale();
  const host = useAgentHost(state.selectedId, { toast, onOpenFile });
  const selected = state.tasks?.find((task) => task.id === state.selectedId) ?? null;
  const view = agentTaskView(state, state.selectedId);
  // The attention corner lives in the view-tab row: a folded capsule sits on
  // that row instead of covering the transcript. TODO is the first tenant;
  // terminals and sub-agents push their own items here.
  const todos = (state.selectedId ? state.sessions[state.selectedId]?.todos : undefined) ?? NO_TODOS;
  const hudItems = useMemo<StreamHudItem[]>(
    () =>
      todos.length > 0
        ? [{ id: "todo", content: <TodoHud todos={todos} locale={locale} /> }]
        : NO_HUD,
    [todos, locale],
  );
  // The board replaces the transcript for any session that chose it; a chat
  // keeps its transcript unless the reader explicitly opens the board. The
  // team/worktree choices themselves live in the composer's work bar.
  // A reviewable task swaps the main pane for the review surface; the
  // transcript stays mounted (hidden) so「对话」returns to the same scroll.
  const reviewable = taskReviewable(selected);
  const reviewView = agentReviewView(state, state.selectedId);
  const showReview = reviewable && reviewView === "review";
  // A reviewable task's「对话」tab always means the transcript, even if the
  // session was left on the trajectory ledger before the review began.
  const paneView = reviewable ? "chat" : view;
  const board =
    !showReview && paneView === "chat" && agentTeamView(state, state.selectedId) === "board";
  const stream = (
    <MessageStream
      key={`chat:${state.selectedId ?? "draft"}`}
      visible={paneView === "chat" && !board && !showReview}
    />
  );

  return (
    <AgentHostProvider value={host}>
      <div className="flex h-full min-h-0 flex-col">
        {/* One step up from the app scale (styles.css `.agent-type`): the session
            is read as prose, and the config dialog stays outside it. */}
        <div className="agent-type flex min-h-0 flex-1">
          <TaskList />
          <div className="flex min-w-0 flex-1 flex-col">
            {state.selectedId ? (
              <div className="relative shrink-0 px-6 py-2">
                <div className="mx-auto flex max-w-[46rem] items-center justify-center">
                  {reviewable ? (
                    <Segmented
                      value={reviewView}
                      onChange={(next) =>
                        agentActions.setReviewView(state.selectedId!, next)
                      }
                      options={[
                        { value: "review", label: t("agent.review.tabReview") },
                        { value: "chat", label: t("agent.review.tabChat") },
                      ]}
                    />
                  ) : (
                    <Segmented
                      value={view}
                      onChange={(next) => agentActions.setTaskView(state.selectedId!, next)}
                      options={[
                        { value: "chat", label: t("agent.traj.viewChat") },
                        { value: "trajectory", label: t("agent.traj.viewTrajectory") },
                      ]}
                    />
                  )}
                </div>
                <StreamHud items={hudItems} locale={locale} />
              </div>
            ) : null}
            {selected && selected.kind !== "chat" ? (
              <TaskActions key={selected.id} task={selected} />
            ) : null}
            {showReview && selected ? <ReviewView key={`review:${selected.id}`} task={selected} /> : null}
            {import.meta.env.DEV ? (
              <Profiler id="agent-stream" onRender={onStreamRender}>
                {stream}
              </Profiler>
            ) : (
              stream
            )}
            {state.selectedId && paneView === "trajectory" && !showReview ? (
              <TrajectoryPane key={`traj:${state.selectedId}`} sessionId={state.selectedId} />
            ) : null}
            {board ? <TeamBoard key={`board:${state.selectedId}`} /> : null}
            <div className="shrink-0">
              <RuntimeNotice />
              {/* While the host commits and merges, input is closed: the
                  review pane owns the retry decision. */}
              {selected?.workflow === "finalizing" ? null : <Composer />}
            </div>
          </div>
        </div>
        {state.configOpen ? (
          <AgentConfigTab toast={toast} onClose={agentActions.closeConfig} />
        ) : null}
      </div>
    </AgentHostProvider>
  );
}

/** The ledger pane reads the same committed history the transcript does. */
function TrajectoryPane({ sessionId }: { sessionId: string }) {
  const state = agentStore.use();
  const history = state.entries[sessionId];
  const live = state.live[sessionId];
  const items = history?.items ?? [];

  // Calls that already committed must not appear twice: the live overlay is
  // filtered down to what the log does not have yet. A delta without a call id
  // can only be matched by name + arguments.
  const committedIds = new Set<string>();
  const committedCalls = new Set<string>();
  for (const entry of items) {
    if (entry.kind !== "tool") continue;
    if (entry.callId) committedIds.add(entry.callId);
    else committedCalls.add(`${entry.name}\u0000${entry.args}`);
  }
  const tools = (live?.tools ?? []).filter((tool) =>
    tool.callId
      ? !committedIds.has(tool.callId)
      : !committedCalls.has(`${tool.name}\u0000${tool.args}`),
  );
  // A cancelled or failed attempt can leave its buffer behind; only a running
  // session may draw the live tail.
  const running = isSessionRunning(state, sessionId);
  const liveTrace =
    running && live && (live.text || live.reasoning || tools.length > 0)
      ? { text: live.text, reasoning: live.reasoning, tools }
      : undefined;

  return (
    <TrajectoryView
      entries={items}
      live={liveTrace}
      loading={history ? !history.loaded && items.length === 0 : true}
      failed={Boolean(history?.error) && items.length === 0}
      onRetry={() => agentActions.refreshEntries(sessionId)}
    />
  );
}
