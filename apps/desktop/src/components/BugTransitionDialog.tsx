import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import clsx from "clsx";
import { GitBranch } from "lucide-react";

import {
  api,
  type BugDetail,
  type BugTransitionField,
  type BugTransitionForm,
  type WorkspaceMember,
} from "../lib/api";
import { Dialog } from "./Dialog";
import { Button, Spinner, inputClass, selectClass } from "./ui";

type Props = {
  detail: BugDetail;
  status: string;
  label: string;
  members: WorkspaceMember[];
  membersLoading: boolean;
  busy: boolean;
  onClose: () => void;
  onRefreshMembers: () => void;
  onSubmit: (status: string, fields: Record<string, string>) => Promise<void>;
};

/** Person fields that may hold several names in one string. */
const MULTI_USER_FIELDS = new Set(["cc", "participator", "follower"]);

/**
 * Collects the workflow fields a transition requires (状态 / 处理人 / 备注 …)
 * and submits them with the transition. Opened from the detail pane's status
 * buttons so the pane itself stays on the bug while the dialog is up.
 */
export function BugTransitionDialog(props: Props) {
  const {
    detail,
    status,
    label,
    members,
    membersLoading,
    busy,
    onClose,
    onRefreshMembers,
    onSubmit,
  } = props;

  const [form, setForm] = useState<BugTransitionForm | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by 重试 to re-run the fetch effect after a failure. */
  const [attempt, setAttempt] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let cancelled = false;
    // Drop the previous status's form first: a failed re-fetch must not leave
    // its fields submittable.
    setForm(null);
    setValues({});
    setLoading(true);
    setError(null);
    void api
      .bugTransitionForm(detail.workspaceId, detail.id, status)
      .then((next) => {
        if (cancelled) return;
        setForm(next);
        setValues(
          Object.fromEntries(
            next.fields.map((field) => [field.name, field.value]),
          ),
        );
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detail.workspaceId, detail.id, detail.status, status, attempt]);

  // Keep focus out of the background status buttons when the form appears.
  useEffect(() => {
    if (!form || loading) return;
    const root = formRef.current;
    if (!root) return;
    const control = root.querySelector<HTMLElement>("textarea, select, input");
    (control ?? root.querySelector<HTMLElement>("button"))?.focus();
  }, [form, loading]);

  // Escape closes this dialog, not the drawer behind it. The drawer's own
  // handler stands down while a transition target is set.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [busy, onClose]);

  const close = () => {
    if (!busy) onClose();
  };

  // The backend leaves this field out of the payload; it is never shown or
  // submitted.
  const visibleFields = form
    ? form.fields.filter((field) => field.name !== "enable_add_timesheet")
    : [];

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form || busy) return;

    const missing = visibleFields.filter(
      (field) =>
        field.required && !field.disabled && !(values[field.name] ?? "").trim(),
    );
    if (missing.length > 0) {
      setError(
        `请填写：${missing
          .map((field) => field.label || field.name)
          .join("、")}`,
      );
      return;
    }

    setError(null);
    // Disabled fields are omitted: the backend keeps their workflow defaults.
    const fields: Record<string, string> = {};
    for (const field of visibleFields) {
      if (field.disabled) continue;
      fields[field.name] = values[field.name] ?? "";
    }
    try {
      await onSubmit(form.status, fields);
    } catch (cause) {
      // Keep the dialog open so the values can be corrected and retried.
      setError(String(cause));
    }
  };

  return (
    <Dialog
      title={`流转到「${form?.label ?? label}」`}
      icon={<GitBranch size={16} className="text-slate-400" />}
      onClose={close}
      bodyScroll={false}
    >
      <form
        ref={formRef}
        onSubmit={(event) => void handleSubmit(event)}
        className="flex h-full min-h-0 flex-col"
      >
        <p className="shrink-0 text-ui-caption leading-5 text-slate-500">
          按工作流填写本次流转字段。
        </p>

        <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-ui-caption text-slate-400">
              <Spinner />
              正在读取流转表单…
            </div>
          ) : form ? (
            <div className="space-y-3">
              {error ? <TransitionError text={error} /> : null}
              {visibleFields.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-4 text-ui-caption text-slate-400">
                  本次流转无需填写字段。
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {visibleFields.map((field) => (
                    <TransitionField
                      key={field.name}
                      field={field}
                      value={values[field.name] ?? ""}
                      busy={busy}
                      members={members}
                      membersLoading={membersLoading}
                      onChange={(value) => {
                        // Editing dismisses a stale "请填写：…" message.
                        setError(null);
                        setValues((current) => ({
                          ...current,
                          [field.name]: value,
                        }));
                      }}
                      onRefreshMembers={onRefreshMembers}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : error ? (
            <div className="space-y-2">
              <TransitionError text={error} />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setAttempt((value) => value + 1)}
              >
                重试
              </Button>
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 pt-3">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            loading={busy}
            disabled={loading || !form}
          >
            确认流转
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function TransitionError({ text }: { text: string }) {
  return (
    <div className="break-all rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-ui-caption leading-5 text-rose-700">
      {text}
    </div>
  );
}

/** One workflow field, rendered by its TAPD `htmlType`. */
function TransitionField(props: {
  field: BugTransitionField;
  value: string;
  busy: boolean;
  members: WorkspaceMember[];
  membersLoading: boolean;
  onChange: (value: string) => void;
  onRefreshMembers: () => void;
}) {
  const { field, value, busy, members, membersLoading, onChange, onRefreshMembers } =
    props;
  const htmlType = field.htmlType.toLowerCase();
  const disabled = busy || field.disabled;

  return (
    <label
      className={clsx(
        "block min-w-0",
        htmlType === "textarea" && "sm:col-span-2",
      )}
    >
      <span className="mb-1 flex flex-wrap items-center gap-x-1 text-ui-xs text-slate-500">
        <span className="min-w-0 break-words">{field.label || field.name}</span>
        {field.required ? <span className="text-rose-500">*</span> : null}
        {field.disabled ? (
          <span className="rounded bg-slate-100 px-1 py-0.5 text-ui-2xs text-slate-400">
            只读
          </span>
        ) : null}
      </span>

      {field.disabled ? (
        // Read-only workflow fields are shown, never submitted.
        <div className="select-text whitespace-pre-wrap break-words rounded-lg border border-border bg-slate-50 px-2.5 py-1.5 text-ui-caption text-slate-500">
          {value.trim() || "—"}
        </div>
      ) : htmlType === "user_chooser" ? (
        <UserChooserField
          field={field}
          value={value}
          disabled={disabled}
          members={members}
          membersLoading={membersLoading}
          onChange={onChange}
          onRefreshMembers={onRefreshMembers}
        />
      ) : htmlType === "multi_select" || htmlType === "checkbox" ? (
        <select
          multiple
          value={splitMulti(value)}
          disabled={disabled}
          onChange={(event) => {
            const next = Array.from(
              event.target.selectedOptions,
              (option) => option.value,
            );
            onChange(next.join("|"));
          }}
          className={clsx(selectClass, "w-full")}
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label || option.value}
            </option>
          ))}
          {splitMulti(value)
            .filter(
              (selected) =>
                !field.options.some((option) => option.value === selected),
            )
            .map((selected) => (
              <option key={selected} value={selected}>
                {selected}
              </option>
            ))}
        </select>
      ) : htmlType === "select" || htmlType === "radio" ? (
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={clsx(selectClass, "w-full")}
        >
          <option value="">{field.required ? "请选择" : "未选择"}</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label || option.value}
            </option>
          ))}
          {value && !field.options.some((option) => option.value === value) ? (
            <option value={value}>{value}</option>
          ) : null}
        </select>
      ) : htmlType === "textarea" ? (
        <textarea
          rows={3}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={clsx(inputClass, "resize-y")}
        />
      ) : (
        <input
          type="text"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={inputClass}
        />
      )}
    </label>
  );
}

