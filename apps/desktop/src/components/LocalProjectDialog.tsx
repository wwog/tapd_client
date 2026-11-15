import { useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, FolderPlus } from "lucide-react";

import { t } from "../lib/i18n";
import type { LocalProject } from "../lib/local";
import { Dialog } from "./Dialog";
import { FolderPicker } from "./FolderPicker";
import { Button, inputClass } from "./ui";

type Values = { name: string; repoPath: string; rule: string };

/**
 * Create / edit dialog for a local project. The name is optional (the backend
 * falls back to the folder basename on create); the folder is required, so the
 * save button stays disabled until one is set or typed.
 */
export function LocalProjectDialog(props: {
  /** `null` creates; a project edits it in place. */
  project: LocalProject | null;
  onClose: () => void;
  /** Rejects with the backend message, which stays visible in the dialog. */
  onSubmit: (values: Values) => Promise<void>;
}) {
  const { project, onClose, onSubmit } = props;
  const [name, setName] = useState(project?.name ?? "");
  const [repoPath, setRepoPath] = useState(project?.repoPath ?? "");
  const [rule, setRule] = useState(project?.rule ?? "");
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const title = project ? t("local.projects.edit") : t("local.projects.create");
  const pathReady = repoPath.trim().length > 0;

  const save = async () => {
    if (!pathReady || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        repoPath: repoPath.trim(),
        rule: rule.trim(),
      });
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      title={title}
      icon={<FolderPlus size={15} className="text-slate-400" />}
      onClose={() => {
        if (!submitting) onClose();
      }}
    >
      <div className="space-y-1.5">
        <div className="text-ui-xs text-slate-400">{t("local.projects.name")}</div>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("local.projects.nameHint")}
          disabled={submitting}
          className={inputClass}
          autoFocus
        />
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="text-ui-xs text-slate-400">{t("local.projects.folder")}</div>
        <div className="flex items-center gap-1.5">
          <input
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
            placeholder="/Users/you/projects/repo"
            spellCheck={false}
            disabled={submitting}
            className={`${inputClass} font-mono`}
          />
          <Button
            size="sm"
            variant="secondary"
            icon={<FolderOpen size={12} />}
            disabled={submitting}
            onClick={() => setPicking(true)}
          >
            {t("local.projects.chooseFolder")}
          </Button>
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="text-ui-xs text-slate-400">{t("local.projects.rule")}</div>
        <textarea
          value={rule}
          onChange={(event) => setRule(event.target.value)}
          placeholder={t("local.projects.rulePlaceholder")}
          title={t("local.projects.ruleHint")}
          rows={4}
          disabled={submitting}
          className={`${inputClass} resize-y leading-5`}
        />
      </div>

      {error ? (
        <p className="mt-3 break-all rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-600">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={submitting} onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={submitting}
          disabled={!pathReady}
          title={!pathReady ? t("local.projects.folderRequired") : undefined}
          onClick={() => void save()}
        >
          {t("common.save")}
        </Button>
      </div>

      {/* Portalled: the dialog panel clips its body and would otherwise own
          the picker's stacking context. */}
      {picking
        ? createPortal(
            <FolderPicker
              elevated
              open
              initialPath={repoPath.trim() || undefined}
              onCancel={() => setPicking(false)}
              onSelect={(path) => {
                setRepoPath(path);
                setPicking(false);
              }}
            />,
            document.body,
          )
        : null}
    </Dialog>
  );
}
