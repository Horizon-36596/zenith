import { describe, expect, it } from "vitest";
import { EditError } from "./errors.js";
import { setMeta, setStart } from "./meta.js";
import { canonicalRoundTrip, testAuto } from "./testing.js";

describe("setMeta", () => {
  it("sets title, description and authors", () => {
    const result = setMeta(testAuto(), {
      title: "New title",
      description: "New description",
      authors: ["example-user"],
    });
    expect(result.title).toBe("New title");
    expect(result.description).toBe("New description");
    expect(result.authors).toEqual(["example-user"]);
    canonicalRoundTrip(result);
  });

  it("leaves a field out of meta unchanged", () => {
    const auto = setMeta(testAuto(), { title: "Keep me" });
    const result = setMeta(auto, { description: "Only this changes" });
    expect(result.title).toBe("Keep me");
    expect(result.description).toBe("Only this changes");
    canonicalRoundTrip(result);
  });

  it("clears a field given explicit undefined", () => {
    const auto = setMeta(testAuto(), { title: "Has a title" });
    const result = setMeta(auto, { title: undefined });
    expect(result.title).toBeUndefined();
    canonicalRoundTrip(result);
  });
});

describe("setStart", () => {
  it("replaces the start pose and holds", () => {
    const result = setStart(testAuto(), {
      pose: { xIn: 10, yIn: -10, headingRad: 1.2 },
      holds: { pollen: 4 },
    });
    expect(result.start).toEqual({ pose: { xIn: 10, yIn: -10, headingRad: 1.2 }, holds: { pollen: 4 } });
    canonicalRoundTrip(result);
  });

  it("accepts a waypoint ref for the start pose", () => {
    const result = setStart(testAuto(), { pose: { ref: "start" } });
    expect(result.start.pose).toEqual({ ref: "start" });
    canonicalRoundTrip(result);
  });

  it("rejects a pose with an empty waypoint ref via the schema", () => {
    expect(() => setStart(testAuto(), { pose: { ref: "" } })).toThrow(EditError);
  });
});
