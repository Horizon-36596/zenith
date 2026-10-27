import { envelopeShapeProblem, setEnvelope, setRejoinFrom } from "@horizon36596/zenith-core";
import { parseAuto, parseRobot, SCHEMA_ID, type Auto, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENVELOPE_PROVENANCE,
  DEFAULT_ENVELOPE_SIDE_IN,
  defaultEnvelopeFor,
  defaultEnvelopeSeconds,
  defaultRejoinFor,
  offersRejoin,
} from "./envelope";
import { findEntry } from "./stepOps";

/** The inspector's Envelope and Rejoin sections start from these (spec 13 section 10). */

const robot: Robot = parseRobot({
  $schema: SCHEMA_ID.robot,
  formatVersion: 1,
  name: "Envelope test robot",
  frame: { forward: "+x", left: "+y", headingZero: "+x", headingPositive: "ccw" },
  footprint: {
    startIn: { lengthIn: 18, widthIn: 18, provenance: "PLACEHOLDER: test fixture" },
    expandedIn: { lengthIn: 18, widthIn: 18, provenance: "PLACEHOLDER: test fixture" },
    centreOfRotationIn: { xIn: 0, yIn: 0 },
  },
  kinematics: {
    maxForwardVelInPerS: { value: 60, provenance: "PLACEHOLDER: test fixture" },
    maxStrafeVelInPerS: { value: 50, provenance: "PLACEHOLDER: test fixture" },
    forwardDecelInPerS2: { value: 80, provenance: "PLACEHOLDER: test fixture" },
    strafeDecelInPerS2: { value: 40, provenance: "PLACEHOLDER: test fixture" },
    accelInPerS2: { value: 80, provenance: "PLACEHOLDER: test fixture" },
    maxAngularVelRadPerS: { value: 6, provenance: "PLACEHOLDER: test fixture" },
    defaultPathSpeedFraction: { value: 0.8, provenance: "PLACEHOLDER: test fixture" },
    follower: { library: "pedro", version: "3.0.0-20260828.185437-17", holdEnd: true },
  },
  commands: [
    { name: "score", estimateS: "1" },
    { name: "collect", estimateS: "unknown", movesRobot: true },
  ],
});

const auto = (steps: unknown[]): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 3,
    name: "inspector-envelope",
    alliance: "RED",
    start: { pose: { xIn: -36, yIn: -60, headingRad: 1.5708 } },
    steps,
  });

const back = { id: "back", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: -36, yIn: 0 } }], heading: { mode: "tangent" } };

describe("Add an envelope", () => {
  const start = { xIn: -36, yIn: -60, headingRad: 1.5708 };

  it("writes a 24 in square round the step's start, labelled as the editor's", () => {
    const envelope = defaultEnvelopeFor({ id: "collect", kind: "command", name: "collect" }, start, null);
    expect(DEFAULT_ENVELOPE_SIDE_IN).toBe(24);
    expect(envelope.polygon).toEqual([
      { xIn: -48, yIn: -72 },
      { xIn: -24, yIn: -72 },
      { xIn: -24, yIn: -48 },
      { xIn: -48, yIn: -48 },
    ]);
    expect(envelope.provenance).toBe(DEFAULT_ENVELOPE_PROVENANCE);
    expect(envelopeShapeProblem(envelope.polygon)).toBeNull();
  });

  it("takes its window from the timeout, else the estimate, else the whole period", () => {
    expect(defaultEnvelopeSeconds({ kind: "command", name: "collect", timeoutS: 5 }, 2)).toBe(5);
    expect(defaultEnvelopeSeconds({ kind: "command", name: "collect" }, 2)).toBe(2);
    expect(defaultEnvelopeSeconds({ kind: "command", name: "collect" }, null)).toBe(30);
    expect(defaultEnvelopeSeconds({ kind: "command", name: "collect", timeoutS: 45 }, null)).toBe(30);
  });

  it("is an edit the file accepts, on every step kind the section appears for", () => {
    let doc = auto([
      { id: "collect", kind: "command", name: "collect" },
      { id: "hold", kind: "wait", seconds: 1 },
      back,
    ]);
    for (const id of ["collect", "hold", "back"]) {
      const entry = findEntry(doc, id);
      if (entry === undefined) throw new Error(id);
      doc = setEnvelope(doc, id, defaultEnvelopeFor(entry.step, start, null));
    }
    expect(doc.steps.every((step) => "envelope" in step)).toBe(true);
  });
});

describe("the rejoin pose", () => {
  it("is offered on a current path right after a command that moves the robot, and nowhere else", () => {
    const after = auto([{ id: "collect", kind: "command", name: "collect" }, back]);
    const afterScore = auto([{ id: "score", kind: "command", name: "score" }, back]);
    const first = auto([back]);
    const offered = (doc: Auto): boolean => {
      const entry = findEntry(doc, "back");
      if (entry === undefined) throw new Error("no back step");
      return offersRejoin(doc, entry, robot);
    };
    expect(offered(after)).toBe(true);
    expect(offered(afterScore)).toBe(false);
    expect(offered(first)).toBe(false);
  });

  it("stays offered once set, so it can be cleared", () => {
    const doc = setRejoinFrom(
      auto([{ id: "score", kind: "command", name: "score" }, back]),
      "back",
      defaultRejoinFor({ xIn: -36, yIn: -60, headingRad: 1.5708 }),
    );
    const entry = findEntry(doc, "back");
    if (entry === undefined) throw new Error("no back step");
    expect(offersRejoin(doc, entry, robot)).toBe(true);
  });
});
