/**
 * Built-in plugin inventory: what the running engine actually composed.
 *
 * Mirrors the reference client's panel (search + "session plugins" and "global
 * plugins" sections) but reads this deployment's Loader through the bridge, so
 * every row is a plugin that really is mounted — plus its own enabled flag and
 * root-Fiber state. Nothing here can enable or disable a row: the profile is
 * rendered by the app on every start.
 */
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Search } from "lucide-react";

import { dshPluginApi, type DshPluginEntry } from "../lib/dsh";
import { getLocale, t } from "../lib/i18n";
import { Button, Spinner } from "../components/ui";
import { ScrollingName } from "../components/ScrollingName";

type Text = { zh: string; en: string } | null;

/** Both localized copies are sent; the client picks the current one. */
function pick(text: Text): string {
  if (!text) return "";
  return getLocale() === "en" ? text.en : text.zh;
}

/** Package name without its scope and engine prefix, as the reference shows it. */
function shortModule(module: string): string {
  const unscoped = module.startsWith("@") ? module.slice(module.indexOf("/") + 1) : module;
  return unscoped.replace(/^cordis:/, "").replace(/^cordis-plugin-/, "");
}

type State = "off" | "pending" | "loading" | "active" | "failed" | "unloading";

function stateOf(entry: DshPluginEntry): State {
  if (!entry.enabled) return "off";
  return (entry.phase ?? "active") as State;
}

/** Dot tone per state; a settled running plugin stays quiet. */
const DOT: Record<State, string> = {
  off: "bg-slate-300",
  pending: "bg-slate-400",
  loading: "bg-sky-400",
  active: "bg-emerald-500",
  failed: "bg-rose-500",
  unloading: "bg-amber-400",
};

const LABEL: Record<State, Parameters<typeof t>[0]> = {
  off: "agent.plugins.stateOff",
  pending: "agent.plugins.statePending",
  loading: "agent.plugins.stateLoading",
  active: "agent.plugins.stateActive",
  failed: "agent.plugins.stateFailed",
  unloading: "agent.plugins.stateUnloading",
};

function matches(entry: DshPluginEntry, needle: string): boolean {
  if (!needle) return true;
  const haystack = [
    entry.module,
    entry.package,
    entry.id,
    entry.title?.zh ?? "",
    entry.title?.en ?? "",
    entry.description?.zh ?? "",
    entry.description?.en ?? "",
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

export function PluginInventory() {
  const [entries, setEntries] = useState<DshPluginEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = () => {
    setError(null);
    dshPluginApi
      .list()
      .then((reply) => setEntries(reply.entries))
      .catch((problem) => setError(String(problem)));
  };

  useEffect(() => {
    load();
  }, []);

  const needle = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const visible = (entries ?? []).filter(
      (entry) => !entry.group && matches(entry, needle),
    );
    return {
      session: visible.filter((entry) => entry.scope === "session"),
      global: visible.filter((entry) => entry.scope !== "session"),
    };
  }, [entries, needle]);

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

  if (entries === null) {
    return (
      <div className="flex items-center gap-2 py-6 text-ui-caption text-slate-400">
        <Spinner />
        {t("agent.plugins.loading")}
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
          aria-label={t("agent.plugins.search")}
          placeholder={t("agent.plugins.search")}
          className="min-w-0 flex-1 bg-transparent text-ui-caption text-slate-700 outline-none placeholder:text-slate-300"
        />
      </div>

      <Section
        title={t("agent.plugins.sessionTitle")}
        hint={t("agent.plugins.sessionHint")}
        empty={t("agent.plugins.sessionEmpty")}
        entries={groups.session}
      />
      <Section
        title={t("agent.plugins.globalTitle")}
        hint={t("agent.plugins.globalHint")}
        empty={t("agent.plugins.empty")}
        entries={groups.global}
      />

      {(groups.session.length === 0 && groups.global.length === 0) ? (
        <div className="rounded-xl border border-dashed border-border p-3 text-ui-caption text-slate-400">
          {t("agent.plugins.emptySearch")}
        </div>
      ) : null}
    </div>
  );
}

function Section({
  title,
  hint,
  empty,
  entries,
}: {
  title: string;
  hint: string;
  empty: string;
  entries: DshPluginEntry[];
}) {
  return (
    <section className="rounded-xl border border-border">
      <header className="flex items-baseline gap-2 border-b border-border px-3 py-2">
        <h3 className="text-ui-caption text-slate-800">{title}</h3>
        <span className="tabular-nums text-ui-xs text-slate-400">{entries.length}</span>
        <span className="ml-auto min-w-0 truncate text-ui-xs text-slate-400" title={hint}>
          {hint}
        </span>
      </header>
      {entries.length === 0 ? (
        <div className="px-3 py-2 text-ui-xs text-slate-400">{empty}</div>
      ) : (
        <div className="flex flex-col">
          {entries.map((entry) => (
            <PluginRow key={`${entry.scope}:${entry.sessionId ?? ""}:${entry.id}`} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
}

function PluginRow({ entry }: { entry: DshPluginEntry }) {
  const state = stateOf(entry);
  const packageName = entry.package || entry.module;
  const title = pick(entry.title) || shortModule(packageName) || entry.id;
  const module = shortModule(packageName);

  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 last:border-b-0">
      <span className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", DOT[state])} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <ScrollingName text={title} className="text-ui-caption text-slate-700" />
          {module && module !== title ? (
            <span className="shrink-0 truncate font-mono text-ui-2xs text-slate-400">
              {module}
            </span>
          ) : null}
        </div>
        {pick(entry.description) ? (
          <div className="mt-0.5 min-w-0 truncate text-ui-xs text-slate-400">
            {pick(entry.description)}
          </div>
        ) : null}
      </div>
      <span
        className={clsx(
          "shrink-0 text-ui-xs",
          state === "failed" ? "text-rose-600" : "text-slate-400",
        )}
      >
        {t(LABEL[state])}
      </span>
    </div>
  );
}
