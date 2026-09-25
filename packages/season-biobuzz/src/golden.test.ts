import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  check,
  estimate,
  ledger,
  loadAuto,
  loadField,
  loadRobot,
  loadWaypoints,
  plan,
  render,
  resolve,
} from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { loadSeason } from "./rules.js";

/**
 * The golden picture of `examples/starter/autos/collect-and-score.auto.json`.
 *
 * It lives here rather than in `packages/core` because it is the whole stack together: the example
 * project, the BIOBUZZ rules, the estimate, the checks, the ledger and the renderer. `render` is
 * pure, so the same files always produce the same bytes; a diff in the golden file is a real change
 * to the picture and wants looking at, not regenerating without a thought.
 *
 * Set `ZENITH_UPDATE_GOLDEN=1` to write the file instead of comparing against it.
 */
const examples = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const goldenPath = `${examples}.golden/collect-and-score.svg`;
const present = existsSync(`${examples}zenith.json`);

const read = (relative: string): unknown =>
  JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

describe.skipIf(!present)("the collect-and-score golden render", () => {
  const build = (): { svg: string; totals: string } => {
    const robot = loadRobot(read("autos/robot.json"));
    const field = loadField(read("autos/field/biobuzz.field.json"));
    const waypoints = loadWaypoints(read("autos/waypoints.json"));
    const auto = loadAuto(read("autos/collect-and-score.auto.json"));
    const season = loadSeason(field);

    const planned = plan(resolve(auto, waypoints), robot, field);
    const timing = estimate(planned, robot);
    const findings = check(planned, timing, robot, field, season);
    const rows = ledger(planned, field, season);
    const svg = render(planned, timing, findings, rows, {
      showLedger: true,
      waypoints,
    });
    return {
      svg,
      totals: `${(timing.nominalS ?? 0).toFixed(3)} (${(timing.lowS ?? 0).toFixed(3)}-${(timing.highS ?? 0).toFixed(3)})`,
    };
  };

  it("matches the picture checked in under examples/starter/.golden", () => {
    const { svg } = build();
    if (process.env["ZENITH_UPDATE_GOLDEN"] === "1" || !existsSync(goldenPath)) {
      mkdirSync(`${examples}.golden`, { recursive: true });
      writeFileSync(goldenPath, svg, "utf8");
    }
    const onDisk = readFileSync(goldenPath, "utf8").split("\r\n").join("\n");
    expect(
      svg,
      "the collect-and-score render changed; look at the picture, then regenerate with ZENITH_UPDATE_GOLDEN=1",
    ).toBe(onDisk);
  });

  it("estimates the routine well inside the autonomous period", () => {
    const { totals } = build();
    expect(totals).toBe("13.483 (10.786-16.179)");
  });

  it("is byte-identical on a second render", () => {
    expect(build().svg).toBe(build().svg);
  });
});
