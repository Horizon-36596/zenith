import { readFileSync, readFileSync as read, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FINDING_HELP, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { derive } from "../state/derived";
import { describe, expect, it } from "vitest";
import { ACTIONS, HELP_MENU, TOOLBAR_GROUPS, actionById } from "../app/actions";
import { CANVAS_HELP } from "../canvas/help";
import { canvasHelp } from "./canvasHelp";
import { INSERT_HELP, PANEL_HELP, findingHelp } from "./content";
import { CORE_STOPS, FULL_STOPS } from "../tour/stops";

/**
 * Help everywhere (site/docs/editor.md): every toolbar button, panel header,
 * inspector section, insert kind and finding code has plain-language help, and nothing that ships
 * a `?` points at help that does not exist.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".tsx") ? [readFileSync(path, "utf8")] : [];
  });
}

const ALL = sources(SRC).join("\n");

describe("help coverage", () => {
  it("gives every action a name and a sentence saying what it does", () => {
    for (const action of ACTIONS) {
      expect(action.label.trim(), action.id).not.toBe("");
      expect(action.does.trim().length, action.id).toBeGreaterThan(10);
      expect(action.does.trim(), action.id).toMatch(/[.?!]$/);
    }
  });

  it("says why whenever an action can be disabled", () => {
    for (const action of ACTIONS) {
      if (action.enabled === undefined) continue;
      expect(action.whyDisabled, `${action.id} can be disabled but never says why`).toBeDefined();
    }
  });

  it("builds every toolbar and help menu button from an action that exists", () => {
    for (const id of [...TOOLBAR_GROUPS.flat(), ...HELP_MENU]) {
      expect(actionById(id), id).toBeDefined();
    }
  });

  it("gives every toolbar button with a key its shortcut in the tooltip", () => {
    for (const id of TOOLBAR_GROUPS.flat()) {
      const action = actionById(id);
      if (id.startsWith("tool.") || id === "view.snap" || id === "view.alliance") {
        expect(action?.shortcut, `${id} has no shortcut`).toBeDefined();
      }
    }
  });

  it("has help text for every panel header and inspector section, and uses all of it", () => {
    const used = new Set(
      [...ALL.matchAll(/"((?:section\.)?[a-z]+)"/g)].map((match) => match[1] ?? ""),
    );
    for (const [id, entry] of Object.entries(PANEL_HELP)) {
      expect(entry.title.trim(), id).not.toBe("");
      expect(entry.body.length, id).toBeGreaterThan(20);
      expect(entry.body.length, `${id} is longer than a tooltip should be`).toBeLessThanOrEqual(300);
      expect(used.has(id), `PANEL_HELP.${id} is never shown`).toBe(true);
    }
    for (const match of ALL.matchAll(/help="([a-z.]+)"/g)) {
      expect(Object.keys(PANEL_HELP), `help="${match[1] ?? ""}" has no entry`).toContain(match[1]);
    }
  });

  it("gives every region title a ?", () => {
    // A panel's attributes, up to the start of its children, fit well inside 600 characters.
    for (const at of ALL.matchAll(/<Panel\b/g)) {
      const tag = ALL.slice(at.index, at.index + 600);
      const title = /title="([^"]+)"/.exec(tag)?.[1];
      if (title === undefined) continue;
      expect(tag, `the ${title} panel has no ?`).toMatch(/help="/);
    }
  });

  it("describes every insert kind in one line", () => {
    for (const [kind, entry] of Object.entries(INSERT_HELP)) {
      expect(entry.title.trim(), kind).not.toBe("");
      expect(entry.body.length, kind).toBeLessThanOrEqual(120);
    }
    expect(Object.keys(INSERT_HELP).sort()).toEqual(
      ["branch", "command", "parallel", "path", "sequence", "wait"].sort(),
    );
  });

  it("explains every finding code, with a fix, including every one the example raises", () => {
    const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
    const json = (name: string): unknown => JSON.parse(read(`${examples}${name}`, "utf8"));
    const raised = derive(
      loadAuto(json("collect-and-score.auto.json")),
      loadRobot(json("robot.json")),
      loadField(json("field/biobuzz.field.json")),
      loadWaypoints(json("waypoints.json")),
    ).findings.map((finding) => finding.code);
    expect(raised.length).toBeGreaterThan(0);
    for (const code of new Set([...Object.keys(FINDING_HELP), ...raised])) {
      const help = findingHelp(code);
      expect(help, code).not.toBeNull();
      expect(help?.means.length ?? 0, code).toBeGreaterThan(10);
      expect(help?.fix.length ?? 0, code).toBeGreaterThan(5);
    }
  });

  it("lists every canvas gesture in the overlay", () => {
    expect(canvasHelp()).toHaveLength(CANVAS_HELP.length);
  });

  it("points every tour stop, and every area it keeps clear, at an anchor the shell renders", () => {
    const rendered = (anchor: string): boolean =>
      ALL.includes(`data-tour="${anchor}"`) ||
      ALL.includes(`? "${anchor}"`) ||
      ALL.includes(`tour="${anchor}"`) ||
      ALL.includes(`help="${anchor}"`) ||
      ACTIONS.some((action) => action.id === anchor);
    for (const stop of [...CORE_STOPS, ...FULL_STOPS]) {
      for (const anchor of [...(stop.anchor === null ? [] : [stop.anchor]), ...(stop.keepClear ?? [])]) {
        expect(rendered(anchor), `the ${stop.id} stop points at ${anchor}, which nothing renders`).toBe(true);
      }
    }
  });

  it("teaches the heading arrows, not the retired per-point knob", () => {
    const heading = FULL_STOPS.find((stop) => stop.id === "tool.heading");
    expect(heading?.body).not.toMatch(/knob/i);
    expect(heading?.body).toMatch(/arrow/i);
    expect(heading?.body).toMatch(/Split heading here/);
    expect(heading?.task?.signal).toBe("headingTurned");
    expect(heading?.prepare).toBe("selectPathWithHeadingArrows");
  });
});
