/**
 * `writeTimeout` is the inspector's timeout field's edit function (`packages/panels/Inspector.tsx`
 * always shows the row for path/command/wait steps now; this is what clearing it has to do): `null`
 * clears the timeout rather than writing `timeoutS: null`, because canonical form only ever omits
 * the key or carries a positive number (`packages/core/src/canonicalize.ts` drops `undefined`
 * values, and `packages/core/src/edit/timing.ts`'s `setTimeout` treats `undefined` as "no timeout").
 */
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import { writeTimeout } from "./edits";
import { getState, openAuto } from "../state/store";

const fixture = () =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "edits-fixture",
    title: "Edits fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [
      {
        id: "leg1",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: 24, headingRad: 0 } }],
        heading: { mode: "tangent" },
        timeoutS: 3,
      },
      { id: "shoot", kind: "command", name: "score", timeoutS: 2 },
      { id: "sit", kind: "wait", seconds: 1 },
      {
        id: "park",
        kind: "parallel",
        mode: "all",
        steps: [{ id: "idle", kind: "command", name: "spinUp" }],
      },
    ],
  });

beforeEach(() => {
  openAuto("edits-fixture.auto.json", fixture(), canonicalize("auto", fixture()));
});

describe("writeTimeout", () => {
  it("sets a path step's timeoutS", () => {
    writeTimeout("leg1", 5);
    const step = getState().auto?.steps.find((candidate) => candidate.id === "leg1");
    expect(step?.kind === "path" && step.timeoutS).toBe(5);
  });

  it("clears a command step's timeoutS to null, dropping the key rather than writing null", () => {
    writeTimeout("shoot", null);
    const auto = getState().auto;
    if (auto === null) throw new Error("expected an open document");
    const step = auto.steps.find((candidate) => candidate.id === "shoot");
    expect(step?.kind === "command" && step.timeoutS).toBeUndefined();

    // The canonical bytes carry no timeoutS for "shoot" at all: not the key, and not `null`. Other
    // steps still have their own timeoutS, so this checks the parsed step, not a whole-file substring.
    const roundTripped = JSON.parse(canonicalize("auto", auto)) as { steps: Array<Record<string, unknown>> };
    const shoot = roundTripped.steps.find((candidate) => candidate["id"] === "shoot");
    expect(shoot).toBeDefined();
    expect(shoot).not.toHaveProperty("timeoutS");
  });

  it("sets a wait step's timeoutS, which starts absent", () => {
    writeTimeout("sit", 4);
    const step = getState().auto?.steps.find((candidate) => candidate.id === "sit");
    expect(step?.kind === "wait" && step.timeoutS).toBe(4);
  });

  it("leaves the document untouched when the step kind has no timeoutS", () => {
    const before = getState().auto;
    writeTimeout("park", 1);
    expect(getState().auto).toBe(before);
  });
});
