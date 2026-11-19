import { useState } from "react";
import clsx from "clsx";

import { t } from "../lib/i18n";
import type { DshAnswer, DshQuestion } from "../lib/dsh";
import { Button, inputClass } from "../components/ui";
import { agentActions, type PendingQuestion } from "./store";

type Draft = { selected: string[]; custom: string };

const EMPTY: Draft = { selected: [], custom: "" };

/**
 * Multi-question ask card. One question per step with skip, custom text and a
 * back step; dismissing sends `answers: null` (never an empty approval).
 */
export function QuestionCard({ pending }: { pending: PendingQuestion }) {
  const questions = pending.questions;
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(questions.map((question) => [question.id, { ...EMPTY }])),
  );

  const question = questions[index];
  if (!question) return null;
  const draft = drafts[question.id] ?? EMPTY;
  const last = index === questions.length - 1;

  const patch = (id: string, next: Partial<Draft>) => {
    setDrafts((current) => ({
      ...current,
      [id]: { ...(current[id] ?? EMPTY), ...next },
    }));
  };

  const toggle = (target: DshQuestion, label: string) => {
    const selected = drafts[target.id]?.selected ?? [];
    const next = target.multiSelect
      ? selected.includes(label)
        ? selected.filter((item) => item !== label)
        : [...selected, label]
      : selected[0] === label
        ? []
        : [label];
    patch(target.id, { selected: next });
  };

  const answers = (skipped: string | null): DshAnswer[] =>
    questions.map((item) => {
      if (item.id === skipped) return { id: item.id, selected: [] };
      const value = drafts[item.id] ?? EMPTY;
      const custom = value.custom.trim();
      return {
        id: item.id,
        selected: value.selected,
        ...(custom ? { custom } : {}),
      };
    });

  const finish = (skipped: string | null = null) => {
    void agentActions.answerQuestion(pending.rpcId, answers(skipped));
  };

  const skip = () => {
    if (last) {
      finish(question.id);
      return;
    }
    patch(question.id, { selected: [], custom: "" });
    setIndex(index + 1);
  };

  return (
    <section data-component="QuestionCard" className="rounded-xl border border-border bg-surface px-3 py-2.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="shrink-0 text-ui-xs tabular-nums text-slate-400">
          {t("agent.question.step", { index: index + 1, total: questions.length })}
        </span>
        {question.header ? (
          <span className="min-w-0 truncate text-ui-xs text-slate-400">{question.header}</span>
        ) : null}
      </div>

      <div className="mt-1.5 break-words text-ui-caption text-slate-800 select-text">
        {question.question}
      </div>

      {question.detail ? (
        <details className="mt-1">
          <summary className="cursor-pointer select-none text-ui-xs text-slate-400">
            {t("common.details")}
          </summary>
          <pre className="mt-1 max-h-52 select-text overflow-auto whitespace-pre-wrap break-words font-mono text-ui-xs leading-5 text-slate-600">
            {question.detail}
          </pre>
        </details>
      ) : null}

      {question.options && question.options.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          {question.options.map((option) => {
            const active = draft.selected.includes(option.label);
            return (
              <button
                key={option.label}
                type="button"
                disabled={pending.busy}
                title={option.description}
                aria-pressed={active}
                onClick={() => toggle(question, option.label)}
                className={clsx(
                  "rounded-lg border px-2.5 py-1.5 text-left text-ui-caption transition disabled:cursor-default disabled:opacity-60",
                  active
                    ? "border-sky-200 bg-sky-50 text-sky-800"
                    : "border-border bg-surface text-slate-600 hover:border-slate-300",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : null}

      <input
        value={draft.custom}
        disabled={pending.busy}
        onChange={(event) => patch(question.id, { custom: event.target.value })}
        placeholder={t("agent.question.custom")}
        className={`${inputClass} mt-2`}
      />

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          disabled={pending.busy}
          title={t("agent.question.dismissHint")}
          onClick={() => void agentActions.answerQuestion(pending.rpcId, null)}
          className="rounded-lg px-1.5 py-1 text-ui-xs text-slate-400 transition hover:bg-overlay hover:text-slate-700 disabled:opacity-50"
        >
          {t("agent.question.dismiss")}
        </button>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" disabled={pending.busy} title={t("agent.question.skipHint")} onClick={skip}>
            {t("agent.question.skip")}
          </Button>
          {index > 0 ? (
            <Button size="sm" disabled={pending.busy} onClick={() => setIndex(index - 1)}>
              {t("common.back")}
            </Button>
          ) : null}
          {last ? (
            <Button size="sm" variant="primary" disabled={pending.busy} onClick={() => finish()}>
              {t("common.submit")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={pending.busy}
              onClick={() => setIndex(index + 1)}
            >
              {t("common.next")}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
