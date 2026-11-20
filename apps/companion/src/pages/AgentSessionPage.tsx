import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ArrowUp,
  CheckCircle2,
  ChevronLeft,
  ExternalLink,
  FileText,
  FolderGit2,
  GitBranch,
  LayoutGrid,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  Square,
  Users,
  type LucideIcon,
} from "lucide-react";

import { asApiError } from "../lib/api";
import {
  compactTokens,
  effortStops,
  rememberedEffort,
  resolveActive,
  type ActiveRoute,
  type CatalogModel,
  type CatalogProvider,
  type DshModelsCatalog,
} from "../lib/agentModels";
import { BottomSheet } from "../components/BottomSheet";
import { TodoCard } from "../../../shared/agent/TodoCard";
import { AgentHostProvider } from "../../../shared/agent/host";
import type { AgentLocale } from "../../../shared/agent/types";
import {
  applyAgentTask,
  applyAgentTeam,
  dshApi,
  isAgentSessionCreated,
  refreshAgentFeed,
  useAgentFeed,
  watchAgentTeam,
  type DshAnswer,
  type DshApprovalOutcome,
  type DshEntry,
  type DshFinalizeStep,
  type DshPendingRequest,
  type DshPermissionMode,
  type DshSession,
  type DshStatus,
  type DshTask,
  type DshTaskFile,
  type DshTaskFileStatus,
  type DshTeam,
  type DshTeamTask,
  type DshTeamTaskStatus,
  type ModelSelection,
} from "../lib/dsh";
import { fileHash } from "../lib/files";
import { plainTitle } from "../lib/format";
import { resolveLocaleMode, t, type MessageKey } from "../lib/i18n";
import { navigate } from "../lib/router";
import { usePrefs } from "../lib/prefs";
import { isPageHidden, onPageVisibilityChange } from "../lib/visibility";
import { isInterrupted, PHASE_LABELS, WorkflowChip } from "./AgentPage";
import { ModeChip, ModeSheet, ModelChip, ModelSheet, type ModeValue } from "./agent/pickers";
import { TurnStack } from "./agent/TurnStack";
import { TrajectoryView } from "./agent/trajectory";
import { agentHostCapabilities } from "./agent/markdown";
import { isPendingChild } from "../../../shared/agent/subagents";

/** Runtime status cadence; the task/approval feed is polled once by `App`. */
const SESSION_POLL_MS = 3_000;
/**
 * Session rows (todos/usage/selection/status) tolerate a slower cadence than
 * the transcript: the desktop's feature proxy allows a fixed budget per
 * minute, and entries + feed + an open child fold already sit close to it.
 */
const SESSIONS_POLL_MS = 6_000;
/** Soft cap on the composer's growth before it scrolls internally. */
const COMPOSER_MAX_HEIGHT = 120;

const TEAM_COLUMNS: ReadonlyArray<{ status: DshTeamTaskStatus; label: MessageKey }> = [
  { status: "pending", label: "mobile.agent.colPending" },
  { status: "in_progress", label: "mobile.agent.colInProgress" },
  { status: "completed", label: "mobile.agent.colCompleted" },
];

/** Scope chips per card; the rest collapse into a `+n` chip. */
const MAX_SCOPES = 3;

type ApprovalPending = Extract<DshPendingRequest, { kind: "approval" }>;
type QuestionPending = Extract<DshPendingRequest, { kind: "question" }>;
type TaskAction = "approve" | "retry" | "cancel";

/** The host's finishing pipeline, in the order the steps run. */
const FINALIZE_STEPS: ReadonlyArray<{ step: DshFinalizeStep; label: MessageKey }> = [
  { step: "commit", label: "mobile.agent.finalizeStepCommit" },
  { step: "merge", label: "mobile.agent.finalizeStepMerge" },
  { step: "cleanup", label: "mobile.agent.finalizeStepCleanup" },
  { step: "writeback", label: "mobile.agent.finalizeStepWriteback" },
];

const FILE_STATUS_LABELS: Record<DshTaskFileStatus, MessageKey> = {
  added: "mobile.agent.fileAdded",
  modified: "mobile.agent.fileModified",
  deleted: "mobile.agent.fileDeleted",
  renamed: "mobile.agent.fileRenamed",
  untracked: "mobile.agent.fileUntracked",
};

