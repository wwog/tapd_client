import { invoke } from "@tauri-apps/api/core";

/**
 * Every command handled by `feature_router::dispatch`.
 *
 * Kept as a literal union so a typo fails at compile time; the Rust side has a
 * matching arm per name.
 */
export type FeatureCommandName =
  | "agent_config_get"
  | "agent_config_set"
  | "agent_detect"
  | "agent_enqueue_bug"
  | "agent_external_release"
  | "agent_input"
  | "agent_message_chunk"
  | "agent_open_session"
  | "agent_open_task"
  | "agent_permission_option"
  | "agent_permission_reply"
  | "agent_queue_resume"
  | "agent_resize"
  | "agent_review_approve"
  | "agent_review_diff"
  | "agent_review_stop"
  | "agent_runtimes"
  | "agent_save_resource"
  | "agent_summary"
  | "agent_task_cancel"
  | "agent_task_log"
  | "agent_task_retry"
  | "agent_tasks_history"
  | "agent_tasks_list"
  | "agent_thought_chunk"
  | "cache_bug_detail"
  | "cache_bug_list"
  | "cache_workspace_context"
  | "cache_workspace_members"
  | "mcp_import_client"
  | "notification_ai_action"
  | "notification_ai_debug"
  | "notification_handle"
  | "notification_ignore"
  | "notification_island_expand"
  | "notification_island_visible"
  | "notification_open_main"
  | "notification_settings_get"
  | "notification_settings_set"
  | "notification_simulate"
  | "notification_start_drag"
  | "notification_state_get"
  | "notification_view";

/** Calls a feature command routed to the notification / agent / cache modules. */
export const featureCommand = <T>(
  name: FeatureCommandName,
  payload: unknown = {},
): Promise<T> => invoke<T>("feature_command", { name, payload });

export type ToastFn = (kind: "ok" | "error", text: string) => void;

export type SettingsSectionProps = {
  toast: ToastFn;
};
