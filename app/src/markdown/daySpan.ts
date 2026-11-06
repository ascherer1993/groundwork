/**
 * A daily note's day block (a `todos` fence holding `day`) shows the todos
 * written beside it as its own: the task lists right above or below it, with
 * only blank lines between. Those lines are drawn inside the block rather
 * than on the page. A list that mixes tasks with other items stays on the
 * page.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*todos\s*$/i;
const TASK = /^(?:[-*+]|\d+[.)]) \[.\](?:\s|$)/;
const ITEM = /^(?:[-*+]|\d+[.)])(?:\s|$)/;

/** Whether a `todos` fence's text (fence lines included, or not) is a day view. */
export function isDayBlock(source: string): boolean {
  const first = source
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^(`{3,}|~{3,})/.test(l));
  return first?.toLowerCase() === "day";
}

/**
 * The lines (zero-based, inclusive) a day block at `start`–`end` takes over:
 * itself and the todos beside it. `line(i)` reads line `i` of `count`.
 */
export function daySpanAt(
  line: (i: number) => string,
  count: number,
  start: number,
  end: number,
): [number, number] {
  const blank = (i: number) => !line(i).trim();
  const inList = (i: number) => TASK.test(line(i)) || (/^\s/.test(line(i)) && !blank(i));

  let first = start;
  for (let i = start - 1; ;) {
    let bottom = i;
    while (bottom >= 0 && blank(bottom)) bottom--;
    let top = bottom;
    while (top >= 0 && inList(top)) top--;
    top++;
    // A run of lines that starts with a task, not continuing a list of other items.
    if (top > bottom || !TASK.test(line(top)) || (top > 0 && ITEM.test(line(top - 1)))) break;
    first = top;
    i = top - 1;
  }

  let last = end;
  for (let i = end + 1; ;) {
    let top = i;
    while (top < count && blank(top)) top++;
    if (top >= count || !TASK.test(line(top))) break;
    let bottom = top + 1;
    while (bottom < count && inList(bottom)) bottom++;
    if (bottom < count && ITEM.test(line(bottom))) break;
    last = bottom - 1;
    i = bottom;
  }
  return [first, last];
}

/** The first day block in `text` and the lines it takes over, if it has one. */
export function findDaySpan(text: string): [number, number] | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i]!.match(FENCE);
    if (!open) continue;
    const marker = open[1]!;
    const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end]!)) end++;
    end = Math.min(end, lines.length - 1);
    if (isDayBlock(lines.slice(i + 1, end).join("\n"))) {
      return daySpanAt((n) => lines[n]!, lines.length, i, end);
    }
    i = end;
  }
  return null;
}
