import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import clsx from "clsx";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  Download,
  FileJson,
  FolderOpen,
  RefreshCw,
  Sparkles,
  Terminal,
  Wrench,
  Zap,
} from "lucide-react";

import { api, type McpClientId, type McpConfigInfo } from "../lib/api";
import { copyText } from "../lib/desktop";
import { t, type MessageKey } from "../lib/i18n";
import { mcpApi, type McpImportResult } from "../lib/mcp";
import { Badge, Button, Spinner } from "./ui";

type Props = {
  onCopy: (text: string) => void;
  toast: (kind: "ok" | "error", text: string) => void;
  /** Called after a successful write so a parent can refresh its own copy. */
  onImported?: () => void;
  /** Controlled config; when omitted the component loads `mcp_config` itself. */
  config?: McpConfigInfo | null;
};

const COPY_BUTTON =
  "inline-flex shrink-0 items-center gap-1 rounded border border-border bg-surface px-2 py-1 text-ui-xs text-slate-600 transition hover:border-slate-300";

/**
 * One-click MCP import into the user-level config of each AI client, plus the
 * manual JSON for project-level setups. Shared by the MCP page and onboarding.
 */
export function McpClientImport({ onCopy, toast, onImported, config }: Props) {
  const controlled = config !== undefined;
  const [loaded, setLoaded] = useState<McpConfigInfo | null>(null);
  const mcp = controlled ? (config ?? null) : loaded;
  const [configError, setConfigError] = useState<string | null>(null);
  const [importingClient, setImportingClient] = useState<McpClientId | null>(null);
  const [importResults, setImportResults] = useState<
    Partial<Record<McpClientId, McpImportResult>>
  >({});
  const [expandedClients, setExpandedClients] = useState<
    Partial<Record<McpClientId, boolean>>
  >({});
  const [copiedClient, setCopiedClient] = useState<McpClientId | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      setLoaded(await api.mcpConfig());
      setConfigError(null);
    } catch (error) {
      setConfigError(String(error));
    }
  }, []);

  useEffect(() => {
    if (!controlled) void loadConfig();
  }, [controlled, loadConfig]);

  const copyClientPath = async (id: McpClientId, path: string) => {
    if (!(await copyText(path))) {
      toast("error", t("common.copyFailed"));
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

  const importClient = async (client: McpClientId) => {
    setImportingClient(client);
    try {
      const result = await mcpApi.importClient(client);
      // The inline result block below and the refreshed "已导入" badge already
      // report the outcome; a toast here would be duplicate noise.
      setImportResults((previous) => ({ ...previous, [client]: result }));
      if (controlled) onImported?.();
      else await loadConfig();
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
      <section className="rounded-2xl border border-border bg-surface p-4">
        <header className="flex items-center gap-2">
          <Wrench size={15} className="text-slate-400" />
          <h3 className="text-ui-caption text-slate-900">{t("mcp.connectClients")}</h3>
        </header>
        {configError ? (
          <div className="mt-3 text-ui-caption text-slate-400">
            <p className="break-all">{t("mcp.configReadFailed", { error: configError })}</p>
            <Button
              size="sm"
              className="mt-2"
              onClick={() => void loadConfig()}
              icon={<RefreshCw size={13} />}
            >
              {t("common.retry")}
            </Button>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2 text-ui-caption text-slate-400">
            <Spinner />
            {t("mcp.configReading")}
          </div>
        )}
      </section>
    );
  }

  const commandPath = mcp.commandPath || "tapd-mcp";

  const guides: Array<{
    id: McpClientId;
    title: string;
    hint: MessageKey;
    icon: ReactNode;
    code: string;
    manual: MessageKey;
  }> = [
    {
      id: "opencode",
      title: "opencode",
      hint: "mcp.guideGlobalUser",
      icon: <Sparkles size={15} className="text-slate-400" />,
      code: mcp.snippet,
      manual: "mcp.manualOpencode",
    },
    {
      id: "zcode",
      title: "ZCode",
      hint: "mcp.guideZcodeHint",
      icon: <Zap size={15} className="text-slate-400" />,
      code: JSON.stringify(
        { mcp: { servers: { tapd: { type: "stdio", command: commandPath } } } },
        null,
        2,
      ),
      manual: "mcp.manualZcode",
    },
    {
      id: "claude",
      title: "Claude Code",
      hint: "mcp.guideClaudeHint",
      icon: <Terminal size={15} className="text-slate-400" />,
      code: `claude mcp add --scope user --transport stdio tapd -- "${commandPath}"`,
      manual: "mcp.manualClaude",
    },
    {
      id: "cursor",
      title: "Cursor",
      hint: "mcp.guideCursorHint",
      icon: <FileJson size={15} className="text-slate-400" />,
      code: JSON.stringify({ mcpServers: { tapd: { command: commandPath } } }, null, 2),
      manual: "mcp.manualCursor",
    },
    // Codex 一键导入暂时下线：不展示入口，也不提示；后端 client spec 与
    // Agent 启动时的幂等注入保持原样，恢复时取消注释即可。
  ];

  const clientStatus = (id: McpClientId) =>
    mcp.clients.find((client) => client.id === id);

  return (
    <section className="space-y-2">
      <header className="px-1">
        <h3
          className="flex items-center gap-2 text-ui-base text-slate-900"
          title={t("mcp.importIntro")}
        >
          <Wrench size={15} className="text-slate-400" />
          {t("mcp.connectClients")}
        </h3>
      </header>

      {guides.map((guide) => {
        const status = clientStatus(guide.id);
        const clientPath = status?.path ?? null;
        const expanded = Boolean(expandedClients[guide.id]);
        const result = importResults[guide.id];
        return (
          <section
            key={guide.id}
            className="rounded-2xl border border-border bg-surface p-4"
          >
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                {guide.icon}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h4 className="text-ui-caption font-normal text-slate-900">
                      {guide.title}
                    </h4>
                    <Badge tone={status?.imported ? "green" : "amber"}>
                      {status?.imported ? t("mcp.imported") : t("mcp.notImported")}
                    </Badge>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1">
                    <p
                      className="select-text min-w-0 flex-1 truncate text-ui-xs text-slate-400"
                      title={clientPath ?? t(guide.hint)}
                    >
                      {clientPath ?? t(guide.hint)}
                    </p>
                    {clientPath ? (
                      <div className="flex shrink-0 items-center">
                        <button
                          type="button"
                          title={t("mcp.copyPath")}
                          aria-label={t("mcp.copyPath")}
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
                          title={t("mcp.openFolder")}
                          aria-label={t("mcp.openFolder")}
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
                  {status?.imported ? t("mcp.reimport") : t("mcp.importNow")}
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
                  {t("mcp.manualSetup")}
                </Button>
              </div>
            </div>

            {result ? (
              <div className="mt-2 break-all text-ui-xs leading-5 text-emerald-700">
                <CheckCircle2 size={11} className="mr-1 inline" />
                {result.changed
                  ? t("mcp.written", { path: result.path })
                  : t("mcp.alreadyPresent", { path: result.path })}
                {result.backupPath ? (
                  <span className="text-emerald-600/80">
                    {t("mcp.backupSuffix", { path: result.backupPath })}
                  </span>
                ) : null}
              </div>
            ) : null}

            {expanded ? (
              <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-ui-xs leading-5 text-slate-500">{t(guide.manual)}</p>
                  <button
                    type="button"
                    onClick={() => onCopy(guide.code)}
                    className={COPY_BUTTON}
                  >
                    <Copy size={10} />
                    {t("common.copy")}
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
    </section>
  );
}
