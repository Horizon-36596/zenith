import { describe, expect, it } from "vitest";
import { FORMAT_VERSIONS, SCHEMA_ID } from "./ids.js";
import { detectKind, migrate } from "./migrate.js";
import { parseProposal, validateKind } from "./parse.js";
import {
  MAX_PROPOSAL_CHANGES,
  MAX_PROPOSAL_COMMENT_LENGTH,
  PROPOSAL_CHANGE_OPS,
  STRUCTURE_HASH_PATTERN,
} from "./proposal.js";

/**
 * The proposal file (spec 13 section 14) is written by another team and
 * read by the team that owns the auto, so, like the projection it is made against, it is strict:
 * an unknown key anywhere is refused rather than dropped, every array and string has a cap, and
 * the changes are a closed set. Nothing in it can name a command, an argument or a condition.
 */

const HASH = `sha256:${"0".repeat(64)}`;

const pose = { xIn: 12, yIn: -24, headingRad: 1.5708 };

/** One change of every kind, in the order `PROPOSAL_CHANGE_OPS` lists them. */
const everyChange = (): Record<string, unknown>[] => [
  { op: "movePose", stepId: "s1", segmentIndex: 0, point: "to", pose, comment: "Stop short of the wall." },
  { op: "movePose", stepId: "s1", segmentIndex: 0, point: { controlIndex: 0 }, pose: { xIn: 1, yIn: 2 } },
  { op: "setHeading", stepId: "s1", heading: { mode: "constant", headingRad: 0 } },
  { op: "setSpeedFraction", stepId: "s1", speedFraction: 0.5 },
  { op: "setTimeout", stepId: "s2", timeoutS: 2 },
  { op: "setTimeout", stepId: "s2", timeoutS: null },
  { op: "insertWait", afterStepId: "s2", seconds: 0.5 },
  { op: "insertWait", atStart: true, until: { token: "cond1" } },
  { op: "setWait", stepId: "s3", seconds: 1 },
  { op: "removeStep", stepId: "s3" },
  {
    op: "addPath",
    afterStepId: "s1",
    segments: [{ kind: "line", from: pose, to: { xIn: 0, yIn: 0, headingRad: 0 } }],
    heading: { mode: "tangent" },
    speedFraction: 0.8,
    markers: [{ at: { t: 0.5 }, token: "cmd1" }],
  },
  { op: "reorder", stepId: "s2", newIndex: 0 },
  { op: "moveMarker", stepId: "s1", markerIndex: 0, at: { distanceIn: 6 } },
  {
    op: "setEnvelope",
    stepId: "s2",
    envelope: {
      polygon: [
        { xIn: 0, yIn: 0 },
        { xIn: 24, yIn: 0 },
        { xIn: 24, yIn: 24 },
      ],
      maxDurationS: 3,
      provenance: "SET FROM EDITOR",
    },
  },
  { op: "setEnvelope", stepId: "s2", envelope: null },
];

const proposal = (changes: Record<string, unknown>[] = everyChange()): Record<string, unknown> => ({
  $schema: SCHEMA_ID.proposal,
  formatVersion: 1,
  kind: "proposal",
  shareRef: { shareId: "abc123", revision: 4 },
  baseStructureHash: HASH,
  changes,
});

const refuses = (json: unknown): boolean => !validateKind("proposal", json).ok;

