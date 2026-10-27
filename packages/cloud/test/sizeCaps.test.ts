/**
 * The size caps in the rules (spec 13 section 13) hold every projection and proposal a real auto
 * produces. The client caps a share's projection and a proposal's diff at 1,000,000 bytes of UTF-8
 * before sealing, and the rules cap the ciphertext at the same number, the largest round number that
 * keeps a document under Firestore's 1 MiB with its keys (spec 14); cloud/firestore.rules says how
 * it was chosen.
 *
 * The schema cannot give an exact maximum, because a structure nests groups with no depth limit and
 * the named commands may carry up to 1,000 calls of 200 arguments. So this builds an upper bound
 * instead, with every flat list at the schema's own cap and the nested parts far beyond any real
 * auto, writes it in canonical form (what the share dialog and the proposal send store), and checks
 * that it fits. Measured on the example autos, real projections are about 3 KB (view) and 13 KB
 * (propose).
 */
import { canonicalize } from "@horizon36596/zenith-core";
import {
  ENVELOPE_MAX_POINTS,
  MAX_BEZIER_CONTROL_POINTS,
  MAX_PROJECTION_CLAIMS,
  MAX_PROJECTION_ENVELOPES,
  MAX_PROJECTION_LIST_LENGTH,
  MAX_PROJECTION_PHASES,
  MAX_PROJECTION_POSES,
  MAX_PROJECTION_STRING_LENGTH,
  MAX_PROPOSAL_CHANGES,
  MAX_PROPOSAL_COMMENT_LENGTH,
  parseProjection,
  parseProposal,
  SCHEMA_ID,
} from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { encodeShareManifestBody, MAX_MANIFEST_TEAMS, MAX_SHARE_EXPIRY_MS, MAX_SHARE_MANIFEST_BYTES, MAX_TERMS_DEVICES } from "../src/crypto/manifest.js";
import { encodeRoster, MAX_ROSTER_ENTRIES, MAX_ROSTER_LINKS, MAX_ROSTER_SHARES, paddedRosterLength, type Roster } from "../src/keys/roster.js";
import { MAX_OWNER_CHOICE_BYTES, MAX_PRIVATE_KEY_BYTES, MAX_PROPOSAL_DIFF_BYTES, MAX_ROSTER_BYTES, MAX_SHARE_PROJECTION_BYTES } from "../src/types.js";

/** Firestore's own limit on one document, in bytes. */
const FIRESTORE_DOCUMENT_BYTES = 1_048_576;

const bytes = (text: string): number => new TextEncoder().encode(text).length;
const letters = (n: number): string => "x".repeat(n);

/** A heading one whole degree from the last, written at full precision as the projection keeps it. */
const heading = (i: number): number => (((i % 360) - 180) * Math.PI) / 180;

/** The widest segment a projection or a proposal may hold: a Bezier with every control point. */
function widestSegment(): unknown {
  return {
    kind: "bezier",
    from: { xIn: -71.5, yIn: -71.5, headingRad: -3.1416 },
    control: Array.from({ length: MAX_BEZIER_CONTROL_POINTS }, () => ({ xIn: -70.125, yIn: 70.125 })),
    to: { xIn: 71.5, yIn: 71.5, headingRad: 3.1416 },
  };
}

/**
 * The upper bound for a projection: 3,000 trajectory rows (300 s at 10 Hz, ten times an FTC
 * autonomous period), 200 phases, 200 claims, 50 envelopes of 32 corners (the most an auto's
 * envelope has, which is where a projection's come from), a 200-character title, 200 named
 * commands with three arguments each, and at the propose level 200 path steps of three full Bezier
 * segments with a marker each. A large real auto has about 30 steps.
 */
