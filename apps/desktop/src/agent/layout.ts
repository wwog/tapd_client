/**
 * The one reading column shared by the transcript, the task pane, the view tab
 * row and the composer.
 *
 * The width is fluid up to a cap instead of a fixed 46rem: a wider window has
 * to show more of the conversation, while the surrounding `px-6` keeps a
 * minimum gutter on both sides. Every sibling uses this constant so the tabs,
 * the prose and the input never drift out of alignment.
 */
export const AGENT_COLUMN = "mx-auto w-full max-w-[56rem]";
