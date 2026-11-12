import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { ArrowRight, Check, Coffee, GitBranch, RefreshCw, Sparkles, Users } from "lucide-react";

import { api } from "../lib/api";
import { coworkerApi, type Coworker } from "../lib/coworker";
import { COWORKER_FORK_URL, COWORKER_GUIDE_URL } from "../lib/links";
import { Avatar } from "./Avatar";
import { Button, EmptyState, Spinner } from "./ui";

type Props = {
  toast: (kind: "ok" | "error", text: string) => void;
};

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
 * 同事页：勾选一起干活的同事。启用的同事把角色、简述和技能包路径带进
 * 每一次 Agent 任务的提示词；可叠加，也可随时清空回到单干。
 */
export function CoworkerPage({ toast }: Props) {
  const [coworkers, setCoworkers] = useState<Coworker[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [promptSection, setPromptSection] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
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
    void load();
  }, [load]);

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

  const openLink = (url: string) => {
    void api.openPath(url).catch((error) => toast("error", String(error)));
  };

  const selected = (coworkers ?? []).filter((coworker) =>
    selectedIds.includes(coworker.id),
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-ui-lg text-slate-900">
              <Users size={16} className="text-slate-400" />
              找几个同事搭伙
            </h2>
            <p className="mt-1 text-ui-sm text-slate-500">
              启用的同事会把自己的角色和技能包带进每一次 Agent 修复。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="max-w-[260px] truncate text-ui-xs text-slate-400"
              title={selected.map((coworker) => coworker.name).join("、")}
            >
              {selected.length > 0
                ? `当前搭子：${selected.map((coworker) => coworker.name).join("、")}`
                : "今天单干"}
            </span>
            {selectedIds.length > 0 ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void commit([])}
                className="rounded-lg px-1.5 py-0.5 text-ui-xs text-slate-400 transition hover:bg-overlay hover:text-slate-700 disabled:opacity-50"
              >
                清空
              </button>
            ) : null}
          </div>
        </div>

        {warnings.length > 0 ? (
          <details className="mb-4 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2">
            <summary className="cursor-pointer select-none text-ui-sm text-amber-800">
              {warnings.length} 条同事包告警
            </summary>
            <ul className="mt-1.5 space-y-1">
              {warnings.map((warning, index) => (
                <li
                  key={`${index}-${warning}`}
                  className="break-all text-ui-xs leading-4 text-amber-700"
                >
                  {warning}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {promptSection ? (
          <details className="mb-4 rounded-xl border border-border bg-slate-50/60 px-3 py-2">
            <summary className="cursor-pointer select-none text-ui-sm text-slate-500">
              将写入 Agent 提示词的内容
            </summary>
            <pre className="mt-2 max-h-52 select-text overflow-auto whitespace-pre-wrap break-all font-mono text-ui-xs leading-5 text-slate-600">
              {promptSection}
            </pre>
          </details>
        ) : null}

        {loadError ? (
          <div className="rounded-xl border border-rose-100 bg-rose-50 p-4 text-ui-caption text-rose-700">
            <div className="break-all">{loadError}</div>
            <Button
              size="sm"
              className="mt-3"
              onClick={() => void load()}
              icon={<RefreshCw size={13} />}
            >
              重新加载
            </Button>
          </div>
        ) : coworkers === null ? (
          <div className="flex items-center justify-center gap-2 py-16 text-ui-caption text-slate-400">
            <Spinner />
            正在喊人…
          </div>
        ) : coworkers.length === 0 ? (
          <EmptyState
            icon={<Coffee size={18} />}
            title="还没有同事入职"
            description="把同事包放进 assets/coworker，重启后就能在这里见到。"
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {coworkers.map((coworker, index) => (
              <CoworkerCard
                key={coworker.id}
                coworker={coworker}
                selected={selectedIds.includes(coworker.id)}
                disabled={busy}
                index={index}
                onToggle={() => toggle(coworker.id)}
              />
            ))}
          </div>
        )}

        <section className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="flex items-center gap-1.5 text-ui-base text-slate-800">
                <Sparkles size={14} className="text-amber-500" />
                技能征集
              </h3>
              <p className="mt-1 max-w-2xl text-ui-sm leading-5 text-slate-500">
                你的独门手艺，也值得成为下一位同事。带上角色、头像和技能包来投。
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" onClick={() => openLink(COWORKER_GUIDE_URL)}>
                投稿规范
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<GitBranch size={13} />}
                onClick={() => openLink(COWORKER_FORK_URL)}
              >
                Fork 项目
              </Button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-ui-xs text-slate-500">
            <Step label="fork" />
            <ArrowRight size={11} className="text-slate-300" />
            <Step label="assets/coworker/<id>/" mono />
            <ArrowRight size={11} className="text-slate-300" />
            <Step label="PR" />
            <span className="ml-1 text-slate-400">
              规范见 README；坏包会在本页提示。
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}

function Step({ label, mono = false }: { label: string; mono?: boolean }) {
  return (
    <span
      className={clsx(
        "rounded-md border border-slate-200 bg-surface px-2 py-0.5 text-slate-600",
        mono && "font-mono",
      )}
    >
      {label}
    </span>
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
          <span className="text-ui-2xs text-slate-300">没有技能包</span>
        ) : null}
        <span
          className="ml-auto text-ui-2xs"
          style={{ color: selected ? accent : undefined }}
        >
          {selected ? "已入伙" : "点一下入伙"}
        </span>
      </div>
    </button>
  );
}
