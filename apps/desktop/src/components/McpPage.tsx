import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import clsx from "clsx";
import {
  ClipboardList,
  Copy,
  Download,
  Plug,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import {
  api,
  type McpAuditEntry,
  type McpConfigInfo,
  type McpPolicy,
  type Workspace,
} from "../lib/api";
import { formatAuditTime } from "../lib/format";
import { t } from "../lib/i18n";
import { Badge, Button, Spinner, Switch, cardClass, inputClass } from "./ui";
import { McpClientImport } from "./McpClientImport";
import { McpToolDocs } from "./McpToolDocs";

type Props = {
  workspaces: Workspace[];
  onCopy: (text: string) => void;
  toast: (kind: "ok" | "error", text: string) => void;
};

const COPY_BUTTON =
  "inline-flex shrink-0 items-center gap-1 rounded border border-border bg-surface px-2 py-1 text-ui-xs text-slate-600 transition hover:border-slate-300";

/**
 * MCP tab: server status, policy/audit, and per-client one-click import
 * (opencode / Claude Code / Cursor / Codex) with manual project-level config.
 */
export function McpPage({ workspaces, onCopy, toast }: Props) {
  const [mcp, setMcp] = useState<McpConfigInfo | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [policy, setPolicy] = useState<McpPolicy | null>(null);
  const [audit, setAudit] = useState<McpAuditEntry[]>([]);
  const [auditFilter, setAuditFilter] = useState<"all" | "denied" | "error">("all");
  const [auditBusy, setAuditBusy] = useState(false);
  const [statusInput, setStatusInput] = useState("");
  const [docsTool, setDocsTool] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await api.mcpConfig();
      setMcp(next);
      setConfigError(null);
    } catch (error) {
      setConfigError(String(error));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const loadAudit = useCallback(async () => {
    try {
      setAudit(await api.mcpAuditList(120));
    } catch (error) {
      toast("error", String(error));
    }
  }, [toast]);

  const loadPolicy = useCallback(async () => {
    try {
      const next = await api.mcpPolicyGet();
      setPolicy(next);
      setStatusInput(next.allowedStatuses.join(", "));
    } catch (error) {
      toast("error", String(error));
    }
  }, [toast]);

  useEffect(() => {
    void loadPolicy();
    void loadAudit();
  }, [loadPolicy, loadAudit]);

  const savePolicy = async (patch: Partial<McpPolicy>) => {
    if (!policy) return;
    const next = { ...policy, ...patch };
    setPolicy(next);
    try {
      const saved = await api.mcpPolicySet(next);
      setPolicy(saved);
      setStatusInput(saved.allowedStatuses.join(", "));
    } catch (error) {
      toast("error", String(error));
      await loadPolicy();
    }
  };

  const commitStatuses = async () => {
    if (!policy) return;
    const raw = statusInput
      .split(/[,，\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (raw.join("\u0000") === policy.allowedStatuses.join("\u0000")) return;
    await savePolicy({ allowedStatuses: raw });
  };

  const toggleWorkspace = (workspaceId: string) => {
    if (!policy) return;
    const allowed = new Set(policy.allowedWorkspaceIds);
    if (allowed.has(workspaceId)) allowed.delete(workspaceId);
    else allowed.add(workspaceId);
    void savePolicy({ allowedWorkspaceIds: [...allowed] });
  };

  const exportAudit = async () => {
    setAuditBusy(true);
    try {
      const path = await api.mcpAuditExport();
      toast("ok", t("mcp.auditExported", { path }));
    } catch (error) {
      toast("error", String(error));
    } finally {
      setAuditBusy(false);
    }
  };

  const clearAudit = async () => {
    setAuditBusy(true);
    try {
      await api.mcpAuditClear();
      setAudit([]);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setAuditBusy(false);
    }
  };


  if (!mcp) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-ui-caption text-slate-400">
          {configError ? (
            <>
              <Plug size={22} className="mx-auto mb-2 text-slate-300" />
              <p className="max-w-md break-all">{t("mcp.configReadFailed", { error: configError })}</p>
              <Button
                size="sm"
                className="mt-3"
                onClick={() => void loadConfig()}
                loading={refreshing}
                icon={<RefreshCw size={13} />}
              >
                {t("common.retry")}
              </Button>
            </>
          ) : (
            <>
              <Spinner className="mx-auto mb-2" />
              {t("mcp.settingsLoading")}
            </>
          )}
        </div>
      </div>
    );
  }

  const port = mcp.port ? `127.0.0.1:${mcp.port}` : "—";
  const writable = policy ? policy.writesEnabled : !mcp.readOnly;
  const filteredAudit = audit.filter((entry) =>
    auditFilter === "all" ? true : entry.decision === auditFilter,
  );


  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <McpClientImport
        config={mcp}
        onCopy={onCopy}
        toast={toast}
        onImported={() => void loadConfig()}
      />
      <section className={cardClass}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              className="flex items-center gap-2 text-ui-base text-slate-900"
              title={t("mcp.serviceIntro")}
            >
              <Plug size={15} className="text-slate-400" />
              {t("mcp.service")}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone="green" dot>
              {t("mcp.enabled")}
            </Badge>
            <Badge tone={writable ? "blue" : "neutral"}>
              {writable ? t("mcp.readWrite") : t("mcp.readOnly")}
            </Badge>
            <Button
              size="sm"
              onClick={() => {
                void loadConfig();
                void loadPolicy();
                void loadAudit();
              }}
              loading={refreshing}
              icon={<RefreshCw size={13} />}
            >
              {t("common.refresh")}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-2 text-ui-sm text-slate-500 sm:grid-cols-4">
          <StatusTile label={t("mcp.transport")} value={mcp.transport} mono />
          <StatusTile label={t("mcp.localPort")} value={port} mono />
          <StatusTile label={t("mcp.tools")} value={t("mcp.toolCount", { n: mcp.tools.length })} />
          <StatusTile label={t("mcp.access")} value={writable ? t("mcp.readWrite") : t("mcp.readOnly")} />
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {mcp.tools.map((tool) => (
            <button
              key={tool.name}
              type="button"
              onClick={() => setDocsTool(tool.name)}
              title={t("mcp.viewDocs")}
              className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-ui-xs text-slate-600 transition hover:bg-sky-50 hover:text-sky-700"
            >
              {tool.name}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-2">
          <PathRow label={t("mcp.binaryPath")} value={mcp.commandPath} onCopy={onCopy} />
        </div>
      </section>

      <section className={cardClass}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              className="flex items-center gap-2 text-ui-base text-slate-900"
              title={t("mcp.policyIntro")}
            >
              <ShieldCheck size={15} className="text-slate-400" />
              {t("mcp.policy")}
            </h2>
          </div>
        </div>

        {!policy ? (
          <div className="mt-4 flex items-center gap-2 text-ui-caption text-slate-400">
            <Spinner />
            {t("mcp.policyReading")}
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="space-y-3">
              <PolicyRow
                title={t("mcp.allowWrites")}
                hint={t("mcp.allowWritesHint")}
              >
                <Switch
                  checked={policy.writesEnabled}
                  onChange={(value) => void savePolicy({ writesEnabled: value })}
                  className="mt-0.5"
                  uncheckedClassName="bg-slate-200"
                />
              </PolicyRow>
              <PolicyRow
                title={t("mcp.auditLog")}
                hint={t("mcp.auditLogHint")}
              >
                <Switch
                  checked={policy.auditEnabled}
                  onChange={(value) => void savePolicy({ auditEnabled: value })}
                  className="mt-0.5"
                  uncheckedClassName="bg-slate-200"
                />
              </PolicyRow>
            </div>

            <div>
              <div className="flex items-center justify-between gap-2">
                <div className="text-ui-sm font-normal text-slate-600">
                  {t("mcp.allowedProjects")}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => void savePolicy({ allowedWorkspaceIds: [] })}
                  className={chipClass(policy.allowedWorkspaceIds.length === 0)}
                >
                  {t("mcp.allProjects")}
                </button>
                {workspaces.map((workspace) => {
                  const active = policy.allowedWorkspaceIds.includes(workspace.id);
                  return (
                    <button
                      key={workspace.id}
                      type="button"
                      onClick={() => toggleWorkspace(workspace.id)}
                      className={chipClass(active)}
                      title={workspace.prettyName || workspace.name}
                    >
                      {workspace.name}
                    </button>
                  );
                })}
                {workspaces.length === 0 ? (
                  <span className="text-ui-xs text-slate-400">
                    {t("mcp.projectsLoading")}
                  </span>
                ) : null}
              </div>
            </div>

            <div>
              <label className="text-ui-sm font-normal text-slate-600">
                {t("mcp.allowedStatuses")}
              </label>
              <input
                value={statusInput}
                onChange={(event) => setStatusInput(event.target.value)}
                onBlur={() => void commitStatuses()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                title={t("mcp.statusesHint")}
                placeholder={t("mcp.statusesPlaceholder")}
                className={`${inputClass} mt-1.5 font-mono`}
              />
            </div>
          </div>
        )}
      </section>

      <section className={cardClass}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
              <ClipboardList size={15} className="text-slate-400" />
              {t("mcp.audit")}
            </h2>
            <p className="mt-1 text-ui-caption leading-5 text-slate-500">
              {t("mcp.auditHint", {
                n: audit.length || 120,
              })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <select
              value={auditFilter}
              onChange={(event) =>
                setAuditFilter(event.target.value as "all" | "denied" | "error")
              }
              className="rounded-lg border border-border bg-surface px-2 py-1.5 text-ui-sm text-slate-600 focus:border-sky-300"
            >
              <option value="all">{t("common.all")}</option>
              <option value="denied">{t("mcp.filterDenied")}</option>
              <option value="error">{t("common.failed")}</option>
            </select>
            <Button
              size="sm"
              onClick={() => void loadAudit()}
              icon={<RefreshCw size={12} />}
            >
              {t("common.refresh")}
            </Button>
            <Button
              size="sm"
              onClick={() => void exportAudit()}
              loading={auditBusy}
              icon={<Download size={12} />}
            >
              {t("mcp.export")}
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => void clearAudit()}
              loading={auditBusy}
              icon={<Trash2 size={12} />}
            >
              {t("common.clear")}
            </Button>
          </div>
        </div>

        <div className="mt-3 max-h-[360px] overflow-auto rounded-xl border border-slate-100">
          {filteredAudit.length === 0 ? (
            <div className="p-6 text-center text-ui-sm text-slate-400">
              {audit.length ? t("mcp.noMatch") : t("mcp.noCalls")}
            </div>
          ) : (
            <table className="w-full text-left text-ui-sm">
              <thead className="sticky top-0 bg-slate-50 text-ui-xs text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-normal">{t("mcp.time")}</th>
                  <th className="px-2 py-2 font-normal">{t("mcp.tools")}</th>
                  <th className="px-2 py-2 font-normal">{t("mcp.client")}</th>
                  <th className="px-2 py-2 font-normal">{t("mcp.result")}</th>
                  <th className="px-2 py-2 font-normal">{t("mcp.duration")}</th>
                  <th className="px-2 py-2 font-normal">{t("mcp.projectBug")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredAudit.map((entry) => (
                  <tr
                    key={entry.id}
                    className="text-slate-600"
                    title={entry.error ?? undefined}
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-ui-xs text-slate-400">
                      {formatAuditTime(entry.ts)}
                    </td>
                    <td className="px-2 py-2 font-mono text-ui-xs text-slate-700">
                      {entry.tool}
                    </td>
                    <td className="px-2 py-2">{entry.client}</td>
                    <td className="px-2 py-2">
                      <Badge
                        tone={
                          entry.decision === "allowed"
                            ? "green"
                            : entry.decision === "denied"
                              ? "amber"
                              : "red"
                        }
                      >
                        {entry.decision === "allowed"
                          ? t("mcp.resultAllowed")
                          : entry.decision === "denied"
                            ? t("mcp.resultDenied")
                            : t("common.failed")}
                      </Badge>
                    </td>
                    <td className="px-2 py-2 tabular-nums text-slate-500">
                      {entry.durationMs}ms
                    </td>
                    <td className="max-w-[190px] truncate px-2 py-2 font-mono text-ui-xs text-slate-400">
                      {entry.workspaceId ?? "—"}
                      {entry.bugId ? ` / ${entry.bugId}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>


      {docsTool ? (
        <McpToolDocs
          tools={mcp.tools}
          initialTool={docsTool}
          onCopy={onCopy}
          onClose={() => setDocsTool(null)}
        />
      ) : null}
    </div>
  );
}

function chipClass(active: boolean): string {
  return clsx(
    "rounded-full border px-2.5 py-1 text-ui-xs transition",
    active
      ? "border-sky-200 bg-sky-50 text-sky-700"
      : "border-border bg-surface text-slate-500 hover:border-slate-300",
  );
}

function PolicyRow(props: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-slate-100 bg-slate-50/70 p-3">
      <div className="min-w-0">
        <div className="text-ui-sm font-normal text-slate-700">{props.title}</div>
        <div className="mt-0.5 text-ui-xs leading-5 text-slate-400">{props.hint}</div>
      </div>
      {props.children}
    </div>
  );
}

function StatusTile({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
      <div className="text-ui-xs text-slate-400">{label}</div>
      <div
        className={
          mono
            ? "mt-1 truncate font-mono text-slate-700"
            : "mt-1 truncate text-slate-700"
        }
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function PathRow(props: {
  label: string;
  value: string;
  onCopy: (text: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 p-2.5">
      <span className="w-24 shrink-0 text-ui-sm text-slate-400">{props.label}</span>
      <span
        className="min-w-0 flex-1 truncate font-mono text-ui-sm text-slate-600"
        title={props.value}
      >
        {props.value}
      </span>
      <button
        type="button"
        onClick={() => props.onCopy(props.value)}
        className={COPY_BUTTON}
      >
        <Copy size={10} />
        {t("common.copy")}
      </button>
    </div>
  );
}
