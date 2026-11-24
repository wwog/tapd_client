/**
 * Unified-diff projection for the review surfaces.
 *
 * The backend hands over raw `git diff` text (capped at the workspace's char
 * limit). A reviewer's first question is which lines changed and at what line
 * number, so this splits the text into rows carrying both numbers instead of
 * leaving it as one blob. File-level headers are dropped — the file row above
 * the diff already names the path — and the "no newline" marker is skipped.
 */

export type DiffRowKind = "hunk" | "add" | "del" | "context" | "note";

export type DiffRow = {
  kind: DiffRowKind;
  /** Old-file line number; absent on added lines and non-content rows. */
  oldNo?: number;
  /** New-file line number; absent on removed lines and non-content rows. */
  newNo?: number;
  /** The line's content without its diff prefix. */
  text: string;
};

/** `@@ -12,7 +12,9 @@ func()`: the hunk's starting numbers and its trailing context. */
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u;

/**
 * File-level headers. They only appear before a hunk starts, or between file
 * sections of a multi-file diff; a deletion whose content begins with `--` or
 * an insertion beginning with `++` stays content because it is inside a hunk.
 */
function isFileHeader(line: string): boolean {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("dissimilarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line.startsWith("copy from ") ||
    line.startsWith("copy to ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  );
}

/** Rows of one unified diff, in file order, with old/new line numbers. */
export function diffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  const lines = diff.split("\n");
  // A trailing newline leaves one empty tail element, not a content line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let sawHunk = false;

  for (const raw of lines) {
    const line = raw.replace(/\r$/u, "");
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      sawHunk = true;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    // "\ No newline at end of file" is a marker, not a line of either side.
    if (line.startsWith("\\")) continue;
    if (!inHunk) {
      if (!isFileHeader(line)) rows.push({ kind: "note", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", newNo, text: line.slice(1) });
      newNo += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "del", oldNo, text: line.slice(1) });
      oldNo += 1;
      continue;
    }
    // A context line is prefixed with one space; some writers emit the empty
    // line for an empty context line, which counts the same way.
    if (line.startsWith(" ") || line === "") {
      rows.push({ kind: "context", oldNo, newNo, text: line.slice(1) });
      oldNo += 1;
      newNo += 1;
      continue;
    }
    // Anything else ends the hunk: a new file section, a mode change, or a
    // note such as "Binary files … differ".
    inHunk = false;
    if (!isFileHeader(line)) rows.push({ kind: "note", text: line });
  }

  // A diff with no hunk at all is nothing but headers: a mode-only change
  // (`chmod`), or a binary note. Dropping those lines would leave the panel
  // claiming the file has no changes while the file row says it was modified,
  // so they are shown as plain notes instead.
  if (!sawHunk) {
    return lines
      .map((raw) => raw.replace(/\r$/u, ""))
      .filter((line) => line !== "")
      .map((line): DiffRow => ({ kind: "note", text: line }));
  }

  return rows;
}
