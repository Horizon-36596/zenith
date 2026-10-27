import { describe, expect, it } from "vitest";
import {
  arrowStart,
  arrowValue,
  clampToRange,
  commitWrites,
  inRange,
  rangeHint,
  rangeWords,
  refusedNumberLine,
  roundToDigits,
  steppedValue,
} from "./numberStep";

// The two fields that start from somewhere while empty, as the inspector sets them up.
const timeout = { min: 0.01 };
const speed = { min: 0.01, max: 1 };

describe("clampToRange", () => {
  it("holds a value to either end, and leaves an open end open", () => {
    expect(clampToRange(-1, speed)).toBe(0.01);
    expect(clampToRange(2, speed)).toBe(1);
    expect(clampToRange(0.5, speed)).toBe(0.5);
    expect(clampToRange(1e6, timeout)).toBe(1e6);
    expect(clampToRange(-5, {})).toBe(-5);
  });
});

describe("roundToDigits", () => {
  it("rounds to what a field with that many decimals shows", () => {
    expect(roundToDigits(5.25, 0)).toBe(5);
    expect(roundToDigits(0.3625, 2)).toBe(0.36);
    expect(roundToDigits(0.3125, 2)).toBe(0.31);
    expect(roundToDigits(90.04, 1)).toBe(90);
    // The float noise of adding steps goes too, so the file holds the number the field shows.
    expect(roundToDigits(0.3 + 5 * 0.05, 2)).toBe(0.55);
  });

  it("rounds a half away from zero on both sides, as toFixed shows it", () => {
    expect(roundToDigits(0.25, 1)).toBe(0.3);
    expect(roundToDigits(-0.25, 1)).toBe(-0.3);
    expect(roundToDigits(2.5, 0)).toBe(3);
    expect(roundToDigits(-2.5, 0)).toBe(-3);
  });

  it("gives 0, never -0, for a small negative value", () => {
    expect(Object.is(roundToDigits(-0.004, 2), 0)).toBe(true);
    expect(Object.is(roundToDigits(-0, 0), 0)).toBe(true);
  });
});

describe("steppedValue on an empty Timeout, which starts from 0 below its 0.01 s floor", () => {
  it("leaves the field empty on ArrowDown, rather than writing the 0.01 s floor", () => {
    expect(steppedValue(0, -0.1, timeout, true)).toBeNull();
    expect(steppedValue(0, -0.4, timeout, true)).toBeNull();
  });

  it("leaves it empty on a drag to the left", () => {
    expect(steppedValue(0, -3 * 0.1, timeout, true)).toBeNull();
    expect(steppedValue(0, -50 * 0.1 * 4, timeout, true)).toBeNull();
  });

  it("steps up from nothing on ArrowUp", () => {
    expect(steppedValue(0, 0.1, timeout, true)).toBeCloseTo(0.1, 9);
  });

  it("empties the field again when a drag that began on it comes back past where it started", () => {
    expect(steppedValue(0, 5 * 0.1, timeout, true)).toBeCloseTo(0.5, 9);
    expect(steppedValue(0, -3 * 0.1, timeout, true)).toBeNull();
  });
});

describe("steppedValue on an empty Speed, which starts from the robot's 0.80 default", () => {
  it("steps down to 0.75 and up to 0.85", () => {
    expect(steppedValue(0.8, -0.05, speed, true)).toBeCloseTo(0.75, 9);
    expect(steppedValue(0.8, 0.05, speed, true)).toBeCloseTo(0.85, 9);
  });

  it("stops a long drag to the left at the floor, as a set speed does", () => {
    expect(steppedValue(0.8, -40 * 0.05, speed, true)).toBe(0.01);
  });

  it("stops at the top of the range", () => {
    expect(steppedValue(0.8, 10 * 0.05, speed, true)).toBe(1);
  });
});

describe("steppedValue on a field with a value", () => {
  it("is held to the floor as before, so ArrowDown on a 0.10 s Timeout gives 0.01 s", () => {
    expect(steppedValue(0.1, -0.1, timeout, false)).toBe(0.01);
    expect(steppedValue(0.5, -10, speed, false)).toBe(0.01);
  });

  it("moves freely on a field with no range", () => {
    expect(steppedValue(2, -5, {}, false)).toBe(-3);
    expect(steppedValue(0, -5, {}, true)).toBe(-5);
  });
});

