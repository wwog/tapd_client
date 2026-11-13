import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Check, ChevronDown, ChevronUp, Eye, EyeOff, FolderGit2, FolderOpen } from "lucide-react";
import clsx from "clsx";

import { agentApi, type ProjectAgentConfig } from "../lib/agent";
import { api, type Workspace, type WorkspaceContext } from "../lib/api";
import { copyText } from "../lib/desktop";
import type { SettingsSectionProps } from "../lib/feature";
import { t } from "../lib/i18n";
import { useTauriSubscription } from "../lib/tauriEvent";
import { Button, cardClass, inputClass } from "./ui";
import { FolderPicker } from "./FolderPicker";

const emptyProject = (): ProjectAgentConfig => ({ repoPath: "", rule: "" });

/**
 * Project cards: each TAPD project carries its local repository folder and its
 * own agent rules. Everything saves on blur / on pick — there is no save button.
 */
export function ProjectSettings(props: {
  context: WorkspaceContext | null;
  hiddenWorkspaceIds: string[];
  onSetWorkspaceVisible: (id: string, visible: boolean) => void;
  toast: SettingsSectionProps["toast"];
}) {
  const { context, hiddenWorkspaceIds, onSetWorkspaceVisible, toast } = props;
  const visibleCount = (context?.workspaces ?? []).filter(
    (workspace) => !hiddenWorkspaceIds.includes(workspace.id),
  ).length;
  const [projects, setProjects] = useState<Record<string, ProjectAgentConfig>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const projectsRef = useRef<Record<string, ProjectAgentConfig>>({});
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    void agentApi
      .configGet()
      .then(({ config }) => setProjects(config.projects ?? {}))
      .catch((error) => toast("error", String(error)));
  }, [toast]);

  const persist = useCallback(
    async (next: Record<string, ProjectAgentConfig>) => {
      setProjects(next);
      try {
        const { config: updated } = await agentApi.configSet({ projects: next });
        setProjects(updated.projects ?? {});
      } catch (error) {
        toast("error", String(error));
      }
    },
    [toast],
  );

  /** Local edit only; the save happens on blur. */
  const edit = useCallback((workspaceId: string, patch: Partial<ProjectAgentConfig>) => {
    setProjects((current) => {
      const previous = current[workspaceId] ?? emptyProject();
      return {
        ...current,
        [workspaceId]: {
          repoPath: patch.repoPath ?? previous.repoPath,
          rule: patch.rule ?? previous.rule,
        },
      };
    });
  }, []);

  /** Copies a project ID; the row swaps in a check mark instead of a toast. */
  const copyWorkspaceId = async (id: string) => {
    if (!(await copyText(id))) {
      toast("error", t("common.copyFailed"));
      return;
    }
    setCopiedId(id);
    window.setTimeout(
      () => setCopiedId((current) => (current === id ? null : current)),
      1500,
    );
  };

  const save = useCallback(() => {
    void persist(projectsRef.current);
  }, [persist]);

  // Dropping a folder (or a file inside it) onto a project card sets its path.
  useTauriSubscription(
    () =>
      getCurrentWindow().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter") {
          setDragging(true);
          return;
        }
        if (payload.type === "leave") {
          setDragging(false);
          return;
        }
        if (payload.type !== "drop") return;
        setDragging(false);

        const path = payload.paths?.[0];
        if (!path) return;

        const ratio = window.devicePixelRatio || 1;
        const element = document.elementFromPoint(
          payload.position.x / ratio,
          payload.position.y / ratio,
        );
        const card = element?.closest?.("[data-project-id]") as HTMLElement | null;
        const workspaceId = card?.dataset.projectId;
        if (!workspaceId) return;

        void api
          .listDirs(path)
          .then((listing) => {
            void persist({
              ...projectsRef.current,
              [workspaceId]: {
                ...(projectsRef.current[workspaceId] ?? emptyProject()),
                repoPath: listing.path,
              },
            });
          })
          .catch((error) => toast("error", String(error)));
      }),
    [persist, toast],
  );

  // TAPD projects plus any project already configured but not in the list.
  const workspaces = useMemo<Workspace[]>(() => {
    const list = [...(context?.workspaces ?? [])];
    for (const id of Object.keys(projects)) {
      if (!list.some((workspace) => workspace.id === id)) {
        list.push({
          id,
          name: id,
          prettyName: id,
          category: "",
          status: "",
          logoColor: null,
          lastVisitedTime: null,
          jumpUrl: null,
        });
      }
    }
    return list;
  }, [context, projects]);

  const pickerProject = pickerFor ? projects[pickerFor] ?? emptyProject() : null;

  return (
    <section className={`${cardClass} @container`}>
      <h2
        className="flex items-center gap-2 text-ui-base text-slate-900"
        title={t("settings.projects.tooltip")}
      >
        <FolderGit2 size={15} className="text-slate-400" />
        {t("settings.projects.title")}
      </h2>

      {/* Container query, not viewport: the detail pane can squeeze this column
          while the window itself stays wide. One column until a card can hold
          its whole header row without clipping "规则". */}
      <div className="mt-3 grid grid-cols-1 gap-2 @[560px]:grid-cols-2">
        {workspaces.map((workspace) => {
          const project = projects[workspace.id] ?? emptyProject();
          const open = expanded[workspace.id] ?? false;
          const hasRule = project.rule.trim().length > 0;
          const hidden = hiddenWorkspaceIds.includes(workspace.id);

          return (
            <div
              key={workspace.id}
              data-project-id={workspace.id}
              className={clsx(
                "rounded-xl border bg-surface p-3 transition",
                open ? "border-sky-200 " : "border-slate-100",
                dragging && "border-dashed border-sky-300 bg-sky-50/40",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: workspace.logoColor || "#0ea5e9" }}
                />
                <span
                  className="min-w-0 flex-1 truncate text-ui-caption font-normal text-slate-800"
                  title={workspace.name}
                >
                  {workspace.name}
                </span>
                <button
                  type="button"
                  title={t("settings.projects.copyId")}
                  aria-label={t("settings.projects.copyId")}
                  onClick={() => void copyWorkspaceId(workspace.id)}
                  className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 font-mono text-ui-xs text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                >
                  <Check
                    size={10}
                    className={clsx(
                      "text-emerald-600 transition-opacity",
                      copiedId === workspace.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {workspace.id}
                </button>
                <button
                  type="button"
                  title={
                    hidden
                      ? t("settings.projects.show")
                      : visibleCount <= 1
                        ? t("settings.projects.keepOne")
                        : t("settings.projects.hide")
                  }
                  aria-label={hidden ? t("settings.projects.showAction") : t("settings.projects.hideAction")}
                  disabled={!hidden && visibleCount <= 1}
                  onClick={() => onSetWorkspaceVisible(workspace.id, hidden)}
                  className={clsx(
                    "grid h-6 w-6 shrink-0 place-items-center rounded-md transition",
                    hidden
                      ? "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                      : "text-sky-600 hover:bg-sky-50",
                    !hidden && visibleCount <= 1 && "cursor-not-allowed opacity-40",
                  )}
                >
                  {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((current) => ({ ...current, [workspace.id]: !open }))
                  }
                  className={clsx(
                    "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-ui-xs transition",
                    hasRule
                      ? "text-sky-600 hover:bg-sky-50"
                      : "text-slate-400 hover:bg-slate-50",
                  )}
                >
                  {t("settings.projects.rules")}
                  {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                </button>
              </div>

              <div className="mt-2">
                <div className="flex items-center justify-between text-ui-xs text-slate-400">
                  <span>{t("settings.projects.localFolder")}</span>
                  {project.repoPath ? (
                    <span className="truncate pl-2 font-mono text-ui-xs text-slate-400">
                      {project.repoPath.split("/").pop()}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <input
                    value={project.repoPath}
                    onChange={(event) =>
                      edit(workspace.id, { repoPath: event.target.value })
                    }
                    onBlur={save}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                    placeholder="/Users/you/projects/repo"
                    spellCheck={false}
                    className={`${inputClass} font-mono`}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<FolderOpen size={12} />}
                    onClick={() => setPickerFor(workspace.id)}
                  >
                    {t("settings.projects.choose")}
                  </Button>
                </div>
              </div>

              {open ? (
                <div className="mt-2">
                  <div className="text-ui-xs text-slate-400">{t("settings.projects.rulesTitle")}</div>
                  <textarea
                    value={project.rule}
                    onChange={(event) => edit(workspace.id, { rule: event.target.value })}
                    onBlur={save}
                    rows={4}
                    title={t("settings.projects.rulesTooltip")}
                    placeholder={t("settings.projects.rulesPlaceholder")}
                    className={`${inputClass} mt-1 resize-y leading-5`}
                  />
                </div>
              ) : null}
            </div>
          );
        })}

        {workspaces.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-3 text-ui-caption text-slate-400">
            {t("settings.projects.loadAfterLogin")}
          </div>
        ) : null}
      </div>

      <FolderPicker
        open={pickerFor !== null}
        initialPath={pickerProject?.repoPath}
        title={t("settings.projects.pickerTitle")}
        description={t("settings.projects.pickerDesc")}
        onCancel={() => setPickerFor(null)}
        onSelect={(path) => {
          const workspaceId = pickerFor;
          setPickerFor(null);
          if (!workspaceId) return;
          void persist({
            ...projectsRef.current,
            [workspaceId]: {
              ...(projectsRef.current[workspaceId] ?? emptyProject()),
              repoPath: path,
            },
          });
        }}
      />
    </section>
  );
}
