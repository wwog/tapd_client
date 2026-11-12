import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, Minus, Plus } from "lucide-react";

import { api, asApiError, type CompanionState } from "../lib/api";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  getPrefs,
  setPrefs,
  usePrefs,
  type ThemeMode,
} from "../lib/prefs";
import { navigate } from "../lib/router";
import { clearSession } from "../lib/session";

/** Static segmented control: the active segment gets a selected surface. */
function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={props.label}
      className="inline-flex rounded-lg border border-border bg-slate-50 p-0.5"
    >
      {props.options.map((option) => {
        const active = option.value === props.value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => props.onChange(option.value)}
            className={`rounded-md px-3 py-1 text-ui-sm transition ${
              active ? "bg-selected text-slate-900" : "text-slate-500"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function SettingRow(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-b-0">
      <span className="shrink-0 text-ui-caption text-slate-700">{props.label}</span>
      {props.children}
    </div>
  );
}

/** Companion preferences live only on this phone; the desktop is read-only. */
export function SettingsPage() {
  const prefs = usePrefs();
  const [state, setState] = useState<CompanionState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.state();
        if (!cancelled) setState(data);
      } catch (err) {
        if (!cancelled) setError(asApiError(err).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const back = () => {
    if (window.history.length > 1) window.history.back();
    else navigate("#/bugs");
  };

  const unpair = () => {
    if (!window.confirm("解除配对后需要重新扫码，确定解除？")) return;
    clearSession();
    navigate("#/pair");
  };

  return (
    <div className="pb-6">
      <header className="sticky top-0 z-20 flex items-center gap-1.5 border-b border-border bg-canvas px-2 py-2">
        <button
          type="button"
          aria-label="返回"
          onClick={back}
          className="rounded-md p-1.5 text-slate-500 transition active:bg-overlay-soft"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-ui-caption text-slate-900">设置</span>
      </header>

      <section className="mx-3 mt-3 rounded-2xl border border-border bg-surface px-4 py-1">
        <SettingRow label="主题">
          <Segmented<ThemeMode>
            label="主题"
            value={prefs.theme}
            onChange={(theme) => setPrefs({ theme })}
            options={[
              { value: "system", label: "跟随系统" },
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
            ]}
          />
        </SettingRow>
        <SettingRow label="字号">
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="减小字号"
              title="减小字号"
              disabled={prefs.fontSize <= FONT_SIZE_MIN}
              onClick={() => setPrefs({ fontSize: getPrefs().fontSize - 1 })}
              className="rounded-md border border-border bg-surface p-1 text-slate-500 transition active:bg-overlay-soft disabled:opacity-40"
            >
              <Minus size={14} />
            </button>
            <span className="w-10 text-center text-ui-caption text-slate-700 tabular-nums">
              {prefs.fontSize}px
            </span>
            <button
              type="button"
              aria-label="增大字号"
              title="增大字号"
              disabled={prefs.fontSize >= FONT_SIZE_MAX}
              onClick={() => setPrefs({ fontSize: getPrefs().fontSize + 1 })}
              className="rounded-md border border-border bg-surface p-1 text-slate-500 transition active:bg-overlay-soft disabled:opacity-40"
            >
              <Plus size={14} />
            </button>
          </div>
        </SettingRow>
      </section>

      <section className="mx-3 mt-3 rounded-2xl border border-border bg-surface px-4 py-1">
        {error ? (
          <p className="py-2.5 text-ui-caption text-rose-600">{error}</p>
        ) : (
          <>
            <SettingRow label="桌面端账号">
              <span className="min-w-0 truncate text-ui-caption text-slate-700">
                {state ? state.me ?? "—" : "…"}
              </span>
            </SettingRow>
            <SettingRow label="桌面端版本">
              <span className="text-ui-caption text-slate-700 tabular-nums">
                {state ? state.version : "…"}
              </span>
            </SettingRow>
            <SettingRow label="连接状态">
              <span className="text-ui-caption text-slate-700">
                {state ? (state.loggedIn ? "已登录" : "未登录") : "…"}
              </span>
            </SettingRow>
          </>
        )}
      </section>

      <div className="mx-3 mt-3">
        <button
          type="button"
          onClick={unpair}
          title="清除本机的配对会话，桌面端设备列表仍保留记录。"
          className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-ui-caption text-rose-600 transition active:bg-overlay-soft"
        >
          解除配对
        </button>
      </div>
    </div>
  );
}
