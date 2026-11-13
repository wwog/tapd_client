import { useState, type ReactNode } from "react";
import clsx from "clsx";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Bot,
  Bug,
  Check,
  Palette,
  Plug,
  Sparkles,
  Users,
} from "lucide-react";

import appIcon from "../assets/app-icon.png";
import { api, type AppInfo } from "../lib/api";
import { copyText } from "../lib/desktop";
import { t, type MessageKey } from "../lib/i18n";
import { ThemePicker } from "./AppearanceCard";
import { CoworkerGrid, useCoworkers } from "./CoworkerPicker";
import { McpClientImport } from "./McpClientImport";
import { Button, cardClass } from "./ui";

type Props = {
  info: AppInfo;
  onDone: () => void;
};

/* --------------------------------------------------------------------------
 * Tiny fake product shots. They are plain DOM/SVG so they stay crisp without
 * shipping extra screenshots.
 * ----------------------------------------------------------------------- */

function NotificationArt() {
  return (
    <div className="relative h-[120px] overflow-hidden rounded-xl bg-gradient-to-br from-slate-100 via-sky-50 to-surface p-3">
      <div className="absolute right-3 top-3 flex h-5 items-center gap-1 rounded-full bg-slate-900 px-2 text-[7px] text-slate-200 ">
        <span className="h-1 w-1 rounded-full bg-emerald-400" />
        {t("onboard.standby")}
      </div>
      <div className="mt-7 w-[82%] rounded-lg bg-slate-900 p-2  ">
        <div className="flex items-center gap-1">
          <span className="grid h-4 w-4 place-items-center rounded bg-sky-500 text-white">
            <Bug size={9} />
          </span>
          <span className="h-1 w-10 rounded bg-white/25" />
          <span className="ml-auto h-1 w-4 rounded bg-white/10" />
        </div>
        <div className="mt-1.5 h-1 w-full rounded bg-white/30" />
        <div className="mt-1 h-1 w-3/4 rounded bg-white/15" />
        <div className="mt-2 flex gap-1">
          <span className="h-3 flex-1 rounded bg-sky-500" />
          <span className="h-3 flex-1 rounded bg-white/10" />
        </div>
      </div>
      <span className="absolute right-5 top-12 h-2 w-2 rounded-full bg-rose-500 border-2 border-white" />
      <Bell size={13} className="absolute bottom-3 right-4 text-slate-300" />
    </div>
  );
}

function FocusArt() {
  return (
    <div className="h-[120px] overflow-hidden rounded-xl bg-gradient-to-br from-emerald-50 via-surface to-sky-50 p-2.5">
      <div className="flex h-full gap-1.5 rounded-lg bg-surface p-1.5  border border-border/70">
        <div className="flex w-6 flex-col items-center gap-1 rounded-md bg-slate-50 py-1">
          <span className="h-2 w-2 rounded bg-sky-400" />
          <span className="h-2 w-2 rounded bg-slate-200" />
          <span className="h-2 w-2 rounded bg-slate-200" />
          <span className="mt-auto h-3 w-3 rounded-full bg-gradient-to-br from-sky-400 to-emerald-400" />
        </div>
        <div className="flex w-[74px] flex-col gap-1">
          <span className="h-1 w-8 rounded bg-slate-300" />
          <span className="mt-0.5 h-3.5 w-full rounded bg-sky-50 border border-sky-200" />
          <span className="h-3.5 w-full rounded bg-slate-50" />
          <span className="h-3.5 w-full rounded bg-slate-50" />
          <span className="h-3.5 w-4/5 rounded bg-slate-50" />
        </div>
        <div className="flex flex-1 flex-col gap-1 rounded-md bg-slate-50 p-1.5">
          <span className="h-1 w-9 rounded bg-slate-300" />
          <span className="h-1 w-full rounded bg-slate-200" />
          <span className="h-1 w-5/6 rounded bg-slate-200" />
          <span className="mt-auto h-3 w-10 rounded bg-slate-900/80" />
        </div>
      </div>
    </div>
  );
}

