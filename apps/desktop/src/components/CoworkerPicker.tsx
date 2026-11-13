import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { Check, Coffee, RefreshCw } from "lucide-react";

import { coworkerApi, type Coworker } from "../lib/coworker";
import { t } from "../lib/i18n";
import { Avatar } from "./Avatar";
import { Button, EmptyState, Spinner } from "./ui";

type Toast = (kind: "ok" | "error", text: string) => void;

const ROLE_ACCENTS: Array<[RegExp, string]> = [
  [/产品|需求|product/i, "#d97706"],
  [/设计|交互|视觉|design|ui|ux/i, "#8b5cf6"],
  [/测试|质量|qa|test/i, "#10b981"],
  [/程序|开发|工程|engineer|dev/i, "#0ea5e9"],
];

function accentOf(coworker: Coworker): string {
  if (coworker.accent) return coworker.accent;
  return (
    ROLE_ACCENTS.find(([pattern]) => pattern.test(coworker.role))?.[1] ?? "#64748b"
  );
}

/**
 * Loads the coworker packages and keeps the enabled set in sync with the
 * backend. Selection applies immediately, so both the 同事 page and the
 * onboarding step can share it without a save button.
 */
export function useCoworkers(toast: Toast) {
  const [coworkers, setCoworkers] = useState<Coworker[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [promptSection, setPromptSection] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await coworkerApi.list();
      setCoworkers(result.coworkers);
      setSelectedIds(result.selectedIds);
      setPromptSection(result.promptSection);
      setWarnings(result.warnings);
    } catch (error) {
      setCoworkers([]);
      setLoadError(String(error));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const commit = async (next: string[]) => {
    const previous = selectedIds;
    setSelectedIds(next);
    setBusy(true);
    try {
      const saved = await coworkerApi.select(next);
      setSelectedIds(saved.selectedIds);
      setPromptSection(saved.promptSection);
    } catch (error) {
      setSelectedIds(previous);
      toast("error", String(error));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => {
    if (busy) return;
    const next = selectedIds.includes(id)
      ? selectedIds.filter((selected) => selected !== id)
      : [...selectedIds, id];
    void commit(next);
  };

  const selected = (coworkers ?? []).filter((coworker) =>
    selectedIds.includes(coworker.id),
  );

  return {
    coworkers,
    selectedIds,
    selected,
    promptSection,
    warnings,
    loadError,
    busy,
    reload,
    toggle,
    clear: () => void commit([]),
  };
}

/** Shared grid: loading, empty, error and the selectable coworker cards. */
export function CoworkerGrid(props: {
  coworkers: Coworker[] | null;
  selectedIds: string[];
  busy: boolean;
  loadError: string | null;
  onRetry: () => void;
  onToggle: (id: string) => void;
  className?: string;
}) {
  const { coworkers, selectedIds, busy, loadError, onRetry, onToggle } = props;

  if (loadError) {
    return (
      <div className="rounded-xl border border-rose-100 bg-rose-50 p-4 text-ui-caption text-rose-700">
        <div className="break-all">{loadError}</div>
        <Button
          size="sm"
          className="mt-3"
          onClick={onRetry}
          icon={<RefreshCw size={13} />}
        >
          {t("coworker.reload")}
        </Button>
      </div>
    );
  }

  if (coworkers === null) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-ui-caption text-slate-400">
        <Spinner />
        {t("coworker.loading")}
      </div>
    );
  }

  if (coworkers.length === 0) {
    return (
      <EmptyState
        icon={<Coffee size={18} />}
        title={t("coworker.emptyTitle")}
        description={t("coworker.emptyHint")}
      />
    );
  }

  return (
    <div className={clsx("grid gap-3 sm:grid-cols-2 xl:grid-cols-3", props.className)}>
      {coworkers.map((coworker, index) => (
        <CoworkerCard
          key={coworker.id}
          coworker={coworker}
          selected={selectedIds.includes(coworker.id)}
          disabled={busy}
          index={index}
          onToggle={() => onToggle(coworker.id)}
        />
      ))}
    </div>
  );
}

function CoworkerCard(props: {
  coworker: Coworker;
  selected: boolean;
  disabled: boolean;
  index: number;
  onToggle: () => void;
}) {
  const { coworker, selected, disabled, index } = props;
  const accent = accentOf(coworker);
  const hiddenSkills = coworker.skills.length - 3;

  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={props.onToggle}
      style={{
        borderColor: selected ? accent : undefined,
        backgroundColor: selected ? `${accent}0d` : undefined,
        animationDelay: `${Math.min(index, 8) * 35}ms`,
      }}
      className={clsx(
        "coworker-card group relative flex flex-col rounded-2xl border-2 p-4 text-left transition duration-200",
        "active:scale-[0.99] disabled:cursor-default",
        selected
          ? ""
          : "border-border bg-surface hover:-translate-y-0.5 hover:border-slate-300",
      )}
    >
      {selected ? (
        <span
          className="absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-full text-white"
          style={{ backgroundColor: accent }}
        >
          <Check size={11} strokeWidth={3} />
        </span>
      ) : null}

      <div className="flex items-start gap-3 pr-5">
        <span
          className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-105"
          style={{ backgroundColor: `${accent}16` }}
        >
          <Avatar
            src={coworker.avatar}
            name={coworker.name}
            className="h-12 w-12 text-ui-lg"
            rounded="rounded-xl"
          />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="truncate text-ui-base text-slate-900">
              {coworker.name}
            </span>
            <span
              className="shrink-0 rounded-full px-1.5 py-0.5 text-ui-2xs"
              style={{ color: accent, backgroundColor: `${accent}16` }}
            >
              {coworker.role}
            </span>
          </div>
          {coworker.title ? (
            <div className="mt-0.5 truncate text-ui-xs text-slate-400">
              {coworker.title}
            </div>
          ) : null}
        </div>
      </div>

      <p
        className="mt-3 line-clamp-2 text-ui-sm leading-5 text-slate-600"
        title={coworker.description}
      >
        {coworker.description}
      </p>

      <div className="mt-auto flex flex-wrap items-center gap-1 pt-3">
        {coworker.skills.slice(0, 3).map((skill) => (
          <span
            key={skill.path}
            title={skill.description || skill.path}
            className="max-w-[140px] truncate rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-ui-2xs text-slate-500"
          >
            {skill.name}
          </span>
        ))}
        {hiddenSkills > 0 ? (
          <span className="rounded-full border border-slate-200 px-2 py-0.5 text-ui-2xs text-slate-400">
            +{hiddenSkills}
          </span>
        ) : null}
        {coworker.skills.length === 0 ? (
          <span className="text-ui-2xs text-slate-300">{t("coworker.noSkills")}</span>
        ) : null}
        <span
          className="ml-auto text-ui-2xs"
          style={{ color: selected ? accent : undefined }}
        >
          {selected ? t("coworker.joined") : t("coworker.join")}
        </span>
      </div>
    </button>
  );
}
