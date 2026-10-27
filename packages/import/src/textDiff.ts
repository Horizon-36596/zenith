/**
 * A line diff of two texts, for previewing a change to a file before it is written (the
 * `robot.json` preview of `zenith import-commands` and of the editor's Import commands dialog).
 * Longest common subsequence over lines; plenty for files of a few hundred lines. Pure.
 */

export interface DiffLine {
  /** `" "` unchanged, `"-"` only in the old text, `"+"` only in the new one. */
  op: " " | "-" | "+";
  text: string;
  /** 1-based line numbers in the old and the new text; absent on the side the line is not in. */
  oldLine?: number;
  newLine?: number;
}

const splitLines = (text: string): string[] => {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** Every line of both texts, in order, marked unchanged, removed or added. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  // Trim the common head and tail first: an import usually touches a small part of the file.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const n = midA.length;
  const m = midB.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = lcs[i] as Uint32Array;
    const below = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = midA[i] === midB[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number);
    }
  }

  const out: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  const same = (text: string): void => {
    out.push({ op: " ", text, oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  };
  for (let i = 0; i < head; i += 1) same(a[i] as string);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      same(midA[i] as string);
      i += 1;
      j += 1;
    } else if (i < n && (j >= m || ((lcs[i + 1] as Uint32Array)[j] as number) >= ((lcs[i] as Uint32Array)[j + 1] as number))) {
      // Removals before additions, the way diff -u shows a changed line.
      out.push({ op: "-", text: midA[i] as string, oldLine });
      oldLine += 1;
      i += 1;
    } else {
      out.push({ op: "+", text: midB[j] as string, newLine });
      newLine += 1;
      j += 1;
    }
  }
  for (let k = a.length - tail; k < a.length; k += 1) same(a[k] as string);
  return out;
}

/**
 * The changed lines with `context` unchanged lines around each run, the way `diff -u` shows them;
 * `null` stands for the unchanged lines left out between two runs. Empty when nothing changed.
 */
export function diffHunks(lines: readonly DiffLine[], context = 3): Array<DiffLine | null> {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.op === " ") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k += 1) keep[k] = true;
  });
  const out: Array<DiffLine | null> = [];
  let skipped = false;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped && out.length > 0) out.push(null);
      skipped = false;
      out.push(line);
    } else {
      skipped = true;
    }
  });
  return out;
}

/** A diff as text: `+`, `-` and space-prefixed lines, with `...` where unchanged lines are left out. */
export function formatDiff(before: string, after: string, context = 3): string {
  return diffHunks(diffLines(before, after), context)
    .map((line) => (line === null ? "..." : `${line.op}${line.text}`))
    .join("\n");
}