function upperBoundProjection(level: "view" | "propose"): unknown {
  const poses = Array.from({ length: MAX_PROJECTION_POSES }, (_, i) => [-71.5 + (i % 280) * 0.5, 71.5 - (i % 280) * 0.5, heading(i)]);
  const structure = {
    steps: Array.from({ length: MAX_PROJECTION_LIST_LENGTH }, (_, i) => ({
      id: `s${String(i + 1)}`,
      kind: "path",
      timeoutS: 4.25,
      segments: Array.from({ length: 3 }, widestSegment),
      heading: { mode: "linear", fromRad: -3.1416, toRad: 3.1416 },
      speedFraction: 0.85,
      markers: [{ at: { t: 0.5 }, token: `cmd${String(i + 1)}` }],
    })),
  };
  return {
    $schema: SCHEMA_ID.projection,
    formatVersion: 1,
    kind: "projection",
    level,
    season: "biobuzz",
    alliance: "BLUE",
    title: letters(MAX_PROJECTION_STRING_LENGTH),
    startPose: { xIn: -71.5, yIn: -71.5, headingRad: -3.1416 },
    boundingBox: { lengthIn: 18, widthIn: 18, centreOffsetIn: { xIn: 0, yIn: 0 } },
    trajectory: { rateHz: 10, positionQuantumIn: 0.5, headingQuantumRad: Math.PI / 180, poses },
    phases: Array.from({ length: MAX_PROJECTION_PHASES }, (_, i) => ({ startS: i * 1.5, endS: i * 1.5 + 1.5, label: "collect" })),
    claims: Array.from({ length: MAX_PROJECTION_CLAIMS }, (_, i) => ({ elementId: letters(40), action: "score", atS: i * 1.5 })),
    envelopes: Array.from({ length: MAX_PROJECTION_ENVELOPES }, (_, i) => ({
      startS: i,
      endS: i + 3,
      polygon: Array.from({ length: ENVELOPE_MAX_POINTS }, (_, j) => ({ xIn: -70.125 + j, yIn: 70.125 - j })),
    })),
    totalS: 299.9,
    ...(level === "propose" ? { structure } : {}),
    commands: Array.from({ length: MAX_PROJECTION_LIST_LENGTH }, (_, i) => ({
      token: `cmd${String(i + 1)}`,
      kind: "marker",
      name: letters(40),
      args: { power: 0.75, side: letters(20), reversed: false },
      startS: i,
      endS: i + 1,
    })),
  };
}

/**
 * The upper bound for a proposal: 200 changes (the schema's cap), each the largest kind a real
 * proposal sends, a new path of three full Bezier segments with a marker, a timeout, a speed and a
 * 200-character comment.
 */
function upperBoundProposal(): unknown {
  return {
    $schema: SCHEMA_ID.proposal,
    formatVersion: 1,
    kind: "proposal",
    shareRef: { shareId: letters(22), revision: 12 },
    baseStructureHash: `sha256:${"a".repeat(64)}`,
    changes: Array.from({ length: MAX_PROPOSAL_CHANGES }, (_, i) => ({
      op: "addPath",
      afterStepId: `s${String(i + 1)}`,
      timeoutS: 4.25,
      segments: Array.from({ length: 3 }, widestSegment),
      heading: { mode: "linear", fromRad: -3.1416, toRad: 3.1416 },
      speedFraction: 0.85,
      markers: [{ at: { t: 0.5 }, token: `cmd${String(i + 1)}` }],
      comment: letters(MAX_PROPOSAL_COMMENT_LENGTH),
    })),
  };
}

/**
 * A document's stored size by Firestore's published rules: a string is its UTF-8 bytes plus 1, bytes
 * their length, a number or time 8, a boolean or null 1, a map the sum of its keys (as strings) and
 * values, an array the sum of its values; plus the document name and 32 bytes.
 */
function storedSize(value: unknown): number {
  if (value === null || typeof value === "boolean") return 1;
  if (typeof value === "number" || value instanceof Date) return 8;
  if (typeof value === "string") return bytes(value) + 1;
  if (value instanceof Uint8Array) return value.byteLength;
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + storedSize(item), 0);
  return Object.entries(value as Record<string, unknown>).reduce((sum, [key, item]) => sum + bytes(key) + 1 + storedSize(item), 0);
}

