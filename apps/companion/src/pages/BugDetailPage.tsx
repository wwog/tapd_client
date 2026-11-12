import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft } from "lucide-react";

import { api, asApiError, type BugDetail, type Comment } from "../lib/api";
import { absoluteTime, bugRef, bugTitle, ownerNames, relativeTime } from "../lib/format";
import { navigate } from "../lib/router";
import { sanitizeRichHtml } from "../lib/rich";
import { Badge, PriorityDot, STATUS_TONES } from "../components/Badge";

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

function DetailSkeleton() {
  return (
    <div className="p-3">
      <div className="h-5 w-4/5 animate-pulse rounded bg-overlay-soft" />
      <div className="mt-3 h-32 animate-pulse rounded-2xl bg-overlay-soft" />
      <div className="mt-3 h-40 animate-pulse rounded-2xl bg-overlay-soft" />
    </div>
  );
}

/** Bug detail: info grid, sanitized description, comments. */
export function BugDetailPage(props: { id: string; workspaceId: string | null }) {
  const { id, workspaceId } = props;
  const [detail, setDetail] = useState<BugDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setError("缺少工作区参数，请从列表进入");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const data = await api.bug(workspaceId, id);
        if (!cancelled) setDetail(data);
      } catch (err) {
        if (!cancelled) setError(asApiError(err).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, workspaceId]);

  const back = () => {
    if (window.history.length > 1) window.history.back();
    else navigate("#/bugs");
  };

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

      {loading ? <DetailSkeleton /> : null}

      {!loading && error ? (
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
    </div>
  );
}
