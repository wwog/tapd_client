/** Every message group, merged into one catalogue. */
import { common } from "./common";
import { coworkers } from "./coworkers";
import { local } from "./local";
import { misc } from "./misc";
import { shell } from "./shell";
import { terminal } from "./terminal";
import { workspace } from "./workspace";

export const CATALOG = {
  ...common,
  ...coworkers,
  ...shell,
  ...terminal,
  ...workspace,
  ...local,
  ...misc,
} as const;

export type MessageKey = keyof typeof CATALOG;
