import {
  Ban,
  Check,
  CheckCheck,
  Copy,
  Loader2,
  ShieldAlert,
  Terminal,
} from "lucide-react";

import type {
  AgentRuntimeDescriptor,
  AgentTask,
  PermissionReply,
} from "../lib/agent";
import { Button } from "./ui";

type Props = {
  task: AgentTask;
  runtime: AgentRuntimeDescriptor | null;
  replyFallback: string | null;
  permissionBusy: PermissionReply | null;
  permissionOptionBusy: string | null;
  interactive: boolean;
  onPermission: (response: PermissionReply) => void;
  onPermissionOption: (optionId: string) => void;
  onFocusTerminal: () => void;
  onCopySession: () => void;
};

/** Amber strip that asks the human to answer the runtime's permission prompt. */
export function AgentPermissionBar(props: Props) {
  const {
    task,
    runtime,
    replyFallback,
    permissionBusy,
    permissionOptionBusy,
    interactive,
    onPermission,
    onPermissionOption,
    onFocusTerminal,
    onCopySession,
  } = props;

  const review = task.review;
  if (!review) return null;

  /** Capability says the desktop may not answer this runtime's prompts. */
  const runtimeBlocksDecision =
    runtime !== null && !runtime.capabilities.externalDecision;
  const decisionFallbackText = `${runtime?.name ?? "当前运行时"} 不接受桌面回执，该确认请直接在任务中处理。`;
  const reviewOptions = review.options ?? [];

  return (
    <div className="shrink-0 border-b border-amber-200/70 bg-amber-50/70 px-3.5 py-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <ShieldAlert size={14} className="shrink-0 text-amber-600" />
        <span className="shrink-0 text-ui-caption font-normal text-amber-900">
          Agent 请求权限
        </span>
        <span
          className="min-w-0 flex-1 truncate text-ui-sm text-amber-800"
          title={review.title}
        >
          {review.title}
        </span>
      </div>
      <div
        className="mt-1 truncate font-mono text-ui-xs text-amber-700/90"
        title={`${review.action} · ${review.resource}`}
      >
        {review.action} · {review.resource}
      </div>
      {replyFallback ? (
        <div
          className="mb-2 rounded-lg border border-rose-200 bg-surface/70 px-2.5 py-1.5 text-ui-sm leading-4 text-rose-700"
          title={replyFallback}
        >
          运行时没有接受这次回执，请重试或选择其他选项。
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {runtimeBlocksDecision ? (
          <>
            <span className="min-w-0 flex-1 text-ui-sm leading-4 text-amber-900">
              {decisionFallbackText}
            </span>
            {interactive ? (
              <Button
                size="sm"
                variant="secondary"
                icon={<Terminal size={12} />}
                onClick={onFocusTerminal}
              >
                去终端处理
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                icon={<Copy size={12} />}
                disabled={!task.sessionId}
                onClick={onCopySession}
              >
                复制会话 ID
              </Button>
            )}
          </>
        ) : reviewOptions.length > 0 ? (
          <>
            {reviewOptions.map((option) => {
              const rejecting = option.kind.startsWith("reject");
              const always = option.kind === "allow_always";
              const busy = permissionOptionBusy === option.optionId;
              return (
                <Button
                  key={option.optionId}
                  size="sm"
                  variant={
                    rejecting
                      ? "danger"
                      : always
                        ? "secondary"
                        : "primary"
                  }
                  icon={
                    busy ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : rejecting ? (
                      <Ban size={12} />
                    ) : always ? (
                      <CheckCheck size={12} />
                    ) : (
                      <Check size={12} />
                    )
                  }
                  disabled={
                    permissionOptionBusy !== null ||
                    permissionBusy !== null
                  }
                  onClick={() => onPermissionOption(option.optionId)}
                >
                  {option.name}
                </Button>
              );
            })}
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="primary"
              icon={
                permissionBusy === "once" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Check size={12} />
                )
              }
              disabled={permissionBusy !== null}
              onClick={() => onPermission("once")}
            >
              允许一次
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={
                permissionBusy === "always" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <CheckCheck size={12} />
                )
              }
              disabled={permissionBusy !== null}
              onClick={() => onPermission("always")}
            >
              总是允许
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={
                permissionBusy === "reject" ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Ban size={12} />
                )
              }
              disabled={permissionBusy !== null}
              onClick={() => onPermission("reject")}
            >
              拒绝
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
