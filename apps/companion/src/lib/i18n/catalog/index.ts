/** Every message group, merged into one catalogue. */
import { agent } from "./agent";
import { common } from "./common";
import { misc } from "./misc";
import { shell } from "./shell";
import { terminal } from "./terminal";

export const CATALOG = { ...common, ...shell, ...agent, ...terminal, ...misc } as const;

export type MessageKey = keyof typeof CATALOG;
