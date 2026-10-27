import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  loadAuto,
  loadField,
  loadLink,
  loadRobot,
  loadWaypoints,
  plan,
  projectShare,
  resolve,
  runLedger,
  simulate,
} from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import type { Projection } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { readPartnerText } from "../alliance/source";

/**
 * The example propose-level share in `examples/starter/partners/`, and the proof it is what it says
 * it is: the starter's own `collect-and-score`, with the starter's own waypoints, simulated and
 * shared with `projectShare` at the propose level. It sits beside the view-level example partner and
 * is made the same way: generated, never written by hand. Run this test with
 * `ZENITH_WRITE_PROPOSE_FIXTURE=1` to write it again after a change to the starter or to core.
 *
 * Because it is the starter's own auto, a proposal made against it in the proposer's editor opens
 * in the owner's review against `collect-and-score` itself, which is what the proposals end-to-end
 * test does: one browser plays both teams.
 */

const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const PROPOSE_FIXTURE = `${starter}partners/starter-collect-and-score.propose.projection.json`;
const read = (relative: string): unknown => JSON.parse(readFileSync(`${starter}${relative}`, "utf8"));

function buildShare(): Projection {
  const link = loadLink(read("zenith.json"));
  const robot = loadRobot(read(link.robot));
  const field = loadField(read(link.field));
  const waypoints = loadWaypoints(read(link.waypoints ?? "autos/waypoints.json"));
  const season = resolveSeason(field).rules;
  const planned = plan(resolve(loadAuto(read("autos/collect-and-score.auto.json")), waypoints, robot), robot, field);
  const ledger = runLedger(planned, field, season);
  const trace = simulate(planned, robot, field, { ledger, season });
  return projectShare({ plan: planned, trace, robot, field, ledger }, { level: "propose", title: "Starter collect and score" });
}

describe("the example propose-level share", () => {
  it("is exactly what projectShare builds from the starter's collect-and-score at the propose level", () => {
    const expected = canonicalize("projection", buildShare());
    if (process.env["ZENITH_WRITE_PROPOSE_FIXTURE"] === "1") {
      mkdirSync(dirname(PROPOSE_FIXTURE), { recursive: true });
      writeFileSync(PROPOSE_FIXTURE, expected, "utf8");
    }
    expect(readFileSync(PROPOSE_FIXTURE, "utf8").replace(/\r\n/g, "\n")).toBe(expected);
  });

  it("loads through the partner source with its structure and no command name", () => {
    const text = readFileSync(PROPOSE_FIXTURE, "utf8");
    const load = readPartnerText("starter-collect-and-score.propose.projection.json", text);
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    expect(load.projection.level).toBe("propose");
    expect(load.projection.structure?.steps.length).toBeGreaterThan(0);
    for (const name of ["intakeOn", "intakeOff", "spinUp", "hopperFull", "driveOut", "shootPreloads", "toOtherSide", "collectFlower", "toGarden", "sweepGarden"]) {
      expect(text).not.toContain(`"${name}"`);
    }
  });
});
