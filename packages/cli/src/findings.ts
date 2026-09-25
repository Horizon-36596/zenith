import { FINDING_HELP, type Finding, type FindingCode, type FindingHelp } from "@horizon36596/zenith-core";

export interface FileFindings {
  path: string;
  findings: Finding[];
  /** Full sentences from `@horizon36596/zenith-seasons` when the file's season plugin is missing or unknown. */
  seasonWarnings?: readonly string[];
}

const pad = (text: string, width: number): string =>
  text.length >= width ? text : text + " ".repeat(width - text.length);

/** A table a person reads. Every verb also has --json, so an agent never parses this. */
export function formatFindingsTable(files: readonly FileFindings[]): string {
  const lines: string[] = [];
  for (const file of files) {
    lines.push(file.path);
    if (file.findings.length === 0) {
      lines.push("  no findings");
    } else {
      const severityWidth = Math.max(...file.findings.map((finding) => finding.severity.length));
      const codeWidth = Math.max(...file.findings.map((finding) => finding.code.length));
      const stepWidth = Math.max(...file.findings.map((finding) => finding.stepId.length));
      for (const finding of file.findings) {
        lines.push(
          `  ${pad(finding.severity, severityWidth)}  ${pad(finding.code, codeWidth)}  ${pad(finding.stepId, stepWidth)}  ${finding.message}`,
        );
      }
    }
  }
  const errors = files.reduce(
    (sum, file) => sum + file.findings.filter((finding) => finding.severity === "error").length,
    0,
  );
  const warnings = files.reduce(
    (sum, file) => sum + file.findings.filter((finding) => finding.severity === "warning").length,
    0,
  );
  const plural = (count: number, word: string): string =>
    `${String(count)} ${word}${count === 1 ? "" : "s"}`;
  lines.push(`${plural(errors, "error")}, ${plural(warnings, "warning")}`);
  return lines.join("\n");
}

/** The distinct codes these files raise, in the order they first appear. */
export function codesIn(files: readonly FileFindings[]): FindingCode[] {
  const codes: FindingCode[] = [];
  for (const file of files) {
    for (const finding of file.findings) {
      if (!codes.includes(finding.code)) codes.push(finding.code);
    }
  }
  return codes;
}

/** `FINDING_HELP` for just the codes these files raise, for `validate --explain --json`. */
export const helpFor = (files: readonly FileFindings[]): Partial<Record<FindingCode, FindingHelp>> =>
  Object.fromEntries(codesIn(files).map((code) => [code, FINDING_HELP[code]]));

/**
 * `validate --explain`: what each code in the table means and how to fix it, once per code, in
 * the words the editor shows behind the code chip.
 */
export function formatExplanations(files: readonly FileFindings[]): string {
  const codes = codesIn(files);
  if (codes.length === 0) return "";
  const lines: string[] = ["", "What these findings mean"];
  for (const code of codes) {
    const help = FINDING_HELP[code];
    lines.push(`  ${code}: ${help.title}`);
    lines.push(`    ${help.means}`);
    lines.push(`    To fix it: ${help.fix}`);
  }
  return lines.join("\n");
}

export const countErrors = (files: readonly FileFindings[]): number =>
  files.reduce(
    (sum, file) => sum + file.findings.filter((finding) => finding.severity === "error").length,
    0,
  );
