import { parseAuto, SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { canonicalize } from "../canonicalize.js";

/**
 * A small, three-step auto for the edit primitive tests: a path with a marker, a command, and a
 * `parallel` group with a `deadline`, so the tests can exercise both flat and nested addressing.
 * Not exported from the package's public surface; `edit/*.test.ts` import it directly.
 */
export function testAuto(): Auto {
  return parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "edit-fixture",
    title: "Edit fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [
      {
        id: "leg1",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: 24, headingRad: 0 } }],
        heading: { mode: "tangent" },
        speedFraction: 0.8,
        markers: [{ at: { t: 0.5 }, command: { name: "shootAll", args: { count: 3 } } }],
        timeoutS: 3,
      },
      { id: "shoot", kind: "command", name: "shootAll", args: { count: 4 }, timeoutS: 2 },
      {
        id: "park",
        kind: "parallel",
        mode: "deadline",
        deadline: "drive",
        steps: [
          {
            id: "drive",
            kind: "path",
            segments: [{ kind: "line", from: "current", to: { xIn: 12, yIn: 24, headingRad: 0 } }],
            heading: { mode: "tangent" },
          },
          { id: "spinDown", kind: "command", name: "launcherIdle" },
        ],
      },
    ],
  });
}

/** Canonicalizing twice must give the same bytes: the standard round-trip assertion. */
export function canonicalRoundTrip(auto: Auto): string {
  const once = canonicalize("auto", auto);
  const twice = canonicalize("auto", parseAuto(JSON.parse(once) as unknown));
  if (once !== twice) throw new Error("canonicalize is not idempotent for this auto.");
  return once;
}
