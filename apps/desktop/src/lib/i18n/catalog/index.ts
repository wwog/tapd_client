/**
 * Every message group, merged into one catalogue. Spread order does not matter
 * because keys are globally unique; the checker fails on duplicates.
 */
import { agent } from "./agent";
import { bugs } from "./bugs";
import { common } from "./common";
import { misc } from "./misc";
import { settings } from "./settings";
import { shell } from "./shell";
import { workbench } from "./workbench";

export const CATALOG = {
  ...common,
  ...shell,
  ...settings,
  ...bugs,
  ...agent,
  ...workbench,
  ...misc,
} as const;

export type MessageKey = keyof typeof CATALOG;
