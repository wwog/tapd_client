import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import { t } from "../lib/i18n";
import { Dialog } from "./Dialog";
import { Button } from "./ui";

/**
 * Destructive confirm shared by the local project and work item deletions.
 * The action button runs the caller's request; the dialog stays open (and
 * keeps the error banner) until it resolves successfully.
 */
export function ConfirmDialog(props: {
  title: string;
  icon?: ReactNode;
  message: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const {
    title,
    icon,
    message,
    busy = false,
    onCancel,
    onConfirm,
  } = props;

  return (
    <Dialog
      title={title}
      icon={icon ?? <AlertTriangle size={15} className="text-rose-500" />}
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      <p className="text-ui-caption leading-6 text-slate-600">{message}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button size="sm" variant="danger" loading={busy} onClick={onConfirm}>
          {t("common.delete")}
        </Button>
      </div>
    </Dialog>
  );
}