describe("proposal schema", () => {
  it("is a new kind at formatVersion 1 under the same schema root as the projection", () => {
    expect(FORMAT_VERSIONS.proposal).toBe(1);
    expect(SCHEMA_ID.proposal).toBe(SCHEMA_ID.projection.replace("projection.json", "proposal.json"));
    expect(detectKind(proposal())).toBe("proposal");
    expect(detectKind({ kind: "proposal", changes: [] })).toBe("proposal");
    expect(migrate(proposal()).kind).toBe("proposal");
  });

  it("reads one change of every kind in the closed set", () => {
    const parsed = parseProposal(proposal());
    expect(parsed.changes.map((change) => change.op)).toEqual(everyChange().map((change) => change["op"]));
    expect(new Set(parsed.changes.map((change) => change.op))).toEqual(new Set(PROPOSAL_CHANGE_OPS));
  });

  it("requires $schema, the kind and a structure hash of the right form", () => {
    const { $schema: _omit, ...withoutSchema } = proposal();
    expect(refuses(withoutSchema)).toBe(true);
    expect(refuses({ ...proposal(), kind: "projection" })).toBe(true);
    expect(refuses({ ...proposal(), baseStructureHash: "abc" })).toBe(true);
    expect(STRUCTURE_HASH_PATTERN.test(HASH)).toBe(true);
  });

  it("refuses a change outside the closed set, such as one that names or edits a command", () => {
    expect(refuses(proposal([{ op: "setCommandArgs", stepId: "s2", args: { count: 9 } }]))).toBe(true);
    expect(refuses(proposal([{ op: "renameStep", stepId: "s2", newId: "shoot" }]))).toBe(true);
    expect(refuses(proposal([{ op: "addCommand", afterStepId: "s2", name: "score" }]))).toBe(true);
  });

  it("refuses an unknown key at any depth, which is how a command name would try to ride along", () => {
    expect(refuses({ ...proposal(), note: "hello" })).toBe(true);
    expect(refuses(proposal([{ op: "removeStep", stepId: "s3", name: "score" }]))).toBe(true);
    expect(
      refuses(
        proposal([
          {
            op: "addPath",
            atStart: true,
            segments: [{ kind: "line", from: pose, to: pose }],
            heading: { mode: "tangent" },
            markers: [{ at: { t: 0.5 }, token: "cmd1", command: { name: "score" } }],
          },
        ]),
      ),
    ).toBe(true);
    expect(refuses(proposal([{ op: "movePose", stepId: "s1", segmentIndex: 0, point: "to", pose: { ...pose, ref: "start" } }]))).toBe(
      true,
    );
  });

  it("only takes opaque step ids and opaque tokens", () => {
    expect(refuses(proposal([{ op: "removeStep", stepId: "driveOut" }]))).toBe(true);
    expect(refuses(proposal([{ op: "insertWait", atStart: true, until: { token: "hopperFull" } }]))).toBe(true);
    expect(
      refuses(
        proposal([
          {
            op: "addPath",
            atStart: true,
            segments: [{ kind: "line", from: pose, to: pose }],
            heading: { mode: "tangent" },
            markers: [{ at: { t: 0.5 }, token: "score" }],
          },
        ]),
      ),
    ).toBe(true);
  });

  it("places an inserted step after one step or at the start, never both and never neither", () => {
    expect(refuses(proposal([{ op: "insertWait", seconds: 1 }]))).toBe(true);
    expect(refuses(proposal([{ op: "insertWait", afterStepId: "s1", atStart: true, seconds: 1 }]))).toBe(true);
    expect(
      refuses(proposal([{ op: "addPath", segments: [{ kind: "line", from: pose, to: pose }], heading: { mode: "tangent" } }])),
    ).toBe(true);
  });

  it("gives a wait seconds or a condition token, not both and not neither", () => {
    expect(refuses(proposal([{ op: "setWait", stepId: "s3" }]))).toBe(true);
    expect(refuses(proposal([{ op: "setWait", stepId: "s3", seconds: 1, until: { token: "cond1" } }]))).toBe(true);
    expect(refuses(proposal([{ op: "insertWait", atStart: true, seconds: 1, until: { token: "cond1" } }]))).toBe(true);
  });

  it("caps the changes, the comments and the lists inside them", () => {
    const many = Array.from({ length: MAX_PROPOSAL_CHANGES + 1 }, () => ({ op: "removeStep", stepId: "s3" }));
    expect(refuses(proposal(many))).toBe(true);
    const long = "x".repeat(MAX_PROPOSAL_COMMENT_LENGTH + 1);
    expect(refuses(proposal([{ op: "removeStep", stepId: "s3", comment: long }]))).toBe(true);
    expect(refuses(proposal([{ op: "removeStep", stepId: "s3", comment: "two\nlines" }]))).toBe(true);
    expect(refuses({ ...proposal(), shareRef: { shareId: "x".repeat(201), revision: 1 } })).toBe(true);
  });

  it("keeps numbers in range: indexes are whole and not negative, a speed fraction is at most 1", () => {
    expect(refuses(proposal([{ op: "reorder", stepId: "s2", newIndex: -1 }]))).toBe(true);
    expect(refuses(proposal([{ op: "reorder", stepId: "s2", newIndex: 0.5 }]))).toBe(true);
    expect(refuses(proposal([{ op: "setSpeedFraction", stepId: "s1", speedFraction: 1.5 }]))).toBe(true);
    expect(refuses(proposal([{ op: "setTimeout", stepId: "s2", timeoutS: 0 }]))).toBe(true);
    expect(refuses(proposal([{ op: "movePose", stepId: "s1", segmentIndex: 0, point: "to", pose: { xIn: Number.NaN, yIn: 0 } }]))).toBe(
      true,
    );
  });
});
