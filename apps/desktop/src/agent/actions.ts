/**
 * Desktop re-export: tool-call descriptions live in the shared agent view
 * (`apps/shared/agent/actions.ts`). `describeTool` / `runningVerb` gained a
 * trailing `locale` argument when they moved — copy comes from the shared
 * label catalogue instead of the desktop one.
 */
export {
  describeTool,
  runningVerb,
  reasoningPreview,
  type ToolAction,
} from "../../../shared/agent/actions";