function TranscriptSkeleton() {
  return (
    <div data-component="TranscriptSkeleton" className="space-y-3 px-4 py-3" aria-hidden="true">
      {[0, 1, 2].map((row) => (
        <div key={row} className="rounded-lg border border-border px-3 py-2">
          <div className="h-3 w-2/3 animate-pulse rounded bg-overlay-soft" />
          <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-overlay-soft" />
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------
   Task page building blocks
   ------------------------------------------------------------------------- */

function TaskButton(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: "primary" | "neutral" | "danger";
}) {
  const tone = props.tone ?? "neutral";
  const palette =
    tone === "primary"
      ? "bg-primary text-primary-foreground active:bg-primary-hover"
      : tone === "danger"
        ? "border border-rose-200 bg-rose-50 text-rose-700 active:bg-overlay-soft"
        : "border border-border bg-surface text-slate-700 active:bg-overlay-soft";
  return (
    <button
      data-component="TaskButton"
      type="button"
      disabled={props.disabled || props.busy}
      onClick={props.onClick}
      className={`inline-flex min-h-11 flex-1 basis-24 items-center justify-center gap-1.5 rounded-lg px-3 text-ui-sm transition disabled:opacity-40 ${palette}`}
    >
      {props.busy ? <LoaderCircle size={13} className="animate-spin" /> : null}
      {props.label}
    </button>
  );
}

/** One labelled paragraph of the model's review note. */
function ReviewField(props: { label: string; text: string }) {
  return (
    <div data-component="ReviewField" className="flex items-baseline gap-2">
      <span className="shrink-0 text-ui-2xs text-slate-400">{props.label}</span>
      <span className="min-w-0 flex-1 select-text whitespace-pre-wrap text-ui-xs leading-5 text-slate-700">
        {props.text}
      </span>
    </div>
  );
}

/**
 * Review / finishing screen for a workflow task (docs/AGENT_TASK_FLOW.md §7).
 * The model's own summary and the changed files: tapping a file expands its
 * diff in place (the desktop review parity), the trailing button opens the
 * file itself in the built-in viewer scoped to the session's worktree.
 * Finishing shows the commit → merge → cleanup → writeback pipeline and the
 * failure detail; the approve/discard/retry gate itself sits in the sticky
 * composer area so it never scrolls away.
 */
function ReviewPanel(props: {
  task: DshTask;
  sessionId: string;
  files: DshTaskFile[] | null;
  filesTruncated: boolean;
  filesLoading: boolean;
  filesError: string | null;
  onRefresh: () => void;
}) {
  const review = props.task.review;
  const finalize = props.task.finalize;
  const finalizing = props.task.workflow === "finalizing";
  const currentStep = finalize?.step
    ? FINALIZE_STEPS.findIndex((item) => item.step === finalize.step)
    : -1;
  const changes = props.task.changes;

  /** The one expanded diff; content is fetched once per path. */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<
    Record<string, { loading?: boolean; text?: string; truncated?: boolean; error?: string }>
  >({});

  // Approve moves the diff target (worktree → branch / cleaned repo), so a
  // workflow change invalidates the expanded state and the cached bodies —
  // otherwise the panel keeps serving the pre-approval diff.
  useEffect(() => {
    setExpanded(null);
    setDiffs({});
  }, [props.task.workflow]);

  const toggleDiff = (file: DshTaskFile) => {
    if (expanded === file.path) {
      setExpanded(null);
      return;
    }
    setExpanded(file.path);
    if (diffs[file.path]) return;
    setDiffs((current) => ({ ...current, [file.path]: { loading: true } }));
    void dshApi
      .taskDiff(props.sessionId, file.path)
      .then((result) => {
        setDiffs((current) => ({
          ...current,
          [file.path]: { text: result.diff, truncated: result.truncated },
        }));
      })
      .catch((err) => {
        setDiffs((current) => ({
          ...current,
          [file.path]: { error: asApiError(err).message },
        }));
      });
  };

  return (
    <section data-component="ReviewPanel" className="border-b border-border bg-canvas">
      <div className="flex items-center gap-2 px-4 pt-2.5 pb-1">
        <h2 className="min-w-0 flex-1 text-ui-caption text-slate-900">
          {finalizing ? t("mobile.agent.finalizeTitle") : t("mobile.agent.reviewTitle")}
        </h2>
        {changes ? (
          <span className="shrink-0 font-mono text-ui-2xs">
            <span className="text-emerald-600">+{changes.additions}</span>
            <span className="ml-1 text-rose-600">−{changes.deletions}</span>
          </span>
        ) : null}
        <button
          type="button"
          aria-label={t("common.refresh")}
          title={t("common.refresh")}
          onClick={() => {
            setExpanded(null);
            setDiffs({});
            props.onRefresh();
          }}
          className="inline-flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-md text-slate-500 transition active:bg-overlay-soft"
        >
          <RefreshCw size={13} className={props.filesLoading ? "animate-spin" : undefined} />
        </button>
      </div>

      {review && (review.summary || review.verification || review.risks) ? (
        <div className="space-y-1 px-4 pb-2">
          {review.summary ? (
            <ReviewField label={t("mobile.agent.reviewSummary")} text={review.summary} />
          ) : null}
          {review.verification ? (
            <ReviewField
              label={t("mobile.agent.reviewVerification")}
              text={review.verification}
            />
          ) : null}
          {review.risks ? (
            <ReviewField label={t("mobile.agent.reviewRisks")} text={review.risks} />
          ) : null}
        </div>
      ) : null}

      {finalizing ? (
        <div className="flex flex-wrap items-center gap-1 px-4 pb-2">
          {FINALIZE_STEPS.map((item, index) => {
            const done = currentStep >= 0 && index < currentStep;
            const active = index === currentStep;
            return (
              <span key={item.step} className="flex items-center gap-1">
                {index > 0 ? <span className="text-ui-2xs text-slate-300">→</span> : null}
                <span
                  className={`rounded-md px-1.5 py-0.5 text-ui-2xs ${
                    active
                      ? "bg-sky-50 text-sky-700"
                      : done
                        ? "bg-emerald-50 text-emerald-700"
                        : "text-slate-400"
                  }`}
                >
                  {t(item.label)}
                </span>
              </span>
            );
          })}
        </div>
      ) : null}

      <div className="flex items-center gap-2 px-4 pb-1 text-ui-2xs text-slate-500">
        <span className="shrink-0">{t("mobile.agent.reviewFiles")}</span>
        {props.files ? <span className="text-slate-400">{props.files.length}</span> : null}
        {props.filesTruncated ? (
          <span className="shrink-0 rounded-md bg-amber-50 px-1.5 py-0.5 text-amber-700">
            {t("mobile.agent.reviewTruncated")}
          </span>
        ) : null}
      </div>

      {props.filesLoading && props.files === null ? (
        <p className="px-4 py-2 text-ui-xs text-slate-400">{t("mobile.agent.reviewLoading")}</p>
      ) : null}

      {props.filesError ? (
        <p
          className="px-4 py-2 text-ui-xs leading-5 text-rose-600"
          title={t("mobile.agent.reviewLoadFailed")}
        >
          {props.filesError}
        </p>
      ) : null}

      {props.files?.map((file) => {
        const open = expanded === file.path;
        const diff = diffs[file.path];
        return (
          <div key={file.path} className="border-t border-border">
            <div className="flex min-h-11 items-center gap-2 px-4 py-2">
              <button
                type="button"
                onClick={() => toggleDiff(file)}
                title={file.path}
                className="min-w-0 flex-1 text-left"
              >
                <span className="block truncate font-mono text-ui-xs text-slate-700">
                  {file.path}
                </span>
              </button>
              <span className="shrink-0 rounded-md border border-border px-1 text-ui-2xs text-slate-500">
                {t(FILE_STATUS_LABELS[file.status])}
              </span>
              {file.binary ? null : (
                <span className="shrink-0 font-mono text-ui-2xs">
                  <span className="text-emerald-600">+{file.additions}</span>
                  <span className="ml-1 text-rose-600">−{file.deletions}</span>
                </span>
              )}
              <button
                type="button"
                aria-label={t("mobile.agent.viewFile")}
                title={t("mobile.agent.viewFile")}
                onClick={() =>
                  navigate(fileHash(`__session__:${props.sessionId}`, file.path))
                }
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-slate-400 transition active:bg-overlay-soft"
              >
                <FileText size={13} />
              </button>
            </div>
            {open ? (
              <div className="px-4 pb-2">
                {diff?.loading ? (
                  <p className="py-1 text-ui-xs text-slate-400">{t("common.reading")}</p>
                ) : diff?.error ? (
                  <p
                    className="py-1 text-ui-xs leading-5 text-rose-600"
                    title={t("mobile.agent.diffFailed")}
                  >
                    {diff.error}
                  </p>
                ) : diff ? (
                  <>
                    <pre className="max-h-72 select-text overflow-auto overscroll-contain whitespace-pre rounded-lg border border-border bg-slate-50 px-3 py-2 font-mono text-ui-2xs leading-5 text-slate-700">
                      {diff.text || t("mobile.agent.diffEmpty")}
                    </pre>
                    {diff.truncated ? (
                      <p className="mt-1 text-ui-2xs text-amber-700">
                        {t("mobile.agent.reviewTruncated")}
                      </p>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}

      {props.files && props.files.length === 0 && !props.filesError ? (
        <p className="px-4 py-2 text-ui-xs text-slate-400">
          {t("mobile.agent.reviewNoFiles")}
        </p>
      ) : null}

      {finalizing && finalize?.error ? (
        <p className="select-text px-4 py-1.5 text-ui-xs leading-5 text-rose-600">
          {finalize.error}
        </p>
      ) : null}
      {finalizing && finalize?.instructions ? (
        <pre className="mx-4 mt-1 overflow-x-auto rounded-lg border border-border bg-surface px-2.5 py-2 font-mono text-ui-2xs leading-5 whitespace-pre-wrap text-slate-600 select-text">
          {finalize.instructions}
        </pre>
      ) : null}
      {finalizing && finalize?.notice ? (
        <p className="px-4 py-1.5 text-ui-2xs leading-5 text-amber-700">{finalize.notice}</p>
      ) : null}

    </section>
  );
}

function ApprovalCard(props: { request: ApprovalPending }) {
  const [busy, setBusy] = useState<DshApprovalOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const approval = props.request.request;

  const answer = async (outcome: DshApprovalOutcome) => {
    if (busy) return;
    setBusy(outcome);
    setError(null);
    try {
      await dshApi.approvalAnswer(props.request.rpcId, outcome);
      await refreshAgentFeed();
    } catch (err) {
      setError(asApiError(err).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-component="ApprovalCard" className="mx-4 mt-3 rounded-xl border border-border bg-surface px-3 py-3">
      <p className="text-ui-xs text-slate-500">{t("mobile.agent.approvalRequest")}</p>
      <p className="mt-1.5 flex items-baseline gap-2">
        <span className="shrink-0 text-ui-2xs text-slate-400">
          {t("mobile.agent.approvalTool")}
        </span>
        <span className="min-w-0 flex-1 break-all font-mono text-ui-xs text-slate-900">
          {approval.toolName}
        </span>
      </p>
      {approval.reason ? (
        <p className="mt-1 flex items-baseline gap-2">
          <span className="shrink-0 text-ui-2xs text-slate-400">
            {t("mobile.agent.approvalTarget")}
          </span>
          <span className="min-w-0 flex-1 select-text wrap-break-word whitespace-pre-wrap text-ui-xs leading-5 text-slate-600">
            {approval.reason}
          </span>
        </p>
      ) : null}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void answer("allowed-once")}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-ui-sm text-primary-foreground transition active:bg-primary-hover disabled:opacity-40"
        >
          {busy === "allowed-once" ? <LoaderCircle size={13} className="animate-spin" /> : null}
          {t("mobile.agent.allowOnce")}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void answer("rejected")}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 text-ui-sm text-rose-700 transition active:bg-overlay-soft disabled:opacity-40"
        >
          {busy === "rejected" ? <LoaderCircle size={13} className="animate-spin" /> : null}
          {t("mobile.agent.reject")}
        </button>
      </div>
      {error ? (
        <p
          className="mt-2 text-ui-xs leading-5 text-rose-600"
          title={t("mobile.agent.approvalFailed")}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function QuestionCard(props: { request: QuestionPending; onAnswer: () => void }) {
  const first = props.request.request.questions[0];
  return (
    <div data-component="QuestionCard" className="mx-4 mt-3 rounded-xl border border-border bg-surface px-3 py-3">
      <p className="text-ui-xs text-slate-500">{t("mobile.agent.questionRequest")}</p>
      <p className="mt-1 line-clamp-3 select-text text-ui-caption leading-5 text-slate-900">
        {first?.question ?? t("common.empty")}
      </p>
      <button
        type="button"
        onClick={props.onAnswer}
        className="mt-2 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-primary px-3 text-ui-sm text-primary-foreground transition active:bg-primary-hover"
      >
        {t("mobile.agent.answerQuestion")}
      </button>
    </div>
  );
}

/**
 * One runtime question set. A single single-select question answers with one
 * tap; everything else walks question i/N with optional custom text. Closing
 * the sheet dismisses the request (`answers: null`), it never approves it.
 */
function QuestionSheet(props: { pending: QuestionPending; onClose: () => void }) {
  const request = props.pending.request;
  const questions = request.questions;
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = questions[index];
  const singleSelect = questions.length === 1 && !current?.multiSelect;
  const hasOptions = (current?.options?.length ?? 0) > 0;

  const answer = async (answers: DshAnswer[] | null) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await dshApi.questionAnswer(props.pending.rpcId, answers);
      await refreshAgentFeed();
      props.onClose();
    } catch (err) {
      setError(asApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  const answersFor = (
    picked: Record<string, string[]>,
    texts: Record<string, string>,
    override?: { id: string; selected: string[] },
  ): DshAnswer[] =>
    questions.map((question) => {
      if (override && question.id === override.id) {
        return { id: question.id, selected: override.selected };
      }
      const value = picked[question.id] ?? [];
      const text = (texts[question.id] ?? "").trim();
      return text
        ? { id: question.id, selected: value, custom: text }
        : { id: question.id, selected: value };
    });

  const toggle = (label: string) => {
    if (!current) return;
    setSelected((prev) => {
      const value = prev[current.id] ?? [];
      if (!current.multiSelect) return { ...prev, [current.id]: [label] };
      return {
        ...prev,
        [current.id]: value.includes(label)
          ? value.filter((item) => item !== label)
          : [...value, label],
      };
    });
  };

  /** Skip clears the current question; on the last one it submits the set. */
  const skip = () => {
    if (!current || busy) return;
    const clearedSelected = { ...selected, [current.id]: [] };
    const clearedCustom = { ...custom, [current.id]: "" };
    setSelected(clearedSelected);
    setCustom(clearedCustom);
    if (index < questions.length - 1) {
      setIndex(index + 1);
      return;
    }
    void answer(answersFor(clearedSelected, clearedCustom));
  };

  const next = () => {
    if (busy) return;
    if (index < questions.length - 1) setIndex(index + 1);
    else void answer(answersFor(selected, custom));
  };

  const footer =
    questions.length === 0 ? (
      <button
        type="button"
        disabled={busy}
        onClick={() => void answer(null)}
        className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-40"
      >
        {t("common.close")}
      </button>
    ) : singleSelect && hasOptions ? undefined : (
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || index === 0}
          onClick={() => setIndex(index - 1)}
          className="min-h-11 shrink-0 rounded-lg border border-border bg-surface px-3 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-40"
        >
          {t("common.back")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={skip}
          className="min-h-11 shrink-0 rounded-lg border border-border bg-surface px-3 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-40"
        >
          {t("common.skip")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={next}
          className="inline-flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-ui-sm text-primary-foreground transition active:bg-primary-hover disabled:opacity-40"
        >
          {busy ? <LoaderCircle size={13} className="animate-spin" /> : null}
          {index < questions.length - 1 ? t("common.next") : t("common.submit")}
        </button>
      </div>
    );

  return (
    <BottomSheet
      open
      title={t("mobile.agent.questionRequest")}
      onClose={() => {
        if (!busy) void answer(null);
      }}
      footer={footer}
    >
      {current ? (
        <>
          {questions.length > 1 ? (
            <p className="text-ui-2xs text-slate-400">
              {t("mobile.agent.questionProgress", { i: index + 1, n: questions.length })}
            </p>
          ) : null}
          {current.header ? (
            <p className="text-ui-xs text-slate-500">{current.header}</p>
          ) : null}
          <p className="mt-1 select-text whitespace-pre-wrap text-ui-caption leading-5 text-slate-900">
            {current.question}
          </p>
          {current.detail ? (
            <p className="mt-2 max-h-60 select-text overflow-y-auto overscroll-contain rounded-lg border border-border bg-canvas px-2.5 py-2 text-ui-xs leading-5 whitespace-pre-wrap text-slate-600">
              {current.detail}
            </p>
          ) : null}
          {(current.options ?? []).length > 0 ? (
            <div className="mt-3 space-y-2">
              {(current.options ?? []).map((option) => {
                const picked = (selected[current.id] ?? []).includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    disabled={busy}
                    aria-pressed={picked}
                    onClick={() => {
                      if (singleSelect) {
                        void answer([{ id: current.id, selected: [option.label] }]);
                      } else {
                        toggle(option.label);
                      }
                    }}
                    className={`flex min-h-11 w-full flex-col items-start rounded-lg border px-3 py-2 text-left transition disabled:opacity-40 ${
                      picked
                        ? "border-sky-300 bg-sky-50"
                        : "border-border bg-surface active:bg-overlay-soft"
                    }`}
                  >
                    <span className="text-ui-caption text-slate-900">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 text-ui-xs leading-5 text-slate-500">
                        {option.description}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {singleSelect && hasOptions ? null : (
            <label className="mt-3 block">
              <span className="text-ui-caption text-slate-500">
                {t("mobile.agent.questionCustom")}
              </span>
              <input
                value={custom[current.id] ?? ""}
                onChange={(event) =>
                  setCustom((prev) => ({ ...prev, [current.id]: event.target.value }))
                }
                placeholder={t("mobile.agent.questionCustomPlaceholder")}
                className="mt-1.5 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-ui-base text-slate-700 transition placeholder:text-slate-400"
              />
            </label>
          )}
          {error ? (
            <p
              className="mt-3 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700"
              title={t("mobile.agent.questionFailed")}
            >
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-ui-caption text-slate-400">{t("common.empty")}</p>
      )}
    </BottomSheet>
  );
}

/* -------------------------------------------------------------------------
   Team board (docs/DSH.md §9.5)
   ------------------------------------------------------------------------- */

/** One compact choice in the composer work bar; active is a soft fill. */
function WorkPill(props: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      data-component="WorkPill"
      type="button"
      aria-pressed={props.active}
      disabled={props.disabled}
      title={props.title}
      onClick={props.onClick}
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-ui-2xs transition ${
        props.active
          ? "bg-sky-50 text-sky-700"
          : "text-slate-500 active:bg-overlay-soft"
      } ${props.disabled ? "opacity-50" : ""}`}
    >
      <Icon size={11} />
      {props.label}
    </button>
  );
}

/** The three panes the desktop pane bar offers; `task` only for workflows. */
type SessionPane = "task" | "chat" | "trajectory";

/** Pane choice, mirrored from the desktop pane bar. */
function PaneSwitch(props: {
  value: SessionPane;
  onChange: (value: SessionPane) => void;
  /** Workflow tasks get the task pane; a free chat has no task to show. */
  showTask: boolean;
}) {
  const options: ReadonlyArray<{ value: SessionPane; label: MessageKey }> = [
    ...(props.showTask
      ? [{ value: "task", label: "mobile.agent.paneTask" } as const]
      : []),
    { value: "chat", label: "mobile.agent.paneChat" },
    { value: "trajectory", label: "mobile.agent.paneTrajectory" },
  ];
  return (
    <div
      data-component="PaneSwitch"
      role="tablist"
      className="inline-flex shrink-0 items-center rounded-lg border border-border bg-surface p-0.5"
    >
      {options.map((option) => {
        const active = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => props.onChange(option.value)}
            className={`min-h-8 rounded-md px-3 py-1 text-ui-sm transition ${
              active ? "bg-slate-100 text-slate-900" : "text-slate-500 active:bg-overlay-soft"
            }`}
          >
            {t(option.label)}
          </button>
        );
      })}
    </div>
  );
}

function TeamCard(props: { task: DshTeamTask }) {
  const task = props.task;
  const scopes = task.writeScopes.slice(0, MAX_SCOPES);
  const hidden = task.writeScopes.length - scopes.length;
  return (
    <article data-component="TeamCard" className="rounded-xl border border-border bg-surface px-3 py-2">
      <p
        className="line-clamp-2 text-ui-caption leading-5 text-slate-900"
        title={task.description || undefined}
      >
        {task.subject}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-xs text-slate-500">
        <span className="max-w-full truncate">
          {task.ownerName || t("mobile.agent.teamUnassigned")}
        </span>
        {task.blockedBy.length > 0 ? (
          <span className="shrink-0 text-amber-700" title={task.blockedBy.join(", ")}>
            {t("mobile.agent.teamBlocked", { n: task.blockedBy.length })}
          </span>
        ) : null}
        {task.ready && task.status === "pending" ? (
          <span className="shrink-0 text-emerald-700">{t("mobile.agent.teamReady")}</span>
        ) : null}
      </p>
      {scopes.length > 0 ? (
        <p className="mt-1 flex flex-wrap gap-1">
          {scopes.map((scope) => (
            <span
              key={scope}
              title={scope}
              className="max-w-full truncate rounded-md border border-border px-1 font-mono text-ui-2xs text-slate-500"
            >
              {scope}
            </span>
          ))}
          {hidden > 0 ? (
            <span className="px-1 text-ui-2xs text-slate-400">
              {t("mobile.agent.teamMoreScopes", { n: hidden })}
            </span>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}

/** Vertical status groups; empty groups and an empty board carry no rows. */
function TeamBoard(props: { team: DshTeam | null; error: string | null }) {
  const team = props.team;
  if (!team) {
    return props.error ? (
      <p
        data-component="TeamBoard"
        className="px-4 py-6 text-ui-caption leading-5 text-rose-600"
        title={t("mobile.agent.teamLoadFailed")}
      >
        {props.error}
      </p>
    ) : (
      <p data-component="TeamBoard" className="px-4 py-6 text-ui-caption text-slate-400">{t("common.reading")}</p>
    );
  }

  return (
    <div data-component="TeamBoard" className="flex flex-col gap-3">
      {team.failure ? (
        <p
          className="mx-4 mt-2 select-text truncate text-ui-xs leading-5 text-amber-700"
          title={team.failure}
        >
          {team.failure}
        </p>
      ) : null}

      {team.tasks.length === 0 ? (
        <p
          className="px-4 py-10 text-center text-ui-base text-slate-400"
          title={t("mobile.agent.teamEmptyHint")}
        >
          {t("mobile.agent.teamEmpty")}
        </p>
      ) : (
        TEAM_COLUMNS.map((column) => {
          const tasks = team.tasks.filter((task) => task.status === column.status);
          if (tasks.length === 0) return null;
          return (
            <section key={column.status}>
              <h2 className="border-b border-border bg-overlay-soft px-4 py-1 text-ui-2xs text-slate-500">
                {t(column.label)}
              </h2>
              <div className="space-y-2 px-4 py-2">
                {tasks.map((task) => (
                  <TeamCard key={task.id} task={task} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------
   Child-session transcripts (sub-agent folds)
   ------------------------------------------------------------------------- */

type ChildTranscript = {
  /** Oldest first; empty until the first read lands. */
  entries: DshEntry[];
  /** True from fold-open until the first read resolves. */
  loading: boolean;
  /** The last fetch failed; the fold shows it until a poll succeeds. */
  error: string | null;
};

/** The revisions the finishing chain created, as label/value rows. */
function taskHashes(task: DshTask): { label: string; value: string }[] {
  return [
    { label: t("mobile.agent.taskGitStart"), value: task.git.start },
    { label: t("mobile.agent.taskGitCommit"), value: task.git.commit },
    { label: t("mobile.agent.taskGitMerge"), value: task.git.merge },
  ].filter((row): row is { label: string; value: string } => Boolean(row.value));
}

/** One label/value line; long values wrap and stay selectable. */
function TaskFact(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div data-component="TaskFact" className="flex items-start gap-2">
      <span className="w-14 shrink-0 text-ui-2xs text-slate-400">{props.label}</span>
      <span
        className={`min-w-0 flex-1 select-text break-all text-ui-xs text-slate-700 ${
          props.mono ? "font-mono" : ""
        }`}
      >
        {props.value}
      </span>
    </div>
  );
}

/**
 * The task pane: the facts of this round (state, branch, model, working
 * directory, revisions, write-back, review summary) plus the record link the
 * round came from (desktop parity: 打开缺陷 / 打开事项). Actions stay in the
 * composer gate, so there is one place to approve, retry or abandon.
 */
function TaskPane(props: { task: DshTask }) {
  const { task } = props;
  const changes = task.changes;
  const hashes = taskHashes(task);
  const writeback = task.writeback;
  const wroteStatus = Boolean(writeback.statusFrom || writeback.statusTo);
  const review = task.review;
  const workDir = task.direct
    ? t("mobile.agent.taskDirect")
    : task.worktreePath || task.repoPath || "";

  /**
   * Where this round's record lives. A bug task links the TAPD detail page
   * (the task stores the long entity id, the same id the detail route uses);
   * a local task links its project's item page. Captured first so the route
   * closures keep the narrowed values.
   */
  const bugRef =
    task.kind === "bug" && task.bugId && task.project
      ? { bugId: task.bugId, workspaceId: task.project.id }
      : null;
  const localProjectId =
    task.kind === "local_item" && task.project ? task.project.id : null;
  const detailLink = bugRef
    ? {
        label: t("mobile.agent.openBug"),
        go: () =>
          navigate(
            `#/bug/${encodeURIComponent(bugRef.bugId)}?w=${encodeURIComponent(bugRef.workspaceId)}`,
          ),
      }
    : localProjectId
      ? {
          label: t("mobile.agent.openItem"),
          go: () => navigate(`#/local?p=${encodeURIComponent(localProjectId)}`),
        }
      : null;

  return (
    <div data-component="TaskPane" className="flex flex-col gap-3 px-4 py-3">
      <section className="rounded-xl border border-border bg-surface p-3">
        <div className="flex items-center gap-2">
          <WorkflowChip workflow={task.workflow} interrupted={isInterrupted(task)} />
          {changes ? (
            <span className="ml-auto shrink-0 text-ui-xs text-slate-500">
              {t("mobile.agent.taskChanges", { files: changes.files })}
              <span className="ml-1 text-emerald-700">+{changes.additions}</span>
              <span className="ml-1 text-rose-600">−{changes.deletions}</span>
            </span>
          ) : null}
        </div>
        <div className="mt-2 space-y-1.5">
          {task.branch ? (
            <TaskFact label={t("mobile.agent.taskBranch")} value={task.branch} mono />
          ) : null}
          {task.model ? (
            <TaskFact label={t("mobile.agent.taskModel")} value={task.model} mono />
          ) : null}
          {workDir ? (
            <TaskFact label={t("mobile.agent.taskWorkingDir")} value={workDir} mono />
          ) : null}
          {task.bugId ? (
            <TaskFact label={t("mobile.agent.taskBug")} value={task.bugId} mono />
          ) : null}
        </div>
        {detailLink ? (
          <button
            type="button"
            onClick={detailLink.go}
            className="mt-2 inline-flex min-h-8 items-center gap-1.5 text-ui-xs text-sky-700 transition active:opacity-60"
          >
            <ExternalLink size={11} />
            {detailLink.label}
          </button>
        ) : null}
      </section>

      {hashes.length > 0 ? (
        <section className="rounded-xl border border-border bg-surface p-3">
          <h2 className="text-ui-caption text-slate-900">
            {t("mobile.agent.taskRevisions")}
          </h2>
          <div className="mt-2 space-y-1.5">
            {hashes.map((row) => (
              <TaskFact key={row.label} label={row.label} value={row.value} mono />
            ))}
          </div>
        </section>
      ) : null}

      {task.kind === "bug" && (writeback.comment || wroteStatus) ? (
        <section className="rounded-xl border border-border bg-surface p-3">
          <h2 className="text-ui-caption text-slate-900">{t("mobile.agent.taskWriteback")}</h2>
          <div className="mt-2 space-y-1">
            {writeback.comment ? (
              <p className="text-ui-xs text-emerald-700">
                {t("mobile.agent.taskWritebackComment")}
              </p>
            ) : null}
            {wroteStatus ? (
              <p className="text-ui-xs text-slate-600">
                {t("mobile.agent.taskWritebackStatus", {
                  from: writeback.statusFrom ?? "-",
                  to: writeback.statusTo ?? "-",
                })}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {review && (review.summary || review.verification || review.risks) ? (
        <section className="rounded-xl border border-border bg-surface p-3">
          <h2 className="text-ui-caption text-slate-900">{t("mobile.agent.reviewTitle")}</h2>
          <div className="mt-2 space-y-1">
            {review.summary ? (
              <ReviewField label={t("mobile.agent.reviewSummary")} text={review.summary} />
            ) : null}
            {review.verification ? (
              <ReviewField
                label={t("mobile.agent.reviewVerification")}
                text={review.verification}
              />
            ) : null}
            {review.risks ? (
              <ReviewField label={t("mobile.agent.reviewRisks")} text={review.risks} />
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

/**
 * The end-of-transcript receipt of a finished task: the revisions, the change
 * count and the TAPD result the user can trust, with a way into the task pane.
 * Deliberately a task-level card, not a turn.
 */
function TaskDoneCard(props: { task: DshTask; onViewTask: () => void }) {
  const { task } = props;
  const hashes = taskHashes(task);
  const writeback = task.writeback;
  const wroteStatus = Boolean(writeback.statusFrom || writeback.statusTo);

  return (
    <section data-component="TaskDoneCard" className="rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <CheckCircle2 size={14} className="shrink-0 text-emerald-600" />
        <span className="text-ui-caption text-slate-800">{t("mobile.agent.doneTitle")}</span>
        {task.changes ? (
          <span className="ml-auto shrink-0 text-ui-xs text-slate-500">
            {t("mobile.agent.taskChanges", { files: task.changes.files })}
            <span className="ml-1 text-emerald-700">+{task.changes.additions}</span>
            <span className="ml-1 text-rose-600">−{task.changes.deletions}</span>
          </span>
        ) : null}
      </div>

      {hashes.length > 0 ? (
        <div className="mt-1.5 space-y-1">
          {hashes.map((row) => (
            <div key={row.label} className="flex items-start gap-2">
              <span className="w-14 shrink-0 text-ui-2xs text-slate-400">{row.label}</span>
              <span className="min-w-0 flex-1 select-text break-all font-mono text-ui-2xs text-slate-500">
                {row.value}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {task.kind === "bug" && (writeback.comment || wroteStatus) ? (
        <p className="mt-1 text-ui-2xs text-slate-500">
          {writeback.comment ? `${t("mobile.agent.taskWritebackComment")} · ` : null}
          {wroteStatus
            ? t("mobile.agent.taskWritebackStatus", {
                from: writeback.statusFrom ?? "-",
                to: writeback.statusTo ?? "-",
              })
            : null}
        </p>
      ) : null}

      <button
        type="button"
        onClick={props.onViewTask}
        className="mt-1.5 text-ui-2xs text-sky-700 transition active:opacity-60"
      >
        {t("mobile.agent.viewTask")}
      </button>
    </section>
  );
}

/**
 * One task: header (title + workflow chip), workflow actions, the turn-grouped
 * transcript with its sub-agent folds, answerable approvals/questions and the
 * composer. No live token streaming — the transcript is always the committed
 * rows, polled incrementally; child sessions are polled only while their fold
 * is open.
 */
export function AgentSessionPage(props: { id: string }) {
  const { id } = props;
  const feed = useAgentFeed();
  const prefs = usePrefs();
  const task = useMemo(
    () => feed.tasks?.find((row) => row.id === id) ?? null,
    [feed.tasks, id],
  );
  const pending = useMemo(
    () => feed.pending.filter((item) => item.sessionId === id),
    [feed.pending, id],
  );
  const approvals = useMemo(
    () => pending.filter((item): item is ApprovalPending => item.kind === "approval"),
    [pending],
  );
  const questions = useMemo(
    () => pending.filter((item): item is QuestionPending => item.kind === "question"),
    [pending],
  );

  const [entries, setEntries] = useState<DshEntry[] | null>(null);
  /** `false` = the runtime has not seen this session yet (desktop restart). */
  const [entriesKnown, setEntriesKnown] = useState<boolean | null>(null);
  const [entriesError, setEntriesError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  /** Send / stop / mode / model failures share one line above the card. */
  const [composerError, setComposerError] = useState<{
    text: string;
    label: MessageKey;
  } | null>(null);

  /** Sanitized model catalog (`settings_agent_models`), read once per open. */
  const [catalog, setCatalog] = useState<DshModelsCatalog | null>(null);
  /** This session's model-route pick; `null` follows the session row. */
  const [selectionOverride, setSelectionOverride] = useState<ModelSelection | null>(null);
  /** This session's permission mode; `null` inherits the runtime default. */
  const [modeState, setModeState] = useState<DshPermissionMode | null>(null);
  /** Runtime phase gate: the composer refuses to send into a dead runtime. */
  const [runtime, setRuntime] = useState<DshStatus | null>(null);
  const [startingRuntime, setStartingRuntime] = useState(false);
  /** The runtime-wide default a session without its own choice inherits. */
  const [defaultMode, setDefaultMode] = useState<DshPermissionMode>("auto");
  /** Local plan flag; `null` follows the engine's `plan/mode` event state. */
  const [planOverride, setPlanOverride] = useState<boolean | null>(null);
  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const [modeSheetOpen, setModeSheetOpen] = useState(false);

  /** `dsh_sessions` rows: session todos, child identity and running flags. */
  const [sessions, setSessions] = useState<DshSession[] | null>(null);
  /** Explicit pane; the conversation is the default. */
  const [pane, setPane] = useState<SessionPane>("chat");

  /** Child transcripts, keyed by session id; grown only through open folds. */
  const [childState, setChildState] = useState<Record<string, ChildTranscript>>({});

  const [taskBusy, setTaskBusy] = useState<TaskAction | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  /** Review file list (`dsh_task_changes`); `null` until the first read. */
  const [reviewFiles, setReviewFiles] = useState<DshTaskFile[] | null>(null);
  const [reviewFilesTruncated, setReviewFilesTruncated] = useState(false);
  const [reviewFilesLoading, setReviewFilesLoading] = useState(false);
  const [reviewFilesError, setReviewFilesError] = useState<string | null>(null);
  /** Free-chat worktree switch (only meaningful for `kind: "chat"`). */
  const [worktreeBusy, setWorktreeBusy] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [activeQuestion, setActiveQuestion] = useState<number | null>(null);
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamError, setTeamError] = useState<string | null>(null);
  /** Explicit pane; `null` follows the team mode default (board when on). */
  const [teamView, setTeamView] = useState<"chat" | "board" | null>(null);

  const alive = useRef(true);
  const entriesInFlight = useRef(false);
  const sessionsInFlight = useRef(false);
  const reviewInFlight = useRef(false);
  const childCursors = useRef<Record<string, number>>({});
  const childInFlight = useRef<Set<string>>(new Set());
  /** Session ids whose sub-agent fold is currently open (controlled). */
  const [openChildren, setOpenChildren] = useState<ReadonlySet<string>>(new Set());
  const resumeTried = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** The transcript's own scroll box, above the composer. */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** Poll cursor: the highest seq the incremental reads have reached. */
  const lastSeq = useRef(0);
  /**
   * Scroll tracker: the highest seq the reader has been shown. Separate from
   * `lastSeq` on purpose — the poll continuation writes its cursor
   * synchronously before effects run, so comparing against it here would
   * never fire.
   */
  const followSeq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadEntries = useCallback(
    async (poll: boolean) => {
      if (entriesInFlight.current) return;
      entriesInFlight.current = true;
      // Incremental: the runtime already ships only rows past `sinceSeq`.
      // A poll without a cursor is the first read, which is a full snapshot.
      const from = poll && lastSeq.current > 0 ? lastSeq.current : undefined;
      try {
        const result = await dshApi.entries(id, from);
        if (!alive.current) return;
        // A restarted desktop answers with a smaller `lastSeq`; that
        // invalidates the suffix. Reset the cursor and let the `finally`
        // below release the gate — the next poll is then a full read.
        if (from !== undefined && result.known && result.lastSeq < lastSeq.current) {
          lastSeq.current = 0;
          return;
        }
        if (from !== undefined && result.known) {
          const fresh = result.entries.filter((entry) => entry.seq > lastSeq.current);
          if (fresh.length > 0) {
            setEntries((current) => [...(current ?? []), ...fresh]);
          }
        } else if (from !== undefined) {
          // An incremental poll came back `known: false` (desktop restart).
          // Keep the already-shown rows instead of flashing an empty
          // transcript: re-arm the resume effect and let the full read after
          // the re-attach replace this list in one shot.
          lastSeq.current = 0;
          resumeTried.current = false;
          setEntriesKnown(false);
          setEntriesError(null);
          return;
        } else {
          // `known: false` means the desktop restarted before the bridge saw
          // this session; the transcript is simply empty, not a failure.
          setEntries(result.entries);
        }
        lastSeq.current = result.lastSeq;
        setEntriesKnown(result.known);
        setEntriesError(null);
      } catch (err) {
        if (alive.current) setEntriesError(asApiError(err).message);
      } finally {
        entriesInFlight.current = false;
      }
    },
    [id],
  );

  /**
   * Session rows feed the todo card, the child markers (`parentSession`) and
   * the child running flags. Failures stay silent: the transcript poll below
   * already surfaces connection problems, and a stale row is better than an
   * error row here.
   */
  const loadSessions = useCallback(async () => {
    if (sessionsInFlight.current) return;
    sessionsInFlight.current = true;
    try {
      const { sessions: rows } = await dshApi.sessions();
      if (alive.current) setSessions(rows);
    } catch {
      // Keep the last good rows.
    } finally {
      sessionsInFlight.current = false;
    }
    // The composer refuses to send while the runtime is down; the phase is
    // cheap and rides the same cadence. Failures keep the last good phase.
    void dshApi.status().then(
      (status) => {
        if (alive.current) setRuntime(status);
      },
      () => {},
    );
  }, []);

  /** The review screen's changed-file list; one read per workflow phase. */
  const loadReviewFiles = useCallback(async () => {
    if (reviewInFlight.current) return;
    reviewInFlight.current = true;
    setReviewFilesLoading(true);
    try {
      const result = await dshApi.taskChanges(id);
      if (!alive.current) return;
      setReviewFiles(result.files);
      setReviewFilesTruncated(result.truncated);
      setReviewFilesError(null);
    } catch (err) {
      if (alive.current) setReviewFilesError(asApiError(err).message);
    } finally {
      reviewInFlight.current = false;
      if (alive.current) setReviewFilesLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadEntries(false);
    void loadSessions();
    const poll = () => {
      if (isPageHidden()) return;
      void loadEntries(true);
    };
    const pollSessions = () => {
      if (isPageHidden()) return;
      void loadSessions();
    };
    const timer = window.setInterval(poll, SESSION_POLL_MS);
    const sessionsTimer = window.setInterval(pollSessions, SESSIONS_POLL_MS);
    const off = onPageVisibilityChange(() => {
      if (isPageHidden()) return;
      void loadEntries(true);
      void loadSessions();
      void refreshAgentFeed();
    });
    return () => {
      window.clearInterval(timer);
      window.clearInterval(sessionsTimer);
      off();
    };
  }, [loadEntries, loadSessions]);

  // The catalog backs the composer's model picker; the mode reads are one-shot
  // because both sides apply their choice at the next tool call or prompt.
  useEffect(() => {
    void dshApi.agentModels().then(
      (result) => {
        if (alive.current) setCatalog(result.models);
      },
      () => {
        // The picker degrades to the empty-catalog message; nothing else here
        // depends on it.
      },
    );
    void dshApi.sessionMode(id).then(
      (result) => {
        if (alive.current) setModeState(result.mode);
      },
      () => {},
    );
    void dshApi.policyGet().then(
      (result) => {
        if (alive.current) setDefaultMode(result.mode);
      },
      () => {},
    );
  }, [id]);

  // Tool rows are merged in place (a result keeps the call's seq), so statuses
  // like `completed` only reach the phone with a full read. Do one at turn end.
  const sessionRow = useMemo(
    () => sessions?.find((row) => row.id === id) ?? null,
    [sessions, id],
  );
  const sessionStatus = sessionRow?.status ?? task?.status ?? null;
  useEffect(() => {
    if (sessionStatus && sessionStatus !== "running") void loadEntries(false);
  }, [sessionStatus, loadEntries]);

  /** Review and finishing share one screen; a chat never has a workflow gate. */
  const reviewWorkflow =
    task && task.kind !== "chat" ? task.workflow : null;
  const reviewing =
    reviewWorkflow === "awaiting_review" || reviewWorkflow === "finalizing";
  useEffect(() => {
    if (!reviewing) {
      setReviewFiles(null);
      setReviewFilesTruncated(false);
      setReviewFilesError(null);
      setReviewFilesLoading(false);
      return;
    }
    void loadReviewFiles();
  }, [reviewing, reviewWorkflow, loadReviewFiles]);

  /* -- Child transcripts: lazy per open fold ------------------------------ */

  const loadChild = useCallback(async (childId: string) => {
    if (isPendingChild(childId)) return;
    if (childInFlight.current.has(childId)) return;
    childInFlight.current.add(childId);
    const cursor = childCursors.current[childId] ?? 0;
    const from = cursor > 0 ? cursor : undefined;
    try {
      const result = await dshApi.entries(childId, from);
      if (!alive.current) return;
      // A restarted desktop invalidates the suffix. Reset the cursor and let
      // the `finally` below release the gate — the next poll is then a full
      // read.
      if (from !== undefined && result.known && result.lastSeq < cursor) {
        childCursors.current[childId] = 0;
        return;
      }
      childCursors.current[childId] = result.lastSeq;
      setChildState((current) => {
        const previous = current[childId];
        // Without a cursor (first read, or `known: false` after a restart)
        // the response is the whole transcript.
        const base = from !== undefined && result.known ? (previous?.entries ?? []) : [];
        const fresh = result.entries.filter((entry) => entry.seq > cursor);
        return {
          ...current,
          [childId]: {
            entries: [...base, ...fresh].sort((left, right) => left.seq - right.seq),
            loading: false,
            error: null,
          },
        };
      });
    } catch (err) {
      // Keep the last good rows; the fold shows the error instead of the
      // transcript while there is nothing to show, and the next poll retries.
      if (alive.current) {
        const message = asApiError(err).message;
        setChildState((current) => ({
          ...current,
          [childId]: {
            entries: current[childId]?.entries ?? [],
            loading: false,
            error: message,
          },
        }));
      }
    } finally {
      childInFlight.current.delete(childId);
    }
  }, []);

  /** Controlled child folds: opening one fetches the transcript immediately;
   *  the interval below keeps an open fold fresh until it closes. */
  const toggleChild = useCallback(
    (childId: string) => {
      const opening = !openChildren.has(childId);
      setOpenChildren((current) => {
        const next = new Set(current);
        if (next.has(childId)) next.delete(childId);
        else next.add(childId);
        return next;
      });
      if (opening && !isPendingChild(childId)) void loadChild(childId);
    },
    [openChildren, loadChild],
  );

  // Only open folds poll; pending placeholders (`pending:<callId>`) have no
  // session to read until the runtime registers it.
  useEffect(() => {
    if (openChildren.size === 0) return;
    const poll = () => {
      if (isPageHidden()) return;
      for (const childId of openChildren) void loadChild(childId);
    };
    poll();
    const timer = window.setInterval(poll, SESSION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [openChildren, loadChild]);

  const childEntries = useCallback(
    (childId: string) => childState[childId]?.entries,
    [childState],
  );
  const childLoading = useCallback(
    (childId: string) => childState[childId]?.loading ?? false,
    [childState],
  );
  const childError = useCallback(
    (childId: string) => childState[childId]?.error ?? null,
    [childState],
  );

  // The app's only poller also refreshes this session's board while the page
  // is open, so the board never needs an interval of its own. Free chats have
  // no board, and a failed first task read simply leaves it unregistered.
  const hasTeam = Boolean(task && task.kind !== "chat");
  useEffect(() => {
    if (!hasTeam) return;
    watchAgentTeam(id);
    return () => watchAgentTeam(null);
  }, [id, hasTeam]);

  // A task restored from a previous desktop run has no live session until it
  // is resumed. Do that once, on open, so its persisted transcript appears.
  useEffect(() => {
    if (entriesKnown !== false || task === null || resumeTried.current) return;
    resumeTried.current = true;
    setResuming(true);
    setResumeError(null);
    void (async () => {
      try {
        const { task: resumed } = await dshApi.taskResume(id);
        applyAgentTask(resumed);
        await loadEntries(false);
        void refreshAgentFeed();
      } catch (err) {
        if (alive.current) setResumeError(asApiError(err).message);
      } finally {
        if (alive.current) setResuming(false);
      }
    })();
  }, [entriesKnown, task, id, loadEntries]);

  const runTaskAction = async (
    action: TaskAction,
    run: () => Promise<{ task: DshTask }>,
  ) => {
    if (taskBusy) return;
    setTaskBusy(action);
    setTaskError(null);
    try {
      const { task: updated } = await run();
      applyAgentTask(updated);
      // The workflow may have entered a new phase; the follow-up read also
      // refreshes pending and covers a lost response.
      void refreshAgentFeed();
    } catch (err) {
      if (alive.current) setTaskError(asApiError(err).message);
    } finally {
      if (alive.current) setTaskBusy(null);
    }
  };

  /** Approve = commit + merge + cleanup + writeback; no second confirmation. */
  const approveTask = () => void runTaskAction("approve", () => dshApi.taskApprove(id));
  /** `stash` keeps the worktree changes when the task is abandoned. */
  const abandonTask = () => void runTaskAction("cancel", () => dshApi.taskCancel(id, true));
  const retryFinalize = () =>
    void runTaskAction("retry", () => dshApi.taskRetryFinalize(id));

  /** Free-chat worktree switch; the host moves the session's cwd in place. */
  const toggleChatWorktree = async (enabled: boolean) => {
    if (worktreeBusy) return;
    setWorktreeBusy(true);
    setWorktreeError(null);
    try {
      const { task: updated } = await dshApi.chatWorktree(id, enabled);
      applyAgentTask(updated);
      void refreshAgentFeed();
    } catch (err) {
      if (alive.current) setWorktreeError(asApiError(err).message);
    } finally {
      if (alive.current) setWorktreeBusy(false);
    }
  };

  const team = feed.teams[id];
  const teamEnabled = Boolean(team?.enabled);
  // The board replaces the conversation pane; the trajectory stays reachable
  // from either, and switching back restores the board default.
  const boardView = teamEnabled && (teamView ?? "board") === "board" && pane === "chat";

  /** Team mode is per session; the returned board replaces the polled copy. */
  const toggleTeam = async (enabled: boolean) => {
    if (teamBusy) return;
    setTeamBusy(true);
    setTeamError(null);
    try {
      const { team: next } = await dshApi.teamSet(id, enabled);
      applyAgentTeam(id, next);
      // The new mode decides the default pane again.
      setTeamView(null);
      void refreshAgentFeed();
    } catch (err) {
      if (alive.current) setTeamError(asApiError(err).message);
    } finally {
      if (alive.current) setTeamBusy(false);
    }
  };

  const openQuestion = useMemo(
    () => questions.find((item) => item.rpcId === activeQuestion) ?? null,
    [questions, activeQuestion],
  );

  // Answered on the desktop (or cancelled by the runtime): close the sheet.
  useEffect(() => {
    if (activeQuestion !== null && openQuestion === null) setActiveQuestion(null);
  }, [activeQuestion, openQuestion]);

  // The session's own choice wins; an old session without one still knows the
  // route of its last request; otherwise the catalog's active pair.
  const catalogActive = resolveActive(catalog);
  const configured: ModelSelection | null = catalogActive
    ? { provider: catalogActive.provider.id, model: catalogActive.model.id }
    : null;
  const chosen: ModelSelection | null =
    selectionOverride ??
    sessionRow?.selection ??
    (sessionRow?.usage?.provider && sessionRow?.usage?.model
      ? { provider: sessionRow.usage.provider, model: sessionRow.usage.model }
      : null) ??
    configured;
  const route: ActiveRoute | null = useMemo(() => {
    if (!catalog || !chosen) return null;
    const provider = catalog.providers.find((item) => item.id === chosen.provider);
    const model = provider?.models.find((item) => item.id === chosen.model);
    return provider && model ? { provider, model } : null;
  }, [catalog, chosen]);
  // The session's own level wins; otherwise the level this model was last used
  // with. `off` is the floor, so a new model never silently thinks.
  const effort = route
    ? chosen?.reasoningEffort && effortStops(route.model).includes(chosen.reasoningEffort)
      ? chosen.reasoningEffort
      : rememberedEffort(catalog, route.provider.id, route.model.id)
    : undefined;
  const plan = planOverride ?? sessionRow?.planActive ?? false;
  const modeValue: ModeValue = plan ? "plan" : (modeState ?? defaultMode);
  const modelLabel = route
    ? `${route.provider.name || route.provider.id}/${route.model.id}`
    : (chosen?.model ?? t("mobile.agent.modelPickTitle"));
  // `off` is the floor; the level only reads on models that declare one.
  const showsEffort = route ? effortStops(route.model).length > 1 : false;
  const modelChipLabel =
    showsEffort && effort
      ? `${modelLabel} · ${effort === "off" ? t("mobile.agent.modelReasoningOff") : effort}`
      : modelLabel;

  // Composer status line: the same read-only figures as the desktop dock.
  const usage = sessionRow?.usage;
  const statusSegments: string[] = [];
  if (usage) {
    if (usage.turns > 0) {
      statusSegments.push(
        t("mobile.agent.usageTurns", { turns: usage.turns, steps: usage.steps }),
      );
    }
    if (usage.totalTokens > 0) {
      statusSegments.push(
        t("mobile.agent.usageTokens", { tokens: compactTokens(usage.totalTokens) }),
      );
    }
    if (usage.contextWindow > 0 && usage.contextUsedTokens > 0) {
      statusSegments.push(
        t("mobile.agent.usageContext", {
          percent: Math.min(
            100,
            Math.round((usage.contextUsedTokens / usage.contextWindow) * 100),
          ),
        }),
      );
    }
  }

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setComposerError(null);
    try {
      await dshApi.prompt(id, text);
      if (!alive.current) return;
      setDraft("");
    } catch (err) {
      // The draft is kept so the message can be retried.
      if (alive.current) {
        setComposerError({ text: asApiError(err).message, label: "mobile.agent.promptFailed" });
      }
      return;
    } finally {
      if (alive.current) setSending(false);
    }
    // The prompt is queued; entry polling picks the committed rows up.
    void loadEntries(true);
  }, [draft, sending, id, loadEntries]);

  /** The composer's stop state: end the running turn, leave the workflow alone. */
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    setComposerError(null);
    try {
      await dshApi.cancelTurn(id);
    } catch (err) {
      if (alive.current) {
        setComposerError({ text: asApiError(err).message, label: "mobile.agent.stopFailed" });
      }
    } finally {
      if (alive.current) setStopping(false);
    }
  };

  /** One explicit runtime start; the send gate clears on the next read. */
  const startRuntime = async () => {
    if (startingRuntime) return;
    setStartingRuntime(true);
    try {
      await dshApi.start();
      setRuntime(await dshApi.status());
    } catch (err) {
      if (alive.current) {
        setComposerError({ text: asApiError(err).message, label: "mobile.agent.startFailed" });
      }
    } finally {
      if (alive.current) setStartingRuntime(false);
    }
  };

  /**
   * Failed-turn retry (the shared turn block's 重试 button). The engine re-runs
   * the turn from its own log — no prompt is sent again. Failures are swallowed
   * here on purpose: the shared button only clears its spinner on resolve, so
   * the error surfaces through the composer line instead of an unhandled
   * rejection.
   */
  const retryTurn = useCallback(async () => {
    try {
      await dshApi.retryTurn(id);
      void loadEntries(true);
    } catch (err) {
      if (alive.current) {
        setComposerError({ text: asApiError(err).message, label: "mobile.agent.retryFailed" });
      }
    }
  }, [id, loadEntries]);

  /**
   * One session-local route write, with rollback on failure. The write counter
   * mirrors the desktop's `modeWrites` guard: a slow older failure must not
   * roll back a newer pick that already owns the screen.
   */
  const selectionWrites = useRef(0);
  const applySelection = async (selection: ModelSelection) => {
    const before = selectionOverride ?? chosen;
    const write = (selectionWrites.current += 1);
    setSelectionOverride(selection);
    setComposerError(null);
    try {
      await dshApi.selectModel(id, selection);
    } catch (err) {
      if (alive.current && selectionWrites.current === write) {
        setSelectionOverride(before);
        setComposerError({
          text: asApiError(err).message,
          label: "mobile.agent.modelSetFailed",
        });
      }
    }
  };

  /** A new route starts at the level that model last used. A model with no
   *  reasoning ladder omits `reasoningEffort`: `off` would fail upstream. */
  const pickModel = (provider: CatalogProvider, model: CatalogModel) => {
    setModelSheetOpen(false);
    const level = rememberedEffort(catalog, provider.id, model.id);
    void applySelection({
      provider: provider.id,
      model: model.id,
      ...(level ? { reasoningEffort: level } : {}),
    });
  };

  const pickEffort = (level: string) => {
    if (!route) return;
    void applySelection({
      provider: route.provider.id,
      model: route.model.id,
      reasoningEffort: level,
    });
  };

  /** Plan is a separate engine flag; a mode pick also leaves plan mode. */
  const modeWrites = useRef(0);
  const pickMode = async (value: ModeValue) => {
    setModeSheetOpen(false);
    const nextPlan = value === "plan";
    const nextMode = nextPlan ? null : value;
    const beforeMode = modeState;
    const beforePlan = planOverride;
    const write = (modeWrites.current += 1);
    setPlanOverride(nextPlan);
    if (nextMode) setModeState(nextMode);
    setComposerError(null);
    try {
      await dshApi.setSessionMode(
        id,
        nextMode ? { mode: nextMode, plan: nextPlan } : { plan: nextPlan },
      );
    } catch (err) {
      // A newer pick owns the screen now; its own failure/success decides.
      if (alive.current && modeWrites.current === write) {
        setModeState(beforeMode);
        setPlanOverride(beforePlan);
        setComposerError({
          text: asApiError(err).message,
          label: "mobile.agent.modeSetFailed",
        });
      }
    }
  };

  // Composer grows with the draft up to a soft cap, then scrolls internally.
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }, [draft]);

  const sorted = useMemo(
    () => (entries ? [...entries].sort((left, right) => left.seq - right.seq) : null),
    [entries],
  );

  // Follow new rows only when the reader was already at the bottom.
  useEffect(() => {
    if (!sorted || sorted.length === 0) return;
    const element = bottomRef.current;
    if (!element) return;
    const latest = sorted[sorted.length - 1].seq;
    const firstLoad = followSeq.current === 0;
    // The transcript has its own scroll box, so "at the bottom" is measured
    // against that box — not the window, which also holds the composer.
    const scroller = scrollRef.current;
    const nearBottom =
      !scroller ||
      element.getBoundingClientRect().top <=
        scroller.getBoundingClientRect().bottom + 64;
    if (firstLoad || (latest > followSeq.current && nearBottom)) {
      // Scroll the box itself, then once more after the frame settles: the
      // first pass runs before late layout (wrapped markdown, cards), which
      // used to leave the last ~20px below the fold.
      const pin = () => {
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
        else element.scrollIntoView({ block: "end" });
      };
      pin();
      requestAnimationFrame(pin);
    }
    followSeq.current = latest;
  }, [sorted]);

  // Panes are different documents: the task pane opens at its top instead of
  // inheriting the transcript's scroll position. Reset twice — the browser's
  // scroll anchoring otherwise pulls the new shorter pane back down.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || pane === "chat") return;
    scroller.scrollTop = 0;
    requestAnimationFrame(() => {
      scroller.scrollTop = 0;
    });
  }, [pane]);

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    // Desktop keyboards send on Enter; the send button covers phones.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  const title = plainTitle(task?.title) || t("mobile.agent.untitledSession");
  /** The task was deleted from the list while this page sat in the back
   *  stack: one line and a way back, not a pile of load failures. */
  if (feed.tasks !== null && task === null && !isAgentSessionCreated(id)) {
    return (
      <div data-component="AgentSessionPage" className="grid h-full place-items-center p-6">
        <div className="text-center">
          <p className="text-ui-base text-slate-400">{t("mobile.agent.sessionGone")}</p>
          <button
            type="button"
            onClick={() => navigate("#/agent")}
            className="mt-5 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft"
          >
            {t("mobile.nav.back")}
          </button>
        </div>
      </div>
    );
  }
  const agentLocale: AgentLocale = resolveLocaleMode(prefs.locale);
  const todos = sessionRow?.todos ?? [];
  const sessionRunning = (sessionRow?.status ?? task?.status ?? "idle") === "running";
  // Both work-bar choices are start-only: a task is created with the config
  // default, a chat may change them until its first message.
  const started =
    task != null &&
    (task.kind !== "chat" || task.messageCount > 0 || sessionRunning);
  const canChoose = Boolean(task?.project && !started);
  const lockedHint = t("mobile.agent.workBarLocked");
  /** Why the free-chat worktree switch is off (or disabled) right now. */
  const worktreeHint = started ? lockedHint : t("mobile.agent.chatWorktreeHint");

  /** Same cards in either pane; the board puts them above the groups. */
  const pendingCards = (
    <>
      {approvals.map((request) => (
        <ApprovalCard key={request.rpcId} request={request} />
      ))}
      {questions.map((request) => (
        <QuestionCard
          key={request.rpcId}
          request={request}
          onAnswer={() => setActiveQuestion(request.rpcId)}
        />
      ))}
    </>
  );

  return (
    <AgentHostProvider value={agentHostCapabilities}>
    {/* One column filling the viewport: the header stays put, the transcript
        is its own scroller and the composer is the last flex child — the same
        shape as the desktop, so the composer never floats over the rows. */}
    <div className="flex h-full min-h-0 flex-col">
      {/* Header, pane switch and the team toggle share one block; the review
          gate lives at the top of the scrolling message area. */}
      <div className="shrink-0 bg-canvas">
        <header className="flex items-center gap-1.5 border-b border-border bg-canvas px-2 py-2">
          <button
            type="button"
            aria-label={t("mobile.nav.back")}
            onClick={() => navigate("#/agent")}
            className="shrink-0 rounded-md p-1.5 text-slate-500 transition active:bg-overlay-soft"
          >
            <ChevronLeft size={18} />
          </button>
          <span className="min-w-0 flex-1 truncate text-ui-caption text-slate-900" title={title}>
            {title}
          </span>
          {task && task.kind !== "chat" ? (
            <WorkflowChip workflow={task.workflow} interrupted={isInterrupted(task)} />
          ) : null}
        </header>

        {/* The 对话/轨迹 pane switch mirrors the desktop session pane bar. */}
        <div className="flex justify-center border-b border-border bg-canvas px-2 py-1.5">
          <PaneSwitch
            value={pane}
            onChange={setPane}
            showTask={Boolean(task && task.kind !== "chat")}
          />
        </div>

      </div>

      {resuming ? (
        <p className="px-4 py-1.5 text-ui-2xs leading-5 text-slate-400">
          {t("mobile.agent.resuming")}
        </p>
      ) : null}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]"
      >
      {/* The review gate sits at the top of the message area, so the summary
          and file list are the first thing a running task returns to. */}
      {reviewing && task ? (
        <ReviewPanel
          task={task}
          sessionId={id}
          files={reviewFiles}
          filesTruncated={reviewFilesTruncated}
          filesLoading={reviewFilesLoading}
          filesError={reviewFilesError}
          onRefresh={() => void loadReviewFiles()}
        />
      ) : null}

      {feed.tasksError ? (
        <p className="px-4 py-2 text-ui-xs text-rose-600" title={t("mobile.agent.loadFailed")}>
          {feed.tasksError}
        </p>
      ) : null}

      {feed.pendingError && feed.pendingError !== feed.tasksError ? (
        <p
          className="px-4 py-2 text-ui-xs text-rose-600"
          title={t("mobile.agent.pendingLoadFailed")}
        >
          {feed.pendingError}
        </p>
      ) : null}

      {resumeError ? (
        <p className="px-4 py-2 text-ui-xs text-rose-600" title={t("mobile.agent.resumeFailed")}>
          {resumeError}
        </p>
      ) : null}

      {entriesError ? (
        <p
          className="px-4 py-2 text-ui-xs text-rose-600"
          title={t("mobile.agent.entriesLoadFailed")}
        >
          {entriesError}
        </p>
      ) : null}

      {entries === null &&
      !entriesError &&
      pane !== "trajectory" &&
      pane !== "task" ? (
        <TranscriptSkeleton />
      ) : null}

      {pane === "task" && task ? (
        <>
          {pendingCards}
          <TaskPane task={task} />
        </>
      ) : pane === "trajectory" ? (
        <>
          {/* A blocking ask wins over any pane: the turn waits until it is
              answered, so the cards must not need a pane switch. */}
          {pendingCards}
          <TrajectoryView
            entries={sorted ?? []}
            locale={agentLocale}
            loading={entries === null && entriesError === null}
            failed={entriesError !== null && (sorted?.length ?? 0) === 0}
            onRetry={() => void loadEntries(false)}
            inspectorVariant="sheet"
          />
        </>
      ) : boardView ? (
        <>
          {/* A blocking ask wins over the board: the turn waits until it is
              answered, and the cards must not need a pane switch. */}
          {pendingCards}
          <TeamBoard team={team ?? null} error={feed.teamErrors[id] ?? null} />
        </>
      ) : (
        <>
          <div className="flex flex-col gap-3 px-4 py-3">
            {/* The session's standing plan sits above the turns it guides. */}
            {todos.length > 0 ? <TodoCard todos={todos} locale={agentLocale} /> : null}

            {sorted && sorted.length > 0 ? (
              <TurnStack
                entries={sorted}
                running={sessionRunning}
                locale={agentLocale}
                sessionId={id}
                sessions={sessions ?? []}
                childEntries={childEntries}
                childLoading={childLoading}
                childError={childError}
                openSubagentIds={openChildren}
                onToggleSubagent={toggleChild}
                onRetry={retryTurn}
              />
            ) : null}

            {task &&
            task.kind !== "chat" &&
            task.workflow === "done" &&
            !sessionRunning &&
            (task.git.commit || task.git.merge) ? (
              <TaskDoneCard task={task} onViewTask={() => setPane("task")} />
            ) : null}

            {sorted && sorted.length === 0 && todos.length === 0 ? (
              <div className="grid place-items-center px-6 py-12 text-center">
                <p
                  className="text-ui-base text-slate-400"
                  title={t("mobile.agent.emptyTranscriptHint")}
                >
                  {t("mobile.agent.emptyTranscript")}
                </p>
              </div>
            ) : null}
          </div>

          {pendingCards}
        </>
      )}

        {/* Scroll anchor: the tail of the transcript, above the composer. */}
        <div ref={bottomRef} aria-hidden="true" />
      </div>

      {/* The composer: one bordered card — editor on top, operable controls on
          its bottom row — the last flex child, directly above the tab bar.
          While the session runs the primary button is the stop state of send,
          not a separate control. */}
      <div className="shrink-0 border-t border-border bg-canvas px-4 pb-2 pt-2">
        {/* The workflow gate: approve/discard while in review, retry while the
            host is finishing. It stays above the composer so a long file list
            never hides the primary action. */}
        {task && task.kind !== "chat" && reviewing ? (
          <div className="mb-1.5">
            <div className="flex items-center gap-2">
              {task.workflow === "finalizing" ? (
                <TaskButton
                  label={
                    taskBusy === "retry"
                      ? t("mobile.agent.finalizeRetrying")
                      : t("mobile.agent.finalizeRetry")
                  }
                  tone="primary"
                  busy={taskBusy === "retry"}
                  disabled={taskBusy !== null || sessionRunning}
                  onClick={retryFinalize}
                />
              ) : (
                <>
                  <TaskButton
                    label={t("mobile.agent.approve")}
                    tone="primary"
                    busy={taskBusy === "approve"}
                    disabled={taskBusy !== null || sessionRunning}
                    onClick={approveTask}
                  />
                  <TaskButton
                    label={t("mobile.agent.abandon")}
                    tone="danger"
                    busy={taskBusy === "cancel"}
                    disabled={taskBusy !== null || sessionRunning}
                    onClick={abandonTask}
                  />
                </>
              )}
            </div>
            {taskError ? (
              <p
                className="mt-1 text-ui-xs leading-5 text-rose-600"
                title={t("common.actionFailed")}
              >
                {taskError}
              </p>
            ) : null}
          </div>
        ) : null}
        {runtime && runtime.phase !== "ready" ? (
          <div className="mb-1 flex min-h-9 items-center gap-2 px-1">
            <p
              className="min-w-0 flex-1 truncate text-ui-2xs text-slate-500"
              title={runtime.error}
            >
              {t(PHASE_LABELS[runtime.phase])}
            </p>
            <button
              type="button"
              disabled={startingRuntime}
              onClick={() => void startRuntime()}
              className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-40"
            >
              {startingRuntime ? (
                <LoaderCircle size={12} className="animate-spin" />
              ) : null}
              {t("mobile.agent.start")}
            </button>
          </div>
        ) : null}
        {task?.workflow === "done" && task.finalize?.notice ? (
          <p className="mb-1 select-text wrap-break-word px-1 text-ui-2xs leading-5 text-amber-700">
            {task.finalize.notice}
          </p>
        ) : null}
        {composerError ? (
          <p
            className="mb-1 text-ui-xs leading-5 text-rose-600"
            title={t(composerError.label)}
          >
            {composerError.text}
          </p>
        ) : null}
        <div className="rounded-xl border border-border bg-surface transition focus-within:border-slate-300">
          {task?.project ? (
            <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
              <FolderGit2 size={11} className="shrink-0 text-slate-400" />
              <span
                className="min-w-0 truncate text-ui-2xs text-slate-500"
                title={task.project.name}
              >
                {task.project.name}
              </span>
              {task.branch ? (
                <>
                  <span className="shrink-0 text-slate-300">·</span>
                  <GitBranch size={10} className="shrink-0 text-slate-400" />
                  <span
                    className="min-w-0 max-w-[38%] shrink-0 truncate font-mono text-ui-2xs text-slate-400"
                    title={task.branch}
                  >
                    {task.branch}
                  </span>
                </>
              ) : null}
              <span className="ml-auto flex min-w-0 items-center gap-1">
                {teamEnabled ? (
                  <WorkPill
                    icon={boardView ? MessageSquare : LayoutGrid}
                    label={
                      boardView
                        ? t("mobile.agent.viewChat")
                        : t("mobile.agent.viewBoard")
                    }
                    onClick={() => setTeamView(boardView ? "chat" : "board")}
                  />
                ) : null}
                <WorkPill
                  icon={Users}
                  label={t("mobile.agent.teamToggle")}
                  active={teamEnabled}
                  disabled={!canChoose || teamBusy}
                  title={canChoose ? t("mobile.agent.teamToggleHint") : lockedHint}
                  onClick={() => void toggleTeam(!teamEnabled)}
                />
                {task.kind === "chat" ? (
                  <WorkPill
                    icon={GitBranch}
                    label={t("mobile.agent.chatWorktree")}
                    active={Boolean(task.worktreePath)}
                    disabled={!canChoose || worktreeBusy}
                    title={canChoose ? t("mobile.agent.chatWorktreeHint") : worktreeHint}
                    onClick={() => void toggleChatWorktree(!task.worktreePath)}
                  />
                ) : (
                  <WorkPill
                    icon={GitBranch}
                    label={t("mobile.agent.chatWorktree")}
                    active
                    disabled
                    title={lockedHint}
                  />
                )}
              </span>
            </div>
          ) : null}
          {worktreeError || teamError ? (
            <p
              className="border-b border-border px-2.5 py-1 text-ui-2xs leading-4 text-rose-600"
              title={
                worktreeError
                  ? t("mobile.agent.chatWorktreeFailed")
                  : teamError
                    ? t("mobile.agent.teamToggleFailed")
                    : undefined
              }
            >
              {worktreeError || teamError}
            </p>
          ) : null}
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder={t("mobile.agent.composerPlaceholder")}
            title={t("mobile.agent.composerHint")}
            className="block max-h-30 min-h-11 w-full resize-none bg-transparent px-2.5 pt-2.5 text-ui-caption leading-5 text-slate-700 transition placeholder:text-slate-400 focus:outline-none"
          />
          <div className="flex items-center gap-1 px-1 pb-1 pt-0.5">
            <ModeChip value={modeValue} onClick={() => setModeSheetOpen(true)} />
            <span className="ml-auto flex min-w-0 items-center gap-1">
              <ModelChip label={modelChipLabel} onClick={() => setModelSheetOpen(true)} />
              <button
                type="button"
                aria-label={sessionRunning ? t("mobile.agent.stop") : t("common.send")}
                aria-pressed={sessionRunning}
                disabled={
                  sessionRunning
                    ? stopping
                    : sending ||
                      draft.trim().length === 0 ||
                      (runtime !== null && runtime.phase !== "ready")
                }
                onClick={() => (sessionRunning ? void stop() : void send())}
                className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg transition disabled:opacity-40 ${
                  sessionRunning
                    ? "border border-rose-200 bg-rose-50 text-rose-600 active:bg-overlay-soft"
                    : "bg-primary text-primary-foreground active:bg-primary-hover"
                }`}
              >
                {sessionRunning ? (
                  stopping ? (
                    <LoaderCircle size={16} className="animate-spin" />
                  ) : (
                    <Square size={14} fill="currentColor" />
                  )
                ) : sending ? (
                  <LoaderCircle size={16} className="animate-spin" />
                ) : (
                  <ArrowUp size={16} />
                )}
              </button>
            </span>
          </div>
        </div>
        {/* Read-only figures under the card, like the desktop dock. */}
        {statusSegments.length > 0 ? (
          <div className="mt-1 flex justify-center">
            <span className="min-w-0 truncate text-ui-2xs text-slate-400">
              {statusSegments.join(" · ")}
            </span>
          </div>
        ) : null}
      </div>

      {openQuestion ? (
        <QuestionSheet
          key={openQuestion.rpcId}
          pending={openQuestion}
          onClose={() => setActiveQuestion(null)}
        />
      ) : null}

      {modeSheetOpen ? (
        <ModeSheet
          value={modeValue}
          onPick={(value) => void pickMode(value)}
          onClose={() => setModeSheetOpen(false)}
        />
      ) : null}

      {modelSheetOpen ? (
        <ModelSheet
          catalog={catalog}
          route={route}
          chosen={chosen}
          effort={effort}
          onPick={pickModel}
          onEffort={pickEffort}
          onClose={() => setModelSheetOpen(false)}
        />
      ) : null}
    </div>
    </AgentHostProvider>
  );
}
