import { describe, expect, it } from "vitest";
import { firstSentence } from "./firstSentence";

describe("firstSentence", () => {
  it("cuts at the first sentence end and keeps its full stop", () => {
    expect(firstSentence("Runs the front intake inward and keeps it running. The state parameter has one value.")).toBe(
      "Runs the front intake inward and keeps it running.",
    );
  });

  it("returns a one-sentence summary whole", () => {
    expect(firstSentence("Stops the front intake.")).toBe("Stops the front intake.");
    expect(firstSentence("The robot holds no pollen")).toBe("The robot holds no pollen");
  });

  it("never adds an ellipsis, whatever the length", () => {
    const long = `${"A long first sentence about the robot ".repeat(8).trim()}. And a second one.`;
    const cut = firstSentence(long);
    expect(cut).toBe(long.slice(0, long.indexOf(". ") + 1));
    expect(cut).not.toMatch(/…|\.\.\./);
    expect(firstSentence(`${"word ".repeat(80)}without an end`)).not.toMatch(/…|\.\.\./);
  });

  it("does not end a sentence at a decimal, or an abbreviation", () => {
    expect(firstSentence("Waits 0.5 s, e.g. for the launcher. Then goes on.")).toBe("Waits 0.5 s, e.g. for the launcher.");
    expect(firstSentence("Pass count 1.5 to 4 pollen. Next.")).toBe("Pass count 1.5 to 4 pollen.");
  });

  it("ends a sentence at etc. or approx. when a capitalised word follows, and not otherwise", () => {
    expect(firstSentence("Runs the intake, the belt, etc. Then it stops.")).toBe("Runs the intake, the belt, etc.");
    expect(firstSentence("Drives approx. Then turns.")).toBe("Drives approx.");
    expect(firstSentence("Runs the intake, belt, etc. until full. Then stops.")).toBe("Runs the intake, belt, etc. until full.");
    expect(firstSentence("Drives approx. 12 in forward. Then turns.")).toBe("Drives approx. 12 in forward.");
    expect(firstSentence("Scores red vs. Blue goal first. Then parks.")).toBe("Scores red vs. Blue goal first.");
  });

  it("keeps a closing quote or bracket after the end mark", () => {
    expect(firstSentence('Sets the mode to "fast." Then waits.')).toBe('Sets the mode to "fast."');
    expect(firstSentence("Spins up (the launcher.) Then fires.")).toBe("Spins up (the launcher.)");
    expect(firstSentence("Is it “full?” Check the sensor.")).toBe("Is it “full?”");
    expect(firstSentence("Stops [all motors!] Then waits.")).toBe("Stops [all motors!]");
  });

  it("ends a sentence at a question mark or an exclamation mark", () => {
    expect(firstSentence("Is it full? Check the sensor.")).toBe("Is it full?");
    expect(firstSentence("Stop now! Then wait.")).toBe("Stop now!");
  });

  it("treats a line break like a space, and trims", () => {
    expect(firstSentence("  Brings the launcher up to speed.\nEnds once it is at speed. ")).toBe("Brings the launcher up to speed.");
  });

  it("gives an empty string for an empty summary", () => {
    expect(firstSentence("")).toBe("");
    expect(firstSentence("   ")).toBe("");
  });
});
