/**
 * Where Insert → Path puts a new end (QA-04): 24 in along the anchor's heading, cut short so the
 * footprint stays on the field, or 24 in toward the field centre when that leaves less than 12 in.
 * Checked at each of the four walls with the example robot, its intake pushed out past its body.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, fieldBounds, footprintBoundsIn, loadAuto, loadField, loadRobot } from "@horizon36596/zenith-core";
import type { Auto, PathStep, Pose } from "@horizon36596/zenith-schema";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { currentDerived, getState, openAuto, openProject, selectStep } from "../state/store";
import { addPathStep } from "./edits";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const starter = loadRobot(read("robot.json"));
// The starter's intake is flush with its frame. Moved 2 in forward, it reaches past the body, which is
// the case QA-04 was about: the new end has to keep the mouth on the field, not just the frame.
const robot = {
  ...starter,
  mouths: (starter.mouths ?? []).map((mouth) => ({
    ...mouth,
    offsetIn: { ...mouth.offsetIn, xIn: mouth.offsetIn.xIn + 2 },
  })),
};
const field = loadField(read("field/biobuzz.field.json"));
const project: Project = {
  source: { kind: "example" },
  name: "reach-fixture",
  link: { autosDir: "autos", robot: "robot.json", field: "field.json" } as Project["link"],
  robot,
  field,
  autoFiles: [],
  autoTexts: {},
};

/** A routine of one straight leg from the centre to `endIn`, so the robot ends facing that way. */
const toward = (endIn: { xIn: number; yIn: number }): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "reach-fixture",
    title: "Reach fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: Math.atan2(endIn.yIn, endIn.xIn) } },
    steps: [
      {
        id: "leg",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { ...endIn, headingRad: 0 } }],
        heading: { mode: "tangent" },
      },
    ],
  });

const insertAfterLeg = (auto: Auto): { id: string; to: Pose } => {
  openAuto("reach-fixture.auto.json", auto, canonicalize("auto", auto));
  selectStep("leg");
  const id = addPathStep();
  if (id === null) throw new Error("the insert was refused");
  const step = getState().auto?.steps.find((candidate) => candidate.id === id) as PathStep | undefined;
  const to = step?.segments[0]?.to;
  if (to === undefined || to === "current" || "ref" in to) throw new Error("expected an inline end");
  return { id, to };
};

const onField = (pose: Pose): boolean => {
  const box = footprintBoundsIn({ xIn: pose.xIn, yIn: pose.yIn, headingRad: pose.headingRad ?? 0 }, robot);
  const wall = fieldBounds(field);
  const slack = 1e-6;
  return (
    box.minXIn >= wall.minXIn - slack &&
    box.maxXIn <= wall.maxXIn + slack &&
    box.minYIn >= wall.minYIn - slack &&
    box.maxYIn <= wall.maxYIn + slack
  );
};

const perimeterOn = (id: string): number =>
  currentDerived().findings.filter((finding) => finding.code === "PERIMETER" && finding.stepId === id).length;

beforeEach(() => {
  openProject(project, { kind: "local" } as unknown as ProjectBackend);
});

/** A turn-back leg must still go somewhere a person would notice. */
const NEAR = 12;

const WALLS = [
  { wall: "the far wall (+x)", end: { xIn: 58, yIn: 0 } },
  { wall: "the near wall (-x)", end: { xIn: -58, yIn: 0 } },
  { wall: "the left wall (+y)", end: { xIn: 0, yIn: 58 } },
  { wall: "the right wall (-y)", end: { xIn: 0, yIn: -58 } },
];

describe("a path inserted after a step facing a wall", () => {
  for (const { wall, end } of WALLS) {
    it(`stays on the field and raises no PERIMETER at ${wall}`, () => {
      const { id, to } = insertAfterLeg(toward(end));
      expect(onField(to), `ends at (${to.xIn.toFixed(1)}, ${to.yIn.toFixed(1)})`).toBe(true);
      expect(perimeterOn(id)).toBe(0);
      // Too close to go on, so it turns back toward the centre, and still drives somewhere.
      const reach = Math.hypot(to.xIn - end.xIn, to.yIn - end.yIn);
      expect(reach).toBeGreaterThan(NEAR);
      expect(Math.hypot(to.xIn, to.yIn)).toBeLessThan(Math.hypot(end.xIn, end.yIn));
    });
  }

  it("keeps the anchor's heading and a full 24 in when there is room", () => {
    const { id, to } = insertAfterLeg(toward({ xIn: 0, yIn: 0.001 }));
    expect(Math.hypot(to.xIn, to.yIn)).toBeCloseTo(24, 1);
    expect(perimeterOn(id)).toBe(0);
  });

  it("cuts the leg short along the heading when 12 in or more is left", () => {
    const { id, to } = insertAfterLeg(toward({ xIn: 48, yIn: 0 }));
    expect(to.yIn).toBeCloseTo(0, 6);
    expect(to.xIn - 48).toBeGreaterThanOrEqual(12);
    expect(to.xIn - 48).toBeLessThan(24);
    expect(onField(to)).toBe(true);
    expect(perimeterOn(id)).toBe(0);
  });
});

