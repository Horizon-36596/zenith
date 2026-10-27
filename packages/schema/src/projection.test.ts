import { describe, expect, it } from "vitest";
import { detectKind, migrate } from "./migrate.js";
import { FORMAT_VERSIONS, SCHEMA_ID } from "./ids.js";
import { parseProjection, SchemaError, validateKind } from "./parse.js";
import {
  MAX_PROJECTION_CLAIMS,
  MAX_PROJECTION_COMMANDS,
  MAX_PROJECTION_LIST_LENGTH,
  MAX_PROJECTION_ENVELOPES,
  MAX_PROJECTION_PHASES,
  MAX_PROJECTION_POSES,
  MAX_PROJECTION_STEP_DEPTH,
  MAX_PROJECTION_STRING_LENGTH,
} from "./projection.js";

/**
 * The projection file (spec 13 section 8.2) is the one Zenith file that
 * another team hands us, so its schema is strict where the others are forgiving: an unknown key
 * anywhere is refused rather than dropped, and every array and string has a cap.
 */

const viewProjection = (): Record<string, unknown> => ({
  $schema: SCHEMA_ID.projection,
  formatVersion: 1,
  kind: "projection",
  level: "view",
  season: "biobuzz",
  alliance: "RED",
  title: "Close",
  startPose: { xIn: -40, yIn: -63, headingRad: 1.5708 },
  boundingBox: { lengthIn: 18, widthIn: 14, centreOffsetIn: { xIn: 0, yIn: 0 } },
  trajectory: {
    rateHz: 10,
    positionQuantumIn: 0.5,
    headingQuantumRad: 0.0175,
    poses: [
      [-40, -63, 1.5708],
      [-40, -62.5, 1.5708],
    ],
  },
  phases: [{ startS: 0, endS: 0.1, label: "drive" }],
  claims: [{ elementId: "gardenRed", action: "take", atS: 0 }],
  envelopes: [
    {
      startS: 0,
      endS: 0.1,
      polygon: [
        { xIn: -72, yIn: -48 },
        { xIn: -36, yIn: -48 },
        { xIn: -36, yIn: -12 },
      ],
    },
  ],
  totalS: 0.1,
});

const proposeProjection = (): Record<string, unknown> => ({
  ...viewProjection(),
  level: "propose",
  structure: {
    steps: [
      {
        id: "s1",
        kind: "path",
        timeoutS: 3,
        segments: [
          {
            kind: "bezier",
            from: { xIn: -40, yIn: -63, headingRad: 1.5708 },
            control: [{ xIn: -40, yIn: -50 }],
            to: { xIn: -30, yIn: -40, headingRad: 0 },
          },
        ],
        heading: { mode: "linear", fromRad: 1.5708, toRad: 0 },
        speedFraction: 0.5,
        markers: [{ at: { t: 0.5 }, token: "cmd1" }],
        endCondition: { token: "cond1" },
      },
      { id: "s2", kind: "command", token: "cmd2", estimateS: 1.5, stationary: true, movesRobot: false },
      { id: "s3", kind: "wait", until: { token: "cond2" } },
      {
        id: "s4",
        kind: "parallel",
        mode: "deadline",
        deadline: "s5",
        steps: [
          { id: "s5", kind: "wait", seconds: 1 },
          { id: "s6", kind: "command", token: "cmd3", estimateS: null, stationary: false, movesRobot: true },
        ],
      },
      {
        id: "s7",
        kind: "branch",
        condition: { token: "cond3" },
        then: [{ id: "s8", kind: "sequence", steps: [{ id: "s9", kind: "wait", seconds: 0.5 }] }],
        else: [],
      },
    ],
  },
});

const issuesOf = (json: unknown): string[] => {
  const result = validateKind("projection", json);
  return result.ok ? [] : result.issues;
};

