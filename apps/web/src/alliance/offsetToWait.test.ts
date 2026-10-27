import { beforeEach, describe, expect, it } from "vitest";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { getState, openAuto, redo, undo } from "../state/store";
import { offsetToWait } from "./actions";
import { offsetToWaitBlocked } from "./OffsetToWait";
import { getAllianceState, resetAlliance, setOwnOffset } from "./store";

/**
 * When "Make it a wait step" can turn the start offset into a real wait, and what it says when it
 * cannot. The edit itself is core's `insertStartWait`, tested there; the click is in the e2e.
 */
describe("offsetToWaitBlocked", () => {
  it("allows a positive own offset, whatever the partners' offsets are", () => {
    expect(offsetToWaitBlocked(0.5, [], false)).toBeNull();
    expect(offsetToWaitBlocked(0.5, [1.2], false)).toBeNull();
  });

  it("says a partner's wait belongs in the partner's auto when only the partner waits", () => {
    const why = offsetToWaitBlocked(0, [0, 0.8], false);
    expect(why).toContain("it is your partner who waits");
    expect(why).toContain("ask them to add it to theirs");
  });

  it("says there is nothing to make when nobody waits, and refuses in review mode", () => {
    expect(offsetToWaitBlocked(0, [0], false)).toContain("no wait to make");
    expect(offsetToWaitBlocked(0.5, [], true)).toBe("Review mode is read only.");
  });
});

describe("offsetToWait and undo", () => {
  const fixture = () =>
    loadAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "offset-fixture",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
      steps: [{ id: "shoot", kind: "command", name: "score" }],
    });

  beforeEach(() => {
    resetAlliance();
    openAuto("offset-fixture.auto.json", fixture(), canonicalize("auto", fixture()));
  });

  it("puts the start offset back when the wait it became is undone, and takes it away again on redo", () => {
    setOwnOffset(0.5);
    offsetToWait();
    expect(getState().auto?.steps.map((step) => step.kind)).toEqual(["wait", "command"]);
    expect(getAllianceState().ownOffsetS).toBe(0);

    undo();
    expect(getState().auto?.steps.map((step) => step.kind)).toEqual(["command"]);
    expect(getAllianceState().ownOffsetS).toBe(0.5);

    redo();
    expect(getState().auto?.steps.map((step) => step.kind)).toEqual(["wait", "command"]);
    expect(getAllianceState().ownOffsetS).toBe(0);
  });

  it("leaves an offset the user set after the wait alone", () => {
    setOwnOffset(0.5);
    offsetToWait();
    setOwnOffset(1.2);
    undo();
    expect(getAllianceState().ownOffsetS).toBe(1.2);
  });
});
