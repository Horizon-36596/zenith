/**
 * The desktop Deploy panel's words (issue #156): it says the OpMode stubs are written, and which
 * runtime they run on, only when the deploy writes them, which it does exactly when `zenith.json`
 * has a `codegen` section. Without one it says that no OpMode is written, even when the project names
 * a command library. Also the panel's frame: one live region, no way out of a running deploy, the
 * save-first question, a cancelled sim in plain words, and the git panel's sign-in and reasons.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { html, text } from "../account/keys/testMarkup";
import type { DesktopPanel } from "./desktopActions";
import type { DesktopDeployResult, DesktopGitStatus } from "./desktopBridge";
import { CLI_SKIP_REASON, DeployBody, GitBody, SimBody, deploySummary } from "./desktopPanel";

const result = (overrides: Partial<DesktopDeployResult>): DesktopDeployResult => ({
  dryRun: true,
  actions: [
    { kind: "copy", path: "TeamCode/src/main/assets/autos/first-auto.auto.json", from: "autos/first-auto.auto.json", changed: true },
    { kind: "copy", path: "TeamCode/src/main/assets/autos/robot.json", from: "autos/robot.json", changed: true },
  ],
  errors: 0,
  changed: 2,
  deployDir: "TeamCode/src/main/assets/autos",
  commandLibrary: "solverslib",
  stubs: true,
  ...overrides,
});

const markup = (overrides: Partial<DesktopDeployResult>): string =>
  html(createElement(DeployBody, { panel: { kind: "deploy", phase: "preview", result: result(overrides), message: null } }));
const shown = (overrides: Partial<DesktopDeployResult>): string => text(markup(overrides));

/** The sweep's case: the one auto has an error, so it is skipped and its OpMode, written before, is removed. */
const skippedWithStub: Partial<DesktopDeployResult> = {
  actions: [
    { kind: "skip", path: "autos/preload-cycle-park.auto.json", reason: CLI_SKIP_REASON, changed: false },
    { kind: "copy", path: "TeamCode/src/main/assets/autos/robot.json", from: "autos/robot.json", changed: false },
    {
      kind: "remove",
      path: "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/zenith/generated/PreloadCycleParkAuto.java",
      changed: true,
    },
  ],
  errors: 1,
  changed: 1,
};

