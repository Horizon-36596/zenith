/**
 * The Report a bug setup block and attachment (`setup.ts`), held to the privacy rules of spec 13
 * section 12: nothing private is collected, the user agent is reduced to name and major version,
 * every local path is replaced, and the attachment has a size cap that says so when it is too large.
 */
import { describe, expect, it } from "vitest";
import { bugReportProblem, MAX_BUG_AUTO_FILE, MAX_BUG_PROBLEMS, MAX_BUG_RECENT_ACTIONS } from "@horizon36596/zenith-cloud/bugReports";
import { autoAttachment, browserOf, collectSetup, PATH_MARK, reportInput, reportText, setupRows, stripPaths, systemOf, type SetupSources } from "./setup";

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36";
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";
const EDGE = `${CHROME_WINDOWS} Edg/131.0.2903.70`;
const ELECTRON =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) zenith-desktop/0.1.1 Chrome/130.0.6723.191 Electron/33.3.1 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1.2 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const CHROMEBOOK = "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const sources = (over: Partial<SetupSources> = {}): SetupSources => ({
  appVersion: "0.1.1",
  surface: "web",
  hostMode: false,
  userAgent: CHROME_WINDOWS,
  windowWidthPx: 1440,
  windowHeightPx: 900,
  theme: "dark",
  cloudMode: "off",
  findings: [{ code: "REACH", message: "The robot cannot reach driveOut." }],
  recentActions: ["run.validate", "help.reportBug"],
  ...over,
});

describe("the setup block", () => {
  it("holds exactly the fields the dialog shows, and nothing private", () => {
    const setup = collectSetup(sources());
    expect(Object.keys(setup).sort()).toEqual(
      ["appVersion", "browser", "cloudMode", "hostMode", "os", "problems", "recentActions", "surface", "theme", "windowHeightPx", "windowWidthPx"].sort(),
    );
    expect(setup).toEqual({
      appVersion: "0.1.1",
      surface: "web",
      hostMode: false,
      browser: "Chrome 131",
      os: "Windows 10 or 11",
      windowWidthPx: 1440,
      windowHeightPx: 900,
      theme: "dark",
      cloudMode: "off",
      problems: "REACH: The robot cannot reach driveOut.",
      recentActions: "run.validate, help.reportBug",
    });
    // The full user agent never goes anywhere: no build numbers, no engine, no platform string.
    const text = JSON.stringify(setup);
    for (const leaked of ["6778", "AppleWebKit", "Win64", "Mozilla"]) expect(text).not.toContain(leaked);
    expect(bugReportProblem({ whatHappened: "It broke.", setup })).toBeNull();
  });

  it("reads no finding field but the code and the message", () => {
    const finding = { code: "PERIMETER", message: "Leaves the field.", stepId: "secretStep", geometry: { pointIn: { x: 1, y: 2 } } };
    expect(collectSetup(sources({ findings: [finding] })).problems).toBe("PERIMETER: Leaves the field.");
  });

  it("replaces a local path in a finding's message", () => {
    const setup = collectSetup(sources({ findings: [{ code: "ROBOT", message: "Could not read C:\\Students\\ada.lovelace\\robot\\robot.json today." }] }));
    expect(setup.problems).toBe(`ROBOT: Could not read ${PATH_MARK} today.`);
    expect(setup.problems).not.toContain("ada");
  });

  it("keeps the newest action ids within the limit, and only ids", () => {
    const many = Array.from({ length: 400 }, (_, index) => `action.number${String(index)}`);
    const setup = collectSetup(sources({ recentActions: [...many, "bad id with spaces/and/slashes"] }));
    expect(setup.recentActions.length).toBeLessThanOrEqual(MAX_BUG_RECENT_ACTIONS);
    expect(setup.recentActions.endsWith("action.number399, badidwithspacesandslashes")).toBe(true);
    expect(setup.recentActions).not.toContain("action.number0,");
  });

  it("caps a long findings list on a line boundary and says how many were left out", () => {
    const findings = Array.from({ length: 500 }, (_, index) => ({ code: "SLOW", message: `Step ${String(index)} is slower than it needs to be.` }));
    const setup = collectSetup(sources({ findings }));
    expect(setup.problems.length).toBeLessThanOrEqual(MAX_BUG_PROBLEMS);
    expect(setup.problems).toMatch(/\nand \d+ more$/);
  });

  it("keeps window sizes to whole pixels in range, and one-line values non-empty", () => {
    const setup = collectSetup(sources({ windowWidthPx: 1439.6, windowHeightPx: Number.NaN, appVersion: "  " }));
    expect([setup.windowWidthPx, setup.windowHeightPx, setup.appVersion]).toEqual([1440, 0, "unknown"]);
  });

  it("shows every field as a labelled row", () => {
    const rows = setupRows(collectSetup(sources({ hostMode: true, surface: "desktop", findings: [], recentActions: [] })));
    expect(rows.map((row) => row.label)).toEqual(["App version", "App", "Browser", "System", "Window", "Cloud", "Problems in the open file", "Last actions"]);
    expect(rows[1]?.value).toBe("Desktop app, opened by another app (host mode)");
    expect(rows[6]?.value).toBe("None");
  });
});

