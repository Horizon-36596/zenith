import { describe, expect, it } from "vitest";
import { collectIds, effectiveId, uniqueId } from "./ids.js";
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