describe("the desktop Deploy panel", () => {
  it("names the runtime the stubs run on when the deploy writes them", () => {
    const words = shown({});
    expect(words).toContain("refreshes the generated OpMode stubs");
    expect(words).toContain("The stubs run on the SolversLib runtime");
  });

  it("does not say the stubs run on a runtime when there is no codegen section, even with a library named", () => {
    const words = shown({ stubs: false, commandLibrary: "solverslib" });
    expect(words).not.toContain("stubs run on");
    expect(words).not.toContain("runtime");
    expect(words).not.toContain("refreshes the generated OpMode stubs");
    expect(words).toContain("No OpMode is written");
    expect(words).toContain("the Driver Station will not list these autos unless your own OpModes load them");
  });

  it("says why an auto is skipped in the app's words, not the CLI's (0.1.2 UX sweep)", () => {
    const words = shown(skippedWithStub);
    expect(words).toContain("has errors; open it and see Problems");
    expect(words).not.toContain("zenith validate");
    // The CLI still prints its own reason, word for word, so the mapping above keeps matching it.
    expect(readFileSync(new URL("../../../../packages/cli/src/commands/deploy.ts", import.meta.url), "utf8")).toContain(
      `reason: "${CLI_SKIP_REASON}"`,
    );
  });

  it("says plainly that the skipped auto's OpMode is removed, and not in green", () => {
    const summary = deploySummary(result(skippedWithStub), false);
    expect(summary).toEqual({
      text: "1 auto has errors, so it is skipped and its generated OpMode is removed: the Driver Station will not list it until the errors are fixed. Nothing else changes.",
      tone: "warn",
    });
    expect(shown(skippedWithStub)).toContain(summary.text);
    expect(markup(skippedWithStub)).toContain('data-tone="warn"');
    expect(deploySummary(result(skippedWithStub), true).text).toContain("so it was skipped and its generated OpMode was removed");
  });

  it("counts the other changes apart from a skipped auto", () => {
    const actions = [...(skippedWithStub.actions ?? []), ...result({}).actions];
    expect(deploySummary(result({ actions, errors: 1, changed: 3 }), false).text).toMatch(/ 2 other files will change\.$/);
    const noStub = deploySummary(result({ errors: 1, changed: 2 }), false);
    expect(noStub).toEqual({ text: "1 auto has errors, so it is skipped. 2 other files will change.", tone: "warn" });
  });

  it("says plainly why an auto whose name is not its file name is skipped, and does not point at Problems", () => {
    const mismatch = `name "old" does not match the file name new.auto.json; the robot loads an auto by its name, so rename the file to old.auto.json or set "name" to "new".`;
    const skipped: Partial<DesktopDeployResult> = {
      actions: [{ kind: "skip", path: "autos/new.auto.json", reason: mismatch, autoName: "old", changed: false }],
      errors: 1,
      changed: 0,
    };
    expect(deploySummary(result(skipped), true)).toEqual({
      text: "1 auto was skipped: its name does not match its file name. Nothing else changed.",
      tone: "warn",
    });
    expect(deploySummary(result(skipped), false).text).toBe("1 auto is skipped: its name does not match its file name. Nothing else changes.");
    const words = shown(skipped);
    expect(words).not.toContain("Problems");
    expect(words).not.toContain("has errors");
    // The row keeps the CLI's own reason, which says how to fix it.
    expect(words).toContain(mismatch);
    // The summary matches the CLI's wording, so it keeps telling this skip apart.
    expect(readFileSync(new URL("../../../../packages/cli/src/autoLoad.ts", import.meta.url), "utf8")).toContain(
      'return `name "${autoName}" does not match the file name ${fileName}; ',
    );
  });

  it("names a skipped auto's removed OpMode from its name, as deploy does, and tells the two kinds of skip apart", () => {
    const mismatch = `name "old" does not match the file name new.auto.json; the robot loads an auto by its name, so rename the file to old.auto.json or set "name" to "new".`;
    const stub = (name: string) => `TeamCode/src/main/java/org/firstinspires/ftc/teamcode/zenith/generated/${name}`;
    const actions: DesktopDeployResult["actions"] = [
      // The file was renamed from park-left.auto.json, "name" kept, and it has an error now too.
      { kind: "skip", path: "autos/park.auto.json", reason: CLI_SKIP_REASON, autoName: "park-left", changed: false },
      { kind: "skip", path: "autos/new.auto.json", reason: mismatch, autoName: "old", changed: false },
      { kind: "remove", path: stub("ParkLeftAuto.java"), changed: true },
      // Renamed from old.auto.json: the stub the last deploy wrote is named from "name", not the new file name.
      { kind: "remove", path: stub("OldAuto.java"), changed: true },
      // An auto deleted from autos/ drops its OpMode too; that one is an other file.
      { kind: "remove", path: stub("GoneAuto.java"), changed: true },
    ];
    expect(deploySummary(result({ actions, errors: 2, changed: 3 }), false).text).toBe(
      "1 auto has errors, so it is skipped and its generated OpMode is removed: the Driver Station will not list it until the errors are fixed. " +
        "1 auto is skipped: its name does not match its file name, so its generated OpMode is removed and the Driver Station will not list it. " +
        "1 other file will change.",
    );
  });

  it("keeps the green count when nothing is skipped", () => {
    expect(deploySummary(result({}), false)).toEqual({ text: "2 files will change.", tone: "ok" });
    expect(deploySummary(result({}), true)).toEqual({ text: "2 files changed.", tone: "ok" });
    expect(deploySummary(result({ changed: 0 }), false)).toEqual({ text: "Everything is already up to date.", tone: "prose" });
  });

  it("says the same with no library named", () => {
    const words = shown({ stubs: false, commandLibrary: null });
    expect(words).not.toContain("runtime");
    expect(words).toContain("No OpMode is written");
  });
});

