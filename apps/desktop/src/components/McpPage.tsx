import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import clsx from "clsx";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Copy,
  Download,
  FileJson,
  FileText,
  FolderOpen,
  Plug,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  Zap,
} from "lucide-react";

import {
  api,
  type McpAuditEntry,
  type McpClientId,
  type McpConfigInfo,
  type McpPolicy,
  type Workspace,
} from "../lib/api";
import { copyText } from "../lib/desktop";
import { formatAuditTime } from "../lib/format";
import { mcpApi, type McpImportResult } from "../lib/mcp";
import { Badge, Button, Spinner, Switch, cardClass, inputClass } from "./ui";
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
  const [importingClient, setImportingClient] = useState<McpClientId | null>(null);
  const [importResults, setImportResults] = useState<
    Partial<Record<McpClientId, McpImportResult>>
  >({});
  const [expandedClients, setExpandedClients] = useState<Partial<Record<McpClientId, boolean>>>({});
  const [policy, setPolicy] = useState<McpPolicy | null>(null);
  const [audit, setAudit] = useState<McpAuditEntry[]>([]);
  const [auditFilter, setAuditFilter] = useState<"all" | "denied" | "error">("all");
  const [auditBusy, setAuditBusy] = useState(false);
  const [statusInput, setStatusInput] = useState("");
  const [copiedClient, setCopiedClient] = useState<McpClientId | null>(null);
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

  const copyClientPath = async (id: McpClientId, path: string) => {
    if (!(await copyText(path))) {
      toast("error", "复制失败");
      return;
    }
    setCopiedClient(id);
    window.setTimeout(
      () => setCopiedClient((current) => (current === id ? null : current)),
      1500,
    );
  };

  /** Opens the folder that holds a client config; the file may not exist yet. */
  const openClientFolder = (path: string) => {
    const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const folder = cut > 0 ? path.slice(0, cut) : path;
    void api.openPath(folder).catch((error) => toast("error", String(error)));
  };

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
      toast("ok", `已导出审计日志：${path}`);
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

  const importClient = async (client: McpClientId) => {
    setImportingClient(client);
    try {
      const result = await mcpApi.importClient(client);
      // The inline result block below and the refreshed "已导入" badge already
      // report the outcome; a toast here would be duplicate noise.
      setImportResults((previous) => ({ ...previous, [client]: result }));
      await loadConfig();
    } catch (error) {
      toast("error", String(error));
    } finally {
      setImportingClient(null);
    }
  };

  const toggleClient = (client: McpClientId) => {
    setExpandedClients((previous) => ({ ...previous, [client]: !previous[client] }));
  };

  if (!mcp) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-ui-caption text-slate-400">
          {configError ? (
            <>
              <Plug size={22} className="mx-auto mb-2 text-slate-300" />
              <p className="max-w-md break-all">读取 MCP 配置失败：{configError}</p>
              <Button
                size="sm"
                className="mt-3"
                onClick={() => void loadConfig()}
                loading={refreshing}
                icon={<RefreshCw size={13} />}
              >
                重试
              </Button>
            </>
          ) : (
            <>
              <Spinner className="mx-auto mb-2" />
              MCP 设置加载中…
            </>
          )}
        </div>
      </div>
    );
  }

  const commandPath = mcp.commandPath || "tapd-mcp";
  const port = mcp.port ? `127.0.0.1:${mcp.port}` : "—";
  const writable = policy ? policy.writesEnabled : !mcp.readOnly;
  const filteredAudit = audit.filter((entry) =>
    auditFilter === "all" ? true : entry.decision === auditFilter,
  );

  const guides: Array<{
    id: McpClientId;
    title: string;
    hint: string;
    icon: ReactNode;
    code: string;
    manual: string;
  }> = [
    {
      id: "opencode",
      title: "opencode",
      hint: "用户级全局配置",
      icon: <Sparkles size={15} className="text-slate-400" />,
      code: mcp.snippet,
      manual: "只想对某个项目生效时，把上面的 JSON 写入项目根目录的 opencode.json。",
    },
    {
      id: "zcode",
      title: "ZCode",
      hint: "用户级：~/.zcode/cli/config.json",
      icon: <Zap size={15} className="text-slate-400" />,
      code: JSON.stringify(
        { mcp: { servers: { tapd: { type: "stdio", command: commandPath } } } },
        null,
        2,
      ),
      manual:
        "只想对某个项目生效时，把同样的 mcp.servers.tapd 写入项目的 .zcode/config.json（command 是字符串）。写入后重启 ZCode，在 设置 → MCP 确认状态。",
    },
    {
      id: "claude",
      title: "Claude Code",
      hint: "用户级：claude mcp add --scope user",
      icon: <Terminal size={15} className="text-slate-400" />,
      code: `claude mcp add --scope user --transport stdio tapd -- "${commandPath}"`,
      manual:
        "只想对某个项目生效时，去掉 --scope user；或改用 --scope project 写入项目的 .mcp.json。",
    },
    {
      id: "cursor",
      title: "Cursor",
      hint: "用户级：~/.cursor/mcp.json",
      icon: <FileJson size={15} className="text-slate-400" />,
      code: JSON.stringify({ mcpServers: { tapd: { command: commandPath } } }, null, 2),
      manual:
        "只想对某个项目生效时，把同样的 mcpServers.tapd 写入项目的 .cursor/mcp.json。",
    },
    {
      id: "codex",
      title: "Codex",
      hint: "用户级：~/.codex/config.toml",
      icon: <FileText size={15} className="text-slate-400" />,
      code: `[mcp_servers.tapd]\ncommand = "${commandPath}"`,
      manual:
        "只想对某个项目生效时，把上面的配置写入该项目的 Codex 配置，或在启动时用 -c 覆盖。",
    },
  ];

  const clientStatus = (id: McpClientId) =>
    mcp.clients.find((client) => client.id === id);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <section className="space-y-3">
        <div className="px-1">
          <h2
            className="flex items-center gap-2 text-ui-base text-slate-900"
            title="一键写入各客户端的用户级配置，改动前自动备份；只想对某个项目生效时，展开手动配置。"
          >
            <Wrench size={15} className="text-slate-400" />
            接入 AI 客户端
          </h2>
        </div>

        <div className="space-y-2">
          {guides.map((guide) => {
            const status = clientStatus(guide.id);
            const clientPath = status?.path ?? null;
            const expanded = Boolean(expandedClients[guide.id]);
            const result = importResults[guide.id];
            return (
              <section
                key={guide.id}
                className="rounded-2xl border border-border bg-surface p-4 "
              >
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                    {guide.icon}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-ui-caption font-normal text-slate-900">{guide.title}</h3>
                        <Badge tone={status?.imported ? "green" : "amber"}>
                          {status?.imported ? "已导入" : "未导入"}
                        </Badge>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1">
                        <p
                          className="select-text min-w-0 flex-1 truncate text-ui-xs text-slate-400"
                          title={clientPath ?? guide.hint}
                        >
                          {clientPath ?? guide.hint}
                        </p>
                        {clientPath ? (
                          <div className="flex shrink-0 items-center">
                            <button
                              type="button"
                              title="复制路径"
                              aria-label="复制路径"
                              onClick={() => void copyClientPath(guide.id, clientPath)}
                              className="grid h-6 w-6 place-items-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                            >
                              {copiedClient === guide.id ? (
                                <Check size={11} className="text-emerald-600" />
                              ) : (
                                <Copy size={11} />
                              )}
                            </button>
                            <button
                              type="button"
                              title="打开文件夹"
                              aria-label="打开文件夹"
                              onClick={() => openClientFolder(clientPath)}
                              className="grid h-6 w-6 place-items-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                            >
                              <FolderOpen size={11} />
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      size="sm"
                      variant={status?.imported ? "secondary" : "primary"}
                      loading={importingClient === guide.id}
                      onClick={() => void importClient(guide.id)}
                      icon={<Download size={13} />}
                    >
                      {status?.imported ? "重新导入" : "一键导入"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => toggleClient(guide.id)}
                      icon={
                        <ChevronDown
                          size={13}
                          className={clsx("transition", expanded && "rotate-180")}
                        />
                      }
                    >
                      手动配置
                    </Button>
                  </div>
                </div>

                {result ? (
                  <div className="mt-2 break-all text-ui-xs leading-5 text-emerald-700">
                    <CheckCircle2 size={11} className="mr-1 inline" />
                    {result.changed ? "已写入" : "已存在，无需重复写入"}：
                    <span className="font-mono">{result.path}</span>
                    {result.backupPath ? (
                      <span className="text-emerald-600/80">
                        （备份：<span className="font-mono">{result.backupPath}</span>）
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {expanded ? (
                  <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-ui-xs leading-5 text-slate-500">{guide.manual}</p>
                      <button
                        type="button"
                        onClick={() => onCopy(guide.code)}
                        className={COPY_BUTTON}
                      >
                        <Copy size={10} />
                        复制
                      </button>
                    </div>
                    <pre className="select-text theme-static-dark mt-2 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-ui-xs leading-5 text-slate-200">
                      {guide.code}
                    </pre>
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </section>

      <section className={cardClass}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              className="flex items-center gap-2 text-ui-base text-slate-900"
              title="把 TAPD 缺陷接入 AI 客户端，支持查询、导出与修复后回写。"
            >
              <Plug size={15} className="text-slate-400" />
              MCP 服务
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone="green" dot>
              已启用
            </Badge>
            <Badge tone={writable ? "blue" : "neutral"}>
              {writable ? "读写" : "只读"}
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
              刷新
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-2 text-ui-sm text-slate-500 sm:grid-cols-4">
          <StatusTile label="传输" value={mcp.transport} mono />
          <StatusTile label="本地端口" value={port} mono />
          <StatusTile label="工具" value={`${mcp.tools.length} 个`} />
          <StatusTile label="权限" value={writable ? "读写" : "只读"} />
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {mcp.tools.map((tool) => (
            <button
              key={tool.name}
              type="button"
              onClick={() => setDocsTool(tool.name)}
              title="查看接口文档"
              className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-ui-xs text-slate-600 transition hover:bg-sky-50 hover:text-sky-700"
            >
              {tool.name}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-2">
          <PathRow label="MCP 程序路径" value={mcp.commandPath} onCopy={onCopy} />
        </div>
      </section>

      <section className={cardClass}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2
              className="flex items-center gap-2 text-ui-base text-slate-900"
              title="策略只会在 TAPD 权限之上进一步收窄范围，不会扩大 AI 的访问能力。"
            >
              <ShieldCheck size={15} className="text-slate-400" />
              MCP 策略
            </h2>
          </div>
        </div>

        {!policy ? (
          <div className="mt-4 flex items-center gap-2 text-ui-caption text-slate-400">
            <Spinner />
            读取 MCP 策略…
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="space-y-3">
              <PolicyRow
                title="允许写操作"
                hint="评论与状态回写。关闭后仅保留查询、详情与导出工具。"
              >
                <Switch
                  checked={policy.writesEnabled}
                  onChange={(value) => void savePolicy({ writesEnabled: value })}
                  className="mt-0.5"
                  uncheckedClassName="bg-slate-200"
                />
              </PolicyRow>
              <PolicyRow
                title="记录调用审计"
                hint="记录工具、客户端、决策、耗时与项目/缺陷；不保存评论正文和 Cookie。"
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
                  允许访问的项目
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => void savePolicy({ allowedWorkspaceIds: [] })}
                  className={chipClass(policy.allowedWorkspaceIds.length === 0)}
                >
                  全部项目
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
                    项目列表尚未加载，稍后再试。
                  </span>
                ) : null}
              </div>
            </div>

            <div>
              <label className="text-ui-sm font-normal text-slate-600">
                允许的目标状态
              </label>
              <input
                value={statusInput}
                onChange={(event) => setStatusInput(event.target.value)}
                onBlur={() => void commitStatuses()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                title="可填状态 key（resolved）或中文名（已解决），多个用逗号分隔。"
                placeholder="例如 resolved, closed；留空 = 遵循 TAPD 工作流"
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
              调用审计
            </h2>
            <p className="mt-1 text-ui-caption leading-5 text-slate-500">
              最近 {audit.length || 120} 次 MCP 调用；拒绝与失败也会记录。
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
              <option value="all">全部</option>
              <option value="denied">被拒绝</option>
              <option value="error">失败</option>
            </select>
            <Button
              size="sm"
              onClick={() => void loadAudit()}
              icon={<RefreshCw size={12} />}
            >
              刷新
            </Button>
            <Button
              size="sm"
              onClick={() => void exportAudit()}
              loading={auditBusy}
              icon={<Download size={12} />}
            >
              导出
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => void clearAudit()}
              loading={auditBusy}
              icon={<Trash2 size={12} />}
            >
              清空
            </Button>
          </div>
        </div>

        <div className="mt-3 max-h-[360px] overflow-auto rounded-xl border border-slate-100">
          {filteredAudit.length === 0 ? (
            <div className="p-6 text-center text-ui-sm text-slate-400">
              {audit.length ? "没有匹配的记录" : "暂无调用记录"}
            </div>
          ) : (
            <table className="w-full text-left text-ui-sm">
              <thead className="sticky top-0 bg-slate-50 text-ui-xs text-slate-400">
                <tr>
                  <th className="px-3 py-2 font-normal">时间</th>
                  <th className="px-2 py-2 font-normal">工具</th>
                  <th className="px-2 py-2 font-normal">客户端</th>
                  <th className="px-2 py-2 font-normal">结果</th>
                  <th className="px-2 py-2 font-normal">耗时</th>
                  <th className="px-2 py-2 font-normal">项目 / 缺陷</th>
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
                          ? "允许"
                          : entry.decision === "denied"
                            ? "拒绝"
                            : "失败"}
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
        复制
      </button>
    </div>
  );
}