/**
 * Single person picker backed by the workspace member directory. Fields that
 * may hold several people (抄送 / 参与人 / 关注者) stay free text.
 */
function UserChooserField(props: {
  field: BugTransitionField;
  value: string;
  disabled: boolean;
  members: WorkspaceMember[];
  membersLoading: boolean;
  onChange: (value: string) => void;
  onRefreshMembers: () => void;
}) {
  const { field, value, disabled, members, membersLoading, onChange } = props;
  // Backend defaults arrive `昵称;` even for a single person, so parse first.
  const names = value
    .split(/[;,|]/)
    .map((name) => name.trim())
    .filter(Boolean);
  const multiple = MULTI_USER_FIELDS.has(field.name) || names.length > 1;

  if (multiple) {
    return (
      <input
        type="text"
        value={value}
        disabled={disabled}
        placeholder="多个成员用 ; 分隔"
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      />
    );
  }

  const current = names[0] ?? "";
  // Keep a current value that is not in the directory selectable.
  const nicks = Array.from(
    new Set([
      ...members.map((member) => member.nick).filter(Boolean),
      ...(current ? [current] : []),
    ]),
  );

  return (
    <select
      value={current}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      onFocus={() => {
        if (members.length === 0 && !membersLoading) props.onRefreshMembers();
      }}
      className={clsx(selectClass, "w-full")}
    >
      <option value="">{field.required ? "请选择" : "未选择"}</option>
      {nicks.map((nick) => (
        <option key={nick} value={nick}>
          {nick}
        </option>
      ))}
    </select>
  );
}

/** `multi_select` / `checkbox` values arrive `;`-separated; we send `|`. */
function splitMulti(value: string): string[] {
  return value
    .split(/[;,|]/)
    .map((part) => part.trim())
    .filter(Boolean);
}