describe("projection schema", () => {
  it("is a new kind at formatVersion 1 under the v1 schema root", () => {
    expect(FORMAT_VERSIONS.projection).toBe(1);
    expect(SCHEMA_ID.projection).toBe("https://libraries.horizon36596.org/zenith/schema/v1/projection.json");
    expect(detectKind(viewProjection())).toBe("projection");
    // A projection carries `season`, which alone would read as a field file.
    const { $schema: _dropped, ...withoutId } = viewProjection();
    expect(detectKind(withoutId)).toBe("projection");
    // Projections are newer than the old host, so they have no legacy alias to accept.
    expect(issuesOf({ ...viewProjection(), $schema: "https://zenith.horizon36596.org/schema/v1/projection.json" })).not.toEqual([]);
  });

  it("accepts a view projection and a propose projection", () => {
    expect(issuesOf(viewProjection())).toEqual([]);
    expect(issuesOf(proposeProjection())).toEqual([]);
    const parsed = parseProjection(proposeProjection());
    expect(parsed.structure?.steps).toHaveLength(5);
    expect(parsed.trajectory.poses[1]).toEqual([-40, -62.5, 1.5708]);
  });

  it("requires the projection $schema id and no other", () => {
    expect(issuesOf({ ...viewProjection(), $schema: SCHEMA_ID.auto }).join("\n")).toMatch(/\$schema/);
    const { $schema: _dropped, ...withoutId } = viewProjection();
    expect(issuesOf(withoutId).join("\n")).toMatch(/\$schema/);
  });

  it("refuses a future formatVersion by number", () => {
    expect(() => migrate({ ...viewProjection(), formatVersion: 2 })).toThrow(/formatVersion 2/);
  });

  it("rejects an unknown key at the root and at every depth", () => {
    expect(issuesOf({ ...viewProjection(), notes: "leaked" }).join("\n")).toMatch(/notes/);

    const deepPose = viewProjection();
    deepPose["startPose"] = { xIn: 0, yIn: 0, headingRad: 0, provenance: "MEASURED" };
    expect(issuesOf(deepPose).join("\n")).toMatch(/provenance/);

    const deepPhase = viewProjection();
    deepPhase["phases"] = [{ startS: 0, endS: 1, label: "drive", command: "shootAll" }];
    expect(issuesOf(deepPhase).join("\n")).toMatch(/command/);

    const deepStep = proposeProjection();
    const structure = deepStep["structure"] as { steps: Record<string, unknown>[] };
    structure.steps[1] = { ...structure.steps[1], name: "shootAll" };
    expect(issuesOf(deepStep).join("\n")).toMatch(/name/);

    const deepMarker = proposeProjection();
    const path = (deepMarker["structure"] as { steps: Record<string, unknown>[] }).steps[0] as Record<string, unknown>;
    path["markers"] = [{ at: { t: 0.5 }, token: "cmd1", command: { name: "intakeOn" } }];
    expect(issuesOf(deepMarker).join("\n")).toMatch(/command/);
  });

  it("refuses an author's step id where an opaque one belongs", () => {
    const named = proposeProjection();
    const steps = (named["structure"] as { steps: Record<string, unknown>[] }).steps;
    steps[0] = { ...steps[0], id: "driveToShootPose" };
    expect(issuesOf(named).join("\n")).toMatch(/id/);
    const deadline = proposeProjection();
    const group = (deadline["structure"] as { steps: Record<string, unknown>[] }).steps[3] as Record<string, unknown>;
    group["deadline"] = "sweepPollenLine";
    expect(issuesOf(deadline).join("\n")).toMatch(/deadline/);
  });

  it("refuses a command name where a token belongs", () => {
    const named = proposeProjection();
    const steps = (named["structure"] as { steps: Record<string, unknown>[] }).steps;
    steps[1] = { ...steps[1], token: "shootAll" };
    expect(issuesOf(named)).not.toEqual([]);
    const condition = proposeProjection();
    const branch = (condition["structure"] as { steps: Record<string, unknown>[] }).steps[4] as Record<string, unknown>;
    branch["condition"] = { token: "hopperFull" };
    expect(issuesOf(condition)).not.toEqual([]);
  });

  it("caps every array it carries", () => {
    const row = [0, 0, 0];
    const poses = viewProjection();
    (poses["trajectory"] as Record<string, unknown>)["poses"] = Array.from({ length: MAX_PROJECTION_POSES + 1 }, () => row);
    expect(issuesOf(poses).join("\n")).toMatch(/trajectory\.poses/);
    const atCap = viewProjection();
    (atCap["trajectory"] as Record<string, unknown>)["poses"] = Array.from({ length: MAX_PROJECTION_POSES }, () => row);
    expect(issuesOf(atCap)).toEqual([]);

    const phase = { startS: 0, endS: 1, label: "wait" };
    const phases = { ...viewProjection(), phases: Array.from({ length: MAX_PROJECTION_PHASES + 1 }, () => phase) };
    expect(issuesOf(phases).join("\n")).toMatch(/phases/);

    const claim = { elementId: "flower0", action: "take", atS: 1 };
    const claims = { ...viewProjection(), claims: Array.from({ length: MAX_PROJECTION_CLAIMS + 1 }, () => claim) };
    expect(issuesOf(claims).join("\n")).toMatch(/claims/);

    const envelope = (viewProjection()["envelopes"] as unknown[])[0];
    const envelopes = {
      ...viewProjection(),
      envelopes: Array.from({ length: MAX_PROJECTION_ENVELOPES + 1 }, () => envelope),
    };
    expect(issuesOf(envelopes).join("\n")).toMatch(/envelopes/);
  });

  it("caps every string it carries", () => {
    const long = "x".repeat(MAX_PROJECTION_STRING_LENGTH + 1);
    expect(issuesOf({ ...viewProjection(), title: long }).join("\n")).toMatch(/title/);
    expect(issuesOf({ ...viewProjection(), season: long }).join("\n")).toMatch(/season/);
    const claim = { ...viewProjection(), claims: [{ elementId: long, action: "score", atS: 0 }] };
    expect(issuesOf(claim).join("\n")).toMatch(/elementId/);
    expect(issuesOf({ ...viewProjection(), title: "x".repeat(MAX_PROJECTION_STRING_LENGTH) })).toEqual([]);
  });

  it("holds a pose row to exactly three finite numbers", () => {
    const short = viewProjection();
    (short["trajectory"] as Record<string, unknown>)["poses"] = [[0, 0]];
    expect(issuesOf(short)).not.toEqual([]);
    const long = viewProjection();
    (long["trajectory"] as Record<string, unknown>)["poses"] = [[0, 0, 0, 0]];
    expect(issuesOf(long)).not.toEqual([]);
  });

  it("refuses a time span that ends before it starts, and a label off the fixed list", () => {
    expect(issuesOf({ ...viewProjection(), phases: [{ startS: 2, endS: 1, label: "drive" }] })).not.toEqual([]);
    expect(issuesOf({ ...viewProjection(), phases: [{ startS: 0, endS: 1, label: "shootAll" }] })).not.toEqual([]);
    expect(issuesOf({ ...viewProjection(), trajectory: { ...(viewProjection()["trajectory"] as object), rateHz: 4 } })).not.toEqual(
      [],
    );
  });
});

