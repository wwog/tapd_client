import { CalendarClock, MessageSquare, MessageSquarePlus, Send } from "lucide-react";
import clsx from "clsx";

import type { Comment } from "../lib/api";
import { t } from "../lib/i18n";
import { BugSectionTitle } from "./BugSectionTitle";
import { Badge, Button } from "./ui";

/** Comments and their replies, in TAPD's order. */
export function BugComments(props: { comments: Comment[] }) {
  const { comments } = props;

  return (
    <section>
      <BugSectionTitle
        icon={<MessageSquare size={14} />}
        title={t("bugs.commentsCount", { count: countComments(comments) })}
      />
      <div className="mt-2 space-y-3">
        {comments.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-3 text-ui-caption text-slate-400">
            {t("bugs.noComments")}
          </div>
        ) : (
          comments.map((comment) => (
            <CommentItem key={comment.id} comment={comment} depth={0} />
          ))
        )}
      </div>
    </section>
  );
}

/** New top-level comment box; any project member can post, claimed or not. */
export function BugCommentComposer(props: {
  busy: string | null;
  text: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  const { busy, text, onChange, onSubmit } = props;

  return (
    <section>
      <BugSectionTitle
        icon={<MessageSquarePlus size={14} />}
        title={t("bugs.addComment")}
      />
      <textarea
        value={text}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onSubmit();
          }
        }}
        rows={4}
        placeholder={t("bugs.commentPlaceholder")}
        className="mt-2 w-full resize-y rounded-xl border border-border bg-surface p-3 text-ui-caption leading-6 text-slate-700 transition focus:border-sky-400 focus:outline-2 focus:outline-sky-200"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="mr-auto text-ui-xs text-slate-400">
          {text.length > 0 ? t("bugs.commentChars", { count: text.length }) : ""}
        </span>
        <Button
          size="sm"
          variant="primary"
          icon={<Send size={13} />}
          loading={busy === "comment"}
          disabled={busy !== null || text.trim().length === 0}
          onClick={onSubmit}
        >
          {t("bugs.postComment")}
        </Button>
      </div>
    </section>
  );
}

function CommentItem(props: { comment: Comment; depth: number }) {
  const { comment, depth } = props;

  return (
    <div
      className={clsx(
        "rounded-xl border border-slate-100 bg-surface p-3",
        depth > 0 && "ml-5 border-l-2 border-l-slate-200",
      )}
    >
      <div className="flex items-center gap-2 text-ui-sm text-slate-400">
        <span className="grid h-5 w-5 place-items-center rounded-full bg-slate-100 text-ui-2xs text-slate-500">
          {comment.author ? comment.author.slice(-2) : "?"}
        </span>
        <span className="font-normal text-slate-600">
          {comment.author || t("common.unknown")}
        </span>
        <span className="inline-flex items-center gap-1">
          <CalendarClock size={10} />
          {comment.created}
        </span>
        {comment.isDeleted ? <Badge tone="red">{t("bugs.deleted")}</Badge> : null}
      </div>
      <p className="select-text mt-2 whitespace-pre-wrap break-words text-ui-caption leading-6 text-slate-700">
        {comment.plainText || t("bugs.emptyComment")}
      </p>
      {comment.replies.length > 0 ? (
        <div className="mt-2 space-y-2">
          {comment.replies.map((reply) => (
            <CommentItem key={reply.id} comment={reply} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function countComments(comments: Comment[]): number {
  return comments.reduce(
    (total, comment) => total + 1 + countComments(comment.replies),
    0,
  );
}
