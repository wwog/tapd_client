/**
 * Every message group, merged into one catalogue. Spread order does not matter
 * because keys are globally unique; the checker fails on duplicates.
 */
import { agent } from "./agent";
import { bugs } from "./bugs";
import { common } from "./common";
import { explorer } from "./explorer";
import { layout } from "./layout";
import { local } from "./local";
import { misc } from "./misc";
import { settings } from "./settings";
import { shell } from "./shell";
import { terminal } from "./terminal";
import { workbench } from "./workbench";

export const CATALOG = {
  ...common,
  ...agent,
  ...shell,
  ...settings,
  ...bugs,
  ...workbench,
  ...terminal,
  ...layout,
  ...explorer,
  ...local,
  ...misc,
} as const;

export type MessageKey = keyof typeof CATALOG;
