import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints, plan as planAuto, projectShare, resolve, runLedger, simulate } from "@horizon36596/zenith-core";
import { seasonFor } from "@horizon36596/zenith-seasons";
import { parseProjection } from "@horizon36596/zenith-schema";
import type { Auto } from "@horizon36596/zenith-schema";
import { afterEach, describe, expect, it } from "vitest";
import { presetSettings } from "../settings/presets";
import { closeProject, commit, currentDerived, getState, setSettings } from "../state/store";
import { ACTIONS } from "./actions";
import { loadExample } from "./projectActions";
import { buildShareFile, shareFileBlockedReason, shareFileName } from "./shareFile";

/**
 * "Download share file" writes the projection a share would send without the cloud. It must be
 * byte for byte what `zenith projection` writes for the same auto: core's `projectShare` over the
 * instant sim's run with no options, and the ledger with the season's rules.
 */
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): unknown => JSON.parse(readFileSync(`${repo}examples/starter/${path}`, "utf8")) as unknown;
const robot = loadRobot(read("autos/robot.json"));
const field = loadField(read("autos/field/biobuzz.field.json"));
const waypoints = loadWaypoints(read("autos/waypoints.json"));

describe("buildShareFile", () => {
  for (const level of ["view", "propose"] as const) {
    it(`gives the same canonical ${level} projection zenith projection writes`, () => {
      const auto = loadAuto(read("autos/collect-and-score.auto.json"));
      const plan = planAuto(resolve(auto, waypoints, robot), robot, field);
      const built = buildShareFile(plan, level);
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      const season = seasonFor(field);
      const ledger = runLedger(plan, field, season);
      const cli = canonicalize("projection", projectShare({ plan, trace: simulate(plan, robot, field, { ledger, season }), robot, field, ledger }, { level }));
      expect(built.canonical).toBe(cli);
      expect(parseProjection(JSON.parse(built.canonical)).level).toBe(level);
    });
  }

  it("names the file after the auto and the level", () => {
    expect(shareFileName("collect-and-score", "view")).toBe("collect-and-score.view.projection.json");
  });

  it("is in the palette at both levels, and says why with no auto open", () => {
    for (const id of ["project.downloadShareFile", "project.downloadProposeShareFile"]) {
      const action = ACTIONS.find((candidate) => candidate.id === id);
      expect(action?.group).toBe("project");
      const noAuto = { auto: null, project: null, review: null } as unknown as Parameters<NonNullable<NonNullable<typeof action>["whyDisabled"]>>[0];
      expect(action?.whyDisabled?.(noAuto)).toBe("Open an auto first.");
    }
  });
});

describe("shareFileBlockedReason", () => {
  afterEach(() => {
    setSettings(presetSettings("essential"));
    closeProject();
  });

  /**
   * The example's collect-and-score with forty pollen held at the start, where the robot holds at
   * most four: CAPACITY and the other ledger errors, which Essential's Ledger switch hides.
   */
  async function openWithHiddenLedgerError(): Promise<void> {
    closeProject();
    setSettings(presetSettings("essential"));
    await loadExample();
    const auto = getState().auto as Auto;
    commit({ ...auto, start: { ...auto.start, holds: { ...auto.start.holds, pollen: 40 } } });
  }

  it("refuses a share file for an auto whose only errors are in a hidden feature, as zenith projection does (0.1.2 batch review)", async () => {
    await openWithHiddenLedgerError();
    expect(currentDerived().findings.filter((finding) => finding.severity === "error")).toEqual([]);
    expect(shareFileBlockedReason(getState())).toBe(
      "This auto has 3 errors, in a feature your settings hide (Ledger and ball counting), so there is nothing to share yet. Fix them or turn the feature on.",
    );
  });

  it("gives the plain reason once the feature is on, and none for the example as it is", async () => {
    await openWithHiddenLedgerError();
    setSettings(presetSettings("full"));
    expect(shareFileBlockedReason(getState())).toBe("This auto has errors, so there is nothing to share yet. Fix them first.");
    closeProject();
    await loadExample();
    expect(shareFileBlockedReason(getState())).toBeNull();
  });
});
