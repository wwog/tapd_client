import { useEffect, useState } from "react";
import { Check, ChevronLeft, LoaderCircle, RefreshCw } from "lucide-react";

import { api, asApiError, type CoworkerList } from "../lib/api";
import { t } from "../lib/i18n";
import { navigate } from "../lib/router";

/** 同事包：多选后保存（coworker_select），对齐桌面 CoworkerPicker。 */
export function CoworkersPage() {
  const [data, setData] = useState<CoworkerList | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.coworkerList();
      setData(result);
      setDraft(result.selectedIds);
    } catch (err) {
      setLoadError(asApiError(err).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const toggle = (id: string) => {
    if (saving) return;
    setDraft((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const save = async () => {
    if (saving || !data) return;
    setSaving(true);
    try {
      const result = await api.coworkerSelect(draft);
      // 后端会丢弃未知 id；以服务端回执为准。
      setDraft(result.selectedIds);
      setSaveError(null);
      if (window.history.length > 1) window.history.back();
      else navigate("#/agent");
    } catch (err) {
      setSaveError(asApiError(err).message);
    } finally {
      setSaving(false);
    }
  };

  const back = () => {
    if (window.history.length > 1) window.history.back();
    else navigate("#/agent");
  };

  const coworkers = data?.coworkers ?? [];

  return (
    <div>
      <header className="sticky top-0 z-20 flex items-center gap-1.5 border-b border-border bg-canvas px-2 py-2">
        <button
          type="button"
          aria-label={t("mobile.nav.back")}
          onClick={back}
          className="rounded-md p-1.5 text-slate-500 transition active:bg-overlay-soft"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="min-w-0 flex-1 text-ui-caption text-slate-900">{t("magent.coworkers")}</span>
        <span
          className="shrink-0 text-ui-xs text-slate-400"
          title={t("magent.coworkersSelectedHint")}
        >
          {t("magent.selectedCount", { n: draft.length })}
        </span>
      </header>

      {loadError ? (
        <div className="px-4 py-6">
          <p className="rounded-lg border border-rose-100 bg-rose-50 px-3 py-2 text-ui-sm leading-5 text-rose-700">
            {loadError}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-sm text-slate-700 transition active:bg-overlay-soft"
          >
            <RefreshCw size={13} />
            {t("magent.reload")}
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-ui-caption text-slate-400">
          <LoaderCircle size={14} className="animate-spin" />
          {t("magent.coworkersLoading")}
        </div>
      ) : null}

      {!loading && !loadError && coworkers.length === 0 ? (
        <p
          className="px-4 py-10 text-center text-ui-base text-slate-400"
          title={t("magent.coworkersEmptyHint")}
        >
          {t("magent.coworkersEmpty")}
        </p>
      ) : null}

      {!loading && coworkers.length > 0 ? (
        <div className="space-y-3 px-3 py-3">
          {coworkers.map((coworker) => {
            const selected = draft.includes(coworker.id);
            const accent = coworker.accent || "";
            const hiddenSkills = coworker.skills.length - 3;
            return (
              <button
                key={coworker.id}
                type="button"
                aria-pressed={selected}
                disabled={saving}
                onClick={() => toggle(coworker.id)}
                className={`block w-full rounded-2xl border-2 p-4 text-left transition active:bg-overlay-soft disabled:opacity-70 ${
                  selected ? "border-sky-300 bg-sky-50" : "border-border bg-surface"
                }`}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-overlay-soft"
                    style={accent ? { backgroundColor: `${accent}16` } : undefined}
                  >
                    {coworker.avatar ? (
                      <img src={coworker.avatar} alt="" className="h-10 w-10 object-cover" />
                    ) : (
                      <span className="text-ui-base text-slate-500">{coworker.name.slice(0, 1)}</span>
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 truncate text-ui-caption text-slate-900">
                        {coworker.name}
                      </span>
                      {coworker.role ? (
                        <span
                          className="shrink-0 rounded-full px-1.5 py-0.5 text-ui-2xs"
                          style={
                            accent ? { color: accent, backgroundColor: `${accent}16` } : undefined
                          }
                        >
                          {coworker.role}
                        </span>
                      ) : null}
                      {selected ? (
                        <Check size={14} className="ml-auto shrink-0 text-sky-600" />
                      ) : null}
                    </div>
                    {coworker.title ? (
                      <div className="mt-0.5 truncate text-ui-xs text-slate-400" title={coworker.title}>
                        {coworker.title}
                      </div>
                    ) : null}
                  </div>
                </div>
                {coworker.description ? (
                  <p
                    className="mt-2 line-clamp-2 text-ui-sm leading-5 text-slate-600"
                    title={coworker.description}
                  >
                    {coworker.description}
                  </p>
                ) : null}
                {coworker.skills.length > 0 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1">
                    {coworker.skills.slice(0, 3).map((skill) => (
                      <span
                        key={skill.path}
                        title={skill.description || skill.path}
                        className="max-w-[140px] truncate rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-ui-2xs text-slate-500"
                      >
                        {skill.name}
                      </span>
                    ))}
                    {hiddenSkills > 0 ? (
                      <span className="rounded-full border border-slate-200 px-2 py-0.5 text-ui-2xs text-slate-400">
                        +{hiddenSkills}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <span className="mt-2 block text-ui-2xs text-slate-300">{t("magent.noSkills")}</span>
                )}
              </button>
            );
          })}
        </div>
      ) : null}

      {saveError ? (
        <p
          className="px-4 pb-3 text-ui-caption text-rose-600"
          title={t("magent.saveFailed")}
        >
          {saveError}
        </p>
      ) : null}

      {coworkers.length > 0 ? (
        <div className="sticky bottom-14 z-10 border-t border-border bg-canvas px-3 py-2.5">
          <button
            type="button"
            disabled={saving}
            title={t("magent.saveHint")}
            onClick={() => void save()}
            className="w-full rounded-lg bg-primary px-3 py-2 text-ui-caption text-primary-foreground transition active:bg-primary-hover disabled:opacity-50"
          >
            {saving ? t("magent.saving") : t("common.save")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
