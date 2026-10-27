/**
 * The speed a Full sim run goes at (simSpeed.ts): the person's choice when the project has a sim
 * server, and Basic, with the reason, when it does not.
 */
import { describe, expect, it } from "vitest";
import { SIM_SPEEDS, effectiveSimSpeed, simSpeedLimit } from "./simSpeed";

const withServer = { sim: { server: { prepare: "./gradlew prepareSimServer", args: "build/sim/server.args" } } };

describe("the Full sim speed", () => {
  it("is the chosen speed for a project with a sim server", () => {
    for (const speed of SIM_SPEEDS) expect(effectiveSimSpeed(speed, withServer)).toBe(speed);
    expect(simSpeedLimit(withServer)).toBeNull();
  });

  it("is Basic, and says why, for a project with no sim.server, no sim section or no project", () => {
    for (const link of [{ sim: {} }, {}, null, undefined]) {
      expect(effectiveSimSpeed("ultrafast", link)).toBe("basic");
      expect(effectiveSimSpeed("fast", link)).toBe("basic");
      expect(simSpeedLimit(link)).toContain("no sim.server section");
    }
  });
});
