import { invoke } from "@tauri-apps/api/core";

/**
 * Every command handled by `feature_router::dispatch`.
 *
 * Kept as a literal union so a typo fails at compile time; the Rust side has a
 * matching arm per name.
 */
export type FeatureCommandName =
  | "agent_chat"
  | "agent_config_get"
  | "agent_config_set"
  | "agent_detect"
  | "agent_enqueue_bug"
  | "agent_enter_system"
  | "agent_input"
  | "agent_merge_start"
  | "agent_merge_verify"
  | "agent_models"
  | "agent_open_task"
  | "agent_open_terminal"
  | "agent_prompt_answer"
  | "agent_queue_resume"
  | "agent_resize"
  | "agent_review_approve"
  | "agent_review_stop"
  | "agent_runtimes"
  | "agent_scan"
  | "agent_save_resource"
  | "agent_send_message"
  | "agent_summary"
  | "agent_task_cancel"
  | "agent_task_changes"
  | "agent_task_delete"
  | "agent_task_diff"
  | "agent_task_retry"
  | "agent_tasks_history"
  | "agent_tasks_list"
  | "cache_bug_detail"
  | "cache_bug_list"
  | "cache_workspace_context"
  | "cache_workspace_members"
  | "chat_delete"
  | "chat_resume"
  | "chat_search"
  | "chat_sessions"
  | "chat_start"
  | "chat_stop"
  | "coworker_list"
  | "coworker_select"
  | "local_item_create"
  | "local_item_delete"
  | "local_item_enqueue"
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
