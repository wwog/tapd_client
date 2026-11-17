/**
 * Tool inventory: the tool registry a new session inherits.
 *
 * Read from the engine's own `tools` service through the bridge, so every row
 * is a registration that really exists. Conditional rows (Agent Team's board
 * tools, for example) are listed apart: they are composed, but only callable
 * while their mode is on, and nothing here can turn one on or off.
 */
import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";

import { dshToolApi, type DshToolEntry } from "../lib/dsh";
import { t } from "../lib/i18n";
import { Button, Spinner } from "../components/ui";
import { ScrollingName } from "../components/ScrollingName";

function parameterCount(entry: DshToolEntry): number {
  const properties = entry.parameters?.properties;
  return properties ? Object.keys(properties).length : 0;
}

function matches(entry: DshToolEntry, needle: string): boolean {
  if (!needle) return true;
  return `${entry.name}\n${entry.description}`.toLowerCase().includes(needle);
}

export function ToolInventory() {
  const [tools, setTools] = useState<DshToolEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = () => {
    setError(null);
    dshToolApi
      .list()
      .then((reply) => setTools(reply.tools))
      .catch((problem) => setError(String(problem)));
  };

  useEffect(() => {
    load();
  }, []);

  const needle = query.trim().toLowerCase();
  const groups = useMemo(() => {
    // Alphabetical: the registry order follows composition, which is not what
    // a reader looks for here.
    const visible = (tools ?? [])
      .filter((entry) => matches(entry, needle))
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      ready: visible.filter((entry) => !entry.conditional),
      conditional: visible.filter((entry) => entry.conditional),
    };
  }, [tools, needle]);

  if (error) {
    return (
      <div className="rounded-xl border border-rose-100 bg-rose-50 p-3 text-ui-sm leading-5 text-rose-700">
        <div className="break-all">{error}</div>
        <Button size="sm" className="mt-2" onClick={load}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (tools === null) {
    return (
      <div className="flex items-center gap-2 py-6 text-ui-caption text-slate-400">
        <Spinner />
        {t("agent.tools.loading")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-canvas px-2 text-slate-400">
        <Search size={12} className="shrink-0" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          aria-label={t("agent.tools.search")}
          placeholder={t("agent.tools.search")}
          className="min-w-0 flex-1 bg-transparent text-ui-caption text-slate-700 outline-none placeholder:text-slate-300"
        />
      </div>

      <Section
        title={t("agent.tools.readyTitle")}
        hint={t("agent.tools.readyHint")}
        entries={groups.ready}
      />
      <Section
        title={t("agent.tools.conditionalTitle")}
        hint={t("agent.tools.conditionalHint")}
        entries={groups.conditional}
      />

      {groups.ready.length === 0 && groups.conditional.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-3 text-ui-caption text-slate-400">
          {needle ? t("agent.tools.emptySearch") : t("agent.tools.empty")}
        </div>
      ) : null}
    </div>
  );
}

function Section({
  title,
  hint,
  entries,
}: {
  title: string;
  hint: string;
  entries: DshToolEntry[];
}) {
  if (entries.length === 0) return null;
  return (
    <section className="rounded-xl border border-border">
      <header className="flex items-baseline gap-2 border-b border-border px-3 py-2">
        <h3 className="text-ui-caption text-slate-800">{title}</h3>
        <span className="tabular-nums text-ui-xs text-slate-400">{entries.length}</span>
        <span className="ml-auto min-w-0 truncate text-ui-xs text-slate-400" title={hint}>
          {hint}
        </span>
      </header>
      <div className="flex flex-col">
        {entries.map((entry) => (
          <ToolRow key={entry.name} entry={entry} />
        ))}
      </div>
    </section>
  );
}

function ToolRow({ entry }: { entry: DshToolEntry }) {
  const params = parameterCount(entry);
  return (
    <div className="flex min-w-0 flex-col gap-0.5 border-b border-border/60 px-3 py-1.5 last:border-b-0">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-mono text-ui-caption text-slate-800">
          {entry.name}
        </span>
        {params > 0 ? (
          <span className="shrink-0 text-ui-2xs tabular-nums text-slate-400">
            {t("agent.tools.params", { n: params })}
          </span>
        ) : null}
      </div>
      {entry.description ? (
        <ScrollingName
          text={entry.description}
          className="min-w-0 text-ui-xs text-slate-400"
        />
      ) : null}
    </div>
  );
}
