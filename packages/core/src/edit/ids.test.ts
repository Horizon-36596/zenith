import type { Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import {
  collectIds,
  effectiveId,
  nonCompliantStepIds,
  numberedId,
  STEP_ID_MAX,
  STEP_ID_NAME_PATTERN,
  stepIdFrom,
  stepIdProblem,
  uniqueId,
} from "./ids.js";
import { WAYPOINT_NAME_MAX, WAYPOINT_NAME_PATTERN, waypointNameProblem } from "./waypoints.js";
import { testAuto } from "./testing.js";

describe("collectIds", () => {
  it("collects every explicit id, nested included", () => {
    expect([...collectIds(testAuto().steps)].sort()).toEqual(
      ["drive", "leg1", "park", "shoot", "spinDown"].sort(),
    );
  });
});

describe("effectiveId", () => {
  it("falls back to a positional id when a step carries none", () => {
    const step = { kind: "command", name: "x" } as const;
    expect(effectiveId(step, 0, "step")).toBe("step1");
    expect(effectiveId(step, 4, "step")).toBe("step5");
  });

  it("prefers the explicit id", () => {
    const step = { id: "custom", kind: "command", name: "x" } as const;
    expect(effectiveId(step, 4, "step")).toBe("custom");
  });
});

describe("uniqueId", () => {
  it("returns the base when it is free", () => {
    expect(uniqueId("path", new Set())).toBe("path");
  });

  it("suffixes with -2, -3, ... until one is free", () => {
    expect(uniqueId("path", new Set(["path"]))).toBe("path-2");
    expect(uniqueId("path", new Set(["path", "path-2", "path-3"]))).toBe("path-4");
  });
});

describe("numberedId", () => {
  it("starts at 1 and takes the lowest free number", () => {
    expect(numberedId("path", new Set())).toBe("path1");
    expect(numberedId("path", new Set(["path1", "path2"]))).toBe("path3");
    expect(numberedId("path", new Set(["path2"]))).toBe("path1");
  });

  it("ignores ids from older files, such as leg1, that use another base", () => {
    expect(numberedId("path", new Set(["leg1", "leg2"]))).toBe("path1");
  });
});

describe("the step id rule", () => {
  it("is the waypoint name rule, one constant", () => {
    expect(STEP_ID_NAME_PATTERN).toBe(WAYPOINT_NAME_PATTERN);
    expect(STEP_ID_MAX).toBe(WAYPOINT_NAME_MAX);
  });

  it("says why an id cannot be used, in the sentence a waypoint name gets", () => {
    expect(stepIdProblem("")).toBe("A step needs an id.");
    expect(stepIdProblem("shoot preload")).toBe("A step's id starts with a letter and holds only letters, digits, _ and -.");
    expect(stepIdProblem("2nd")).toBe(stepIdProblem("shoot preload"));
    expect(stepIdProblem("park.2")).toBe(stepIdProblem("shoot preload"));
    expect(stepIdProblem("a".repeat(65))).toBe("A step's id is at most 64 characters.");
    expect(stepIdProblem("a".repeat(64))).toBeNull();
    expect(stepIdProblem("shoot_preload-2")).toBeNull();
    expect(waypointNameProblem("shoot preload", undefined)).toBe(
      "A waypoint's name starts with a letter and holds only letters, digits, _ and -.",
    );
  });

  it("counts every effective id as taken but the step being renamed", () => {
    expect(stepIdProblem("leg1", testAuto())).toBe("There is already a step named leg1.");
    expect(stepIdProblem("spinDown", testAuto())).toBe("There is already a step named spinDown.");
    expect(stepIdProblem("leg1", testAuto(), "leg1")).toBeNull();
    expect(stepIdProblem("volley", testAuto())).toBeNull();
  });
});

describe("stepIdFrom", () => {
  it("drops what the rule does not allow and starts each word after it with a capital", () => {
    expect(stepIdFrom("shoot preload", new Set())).toBe("shootPreload");
    expect(stepIdFrom("park.2", new Set())).toBe("park2");
    expect(stepIdFrom("score: high (left)", new Set())).toBe("scoreHighLeft");
    expect(stepIdFrom("arm_up-1", new Set())).toBe("arm_up-1");
  });

  it("puts step in front when what is left does not start with a letter", () => {
    expect(stepIdFrom("2nd shot", new Set())).toBe("step2ndShot");
    expect(stepIdFrom("_x", new Set())).toBe("step_x");
    expect(stepIdFrom("!!!", new Set())).toBe("step");
  });

  it("makes the id unique and keeps it inside the length limit", () => {
    expect(stepIdFrom("shoot preload", new Set(["shootPreload"]))).toBe("shootPreload-2");
    const long = stepIdFrom(`${"a".repeat(70)} b`, new Set(["a".repeat(64)]));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(stepIdProblem(long)).toBeNull();
  });
});

describe("nonCompliantStepIds", () => {
  it("lists explicit ids outside the rule and never a positional one", () => {
    const steps: Step[] = [
      { id: "shoot preload", kind: "wait", seconds: 1 },
      { kind: "sequence", steps: [{ kind: "wait", seconds: 1 }, { id: "g.2", kind: "wait", seconds: 1 }] },
      { id: "park", kind: "wait", seconds: 1 },
    ];
    expect(nonCompliantStepIds(steps)).toEqual(["shoot preload", "g.2"]);
  });
});