const envelope = (ct: number) => ({ v: 1, alg: "A256GCM", kv: 2_147_483_647, iv: new Uint8Array(12), ct: new Uint8Array(ct) });
const shareWrap = () => ({ v: 1, epk: new Uint8Array(65), iv: new Uint8Array(12), ct: new Uint8Array(48), ekv: 2_147_483_647 });
const longId = letters(64);

describe("the rules' size caps (spec 13 section 13)", () => {
  it("leave room under Firestore's 1 MiB for every other field of a document, keys included", () => {
    // A share to 8 teams with the longest ids, a wrap for each, the owner's wrap, 100 older keys and
    // the largest manifest: everything but the projection's ciphertext, which is capped on its own.
    const teamIds = Array.from({ length: 8 }, (_, i) => `${longId.slice(0, 63)}${String(i)}`);
    const share = {
      ownerTeamId: longId, autoId: longId, audience: "teams", teamIds, level: "propose", mode: "follow",
      revision: `000001-${letters(64)}`, expiresAt: new Date(0), revokedAt: new Date(0), createdBy: letters(128),
      createdAt: new Date(0), updatedAt: new Date(0),
      projection: envelope(0),
      keyWraps: Object.fromEntries(teamIds.map((id) => [id, shareWrap()])),
      ownerWrap: envelope(48),
      prevKeys: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(2_147_483_547 + i), envelope(48)])),
      manifest: {
        v: 5, body: new Uint8Array(MAX_SHARE_MANIFEST_BYTES), sig: new Uint8Array(64), dsig: new Uint8Array(64), dkeys: new Uint8Array(182),
        tsig: new Uint8Array(64), tkeys: new Uint8Array(182),
      },
      ownerChoice: envelope(MAX_OWNER_CHOICE_BYTES),
    };
    const shareOthers = storedSize(share) + bytes(`projects/p/databases/(default)/documents/shares/${letters(22)}`) + 32;
    expect(shareOthers).toBeLessThan(19_000);
    expect(MAX_SHARE_PROJECTION_BYTES + shareOthers).toBeLessThan(FIRESTORE_DOCUMENT_BYTES);

    const proposal = {
      shareId: letters(22), ownerTeamId: longId, autoId: longId, fromTeamId: longId, baseRevision: `000001-${letters(64)}`,
      diff: envelope(0), ownerWrap: shareWrap(), fromWrap: envelope(48), sig: new Uint8Array(64), status: "withdrawn", createdBy: letters(128), createdAt: new Date(0),
      decidedBy: letters(128), decidedAt: new Date(0),
    };
    const proposalOthers = storedSize(proposal) + bytes(`projects/p/databases/(default)/documents/proposals/${letters(22)}`) + 32;
    expect(proposalOthers).toBeLessThan(10_000);
    expect(MAX_PROPOSAL_DIFF_BYTES + proposalOthers).toBeLessThan(FIRESTORE_DOCUMENT_BYTES);
  });

  it("hold the largest share manifest body, with the longest ids, versions, key digests, end, counts and terms signers", () => {
    const id = (n: number) => `${String(n)}${letters(127)}`;
    const body = encodeShareManifestBody({
      shareId: letters(128),
      ownerTeamId: letters(128),
      autoId: letters(128),
      revisionId: letters(128),
      audience: "teams",
      mode: "pinned",
      level: "propose",
      revoked: true,
      expiresAtMs: MAX_SHARE_EXPIRY_MS,
      seq: 2_147_483_647,
      skv: 2_147_483_647,
      wkv: 2_147_483_647,
      okv: 2_147_483_647,
      device: letters(22),
      termsSeq: 2_147_483_647,
      termsDevices: Array.from({ length: MAX_TERMS_DEVICES }, (_, i) => `${String(i)}${letters(21)}`),
      choice: new Uint8Array(32),
      teams: Array.from({ length: MAX_MANIFEST_TEAMS }, (_, i) => [id(i), 2_147_483_647, new Uint8Array(32)] as const),
      commit: new Uint8Array(32),
    });
    expect(body.byteLength).toBe(2_472);
    expect(body.byteLength).toBeLessThanOrEqual(MAX_SHARE_MANIFEST_BYTES);
  });

  it("hold the upper-bound projection at both levels, in canonical form", () => {
    for (const level of ["view", "propose"] as const) {
      const text = canonicalize("projection", parseProjection(upperBoundProjection(level)));
      // The bound is far larger than a real projection, so it is a real test of the cap: a view
      // one is over 400 KB and a propose one over 850 KB.
      expect(bytes(text), level).toBeGreaterThan(level === "view" ? 400_000 : 850_000);
      expect(bytes(text), level).toBeLessThanOrEqual(MAX_SHARE_PROJECTION_BYTES);
    }
  });

  it("hold the upper-bound proposal, in canonical form", () => {
    const text = canonicalize("proposal", parseProposal(upperBoundProposal()));
    expect(bytes(text)).toBeGreaterThan(400_000);
    expect(bytes(text)).toBeLessThanOrEqual(MAX_PROPOSAL_DIFF_BYTES);
  });
});

