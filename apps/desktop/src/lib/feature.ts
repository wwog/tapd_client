import { invoke } from "@tauri-apps/api/core";

/**
 * Commands routed through `feature_router::dispatch`.
 *
 * Kept as a literal union so a typo fails at compile time; the Rust side has a
 * matching arm per name.
 */
export type FeatureCommandName =
  | "cache_bug_detail"
  | "cache_bug_list"
  | "cache_workspace_context"
  | "cache_workspace_members"
  | "coworker_list"
  | "coworker_select"
  | "local_item_create"
  | "local_item_delete"
  | "local_item_update"
  | "local_items_list"
  | "local_project_create"
  | "local_project_delete"
  | "local_project_update"
  | "local_projects_list"
  | "mcp_import_client"
  | "notification_ai_action"
  | "notification_ai_debug"
  | "notification_fix_bug"
  | "notification_handle"
  | "notification_ignore"
  | "notification_island_answer_focus"
  | "notification_island_expand"
  | "notification_island_peek"
  | "notification_island_visible"
  | "notification_open_bug"
  | "notification_open_main"
  | "notification_settings_get"
  | "notification_settings_set"
  | "notification_simulate"
  | "notification_start_drag"
  | "notification_state_get"
  | "notification_view"
  | "terminal_close"
  | "terminal_create"
  | "terminal_input"
  | "terminal_list"
  | "terminal_replay"
  | "terminal_resize";

/** Calls a feature command routed to the notification / agent / cache modules. */
export const featureCommand = <T>(
  name: FeatureCommandName,
  payload: unknown = {},
): Promise<T> => invoke<T>("feature_command", { name, payload });

export type ToastFn = (kind: "ok" | "error", text: string) => void;

export type SettingsSectionProps = {
  toast: ToastFn;
};
