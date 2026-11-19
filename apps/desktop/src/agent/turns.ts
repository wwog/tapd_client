/**
 * Desktop re-export: the turn grouping lives in the shared agent view
 * (`apps/shared/agent/turns.ts`) so desktop and companion render identical
 * turn blocks. The `TurnBlockModel` alias keeps every desktop import site
 * unchanged.
 */
export type {
  AgentTurnBlock as TurnBlock,
  AgentTurnBlock as TurnBlockModel,
} from "../../../shared/agent/types";
export { groupTurns } from "../../../shared/agent/turns";
