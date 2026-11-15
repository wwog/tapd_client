import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Bot,
  ChevronRight,
  CircleCheck,
  Folder,
  FolderPlus,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Trash,
  type LucideIcon,
} from "lucide-react";

import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_TONES,
  api,
  asApiError,
  type AgentRuntimeDescriptor,
  type LocalProject,
  type WorkItem,
  type WorkItemStatus,
} from "../lib/api";
import { refreshAgentTasks, useAgentTasks } from "../lib/agentTasks";
import { relativeTime } from "../lib/format";
import { t, type MessageKey } from "../lib/i18n";
import { navigate } from "../lib/router";
import { Badge } from "../components/Badge";
import { BottomSheet } from "../components/BottomSheet";
import { DirectoryPickerSheet } from "../components/DirectoryPickerSheet";

/** Selected project survives tab switches and reloads; a `#/local?p=` link wins. */
const PROJECT_KEY = "companion.local.project";

const readStoredProject = (): string | null => {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
};

const storeProject = (id: string): void => {
  try {
    localStorage.setItem(PROJECT_KEY, id);
  } catch {
    // Private browsing: the selection stays session-local.
  }
};

const STATUS_TABS: ReadonlyArray<{ key: WorkItemStatus; label: MessageKey }> = [
  { key: "pending", label: "mobile.local.pending" },
  { key: "in_progress", label: "mobile.local.inProgress" },
  { key: "done", label: "mobile.local.done" },
];

const STATUS_LABELS: Record<WorkItemStatus, MessageKey> = {
  pending: "mobile.local.pending",
  in_progress: "mobile.local.inProgress",
  done: "mobile.local.done",
};

const STATUS_TONES: Record<WorkItemStatus, "neutral" | "blue" | "green"> = {
  pending: "neutral",
  in_progress: "blue",
  done: "green",
};

const EMPTY_STATES: Record<
  WorkItemStatus,
  { title: MessageKey; hint: MessageKey }
> = {
  pending: {
    title: "mobile.local.emptyPending",
    hint: "mobile.local.emptyPendingHint",
  },
  in_progress: {
    title: "mobile.local.emptyInProgress",
    hint: "mobile.local.emptyInProgressHint",
  },
  done: {
    title: "mobile.local.emptyDone",
    hint: "mobile.local.emptyDoneHint",
  },
};

/** Row inside the item sheet: one action per line, 44px tall. */
function SheetAction(props: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={`flex min-h-11 w-full items-center gap-2 rounded-lg border border-border bg-surface px-3 text-left text-ui-caption transition active:bg-overlay-soft disabled:opacity-40 ${
        props.danger ? "text-rose-700" : "text-slate-700"
      }`}
    >
      <Icon size={14} className="shrink-0 text-slate-400" />
      {props.label}
    </button>
  );
}

const primaryButton =
  "min-h-11 w-full rounded-lg bg-primary px-3 text-ui-sm text-primary-foreground transition active:bg-primary-hover disabled:opacity-50";

const textField =
  "mt-1.5 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-ui-caption text-slate-700 transition placeholder:text-slate-400 focus:border-sky-300 focus:outline-2 focus:outline-sky-200";

function ItemsSkeleton() {
  return (
    <div aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="border-b border-border px-4 py-3">
          <div className="h-4 w-3/4 animate-pulse rounded bg-overlay-soft" />
          <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-overlay-soft" />
        </div>
      ))}
    </div>
  );
}

/**
 * 事项 tab: local projects on the desktop machine and their work items.
 * Nothing here touches TAPD — a project is a folder, an item is a note, and
 * handing it to the Agent enqueues the same task pipeline a bug would.
 */
