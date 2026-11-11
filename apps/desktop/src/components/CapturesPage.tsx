import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FileJson,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import clsx from "clsx";

import {
  api,
  relativeTime,
  type CapturedRequest,
} from "../lib/api";
import { formatBytes } from "../lib/format";
import { copyText } from "../lib/desktop";
import { usePoll } from "../hooks/usePoll";
import { Button, EmptyState } from "./ui";

type Props = {
  toast: (kind: "ok" | "error", text: string) => void;
  onOpenPath: (path: string) => void;
};

export function CapturesPage({ toast, onOpenPath }: Props) {
  const [captures, setCaptures] = useState<CapturedRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyApi, setOnlyApi] = useState(true);
  const [method, setMethod] = useState("ALL");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [lastExport, setLastExport] = useState<string | null>(null);

  const load = async (silent = false) => {
    if (!silent) setBusy(true);
    try {
      const next = await api.captures();
      setCaptures(next);
      setLoaded(true);
    } catch (error) {
      if (!silent) toast("error", String(error));
    } finally {
      if (!silent) setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  usePoll(() => load(true), 4000, { pauseWhenHidden: true });

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return captures
      .slice()
      .sort((a, b) => b.id - a.id)
      .filter((entry) => {
        if (onlyApi && !entry.url.toLowerCase().includes("/api/")) return false;
        if (method !== "ALL" && entry.method !== method) return false;
        if (keyword && !entry.url.toLowerCase().includes(keyword)) return false;
        return true;
      });
  }, [captures, onlyApi, method, query]);

  const methods = useMemo(
    () => Array.from(new Set(captures.map((entry) => entry.method))).sort(),
    [captures],
  );

  const exportCaptures = async () => {
    setBusy(true);
    try {
      const path = await api.exportCaptures();
      setLastExport(path);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setBusy(false);
    }
  };

  const clearCaptures = async () => {
    setBusy(true);
    try {
      await api.clearCaptures();
      setCaptures([]);
      setExpanded(null);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    if (await copyText(text)) {
      toast("ok", "已复制");
      return;
    }
    toast("error", "复制失败");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3">
        <div className="relative min-w-[220px] flex-1">
          <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 URL"
            className="w-full rounded-lg border border-border bg-slate-50 py-2 pl-9 pr-3 text-ui-caption text-slate-800 transition focus:border-sky-400 focus:bg-surface focus:outline-2 focus:outline-sky-200"
          />
        </div>

        <select
          value={method}
          onChange={(event) => setMethod(event.target.value)}
          className="rounded-lg border border-border bg-surface px-2.5 py-2 text-ui-caption text-slate-700 focus:border-sky-300 focus:outline-2 focus:outline-sky-200"
        >
          <option value="ALL">全部方法</option>
          {methods.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>

        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-ui-caption text-slate-600">
          <input
            type="checkbox"
            checked={onlyApi}
            onChange={(event) => setOnlyApi(event.target.checked)}
            className="h-3.5 w-3.5 accent-sky-600"
          />
          只看 /api/
        </label>

        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={() => void load()} loading={busy} icon={<RefreshCw size={13} />}>
            刷新
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void exportCaptures()}
            disabled={busy || captures.length === 0}
            icon={<FileJson size={13} />}
          >
            导出 JSON
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => void clearCaptures()}
            disabled={busy || captures.length === 0}
            icon={<Trash2 size={13} />}
          >
            清空
          </Button>
        </div>
      </div>

      {lastExport ? (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-ui-caption text-emerald-800">
          <FileJson size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono">{lastExport}</span>
          <button
            type="button"
            onClick={() => onOpenPath(lastExport.replace(/\/[^/]+$/, ""))}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-300 bg-surface px-2 py-1 text-ui-sm"
          >
            <FolderOpen size={12} />
            打开
          </button>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-border bg-surface ">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 text-ui-sm text-slate-500">
          <span>
            显示 {filtered.length} / 共 {captures.length} 条 · 上限 150 条、单条响应 512KB
          </span>
          <span className="hidden sm:inline">每 4 秒自动刷新</span>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={loaded ? <Search size={22} /> : <Loader2 size={22} className="animate-spin" />}
            title={loaded ? "还没有匹配的请求" : "正在读取抓包…"}
            description={
              loaded
                ? "在 TAPD 中操作时，这里会记录接口请求。"
                : "正在读取请求记录…"
            }
          />
        ) : (
          <div className="max-h-[calc(100vh-280px)] overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-left">
              <thead className="text-ui-sm text-slate-500">
                <tr>
                  <th className="sticky top-0 z-10 w-8 bg-slate-50 px-3 py-2" />
                  <th className="sticky top-0 z-10 w-16 bg-slate-50 px-3 py-2">
                    时间
                  </th>
                  <th className="sticky top-0 z-10 w-16 bg-slate-50 px-3 py-2">
                    方法
                  </th>
                  <th className="sticky top-0 z-10 w-14 bg-slate-50 px-3 py-2">
                    状态
                  </th>
                  <th className="sticky top-0 z-10 bg-slate-50 px-3 py-2">
                    URL
                  </th>
                  <th className="sticky top-0 z-10 w-20 bg-slate-50 px-3 py-2 text-right">
                    大小
                  </th>
                  <th className="sticky top-0 z-10 w-16 bg-slate-50 px-3 py-2 text-right">
                    耗时
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr+tr>td]:border-t [&>tr+tr>td]:border-slate-100">
                {filtered.map((entry) => {
                  const isOpen = expanded === entry.id;
                  return (
                    <CaptureRow
                      key={entry.id}
                      entry={entry}
                      open={isOpen}
                      onToggle={() => setExpanded(isOpen ? null : entry.id)}
                      onCopy={(text) => void copy(text)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function CaptureRow(props: {
  entry: CapturedRequest;
  open: boolean;
  onToggle: () => void;
  onCopy: (text: string) => void;
}) {
  const { entry, open, onToggle, onCopy } = props;

  const statusTone =
    entry.error || (entry.status && entry.status >= 400)
      ? "text-rose-600 bg-rose-50"
      : entry.status && entry.status >= 200 && entry.status < 300
        ? "text-emerald-600 bg-emerald-50"
        : "text-slate-500 bg-slate-100";

  return (
    <>
      <tr
        className={clsx("cursor-pointer text-ui-caption transition hover:bg-slate-50", open && "bg-sky-50/60")}
        onClick={onToggle}
      >
        <td className="px-3 py-2 text-slate-400">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </td>
        <td className="whitespace-nowrap px-3 py-2 font-mono text-ui-sm text-slate-400">
          {relativeTime(entry.ts)}
        </td>
        <td className="px-3 py-2">
          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-ui-xs font-normal text-slate-600">
            {entry.method}
          </span>
        </td>
        <td className="px-3 py-2">
          <span
            className={clsx(
              "inline-flex min-w-[34px] justify-center rounded px-1.5 py-0.5 font-mono text-ui-xs font-normal",
              statusTone,
            )}
          >
            {entry.status ?? "ERR"}
          </span>
        </td>
        <td className="max-w-0 px-3 py-2">
          <div className="truncate font-mono text-ui-sm text-slate-700" title={entry.url}>
            {entry.url}
          </div>
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-ui-sm text-slate-400">
          {formatBytes(entry.size)}
        </td>
        <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-ui-sm text-slate-400">
          {entry.durationMs != null ? `${entry.durationMs}ms` : "—"}
        </td>
      </tr>

      {open ? (
        <tr className="bg-slate-50/80">
          <td colSpan={7} className="px-4 pb-4 pt-1">
            <div className="grid gap-3 lg:grid-cols-2">
              <BodyPanel
                title="请求体"
                value={entry.requestBody}
                truncated={entry.truncated && Boolean(entry.requestBody)}
                onCopy={onCopy}
              />
              <BodyPanel
                title="响应体"
                value={entry.responseBody}
                truncated={entry.truncated && Boolean(entry.responseBody)}
                onCopy={onCopy}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-ui-sm text-slate-500">
              <span className="rounded bg-surface px-2 py-1 font-mono">
                {entry.contentType ?? "unknown content-type"}
              </span>
              <button
                type="button"
                onClick={() => onCopy(entry.url)}
                className="inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-1 transition hover:border-slate-300"
              >
                <Copy size={11} />
                复制 URL
              </button>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function BodyPanel(props: {
  title: string;
  value: string | null;
  truncated: boolean;
  onCopy: (text: string) => void;
}) {
  const { title, value, truncated, onCopy } = props;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 text-ui-sm text-slate-500">
        <span>
          {title}
          {truncated ? <span className="ml-2 text-amber-600">已截断</span> : null}
        </span>
        {value ? (
          <button
            type="button"
            onClick={() => onCopy(value)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition hover:bg-slate-100"
          >
            <Copy size={11} />
            复制
          </button>
        ) : null}
      </div>
      <pre className="select-text max-h-72 overflow-auto whitespace-pre-wrap break-all bg-slate-50/60 p-3 font-mono text-ui-sm leading-5 text-slate-700">
        {value || <span className="text-slate-400">无内容</span>}
      </pre>
    </div>
  );
}