describe("commitWrites", () => {
  it("writes nothing for text nobody typed in, so Enter keeps an unrounded number exact", () => {
    // A heading of 1.3 rad shows as 74, and an x of -40.25 as -40.3.
    expect(commitWrites("74", "74", false)).toBe(false);
    expect(commitWrites("-40.3", "-40.3", false)).toBe(false);
  });

  it("writes nothing for typed text that is back to what the field showed", () => {
    expect(commitWrites("-40.3", "-40.3", true)).toBe(false);
    expect(commitWrites(" 74 ", "74", true)).toBe(false);
  });

  it("writes typed text that differs, an emptied field included", () => {
    expect(commitWrites("-30", "-40.3", true)).toBe(true);
    expect(commitWrites("-40.30", "-40.3", true)).toBe(true);
    expect(commitWrites("", "0.80", true)).toBe(true);
  });
});

describe("arrowValue", () => {
  it("writes the number the field shows, without float drift (issue #314)", () => {
    let value = 0.3;
    for (let press = 0; press < 3; press += 1) value = arrowValue(value, 0.05, speed, false, 2) ?? value;
    expect(value).toBe(0.45);
    expect(arrowValue(0.45, -0.05, speed, false, 2)).toBe(0.4);
  });

  it("holds the rounded value to the range, and keeps an empty start below the floor empty", () => {
    expect(arrowValue(0.98, 0.05, speed, false, 2)).toBe(1);
    expect(arrowValue(0.03, -0.05, speed, false, 2)).toBe(0.01);
    expect(arrowValue(0, -0.5, timeout, true, 2)).toBeNull();
    expect(arrowValue(0, 0.5, timeout, true, 2)).toBe(0.5);
  });
});

describe("arrowStart (issue #403)", () => {
  it("starts from the number typed and not yet committed, not from the stored value", () => {
    // Value 1, "10" typed, ArrowUp by 0.5: the press writes 10.5, never 1.5 with 10 still on screen.
    const start = arrowStart(1, undefined, 10);
    expect(start).toEqual({ from: 10, startedEmpty: false });
    expect(arrowValue(start?.from ?? NaN, 0.5, {}, start?.startedEmpty ?? false, 2)).toBe(10.5);
  });

  it("starts from a number typed into an empty field as from a value, not from the empty start", () => {
    expect(arrowStart(null, 0.8, 0.3)).toEqual({ from: 0.3, startedEmpty: false });
  });

  it("starts from the value, or the empty start while empty, when nothing was typed", () => {
    expect(arrowStart(2, undefined, null)).toEqual({ from: 2, startedEmpty: false });
    expect(arrowStart(null, 0.8, null)).toEqual({ from: 0.8, startedEmpty: true });
    expect(arrowStart(null, undefined, null)).toBeNull();
  });
});

describe("a number field's range, in words (issue #502)", () => {
  it("names both ends, with the unit once and % and ° tight", () => {
    expect(rangeWords({ min: 1, max: 100 }, "%", 0)).toBe("1 to 100%");
    expect(rangeWords({ min: 0, max: 30 }, "s", 1)).toBe("0 to 30 s");
    expect(rangeWords({ min: -84, max: 84 }, "in", 2)).toBe("-84 to 84 in");
    expect(rangeWords({ min: 0.1 }, "in/s", 1)).toBe("0.1 in/s or more");
    expect(rangeWords({ max: 5 }, undefined, 0)).toBe("5 or less");
    expect(rangeWords({}, "in", 2)).toBeNull();
  });

  it("says a refused value's range once, and what a number field takes for text that is not one", () => {
    expect(refusedNumberLine("Speed", { min: 1, max: 100 }, "%", 0, false)).toBe("Speed runs 1 to 100%.");
    expect(refusedNumberLine("Speed", { min: 1, max: 100 }, "%", 0, true)).toBe("Speed takes a number from 1 to 100%.");
    expect(refusedNumberLine("Top speed forward", { min: 0.1 }, "in/s", 1, false)).toBe("Top speed forward takes 0.1 in/s or more.");
    expect(refusedNumberLine("Nudge", {}, "in", 2, true)).toBe("Nudge takes a number.");
  });

  it("ends the tooltip with the range, and knows what is in it", () => {
    expect(rangeHint({ min: 0, max: 30 }, "s", 1)).toBe("Runs 0 to 30 s.");
    expect(rangeHint({ min: 0 }, "in", 2)).toBe("Takes 0 in or more.");
    expect(rangeHint({}, "in", 2)).toBeNull();
    expect(inRange(100, { min: 1, max: 100 })).toBe(true);
    expect(inRange(150, { min: 1, max: 100 })).toBe(false);
    expect(inRange(-5, { min: 1 })).toBe(false);
    expect(inRange(99999, {})).toBe(true);
  });
});
