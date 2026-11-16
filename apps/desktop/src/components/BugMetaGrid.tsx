import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

import type { BugDetail, WorkspaceMember } from "../lib/api";
import { ownerNames } from "../lib/bug";
import { t } from "../lib/i18n";
import { BugSectionTitle } from "./BugSectionTitle";

/** Read-only bug metadata plus the owner/developer pickers. */
export function BugMetaGrid(props: {
  detail: BugDetail;
  mine: boolean;
  members: WorkspaceMember[];
  membersLoading: boolean;
  savingField: string | null;
  onChangeField: (field: string, value: string) => void;
  onRefreshMembers: () => void;
}) {
  const {
    detail,
    mine,
    members,
    membersLoading,
    savingField,
    onChangeField,
    onRefreshMembers,
  } = props;

  const items: Array<[string, string]> = [
    [t("common.creator"), detail.creator || "—"],
    [t("common.created"), detail.created || "—"],
    [t("bugs.lastModified"), detail.modified || "—"],
    [t("bugs.foundVersionLabel"), detail.versionReport || "—"],
    [t("bugs.iteration"), detail.iterationName || "—"],
    [t("bugs.module"), detail.module || "—"],
    [t("bugs.fixer"), detail.fixer || "—"],
  ];

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-slate-100 bg-surface p-3 text-ui-caption sm:grid-cols-3">
      <UserField
        label={t("common.owner")}
        field="current_owner"
        value={detail.owner}
        mine={mine}
        members={members}
        membersLoading={membersLoading}
        saving={savingField === "current_owner"}
        onChange={onChangeField}
        onRefreshMembers={onRefreshMembers}
      />
      <UserField
        label={t("common.developer")}
        field="de"
        value={detail.de}
        mine={mine}
        members={members}
        membersLoading={membersLoading}
        saving={savingField === "de"}
        onChange={onChangeField}
        onRefreshMembers={onRefreshMembers}
      />
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-ui-xs text-slate-400">{label}</dt>
          <dd className="mt-0.5 truncate text-slate-700" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Collapsible custom fields; collapsed again on every drawer open. */
export function BugCustomFields(props: { detail: BugDetail; open: boolean }) {
  const { detail, open } = props;
  const [expanded, setExpanded] = useState(false);
  const customFields = Object.entries(detail.customFields).filter(
    ([, value]) => value.trim().length > 0,
  );

  // Reset the collapsible section each time the drawer is opened.
  useEffect(() => {
    if (!open) return;
    setExpanded(false);
  }, [open]);

  if (customFields.length === 0) return null;

  return (
    <section>
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-2 text-left"
      >
        <BugSectionTitle
          icon={
            expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          }
          title={t("bugs.customFields", { count: customFields.length })}
        />
      </button>
      {expanded ? (
        <dl className="mt-2 grid gap-2 rounded-xl border border-slate-100 bg-slate-50/60 p-3 text-ui-caption sm:grid-cols-2">
          {customFields.map(([key, value]) => (
            <div key={key} className="min-w-0">
              <dt className="truncate font-mono text-ui-xs text-slate-400">{key}</dt>
              <dd className="mt-0.5 break-words text-slate-700">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

/** Owner / developer cell: a picker for the owner, plain text otherwise. */
function UserField(props: {
  label: string;
  field: "current_owner" | "de";
  value: string;
  mine: boolean;
  members: WorkspaceMember[];
  membersLoading: boolean;
  saving: boolean;
  onChange: (field: string, value: string) => void;
  onRefreshMembers: () => void;
}) {
  const {
    label,
    field,
    value,
    mine,
    members,
    membersLoading,
    saving,
    onChange,
    onRefreshMembers,
  } = props;
  const current = value.trim();

  if (!mine) {
    return (
      <div className="min-w-0">
        <dt className="text-ui-xs text-slate-400">{label}</dt>
        <dd className="mt-0.5 truncate text-slate-700" title={current || "—"}>
          {current || "—"}
        </dd>
      </div>
    );
  }

  const optionNicks = Array.from(
    new Set([
      ...members.map((member) => member.nick).filter(Boolean),
      ...ownerNames(current),
      ...(current ? [current] : []),
    ]),
  );

  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-ui-xs text-slate-400">
        {label}
        {saving ? <Loader2 size={9} className="animate-spin" /> : null}
      </dt>
      <dd className="mt-0.5">
        <select
          value={current}
          disabled={saving}
          onChange={(event) => onChange(field, event.target.value)}
          onFocus={() => {
            if (members.length === 0 && !membersLoading) onRefreshMembers();
          }}
          title={t("bugs.chooseFromMembers")}
          className="w-full min-w-0 truncate rounded-md border border-border bg-surface px-1 py-0.5 text-ui-caption text-slate-700 transition focus:border-sky-400 focus:outline-2 focus:outline-sky-200 disabled:opacity-60"
        >
          {!current ? (
            <option value="">
              {membersLoading ? t("common.loadingEllipsis") : t("bugs.unspecified")}
            </option>
          ) : null}
          {optionNicks.map((nick) => (
            <option key={nick} value={nick}>
              {nick}
            </option>
          ))}
        </select>
      </dd>
    </div>
  );
}
