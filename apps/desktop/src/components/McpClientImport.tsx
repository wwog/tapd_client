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
          <h3 className="text-ui-caption text-slate-900">接入 AI 客户端</h3>
        </header>
        {configError ? (
          <div className="mt-3 text-ui-caption text-slate-400">
            <p className="break-all">读取 MCP 配置失败：{configError}</p>
            <Button
              size="sm"
              className="mt-2"
              onClick={() => void loadConfig()}
              icon={<RefreshCw size={13} />}
            >
              重试
            </Button>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2 text-ui-caption text-slate-400">
            <Spinner />
            正在读取 MCP 配置…
          </div>
        )}
      </section>
    );
  }

  const commandPath = mcp.commandPath || "tapd-mcp";

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
          title="一键写入各客户端的用户级配置，改动前自动备份；只想对某个项目生效时，展开手动配置。"
        >
          <Wrench size={15} className="text-slate-400" />
          接入 AI 客户端
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
    </section>
  );
}
