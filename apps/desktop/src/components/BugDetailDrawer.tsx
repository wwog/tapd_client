import { memo, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  FileText,
  GitBranch,
  Loader2,
  X,
} from "lucide-react";
import clsx from "clsx";

import {
  api,
  ensureMediaEndpoint,
  type BugDetail,
  type BugTransitionInfo,
  type ExportResult,
  type OpenMediaMode,
  type WorkspaceMember,
} from "../lib/api";
import { bugTitle, isMyBug } from "../lib/bug";
import { agentBugKey, type AgentInFlight } from "../lib/agent";
import { SkeletonBlock } from "./Skeleton";
import {
  Badge,
  Button,
  PRIORITY_TONES,
  SEVERITY_TONES,
  STATUS_TONES,
} from "./ui";
import { BugSectionTitle } from "./BugSectionTitle";
import { BugResources } from "./BugResources";
import { BugCommentComposer, BugComments } from "./BugComments";
import { BugChanges } from "./BugChanges";
import { BugCustomFields, BugMetaGrid } from "./BugMetaGrid";
import { BugDrawerFooter } from "./BugDrawerFooter";

type Props = {
  open: boolean;
  detail: BugDetail | null;
  loading: boolean;
  error: string | null;
  exporting: boolean;
  lastExport: ExportResult | null;
  onClose: () => void;
  onOpenWeb: (url: string) => void;
  onCopy: (text: string) => void;
  onExport: (detail: BugDetail) => void;
  onAgentFix: (detail: BugDetail) => void;
  /** Launch with a prompt/resources from the compose sheet. */
  onAgentCompose: (detail: BugDetail) => void;
  /** In-flight agent tasks keyed by workspace + bug. */
  agentInFlight?: Map<string, AgentInFlight>;
  /** Jump to an already queued/running task instead of enqueuing again. */
  onOpenAgentTask?: (taskId: string) => void;
  onOpenPath: (path: string) => void;
  onOpenMedia: (
    url: string,
    mode: OpenMediaMode,
    kind?: string,
    target?: string,
  ) => void;
  /** TAPD nickname of the signed-in user; decides whether actions are open. */
  me: string | null;
  /** Workspace people directory for the owner / developer pickers. */
  members: WorkspaceMember[];
  membersLoading: boolean;
  onRefreshMembers: () => void;
  onClaim: (detail: BugDetail) => Promise<void>;
  onAddComment: (detail: BugDetail, comment: string) => Promise<void>;
  onChangeField: (detail: BugDetail, field: string, value: string) => Promise<void>;
  onTransition: (detail: BugDetail, status: string) => Promise<void>;
};

