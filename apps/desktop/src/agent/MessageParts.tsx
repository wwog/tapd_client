/**
 * Desktop re-export: message bubbles and meta live in the shared agent view
 * (`apps/shared/agent/MessageParts.tsx`) so desktop and companion render
 * identical chat parts. Host capabilities (Markdown, the usage chip, image
 * bytes) are injected once per page through `AgentHostProvider`.
 */
export { UserBubble, AnswerBlock, MessageMeta } from "../../../shared/agent/MessageParts";
