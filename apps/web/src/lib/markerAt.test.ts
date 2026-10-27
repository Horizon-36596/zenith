import { describe, expect, it } from "vitest";
import { markerAtInUnit, markerMaxIn } from "./markerAt";

describe("markerAtInUnit", () => {
  it("clamps a fraction into 0 to 1", () => {
    expect(markerAtInUnit("t", 24)).toEqual({ t: 1 });
    expect(markerAtInUnit("t", -3)).toEqual({ t: 0 });
    expect(markerAtInUnit("t", 0.4)).toEqual({ t: 0.4 });
  });

  it("never gives a negative distance, from the start or from the end", () => {
    expect(markerAtInUnit("distanceIn", -12)).toEqual({ distanceIn: 12 });
    expect(markerAtInUnit("distanceFromEndIn", -12)).toEqual({ distanceFromEndIn: 12 });
    expect(markerAtInUnit("distanceIn", 7.5)).toEqual({ distanceIn: 7.5 });
  });

  it("never gives a distance longer than the path, when its length is known", () => {
    expect(markerAtInUnit("distanceFromEndIn", 500, 117.456)).toEqual({ distanceFromEndIn: 117.46 });
    expect(markerAtInUnit("distanceIn", 500, 117.456)).toEqual({ distanceIn: 117.46 });
    expect(markerAtInUnit("distanceIn", 40, 117.456)).toEqual({ distanceIn: 40 });
    expect(markerAtInUnit("distanceIn", 500, null)).toEqual({ distanceIn: 500 });
    expect(markerMaxIn(undefined)).toBeUndefined();
    expect(markerMaxIn(117.456)).toBe(117.46);
  });
});
