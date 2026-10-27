/**
 * What caps a wait for a condition (issue #242): its Timeout, shown as state after the Until select,
 * or a warning when the step has none.
 */
import { describe, expect, it } from "vitest";
import { NO_TIMEOUT_WARNING, waitCapText } from "./waitCap";

describe("the wait cap", () => {
  it("reads the Timeout as an upper bound in seconds", () => {
    expect(waitCapText(1)).toBe("≤ 1.00 s");
    expect(waitCapText(2.5)).toBe("≤ 2.50 s");
    expect(waitCapText(0.125)).toBe("≤ 0.13 s");
  });

  it("warns about a wait with no Timeout in a short sentence", () => {
    expect(NO_TIMEOUT_WARNING).toBe("No time limit: may wait to the end");
  });
});
