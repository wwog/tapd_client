import { useState } from "react";
import { ListChecks } from "lucide-react";

import { t } from "../lib/i18n";
import type { WorkItem, WorkItemImportance } from "../lib/local";
import { Dialog } from "./Dialog";
import { Segmented } from "./Segmented";
import { Button, inputClass } from "./ui";

export type LocalItemValues = {
  title: string;
  description: string;
  importance: WorkItemImportance;
};

/** Create / edit dialog for one local work item; only the title is required. */
export function LocalItemDialog(props: {
  /** `null` creates; an item edits it in place. */
  item: WorkItem | null;
  onClose: () => void;
  /** Rejects with the backend message, which stays visible in the dialog. */
  onSubmit: (values: LocalItemValues) => Promise<void>;
}) {
  const { item, onClose, onSubmit } = props;
  const [title, setTitle] = useState(item?.title ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [importance, setImportance] = useState<WorkItemImportance>(
    item?.importance ?? "normal",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = title.trim().length > 0;

  const save = async () => {
    if (!ready || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim(),
        importance,
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
      title={item ? t("local.items.edit") : t("local.items.create")}
      icon={<ListChecks size={15} className="text-slate-400" />}
      onClose={() => {
        if (!submitting) onClose();
      }}
    >
      <div className="space-y-1.5">
        <div className="text-ui-xs text-slate-400">{t("common.title")}</div>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("local.items.titlePlaceholder")}
          disabled={submitting}
          className={inputClass}
          autoFocus
        />
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="text-ui-xs text-slate-400">
          {t("local.items.importance")}
        </div>
        <Segmented<WorkItemImportance>
          value={importance}
          onChange={setImportance}
          options={[
            { value: "low", label: t("local.importance.low") },
            { value: "normal", label: t("local.importance.normal") },
            { value: "high", label: t("local.importance.high") },
          ]}
        />
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="text-ui-xs text-slate-400">
          {t("local.items.description")}
        </div>
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t("local.items.descriptionPlaceholder")}
          rows={5}
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
          disabled={!ready}
          title={!ready ? t("local.items.titleRequired") : undefined}
          onClick={() => void save()}
        >
          {t("common.save")}
        </Button>
      </div>
    </Dialog>
  );
}
