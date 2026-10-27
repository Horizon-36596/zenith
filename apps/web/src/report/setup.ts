/**
 * What a bug report carries besides the person's own words (the Report a bug dialog, help.reportBug):
 * the setup block and, only when they tick it, the auto file. Pure, so the unit tests can hold it to
 * the privacy rules of spec 13 section 12, where the users are students and some are under 13:
 *
 * - The setup block holds the app's version, whether it is the web or desktop app and in host mode,
 *   the browser and system reduced to name and major version, the window size and theme, the cloud
 *   mode, the open file's findings (code and message) and the ids of the last actions run. Nothing
 *   else: no display name, email, age answer, team, device key, token or file path, and never the
 *   full user agent.
 * - Every path on the person's computer, in any field, becomes `[path]` before it is shown or sent.
 * - The auto file is attached only by choice ("Include a snapshot of my auto file"), without its
 *   `authors`, and refused, with a sentence, when it is larger than MAX_BUG_AUTO_FILE. It is the
 *   owner's one exception to "Horizon admins never see a team's paths" (2026-09-30).
 */
import {
  MAX_BUG_AUTO_FILE,
  MAX_BUG_PROBLEMS,
  MAX_BUG_RECENT_ACTIONS,
  MAX_BUG_SETUP_TEXT,
  MAX_BUG_WINDOW_PX,
  type BugReportInput,
  type BugReportSetup,
} from "@horizon36596/zenith-cloud/bugReports";

/** Everything the page knows that the setup block is made from. The dialog reads it; tests make it. */
export interface SetupSources {
  appVersion: string;
  surface: "web" | "desktop";
  hostMode: boolean;
  /** `navigator.userAgent`, which is reduced here and never kept whole. */
  userAgent: string;
  windowWidthPx: number;
  windowHeightPx: number;
  theme: "dark" | "light";
  cloudMode: "off" | "fake" | "firebase";
  /** The open file's findings; only `code` and `message` are read. */
  findings: ReadonlyArray<{ code: string; message: string }>;
  /** Action ids, oldest first. */
  recentActions: readonly string[];
}

/** The version the build was given, or "unknown" where Vite did not build the code. */
export const appVersion = (): string => (typeof __APP_VERSION__ === "string" && __APP_VERSION__ !== "" ? __APP_VERSION__ : "unknown");

/** What a path on the person's computer becomes. */
export const PATH_MARK = "[path]";

/**
 * Paths on a person's computer: a `file:` address; a Windows drive or network path (with `\` or `/`,
 * and with JSON's doubled `\\`); a home directory as `~/`; and an absolute Unix path that starts in a
 * directory where people's files live. A path runs to the next space, quote, bracket or line end, so
 * the words after it stay. Web addresses (`https://…/home/…`) are left alone: their `/home/` follows a
 * host, not a space or the start of the text.
 */
