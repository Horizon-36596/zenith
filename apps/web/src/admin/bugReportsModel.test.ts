/**
 * The admin page's Bug reports view model (`bugReportsModel.ts`): a row's title, the status filter and the
 * count line.
 */
import { describe, expect, it } from "vitest";
import type { BugReport } from "@horizon36596/zenith-cloud";
import { filterReports, reportCountWords, reportTitle } from "./bugReportsModel";

const report = (id: string, status: BugReport["status"], whatHappened = "It broke."): BugReport => ({
  id,
  reporter: "uid",
  createdAt: new Date("2026-09-30T12:00:00Z"),
  status,
  whatHappened,
  setup: {
    appVersion: "0.1.1", surface: "web", hostMode: false, browser: "Chrome 131", os: "Linux",
    windowWidthPx: 1280, windowHeightPx: 720, theme: "dark", cloudMode: "firebase", problems: "", recentActions: "",
  },
});

describe("the bug reports view", () => {
  it("titles a report by the first line of what happened, cut short with an ellipsis", () => {
    expect(reportTitle(report("a", "new", "\n  The path vanished.\nMore detail."))).toBe("The path vanished.");
    const long = reportTitle(report("b", "new", "x".repeat(200)), 20);
    expect(long).toHaveLength(20);
    expect(long.endsWith("…")).toBe(true);
  });

  it("filters by status and counts what it shows", () => {
    const reports = [report("a", "new"), report("b", "triaged"), report("c", "closed"), report("d", "new")];
    expect(filterReports(reports, "all").map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(filterReports(reports, "new").map((r) => r.id)).toEqual(["a", "d"]);
    expect(reportCountWords(2, 4)).toBe("2 of 4 reports");
    expect(reportCountWords(1, 1)).toBe("1 report");
  });
});