describe("projection schema: the named commands (Include command names)", () => {
  const named = (): Record<string, unknown>[] => [
    { token: "cmd1", kind: "marker", name: "intakeOn", startS: 0, endS: 0.1 },
    { token: "cmd2", kind: "command", name: "score", args: { count: 4, fast: true, side: "left" }, startS: 0.1, endS: 0.1 },
    { token: "cmd3", kind: "command", name: "spinUp" },
  ];
  const withNames = (commands: unknown, base = viewProjection()): Record<string, unknown> => ({ ...base, commands });

  it("is optional, so a projection made before it existed, or with it off, stays valid", () => {
    expect("commands" in viewProjection()).toBe(false);
    expect(issuesOf(viewProjection())).toEqual([]);
  });

  it("accepts names and arguments at both levels", () => {
    expect(issuesOf(withNames(named()))).toEqual([]);
    expect(issuesOf(withNames(named(), proposeProjection()))).toEqual([]);
    expect(issuesOf(withNames([]))).toEqual([]);
    expect(parseProjection(withNames(named())).commands?.[1]?.args).toEqual({ count: 4, fast: true, side: "left" });
  });

  it("carries nothing but a token, a kind, a name, arguments and a span", () => {
    for (const extra of [{ summary: "Runs the intake." }, { params: {} }, { condition: "hopperFull" }, { code: "new Intake()" }]) {
      const entries = named();
      entries[0] = { ...entries[0], ...extra };
      expect(issuesOf(withNames(entries)).join("\n")).toMatch(new RegExp(Object.keys(extra)[0] ?? ""));
    }
  });

  it("names a command token and nothing else, and refuses a kind off its list", () => {
    expect(issuesOf(withNames([{ token: "cond1", kind: "command", name: "hopperFull" }]))).not.toEqual([]);
    expect(issuesOf(withNames([{ token: "intakeOn", kind: "command", name: "intakeOn" }]))).not.toEqual([]);
    expect(issuesOf(withNames([{ token: "cmd1", kind: "condition", name: "hopperFull" }]))).not.toEqual([]);
    expect(issuesOf(withNames([{ token: "cmd1", kind: "command", name: "" }]))).not.toEqual([]);
  });

  it("holds arguments to strings, finite numbers and flags, never an object", () => {
    expect(issuesOf(withNames([{ token: "cmd1", kind: "command", name: "score", args: { count: { value: 4 } } }]))).not.toEqual([]);
    expect(issuesOf(withNames([{ token: "cmd1", kind: "command", name: "score", args: { count: [4] } }]))).not.toEqual([]);
    expect(issuesOf(withNames([{ token: "cmd1", kind: "command", name: "score", args: { count: null } }]))).not.toEqual([]);
  });

  it("caps the list, the names, the arguments and their strings", () => {
    const long = "x".repeat(MAX_PROJECTION_STRING_LENGTH + 1);
    const entry = { token: "cmd1", kind: "command", name: "spinUp" };
    expect(issuesOf(withNames(Array.from({ length: MAX_PROJECTION_COMMANDS + 1 }, () => entry))).join("\n")).toMatch(/commands/);
    expect(issuesOf(withNames(Array.from({ length: MAX_PROJECTION_COMMANDS }, () => entry)))).toEqual([]);
    expect(issuesOf(withNames([{ ...entry, name: long }]))).not.toEqual([]);
    expect(issuesOf(withNames([{ ...entry, args: { [long]: 1 } }]))).not.toEqual([]);
    expect(issuesOf(withNames([{ ...entry, args: { side: long } }]))).not.toEqual([]);
    const many = Object.fromEntries(Array.from({ length: MAX_PROJECTION_LIST_LENGTH + 1 }, (_, index) => [`a${String(index)}`, index]));
    expect(issuesOf(withNames([{ ...entry, args: many }]))).not.toEqual([]);
  });

  it("takes a span whole or not at all, and never one that ends before it starts", () => {
    expect(issuesOf(withNames([{ token: "cmd1", kind: "command", name: "spinUp", startS: 1 }]))).not.toEqual([]);
    expect(issuesOf(withNames([{ token: "cmd1", kind: "command", name: "spinUp", endS: 1 }]))).not.toEqual([]);
    expect(issuesOf(withNames([{ token: "cmd1", kind: "command", name: "spinUp", startS: 2, endS: 1 }]))).not.toEqual([]);
  });
});

describe("projection step depth (issue #377)", () => {
  /** A propose-level projection whose one step sits inside `groups` nested sequences. */
  const nested = (groups: number): Record<string, unknown> => {
    let steps: unknown[] = [{ id: "s1", kind: "wait", seconds: 1 }];
    for (let group = 0; group < groups; group += 1) {
      steps = [{ id: `s${String(group + 2)}`, kind: "sequence", steps }];
    }
    return { ...proposeProjection(), structure: { steps } };
  };

  it("refuses a structure nested thousands deep with a schema issue, not a stack overflow", () => {
    const deep = nested(10_000);
    expect(issuesOf(deep)).toEqual([
      `structure.steps: steps nest deeper than ${String(MAX_PROJECTION_STEP_DEPTH)} levels`,
    ]);
    expect(() => parseProjection(deep)).toThrow(SchemaError);
  });

  it("reads a structure at the cap and refuses one a level past it", () => {
    expect(issuesOf(nested(MAX_PROJECTION_STEP_DEPTH - 1))).toEqual([]);
    expect(issuesOf(nested(MAX_PROJECTION_STEP_DEPTH))).not.toEqual([]);
  });
});