describe("the device roster's size cap", () => {
  it("holds the largest roster, with the longest uids, and leaves the rest of a team key record room in 1 MiB", () => {
    const key = (n: number) => new Uint8Array(91).fill(n % 256);
    const uid = (n: number) => `${String(n).padStart(4, "0")}${letters(124)}`;
    const deviceId = (n: number) => `${String(n).padStart(4, "0")}${letters(18)}`;
    const keys = (n: number) => ({ deviceId: deviceId(n), uid: uid(n), encSpki: key(n), signSpki: key(n + 1), fingerprint: new Uint8Array(32) });
    const roster: Roster = {
      v: 1,
      teamId: longId,
      kv: 2_147_483_647,
      rotator: deviceId(0),
      nonce: new Uint8Array(16),
      members: Array.from({ length: MAX_ROSTER_ENTRIES }, (_, n) => ({ uid: uid(n), role: "editor" as const })),
      devices: Array.from({ length: MAX_ROSTER_ENTRIES }, (_, n) => keys(n)),
      recovery: new Uint8Array(32),
      via: Array.from({ length: MAX_ROSTER_LINKS }, (_, n) => ({
        kind: "grant" as const,
        ...keys(n),
        kv: 2_147_483_646,
        approverDeviceId: deviceId(n + 1),
        wrap: { v: 1 as const, epk: new Uint8Array(65), iv: new Uint8Array(12), ct: new Uint8Array(48) },
        signature: new Uint8Array(64),
      })),
      membersMayApprove: true,
      recoveryAnchor: new Uint8Array(64),
      // The most shares a roster lists, with the longest ids the rules allow.
      shares: Array.from({ length: MAX_ROSTER_SHARES }, (_, n) => ({ shareId: `${String(n).padStart(4, "0")}${letters(60)}`, digest: new Uint8Array(32) })),
    };
    // The sealed roster is the JSON and a 16-byte tag, padded to a size bucket.
    const plain = encodeRoster(roster).length;
    const sealed = plain + 16;
    expect(sealed).toBeGreaterThan(500_000);
    expect(sealed).toBeLessThanOrEqual(MAX_ROSTER_BYTES);
    expect(paddedRosterLength(plain)).toBe(MAX_ROSTER_BYTES - 16);
    const record = {
      v: 1, kv: 2_147_483_647, prev: envelope(48), pairSpki: key(1), pairPrivate: envelope(MAX_PRIVATE_KEY_BYTES), signSpki: key(2),
      signPrivate: envelope(MAX_PRIVATE_KEY_BYTES), sig: new Uint8Array(64), roster: envelope(0), rosterSig: new Uint8Array(64),
    };
    const others = storedSize(record) + bytes(`projects/p/databases/(default)/documents/teams/${longId}/teamKeys/2147483647`) + 32;
    expect(MAX_ROSTER_BYTES + others).toBeLessThan(FIRESTORE_DOCUMENT_BYTES);
  });
});