describe("the desktop panel's frame", () => {
  const deploy = (phase: Extract<DesktopPanel, { kind: "deploy" }>["phase"]): string =>
    html(createElement(DeployBody, { panel: { kind: "deploy", phase, result: phase === "confirm" ? null : result({}), message: null } }));

  it("asks before a deploy of unsaved edits, as the sim does", () => {
    const words = text(deploy("confirm"));
    expect(words).toContain("has unsaved edits. Deploy copies the files on disk, so save it first.");
    expect(words).toContain("Save and preview");
    expect(words).toContain("Cancel");
  });

  it("offers no way out of a running deploy, and closes with the X otherwise", () => {
    const running = deploy("running");
    expect(running).not.toContain('aria-label="Close"');
    expect(text(running)).not.toContain("Cancel");
    expect(deploy("preview")).toContain('aria-label="Close"');
  });

  it("keeps the live region to the status lines", () => {
    expect(deploy("preview").match(/aria-live/g)).toHaveLength(1);
  });

  it("says a cancelled sim in plain words, not as an error", () => {
    const sim: Extract<DesktopPanel, { kind: "sim" }> = {
      kind: "sim",
      phase: "failed",
      fileName: "first-auto.auto.json",
      runId: "r1",
      command: "gradlew sim",
      lines: [],
      startedAt: 0,
      message: "The sim was stopped.",
      tail: [],
      elapsedS: null,
      speed: "basic",
      status: null,
      receivedS: null,
      cached: false,
      cancelled: true,
    };
    const markup = html(createElement(SimBody, { panel: sim }));
    expect(text(markup)).toContain("Sim cancelled.");
    expect(text(markup)).not.toContain("The sim was stopped.");
    expect(markup).toContain('data-cancelled="true"');
  });
});

describe("the desktop git panel", () => {
  const status: DesktopGitStatus = {
    isRepo: true,
    branch: "auto/first-auto/me",
    base: "main",
    onBase: false,
    workBranch: "auto/first-auto/me",
    changedAutos: [],
    otherChanges: 2,
    hasRemote: true,
    ahead: 0,
  };
  const git = (patch: Partial<Extract<DesktopPanel, { kind: "git" }>>): string =>
    html(
      createElement(GitBody, {
        panel: {
          kind: "git",
          fileName: "first-auto.auto.json",
          status,
          github: { source: null, login: null, canStore: true, cli: "missing" },
          busy: null,
          log: [],
          error: null,
          prUrl: null,
          readAtSaved: null,
          confirmCommit: false,
          ...patch,
        },
      }),
    );

  it("signs in through the one sign-in dialog, and says what the GitHub CLI could do", () => {
    const words = text(git({}));
    expect(words).toContain("Not signed in. Open pull request needs GitHub.");
    expect(words).toContain("Sign in to GitHub…");
    expect(words).toContain("Or install the GitHub CLI and run gh auth login, then check again.");
    expect(words).toContain("Check again");
    expect(text(git({ github: { source: null, login: null, canStore: true, cli: "signed-out" } }))).toContain(
      "Or run gh auth login in a terminal, then check again.",
    );
    // A CLI that can already sign in needs no sentence.
    expect(text(git({ github: { source: null, login: null, canStore: true, cli: "ready" } }))).not.toContain("gh auth login");
  });

  it("says who is signed in, with Sign out for a token Zenith keeps", () => {
    const stored = text(git({ github: { source: "stored", login: "me", canStore: true } }));
    expect(stored).toContain("Signed in as me. The token is kept encrypted on this computer.");
    expect(stored).toContain("Sign out");
    expect(text(git({ github: { source: "gh", login: "me", canStore: true } }))).not.toContain("Sign out");
  });

  it("puts the reason a button is off under the row", () => {
    const markup = git({});
    expect(markup).toContain('data-testid="desktop-git-why"');
    expect(text(markup)).toContain("Sign in to GitHub to open the pull request.");
  });

  it("asks before a commit of unsaved edits", () => {
    const words = text(git({ confirmCommit: true }));
    expect(words).toContain("first-auto.auto.json has unsaved edits. A commit takes the file on disk, so save it first.");
    expect(words).toContain("Save and commit");
  });

  it("says what to do when the folder is not a git repository", () => {
    expect(text(git({ status: { ...status, isRepo: false } }))).toContain(
      "This folder is not a git repository, so there is nothing to commit to. Open the robot repository folder, or run git init in this one.",
    );
  });
});
