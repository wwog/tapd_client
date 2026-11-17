/**
 * Host re-export of the shared agent chat view: the mobile session page
 * renders exactly the TurnBlock / bubbles the desktop renders. The local
 * placeholder implementation (and its private copy table) was removed once
 * the shared view landed in `apps/shared/agent`.
 */
export { TurnBlock, type LiveTrace } from "../../../../shared/agent/TurnBlock";
export {
  UserBubble,
  AnswerBlock,
  MessageMeta,
} from "../../../../shared/agent/MessageParts";
