/**
 * The auto dialog's "Holds at start" (issue #403): an edit changes the first preloaded kind and keeps
 * every other kind the file preloads; it once wrote `{ [kind]: count }` and dropped the rest.
 */
import { describe, expect, it } from "vitest";
import type { Auto, Field } from "@horizon36596/zenith-schema";
import { firstHold, setFirstHold, startHoldKind } from "./startHolds";

const auto = (holds?: Record<string, number>): Auto =>
  ({
    formatVersion: 1,
    name: "holds",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 }, ...(holds === undefined ? {} : { holds }) },
    steps: [],
  }) as unknown as Auto;

describe("Holds at start", () => {
  it("changes the first kind and keeps the others", () => {
    const next = setFirstHold(auto({ pollen: 1, nectar: 2 }), 3);
    expect(next.start.holds).toEqual({ pollen: 3, nectar: 2 });
    expect(firstHold(next)).toBe(3);
  });

  it("leaves an auto that preloads nothing as it is when no kind is given", () => {
    const none = auto();
    expect(setFirstHold(none, 2)).toBe(none);
    expect(firstHold(none)).toBeNull();
  });

  it("gives an auto that preloads nothing the one kind of piece the field places (issue #502)", () => {
    const field = (kinds: string[]): Field =>
      ({ elements: [{ id: "c", kind: "container", container: "flower" }, ...kinds.map((kind, index) => ({ id: `p${String(index)}`, kind, container: index === 0 ? null : "c" }))] }) as unknown as Field;
    expect(startHoldKind(auto(), field(["pollen", "pollen"]))).toBe("pollen");
    expect(startHoldKind(auto(), field(["pollen", "nectar"]))).toBeNull();
    expect(startHoldKind(auto(), null)).toBeNull();
    expect(startHoldKind(auto({ nectar: 1 }), field(["pollen"]))).toBe("nectar");
    expect(setFirstHold(auto(), 2, "pollen").start.holds).toEqual({ pollen: 2 });
  });
});
