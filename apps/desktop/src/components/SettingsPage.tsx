import { useState } from "react";
import {
  Copy,
  FileJson,
  FolderOpen,
  Info,
  PackageOpen,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";

import { api, type AppInfo } from "../lib/api";
import { pickExportDir } from "../lib/exportDir";
import type { SettingsSectionProps } from "../lib/feature";
import { t } from "../lib/i18n";
import { PROJECT_URL } from "../lib/links";
import { AppearanceCard } from "./AppearanceCard";
import { CapturesPage } from "./CapturesPage";
import { CompanionCard } from "./CompanionCard";
import { Dialog } from "./Dialog";
import { NotificationSettings } from "./NotificationSettings";
import { Button, cardClass } from "./ui";

type Props = {
  info: AppInfo | null;
  onOpenPath: (path: string) => void;
  onCopy: (text: string) => void;
  onShowOnboarding: () => void;
  toast: SettingsSectionProps["toast"];
};

export function SettingsPage(props: Props) {
  const { info, onOpenPath, onCopy, onShowOnboarding, toast } = props;
  const [capturesOpen, setCapturesOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const clearLocalData = async () => {
    setClearing(true);
    try {
      await api.clearAppData();
    } catch (error) {
      setClearing(false);
      toast("error", String(error));
    }
  };

  const exportDiagnostics = async () => {
    setDiagnosing(true);
    try {
      const dir = await pickExportDir(info?.paths.exportsDir);
      if (!dir) return;
      const result = await api.exportDiagnostics(dir);
      // Opening the destination is the success signal; toasts stay reserved
      // for failures.
      onOpenPath(result.folder);
    } catch (error) {
      toast("error", String(error));
    } finally {
      setDiagnosing(false);
    }
  };

  const paths: Array<[string, string]> = info
    ? [
        [t("settings.paths.data"), info.paths.dataDir],
        [t("settings.paths.logs"), info.paths.logsDir],
        [t("settings.paths.captures"), info.paths.capturesDir],
        [t("settings.paths.exports"), info.paths.exportsDir],
        [t("settings.paths.config"), info.paths.configFile],
        ["runtime.json", info.paths.runtimeFile],
      ]
    : [];

  const runtimeEndpoint = info?.runtimePort
    ? `127.0.0.1:${info.runtimePort}`
    : t("common.notStarted");

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <AppearanceCard />

      <NotificationSettings toast={toast} />

      <CompanionCard toast={toast} />

      <section className={cardClass}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
              <ShieldCheck size={15} className="text-slate-400" />
              {t("settings.runtime.title")}
            </h2>
            <p className="mt-1 truncate text-ui-caption text-slate-500">
              {info
                ? `v${info.version} · MCP ${runtimeEndpoint}`
                : t("settings.runtime.reading")}
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDetailsOpen(true)}
            icon={<Info size={13} />}
          >
            {t("settings.runtime.viewDetails")}
          </Button>
        </div>
      </section>

      {detailsOpen ? (
        <Dialog
          title={t("settings.runtime.title")}
          icon={<ShieldCheck size={15} className="text-slate-400" />}
          onClose={() => setDetailsOpen(false)}
          action={
            <Button
              size="sm"
              onClick={() => void exportDiagnostics()}
              loading={diagnosing}
              icon={<PackageOpen size={13} />}
            >
              {t("settings.runtime.export")}
            </Button>
          }
        >
          <dl className="mt-3 space-y-1 text-ui-caption">
            <PlainRow label={t("common.version")} value={info?.version ?? "—"} onCopy={onCopy} />
            <PlainRow
              label={t("settings.runtime.mcpPort")}
              value={runtimeEndpoint}
              onCopy={onCopy}
            />
          </dl>

          <div className="mt-4 divide-y divide-slate-100">
            {paths.map(([label, value]) => (
              <div key={label} className="flex items-center gap-3 py-2 text-ui-caption">
                <span className="w-24 shrink-0 text-slate-400">{label}</span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-ui-sm text-slate-600"
                  title={value}
                >
                  {value}
                </span>
                <button
                  type="button"
                  onClick={() => onOpenPath(value)}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-ui-sm text-slate-600 transition hover:border-slate-300"
                >
                  <FolderOpen size={11} />
                </button>
                <button
                  type="button"
                  onClick={() => onCopy(value)}
                  className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 text-ui-sm text-slate-600 transition hover:border-slate-300"
                >
                  <Copy size={11} />
                </button>
              </div>
            ))}
          </div>
        </Dialog>
      ) : null}

      <section className={cardClass}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
              <FileJson size={15} className="text-slate-400" />
              {t("settings.captures.title")}
            </h2>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setCapturesOpen(true)}
            icon={<FileJson size={13} />}
          >
            {t("settings.captures.open")}
          </Button>
        </div>
      </section>

      <section className={cardClass}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
              <Sparkles size={15} className="text-slate-400" />
              {t("settings.onboarding.title")}
            </h2>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={onShowOnboarding}
            icon={<Sparkles size={13} />}
          >
            {t("settings.onboarding.view")}
          </Button>
        </div>
      </section>

            <section className={cardClass}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              className="flex items-center gap-2 text-ui-base text-slate-900"
              title={t("settings.localData.tooltip")}
            >
              <Trash2 size={15} className="text-slate-400" />
              {t("settings.localData.title")}
            </h2>
            {info ? (
              <p
                className="mt-1 truncate font-mono text-ui-sm text-slate-400"
                title={info.paths.dataDir}
              >
                {info.paths.dataDir}
              </p>
            ) : null}
          </div>
          {confirmClear ? (
            <div className="flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={clearing}
                onClick={() => setConfirmClear(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={clearing}
                onClick={() => void clearLocalData()}
              >
                {t("settings.clear.confirm")}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2 size={13} />}
              onClick={() => setConfirmClear(true)}
            >
              {t("settings.clear.action")}
            </Button>
          )}
        </div>
        {confirmClear ? (
          <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-600">
            {t("settings.clear.warning")}
          </p>
        ) : null}
      </section>

      <footer className="pb-2 pt-1 text-center">
        <button
          type="button"
          onClick={() => onOpenPath(PROJECT_URL)}
          title={t("settings.repo.openTooltip")}
          className="inline-flex items-center gap-1.5 text-ui-xs text-sky-600 transition hover:text-sky-700 hover:underline underline-offset-2"
        >
          <Star size={12} />
          {t("settings.repo.star")}
        </button>
      </footer>

      {capturesOpen ? (
        <Dialog
          title={t("settings.captures.title")}
          icon={<FileJson size={15} className="text-slate-400" />}
          onClose={() => setCapturesOpen(false)}
          size="wide"
        >
          <CapturesPage toast={toast} onOpenPath={onOpenPath} />
        </Dialog>
      ) : null}
    </div>
  );
}

function PlainRow(props: { label: string; value: string; onCopy: (text: string) => void }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <dt className="w-24 shrink-0 text-slate-400">{props.label}</dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-ui-sm text-slate-600">{props.value}</dd>
      <button
        type="button"
        onClick={() => props.onCopy(props.value)}
        className="text-slate-300 transition hover:text-slate-500"
      >
        <Copy size={11} />
      </button>
    </div>
  );
}