function FixArt() {
  return (
    <div className="relative h-[120px] overflow-hidden rounded-xl bg-gradient-to-br from-sky-50 via-surface to-violet-50">
      <div className="absolute left-3 top-1/2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-2xl bg-surface  border border-border">
        <div className="relative">
          <Bot size={26} className="text-slate-800" strokeWidth={1.8} />
          <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-400" />
        </div>
      </div>
      <div className="absolute right-3 top-1/2 w-28 -translate-y-1/2 rounded-lg bg-slate-900 p-2  ">
        <div className="h-1 w-10 rounded bg-white/30" />
        <div className="mt-1 h-1 w-16 rounded bg-white/15" />
        <div className="mt-2 inline-flex h-4 items-center gap-1 rounded bg-emerald-400 px-1.5 text-[6px] font-normal text-slate-900">
          <Sparkles size={7} />
          {t("onboard.autoFix")}
        </div>
      </div>
    </div>
  );
}

function AgentArt() {
  const rows: Array<{ title: string; state: string; ink: string; dot: string }> = [
    { title: "BUG-1024", state: t("onboard.agentRunning"), ink: "text-sky-600", dot: "bg-sky-500" },
    { title: "BUG-1019", state: t("onboard.awaitingReview"), ink: "text-amber-600", dot: "bg-amber-500" },
    { title: "BUG-1012", state: t("onboard.writtenBack"), ink: "text-emerald-600", dot: "bg-emerald-500" },
  ];

  return (
    <div className="h-[120px] overflow-hidden rounded-xl bg-gradient-to-br from-sky-50 via-surface to-slate-100 p-2.5">
      <div className="flex h-full flex-col gap-1 rounded-lg border border-border bg-surface p-2">
        <div className="flex items-center gap-1 text-[7px] text-slate-500">
          <Bot size={9} className="text-sky-500" />
          {t("onboard.internalAgent")}
          <span className="ml-auto rounded bg-sky-50 px-1 text-sky-600">
            {t("onboard.localRun")}
          </span>
        </div>
        {rows.map((row) => (
          <div
            key={row.title}
            className="flex items-center gap-1 rounded border border-border/60 px-1 py-0.5 text-[7px] text-slate-500"
          >
            <span className="font-mono text-slate-600">{row.title}</span>
            <span className={clsx("ml-auto", row.ink)}>{row.state}</span>
            <span className={clsx("h-1 w-1 rounded-full", row.dot)} />
          </div>
        ))}
        <div className="mt-auto flex items-center gap-1 text-[7px] text-slate-400">
          <Check size={8} className="text-emerald-500" />
          {t("onboard.writeBackHint")}
        </div>
      </div>
    </div>
  );
}

function CoworkerArt() {
  const people: Array<{ role: string; ink: string; bg: string }> = [
    { role: t("onboard.roleProduct"), ink: "text-amber-600", bg: "bg-amber-500/15" },
    { role: t("onboard.roleFrontend"), ink: "text-sky-600", bg: "bg-sky-500/15" },
    { role: t("onboard.roleQa"), ink: "text-emerald-600", bg: "bg-emerald-500/15" },
  ];

  return (
    <div className="relative h-[120px] overflow-hidden rounded-xl bg-gradient-to-br from-amber-50 via-surface to-sky-50 p-2.5">
      <div className="flex h-full flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          {people.map((person, index) => (
            <div
              key={person.role}
              className={clsx(
                "relative flex flex-1 flex-col items-center gap-1 rounded-lg border bg-surface py-1.5",
                index === 1 ? "border-sky-300" : "border-border",
              )}
            >
              <span
                className={clsx(
                  "grid h-6 w-6 place-items-center rounded-full",
                  person.bg,
                  person.ink,
                )}
              >
                <Users size={11} />
              </span>
              <span className={clsx("text-[7px]", person.ink)}>{person.role}</span>
              {index === 1 ? (
                <span className="absolute right-1 top-1 grid h-3 w-3 place-items-center rounded-full bg-sky-500 text-white">
                  <Check size={7} strokeWidth={3} />
                </span>
              ) : null}
            </div>
          ))}
        </div>
        <div className="flex items-center justify-center gap-1 rounded-md bg-slate-900 py-1 text-[7px] text-slate-200">
          <Sparkles size={7} className="text-emerald-300" />
          {t("onboard.skillPacks")}
        </div>
      </div>
    </div>
  );
}

