import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  GitBranch,
  Link2,
  LoaderCircle,
  MessageSquare,
  UserPlus,
} from "lucide-react";

import {
  api,
  asApiError,
  type BugDetail,
  type BugTransitionInfo,
  type Comment,
} from "../lib/api";
import { copyText } from "../lib/clipboard";
import { absoluteTime, bugRef, bugTitle, ownerNames, relativeTime } from "../lib/format";
import {
  bugDetailKey,
  cached,
  invalidateBug,
  STATE_KEY,
  subscribeCache,
  transitionsKey,
  TTL,
} from "../lib/reqCache";
import { navigate } from "../lib/router";
import { sanitizeRichHtml } from "../lib/rich";
import { Badge, PriorityDot, STATUS_TONES } from "../components/Badge";
import { BottomSheet } from "../components/BottomSheet";

function InfoRow(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-b-0">
      <span className="shrink-0 text-ui-xs text-slate-500">{props.label}</span>
      <span className="min-w-0 truncate text-right text-ui-caption text-slate-700">
        {props.children}
      </span>
    </div>
  );
}

/** One comment plus its replies, indented one border per level. */
function CommentCard(props: { comment: Comment; depth: number }) {
  const { comment, depth } = props;
  return (
    <div className={depth > 0 ? "mt-2 ml-3 border-l border-border pl-3" : "mt-3"}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-ui-caption text-slate-900">{comment.author}</span>
        <span className="shrink-0 text-ui-xs text-slate-400">
          {relativeTime(comment.created)}
        </span>
      </div>
      {comment.isDeleted ? (
        <p className="mt-1 text-ui-caption text-slate-400">已删除</p>
      ) : comment.descriptionHtml.trim() ? (
        <div
          className="rich mt-1 text-ui-caption leading-6 text-slate-700"
          dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(comment.descriptionHtml) }}
        />
      ) : comment.plainText.trim() ? (
        <p className="mt-1 text-ui-caption leading-6 text-slate-700">{comment.plainText}</p>
      ) : null}
      {comment.replies.map((reply) => (
        <CommentCard key={reply.id} comment={reply} depth={depth + 1} />
      ))}
    </div>
  );
}

function ActionButton(props: {
  icon: ReactNode;
  label: string;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled || props.busy}
      onClick={props.onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-50"
    >
      {props.busy ? (
        <LoaderCircle size={13} className="animate-spin text-slate-400" />
      ) : (
        <span className="text-slate-400">{props.icon}</span>
      )}
      {props.label}
    </button>
  );
}

function DetailSkeleton() {
  return (
    <div className="p-3">
      <div className="h-5 w-4/5 animate-pulse rounded bg-overlay-soft" />
      <div className="mt-3 h-32 animate-pulse rounded-2xl bg-overlay-soft" />
      <div className="mt-3 h-40 animate-pulse rounded-2xl bg-overlay-soft" />
    </div>
  );
}

