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
export const AGENT_COLUMN = "mx-auto w-full max-w-[clamp(46rem,55%,64rem)]";