describe("reducing the user agent", () => {
  it("names the browser and its major version only", () => {
    expect(browserOf(CHROME_WINDOWS)).toBe("Chrome 131");
    expect(browserOf(EDGE)).toBe("Edge 131");
    expect(browserOf(FIREFOX_LINUX)).toBe("Firefox 133");
    expect(browserOf(SAFARI_MAC)).toBe("Safari 17");
    expect(browserOf(ELECTRON)).toBe("Zenith desktop (Electron) 33");
    expect(browserOf(IPHONE)).toBe("Safari 17");
    expect(browserOf("")).toBe("Unknown browser");
  });

  it("names the system, with a major version only where the browser tells it truthfully", () => {
    expect(systemOf(CHROME_WINDOWS)).toBe("Windows 10 or 11");
    expect(systemOf(SAFARI_MAC)).toBe("macOS");
    expect(systemOf(FIREFOX_LINUX)).toBe("Linux");
    expect(systemOf(IPHONE)).toBe("iOS 17");
    expect(systemOf(ANDROID)).toBe("Android 14");
    expect(systemOf(CHROMEBOOK)).toBe("ChromeOS");
    expect(systemOf("Mozilla/5.0 (Windows NT 6.1)")).toBe("Windows 7");
    expect(systemOf("curl/8.0")).toBe("Unknown system");
  });
});

describe("stripping local paths", () => {
  it("replaces Windows, Unix, home, network and file: paths, and keeps the words around them", () => {
    const cases: Array<[string, string]> = [
      ["open C:\\Students\\ada\\zenith\\robot.json failed", `open ${PATH_MARK} failed`],
      ["open d:/robots/biobuzz/zenith.json", `open ${PATH_MARK}`],
      ["at /home/ada/biobuzz/autos/close.auto.json:12", `at ${PATH_MARK}`],
      ["at /Volumes/ada/Documents/robot", `at ${PATH_MARK}`],
      ["in ~/code/biobuzz today", `in ${PATH_MARK} today`],
      ["from \\\\school-share\\students\\ada\\auto.json", `from ${PATH_MARK}`],
      ["see file:///C:/Robotics/ada/auto.json.", `see ${PATH_MARK}`],
      ['{"path":"C:\\\\Robotics\\\\ada\\\\robot.json"}', `{"path":"${PATH_MARK}"}`],
      ["(/var/folders/x/y)", `(${PATH_MARK})`],
    ];
    for (const [input, output] of cases) expect(stripPaths(input), input).toBe(output);
  });

  it("leaves web addresses, relative paths, action ids and ordinary words alone", () => {
    for (const text of [
      "https://example.org/home/page",
      "../robot.json and autos/close.auto.json",
      "run.validate, help.reportBug",
      "Drive 24 in / 2 s, then turn 90°.",
      "a/b and 1/2",
    ]) {
      expect(stripPaths(text), text).toBe(text);
    }
  });

  it("strips what the person typed before it is sent or copied", () => {
    const setup = collectSetup(sources());
    const input = reportInput({ whatHappened: " Saving to C:\\Robotics\\ada\\x.json failed. ", expected: "", steps: "Open /home/ada/robot" }, setup, null);
    expect(input.whatHappened).toBe(`Saving to ${PATH_MARK} failed.`);
    expect(input.steps).toBe(`Open ${PATH_MARK}`);
    expect(input.autoFile).toBeUndefined();
  });
});

describe("attaching the auto file", () => {
  it("takes the authors out, since names are not sent", () => {
    const attached = autoAttachment(JSON.stringify({ name: "close", authors: ["Ada Lovelace"], steps: [] }));
    expect(attached.ok).toBe(true);
    if (attached.ok) {
      expect(attached.text).not.toContain("Ada");
      expect(JSON.parse(attached.text)).toEqual({ name: "close", steps: [] });
    }
  });

  it("says there is nothing to attach with no auto open", () => {
    expect(autoAttachment(null)).toEqual({ ok: false, reason: "No auto is open, so there is no file to include.", sizeKb: null });
  });

  it("refuses a file over the cap with a sentence, and takes one at the cap", () => {
    const at = JSON.stringify({ name: "x".repeat(MAX_BUG_AUTO_FILE - 40) });
    const over = JSON.stringify({ name: "x".repeat(MAX_BUG_AUTO_FILE + 10) });
    const fits = autoAttachment(at);
    expect(fits.ok).toBe(true);
    const refused = autoAttachment(over);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/is 201 KB, more than the 200 KB a report can carry/);
    // The cloud's own check agrees, and says so too.
    expect(bugReportProblem({ whatHappened: "It broke.", setup: collectSetup(sources()), autoFile: "x".repeat(MAX_BUG_AUTO_FILE + 1) })).toMatch(/too large to attach/);
  });
});

describe("the copied report", () => {
  it("is plain text with the answers, the setup rows and the auto file", () => {
    const setup = collectSetup(sources());
    const text = reportText(reportInput({ whatHappened: "The path vanished.", expected: "It stays.", steps: "" }, setup, '{"name":"close"}\n'));
    expect(text).toContain("What happened:\nThe path vanished.");
    expect(text).toContain("What I expected:\nIt stays.");
    expect(text).not.toContain("Steps to reproduce:");
    expect(text).toContain("Browser: Chrome 131");
    expect(text).toContain('Auto file:\n{"name":"close"}');
    expect(text).not.toMatch(/github\.com|issues/i);
  });
});
