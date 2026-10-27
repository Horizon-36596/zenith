/**
 * The admin page's Bug reports view (`BugReports.tsx`): the words for a report's status, the title a
 * row shows and the filter. It reads nothing and draws nothing. Reports are private: only Horizon
 * admins read them (cloud/firestore.rules, `bugReports/{reportId}`).
 */
import type { BugReport, BugReportStatus } from "@horizon36596/zenith-cloud";

export const REPORT_STATUS_WORDS: Record<BugReportStatus, { label: string; meaning: string }> = {
  new: { label: "New", meaning: "Nobody has marked it yet." },
  triaged: { label: "Triaged", meaning: "A Horizon admin has read it and knows what to do next." },
  closed: { label: "Closed", meaning: "Nothing more will be done. The daily clean-up deletes it 30 days after it was closed." },
};

export type ReportFilter = "all" | BugReportStatus;

/** The first line of what happened, cut to `max` characters, as a row's title. */
export function reportTitle(report: Pick<BugReport, "whatHappened">, max = 90): string {
  const line = report.whatHappened.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** The reports the filter keeps, in the order given (newest first from the backend). */
export function filterReports(reports: readonly BugReport[], filter: ReportFilter): BugReport[] {
  return filter === "all" ? [...reports] : reports.filter((report) => report.status === filter);
}

/** "3 reports", or "1 of 4 reports" when a filter hides some. */
export function reportCountWords(shown: number, total: number): string {
  const noun = total === 1 ? "report" : "reports";
  return shown === total ? `${String(total)} ${noun}` : `${String(shown)} of ${String(total)} ${noun}`;
}