function BugDetailDrawerImpl(props: Props) {
  const {
    open,
    detail,
    loading,
    error,
    exporting,
    lastExport,
    onClose,
    onOpenWeb,
    onCopy,
    onExport,
    onAgentFix,
    onAgentCompose,
    agentInFlight,
    onOpenAgentTask,
    onOpenPath,
    onOpenMedia,
    me,
    members,
    membersLoading,
    onRefreshMembers,
    onClaim,
    onAddComment,
    onChangeField,
    onTransition,
  } = props;

  const [, bumpMedia] = useState(0);
  /** Lets the resource preview own its index without the drawer closing too. */
  const previewOpenRef = useRef(false);

  /** Live agent task for this bug: re-clicking must focus it, not enqueue. */
  const agentInfo = detail
    ? agentInFlight?.get(agentBugKey(detail.workspaceId, detail.id)) ?? null
    : null;

  /** The single write action currently in flight (claim/comment/field/status). */
  const [busy, setBusy] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [transitions, setTransitions] = useState<BugTransitionInfo | null>(null);
  const [transitionsLoading, setTransitionsLoading] = useState(false);
  const [transitionsError, setTransitionsError] = useState<string | null>(null);

  const mine = detail ? isMyBug(detail.owner, me) : true;

  // Media URLs need the loopback proxy; recover if `app_info` raced startup.
  useEffect(() => {
    if (!open) return;
    void ensureMediaEndpoint().then(() => bumpMedia((value) => value + 1));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // The preview handles its own Escape; don't also close the drawer.
      if (event.key === "Escape" && !previewOpenRef.current) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // A different bug starts with an empty comment box.
  useEffect(() => {
    setCommentText("");
  }, [detail?.id]);

  // Only bugs the user owns expose workflow transitions.
  useEffect(() => {
    if (!open || !detail || !mine) {
      setTransitions(null);
      setTransitionsError(null);
      setTransitionsLoading(false);
      return;
    }

    let cancelled = false;
    setTransitionsLoading(true);
    setTransitionsError(null);
    void api
      .bugTransitions(detail.workspaceId, detail.id)
      .then((info) => {
        if (!cancelled) setTransitions(info);
      })
      .catch((cause) => {
        if (!cancelled) setTransitionsError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setTransitionsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, detail?.id, detail?.status, detail?.workspaceId, mine]);

  const runClaim = async () => {
    if (!detail || busy) return;
    setBusy("claim");
    try {
      await onClaim(detail);
    } catch {
      // The App reports the failure; the control just unlocks again.
    } finally {
      setBusy(null);
    }
  };

  const runFieldChange = async (field: string, value: string) => {
    if (!detail || busy || !value.trim() || value.trim() === currentFieldValue(detail, field)) {
      return;
    }
    setBusy(`field:${field}`);
    try {
      await onChangeField(detail, field, value);
    } catch {
      // Reported upstream.
    } finally {
      setBusy(null);
    }
  };

  const runTransition = async (status: string) => {
    if (!detail || busy) return;
    setBusy(`transition:${status}`);
    try {
      await onTransition(detail, status);
    } catch {
      // Reported upstream.
    } finally {
      setBusy(null);
    }
  };

  const submitComment = async () => {
    if (!detail || busy) return;
    const text = commentText.trim();
    if (!text) return;
    setBusy("comment");
    try {
      await onAddComment(detail, text);
      setCommentText("");
    } catch {
      // Reported upstream; keep the draft so it can be retried.
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside
      aria-hidden={!open}
        className={clsx(
          "flex h-full min-w-0 flex-col overflow-hidden rounded-xl bg-surface  border border-border",
          !open && "pointer-events-none",
        )}
      >
        <div
          className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4"
          data-tauri-drag-region
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-ui-sm text-slate-400">
              <span className="rounded bg-rose-50 px-1.5 py-0.5 font-normal text-rose-600">
                BUG
              </span>
              <span className="font-mono">#{detail?.shortId || detail?.id?.slice(-7) || "—"}</span>
              {detail ? (
                <>
                  <Badge tone={STATUS_TONES[detail.status] ?? "neutral"}>
                    {detail.statusLabel || detail.status}
                  </Badge>
                  <Badge tone={PRIORITY_TONES[detail.priority] ?? "neutral"}>
                    {detail.priorityLabel || detail.priority || "—"}
                  </Badge>
                  <Badge tone={SEVERITY_TONES[detail.severity] ?? "neutral"} dot>
                    {detail.severityLabel || detail.severity || "—"}
                  </Badge>
                </>
              ) : null}
            </div>
            {detail ? (
              <div className="mt-2 flex items-start gap-1.5">
                <h2 className="min-w-0 flex-1 text-base font-normal leading-6 text-slate-900">
                  {bugTitle(detail.title)}
                </h2>
                <button
                  type="button"
                  onClick={() => onOpenWeb(detail.bugUrl)}
                  title="在 TAPD 中打开"
                  aria-label="在 TAPD 中打开"
                  className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                >
                  <ArrowUpRight size={14} />
                </button>
              </div>
            ) : loading ? (
              <SkeletonBlock className="mt-3 h-4 w-3/4 rounded" />
            ) : (
              <h2 className="mt-2 text-base font-normal leading-6 text-slate-900">
                缺陷详情
              </h2>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭详情"
            title="关闭详情"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-ui-caption leading-6 text-rose-700">
              {error}
            </div>
          ) : null}

          {!error && loading && !detail ? <DetailSkeleton /> : null}

          {detail ? (
            <div className="space-y-5">
              <BugMetaGrid
                detail={detail}
                mine={mine}
                members={members}
                membersLoading={membersLoading}
                savingField={
                  busy?.startsWith("field:") ? busy.slice("field:".length) : null
                }
                onChangeField={(field, value) => void runFieldChange(field, value)}
                onRefreshMembers={onRefreshMembers}
              />

              {!mine ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-ui-sm leading-5 text-amber-800">
                  <p className="font-normal">
                    当前处理人：{detail.owner || "未分配"}
                  </p>
                  <p className="mt-0.5">
                    认领后才能评论、修改处理人与开发人员、流转状态。
                  </p>
                </div>
              ) : (
                <section>
                  <BugSectionTitle icon={<GitBranch size={14} />} title="状态流转" />
                  <div className="mt-2">
                    {transitionsLoading ? (
                      <p className="inline-flex items-center gap-1.5 text-ui-sm text-slate-400">
                        <Loader2 size={12} className="animate-spin" />
                        正在读取可流转状态…
                      </p>
                    ) : transitionsError ? (
                      <div className="break-all rounded-xl border border-amber-200 bg-amber-50 p-3 text-ui-sm leading-5 text-amber-700">
                        流转状态读取失败：{transitionsError}
                      </div>
                    ) : (transitions?.transitions.length ?? 0) === 0 ? (
                      <p className="rounded-xl border border-dashed border-border p-3 text-ui-caption text-slate-400">
                        当前状态没有可执行的流转
                      </p>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {transitions!.transitions.map((choice) => (
                          <Button
                            key={choice.key}
                            size="sm"
                            variant="secondary"
                            loading={busy === `transition:${choice.key}`}
                            disabled={busy !== null}
                            onClick={() => void runTransition(choice.key)}
                          >
                            {choice.label}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              )}

              <section>
                <BugSectionTitle icon={<FileText size={14} />} title="缺陷描述" />
                {detail.descriptionText ? (
                  <div className="mt-2 whitespace-pre-wrap break-words rounded-xl border border-slate-100 bg-slate-50/70 p-4 text-ui-base leading-6 text-slate-700">
                    {detail.descriptionText}
                  </div>
                ) : (
                  <div className="mt-2 rounded-xl border border-dashed border-border p-4 text-ui-caption text-slate-400">
                    暂无文字描述
                    {detail.descriptionHtml.includes("<video") ? "（包含视频，见资源）" : ""}
                  </div>
                )}
                {detail.descriptionHtml.includes("<img") ||
                detail.descriptionHtml.includes("<video") ? (
                  <p className="mt-2 text-ui-sm text-slate-400">
                    描述中包含内嵌图片/视频，已在下方「资源」列出；导出 MD 时会下载到 assets 目录。
                  </p>
                ) : null}
              </section>

              <BugResources
                open={open}
                detail={detail}
                previewOpenRef={previewOpenRef}
                onOpenMedia={onOpenMedia}
              />

              <BugComments comments={detail.comments} />

              <BugChanges detail={detail} open={open} />

              <BugCustomFields detail={detail} open={open} />

              <BugCommentComposer
                mine={mine}
                busy={busy}
                text={commentText}
                onChange={setCommentText}
                onSubmit={() => void submitComment()}
              />
            </div>
          ) : null}
        </div>

        {detail ? (
          <BugDrawerFooter
            detail={detail}
            mine={mine}
            busy={busy}
            exporting={exporting}
            loading={loading}
            lastExport={lastExport}
            agentInfo={agentInfo}
            onOpenPath={onOpenPath}
            onCopy={onCopy}
            onClaim={() => void runClaim()}
            onAgentFix={onAgentFix}
            onAgentCompose={onAgentCompose}
            onOpenAgentTask={onOpenAgentTask}
            onExport={onExport}
          />
        ) : null}
    </aside>
  );
}

/** Memoized: the pane is large and only changes when its own props change. */
export const BugDetailDrawer = memo(BugDetailDrawerImpl);

/**
 * Placeholder that mirrors the panel's loaded layout (meta grid, description,
 * resources, comments) so content does not jump into place.
 */
function DetailSkeleton() {
  return (
    <div role="status" aria-busy="true" className="space-y-5">
      <span className="sr-only">正在加载缺陷详情</span>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-slate-100 bg-surface p-3 sm:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="space-y-1.5">
            <SkeletonBlock className="h-2.5 w-10" />
            <SkeletonBlock className="h-3 w-16" />
          </div>
        ))}
      </div>

      <div>
        <SkeletonBlock className="h-3 w-16" />
        <div className="mt-2 space-y-2 rounded-xl border border-slate-100 bg-slate-50/70 p-4">
          <SkeletonBlock className="h-3 w-full" />
          <SkeletonBlock className="h-3 w-11/12" />
          <SkeletonBlock className="h-3 w-2/3" />
        </div>
      </div>

      <div>
        <SkeletonBlock className="h-3 w-20" />
        <div className="mt-2 flex items-center gap-3 rounded-xl border border-slate-100 bg-surface p-3">
          <SkeletonBlock className="h-10 w-10 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <SkeletonBlock className="h-3 w-1/2" />
            <SkeletonBlock className="h-2.5 w-1/4" />
          </div>
          <SkeletonBlock className="h-6 w-14 shrink-0 rounded-md" />
        </div>
      </div>

      <div>
        <SkeletonBlock className="h-3 w-16" />
        <div className="mt-2 space-y-2 rounded-xl border border-slate-100 bg-surface p-3">
          <div className="flex items-center gap-2">
            <SkeletonBlock className="h-5 w-5 rounded-full" />
            <SkeletonBlock className="h-2.5 w-16" />
            <SkeletonBlock className="h-2.5 w-24" />
          </div>
          <SkeletonBlock className="h-3 w-full" />
          <SkeletonBlock className="h-3 w-4/5" />
        </div>
      </div>
    </div>
  );
}

function currentFieldValue(detail: BugDetail, field: string): string {
  return (field === "de" ? detail.de : detail.owner).trim();
}
