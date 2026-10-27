/**
 * Bug reports' limits and the one check the client and the web app share, on their own, as
 * `@horizon36596/zenith-cloud/bugReports`, so the web app's Report a bug dialog can check a report
 * before it sends one without loading the Firebase SDK that the package's main entry brings in. The
 * security rules check the same limits (cloud/firestore.rules, `bugReports/{reportId}`).
 */
import {
  BUG_REPORT_STATUSES,
  MAX_BUG_AUTO_FILE,
  MAX_BUG_EXPECTED,
  MAX_BUG_PROBLEMS,
  MAX_BUG_RECENT_ACTIONS,
  MAX_BUG_SETUP_TEXT,
  MAX_BUG_STEPS,
  MAX_BUG_WHAT_HAPPENED,
  MAX_BUG_WINDOW_PX,
  type BugReportSetup,
} from "./types.js";

export {
  BUG_REPORT_STATUSES,
  MAX_BUG_AUTO_FILE,
  MAX_BUG_EXPECTED,
  MAX_BUG_PROBLEMS,
  MAX_BUG_RECENT_ACTIONS,
  MAX_BUG_SETUP_TEXT,
  MAX_BUG_STEPS,
  MAX_BUG_WHAT_HAPPENED,
  MAX_BUG_WINDOW_PX,
};
export type { BugReportDoc, BugReportSetup, BugReportStatus } from "./types.js";

/** What a person sends: their three answers, the setup block and, if they chose, the auto file. */
export interface BugReportInput {
  whatHappened: string;
  /** Empty or absent when they did not say. */
  expected?: string;
  /** Empty or absent when they did not say. */
  steps?: string;
  setup: BugReportSetup;
  /** The open auto as canonical JSON, only when "Include a snapshot of my auto file" is ticked. */
  autoFile?: string;
}

const isText = (value: unknown, max: number): boolean => typeof value === "string" && value.length > 0 && value.length <= max;
const isWhole = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_BUG_WINDOW_PX;

/** The setup block's problem, or null when every field has the shape the rules accept. */
function setupProblem(setup: BugReportSetup): string | null {
  const ok =
    isText(setup.appVersion, MAX_BUG_SETUP_TEXT) &&
    (setup.surface === "web" || setup.surface === "desktop") &&
    typeof setup.hostMode === "boolean" &&
    isText(setup.browser, MAX_BUG_SETUP_TEXT) &&
    isText(setup.os, MAX_BUG_SETUP_TEXT) &&
    isWhole(setup.windowWidthPx) &&
    isWhole(setup.windowHeightPx) &&
    (setup.theme === "dark" || setup.theme === "light") &&
    (setup.cloudMode === "off" || setup.cloudMode === "fake" || setup.cloudMode === "firebase") &&
    typeof setup.problems === "string" &&
    setup.problems.length <= MAX_BUG_PROBLEMS &&
    typeof setup.recentActions === "string" &&
    setup.recentActions.length <= MAX_BUG_RECENT_ACTIONS;
  return ok ? null : "The setup details could not be read. Reload the page and try again.";
}

/**
 * Why the report cannot be sent as it is, as a sentence the dialog can show, or null when it can.
 * Lengths are counted in UTF-16 code units, as the rules count them.
 */
export function bugReportProblem(input: BugReportInput): string | null {
  const what = input.whatHappened.trim();
  if (what === "") return "Say what happened first.";
  if (what.length > MAX_BUG_WHAT_HAPPENED) return `What happened is too long: keep it under ${String(MAX_BUG_WHAT_HAPPENED)} characters.`;
  if ((input.expected ?? "").trim().length > MAX_BUG_EXPECTED) return `What you expected is too long: keep it under ${String(MAX_BUG_EXPECTED)} characters.`;
  if ((input.steps ?? "").trim().length > MAX_BUG_STEPS) return `The steps are too long: keep them under ${String(MAX_BUG_STEPS)} characters.`;
  if (input.autoFile !== undefined && input.autoFile.length > MAX_BUG_AUTO_FILE) {
    return `The auto file is too large to attach (over ${String(MAX_BUG_AUTO_FILE / 1000)} KB). Untick "Include a snapshot of my auto file" and describe it instead.`;
  }
  if (input.autoFile !== undefined && input.autoFile.length === 0) return "The auto file is empty. Untick \"Include a snapshot of my auto file\".";
  return setupProblem(input.setup);
}