const PATH_PATTERNS: readonly RegExp[] = [
  /file:\/\/[^\s"'`<>()[\]{}]*/gi,
  /(?<![A-Za-z0-9])[A-Za-z]:(?:\\\\|\\|\/)[^\s"'`<>()[\]{}]*/g,
  /(?<![A-Za-z0-9:/])(?:\\\\|\\){1,2}[A-Za-z0-9._$-]+(?:\\\\|\\)[^\s"'`<>()[\]{}]*/g,
  /(?<![A-Za-z0-9./:-])~(?:\/|\\)[^\s"'`<>()[\]{}]*/g,
  /(?<![A-Za-z0-9._:/-])\/(?:home|Users|root|mnt|media|Volumes|var|tmp|private|opt|srv|etc|workspace|workspaces|run)\/[^\s"'`<>()[\]{}]*/g,
];

/** `text` with every path on the person's computer replaced by `[path]`. */
export function stripPaths(text: string): string {
  let out = text;
  for (const pattern of PATH_PATTERNS) out = out.replace(pattern, PATH_MARK);
  return out;
}

/** The first match's first group, or null. */
const first = (ua: string, pattern: RegExp): string | null => pattern.exec(ua)?.[1] ?? null;

/** The browser's name and major version, from the user agent. Only those two are ever kept. */
export function browserOf(userAgent: string): string {
  const ua = userAgent;
  const named: ReadonlyArray<[string, RegExp]> = [
    ["Zenith desktop (Electron)", /\bElectron\/(\d+)/],
    ["Edge", /\bEdg(?:e|A|iOS)?\/(\d+)/],
    ["Opera", /\bOPR\/(\d+)/],
    ["Samsung Internet", /\bSamsungBrowser\/(\d+)/],
    ["Firefox", /\b(?:Firefox|FxiOS)\/(\d+)/],
    ["Chrome", /\b(?:Chrome|CriOS)\/(\d+)/],
  ];
  for (const [name, pattern] of named) {
    const major = first(ua, pattern);
    if (major !== null) return `${name} ${major}`;
  }
  if (/\bSafari\//.test(ua)) {
    const major = first(ua, /\bVersion\/(\d+)/);
    return major === null ? "Safari" : `Safari ${major}`;
  }
  return "Unknown browser";
}

/**
 * The system's name, and its major version where the user agent tells it truthfully. Browsers freeze
 * the macOS version at 10.15 and report every Windows from 10 up as "NT 10.0", so those say only
 * "macOS" and "Windows 10 or 11".
 */
export function systemOf(userAgent: string): string {
  const ua = userAgent;
  const ios = first(ua, /\b(?:iPhone|CPU) OS (\d+)/);
  if (/\biPad\b/.test(ua)) return ios === null ? "iPadOS" : `iPadOS ${ios}`;
  if (ios !== null || /\biPhone\b/.test(ua)) return ios === null ? "iOS" : `iOS ${ios}`;
  const android = first(ua, /\bAndroid (\d+)/);
  if (android !== null) return `Android ${android}`;
  if (/\bAndroid\b/.test(ua)) return "Android";
  if (/\bCrOS\b/.test(ua)) return "ChromeOS";
  const windows = first(ua, /\bWindows NT (\d+\.\d+)/);
  if (windows !== null) {
    const names: Record<string, string> = { "10.0": "Windows 10 or 11", "6.3": "Windows 8.1", "6.2": "Windows 8", "6.1": "Windows 7" };
    return names[windows] ?? "Windows";
  }
  if (/\bWindows\b/.test(ua)) return "Windows";
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return "macOS";
  if (/\bLinux\b|\bX11\b/.test(ua)) return "Linux";
  return "Unknown system";
}

/** `text` cut to `max` characters on a line boundary, saying how many lines were left out. */
function capLines(lines: readonly string[], max: number): string {
  const kept: string[] = [];
  let length = 0;
  for (const [index, line] of lines.entries()) {
    const more = lines.length - index;
    const tail = `and ${String(more)} more`;
    const next = length + (kept.length === 0 ? 0 : 1) + line.length;
    if (next > max - tail.length - 1) {
      kept.push(tail);
      break;
    }
    kept.push(line);
    length = next;
  }
  return kept.join("\n").slice(0, max);
}

/** A one-line value within the setup block's limit, never empty. */
const oneLine = (value: string, fallback: string): string => {
  const line = value.replace(/\s+/g, " ").trim().slice(0, MAX_BUG_SETUP_TEXT);
  return line === "" ? fallback : line;
};

/** A window size the rules accept: a whole number of pixels from 0 to MAX_BUG_WINDOW_PX. */
const pixels = (value: number): number => (Number.isFinite(value) ? Math.min(MAX_BUG_WINDOW_PX, Math.max(0, Math.round(value))) : 0);

/** The setup block, from what the page knows. */
export function collectSetup(sources: SetupSources): BugReportSetup {
  const problems = sources.findings.map((finding) => stripPaths(`${finding.code}: ${finding.message}`.replace(/\s+/g, " ").trim()));
  const actions: string[] = [];
  let length = 0;
  // The newest ids matter most, so when the list is too long the oldest are dropped.
  for (const id of [...sources.recentActions].reverse()) {
    const clean = id.replace(/[^A-Za-z0-9._-]/g, "");
    if (clean === "") continue;
    const next = length + (actions.length === 0 ? 0 : 2) + clean.length;
    if (next > MAX_BUG_RECENT_ACTIONS) break;
    actions.unshift(clean);
    length = next;
  }
  return {
    appVersion: oneLine(sources.appVersion, "unknown"),
    surface: sources.surface,
    hostMode: sources.hostMode,
    browser: oneLine(browserOf(sources.userAgent), "Unknown browser"),
    os: oneLine(systemOf(sources.userAgent), "Unknown system"),
    windowWidthPx: pixels(sources.windowWidthPx),
    windowHeightPx: pixels(sources.windowHeightPx),
    theme: sources.theme,
    cloudMode: sources.cloudMode,
    problems: capLines(problems, MAX_BUG_PROBLEMS),
    recentActions: actions.join(", "),
  };
}

/** The setup block as the dialog, the copied text and the admin page show it: a label and a value per row. */
export function setupRows(setup: BugReportSetup): Array<{ label: string; value: string }> {
  const CLOUD: Record<BugReportSetup["cloudMode"], string> = {
    off: "Off (no accounts in this build)",
    fake: "Fake (in this tab only)",
    firebase: "On",
  };
  return [
    { label: "App version", value: setup.appVersion },
    { label: "App", value: `${setup.surface === "web" ? "Web app" : "Desktop app"}${setup.hostMode ? ", opened by another app (host mode)" : ""}` },
    { label: "Browser", value: setup.browser },
    { label: "System", value: setup.os },
    { label: "Window", value: `${String(setup.windowWidthPx)} × ${String(setup.windowHeightPx)} px, ${setup.theme} theme` },
    { label: "Cloud", value: CLOUD[setup.cloudMode] },
    { label: "Problems in the open file", value: setup.problems === "" ? "None" : setup.problems },
    { label: "Last actions", value: setup.recentActions === "" ? "None yet" : setup.recentActions },
  ];
}

/** What attaching the auto file gives: its text, or why it cannot be attached. */
export type AutoAttachment = { ok: true; text: string; sizeKb: number } | { ok: false; reason: string; sizeKb: number | null };

/**
 * The auto file to attach: the canonical text with `authors` taken out (names are not sent) and
 * every path on the person's computer replaced. Refused when nothing is open or it is too large.
 */
export function autoAttachment(canonical: string | null): AutoAttachment {
  if (canonical === null) return { ok: false, reason: "No auto is open, so there is no file to include.", sizeKb: null };
  let text = canonical;
  try {
    const parsed: unknown = JSON.parse(canonical);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "authors" in parsed) {
      const { authors: _authors, ...rest } = parsed as Record<string, unknown>;
      text = `${JSON.stringify(rest, null, 2)}\n`;
    }
  } catch {
    // Not JSON: sent as it is, after the paths are taken out.
  }
  text = stripPaths(text);
  const sizeKb = Math.ceil(text.length / 1000);
  if (text.length > MAX_BUG_AUTO_FILE) {
    return {
      ok: false,
      reason: `This auto file is ${String(sizeKb)} KB, more than the ${String(MAX_BUG_AUTO_FILE / 1000)} KB a report can carry. Leave it out and describe the auto instead.`,
      sizeKb,
    };
  }
  return { ok: true, text, sizeKb };
}

/** The person's three answers, with their paths replaced, ready to send or copy. */
export function reportInput(answers: { whatHappened: string; expected: string; steps: string }, setup: BugReportSetup, autoFile: string | null): BugReportInput {
  return {
    whatHappened: stripPaths(answers.whatHappened).trim(),
    expected: stripPaths(answers.expected).trim(),
    steps: stripPaths(answers.steps).trim(),
    setup,
    ...(autoFile === null ? {} : { autoFile }),
  };
}

/** The report as plain text, for Copy report. */
export function reportText(input: BugReportInput): string {
  const section = (title: string, body: string | undefined) => (body === undefined || body === "" ? [] : [title, body, ""]);
  const lines = [
    "Zenith bug report",
    "",
    ...section("What happened:", input.whatHappened),
    ...section("What I expected:", input.expected),
    ...section("Steps to reproduce:", input.steps),
    "Sent with this report:",
    ...setupRows(input.setup).map((row) => (row.value.includes("\n") ? `${row.label}:\n  ${row.value.split("\n").join("\n  ")}` : `${row.label}: ${row.value}`)),
    ...(input.autoFile === undefined ? [] : ["", "Auto file:", input.autoFile.trimEnd()]),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}