/** Bug detail: info grid, actions (copy link / claim / transition / comment), description, comments. */
export function BugDetailPage(props: { id: string; workspaceId: string | null }) {
  const { id, workspaceId } = props;
  const [detail, setDetail] = useState<BugDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 当前账号 nick；undefined = 还没读到桌面状态（认领按钮等它再出现）。
  const [me, setMe] = useState<string | null | undefined>(undefined);

  const [copied, setCopied] = useState(false);
  const [claimBusy, setClaimBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [transitionsOpen, setTransitionsOpen] = useState(false);
  const [transitions, setTransitions] = useState<BugTransitionInfo | null>(null);
  const [transitionsError, setTransitionsError] = useState<string | null>(null);
  const [transitionBusy, setTransitionBusy] = useState<string | null>(null);
  const [transitionError, setTransitionError] = useState<string | null>(null);

  const [commentOpen, setCommentOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);

  const cacheKey = workspaceId ? bugDetailKey(workspaceId, id) : null;

  // 详情读取走 reqCache：TTL 60s，过期后台刷新先回旧值；换 bug 时清掉旧数据。
  useEffect(() => {
    if (!workspaceId || !cacheKey) {
      setError("缺少工作区参数，请从列表进入");
      setLoading(false);
      return;
    }
    setDetail(null);
    setError(null);
    setActionError(null);
    let cancelled = false;
    const load = (quiet: boolean) => {
      if (!quiet) setLoading(true);
      void cached(cacheKey, TTL.bugDetail, () => api.bug(workspaceId, id))
        .then((data) => {
          if (!cancelled) {
            setDetail(data);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(asApiError(err).message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load(false);
    const off = subscribeCache(cacheKey, () => load(true));
    return () => {
      cancelled = true;
      off();
    };
  }, [cacheKey, workspaceId, id]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void cached(STATE_KEY, TTL.state, api.state)
        .then((state) => {
          if (!cancelled) setMe(state.me);
        })
        .catch(() => {
          // 掉线由全局 gate 呈现。
        });
    };
    load();
    const off = subscribeCache(STATE_KEY, load);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // 状态流转 sheet 打开时读取可流转状态（reqCache TTL 60s）。
  useEffect(() => {
    if (!transitionsOpen || !workspaceId) return;
    let cancelled = false;
    const key = transitionsKey(workspaceId, id);
    const load = () => {
      void cached(key, TTL.transitions, () => api.bugTransitions(workspaceId, id))
        .then((data) => {
          if (!cancelled) {
            setTransitions(data);
            setTransitionsError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setTransitionsError(asApiError(err).message);
        });
    };
    load();
    const off = subscribeCache(key, load);
    return () => {
      cancelled = true;
      off();
    };
  }, [transitionsOpen, workspaceId, id]);

  const back = () => {
    if (window.history.length > 1) window.history.back();
    else navigate("#/bugs");
  };

  const copyLink = async () => {
    if (!detail?.bugUrl) return;
    setActionError(null);
    const ok = await copyText(detail.bugUrl);
    if (!ok) {
      setActionError("复制失败，请手动复制");
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  // 写操作成功后失效详情与该项目列表缓存：订阅的读取会立即回源。
  const afterWrite = () => {
    if (!workspaceId || !detail) return;
    invalidateBug(workspaceId, detail.id);
  };

  const claim = async () => {
    if (!workspaceId || !detail || claimBusy) return;
    setClaimBusy(true);
    setActionError(null);
    try {
      await api.bugClaim(workspaceId, detail.id);
      afterWrite();
    } catch (err) {
      setActionError(asApiError(err).message);
    } finally {
      setClaimBusy(false);
    }
  };

  const doTransition = async (status: string) => {
    if (!workspaceId || !detail || transitionBusy) return;
    setTransitionBusy(status);
    setTransitionError(null);
    try {
      await api.bugTransition(workspaceId, detail.id, status);
      afterWrite();
      setTransitionsOpen(false);
    } catch (err) {
      setTransitionError(asApiError(err).message);
    } finally {
      setTransitionBusy(null);
    }
  };

  const submitComment = async () => {
    const text = commentDraft.trim();
    if (!workspaceId || !detail || !text || commentBusy) return;
    setCommentBusy(true);
    setActionError(null);
    try {
      await api.bugAddComment(workspaceId, detail.id, text);
      setCommentDraft("");
      setCommentOpen(false);
      afterWrite();
    } catch (err) {
      setActionError(asApiError(err).message);
    } finally {
      setCommentBusy(false);
    }
  };

  const ownerList = detail ? ownerNames(detail.owner) : [];
  const showClaim = typeof me === "string" && !ownerList.includes(me);
  const canCopy = Boolean(detail?.bugUrl);

  return (
    <div>
      <header className="sticky top-0 z-20 flex items-center gap-1.5 border-b border-border bg-canvas px-2 py-2">
        <button
          type="button"
          aria-label="返回"
          onClick={back}
          className="rounded-md p-1.5 text-slate-500 transition active:bg-overlay-soft"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="min-w-0 flex-1 truncate text-ui-caption text-slate-500">
          {detail ? `#${bugRef(detail)}` : "缺陷详情"}
        </span>
      </header>

      {loading && !detail ? <DetailSkeleton /> : null}

      {!loading && error && !detail ? (
        <p className="px-4 py-3 text-ui-caption text-rose-600">{error}</p>
      ) : null}

      {!loading && detail ? (
        <div className="pb-6">
          <h1 className="px-4 pt-3 text-ui-base leading-6 text-slate-900">
            {bugTitle(detail.title)}
          </h1>

          <section className="mx-3 mt-3 rounded-2xl border border-border bg-surface px-4 py-1">
            <InfoRow label="状态">
              <Badge tone={STATUS_TONES[detail.status] ?? "neutral"}>
                {detail.statusLabel || detail.status}
              </Badge>
            </InfoRow>
            <InfoRow label="优先级">
              <span className="inline-flex items-center gap-1.5">
                <PriorityDot priority={detail.priority} />
                {detail.priorityLabel || detail.priority || "—"}
              </span>
            </InfoRow>
            <InfoRow label="严重程度">{detail.severityLabel || detail.severity || "—"}</InfoRow>
            <InfoRow label="处理人">{ownerNames(detail.owner)[0] || "未指派"}</InfoRow>
            <InfoRow label="创建人">{detail.creator || "—"}</InfoRow>
            <InfoRow label="创建">{absoluteTime(detail.created)}</InfoRow>
            <InfoRow label="更新">{relativeTime(detail.modified)}</InfoRow>
          </section>

          <section className="mx-3 mt-3 flex flex-wrap items-center gap-2">
            <ActionButton
              icon={<Link2 size={13} />}
              label={copied ? "已复制" : "复制链接"}
              disabled={!canCopy}
              onClick={() => void copyLink()}
            />
            {showClaim ? (
              <ActionButton
                icon={<UserPlus size={13} />}
                label="认领"
                busy={claimBusy}
                onClick={() => void claim()}
              />
            ) : null}
            <ActionButton
              icon={<GitBranch size={13} />}
              label="状态流转"
              onClick={() => {
                setTransitionError(null);
                setTransitionsOpen(true);
              }}
            />
            <ActionButton
              icon={<MessageSquare size={13} />}
              label="评论"
              onClick={() => setCommentOpen(true)}
            />
            {actionError ? (
              <p
                className="w-full text-ui-sm text-rose-600"
                title="上一次操作失败的结果，重试成功后消失。"
              >
                {actionError}
              </p>
            ) : null}
          </section>

          <section className="mx-3 mt-3 rounded-2xl border border-border bg-surface p-4">
            <h2 className="text-ui-sm text-slate-500">描述</h2>
            {detail.descriptionHtml.trim() ? (
              <div
                className="rich mt-2 text-ui-caption leading-6 text-slate-700"
                dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(detail.descriptionHtml) }}
              />
            ) : (
              <p className="mt-2 text-ui-caption text-slate-400">暂无描述</p>
            )}
          </section>

          <section className="mx-3 mt-3 rounded-2xl border border-border bg-surface p-4">
            <h2 className="text-ui-sm text-slate-500">评论（{detail.comments.length}）</h2>
            {detail.comments.length === 0 ? (
              <p className="mt-2 text-ui-caption text-slate-400">还没有评论</p>
            ) : (
              detail.comments.map((comment) => (
                <CommentCard key={comment.id} comment={comment} depth={0} />
              ))
            )}
          </section>
        </div>
      ) : null}

      {/* -- 状态流转 sheet：可流转状态列表，点选即流转 ------------------- */}
      <BottomSheet
        open={transitionsOpen}
        title="状态流转"
        onClose={() => setTransitionsOpen(false)}
      >
        {transitions ? (
          <p
            className="text-ui-sm text-slate-500"
            title={`当前状态 ${transitions.currentLabel || transitions.currentStatus}`}
          >
            当前：{transitions.currentLabel || transitions.currentStatus}
          </p>
        ) : null}
        {transitionsError ? (
          <p
            className="mt-3 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700"
            title="刷新失败；关闭后重开会重试。"
          >
            {transitionsError}
          </p>
        ) : null}
        {!transitions && !transitionsError ? (
          <div className="flex items-center justify-center gap-2 py-8 text-ui-caption text-slate-400">
            <LoaderCircle size={14} className="animate-spin" />
            正在读取可流转状态…
          </div>
        ) : null}
        {transitions ? (
          <div className="mt-3 space-y-2">
            {transitions.transitions.length === 0 ? (
              <p className="py-2 text-ui-caption text-slate-400" title="当前状态下没有可流转的目标。">
                没有可流转的状态
              </p>
            ) : null}
            {transitions.transitions.map((choice) => (
              <button
                key={choice.key}
                type="button"
                disabled={transitionBusy !== null}
                onClick={() => void doTransition(choice.key)}
                className="flex w-full items-center justify-between rounded-lg border border-border bg-surface px-3 py-2.5 text-left text-ui-caption text-slate-700 transition active:bg-overlay-soft disabled:opacity-50"
              >
                <span>{choice.label}</span>
                {transitionBusy === choice.key ? (
                  <LoaderCircle size={13} className="animate-spin text-slate-400" />
                ) : null}
              </button>
            ))}
            {transitionError ? (
              <p
                className="rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700"
                title="流转失败，表单保留可重试。"
              >
                {transitionError}
              </p>
            ) : null}
          </div>
        ) : null}
      </BottomSheet>

      {/* -- 评论 sheet：textarea + 发送 ---------------------------------- */}
      <BottomSheet
        open={commentOpen}
        title="评论"
        onClose={() => setCommentOpen(false)}
        footer={
          <button
            type="button"
            disabled={commentBusy || !commentDraft.trim()}
            onClick={() => void submitComment()}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-ui-sm text-primary-foreground transition active:bg-primary-hover disabled:opacity-50"
          >
            {commentBusy ? <LoaderCircle size={13} className="animate-spin" /> : null}
            {commentBusy ? "正在发送…" : "发送"}
          </button>
        }
      >
        <textarea
          value={commentDraft}
          onChange={(event) => setCommentDraft(event.target.value)}
          rows={5}
          autoFocus
          placeholder="写下评论…"
          className="w-full resize-none rounded-lg border border-border bg-surface px-2.5 py-2 text-ui-caption leading-5 text-slate-700 transition placeholder:text-slate-400 focus:border-sky-300 focus:outline-2 focus:outline-sky-200"
        />
      </BottomSheet>
    </div>
  );
}
