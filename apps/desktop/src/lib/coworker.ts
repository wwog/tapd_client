import { featureCommand } from "./feature";

/** One skill package inside a coworker folder. */
export type CoworkerSkill = {
  name: string;
  description: string;
  /** Absolute path to SKILL.md, injected into the prompt. */
  path: string;
};

/** A bundled coworker as shown on the 同事 page. */
export type Coworker = {
  /** Folder name; the only stable id. */
  id: string;
  name: string;
  role: string;
  title: string;
  description: string;
  /** `#rrggbb`, or empty when the package did not set one. */
  accent: string;
  /** Data URL, or null when the avatar could not be read. */
  avatar: string | null;
  skills: CoworkerSkill[];
};

export type CoworkerList = {
  coworkers: Coworker[];
  /** Enabled ids in selection order. */
  selectedIds: string[];
  /** Exact block appended to the task prompt; empty when nobody is enabled. */
  promptSection: string;
  /** Packages/skills that failed validation; surfaced on the page. */
  warnings: string[];
};

export const coworkerApi = {
  list: () => featureCommand<CoworkerList>("coworker_list"),
  /** Replaces the enabled set; unknown ids are dropped by the backend. */
  select: (ids: string[]) =>
    featureCommand<{ selectedIds: string[]; promptSection: string }>(
      "coworker_select",
      { ids },
    ),
};