function McpArt() {
  return (
    <div className="relative h-[120px] overflow-hidden rounded-xl bg-gradient-to-br from-slate-900 to-slate-800 p-3 text-slate-200">
      <span className="absolute left-3 top-2.5 rounded bg-white/5 px-1.5 py-1 font-mono text-[7px] text-slate-300">
        {"{ }"}
      </span>
      <span className="absolute bottom-2.5 left-3 rounded bg-white/5 px-1.5 py-1 font-mono text-[7px] text-slate-300">
        {"</>"}
      </span>
      <span className="absolute right-3 top-2.5 rounded bg-white/5 px-1.5 py-1 font-mono text-[7px] text-slate-300">
        AI
      </span>
      <span className="absolute left-1/2 top-1/2 grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-xl bg-sky-500 text-white  ">
        <Plug size={16} />
      </span>
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 180 108"
        fill="none"
        aria-hidden="true"
      >
        <path d="M25 25 L78 48" stroke="rgba(56,189,248,.35)" strokeWidth="1" />
        <path d="M25 84 L78 62" stroke="rgba(56,189,248,.25)" strokeWidth="1" />
        <path d="M155 25 L104 48" stroke="rgba(52,211,153,.3)" strokeWidth="1" />
      </svg>
    </div>
  );
}

const FEATURES: Array<{
  title: MessageKey;
  copy: MessageKey;
  art: ReactNode;
}> = [
  {
    title: "onboard.feature.notifications",
    copy: "onboard.feature.notificationsCopy",
    art: <NotificationArt />,
  },
  {
    title: "onboard.feature.focus",
    copy: "onboard.feature.focusCopy",
    art: <FocusArt />,
  },
  {
    title: "onboard.feature.fix",
    copy: "onboard.feature.fixCopy",
    art: <FixArt />,
  },
  {
    title: "onboard.internalAgent",
    copy: "onboard.feature.agentCopy",
    art: <AgentArt />,
  },
  {
    title: "onboard.feature.coworkers",
    copy: "onboard.feature.coworkersCopy",
    art: <CoworkerArt />,
  },
  {
    title: "onboard.feature.mcp",
    copy: "onboard.feature.mcpCopy",
    art: <McpArt />,
  },
];

const STEP_HEADINGS: Array<{ title: MessageKey; copy: MessageKey }> = [
  { title: "onboard.step.welcome", copy: "onboard.step.welcomeCopy" },
  { title: "onboard.step.setup", copy: "onboard.step.setupCopy" },
  { title: "onboard.step.coworkers", copy: "onboard.step.coworkersCopy" },
];

