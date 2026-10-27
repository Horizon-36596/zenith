/** One thing wrong with an imported file: where, as a JSON path, and what, as a sentence. */
export interface ImportIssue {
  /** The JSON path of the offending value, such as `lines[2].endPoint.x`; empty for the whole file. */
  path: string;
  message: string;
}

/**
 * Thrown when a file cannot be imported at all. Every issue names the field it is about, so a
 * planner author can fix the file from the message alone.
 */
export class ImportError extends Error {
  readonly issues: readonly ImportIssue[];

  constructor(what: string, issues: readonly ImportIssue[]) {
    super(`Cannot import ${what}:\n${issues.map((issue) => `  ${issue.path === "" ? "(file)" : issue.path}: ${issue.message}`).join("\n")}`);
    this.name = "ImportError";
    this.issues = issues;
  }
}

/** Formats a JSON path from its keys: `["lines", 2, "endPoint"]` is `lines[2].endPoint`. */
export function jsonPath(keys: readonly (string | number)[]): string {
  let out = "";
  for (const key of keys) {
    if (typeof key === "number") out += `[${String(key)}]`;
    else out += out === "" ? key : `.${key}`;
  }
  return out;
}