export function LocalPage(props: { projectId: string | null }) {
  const { state: agentState } = useAgentTasks();

  const [projects, setProjects] = useState<LocalProject[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  // `#/local?p=<id>` wins at mount; otherwise the remembered project is used.
  const [selection, setSelection] = useState<string | null>(props.projectId);

  const [status, setStatus] = useState<WorkItemStatus>("pending");
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);

  // New project: name + folder + optional rules, the folder comes from the
  // picker sheet.
  const [projectSheetOpen, setProjectSheetOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectRule, setProjectRule] = useState("");
  const [projectDir, setProjectDir] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);

  // Edit project: name + rules; the folder is changed on the desktop only.
  const [editProjectOpen, setEditProjectOpen] = useState(false);
  const [editProjectName, setEditProjectName] = useState("");
  const [editProjectRule, setEditProjectRule] = useState("");
  const [editProjectBusy, setEditProjectBusy] = useState(false);
  const [editProjectError, setEditProjectError] = useState<string | null>(null);

  // New item draft.
  const [addOpen, setAddOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // One sheet for view / edit / delete of the tapped item.
  const [activeItem, setActiveItem] = useState<WorkItem | null>(null);
  const [sheetMode, setSheetMode] = useState<"view" | "edit" | "delete">("view");
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [itemBusy, setItemBusy] = useState(false);
  const [itemError, setItemError] = useState<string | null>(null);

  // Hand to Agent: optional extra prompt + runtime.
  const [enqueueItem, setEnqueueItem] = useState<WorkItem | null>(null);
  const [extraPrompt, setExtraPrompt] = useState("");
  const [runtimes, setRuntimes] = useState<AgentRuntimeDescriptor[]>([]);
  const [runtimeId, setRuntimeId] = useState("");
  const [enqueueBusy, setEnqueueBusy] = useState(false);
  const [enqueueError, setEnqueueError] = useState<string | null>(null);

  const loadProjects = useCallback(() => {
    setProjectsError(null);
    void api
      .localProjects()
      .then((data) => setProjects(data.projects))
      .catch((err) => setProjectsError(asApiError(err).message));
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // A `#/local?p=<id>` navigation can land on the already-mounted page; adopt
  // the new route target without overriding a later in-page selection.
  useEffect(() => {
    if (props.projectId) setSelection(props.projectId);
  }, [props.projectId]);

  // Resolve the visible project once the list is known: keep a valid pick,
  // else the remembered one, else the newest project.
  useEffect(() => {
    if (!projects) return;
    setSelection((current) => {
      const known = (id: string | null) =>
        id && projects.some((project) => project.id === id) ? id : null;
      return known(current) ?? known(readStoredProject()) ?? projects[0]?.id ?? null;
    });
  }, [projects]);

  // Item requests are sequenced so a slow earlier project cannot overwrite a
  // newer one. `quiet` keeps the current list on screen while refetching.
  const itemsSeq = useRef(0);
  const loadItems = useCallback((projectId: string, quiet: boolean) => {
    const request = ++itemsSeq.current;
    if (!quiet) setItems(null);
    setItemsError(null);
    return api
      .localItems(projectId)
      .then((data) => {
        if (request === itemsSeq.current) setItems(data.items);
      })
      .catch((err) => {
        if (request === itemsSeq.current) setItemsError(asApiError(err).message);
      });
  }, []);

  useEffect(() => {
    if (!selection) {
      setItems(null);
      return;
    }
    void loadItems(selection, false);
  }, [selection, loadItems]);

  // The backend marks a linked item done when its Agent task succeeds, and
  // tasks leave the live feed once they finish. The item list is not polled,
  // so watch the feed: any task appearing, changing or dropping out refetches
  // quietly, keeping the current list on screen while it does.
  const agentSignature = useMemo(
    () =>
      (agentState?.tasks ?? [])
        .map((task) => `${task.id}:${task.status}`)
        .sort()
        .join("|"),
    [agentState],
  );
  const lastAgentSignature = useRef(agentSignature);

  useEffect(() => {
    if (lastAgentSignature.current === agentSignature) return;
    // The feed populating for the first time is not a status change; the
    // initial list load already reflects it.
    const firstFeed = lastAgentSignature.current === "";
    lastAgentSignature.current = agentSignature;
    if (firstFeed || !selection) return;
    void loadItems(selection, true);
  }, [agentSignature, selection, loadItems]);

  const project = projects?.find((row) => row.id === selection) ?? null;

  const counts = useMemo(() => {
    const list = items ?? [];
    return {
      pending: list.filter((item) => item.status === "pending").length,
      in_progress: list.filter((item) => item.status === "in_progress").length,
      done: list.filter((item) => item.status === "done").length,
    };
  }, [items]);

  const visible = useMemo(
    () => (items ?? []).filter((item) => item.status === status),
    [items, status],
  );

  /** Live status of the Agent task an item was handed to (terminal ones drop out). */
  const linkedTask = (item: WorkItem) =>
    item.agentTaskId
      ? (agentState?.tasks.find((task) => task.id === item.agentTaskId) ?? null)
      : null;

  const applyItem = (updated: WorkItem) => {
    setItems((current) => {
      if (!current) return null;
      // Same order the desktop returns: newest update first.
      return current
        .map((row) => (row.id === updated.id ? updated : row))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
    setActiveItem((current) => (current?.id === updated.id ? updated : current));
  };

  const selectProject = (id: string) => {
    setSelection(id);
    storeProject(id);
    // Keep the URL on the same project so a refresh or a shared link agrees.
    if (props.projectId !== id) navigate(`#/local?p=${encodeURIComponent(id)}`);
  };

  const openProjectSheet = () => {
    setProjectName("");
    setProjectRule("");
    setProjectDir(null);
    setProjectError(null);
    setProjectSheetOpen(true);
  };

  const submitProject = async () => {
    if (!projectDir || projectBusy) return;
    setProjectBusy(true);
    setProjectError(null);
    try {
      const { project: created } = await api.createLocalProject({
        name: projectName.trim() || null,
        repoPath: projectDir,
        rule: projectRule.trim(),
      });
      setProjects((current) => (current ? [...current, created] : [created]));
      selectProject(created.id);
      setProjectSheetOpen(false);
    } catch (err) {
      setProjectError(asApiError(err).message);
    } finally {
      setProjectBusy(false);
    }
  };

  const openEditProject = () => {
    if (!project) return;
    setEditProjectName(project.name);
    setEditProjectRule(project.rule ?? "");
    setEditProjectError(null);
    setEditProjectOpen(true);
  };

  const submitEditProject = async () => {
    if (!project || editProjectBusy) return;
    const name = editProjectName.trim();
    if (!name) return;
    setEditProjectBusy(true);
    setEditProjectError(null);
    try {
      const { project: updated } = await api.updateLocalProject(project.id, {
        name,
        rule: editProjectRule.trim(),
      });
      setProjects((current) =>
        current?.map((row) => (row.id === updated.id ? updated : row)) ?? current,
      );
      setEditProjectOpen(false);
    } catch (err) {
      setEditProjectError(asApiError(err).message);
    } finally {
      setEditProjectBusy(false);
    }
  };

  const openAddItem = () => {
    setDraftTitle("");
    setDraftDescription("");
    setAddError(null);
    setAddOpen(true);
  };

  const submitItem = async () => {
    if (!selection || addBusy) return;
    const title = draftTitle.trim();
    if (!title) return;
    setAddBusy(true);
    setAddError(null);
    try {
      const { item } = await api.createLocalItem({
        projectId: selection,
        title,
        description: draftDescription.trim() || null,
      });
      setItems((current) => (current ? [item, ...current] : [item]));
      setStatus(item.status);
      setAddOpen(false);
    } catch (err) {
      setAddError(asApiError(err).message);
    } finally {
      setAddBusy(false);
    }
  };

  const openItem = (item: WorkItem) => {
    setActiveItem(item);
    setSheetMode("view");
    setItemError(null);
    setEditTitle(item.title);
    setEditDescription(item.description ?? "");
  };

  const closeItem = () => {
    setActiveItem(null);
    setSheetMode("view");
    setItemError(null);
  };

  /** One mutation path for the item sheet; returns the fresh row or null. */
  const patchItem = async (
    item: WorkItem,
    patch: { title?: string; description?: string; status?: WorkItemStatus },
  ): Promise<WorkItem | null> => {
    if (itemBusy) return null;
    setItemBusy(true);
    setItemError(null);
    try {
      const { item: updated } = await api.updateLocalItem(item.id, patch);
      applyItem(updated);
      return updated;
    } catch (err) {
      setItemError(asApiError(err).message);
      return null;
    } finally {
      setItemBusy(false);
    }
  };

  const changeStatus = async (item: WorkItem, next: WorkItemStatus) => {
    const updated = await patchItem(item, { status: next });
    if (!updated) return;
    // The row left the current tab: follow it so the change stays visible.
    setStatus(updated.status);
    closeItem();
  };

  const saveEdit = async () => {
    if (!activeItem) return;
    const title = editTitle.trim();
    if (!title) return;
    const updated = await patchItem(activeItem, {
      title,
      // Empty string clears the description; the desktop treats it as a value.
      description: editDescription.trim(),
    });
    if (updated) setSheetMode("view");
  };

  const deleteItem = async () => {
    const item = activeItem;
    if (!item || itemBusy) return;
    setItemBusy(true);
    setItemError(null);
    try {
      await api.deleteLocalItem(item.id);
      setItems((current) => current?.filter((row) => row.id !== item.id) ?? null);
      closeItem();
    } catch (err) {
      setItemError(asApiError(err).message);
    } finally {
      setItemBusy(false);
    }
  };

  // Hand to Agent: load the runtime catalog and the desktop default per open.
  useEffect(() => {
    if (!enqueueItem) return;
    let cancelled = false;
    setExtraPrompt("");
    setEnqueueError(null);
    setRuntimes([]);
    setRuntimeId("");
    void Promise.all([api.agentConfig(), api.agentRuntimes()])
      .then(([config, catalog]) => {
        if (cancelled) return;
        setRuntimes(catalog.filter((runtime) => runtime.available));
        setRuntimeId(config.runtimeId);
      })
      .catch(() => {
        // Catalog unavailable: submit anyway and let the desktop pick.
      });
    return () => {
      cancelled = true;
    };
  }, [enqueueItem]);

  const submitEnqueue = async () => {
    if (!enqueueItem || enqueueBusy) return;
    setEnqueueBusy(true);
    setEnqueueError(null);
    try {
      const { item } = await api.enqueueLocalItem({
        id: enqueueItem.id,
        extraPrompt: extraPrompt.trim() || null,
        runtimeId: runtimeId || null,
      });
      // The desktop flips the item to in_progress; render that before leaving.
      applyItem(item);
      setEnqueueItem(null);
      if (selection) await loadItems(selection, true);
      await refreshAgentTasks();
      navigate("#/agent");
    } catch (err) {
      setEnqueueError(asApiError(err).message);
    } finally {
      setEnqueueBusy(false);
    }
  };

  const activeLinked = activeItem ? linkedTask(activeItem) : null;

  return (
    <div>
      <header className="sticky top-0 z-20 border-b border-border bg-canvas">
        <div className="flex items-center gap-2 px-4 pt-3 pb-2">
          <h1 className="text-ui-base text-slate-900">{t("mobile.local.title")}</h1>
          <button
            type="button"
            onClick={openProjectSheet}
            className="ml-auto inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft"
          >
            <FolderPlus size={14} />
            {t("mobile.local.newProject")}
          </button>
        </div>

        {project ? (
          <>
            <div className="flex items-center gap-2 px-4 pb-2">
              <select
                aria-label={t("mobile.local.projects")}
                title={project.repoPath}
                value={project.id}
                onChange={(event) => selectProject(event.target.value)}
                className="min-h-11 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 text-ui-sm text-slate-700 focus:outline-2 focus:outline-sky-200"
              >
                {projects?.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                aria-label={t("mobile.local.editProject")}
                title={t("mobile.local.editProject")}
                onClick={openEditProject}
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-slate-500 transition active:bg-overlay-soft"
              >
                <Pencil size={14} />
              </button>
              <button
                type="button"
                onClick={openAddItem}
                className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-border bg-surface px-2.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft"
              >
                <Plus size={14} />
                {t("mobile.local.add")}
              </button>
            </div>

            <div
              role="tablist"
              aria-label={t("mobile.local.statusTabs")}
              className="mx-4 mb-2 flex items-center rounded-lg border border-border bg-surface p-0.5"
            >
              {STATUS_TABS.map((tab) => {
                const active = status === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setStatus(tab.key)}
                    className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md text-ui-sm transition ${
                      active ? "bg-slate-100 text-slate-900" : "text-slate-500"
                    }`}
                  >
                    {t(tab.label)}
                    <span
                      className={`tabular-nums text-ui-2xs ${active ? "text-slate-500" : "text-slate-400"}`}
                    >
                      {counts[tab.key]}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : null}
      </header>

      {projectsError ? (
        <p className="px-4 py-3 text-ui-caption text-rose-600">{projectsError}</p>
      ) : null}

      {!projects && !projectsError ? <ItemsSkeleton /> : null}

      {projects && projects.length === 0 ? (
        <div
          className="grid place-items-center px-6 py-16 text-center"
          title={t("mobile.local.noProjectsHint")}
        >
          <p className="text-ui-lg text-slate-400">{t("mobile.local.noProjects")}</p>
        </div>
      ) : null}

      {itemsError ? (
        <p className="px-4 py-3 text-ui-caption text-rose-600">{itemsError}</p>
      ) : null}

      {project && items === null && !itemsError ? <ItemsSkeleton /> : null}

      {project && items !== null && visible.length === 0 ? (
        <p
          className="px-4 py-10 text-center text-ui-base text-slate-400"
          title={t(EMPTY_STATES[status].hint)}
        >
          {t(EMPTY_STATES[status].title)}
        </p>
      ) : null}

      {project
        ? visible.map((item) => {
            const linked = linkedTask(item);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => openItem(item)}
                className="flex min-h-11 w-full flex-col items-start border-b border-border px-4 py-3 text-left transition active:bg-overlay-soft"
              >
                <span className="line-clamp-2 w-full text-ui-caption text-slate-900">
                  {item.title}
                </span>
                {item.description ? (
                  <span className="mt-0.5 line-clamp-1 w-full text-ui-xs text-slate-500">
                    {item.description}
                  </span>
                ) : null}
                <span className="mt-1 flex w-full items-center gap-2 text-ui-xs text-slate-500">
                  {linked ? (
                    <Badge tone={AGENT_STATUS_TONES[linked.status]}>
                      {t(AGENT_STATUS_LABELS[linked.status])}
                    </Badge>
                  ) : null}
                  <span className="ml-auto shrink-0 text-slate-400">
                    {relativeTime(item.updatedAt)}
                  </span>
                </span>
              </button>
            );
          })
        : null}

      {/* -- 新建项目：可选名称 + 目录 ------------------------------------- */}
      <BottomSheet
        open={projectSheetOpen && !pickerOpen}
        title={t("mobile.local.newProject")}
        onClose={() => setProjectSheetOpen(false)}
        footer={
          <button
            type="button"
            disabled={!projectDir || projectBusy}
            onClick={() => void submitProject()}
            className={primaryButton}
          >
            {projectBusy ? t("mobile.local.creating") : t("mobile.local.create")}
          </button>
        }
      >
        <label className="block">
          <span className="text-ui-sm text-slate-500">{t("mobile.local.projectName")}</span>
          <input
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
            placeholder={t("mobile.local.projectNamePlaceholder")}
            className={textField}
          />
        </label>
        <div className="mt-3">
          <span className="text-ui-sm text-slate-500">{t("mobile.local.projectFolder")}</span>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="mt-1.5 flex min-h-11 w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-left text-ui-caption transition active:bg-overlay-soft"
          >
            <Folder size={14} className="shrink-0 text-slate-400" />
            <span
              className={`min-w-0 flex-1 truncate ${projectDir ? "text-slate-900" : "text-slate-400"}`}
              title={projectDir ?? undefined}
            >
              {projectDir ?? t("common.chooseFolder")}
            </span>
            <ChevronRight size={14} className="shrink-0 text-slate-400" />
          </button>
        </div>
        <label className="mt-3 block">
          <span className="text-ui-sm text-slate-500">{t("mobile.local.projectRule")}</span>
          <textarea
            value={projectRule}
            onChange={(event) => setProjectRule(event.target.value)}
            rows={3}
            placeholder={t("mobile.local.projectRulePlaceholder")}
            className={`${textField} resize-none leading-5`}
          />
        </label>
        {projectError ? (
          <p className="mt-3 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700">
            {projectError}
          </p>
        ) : null}
      </BottomSheet>

      {/* -- 编辑项目：名称 + 规则（文件夹只在桌面端改） -------------------- */}
      <BottomSheet
        open={editProjectOpen}
        title={t("mobile.local.editProject")}
        onClose={() => setEditProjectOpen(false)}
        footer={
          <button
            type="button"
            disabled={editProjectBusy || !editProjectName.trim()}
            onClick={() => void submitEditProject()}
            className={primaryButton}
          >
            {editProjectBusy ? t("common.saving") : t("common.save")}
          </button>
        }
      >
        <label className="block">
          <span className="text-ui-sm text-slate-500">{t("mobile.local.projectName")}</span>
          <input
            value={editProjectName}
            onChange={(event) => setEditProjectName(event.target.value)}
            className={textField}
          />
        </label>
        <div className="mt-3">
          <span className="text-ui-sm text-slate-500">{t("mobile.local.projectFolder")}</span>
          <p
            className="mt-1.5 truncate rounded-lg border border-border bg-surface px-2.5 py-2 font-mono text-ui-xs text-slate-500"
            title={project?.repoPath ?? ""}
          >
            {project?.repoPath ?? ""}
          </p>
        </div>
        <label className="mt-3 block">
          <span className="text-ui-sm text-slate-500">{t("mobile.local.projectRule")}</span>
          <textarea
            value={editProjectRule}
            onChange={(event) => setEditProjectRule(event.target.value)}
            rows={4}
            placeholder={t("mobile.local.projectRulePlaceholder")}
            className={`${textField} resize-none leading-5`}
          />
        </label>
        {editProjectError ? (
          <p className="mt-3 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700">
            {editProjectError}
          </p>
        ) : null}
      </BottomSheet>

      <DirectoryPickerSheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(path) => {
          setProjectDir(path);
          setPickerOpen(false);
        }}
      />

      {/* -- 新增事项 ------------------------------------------------------ */}
      <BottomSheet
        open={addOpen}
        title={t("mobile.local.addItem")}
        onClose={() => setAddOpen(false)}
        footer={
          <button
            type="button"
            disabled={addBusy || !draftTitle.trim()}
            onClick={() => void submitItem()}
            className={primaryButton}
          >
            {addBusy ? t("mobile.local.adding") : t("mobile.local.add")}
          </button>
        }
      >
        <label className="block">
          <span className="text-ui-sm text-slate-500">{t("common.title")}</span>
          <input
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            placeholder={t("mobile.local.titlePlaceholder")}
            className={textField}
          />
        </label>
        <label className="mt-3 block">
          <span className="text-ui-sm text-slate-500">{t("mobile.local.description")}</span>
          <textarea
            value={draftDescription}
            onChange={(event) => setDraftDescription(event.target.value)}
            rows={4}
            placeholder={t("mobile.local.descriptionPlaceholder")}
            className={`${textField} resize-none leading-5`}
          />
        </label>
        {addError ? (
          <p className="mt-3 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700">
            {addError}
          </p>
        ) : null}
      </BottomSheet>

      {/* -- 事项动作 / 编辑 / 删除确认 ------------------------------------- */}
      <BottomSheet
        open={activeItem !== null}
        title={
          sheetMode === "edit"
            ? t("mobile.local.editItem")
            : (activeItem?.title ?? t("common.actions"))
        }
        onClose={closeItem}
        footer={
          sheetMode === "edit" ? (
            <button
              type="button"
              disabled={itemBusy || !editTitle.trim()}
              onClick={() => void saveEdit()}
              className={primaryButton}
            >
              {itemBusy ? t("common.saving") : t("common.save")}
            </button>
          ) : sheetMode === "delete" ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={itemBusy}
                onClick={() => setSheetMode("view")}
                className="min-h-11 shrink-0 rounded-lg border border-border bg-surface px-3 text-ui-sm text-slate-700 transition active:bg-overlay-soft disabled:opacity-40"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={itemBusy}
                onClick={() => void deleteItem()}
                className="min-h-11 min-w-0 flex-1 rounded-lg border border-rose-200 bg-rose-50 px-3 text-ui-sm text-rose-700 transition active:bg-overlay-soft disabled:opacity-40"
              >
                {itemBusy ? t("common.deleting") : t("common.delete")}
              </button>
            </div>
          ) : undefined
        }
      >
        {sheetMode === "edit" && activeItem ? (
          <>
            <label className="block">
              <span className="text-ui-sm text-slate-500">{t("common.title")}</span>
              <input
                value={editTitle}
                onChange={(event) => setEditTitle(event.target.value)}
                className={textField}
              />
            </label>
            <label className="mt-3 block">
              <span className="text-ui-sm text-slate-500">{t("mobile.local.description")}</span>
              <textarea
                value={editDescription}
                onChange={(event) => setEditDescription(event.target.value)}
                rows={5}
                placeholder={t("mobile.local.descriptionPlaceholder")}
                className={`${textField} resize-none leading-5`}
              />
            </label>
          </>
        ) : sheetMode === "delete" && activeItem ? (
          <>
            <p className="text-ui-caption text-slate-900">{activeItem.title}</p>
            <p className="mt-2 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700">
              {t("mobile.local.deleteConfirm")}
            </p>
          </>
        ) : activeItem ? (
          <>
            {activeItem.description ? (
              <p className="select-text break-words whitespace-pre-wrap text-ui-caption leading-5 text-slate-600">
                {activeItem.description}
              </p>
            ) : null}
            <p className="mt-2 flex flex-wrap items-center gap-2 text-ui-xs text-slate-500">
              <Badge tone={STATUS_TONES[activeItem.status]}>
                {t(STATUS_LABELS[activeItem.status])}
              </Badge>
              {activeLinked ? (
                <Badge tone={AGENT_STATUS_TONES[activeLinked.status]}>
                  {t(AGENT_STATUS_LABELS[activeLinked.status])}
                </Badge>
              ) : null}
              <span className="ml-auto shrink-0 text-slate-400">
                {relativeTime(activeItem.updatedAt)}
              </span>
            </p>
            <div className="mt-4 space-y-2">
              {activeItem.status !== "pending" && activeItem.agentTaskId ? (
                <SheetAction
                  icon={Bot}
                  label={t("mobile.local.openTask")}
                  onClick={() => {
                    if (activeItem.agentTaskId) {
                      navigate(`#/agent/task/${activeItem.agentTaskId}`);
                    }
                  }}
                />
              ) : null}
              {activeItem.status !== "done" ? (
                <SheetAction
                  icon={Bot}
                  label={t("mobile.local.toAgent")}
                  disabled={itemBusy}
                  onClick={() => {
                    const target = activeItem;
                    closeItem();
                    setEnqueueItem(target);
                  }}
                />
              ) : null}
              {activeItem.status === "pending" ? (
                <SheetAction
                  icon={ArrowRight}
                  label={t("mobile.local.moveToProgress")}
                  disabled={itemBusy}
                  onClick={() => void changeStatus(activeItem, "in_progress")}
                />
              ) : activeItem.status === "in_progress" ? (
                <SheetAction
                  icon={ArrowRight}
                  label={t("mobile.local.moveToPending")}
                  disabled={itemBusy}
                  onClick={() => void changeStatus(activeItem, "pending")}
                />
              ) : (
                <SheetAction
                  icon={RotateCcw}
                  label={t("mobile.local.reopen")}
                  disabled={itemBusy}
                  onClick={() => void changeStatus(activeItem, "pending")}
                />
              )}
              {activeItem.status !== "done" ? (
                <SheetAction
                  icon={CircleCheck}
                  label={t("mobile.local.markDone")}
                  disabled={itemBusy}
                  onClick={() => void changeStatus(activeItem, "done")}
                />
              ) : null}
              <SheetAction
                icon={Pencil}
                label={t("common.edit")}
                onClick={() => setSheetMode("edit")}
              />
              <SheetAction
                icon={Trash}
                label={t("common.delete")}
                danger
                disabled={itemBusy}
                onClick={() => setSheetMode("delete")}
              />
            </div>
          </>
        ) : null}
        {itemError ? (
          <p className="mt-3 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700">
            {itemError}
          </p>
        ) : null}
      </BottomSheet>

      {/* -- 交给 Agent：附加说明 + 运行时 -------------------------------- */}
      <BottomSheet
        open={enqueueItem !== null}
        title={t("mobile.local.toAgent")}
        onClose={() => setEnqueueItem(null)}
        footer={
          <button
            type="button"
            disabled={enqueueBusy}
            onClick={() => void submitEnqueue()}
            className={`${primaryButton} flex items-center justify-center gap-1.5`}
          >
            {enqueueBusy ? (
              <LoaderCircle size={13} className="animate-spin" />
            ) : (
              <Bot size={13} />
            )}
            {enqueueBusy ? t("mobile.local.enqueueing") : t("mobile.local.enqueue")}
          </button>
        }
      >
        {enqueueItem ? (
          <>
            <p className="text-ui-caption leading-5 text-slate-900">{enqueueItem.title}</p>
            <label className="mt-3 block">
              <span className="text-ui-sm text-slate-500">{t("mobile.local.extraPrompt")}</span>
              <textarea
                value={extraPrompt}
                onChange={(event) => setExtraPrompt(event.target.value)}
                rows={4}
                placeholder={t("mobile.local.extraPromptPlaceholder")}
                className={`${textField} resize-none leading-5`}
              />
            </label>
            <label className="mt-3 block">
              <span className="text-ui-sm text-slate-500" title={t("mobile.local.runtimeHint")}>
                {t("mobile.local.runtime")}
              </span>
              <select
                value={runtimeId}
                onChange={(event) => setRuntimeId(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-ui-caption text-slate-700 focus:outline-2 focus:outline-sky-200"
              >
                {runtimeId && !runtimes.some((runtime) => runtime.id === runtimeId) ? (
                  <option value={runtimeId}>{runtimeId}</option>
                ) : null}
                {runtimes.map((runtime) => (
                  <option key={runtime.id} value={runtime.id}>
                    {runtime.name}
                  </option>
                ))}
              </select>
            </label>
            {enqueueError ? (
              <p
                className="mt-3 rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700"
                title={t("mobile.local.enqueueFailedHint")}
              >
                {enqueueError}
              </p>
            ) : null}
          </>
        ) : null}
      </BottomSheet>
    </div>
  );
}
