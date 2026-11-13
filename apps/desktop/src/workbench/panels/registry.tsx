/**
 * Panel registry: one definition per panel kind. Adding a panel type is a
 * registry entry plus a component — the split tree, tab strip and drag layer
 * stay untouched.
 */
import type { ReactNode } from "react";
import {
  Bot,
  Bug,
  FileCode2,
  FolderGit2,
  FolderTree,
  Plug,
  Settings as SettingsIcon,
  SquareTerminal,
  User,
  Users,
} from "lucide-react";

import { t, type MessageKey } from "../../lib/i18n";
import { PANEL_MIN_SIZE } from "../layout/defaults";
import type {
  PageView,
  PanelKind,
  PanelRef,
  PanelSize,
} from "../layout/types";
import { BugPanel } from "../panels/BugPanel";
import { FilePanel } from "../panels/FilePanel";
import { ExplorerPanel } from "../panels/ExplorerPanel";
import { PagePanel } from "../panels/PagePanel";
import { TerminalPanel } from "../panels/TerminalPanel";
import type { PanelProps } from "./context";

const PAGE_TITLES: Record<PageView, MessageKey> = {
  bugs: "common.bugs",
  projects: "common.projects",
  agent: "app.nav.agent",
  coworker: "app.nav.coworker",
  mcp: "app.nav.mcp",
  settings: "common.settings",
  account: "app.account.title",
};

const PAGE_ICONS: Record<PageView, ReactNode> = {
  bugs: <Bug size={13} />,
  projects: <FolderGit2 size={13} />,
  agent: <Bot size={13} />,
  coworker: <Users size={13} />,
  mcp: <Plug size={13} />,
  settings: <SettingsIcon size={13} />,
  account: <User size={13} />,
};

const basename = (path: string): string => path.split("/").pop() || path;

export type PanelDefinition = {
  kind: PanelKind;
  /** Tab label; `panel.label` captured at open time wins. */
  title: (panel: PanelRef) => string;
  icon: (panel: PanelRef) => ReactNode;
  minSize: PanelSize;
  /** Page tabs always stay; every other kind can be closed. */
  closable: boolean;
  /**
   * `id`: one tab per resource (files, terminals, pages).
   * `kind`: at most one tab of this kind in the whole layout (bug detail).
   */
  singleton: "id" | "kind";
  render: (props: PanelProps) => ReactNode;
};

export const PANEL_DEFINITIONS: Record<PanelKind, PanelDefinition> = {
  page: {
    kind: "page",
    title: (panel) =>
      panel.label ??
      (panel.resource.type === "page" ? t(PAGE_TITLES[panel.resource.view]) : t("common.bugs")),
    icon: (panel) =>
      panel.resource.type === "page" ? PAGE_ICONS[panel.resource.view] : PAGE_ICONS.bugs,
    minSize: PANEL_MIN_SIZE.page,
    closable: false,
    singleton: "id",
    render: (props) => <PagePanel {...props} />,
  },
  bug: {
    kind: "bug",
    title: (panel) =>
      panel.label ??
      (panel.resource.type === "bug" ? `#${panel.resource.bugId}` : t("layout.tab.bug")),
    icon: () => <Bug size={13} />,
    minSize: PANEL_MIN_SIZE.bug,
    closable: true,
    singleton: "kind",
    render: (props) => <BugPanel {...props} />,
  },
  explorer: {
    kind: "explorer",
    title: (panel) => panel.label ?? t("explorer.title"),
    icon: () => <FolderTree size={13} />,
    minSize: PANEL_MIN_SIZE.explorer,
    closable: true,
    singleton: "id",
    render: (props) => <ExplorerPanel {...props} />,
  },
  file: {
    kind: "file",
    title: (panel) =>
      panel.label ??
      (panel.resource.type === "file" ? basename(panel.resource.path) : t("explorer.fileFallback")),
    icon: () => <FileCode2 size={13} />,
    minSize: PANEL_MIN_SIZE.file,
    closable: true,
    singleton: "id",
    render: (props) => <FilePanel {...props} />,
  },
  terminal: {
    kind: "terminal",
    title: (panel) => panel.label ?? t("layout.tab.terminal"),
    icon: () => <SquareTerminal size={13} />,
    minSize: PANEL_MIN_SIZE.terminal,
    closable: true,
    singleton: "id",
    render: (props) => <TerminalPanel {...props} />,
  },
};