export function Onboarding({ info, onDone }: Props) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  const showNotice = (kind: "ok" | "error", text: string) => {
    setNotice({ kind, text });
    if (kind === "ok") {
      window.setTimeout(
        () => setNotice((current) => (current?.text === text ? null : current)),
        1600,
      );
    }
  };

  const coworkers = useCoworkers(showNotice);

  const finish = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await api.completeOnboarding();
      onDone();
    } catch (cause) {
      showNotice("error", String(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async (text: string) => {
    const copied = await copyText(text);
    showNotice(copied ? "ok" : "error", copied ? t("common.copied") : t("common.copyFailed"));
  };

  const heading = STEP_HEADINGS[step];
  const last = step === 2;

  return (
    <div className="fixed inset-0 z-[90] flex flex-col overflow-hidden bg-canvas text-slate-900">
      <header
        data-tauri-drag-region
        className="flex shrink-0 items-center gap-3 border-b border-border bg-surface pb-4 pl-[86px] pr-6 pt-5"
      >
        <div className="pointer-events-none grid h-10 w-10 shrink-0 place-items-center rounded-2xl border border-border bg-surface">
          <img
            src={appIcon}
            alt={t("settings.login.appName")}
            draggable={false}
            className="h-8 w-8 select-none object-contain"
          />
        </div>
        <div className="pointer-events-none min-w-0 flex-1">
          <div className="text-ui-2xs uppercase tracking-[0.16em] text-sky-600/70">
            TAPD Client · V{info.version}
          </div>
          <h1 className="truncate text-[19px] font-normal tracking-tight text-slate-900">
            {t(heading.title)}
          </h1>
          <p className="truncate text-ui-sm text-slate-500">{t(heading.copy)}</p>
        </div>
        <span className="pointer-events-none shrink-0 text-ui-xs tabular-nums text-slate-400">
          {step + 1} / 3
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-6">
        <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center">
          {step === 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => (
                <div
                  key={feature.title}
                  className="rounded-2xl border border-border bg-surface p-3 transition hover:border-slate-300"
                >
                  {feature.art}
                  <div className="mt-3 text-ui-base font-normal text-slate-900">
                    {t(feature.title)}
                  </div>
                  <div className="mt-0.5 text-ui-sm leading-5 text-slate-500">
                    {t(feature.copy)}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="mx-auto w-full max-w-4xl space-y-4">
              <section className={cardClass}>
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0 max-w-[260px]">
                    <h2 className="flex items-center gap-2 text-ui-base font-normal text-slate-900">
                      <Palette size={15} className="text-slate-400" />
                      {t("common.theme")}
                    </h2>
                    <p className="mt-1 text-ui-caption leading-5 text-slate-500">
                      {t("onboard.themeHint")}
                    </p>
                  </div>
                  <ThemePicker className="w-[420px] max-w-full" />
                </div>
              </section>

              <McpClientImport
                onCopy={(text) => void handleCopy(text)}
                toast={showNotice}
              />
            </div>
          ) : null}

          {step === 2 ? (
            <CoworkerGrid
              coworkers={coworkers.coworkers}
              selectedIds={coworkers.selectedIds}
              busy={coworkers.busy}
              loadError={coworkers.loadError}
              onRetry={() => void coworkers.reload()}
              onToggle={coworkers.toggle}
            />
          ) : null}
        </div>
      </div>

      <footer className="shrink-0 border-t border-border bg-surface px-6 py-3">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => void finish()}
              disabled={busy}
              className="text-ui-sm text-slate-400 transition hover:text-slate-600 disabled:opacity-40"
            >
              {t("common.skip")}
            </button>
            {notice ? (
              <span
                className={clsx(
                  "truncate text-ui-xs",
                  notice.kind === "ok" ? "text-emerald-600" : "text-rose-600",
                )}
                title={notice.text}
              >
                {notice.text}
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-1.5">
            {STEP_HEADINGS.map((_, index) => (
              <button
                key={index}
                type="button"
                aria-label={t("onboard.page", { n: index + 1 })}
                onClick={() => setStep(index)}
                className={clsx(
                  "h-1.5 rounded-full transition-all",
                  index === step
                    ? "w-5 bg-sky-500"
                    : "w-1.5 bg-slate-300 hover:bg-slate-400",
                )}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {step > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                icon={<ArrowLeft size={12} />}
                disabled={busy}
                onClick={() => setStep(step - 1)}
              >
                {t("common.back")}
              </Button>
            ) : null}
            {last ? (
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                onClick={() => void finish()}
                icon={<Check size={12} />}
              >
                {t("onboard.start")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => setStep(step + 1)}
                icon={<ArrowRight size={12} />}
              >
                {t("common.next")}
              </Button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
