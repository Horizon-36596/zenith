import { describe, expect, it } from "vitest";
import { childLists, isGroupStep, STEP_KINDS, withChildLists, type Step } from "./auto.js";
import { SCHEMA_ID } from "./ids.js";
import { parseAuto, validateKind } from "./parse.js";

const autoWith = (steps: unknown[], formatVersion = 2): unknown => ({
  $schema: SCHEMA_ID.auto,
  formatVersion,
  name: "sequence-fixture",
  alliance: "RED",
  start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
  steps,
});

const wait = (id: string): Step => ({ id, kind: "wait", seconds: 0.5 });
const sequence = (id: string, steps: unknown[]): unknown => ({ id, kind: "sequence", steps });

describe("format version 2: the sequence step", () => {
  it("is allowed at the top level", () => {
    const auto = parseAuto(autoWith([sequence("grp", [wait("a"), wait("b")])]));
    expect(auto.steps[0]?.kind).toBe("sequence");
  });

  it("is allowed inside a parallel group, a branch arm and another sequence", () => {
    const steps = [
      {
        id: "par",
        kind: "parallel",
        mode: "deadline",
        deadline: "inner",
        steps: [sequence("inner", [wait("a"), sequence("deeper", [wait("b")])]), wait("c")],
      },
      {
        id: "br",
        kind: "branch",
        condition: "hopperFull",
        then: [sequence("thenSeq", [wait("d")])],
        else: [sequence("elseSeq", [wait("e")])],
      },
    ];
    expect(validateKind("auto", autoWith(steps))).toMatchObject({ ok: true });
  });

  it("needs at least one step", () => {
    expect(() => parseAuto(autoWith([sequence("grp", [])]))).toThrow(/steps/);
  });

  it("parses in a file that says it is v1, because v1 migrates to the current version unchanged", () => {
    // The loader is lenient about the version a file declares, never about its structure: a v1
    // file is a v2 file once it says so.
    expect(parseAuto(autoWith([sequence("grp", [wait("a")])], 1)).formatVersion).toBe(3);
  });

  it("walks through childLists and withChildLists for every group kind", () => {
    const seq: Step = { id: "s", kind: "sequence", steps: [wait("a")] };
    const par: Step = { id: "p", kind: "parallel", mode: "all", steps: [wait("a")] };
    const br: Step = {
      id: "b",
      kind: "branch",
      condition: "c",
      then: [wait("a")],
      else: [wait("b")],
    };
    expect(childLists(seq)).toEqual([[wait("a")]]);
    expect(childLists(par)).toEqual([[wait("a")]]);
    expect(childLists(br)).toEqual([[wait("a")], [wait("b")]]);
    expect(childLists(wait("x"))).toEqual([]);
    expect(withChildLists(seq, [[wait("z")]])).toEqual({ ...seq, steps: [wait("z")] });
    expect(withChildLists(br, [[wait("y")], [wait("z")]])).toEqual({
      ...br,
      then: [wait("y")],
      else: [wait("z")],
    });
    expect(isGroupStep(seq) && isGroupStep(par) && isGroupStep(br)).toBe(true);
    expect(isGroupStep(wait("x"))).toBe(false);
    expect(STEP_KINDS).toContain("sequence");
  });
});
