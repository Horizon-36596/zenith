/** One date form across the account sheets: "Sat 3 Oct", "Sat 3 Oct, 18:30", the year when it is not this year. */
import { describe, expect, it } from "vitest";
import { dateWords } from "./keys/words";
import { dayWords, whenWords } from "./words";

const NOW = new Date(2026, 9, 23, 12, 0, 0).getTime();

describe("dates in the account sheets", () => {
  it("names the day and the time, adding the year only when it is not this year", () => {
    expect(dayWords(new Date(2026, 9, 3, 18, 30), NOW)).toBe("Sat 3 Oct");
    expect(whenWords(new Date(2026, 9, 3, 18, 30), NOW)).toBe("Sat 3 Oct, 18:30");
    expect(whenWords(new Date(2027, 2, 4, 9, 5), NOW)).toBe("Thu 4 Mar 2027, 09:05");
  });

  it("always gives the year on a recovery sheet, which is kept on paper", () => {
    expect(dateWords(new Date(2027, 2, 4, 9, 5))).toBe("Thu 4 Mar 2027");
    expect(dayWords(new Date(2026, 9, 3), NOW, { year: "always" })).toBe("Sat 3 Oct 2026");
  });
});
