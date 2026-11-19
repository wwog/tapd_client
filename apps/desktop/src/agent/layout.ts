/**
 * The one reading column shared by the transcript, the task pane, the view tab
 * row and the composer.
 *
 * The width grows with the window between a minimum and a maximum instead of
 * being pinned at 46rem: a bigger window has to show more of the conversation,
 * while `clamp` keeps the prose readable on very wide screens. The surrounding
 * `px-6` still guarantees the minimum gutter. Every sibling uses this constant
 * so the tabs, the prose and the input never drift out of alignment.
 */
export const AGENT_COLUMN = "mx-auto w-full max-w-[clamp(46rem,68%,64rem)]";

/**
 * Session column sizing. The list yields to the conversation instead of
 * squeezing it: it is narrow by nature (titles truncate) while the transcript
 * is the page. `TASKLIST_CHAT_MIN_WIDTH` is the space the stream keeps before
 * the list folds itself away on a small window.
 */
export const TASKLIST_MIN_WIDTH = 200;
export const TASKLIST_MAX_WIDTH = 360;
export const TASKLIST_DEFAULT_WIDTH = 248;
export const TASKLIST_CHAT_MIN_WIDTH = 720;
