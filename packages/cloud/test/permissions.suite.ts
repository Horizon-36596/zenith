/**
 * The M-C1 permission Contract (spec 13 section 16), written once against `DocStore` and run twice:
 * against the in-memory copy of the rules (memory.permissions.test.ts) and against the real rules in
 * the Firestore emulator (emulator.permissions.test.ts). A case that passes one and fails the other
 * means the two copies of the rules disagree.
 *
 * For every collection, an outsider (a member of another team), a pending member, a viewer and a
 * removed member each get exactly what spec 13 section 4.3 gives them; expired, revoked and used-up
 * invites never add anyone; an unauthenticated caller can get a link share and cannot list shares.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { isCloudError } from "../src/errors.js";
import { sha256Sync } from "../src/memory/sha256.js";
import { DELETE_FIELD, SERVER_TIME, type DocData, type DocStore, type Query, type Write } from "../src/store.js";
import { MAX_PRIVATE_KEY_BYTES, MAX_ROSTER_BYTES } from "../src/types.js";

export interface PermissionHarness {
  /** Replaces the whole database with these documents, without the rules. */
  reset(docs: Record<string, DocData>): Promise<void>;
  /** A connection acting as `uid`, or as an unauthenticated caller for null. */
  as(uid: string | null): DocStore;
  /** Reads a document without the rules. */
  peek(path: string): Promise<DocData | null>;
}

// ------------------------------------------------------------------------ the world

/** 22-character ids, the shape the rules require of client-made ids. */
const A = "teamAlphaAAAAAAAAAAAAA";
const B = "teamBravoBBBBBBBBBBBBB";
const C = "teamCharlieCCCCCCCCCCC";
const AUTO = "autoOneXXXXXXXXXXXXXXX";
const R1 = "000001-rev1aaaa";
const R2 = "000002-rev2bbbb";

/** The seeds of the world's team public keys. */
const SEED = { A: 0x10, B: 0x20, C: 0x30 } as const;

const U = {
  owner: "alice",
  admin: "adam",
  editor: "eve",
  viewer: "vic",
  pending: "pat",
  removed: "rex",
  outsider: "olga", // owner of team B
  outsiderEditor: "bea", // editor of team B
  outsiderViewer: "bob", // viewer of team B
  outsiderPending: "bill", // pending in team B
  third: "cody", // viewer of team C
  horizon: "hana", // a Horizon admin, in no team
  newcomer: "nina", // signed in, profile saved, in no team
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------------ ciphertext of the right shape

// The rules check the shape of ciphertext, never its content (spec 14 section 4.10), so the world
// holds bytes of the right lengths, not real ciphertext. The client tests use real keys.

/** `n` bytes, all `fill`. */
function bytes(n: number, fill = 1): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

/** A sealed value under key version `kv` whose ciphertext is `ct` bytes. */
function env(kv: number, ct = 40): DocData {
  return { v: 1, alg: "A256GCM", kv, iv: bytes(12), ct: bytes(ct) };
}

/** A 256-bit key or SHA-256 sealed under `kv`: 48 bytes of ciphertext. */
function sealedKey(kv: number): DocData {
  return env(kv, 48);
}

/** A 256-bit key wrapped to a public key. */
function keyWrap(): DocData {
  return { v: 1, epk: bytes(65), iv: bytes(12), ct: bytes(48) };
}

/** A share key wrapped to a team's public key of version `ekv`. */
function shareWrap(ekv = 1): DocData {
  return { ...keyWrap(), ekv };
}

/**
 * A share manifest: a body of `body` bytes, all `fill`, two 64-byte signatures, the signing device's
 * 182 bytes of keys, and the 64-byte terms signature and 182 bytes of keys of the device that last
 * signed the terms.
 */
function manifest(fill = 1, body = 120): DocData {
  return { v: 5, body: bytes(body, fill), sig: bytes(64, fill), dsig: bytes(64, fill), dkeys: bytes(182, fill), tsig: bytes(64, fill), tkeys: bytes(182, fill) };
}

/**
 * A team's public keys of version `v`, from a seed byte: its ECDH key with its real SHA-256 as the
 * fingerprint, its ECDSA signing key, and version v-1's 64-byte signature (none at version 1).
 */
function encKey(seed: number, v = 1): DocData {
  const spki = bytes(91, (seed + v) % 256);
  return { v, spki, fingerprint: sha256Sync(spki), signSpki: bytes(91, (seed + v + 128) % 256), sig: v === 1 ? null : bytes(64, v) };
}

/** The fields of team key record `v` that repeat its `encKey`, its sealed signing key, and its sealed device roster and the roster's signature. */
function recordKeys(seed: number, v: number): DocData {
  const key = encKey(seed, v);
  return { pairSpki: key.spki, signSpki: key.signSpki, signPrivate: env(v, 154), sig: key.sig, roster: env(v, 400), rosterSig: bytes(64, 7) };
}

/** The recovery record's keys: its ECDH public half and sealed private half, and its signing pair. */
function recoveryKeys(): DocData {
  return { spki: bytes(91, 9), privateKey: env(1, 154), signSpki: bytes(91, 10), signPrivate: env(1, 154) };
}

/** A device id: 22 base64url characters. */
function deviceOf(uid: string, n = 1): string {
  return `${uid}${String(n)}`.padEnd(22, "D").slice(0, 22);
}

function deviceDoc(): DocData {
  return { v: 1, encSpki: bytes(91, 4), signSpki: bytes(91, 5), fingerprint: bytes(32, 6), createdAt: new Date(Date.now() - DAY_MS) };
}

/** A grant of team key `kv` to `uid`'s device, approved from `approver`'s device. */
function grantDoc(teamId: string, uid: string, deviceId: string, kv: number, approver: string, approverDeviceId: string, over: DocData = {}): DocData {
  const at = new Date(Date.now() - DAY_MS);
  return {
    v: 1, teamId, deviceId, uid, kv, wrap: keyWrap(), proof: sealedKey(kv), approverDeviceId, approverUid: approver,
    signature: bytes(64), createdAt: at, updatedAt: at, ...over,
  };
}

/** The key documents of a team whose key is version `kv`: its teamKeys records and its recovery record. */
function keyDocs(teamId: string, seed: number, kv: number, by: string): Record<string, DocData> {
  const at = new Date(Date.now() - DAY_MS);
  const docs: Record<string, DocData> = {};
  for (let n = 1; n <= kv; n++) {
    docs[`teams/${teamId}/teamKeys/${String(n)}`] = {
      v: 1, kv: n, prev: n === 1 ? null : sealedKey(n), pairPrivate: env(n, 154), ...recordKeys(seed, n),
    };
  }
  docs[`teams/${teamId}/recovery/current`] = {
    v: 1, kv, ...recoveryKeys(), teamKey: keyWrap(), check: sealedKey(kv), updatedBy: by, updatedAt: at,
  };
  return docs;
}

/** One fixed past instant, so a history written by a case matches the history the world holds. */
const PAST = new Date(Date.now() - DAY_MS);

const INVITE = {
  live: "inviteLiveXXXXXXXXXXXX",
  auto: "inviteAutoXXXXXXXXXXXX",
  expired: "inviteExpiredXXXXXXXXX",
  revoked: "inviteRevokedXXXXXXXXX",
  usedUp: "inviteUsedUpXXXXXXXXXX",
};

const SHARE = {
  link: "shareLinkLiveXXXXXXXXX",
  linkExpired: "shareLinkExpiredXXXXXX",
  linkRevoked: "shareLinkRevokedXXXXXX",
  view: "shareTeamsViewXXXXXXXX",
  propose: "shareTeamsProposeXXXXX",
  expired: "shareTeamsExpiredXXXXX",
  revoked: "shareTeamsRevokedXXXXX",
};

function member(teamId: string, uid: string, role: string, extra: DocData = {}): DocData {
  return { uid, teamId, role, displayName: uid, joinedAt: new Date(Date.now() - DAY_MS), ...extra };
}

/** One step of a claim's history as stored, at the fixed past instant. */
function claimEntry(kind: string, teamId: string, by: string, over: DocData = {}): DocData {
  return { kind, teamId, otherTeamId: null, by, at: PAST, ...over };
}

/** A claim as documents: the public claim, counting its steps, and one document per step. */
function claimDocs(teamNumber: number, claim: DocData, steps: DocData[]): Record<string, DocData> {
  const docs: Record<string, DocData> = { [`claims/${String(teamNumber)}`]: { ...claim, historyCount: steps.length } };
  steps.forEach((step, index) => {
    docs[`claims/${String(teamNumber)}/history/${String(index)}`] = step;
  });
  return docs;
}

/** The write that adds step `index` to a claim's history, stamped by the server. */
function stepWrite(teamNumber: number, index: number, step: DocData): Write {
  return { op: "set", path: `claims/${String(teamNumber)}/history/${String(index)}`, data: { ...step, at: SERVER_TIME } };
}

/**
 * The key fields of a share with this audience and these teams: a wrap for each team, the owner
 * wrap and the manifest, or for a link share the sealed secret.
 */
function shareKeys(over: DocData): DocData {
  if (over.audience === "link") return { linkWrap: env(1, 32), manifest: manifest() };
  const teamIds = (over.teamIds as string[] | undefined) ?? [B];
  return { keyWraps: Object.fromEntries(teamIds.map((teamId) => [teamId, shareWrap()])), ownerWrap: sealedKey(1), manifest: manifest() };
}

function share(id: keyof typeof SHARE, over: DocData): [string, DocData] {
  return [
    `shares/${SHARE[id]}`,
    {
      ownerTeamId: A,
      autoId: AUTO,
      audience: "teams",
      teamIds: [B],
      level: "view",
      mode: "pinned",
      revision: R2,
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      revokedAt: null,
      createdBy: U.owner,
      createdAt: new Date(Date.now() - DAY_MS),
      updatedAt: new Date(Date.now() - DAY_MS),
      projection: env(1),
      ...shareKeys(over),
      ...over,
    },
  ];
}

function invite(id: keyof typeof INVITE, over: DocData): [string, DocData] {
  return [
    `invites/${INVITE[id]}`,
    {
      teamId: A,
      role: "editor",
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      maxUses: 2,
      uses: 0,
      autoApprove: false,
      createdBy: U.owner,
      createdAt: new Date(Date.now() - DAY_MS),
      revoked: false,
      ...over,
    },
  ];
}

function world(): Record<string, DocData> {
  const past = PAST;
  const docs: Record<string, DocData> = {
    [`admins/${U.horizon}`]: { name: "Horizon reviewer" },
    [`teams/${A}`]: { number: 36596, name: "Horizon", status: "unverified", createdBy: U.owner, createdAt: past, encKey: encKey(SEED.A) },
    [`teams/${B}`]: { number: 12345, name: "Partner", status: "verified", createdBy: U.outsider, createdAt: past, encKey: encKey(SEED.B) },
    [`teams/${C}`]: { number: null, name: "Third", status: "unverified", createdBy: U.third, createdAt: past, encKey: encKey(SEED.C) },
    ...keyDocs(A, SEED.A, 1, U.owner),
    ...keyDocs(B, SEED.B, 1, U.outsider),
    ...keyDocs(C, SEED.C, 1, U.third),
    [`teams/${A}/members/${U.owner}`]: member(A, U.owner, "owner"),
    [`teams/${A}/members/${U.admin}`]: member(A, U.admin, "admin"),
    [`teams/${A}/members/${U.editor}`]: member(A, U.editor, "editor"),
    [`teams/${A}/members/${U.viewer}`]: member(A, U.viewer, "viewer"),
    [`teams/${A}/members/${U.pending}`]: member(A, U.pending, "pending", { invite: INVITE.live, requestedRole: "editor" }),
    [`teams/${B}/members/${U.outsider}`]: member(B, U.outsider, "owner"),
    [`teams/${B}/members/${U.outsiderEditor}`]: member(B, U.outsiderEditor, "editor"),
    [`teams/${B}/members/${U.outsiderViewer}`]: member(B, U.outsiderViewer, "viewer"),
    [`teams/${B}/members/${U.outsiderPending}`]: member(B, U.outsiderPending, "pending"),
    [`teams/${C}/members/${U.third}`]: member(C, U.third, "viewer"),
    [`teams/${A}/autos/${AUTO}`]: { title: env(1), titleGen: 1, createdBy: U.editor, createdAt: past, updatedAt: past },
    [`teams/${A}/autos/${AUTO}/revisions/${R1}`]: {
      n: 1, baseRevision: null, author: U.editor, createdAt: past, content: env(1), diverged: false,
    },
    [`teams/${A}/autos/${AUTO}/revisions/${R2}`]: {
      n: 2, baseRevision: R1, author: U.editor, createdAt: past, content: env(1, 41), robot: env(1), diverged: false,
    },
    [`teams/${A}/activity/entry1`]: { at: past, by: U.owner, kind: "invite.create", target: INVITE.live },
    [`teams/${B}/inbox/${SHARE.view}`]: { shareId: SHARE.view, ownerTeamId: A, createdBy: U.owner, createdAt: past },
    ...claimDocs(36596, { teamId: A, status: "unverified", claimedAt: past }, [claimEntry("claim", A, U.owner)]),
    ...claimDocs(12345, { teamId: B, status: "verified", claimedAt: past }, [claimEntry("claim", B, U.outsider)]),
    [`proposals/proposal1`]: {
      shareId: SHARE.propose, ownerTeamId: A, autoId: AUTO, fromTeamId: B, baseRevision: R2, diff: env(1),
      ownerWrap: shareWrap(), fromWrap: sealedKey(1), sig: bytes(64), status: "open", createdBy: U.outsiderEditor, createdAt: past,
    },
  };
  for (const uid of Object.values(U)) {
    docs[`users/${uid}`] = { displayName: uid, createdAt: past };
    docs[`users/${uid}/devices/${deviceOf(uid)}`] = deviceDoc();
  }
  // Every active member of A and B holds the team key on their device. The removed member's grant was
  // left behind, which the rules must still keep from them.
  for (const uid of [U.owner, U.admin, U.editor, U.viewer]) {
    docs[`teams/${A}/keyGrants/${deviceOf(uid)}`] = grantDoc(A, uid, deviceOf(uid), 1, U.owner, deviceOf(U.owner));
  }
  docs[`teams/${A}/keyGrants/${deviceOf(U.removed)}`] = grantDoc(A, U.removed, deviceOf(U.removed), 1, U.owner, deviceOf(U.owner));
  for (const uid of [U.outsider, U.outsiderEditor, U.outsiderViewer]) {
    docs[`teams/${B}/keyGrants/${deviceOf(uid)}`] = grantDoc(B, uid, deviceOf(uid), 1, U.outsider, deviceOf(U.outsider));
  }
  docs[`teams/${C}/keyGrants/${deviceOf(U.third)}`] = grantDoc(C, U.third, deviceOf(U.third), 1, U.third, deviceOf(U.third));
  // The pending member asked for the key for their device when they joined.
  docs[`teams/${A}/keyRequests/${deviceOf(U.pending)}`] = { uid: U.pending, deviceId: deviceOf(U.pending), createdAt: past };
  for (const [path, data] of [
    invite("live", {}),
    invite("auto", { role: "viewer", autoApprove: true }),
    invite("expired", { expiresAt: past }),
    invite("revoked", { revoked: true }),
    invite("usedUp", { maxUses: 1, uses: 1 }),
    share("link", { audience: "link", teamIds: [] }),
    share("linkExpired", { audience: "link", teamIds: [], expiresAt: past }),
    share("linkRevoked", { audience: "link", teamIds: [], revokedAt: past }),
    share("view", {}),
    share("propose", { level: "propose" }),
    share("expired", { expiresAt: past }),
    share("revoked", { revokedAt: past }),
  ] as const) {
    docs[path] = data;
  }
  return docs;
}

// ------------------------------------------------------------------------ helpers

async function allowed(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return true;
  } catch (error) {
    if (isCloudError(error, "permission-denied")) return false;
    throw error;
  }
}

function revisionWrite(uid: string, id: string, over: DocData = {}): Write {
  return {
    op: "set",
    path: `teams/${A}/autos/${AUTO}/revisions/${id}`,
    data: { n: 3, baseRevision: R2, author: uid, createdAt: SERVER_TIME, content: env(1), diverged: false, ...over },
  };
}

function joinWrites(uid: string, code: string, role: string, requestedRole: string, uses: number): Write[] {
  return [
    {
      op: "set",
      path: `teams/${A}/members/${uid}`,
      data: { uid, teamId: A, role, displayName: uid, joinedAt: SERVER_TIME, invite: code, requestedRole },
    },
    { op: "update", path: `invites/${code}`, data: { uses } },
  ];
}

function newShare(uid: string, id: string, over: DocData = {}): Write {
  return {
    op: "set",
    path: `shares/${id}`,
    data: {
      ownerTeamId: A,
      autoId: AUTO,
      audience: "teams",
      teamIds: [B],
      level: "view",
      mode: "pinned",
      revision: R2,
      expiresAt: new Date(Date.now() + 7 * DAY_MS),
      revokedAt: null,
      createdBy: uid,
      createdAt: SERVER_TIME,
      updatedAt: SERVER_TIME,
      projection: env(1),
      ...shareKeys(over),
      ...over,
    },
  };
}

function proposalWrite(uid: string, id: string, shareId: string, over: DocData = {}): Write {
  return {
    op: "set",
    path: `proposals/${id}`,
    data: {
      shareId, ownerTeamId: A, autoId: AUTO, fromTeamId: B, baseRevision: R2, diff: env(1),
      ownerWrap: shareWrap(), fromWrap: sealedKey(1), sig: bytes(64), status: "open", createdBy: uid, createdAt: SERVER_TIME, ...over,
    },
  };
}

/** A request for more time on `shareId`, for `teamId`, by `uid`. */
function timeRequestWrite(uid: string, shareId: string, teamId: string, over: DocData = {}): Write {
  return {
    op: "set",
    path: `shares/${shareId}/timeRequests/${teamId}`,
    data: { shareId, teamId, ownerTeamId: A, requestedBy: uid, requestedAt: SERVER_TIME, status: "open", ...over },
  };
}

/** An open request from team B for more time on `shareId`, as it is stored. */
function openTimeRequest(shareId: string): [string, DocData] {
  return [
    `shares/${shareId}/timeRequests/${B}`,
    { shareId, teamId: B, ownerTeamId: A, requestedBy: U.outsiderViewer, requestedAt: PAST, status: "open", reason: "next-event" },
  ];
}

// ------------------------------------------------------------------------ verification (M-C7)

const D = "teamDeltaDDDDDDDDDDDDD"; // holds 55555, contested by E
const E = "teamEchoEEEEEEEEEEEEEE"; // no number; the challenger of the open dispute
const F = "teamFoxtrotFFFFFFFFFFF"; // won 44444 from G
const G = "teamGolfGGGGGGGGGGGGGG"; // lost 44444, no number now

const DECIDED_REASON = "The event results list Foxtrot as 44444.";

const REQ = { open: "requestOpenXXXXXXXXXXX", fresh: "requestFreshXXXXXXXXXX" };
const DISPUTE = { open: "disputeOpenXXXXXXXXXXX", decided: "disputeDecidedXXXXXXXX" };

/** The people of the verification cases, on top of the world's. */
const V = {
  dora: "dora", // owner of D
  ed: "ed", // owner of E
  fay: "fay", // owner of F
  gus: "gus", // owner of G
  tara: "tara", // owner of C
  hugo: "hugo", // a second Horizon admin
  hana2: "hana2", // a third Horizon admin
} as const;


function verificationWorld(options: { openRequest?: boolean; decidedDaysAgo?: number; appealed?: boolean } = {}): Record<string, DocData> {
  const docs = world();
  const past = new Date(Date.now() - 3 * DAY_MS);
  const decidedAt = new Date(Date.now() - (options.decidedDaysAgo ?? 2) * DAY_MS);
  for (const uid of Object.values(V)) docs[`users/${uid}`] = { displayName: uid, createdAt: past };
  docs[`admins/${V.hugo}`] = { name: "Second reviewer" };
  docs[`admins/${V.hana2}`] = { name: "Third reviewer" };
  docs[`teams/${C}/members/${V.tara}`] = member(C, V.tara, "owner");
  docs[`teams/${D}`] = { number: 55555, name: "Delta", status: "contested", createdBy: V.dora, createdAt: past };
  docs[`teams/${D}/members/${V.dora}`] = member(D, V.dora, "owner");
  docs[`teams/${E}`] = { number: null, name: "Echo", status: "unverified", createdBy: V.ed, createdAt: past };
  docs[`teams/${E}/members/${V.ed}`] = member(E, V.ed, "owner");
  docs[`teams/${F}`] = { number: 44444, name: "Foxtrot", status: "verified", createdBy: V.fay, createdAt: past };
  docs[`teams/${F}/members/${V.fay}`] = member(F, V.fay, "owner");
  docs[`teams/${G}`] = { number: null, name: "Golf", status: "unverified", createdBy: V.gus, createdAt: past };
  docs[`teams/${G}/members/${V.gus}`] = member(G, V.gus, "owner");
  Object.assign(docs, claimDocs(
    55555,
    { teamId: D, status: "contested", claimedAt: past, disputeId: DISPUTE.open, requestId: null },
    [claimEntry("claim", D, V.dora), claimEntry("contest", E, V.ed, { disputeId: DISPUTE.open, otherTeamId: D })],
  ));
  docs[`disputes/${DISPUTE.open}`] = {
    teamNumber: 55555, holderTeamId: D, challengerTeamId: E, openedBy: V.ed, createdAt: past, status: "open",
    evidence: [], decision: null, appeal: null, appealDecision: null,
  };
  const decision = { winner: F, reason: DECIDED_REASON, by: U.horizon, at: decidedAt };
  const claimHistory = [
    claimEntry("claim", G, V.gus),
    claimEntry("contest", F, V.fay, { disputeId: DISPUTE.decided, otherTeamId: G }),
    claimEntry("decision", F, U.horizon, { disputeId: DISPUTE.decided, note: decision.reason, otherTeamId: G }),
  ];
  const decidedClaim = { teamId: F, status: "verified", claimedAt: past, disputeId: null, requestId: null };
  Object.assign(docs, claimDocs(44444, decidedClaim, claimHistory));
  docs[`disputes/${DISPUTE.decided}`] = {
    teamNumber: 44444, holderTeamId: G, challengerTeamId: F, openedBy: V.fay, createdAt: past, status: "decided",
    evidence: [], decision, appeal: null, appealDecision: null,
  };
  if (options.appealed === true) {
    const appeal = { team: G, by: V.gus, reason: "Our banner photo shows the number.", at: new Date(decidedAt.getTime() + DAY_MS) };
    docs[`disputes/${DISPUTE.decided}`] = { ...docs[`disputes/${DISPUTE.decided}`], status: "appealed", appeal };
    Object.assign(docs, claimDocs(44444, decidedClaim, [
      ...claimHistory,
      claimEntry("appeal", G, V.gus, { disputeId: DISPUTE.decided, note: appeal.reason, otherTeamId: F }),
    ]));
  }
  if (options.openRequest === true) {
    docs[`verifications/${REQ.open}`] = {
      teamNumber: 36596, teamId: A, requestedBy: U.owner, createdAt: past, status: "open", decision: null,
      evidence: [{ kind: "photo", summary: "Robot with the code on a card.", url: "https://example.org/robot.jpg", by: U.owner, at: past }],
    };
    Object.assign(docs, claimDocs(
      36596,
      { teamId: A, status: "unverified", claimedAt: PAST, requestId: REQ.open },
      [claimEntry("claim", A, U.owner), claimEntry("request", A, U.owner, { requestId: REQ.open })],
    ));
  }
  return docs;
}

/**
 * A verification request by `uid` for team A's 36596, with the claim pointing at it and the claim's
 * step `index` (1: right after the claim itself).
 */
function requestWrites(uid: string, id: string, over: DocData = {}, index = 1): Write[] {
  const teamId = (over.teamId as string | undefined) ?? A;
  const teamNumber = (over.teamNumber as number | undefined) ?? 36596;
  return [
    {
      op: "set",
      path: `verifications/${id}`,
      data: {
        teamNumber, teamId, requestedBy: uid, createdAt: SERVER_TIME, status: "open", decision: null,
        evidence: [{ kind: "statement", summary: "We are team 36596.", by: uid, at: new Date() }],
        ...over,
      },
    },
    { op: "update", path: `claims/${String(teamNumber)}`, data: { historyCount: index + 1, requestId: id } },
    stepWrite(teamNumber, index, claimEntry("request", teamId, uid, { requestId: id })),
  ];
}

/** A reviewer's decision on the open request, the claim's entry, and for a verification the team. */
function verifyWrites(uid: string, verdict: "verified" | "declined", over: { reason?: string; status?: string } = {}): Write[] {
  const reason = over.reason ?? "Robot photo with the claim code, and team listed at an event.";
  const writes: Write[] = [
    { op: "update", path: `verifications/${REQ.open}`, data: { status: "decided", decision: { verdict, reason, by: uid, at: SERVER_TIME } } },
    {
      op: "update",
      path: "claims/36596",
      data: { status: over.status ?? (verdict === "verified" ? "verified" : "unverified"), requestId: null, historyCount: 3 },
    },
    stepWrite(36596, 2, claimEntry(verdict === "verified" ? "verify" : "decline", A, uid, { requestId: REQ.open, note: reason })),
  ];
  if (verdict === "verified") writes.push({ op: "update", path: `teams/${A}`, data: { status: "verified" } });
  return writes;
}

/** A contest of `teamNumber`, held by `holder`, by `uid` for team E unless another challenger is named. */
function contestWrites(uid: string, teamNumber: number, holder: string, over: { status: string; challenger?: string; disputeId?: string }): Write[] {
  const challenger = over.challenger ?? E;
  const disputeId = over.disputeId ?? "disputeFreshXXXXXXXXXX";
  const index = teamNumber === 55555 ? 2 : 1;
  const writes: Write[] = [
    {
      op: "set",
      path: `disputes/${disputeId}`,
      data: {
        teamNumber, holderTeamId: holder, challengerTeamId: challenger, openedBy: uid, createdAt: SERVER_TIME, status: "open",
        evidence: [], decision: null, appeal: null, appealDecision: null,
      },
    },
    { op: "update", path: `claims/${String(teamNumber)}`, data: { status: over.status, disputeId, historyCount: index + 1 } },
    stepWrite(teamNumber, index, claimEntry("contest", challenger, uid, { disputeId, otherTeamId: holder })),
  ];
  if (over.status === "contested") {
    writes.push({ op: "update", path: `teams/${holder}`, data: { status: "contested" } });
    // The challenger has no number, so its label points at the review this write opens.
    writes.push({ op: "update", path: `teams/${challenger}`, data: { status: "contested", disputeId } });
  }
  return writes;
}

function evidenceWrite(disputeId: string, before: DocData[], uid: string, team: string, over: DocData = {}): Write {
  return {
    op: "update",
    path: `disputes/${disputeId}`,
    data: { evidence: [...before, { team, kind: "statement", summary: "Our number since 2023.", by: uid, at: new Date(), ...over }] },
  };
}

/** A reviewer's decision on the open dispute over 55555 (D holds it, E challenges). */
function decideWrites(uid: string, winner: string, over: { reason?: string } = {}): Write[] {
  const reason = over.reason ?? "The event results list Echo as 55555.";
  const loser = winner === E ? D : E;
  return [
    { op: "update", path: `disputes/${DISPUTE.open}`, data: { status: "decided", decision: { winner, reason, by: uid, at: SERVER_TIME } } },
    {
      op: "update",
      path: "claims/55555",
      data: { teamId: winner, status: "verified", disputeId: null, historyCount: 3 },
    },
    stepWrite(55555, 2, claimEntry("decision", winner, uid, { disputeId: DISPUTE.open, note: reason, otherTeamId: loser })),
    { op: "update", path: `teams/${winner}`, data: { status: "verified", number: 55555 } },
    { op: "update", path: `teams/${loser}`, data: { status: "unverified", number: null } },
  ];
}

/** The losing team's appeal of the decided dispute over 44444, and its entry in the claim's history. */
function appealWrites(uid: string, team: string): Write[] {
  return [
    {
      op: "update",
      path: `disputes/${DISPUTE.decided}`,
      data: { status: "appealed", appeal: { team, by: uid, reason: "Our banner photo shows the number.", at: SERVER_TIME } },
    },
    { op: "update", path: "claims/44444", data: { historyCount: 4 } },
    stepWrite(44444, 3, claimEntry("appeal", team, uid, { disputeId: DISPUTE.decided, otherTeamId: F })),
  ];
}

/** A reviewer's decision on the appeal over 44444, the claim's entry, and both teams. */
function appealDecisionWrites(uid: string, winner: string): Write[] {
  const reason = "The banner photo carries the claim code and the number.";
  const loser = winner === G ? F : G;
  return [
    { op: "update", path: `disputes/${DISPUTE.decided}`, data: { status: "final", appealDecision: { winner, reason, by: uid, at: SERVER_TIME } } },
    {
      op: "update",
      path: "claims/44444",
      data: { teamId: winner, status: "verified", historyCount: 5 },
    },
    stepWrite(44444, 4, claimEntry("appeal-decision", winner, uid, { disputeId: DISPUTE.decided, note: reason, otherTeamId: loser })),
    { op: "update", path: `teams/${winner}`, data: { status: "verified", number: 44444 } },
    { op: "update", path: `teams/${loser}`, data: { status: "unverified", number: null } },
  ];
}

// ------------------------------------------------------------------------ deleting a team

/** The tombstone that marks `teamId` deleted, by `uid`, stamped by the server. */
function tombstoneWrite(uid: string, teamId: string, over: DocData = {}): Write {
  return { op: "set", path: `deletedTeams/${teamId}`, data: { deletedBy: uid, deletedAt: SERVER_TIME, ...over } };
}

/** The world with team A's document gone and nothing else purged, as a partial deletion leaves it. */
function worldWithoutTeamA(extra: Record<string, DocData> = {}): Record<string, DocData> {
  return { ...Object.fromEntries(Object.entries(world()).filter(([path]) => path !== `teams/${A}`)), ...extra };
}

/** The seed of a new team's public key in the founding cases. */
const NEW_SEED = 0x50;

/**
 * The key documents a new team's founding batch writes (spec 14 section 4.2): team key record 1, the
 * recovery record and the founder's own grant, and with `withDevice` the founder's device record.
 */
function keyFoundingWrites(uid: string, teamId: string, options: { withDevice?: boolean; seed?: number } = {}): Write[] {
  const deviceId = deviceOf(uid);
  const seed = options.seed ?? NEW_SEED;
  const writes: Write[] = [];
  if (options.withDevice === true) writes.push({ op: "set", path: `users/${uid}/devices/${deviceId}`, data: { ...deviceDoc(), createdAt: SERVER_TIME } });
  writes.push(
    {
      op: "set",
      path: `teams/${teamId}/teamKeys/1`,
      data: { v: 1, kv: 1, prev: null, pairPrivate: env(1, 154), ...recordKeys(seed, 1) },
    },
    {
      op: "set",
      path: `teams/${teamId}/recovery/current`,
      data: { v: 1, kv: 1, ...recoveryKeys(), teamKey: keyWrap(), check: sealedKey(1), updatedBy: uid, updatedAt: SERVER_TIME },
    },
    {
      op: "set",
      path: `teams/${teamId}/keyGrants/${deviceId}`,
      data: { ...grantDoc(teamId, uid, deviceId, 1, uid, deviceId), createdAt: SERVER_TIME, updatedAt: SERVER_TIME },
    },
  );
  return writes;
}

/** Founding team `teamId` as `uid`, with no number, with the team's first keys. */
function foundWrites(uid: string, teamId: string, teamNumber: number | null = null): Write[] {
  return [
    {
      op: "set",
      path: `teams/${teamId}`,
      data: { number: teamNumber, name: "Taken over", status: "unverified", createdBy: uid, createdAt: SERVER_TIME, encKey: encKey(NEW_SEED) },
    },
    { op: "set", path: `teams/${teamId}/members/${uid}`, data: { uid, teamId, role: "owner", displayName: uid, joinedAt: SERVER_TIME } },
    ...keyFoundingWrites(uid, teamId),
  ];
}

// ------------------------------------------------------------------------ the private beta

/**
 * The console's switch that opens the private beta to everyone. A real project starts without it,
 * closed, so every reset of the suite writes it unless a case means to test the closed gate, which
 * resets through the harness itself.
 */
const OPEN_BETA: Record<string, DocData> = { "config/access": { betaOpen: true } };

/** The harness with every reset opening the beta first; a case's own config/access wins. */
function withOpenBeta(raw: PermissionHarness): PermissionHarness {
  return {
    reset: (docs) => raw.reset({ ...OPEN_BETA, ...docs }),
    as: (uid) => raw.as(uid),
    peek: (path) => raw.peek(path),
  };
}

// ------------------------------------------------------------------------ the suite

export function definePermissionSuite(label: string, harness: () => PermissionHarness, skip = false): void {
  const suite = skip ? describe.skip : describe;
  suite(`permissions (${label})`, () => {
    /** The harness as given, whose reset writes exactly the documents it is handed. */
    let raw: PermissionHarness;
    let h: PermissionHarness;
    const get = (uid: string | null, path: string) => allowed(h.as(uid).get(path));
    const list = (uid: string | null, query: Query) => allowed(h.as(uid).list(query));
    const commit = (uid: string | null, writes: Write[]) => allowed(h.as(uid).commit(writes).sent);

    beforeEach(async () => {
      raw = harness();
      h = withOpenBeta(raw);
      await h.reset(world());
    });

    describe("team library: autos and revisions", () => {
      const revision = `teams/${A}/autos/${AUTO}/revisions/${R2}`;
      const revisions = { collection: `teams/${A}/autos/${AUTO}/revisions` };

      it("is read by every active member and by nobody else", async () => {
        for (const uid of [U.owner, U.admin, U.editor, U.viewer]) {
          expect(await get(uid, revision), uid).toBe(true);
          expect(await list(uid, revisions), uid).toBe(true);
          expect(await list(uid, { collection: `teams/${A}/autos` }), uid).toBe(true);
        }
        for (const uid of [U.pending, U.removed, U.outsider, U.third, U.horizon, null]) {
          expect(await get(uid, revision), String(uid)).toBe(false);
          expect(await list(uid, revisions), String(uid)).toBe(false);
          expect(await get(uid, `teams/${A}/autos/${AUTO}`), String(uid)).toBe(false);
        }
      });

      it("takes new revisions from editors and above only", async () => {
        expect(await commit(U.editor, [revisionWrite(U.editor, "000003-byEditor")])).toBe(true);
        expect(await commit(U.owner, [revisionWrite(U.owner, "000003-byOwner1")])).toBe(true);
        for (const uid of [U.viewer, U.pending, U.removed, U.outsider]) {
          expect(await commit(uid, [revisionWrite(uid, `000003-by${uid}xxxx`)]), uid).toBe(false);
        }
      });

      it("never updates or deletes a revision, not even for the owner", async () => {
        const path = `teams/${A}/autos/${AUTO}/revisions/${R2}`;
        expect(await commit(U.owner, [{ op: "update", path, data: { content: env(1, 99) } }])).toBe(false);
        expect(await commit(U.owner, [{ op: "delete", path }])).toBe(false);
        expect(await commit(U.editor, [revisionWrite(U.editor, R2, { n: 2, baseRevision: R1 })])).toBe(false);
        expect(((await h.peek(path))?.content as { ct: Uint8Array }).ct.byteLength).toBe(41);
      });

      it("keeps both of two revisions published from one base", async () => {
        expect(await commit(U.editor, [revisionWrite(U.editor, "000003-firstXXX")])).toBe(true);
        expect(await commit(U.owner, [revisionWrite(U.owner, "000003-secondXX", { diverged: true })])).toBe(true);
        expect((await h.peek(`teams/${A}/autos/${AUTO}/revisions/000003-firstXXX`))?.author).toBe(U.editor);
        expect((await h.peek(`teams/${A}/autos/${AUTO}/revisions/000003-secondXX`))?.author).toBe(U.owner);
      });

      it("refuses a revision whose number does not follow its base, or that names another author", async () => {
        expect(await commit(U.editor, [revisionWrite(U.editor, "000005-skipXXXX", { n: 5 })])).toBe(false);
        expect(await commit(U.editor, [revisionWrite(U.editor, "000004-mismatch", { n: 3 })])).toBe(false);
        expect(await commit(U.editor, [revisionWrite(U.owner, "000003-forgedXX")])).toBe(false);
      });
    });

    describe("members", () => {
      it("are listed by active members only; a pending member reads only their own", async () => {
        for (const uid of [U.owner, U.admin, U.editor, U.viewer]) {
          expect(await list(uid, { collection: `teams/${A}/members` }), uid).toBe(true);
        }
        for (const uid of [U.pending, U.removed, U.outsider, null]) {
          expect(await list(uid, { collection: `teams/${A}/members` }), String(uid)).toBe(false);
        }
        expect(await get(U.pending, `teams/${A}/members/${U.pending}`)).toBe(true);
        expect(await get(U.pending, `teams/${A}/members/${U.owner}`)).toBe(false);
        expect(await get(U.removed, `teams/${A}/members/${U.removed}`)).toBe(true); // missing, and their own
        expect(await get(U.outsider, `teams/${A}/members/${U.owner}`)).toBe(false);
      });

      it("lets anyone list their own memberships across teams, and nobody else's", async () => {
        expect(await list(U.owner, { collection: "members", group: true, where: [{ field: "uid", value: U.owner }] })).toBe(true);
        expect(await list(U.owner, { collection: "members", group: true, where: [{ field: "uid", value: U.outsider }] })).toBe(false);
        expect(await list(U.owner, { collection: "members", group: true })).toBe(false);
      });

      it("change role only by owners and admins, never by the member themselves", async () => {
        const path = `teams/${A}/members/${U.viewer}`;
        expect(await commit(U.editor, [{ op: "update", path, data: { role: "editor" } }])).toBe(false);
        expect(await commit(U.viewer, [{ op: "update", path, data: { role: "editor" } }])).toBe(false);
        expect(await commit(U.pending, [{ op: "update", path: `teams/${A}/members/${U.pending}`, data: { role: "editor" } }])).toBe(false);
        expect(await commit(U.outsider, [{ op: "update", path, data: { role: "editor" } }])).toBe(false);
        expect(await commit(U.admin, [{ op: "update", path, data: { role: "editor" } }])).toBe(true);
        expect(await commit(U.admin, [{ op: "update", path: `teams/${A}/members/${U.owner}`, data: { role: "viewer" } }])).toBe(false);
        expect(await commit(U.admin, [{ op: "update", path, data: { role: "owner" } }])).toBe(false);
        expect(await commit(U.owner, [{ op: "update", path, data: { role: "owner" } }])).toBe(true);
        expect(await commit(U.owner, [{ op: "update", path: `teams/${A}/members/${U.owner}`, data: { role: "admin" } }])).toBe(false);
      });

      it("approve a pending member only by an owner or admin", async () => {
        const path = `teams/${A}/members/${U.pending}`;
        expect(await commit(U.editor, [{ op: "update", path, data: { role: "editor" } }])).toBe(false);
        expect(await commit(U.admin, [{ op: "update", path, data: { role: "editor" } }])).toBe(true);
      });

      it("are removed by owners and admins; an owner cannot leave or be removed by an admin", async () => {
        expect(await commit(U.editor, [{ op: "delete", path: `teams/${A}/members/${U.viewer}` }])).toBe(false);
        expect(await commit(U.outsider, [{ op: "delete", path: `teams/${A}/members/${U.viewer}` }])).toBe(false);
        expect(await commit(U.admin, [{ op: "delete", path: `teams/${A}/members/${U.owner}` }])).toBe(false);
        expect(await commit(U.owner, [{ op: "delete", path: `teams/${A}/members/${U.owner}` }])).toBe(false);
        expect(await commit(U.viewer, [{ op: "delete", path: `teams/${A}/members/${U.viewer}` }])).toBe(true);
        expect(await commit(U.admin, [{ op: "delete", path: `teams/${A}/members/${U.editor}` }])).toBe(true);
        expect(await get(U.editor, `teams/${A}/autos/${AUTO}`)).toBe(false);
      });

      it("cannot be created by writing oneself into a team", async () => {
        const data = { uid: U.newcomer, teamId: A, role: "viewer", displayName: "nina", joinedAt: SERVER_TIME };
        expect(await commit(U.newcomer, [{ op: "set", path: `teams/${A}/members/${U.newcomer}`, data }])).toBe(false);
        expect(await commit(U.newcomer, [{ op: "set", path: `teams/${A}/members/${U.newcomer}`, data: { ...data, role: "owner" } }])).toBe(false);
      });
    });

    describe("invites", () => {
      const joined = async (uid: string) => (await h.peek(`teams/${A}/members/${uid}`))?.role ?? null;

      it("are never listed, not even by the owner, and read by id by anyone signed in", async () => {
        for (const uid of [U.owner, U.admin, U.newcomer, null]) {
          expect(await list(uid, { collection: "invites" }), String(uid)).toBe(false);
          expect(await list(uid, { collection: "invites", where: [{ field: "teamId", value: A }] }), String(uid)).toBe(false);
        }
        expect(await get(U.newcomer, `invites/${INVITE.live}`)).toBe(true);
        expect(await get(null, `invites/${INVITE.live}`)).toBe(false);
      });

      it("are made by owners and admins only", async () => {
        const data = {
          teamId: A, role: "viewer", expiresAt: new Date(Date.now() + DAY_MS), maxUses: 1, uses: 0,
          autoApprove: false, createdAt: SERVER_TIME, revoked: false,
        };
        expect(await commit(U.admin, [{ op: "set", path: "invites/newInviteByAdminXXXXXXX", data: { ...data, createdBy: U.admin } }])).toBe(true);
        for (const uid of [U.editor, U.viewer, U.pending, U.outsider]) {
          expect(await commit(uid, [{ op: "set", path: `invites/newInviteBy${uid}XXXXXXXXXX`, data: { ...data, createdBy: uid } }]), uid).toBe(false);
        }
        expect(await commit(U.admin, [{ op: "set", path: "invites/shortCode", data: { ...data, createdBy: U.admin } }])).toBe(false);
      });

      it("add a redeemer as pending, and count the use in the same write", async () => {
        expect(await commit(U.newcomer, joinWrites(U.newcomer, INVITE.live, "pending", "editor", 1))).toBe(true);
        expect(await joined(U.newcomer)).toBe("pending");
        expect((await h.peek(`invites/${INVITE.live}`))?.uses).toBe(1);
        expect(await get(U.newcomer, `teams/${A}/autos/${AUTO}`)).toBe(false);
      });

      it("refuse a redeemer who gives themselves the role instead of pending", async () => {
        expect(await commit(U.newcomer, joinWrites(U.newcomer, INVITE.live, "editor", "editor", 1))).toBe(false);
        expect(await joined(U.newcomer)).toBe(null);
      });

      it("add the invite's role at once when it approves automatically", async () => {
        expect(await commit(U.newcomer, joinWrites(U.newcomer, INVITE.auto, "viewer", "viewer", 1))).toBe(true);
        expect(await joined(U.newcomer)).toBe("viewer");
        expect(await get(U.newcomer, `teams/${A}/autos/${AUTO}`)).toBe(true);
      });

      it("never add anyone when expired, revoked or used up", async () => {
        expect(await commit(U.newcomer, joinWrites(U.newcomer, INVITE.expired, "pending", "editor", 1))).toBe(false);
        expect(await commit(U.newcomer, joinWrites(U.newcomer, INVITE.revoked, "pending", "editor", 1))).toBe(false);
        expect(await commit(U.newcomer, joinWrites(U.newcomer, INVITE.usedUp, "pending", "editor", 2))).toBe(false);
        expect(await joined(U.newcomer)).toBe(null);
      });

      it("refuse a join that does not count the use, and a use that does not join", async () => {
        const [memberWrite, countWrite] = joinWrites(U.newcomer, INVITE.live, "pending", "editor", 1);
        expect(await commit(U.newcomer, [memberWrite as Write])).toBe(false);
        expect(await commit(U.newcomer, [countWrite as Write])).toBe(false);
        expect(await commit(U.newcomer, joinWrites(U.newcomer, INVITE.live, "pending", "editor", 2))).toBe(false);
        expect(await joined(U.newcomer)).toBe(null);
      });

      it("cannot be used by a member to change their own role", async () => {
        expect(await commit(U.viewer, joinWrites(U.viewer, INVITE.auto, "viewer", "viewer", 1))).toBe(false);
        expect(await commit(U.pending, joinWrites(U.pending, INVITE.auto, "viewer", "viewer", 1))).toBe(false);
        expect(await joined(U.pending)).toBe("pending");
      });

      it("are extended and revoked by admins; a revoked invite stays revoked", async () => {
        const path = `invites/${INVITE.live}`;
        const later = new Date(Date.now() + 30 * DAY_MS);
        expect(await commit(U.editor, [{ op: "update", path, data: { expiresAt: later } }])).toBe(false);
        expect(await commit(U.admin, [{ op: "update", path, data: { expiresAt: later } }])).toBe(true);
        expect(await commit(U.admin, [{ op: "update", path: `invites/${INVITE.revoked}`, data: { revoked: false } }])).toBe(false);
        expect(await commit(U.admin, [{ op: "update", path, data: { uses: 1 } }])).toBe(false);
      });
    });

    describe("shares", () => {
      it("an anyone-with-the-link share is read by id by any caller, even unauthenticated", async () => {
        for (const uid of [null, U.newcomer, U.third]) {
          expect(await get(uid, `shares/${SHARE.link}`), String(uid)).toBe(true);
        }
        for (const id of [SHARE.linkExpired, SHARE.linkRevoked]) {
          expect(await get(null, `shares/${id}`), id).toBe(false);
          expect(await get(U.third, `shares/${id}`), id).toBe(false);
        }
      });

      it("nobody outside the sharing team can list shares", async () => {
        for (const uid of [null, U.newcomer, U.outsider, U.third]) {
          expect(await list(uid, { collection: "shares" }), String(uid)).toBe(false);
          expect(await list(uid, { collection: "shares", where: [{ field: "audience", value: "link" }] }), String(uid)).toBe(false);
          expect(await list(uid, { collection: "shares", where: [{ field: "ownerTeamId", value: A }] }), String(uid)).toBe(false);
        }
        expect(await list(U.viewer, { collection: "shares", where: [{ field: "ownerTeamId", value: A }] })).toBe(true);
        expect(await list(U.viewer, { collection: "shares" })).toBe(false);
      });

      it("a share to teams is read by active members of those teams while it is live", async () => {
        for (const uid of [U.outsider, U.outsiderEditor, U.outsiderViewer]) {
          expect(await get(uid, `shares/${SHARE.view}`), uid).toBe(true);
          expect(await get(uid, `shares/${SHARE.expired}`), uid).toBe(false);
          expect(await get(uid, `shares/${SHARE.revoked}`), uid).toBe(false);
        }
        for (const uid of [U.outsiderPending, U.third, U.newcomer, U.removed, null]) {
          expect(await get(uid, `shares/${SHARE.view}`), String(uid)).toBe(false);
        }
        for (const uid of [U.owner, U.viewer]) {
          expect(await get(uid, `shares/${SHARE.expired}`), uid).toBe(true);
          expect(await get(uid, `shares/${SHARE.revoked}`), uid).toBe(true);
        }
        expect(await get(U.pending, `shares/${SHARE.view}`)).toBe(false);
      });

      it("rewrites the inbox pointer of a team put back on a share, with the same checks as a new one", async () => {
        const pointer = (uid: string, teamId: string, shareId: string): Write => ({
          op: "set", path: `teams/${teamId}/inbox/${shareId}`, data: { shareId, ownerTeamId: A, createdBy: uid, createdAt: SERVER_TIME },
        });
        expect(await commit(U.editor, [pointer(U.editor, B, SHARE.view)])).toBe(true);
        expect(await commit(U.viewer, [pointer(U.viewer, B, SHARE.view)])).toBe(false);
        expect(await commit(U.outsider, [pointer(U.outsider, B, SHARE.view)])).toBe(false);
        expect(await commit(U.editor, [pointer(U.editor, C, SHARE.view)])).toBe(false);
      });

      it("the receiving team lists its inbox; nobody else does", async () => {
        expect(await list(U.outsiderViewer, { collection: `teams/${B}/inbox` })).toBe(true);
        expect(await list(U.outsiderPending, { collection: `teams/${B}/inbox` })).toBe(false);
        expect(await list(U.third, { collection: `teams/${B}/inbox` })).toBe(false);
      });

      it("editors share with specific teams at view level; viewers and outsiders cannot share", async () => {
        expect(await commit(U.editor, [newShare(U.editor, "shareByEditorViewXXXXX")])).toBe(true);
        for (const uid of [U.viewer, U.pending, U.removed, U.outsider]) {
          expect(await commit(uid, [newShare(uid, `shareBy${uid}XXXXXXXXXXXXX`)]), uid).toBe(false);
        }
      });

      it("by default editors may not make propose-level or link shares; admins may", async () => {
        expect(await commit(U.editor, [newShare(U.editor, "shareEditorProposeXXXX", { level: "propose" })])).toBe(false);
        expect(await commit(U.editor, [newShare(U.editor, "shareEditorLinkXXXXXXX", { audience: "link", teamIds: [] })])).toBe(false);
        expect(await commit(U.admin, [newShare(U.admin, "shareAdminProposeXXXXX", { level: "propose" })])).toBe(true);
        expect(await commit(U.admin, [newShare(U.admin, "shareAdminLinkXXXXXXXX", { audience: "link", teamIds: [] })])).toBe(true);
      });

      it("team settings can let editors make propose-level and link shares", async () => {
        expect(await commit(U.editor, [{ op: "set", path: `teams/${A}/settings/sharing`, data: { editorsMayLinkShare: true } }])).toBe(false);
        expect(await commit(U.admin, [{
          op: "set", path: `teams/${A}/settings/sharing`, data: { editorsMayLinkShare: true, editorsMayProposeShare: true },
        }])).toBe(true);
        expect(await commit(U.editor, [newShare(U.editor, "shareEditorProposeXXXX", { level: "propose" })])).toBe(true);
        expect(await commit(U.editor, [newShare(U.editor, "shareEditorLinkXXXXXXX", { audience: "link", teamIds: [] })])).toBe(true);
      });

      it("a link share is always view only, and a share id must be 128 random bits", async () => {
        expect(await commit(U.owner, [newShare(U.owner, "shareLinkProposeXXXXXX", { audience: "link", teamIds: [], level: "propose" })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "k3f9x2")])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareOfMissingRevXXXXX", { revision: "000009-missingX" })])).toBe(false);
      });

      it("is extended and revoked by its team; a revoked share cannot be brought back", async () => {
        const later = new Date(Date.now() + 30 * DAY_MS);
        // Extending signs a new manifest, which names the new end, in the same write.
        expect(await commit(U.outsider, [{ op: "update", path: `shares/${SHARE.view}`, data: { expiresAt: later, manifest: manifest(2), updatedAt: SERVER_TIME } }])).toBe(false);
        expect(await commit(U.viewer, [{ op: "update", path: `shares/${SHARE.view}`, data: { expiresAt: later, manifest: manifest(2), updatedAt: SERVER_TIME } }])).toBe(false);
        expect(await commit(U.admin, [{ op: "update", path: `shares/${SHARE.view}`, data: { expiresAt: later, updatedAt: SERVER_TIME } }])).toBe(false);
        expect(await commit(U.admin, [{ op: "update", path: `shares/${SHARE.view}`, data: { expiresAt: later, manifest: manifest(2), updatedAt: SERVER_TIME } }])).toBe(true);
        // Revoking signs a new manifest, which says the share is revoked, in the same write.
        expect(await commit(U.admin, [{ op: "update", path: `shares/${SHARE.view}`, data: { revokedAt: SERVER_TIME, updatedAt: SERVER_TIME } }])).toBe(false);
        expect(await commit(U.admin, [{ op: "update", path: `shares/${SHARE.view}`, data: { revokedAt: SERVER_TIME, manifest: manifest(3), updatedAt: SERVER_TIME } }])).toBe(true);
        expect(await get(U.outsider, `shares/${SHARE.view}`)).toBe(false);
        expect(await commit(U.owner, [{ op: "update", path: `shares/${SHARE.view}`, data: { revokedAt: null, manifest: manifest(4), updatedAt: SERVER_TIME } }])).toBe(false);
      });

      it("a revoked share is read by nobody outside its team, and its team still sees it on the Sharing page", async () => {
        for (const uid of [null, U.newcomer, U.third, U.outsider, U.outsiderViewer]) {
          expect(await get(uid, `shares/${SHARE.linkRevoked}`), String(uid)).toBe(false);
          expect(await get(uid, `shares/${SHARE.revoked}`), String(uid)).toBe(false);
        }
        for (const uid of [U.owner, U.admin, U.editor, U.viewer]) {
          expect(await get(uid, `shares/${SHARE.linkRevoked}`), uid).toBe(true);
          expect(await get(uid, `shares/${SHARE.revoked}`), uid).toBe(true);
          expect(await list(uid, { collection: "shares", where: [{ field: "ownerTeamId", value: A }] }), uid).toBe(true);
        }
      });

      it("a share whose team was deleted is read by nobody but a Horizon admin", async () => {
        await h.reset(Object.fromEntries(Object.entries(world()).filter(([path]) => path !== `teams/${A}`)));
        for (const uid of [null, U.newcomer, U.third]) {
          expect(await get(uid, `shares/${SHARE.link}`), String(uid)).toBe(false);
        }
        for (const uid of [U.outsider, U.outsiderEditor, U.outsiderViewer]) {
          expect(await get(uid, `shares/${SHARE.view}`), uid).toBe(false);
          expect(await get(uid, `shares/${SHARE.propose}`), uid).toBe(false);
        }
        expect(await get(U.horizon, `shares/${SHARE.link}`)).toBe(true);
        expect(await get(U.horizon, `shares/${SHARE.view}`)).toBe(true);
      });
    });

    describe("shares seen by Horizon admins", () => {
      const allShares: Query = { collection: "shares" };

      it("a Horizon admin gets and lists every share of every team, revoked and expired ones included", async () => {
        for (const id of Object.values(SHARE)) {
          expect(await get(U.horizon, `shares/${id}`), id).toBe(true);
        }
        expect(await list(U.horizon, allShares)).toBe(true);
        expect(await list(U.horizon, { collection: "shares", where: [{ field: "ownerTeamId", value: B }] })).toBe(true);
        expect(await list(U.horizon, { collection: "shares", where: [{ field: "audience", value: "link" }] })).toBe(true);
      });

      it("nobody else lists every share, nor the shares of a team they are not in", async () => {
        for (const uid of [null, U.newcomer, U.owner, U.viewer, U.outsider, U.third, U.pending, U.removed]) {
          expect(await list(uid, allShares), String(uid)).toBe(false);
        }
        for (const uid of [U.outsider, U.outsiderViewer, U.third, U.pending, U.removed]) {
          expect(await list(uid, { collection: "shares", where: [{ field: "ownerTeamId", value: A }] }), uid).toBe(false);
        }
        expect(await list(U.owner, { collection: "shares", where: [{ field: "ownerTeamId", value: B }] })).toBe(false);
      });

      it("a Horizon admin cannot make, change or revoke a share without a role in its team", async () => {
        const later = new Date(Date.now() + 30 * DAY_MS);
        expect(await commit(U.horizon, [newShare(U.horizon, "shareByHorizonAdminXXX")])).toBe(false);
        expect(await commit(U.horizon, [{ op: "update", path: `shares/${SHARE.view}`, data: { expiresAt: later, updatedAt: SERVER_TIME } }])).toBe(false);
        expect(await commit(U.horizon, [{ op: "update", path: `shares/${SHARE.view}`, data: { revokedAt: SERVER_TIME, manifest: manifest(2), updatedAt: SERVER_TIME } }])).toBe(false);
        expect(await commit(U.horizon, [{ op: "update", path: `shares/${SHARE.link}`, data: { level: "propose", updatedAt: SERVER_TIME } }])).toBe(false);
        expect(await commit(U.horizon, [{ op: "delete", path: `shares/${SHARE.revoked}` }])).toBe(false);
        expect(await h.peek(`shares/${SHARE.view}`)).toMatchObject({ revokedAt: null });
      });

      // The rules engine reads at most 10 documents for one get (ADR 0009 section 4). These are the
      // two longest reads of a share to 8 teams: a member of the last team, and a Horizon admin.
      it("a share to 8 teams is read by a member of the last one and by a Horizon admin", async () => {
        const extra = ["teamT1", "teamT2", "teamT3", "teamT4", "teamT5", "teamT6"].map((t) => `${t}XXXXXXXXXXXXXXXX`);
        const docs = world();
        for (const [index, teamId] of extra.entries()) {
          docs[`teams/${teamId}`] = { number: null, name: `Extra ${String(index)}`, status: "unverified", createdBy: `x${String(index)}`, createdAt: PAST };
          docs[`teams/${teamId}/members/x${String(index)}`] = member(teamId, `x${String(index)}`, "viewer");
        }
        const [path, data] = share("view", { teamIds: [B, C, ...extra] });
        docs[path] = data;
        await h.reset(docs);
        expect(await get("x5", path)).toBe(true);
        expect(await get(U.third, path)).toBe(true);
        expect(await get(U.horizon, path)).toBe(true);
        expect(await get(U.newcomer, path)).toBe(false);
      });
    });

    describe("proposals", () => {
      it("are accepted only from editors of a team granted propose on a live share", async () => {
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalOkXXXXXXXXXXXX", SHARE.propose)])).toBe(true);
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalOnViewXXXXXXXX", SHARE.view)])).toBe(false);
        expect(await commit(U.outsiderViewer, [proposalWrite(U.outsiderViewer, "proposalByViewerXXXXXX", SHARE.propose)])).toBe(false);
        expect(await commit(U.outsiderPending, [proposalWrite(U.outsiderPending, "proposalByPendingXXXXX", SHARE.propose)])).toBe(false);
        expect(await commit(U.third, [proposalWrite(U.third, "proposalByThirdXXXXXXX", SHARE.propose, { fromTeamId: C })])).toBe(false);
      });

      it("need an id of 128 random bits, and a sharing team that still exists", async () => {
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalOk", SHARE.propose)])).toBe(false);
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposal21charsXXXXXX", SHARE.propose)])).toBe(false);
        await h.reset(worldWithoutTeamA());
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalToGoneTeamXXXX", SHARE.propose)])).toBe(false);
      });

      it("are refused on an expired or revoked share", async () => {
        await h.reset({
          ...world(),
          [`shares/${SHARE.expired}`]: { ...(world()[`shares/${SHARE.expired}`] as DocData), level: "propose" },
          [`shares/${SHARE.revoked}`]: { ...(world()[`shares/${SHARE.revoked}`] as DocData), level: "propose" },
        });
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalExpiredXXXXXXX", SHARE.expired)])).toBe(false);
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalRevokedXXXXXXX", SHARE.revoked)])).toBe(false);
      });

      it("carry a key of their own, wrapped to the owning team at the key version it shows and sealed under the proposing team's key, at their sizes", async () => {
        const send = (id: string, over: DocData): Promise<boolean> => commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, id, SHARE.propose, over)]);
        // The diff is under the proposal's own key, which is always version 1.
        expect(await send("proposalDiffKv2XXXXXXX", { diff: env(2) })).toBe(false);
        // The owner wrap is a 256-bit key wrapped to a public key, with the version it was wrapped to.
        expect(await send("proposalNoOwnerWrapXXX", { ownerWrap: undefined })).toBe(false);
        expect(await send("proposalOwnerNoEkvXXXX", { ownerWrap: keyWrap() })).toBe(false);
        expect(await send("proposalOwnerLongXXXXX", { ownerWrap: { ...shareWrap(), ct: bytes(49) } })).toBe(false);
        expect(await send("proposalOwnerShortXXXX", { ownerWrap: { ...shareWrap(), ct: bytes(47) } })).toBe(false);
        expect(await send("proposalOwnerExtraXXXX", { ownerWrap: { ...shareWrap(), note: "x" } })).toBe(false);
        // The sending team's copy is that key sealed under a team key: 48 bytes of ciphertext.
        expect(await send("proposalNoFromWrapXXXX", { fromWrap: undefined })).toBe(false);
        expect(await send("proposalOldFromWrapXXX", { fromWrap: shareWrap() })).toBe(false);
        expect(await send("proposalFromLongXXXXXX", { fromWrap: env(1, 49) })).toBe(false);
        expect(await send("proposalFromShortXXXXX", { fromWrap: env(1, 47) })).toBe(false);
        expect(await send("proposalExtraFieldXXXX", { keyWraps: { [A]: shareWrap() } })).toBe(false);
        // The proposing team's signature is 64 bytes, as Bytes; the owning team checks what it signs.
        expect(await send("proposalNoSigXXXXXXXXX", { sig: undefined })).toBe(false);
        expect(await send("proposalSigLongXXXXXXX", { sig: bytes(65) })).toBe(false);
        expect(await send("proposalSigShortXXXXXX", { sig: bytes(63) })).toBe(false);
        expect(await send("proposalSigTextXXXXXXX", { sig: "a".repeat(64) })).toBe(false);
        // The owner wrap must be at the key the owning team shows now, never an older or a newer one.
        expect(await send("proposalOwnerAheadXXXX", { ownerWrap: shareWrap(2) })).toBe(false);
        expect(await send("proposalOwnKeyXXXXXXXX", {})).toBe(true);
        const docs = { ...world(), ...keyDocs(A, SEED.A, 2, U.owner) };
        docs[`teams/${A}`] = { ...(docs[`teams/${A}`] as DocData), encKey: encKey(SEED.A, 2) };
        await h.reset(docs);
        expect(await send("proposalOwnerStaleXXXX", { ownerWrap: shareWrap(1) })).toBe(false);
        expect(await send("proposalOwnerNewestXXX", { ownerWrap: shareWrap(2) })).toBe(true);
      });

      it("are read by both teams and nobody else, and listed by either team's filter", async () => {
        for (const uid of [U.viewer, U.outsiderViewer]) expect(await get(uid, "proposals/proposal1"), uid).toBe(true);
        for (const uid of [U.third, U.pending, U.outsiderPending, U.removed, null]) {
          expect(await get(uid, "proposals/proposal1"), String(uid)).toBe(false);
        }
        expect(await list(U.viewer, { collection: "proposals", where: [{ field: "ownerTeamId", value: A }] })).toBe(true);
        expect(await list(U.outsiderViewer, { collection: "proposals", where: [{ field: "fromTeamId", value: B }] })).toBe(true);
        expect(await list(U.third, { collection: "proposals", where: [{ field: "ownerTeamId", value: A }] })).toBe(false);
        expect(await list(U.viewer, { collection: "proposals" })).toBe(false);
      });

      it("are decided by the owning team's editors and withdrawn only by their author", async () => {
        const decide = (status: string, uid: string): Write => ({
          op: "update", path: "proposals/proposal1", data: { status, decidedBy: uid, decidedAt: SERVER_TIME },
        });
        expect(await commit(U.viewer, [decide("accepted", U.viewer)])).toBe(false);
        expect(await commit(U.outsider, [decide("accepted", U.outsider)])).toBe(false);
        expect(await commit(U.outsider, [decide("withdrawn", U.outsider)])).toBe(false);
        expect(await commit(U.editor, [decide("accepted", U.editor)])).toBe(true);
        expect(await commit(U.editor, [decide("rejected", U.editor)])).toBe(false);
      });
    });

    describe("proposals: the revision they are made against", () => {
      it("a pinned share takes a proposal only against the revision it shows", async () => {
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalOnOldXXXXXXXXX", SHARE.propose, { baseRevision: R1 })])).toBe(false);
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalOnPathXXXXXXXX", SHARE.propose, { baseRevision: `${R2}/x` })])).toBe(false);
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalOnShownXXXXXXX", SHARE.propose, { baseRevision: R2 })])).toBe(true);
      });

      it("a following share takes one against any revision of its auto in the library", async () => {
        await h.reset({
          ...world(),
          [`shares/${SHARE.propose}`]: { ...(world()[`shares/${SHARE.propose}`] as DocData), mode: "follow" },
        });
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalOnOldXXXXXXXXX", SHARE.propose, { baseRevision: R1 })])).toBe(true);
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalOnMissingXXXXX", SHARE.propose, { baseRevision: "000009-missingX" })])).toBe(false);
      });
    });

    // Spec 13 section 13 and spec 14 section 4.10: 1,000,000 bytes of ciphertext for a projection and
    // for a proposal's diff, the largest round number that keeps a document under Firestore's 1 MiB.
    describe("size caps", () => {
      const MAX = 1_000_000;

      it("a share's projection is taken at the cap and refused one byte over it", async () => {
        expect(await commit(U.owner, [newShare(U.owner, "shareAtTheCapXXXXXXXXX", { projection: env(1, MAX) })])).toBe(true);
        expect(await commit(U.owner, [newShare(U.owner, "shareOverTheCapXXXXXXX", { projection: env(1, MAX + 1) })])).toBe(false);
        const update = (ct: number): Write => ({
          op: "update", path: `shares/${SHARE.view}`, data: { projection: env(1, ct), manifest: manifest(2), updatedAt: SERVER_TIME },
        });
        expect(await commit(U.owner, [update(MAX + 1)])).toBe(false);
        expect(await commit(U.owner, [update(MAX)])).toBe(true);
      });

      it("a proposal's diff is taken at the cap and refused one byte over it", async () => {
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalAtCapXXXXXXXXX", SHARE.propose, { diff: env(1, MAX) })])).toBe(true);
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalOverCapXXXXXXX", SHARE.propose, { diff: env(1, MAX + 1) })])).toBe(false);
      });

      it("a revision holds a sealed auto as large as a document can, beside its other fields", async () => {
        expect(await commit(U.editor, [revisionWrite(U.editor, "000003-bigOneXX", { content: env(1, 1_040_000) })])).toBe(true);
      });

      it("a title's ciphertext is at most 1,024 bytes", async () => {
        const auto = (ct: number): Write => ({
          op: "set", path: `teams/${A}/autos/autoBig${String(ct)}XXXXXXXXXXXX`,
          data: { title: env(1, ct), titleGen: 1, createdBy: U.editor, createdAt: SERVER_TIME, updatedAt: SERVER_TIME },
        });
        expect(await commit(U.editor, [auto(1024)])).toBe(true);
        expect(await commit(U.editor, [auto(1025)])).toBe(false);
      });
    });

    describe("requests for more time", () => {
      const path = `shares/${SHARE.view}/timeRequests/${B}`;
      const later = new Date(Date.now() + 30 * DAY_MS);
      const decide = (uid: string, status: string, over: DocData = {}): Write => ({
        op: "update", path, data: { status, decidedBy: uid, decidedAt: SERVER_TIME, ...over },
      });
      const extend = (expiresAt: Date, shareId = SHARE.view): Write => ({
        op: "update", path: `shares/${shareId}`, data: { expiresAt, manifest: manifest(2), updatedAt: SERVER_TIME },
      });

      it("are made by any active member of a team the share was made to, for that team only", async () => {
        expect(await commit(U.outsiderPending, [timeRequestWrite(U.outsiderPending, SHARE.view, B)])).toBe(false);
        expect(await commit(U.third, [timeRequestWrite(U.third, SHARE.view, C)])).toBe(false);
        expect(await commit(U.third, [timeRequestWrite(U.third, SHARE.view, B)])).toBe(false);
        expect(await commit(U.owner, [timeRequestWrite(U.owner, SHARE.view, B)])).toBe(false);
        expect(await commit(U.outsider, [timeRequestWrite(U.outsider, SHARE.link, B)])).toBe(false);
        expect(await commit(U.outsiderViewer, [timeRequestWrite(U.outsider, SHARE.view, B)])).toBe(false);
        expect(await commit(U.outsiderViewer, [timeRequestWrite(U.outsiderViewer, SHARE.view, B, { ownerTeamId: C })])).toBe(false);
        expect(await commit(U.outsiderViewer, [timeRequestWrite(U.outsiderViewer, SHARE.view, B)])).toBe(true);
      });

      it("are taken before and after the share ends, and never once it was revoked", async () => {
        expect(await commit(U.outsiderViewer, [timeRequestWrite(U.outsiderViewer, SHARE.expired, B)])).toBe(true);
        expect(await commit(U.outsiderViewer, [timeRequestWrite(U.outsiderViewer, SHARE.revoked, B)])).toBe(false);
      });

      it("hold only a reason from the fixed list and an end after now: no free text", async () => {
        const ask = (over: DocData) => commit(U.outsiderViewer, [timeRequestWrite(U.outsiderViewer, SHARE.view, B, over)]);
        expect(await ask({ reason: "please" })).toBe(false);
        expect(await ask({ note: "Hi, can we have it longer?" })).toBe(false);
        expect(await ask({ wantedUntil: PAST })).toBe(false);
        expect(await ask({ wantedUntil: "next week" })).toBe(false);
        expect(await ask({ status: "granted" })).toBe(false);
        expect(await ask({ reason: "still-planning", wantedUntil: later })).toBe(true);
      });

      it("are one open request per team, asked again only after a decision", async () => {
        expect(await commit(U.outsiderViewer, [timeRequestWrite(U.outsiderViewer, SHARE.view, B)])).toBe(true);
        expect(await commit(U.outsider, [timeRequestWrite(U.outsider, SHARE.view, B, { reason: "next-event" })])).toBe(false);
        expect(await commit(U.admin, [decide(U.admin, "declined")])).toBe(true);
        expect(await commit(U.outsider, [timeRequestWrite(U.outsider, SHARE.view, B, { reason: "next-event" })])).toBe(true);
        expect(await commit(U.outsider, [{ op: "delete", path }])).toBe(false);
      });

      it("are read by both teams' active members and nobody else, and listed by either team's filter", async () => {
        const [seeded, data] = openTimeRequest(SHARE.view);
        await h.reset({ ...world(), [seeded]: data });
        for (const uid of [U.viewer, U.owner, U.outsiderViewer, U.outsider]) expect(await get(uid, path), uid).toBe(true);
        for (const uid of [U.pending, U.outsiderPending, U.third, U.removed, U.horizon, null]) {
          expect(await get(uid, path), String(uid)).toBe(false);
        }
        const group = (field: string, value: string): Query => ({ collection: "timeRequests", group: true, where: [{ field, value }] });
        expect(await list(U.viewer, group("ownerTeamId", A))).toBe(true);
        expect(await list(U.outsiderViewer, group("teamId", B))).toBe(true);
        expect(await list(U.outsiderViewer, group("ownerTeamId", A))).toBe(false);
        expect(await list(U.third, group("teamId", B))).toBe(false);
        expect(await list(U.viewer, { collection: "timeRequests", group: true })).toBe(false);
      });

      it("are declined by the sharing team's owners and admins or the share's maker, and nobody else", async () => {
        const [seeded, data] = openTimeRequest(SHARE.view);
        await h.reset({ ...world(), [seeded]: data });
        for (const uid of [U.editor, U.viewer, U.outsider, U.outsiderViewer, U.horizon]) {
          expect(await commit(uid, [decide(uid, "declined")]), uid).toBe(false);
        }
        expect(await commit(U.admin, [decide(U.owner, "declined")])).toBe(false);
        expect(await commit(U.admin, [decide(U.admin, "declined", { grantedUntil: later })])).toBe(false);
        expect(await commit(U.admin, [decide(U.admin, "declined")])).toBe(true);
        expect(await commit(U.owner, [decide(U.owner, "declined")])).toBe(false);
      });

      it("the editor who made a share decides the requests on it", async () => {
        const [sharePath, shareData] = share("view", { createdBy: U.editor });
        const [seeded, data] = openTimeRequest(SHARE.view);
        await h.reset({ ...world(), [sharePath]: shareData, [seeded]: data });
        expect(await commit(U.editor, [decide(U.editor, "declined")])).toBe(true);
      });

      it("are granted only together with an extension of the share, to the end they record", async () => {
        const [seeded, data] = openTimeRequest(SHARE.view);
        await h.reset({ ...world(), [seeded]: data });
        expect(await commit(U.owner, [decide(U.owner, "granted", { grantedUntil: later })])).toBe(false);
        expect(await commit(U.owner, [extend(later), decide(U.owner, "granted", { grantedUntil: new Date(later.getTime() + DAY_MS) })])).toBe(false);
        expect(await commit(U.owner, [extend(new Date(Date.now() + DAY_MS)), decide(U.owner, "granted", { grantedUntil: new Date(Date.now() + DAY_MS) })])).toBe(false);
        expect(await commit(U.outsider, [extend(later), decide(U.outsider, "granted", { grantedUntil: later })])).toBe(false);
        expect(await commit(U.owner, [extend(later), decide(U.owner, "granted", { grantedUntil: later })])).toBe(true);
        expect(await commit(U.owner, [decide(U.owner, "declined")])).toBe(false);
      });

      it("an ended share is granted by extending it into the future", async () => {
        const [seeded, data] = openTimeRequest(SHARE.expired);
        await h.reset({ ...world(), [seeded]: data });
        const expiredPath = `shares/${SHARE.expired}/timeRequests/${B}`;
        const grant = (until: Date): Write => ({
          op: "update", path: expiredPath, data: { status: "granted", decidedBy: U.owner, decidedAt: SERVER_TIME, grantedUntil: until },
        });
        const stillPast = new Date(PAST.getTime() + 60_000);
        expect(await commit(U.owner, [extend(stillPast, SHARE.expired), grant(stillPast)])).toBe(false);
        expect(await commit(U.owner, [extend(later, SHARE.expired), grant(later)])).toBe(true);
      });
    });

    describe("activity log", () => {
      const entry = (uid: string): Write => ({
        op: "set", path: `teams/${A}/activity/new-${uid}`, data: { at: SERVER_TIME, by: uid, kind: "member.join" },
      });

      it("is read by owners and admins only", async () => {
        expect(await list(U.owner, { collection: `teams/${A}/activity` })).toBe(true);
        expect(await list(U.admin, { collection: `teams/${A}/activity` })).toBe(true);
        for (const uid of [U.editor, U.viewer, U.pending, U.removed, U.outsider]) {
          expect(await list(uid, { collection: `teams/${A}/activity` }), uid).toBe(false);
        }
      });

      it("is appended to by active members, and never changed", async () => {
        expect(await commit(U.viewer, [entry(U.viewer)])).toBe(true);
        expect(await commit(U.pending, [entry(U.pending)])).toBe(false);
        expect(await commit(U.removed, [entry(U.removed)])).toBe(false);
        expect(await commit(U.outsider, [entry(U.outsider)])).toBe(false);
        expect(await commit(U.viewer, [{ ...entry(U.viewer), data: { at: SERVER_TIME, by: U.owner, kind: "member.join" } } as Write])).toBe(false);
        expect(await commit(U.owner, [{ op: "update", path: `teams/${A}/activity/entry1`, data: { kind: "x" } }])).toBe(false);
        expect(await commit(U.owner, [{ op: "delete", path: `teams/${A}/activity/entry1` }])).toBe(false);
      });

      it("takes from a member who is not active only their own joining or leaving, in the same write", async () => {
        const note = (uid: string, kind: string, target: string = uid): Write => ({
          op: "set", path: `teams/${A}/activity/note-${uid}-${kind}`, data: { at: SERVER_TIME, by: uid, kind, target },
        });
        // Asking to join, as redeeming an invite writes it.
        expect(await commit(U.newcomer, [...joinWrites(U.newcomer, INVITE.live, "pending", "editor", 1), note(U.newcomer, "member.join")])).toBe(true);
        // Once waiting, nothing more, not even joining again.
        expect(await commit(U.newcomer, [note(U.newcomer, "member.join")])).toBe(false);
        expect(await commit(U.pending, [note(U.pending, "invite.create")])).toBe(false);
        // Leaving, in the write that removes their own membership, and only in their own name.
        const leave: Write = { op: "delete", path: `teams/${A}/members/${U.pending}` };
        expect(await commit(U.pending, [note(U.pending, "member.leave", U.owner), leave])).toBe(false);
        expect(await commit(U.pending, [note(U.pending, "member.leave")])).toBe(false);
        expect(await commit(U.pending, [note(U.pending, "member.leave"), leave])).toBe(true);
        // Joining at once by an invite that approves automatically makes an active member.
        expect(await commit(U.third, [
          ...joinWrites(U.third, INVITE.auto, "viewer", "viewer", 1), note(U.third, "member.join"),
        ])).toBe(true);
      });

      it("caps what an entry's target and detail hold", async () => {
        const sized = (target: number, detail: number): Write => ({
          op: "set",
          path: `teams/${A}/activity/sized-${String(target)}-${String(detail)}`,
          data: { at: SERVER_TIME, by: U.viewer, kind: "share.create", target: "t".repeat(target), detail: "d".repeat(detail) },
        });
        expect(await commit(U.viewer, [sized(128, 600)])).toBe(true);
        expect(await commit(U.viewer, [sized(129, 1)])).toBe(false);
        expect(await commit(U.viewer, [sized(1, 601)])).toBe(false);
        expect(await commit(U.viewer, [{ ...sized(1, 1), data: { at: SERVER_TIME, by: U.viewer, kind: "k".repeat(65) } } as Write])).toBe(false);
      });
    });

    describe("teams, settings and verification", () => {
      it("team documents are read by id by anyone signed in, and never listed", async () => {
        expect(await get(U.newcomer, `teams/${A}`)).toBe(true);
        expect(await get(null, `teams/${A}`)).toBe(false);
        expect(await list(U.owner, { collection: "teams" })).toBe(false);
      });

      it("settings are read by active members and written by owners and admins", async () => {
        expect(await get(U.viewer, `teams/${A}/settings/sharing`)).toBe(true);
        for (const uid of [U.pending, U.removed, U.outsider]) {
          expect(await get(uid, `teams/${A}/settings/sharing`), uid).toBe(false);
        }
        expect(await commit(U.editor, [{ op: "set", path: `teams/${A}/settings/sharing`, data: { publishOnSave: true } }])).toBe(false);
        expect(await commit(U.owner, [{ op: "set", path: `teams/${A}/settings/sharing`, data: { publishOnSave: true } }])).toBe(true);
      });

      it("only a Horizon admin can set a team's status, and a claim's only with a decision", async () => {
        expect(await commit(U.owner, [{ op: "update", path: `teams/${A}`, data: { status: "verified" } }])).toBe(false);
        expect(await commit(U.owner, [{ op: "update", path: "claims/36596", data: { status: "verified" } }])).toBe(false);
        expect(await commit(U.horizon, [{ op: "update", path: `teams/${A}`, data: { status: "verified" } }])).toBe(true);
        // A claim changes only with an entry in its history tied to a decision record (M-C7 below).
        expect(await commit(U.horizon, [{ op: "update", path: "claims/36596", data: { status: "verified" } }])).toBe(false);
      });

      // Owner ruling 2026-10-01: no Horizon-admin action needs two people, so a Horizon admin who is a
      // member of the team still sets its status. A member who is not a Horizon admin still cannot.
      it("a Horizon admin who is a member of a team, of any role, may set that team's status", async () => {
        for (const role of ["viewer", "pending", "owner"]) {
          await h.reset({ ...world(), [`teams/${A}/members/${U.horizon}`]: member(A, U.horizon, role) });
          expect(await commit(U.horizon, [{ op: "update", path: `teams/${A}`, data: { status: "verified" } }]), role).toBe(true);
          expect(await commit(U.horizon, [{ op: "update", path: `teams/${B}`, data: { status: "unverified" } }]), role).toBe(true);
        }
        await h.reset(world());
        expect(await commit(U.owner, [{ op: "update", path: `teams/${A}`, data: { status: "verified" } }])).toBe(false);
      });

      it("renames by owners and admins only, and never changes the number that way", async () => {
        expect(await commit(U.editor, [{ op: "update", path: `teams/${A}`, data: { name: "Renamed" } }])).toBe(false);
        expect(await commit(U.admin, [{ op: "update", path: `teams/${A}`, data: { name: "Renamed" } }])).toBe(true);
        expect(await commit(U.admin, [{ op: "update", path: `teams/${A}`, data: { number: 99999 } }])).toBe(false);
      });

      it("a second team cannot take a claimed number", async () => {
        const T = "teamNewNNNNNNNNNNNNNNN";
        const create = (teamNumber: number): Write[] => [
          {
            op: "set",
            path: `teams/${T}`,
            data: { number: teamNumber, name: "Copycat", status: "unverified", createdBy: U.newcomer, createdAt: SERVER_TIME, encKey: encKey(NEW_SEED) },
          },
          { op: "set", path: `teams/${T}/members/${U.newcomer}`, data: { uid: U.newcomer, teamId: T, role: "owner", displayName: "nina", joinedAt: SERVER_TIME } },
          { op: "set", path: `claims/${String(teamNumber)}`, data: { teamId: T, status: "unverified", claimedAt: SERVER_TIME, historyCount: 1 } },
          stepWrite(teamNumber, 0, claimEntry("claim", T, U.newcomer)),
          ...keyFoundingWrites(U.newcomer, T),
        ];
        expect(await commit(U.newcomer, create(36596))).toBe(false);
        expect(await commit(U.newcomer, create(12345))).toBe(false);
        expect((await h.peek("claims/36596"))?.teamId).toBe(A);
        expect(await commit(U.newcomer, create(424242))).toBe(true);
        expect((await h.peek(`teams/${T}/members/${U.newcomer}`))?.role).toBe("owner");
      });

      it("a team can only be founded by a user with a profile", async () => {
        const T = "teamNoProfileNNNNNNNNN";
        const writes: Write[] = [
          { op: "set", path: `teams/${T}`, data: { number: null, name: "Young", status: "unverified", createdBy: "kid", createdAt: SERVER_TIME, encKey: encKey(NEW_SEED) } },
          { op: "set", path: `teams/${T}/members/kid`, data: { uid: "kid", teamId: T, role: "owner", displayName: "kid", joinedAt: SERVER_TIME } },
          ...keyFoundingWrites("kid", T, { withDevice: true }),
        ];
        expect(await commit("kid", writes)).toBe(false);
      });

      it("admins are written only by Horizon admins, and a team role is not one", async () => {
        expect(await commit(U.owner, [{ op: "set", path: `admins/${U.owner}`, data: { name: "x" } }])).toBe(false);
        expect(await commit(U.admin, [{ op: "set", path: `admins/${U.admin}`, data: { name: "x" } }])).toBe(false);
        expect(await get(U.owner, `admins/${U.horizon}`)).toBe(false);
        expect(await get(U.horizon, `admins/${U.horizon}`)).toBe(true);
        expect(await commit(U.horizon, [{ op: "set", path: `admins/${U.owner}`, data: { name: "Alice" } }])).toBe(true);
      });
    });

    describe("verification, claims and disputes (M-C7)", () => {
      beforeEach(async () => {
        await h.reset(verificationWorld());
      });

      describe("requests for verification", () => {
        it("are made by the holder's owners and admins with evidence, and by nobody else", async () => {
          expect(await commit(U.admin, requestWrites(U.admin, REQ.fresh))).toBe(true);
          expect((await h.peek("claims/36596"))?.requestId).toBe(REQ.fresh);
          await h.reset(verificationWorld());
          expect(await commit(U.editor, requestWrites(U.editor, REQ.fresh))).toBe(false);
          expect(await commit(U.viewer, requestWrites(U.viewer, REQ.fresh))).toBe(false);
          expect(await commit(U.outsider, requestWrites(U.outsider, REQ.fresh))).toBe(false);
          expect(await commit(U.horizon, requestWrites(U.horizon, REQ.fresh))).toBe(false);
          // Both halves of the write, or neither.
          expect(await commit(U.owner, requestWrites(U.owner, REQ.fresh).slice(0, 1))).toBe(false);
          expect(await commit(U.owner, requestWrites(U.owner, REQ.fresh).slice(1))).toBe(false);
          expect(await commit(U.owner, requestWrites(U.owner, REQ.fresh))).toBe(true);
        });

        it("need one to six valid pieces of evidence, a photo or event with an https address", async () => {
          const row = (over: DocData) => ({ kind: "statement", summary: "We are 36596.", by: U.owner, at: new Date(), ...over });
          expect(await commit(U.owner, requestWrites(U.owner, REQ.fresh, { evidence: [] }))).toBe(false);
          expect(await commit(U.owner, requestWrites(U.owner, REQ.fresh, { evidence: Array.from({ length: 7 }, () => row({})) }))).toBe(false);
          expect(await commit(U.owner, requestWrites(U.owner, REQ.fresh, { evidence: [row({ kind: "photo" })] }))).toBe(false);
          expect(await commit(U.owner, requestWrites(U.owner, REQ.fresh, { evidence: [row({ kind: "photo", url: "http://example.org/a.jpg" })] }))).toBe(false);
          expect(await commit(U.owner, requestWrites(U.owner, REQ.fresh, { evidence: [row({ kind: "rumour" })] }))).toBe(false);
          expect(await commit(U.owner, requestWrites(U.owner, REQ.fresh, { evidence: [row({ by: U.admin })] }))).toBe(false);
          expect(await commit(U.owner, requestWrites(U.owner, REQ.fresh, { evidence: [row({ summary: "" })] }))).toBe(false);
          expect(await commit(U.owner, requestWrites(U.owner, REQ.fresh, { evidence: [row({ fileRef: "x" })] }))).toBe(false);
          expect(await commit(U.owner, requestWrites(U.owner, REQ.fresh, {
            evidence: Array.from({ length: 6 }, (_, i) => row({ kind: "photo", url: `https://example.org/${String(i)}.jpg` })),
          }))).toBe(true);
        });

        it("are refused while one is open, and on a verified or contested number", async () => {
          expect(await commit(U.owner, requestWrites(U.owner, REQ.fresh))).toBe(true);
          expect(await commit(U.owner, requestWrites(U.owner, "requestSecondXXXXXXXXX", {}, 2))).toBe(false);
          expect(await commit(U.outsider, requestWrites(U.outsider, REQ.fresh, { teamId: B, teamNumber: 12345 }))).toBe(false);
          expect(await commit(V.dora, requestWrites(V.dora, REQ.fresh, { teamId: D, teamNumber: 55555 }))).toBe(false);
        });

        it("are read by the team's active members and Horizon admins, and nobody else", async () => {
          await h.reset(verificationWorld({ openRequest: true }));
          const path = `verifications/${REQ.open}`;
          expect(await get(U.viewer, path)).toBe(true);
          expect(await get(U.horizon, path)).toBe(true);
          for (const uid of [U.pending, U.outsider, U.third, U.newcomer, null]) expect(await get(uid, path), String(uid)).toBe(false);
          expect(await list(U.viewer, { collection: "verifications", where: [{ field: "teamId", value: A }] })).toBe(true);
          expect(await list(U.outsider, { collection: "verifications", where: [{ field: "teamId", value: A }] })).toBe(false);
          expect(await list(U.owner, { collection: "verifications", where: [{ field: "status", value: "open" }] })).toBe(false);
          expect(await list(U.horizon, { collection: "verifications", where: [{ field: "status", value: "open" }] })).toBe(true);
        });

        it("are decided only by a Horizon admin, with a one-sentence reason, together with the claim", async () => {
          await h.reset(verificationWorld({ openRequest: true }));
          expect(await commit(U.owner, verifyWrites(U.owner, "verified"))).toBe(false);
          expect(await commit(U.horizon, verifyWrites(U.horizon, "verified", { reason: "No full stop" }))).toBe(false);
          expect(await commit(U.horizon, verifyWrites(U.horizon, "verified", { reason: "Line one.\nLine two." }))).toBe(false);
          expect(await commit(U.horizon, verifyWrites(U.horizon, "verified").slice(1))).toBe(false);
          expect(await commit(U.horizon, verifyWrites(U.horizon, "verified").slice(0, 1))).toBe(true);
          await h.reset(verificationWorld({ openRequest: true }));
          expect(await commit(U.horizon, verifyWrites(U.horizon, "verified"))).toBe(true);
          expect(await h.peek("claims/36596")).toMatchObject({ status: "verified", requestId: null });
          expect((await h.peek(`teams/${A}`))?.status).toBe("verified");
          // Decided once.
          expect(await commit(V.hugo, verifyWrites(V.hugo, "declined").slice(0, 1))).toBe(false);
        });

        it("may be decided by a Horizon admin who is a member of the team, and record who decided", async () => {
          for (const role of ["pending", "owner"]) {
            const docs = verificationWorld({ openRequest: true });
            docs[`teams/${A}/members/${U.horizon}`] = member(A, U.horizon, role);
            await h.reset(docs);
            expect(await commit(U.horizon, verifyWrites(U.horizon, "verified")), role).toBe(true);
            expect((await h.peek(`verifications/${REQ.open}`))?.decision, role).toMatchObject({ by: U.horizon });
          }
          // A member of the team who is not a Horizon admin still cannot decide it.
          await h.reset(verificationWorld({ openRequest: true }));
          expect(await commit(U.owner, verifyWrites(U.owner, "verified"))).toBe(false);
        });

        it("declined leaves the number unverified and lets the team ask again", async () => {
          await h.reset(verificationWorld({ openRequest: true }));
          expect(await commit(U.horizon, verifyWrites(U.horizon, "declined", { status: "unverified" }))).toBe(true);
          expect(await h.peek("claims/36596")).toMatchObject({ status: "unverified", requestId: null });
          // A decline cannot also verify.
          await h.reset(verificationWorld({ openRequest: true }));
          expect(await commit(U.horizon, verifyWrites(U.horizon, "declined", { status: "verified" }))).toBe(false);
        });
      });

      describe("claiming a number", () => {
        it("refuses a second claim on a verified number, and lets the team ask for a review instead", async () => {
          const T = E;
          expect(await commit(V.ed, [
            { op: "update", path: `teams/${T}`, data: { number: 12345 } },
            { op: "set", path: "claims/12345", data: { teamId: T, status: "unverified", claimedAt: SERVER_TIME, historyCount: 1 } },
            stepWrite(12345, 0, claimEntry("claim", T, V.ed)),
          ])).toBe(false);
          expect(await commit(V.ed, contestWrites(V.ed, 12345, B, { status: "contested" }))).toBe(false);
          expect(await commit(V.ed, contestWrites(V.ed, 12345, B, { status: "verified" }))).toBe(true);
          expect((await h.peek("claims/12345"))?.status).toBe("verified");
        });

        it("contests an unverified number: the claim, its holder and the challenger all become contested", async () => {
          expect(await commit(V.ed, contestWrites(V.ed, 36596, A, { status: "unverified" }))).toBe(false);
          expect(await commit(V.ed, contestWrites(V.ed, 36596, A, { status: "contested" }).slice(0, 3))).toBe(true);
          await h.reset(verificationWorld());
          expect(await commit(V.ed, contestWrites(V.ed, 36596, A, { status: "contested" }))).toBe(true);
          expect((await h.peek("claims/36596"))?.status).toBe("contested");
          expect((await h.peek(`teams/${A}`))?.status).toBe("contested");
          expect((await h.peek(`teams/${E}`))?.status).toBe("contested");
        });

        it("refuses a contest from a team that has a number, from a non-admin, or with a review already open", async () => {
          expect(await commit(U.outsider, contestWrites(U.outsider, 36596, A, { status: "contested", challenger: B }))).toBe(false);
          expect(await commit(U.third, contestWrites(U.third, 36596, A, { status: "contested", challenger: C }))).toBe(false);
          expect(await commit(V.tara, contestWrites(V.tara, 36596, A, { status: "contested", challenger: C }))).toBe(true);
          expect(await commit(V.ed, contestWrites(V.ed, 55555, D, { status: "contested", disputeId: "disputeSecondXXXXXXXXX" }).slice(0, 3))).toBe(false);
        });

        it("lets nobody but the contest itself mark a holder contested, nor a challenger but in the write that opens its review", async () => {
          expect(await commit(V.ed, [{ op: "update", path: `teams/${A}`, data: { status: "contested" } }])).toBe(false);
          expect(await commit(U.owner, [{ op: "update", path: `teams/${A}`, data: { status: "contested" } }])).toBe(false);
          // A team with no number is contested only in the write that opens its review (spec 13 section
          // 4.4), by its own owners and admins, who alone may open it.
          const challenge = contestWrites(V.ed, 36596, A, { status: "contested" });
          const label = (w: Write) => w.path === `teams/${E}`;
          expect(await commit(V.ed, [{ op: "update", path: `teams/${E}`, data: { status: "contested" } }])).toBe(false);
          expect(await commit(V.ed, [{ op: "update", path: `teams/${E}`, data: { status: "contested", disputeId: DISPUTE.open } }])).toBe(false);
          expect(await commit(V.ed, [{ op: "update", path: `teams/${E}`, data: { status: "contested", disputeId: "disputeFreshXXXXXXXXXX" } }])).toBe(false);
          expect(await commit(V.dora, [{ op: "update", path: `teams/${E}`, data: { status: "contested", disputeId: "disputeFreshXXXXXXXXXX" } }])).toBe(false);
          expect(await commit(V.ed, [{ op: "update", path: `teams/${E}`, data: { status: "verified" } }])).toBe(false);
          // A review of a verified number labels neither team.
          const ofVerified = contestWrites(V.ed, 12345, B, { status: "verified" });
          expect(await commit(V.ed, [...ofVerified, { op: "update", path: `teams/${E}`, data: { status: "contested", disputeId: "disputeFreshXXXXXXXXXX" } }])).toBe(false);
          expect(await commit(V.ed, challenge.filter((w) => !label(w)))).toBe(true);
          await h.reset(verificationWorld());
          expect(await commit(V.ed, challenge)).toBe(true);
          expect(await h.peek(`teams/${E}`)).toMatchObject({ status: "contested", disputeId: "disputeFreshXXXXXXXXXX" });
        });
      });

      describe("a claim's history", () => {
        it("is read by the teams each step involves and by Horizon admins; the claim itself by anyone signed in", async () => {
          for (const uid of [U.newcomer, U.third, V.tara]) expect(await get(uid, "claims/55555"), uid).toBe(true);
          expect(await get(null, "claims/55555")).toBe(false);
          const contest = "claims/55555/history/1";
          expect(await get(V.dora, contest)).toBe(true);
          expect(await get(V.ed, contest)).toBe(true);
          expect(await get(U.horizon, contest)).toBe(true);
          for (const uid of [V.tara, U.third, U.outsider, U.owner, U.newcomer, null]) expect(await get(uid, contest), String(uid)).toBe(false);
          // The claim step names only the holder, so the challenger does not read it.
          expect(await get(V.dora, "claims/55555/history/0")).toBe(true);
          expect(await get(V.ed, "claims/55555/history/0")).toBe(false);
          // A decision and its reason: the winner and the team that lost.
          expect(await get(V.fay, "claims/44444/history/2")).toBe(true);
          expect(await get(V.gus, "claims/44444/history/2")).toBe(true);
          expect(await get(V.tara, "claims/44444/history/2")).toBe(false);
        });

        it("is listed only filtered on a team the caller is active in, or by a Horizon admin", async () => {
          const history = "claims/55555/history";
          expect(await list(V.ed, { collection: history, where: [{ field: "teamId", value: E }] })).toBe(true);
          expect(await list(V.dora, { collection: history, where: [{ field: "otherTeamId", value: D }] })).toBe(true);
          expect(await list(V.dora, { collection: history, where: [{ field: "teamId", value: D }] })).toBe(true);
          expect(await list(V.tara, { collection: history, where: [{ field: "teamId", value: D }] })).toBe(false);
          expect(await list(V.tara, { collection: history, where: [{ field: "teamId", value: C }] })).toBe(true); // proves only C's steps, of which there are none
          expect(await list(V.dora, { collection: history })).toBe(false);
          expect(await list(U.newcomer, { collection: history })).toBe(false);
          expect(await list(U.horizon, { collection: history })).toBe(true);
          expect(await list(null, { collection: history, where: [{ field: "teamId", value: D }] })).toBe(false);
        });

        it("takes a step only with the claim moving on to it, by the caller, and never changes one", async () => {
          const contest = contestWrites(V.ed, 36596, A, { status: "contested" });
          // The step alone, or the claim alone.
          expect(await commit(V.ed, contest.filter((w) => !w.path.startsWith("claims/36596/history")))).toBe(false);
          expect(await commit(V.ed, contest.filter((w) => w.path !== "claims/36596"))).toBe(false);
          // A step in another team's name, a step that hides the holder, a step at the wrong index.
          const forged = (change: (w: Write) => Write) => contest.map((w) => (w.path === "claims/36596/history/1" ? change(w) : w));
          const withData = (data: DocData) => (w: Write): Write => ({ ...w, data: { ...(w as { data: DocData }).data, ...data } }) as Write;
          expect(await commit(V.ed, forged(withData({ by: V.dora })))).toBe(false);
          expect(await commit(V.ed, forged(withData({ otherTeamId: C })))).toBe(false);
          expect(await commit(V.ed, forged(withData({ otherTeamId: null })))).toBe(false);
          expect(await commit(V.ed, forged((w) => ({ ...w, path: "claims/36596/history/2" })))).toBe(false);
          expect(await commit(V.ed, contest)).toBe(true);
          expect((await h.peek("claims/36596"))?.historyCount).toBe(2);
          expect((await h.peek("claims/36596/history/1"))?.otherTeamId).toBe(A);
          // Never changed or deleted, by the team or by a reviewer.
          expect(await commit(V.dora, [{ op: "update", path: "claims/55555/history/1", data: { note: "Edited." } }])).toBe(false);
          expect(await commit(U.horizon, [{ op: "update", path: "claims/55555/history/1", data: { note: "Edited." } }])).toBe(false);
          expect(await commit(V.dora, [{ op: "delete", path: "claims/55555/history/1" }])).toBe(false);
        });

        it("keeps a claim with history from its team's owner, who may drop only a claim with nothing but itself", async () => {
          const drop = (teamNumber: number): Write[] => [
            { op: "delete", path: `claims/${String(teamNumber)}` },
            { op: "delete", path: `claims/${String(teamNumber)}/history/0` },
          ];
          expect(await commit(V.fay, drop(44444))).toBe(false);
          expect(await commit(V.fay, [{ op: "delete", path: "claims/44444" }])).toBe(false);
          expect(await commit(V.dora, drop(55555))).toBe(false);
          expect(await commit(U.admin, drop(36596))).toBe(false);
          expect(await commit(U.owner, [{ op: "delete", path: "claims/36596" }])).toBe(false);
          expect(await commit(U.owner, [{ op: "delete", path: "claims/36596/history/0" }])).toBe(false);
          expect(await commit(U.owner, drop(36596))).toBe(true);
          expect(await h.peek("claims/36596")).toBeNull();
          expect(await h.peek("claims/36596/history/0")).toBeNull();
        });
      });

      describe("disputes", () => {
        it("are read by both teams and Horizon admins, and never by a third team", async () => {
          const path = `disputes/${DISPUTE.open}`;
          expect(await get(V.dora, path)).toBe(true);
          expect(await get(V.ed, path)).toBe(true);
          expect(await get(U.horizon, path)).toBe(true);
          for (const uid of [U.third, V.tara, U.outsider, U.owner, U.newcomer, null]) expect(await get(uid, path), String(uid)).toBe(false);
          expect(await list(V.ed, { collection: "disputes", where: [{ field: "challengerTeamId", value: E }] })).toBe(true);
          expect(await list(V.dora, { collection: "disputes", where: [{ field: "holderTeamId", value: D }] })).toBe(true);
          expect(await list(V.tara, { collection: "disputes", where: [{ field: "holderTeamId", value: D }] })).toBe(false);
          expect(await list(V.ed, { collection: "disputes", where: [{ field: "status", value: "open" }] })).toBe(false);
          expect(await list(U.horizon, { collection: "disputes", where: [{ field: "status", value: "open" }] })).toBe(true);
        });

        it("take evidence from either team's owners and admins while open, and from nobody else", async () => {
          const add = (uid: string, team: string, over: DocData = {}) => evidenceWrite(DISPUTE.open, [], uid, team, over);
          expect(await commit(V.ed, [add(V.ed, E)])).toBe(true);
          await h.reset(verificationWorld());
          expect(await commit(V.dora, [add(V.dora, D, { kind: "photo", url: "https://example.org/robot.jpg" })])).toBe(true);
          await h.reset(verificationWorld());
          expect(await commit(V.dora, [add(V.dora, D, { kind: "photo" })])).toBe(false);
          expect(await commit(V.dora, [add(V.dora, E)])).toBe(false);
          expect(await commit(V.tara, [add(V.tara, C)])).toBe(false);
          expect(await commit(U.horizon, [add(U.horizon, D)])).toBe(false);
          expect(await commit(V.fay, [evidenceWrite(DISPUTE.decided, [], V.fay, F)])).toBe(false);
        });

        it("are decided only by a Horizon admin, together with the claim", async () => {
          expect(await commit(V.dora, decideWrites(V.dora, D))).toBe(false);
          expect(await commit(U.horizon, decideWrites(U.horizon, E, { reason: "Two lines.\nNot one." }))).toBe(false);
          expect(await commit(U.horizon, decideWrites(U.horizon, C))).toBe(false);
          expect(await commit(U.horizon, decideWrites(U.horizon, E).slice(1))).toBe(false);
          expect(await commit(U.horizon, decideWrites(U.horizon, E))).toBe(true);
          expect(await h.peek("claims/55555")).toMatchObject({ teamId: E, status: "verified", disputeId: null });
          expect(await h.peek(`teams/${E}`)).toMatchObject({ number: 55555, status: "verified" });
          expect(await h.peek(`teams/${D}`)).toMatchObject({ number: null, status: "unverified" });
          expect(await commit(V.hugo, decideWrites(V.hugo, D).slice(0, 1))).toBe(false);
        });

        it("may be decided, and their appeal too, by a Horizon admin who is a member of either team", async () => {
          const docs = verificationWorld();
          docs[`teams/${D}/members/${U.horizon}`] = member(D, U.horizon, "viewer");
          await h.reset(docs);
          expect(await commit(U.horizon, decideWrites(U.horizon, D))).toBe(true);
          expect((await h.peek(`disputes/${DISPUTE.open}`))?.decision).toMatchObject({ winner: D, by: U.horizon });
          const appealed = verificationWorld({ appealed: true });
          appealed[`teams/${G}/members/${V.hugo}`] = member(G, V.hugo, "editor");
          await h.reset(appealed);
          expect(await commit(V.hugo, appealDecisionWrites(V.hugo, G))).toBe(true);
          expect((await h.peek(`disputes/${DISPUTE.decided}`))?.appealDecision).toMatchObject({ winner: G, by: V.hugo });
        });

        it("take one appeal, from the team that lost, within 14 days of the decision", async () => {
          expect(await commit(V.fay, appealWrites(V.fay, F))).toBe(false);
          expect(await commit(U.horizon, appealWrites(U.horizon, G))).toBe(false);
          expect(await commit(V.gus, appealWrites(V.gus, G).slice(0, 1))).toBe(true);
          expect(await commit(V.gus, appealWrites(V.gus, G).slice(0, 1))).toBe(false);
          await h.reset(verificationWorld());
          expect(await commit(V.gus, appealWrites(V.gus, G))).toBe(true);
          expect((await h.peek(`disputes/${DISPUTE.decided}`))?.status).toBe("appealed");
          await h.reset(verificationWorld({ decidedDaysAgo: 15 }));
          expect(await commit(V.gus, appealWrites(V.gus, G))).toBe(false);
        });

        // Owner ruling 2026-10-01: one Horizon admin may decide an appeal alone, the one who made the
        // first decision included. The record says who decided each time.
        it("take an appeal decision from the reviewer who made the first decision, and record it", async () => {
          await h.reset(verificationWorld({ appealed: true }));
          expect(await commit(U.horizon, appealDecisionWrites(U.horizon, G).slice(1))).toBe(false);
          expect(await commit(V.gus, appealDecisionWrites(V.gus, G))).toBe(false);
          expect(await commit(U.horizon, appealDecisionWrites(U.horizon, G))).toBe(true);
          expect(await h.peek(`disputes/${DISPUTE.decided}`)).toMatchObject({
            status: "final",
            decision: { by: U.horizon },
            appealDecision: { winner: G, by: U.horizon },
          });
          expect(await h.peek("claims/44444/history/4")).toMatchObject({ kind: "appeal-decision", by: U.horizon });
          expect(await h.peek("claims/44444")).toMatchObject({ teamId: G, status: "verified" });
          expect(await h.peek(`teams/${G}`)).toMatchObject({ number: 44444, status: "verified" });
          expect(await h.peek(`teams/${F}`)).toMatchObject({ number: null });
          // The appeal's decision is final.
          expect(await commit(V.hana2, appealDecisionWrites(V.hana2, F).slice(0, 1))).toBe(false);
        });

        it("and requests are never deleted", async () => {
          await h.reset(verificationWorld({ openRequest: true }));
          expect(await commit(U.horizon, [{ op: "delete", path: `disputes/${DISPUTE.open}` }])).toBe(false);
          expect(await commit(U.horizon, [{ op: "delete", path: `verifications/${REQ.open}` }])).toBe(false);
          expect(await commit(U.owner, [{ op: "delete", path: `verifications/${REQ.open}` }])).toBe(false);
        });
      });
    });

    // Deleting a team purges what it holds and marks its id as used for good, so nobody who learns the
    // id (a claim, a share or an invite names it) can found the team again and inherit what is left.
    describe("deleting a team", () => {
      const tombstone = `deletedTeams/${A}`;

      it("marks the team deleted only by its owner, as themselves, while it exists, and never changes the mark", async () => {
        for (const uid of [U.admin, U.editor, U.viewer, U.pending, U.outsider, U.newcomer]) {
          expect(await commit(uid, [tombstoneWrite(uid, A)]), uid).toBe(false);
        }
        expect(await commit(U.owner, [tombstoneWrite(U.admin, A)])).toBe(false);
        expect(await commit(U.owner, [tombstoneWrite(U.owner, A, { deletedAt: PAST })])).toBe(false);
        expect(await commit(U.owner, [tombstoneWrite(U.owner, A, { reason: "x" })])).toBe(false);
        expect(await commit(U.newcomer, [tombstoneWrite(U.newcomer, "teamGhostGGGGGGGGGGGGG")])).toBe(false);
        expect(await commit(U.owner, [tombstoneWrite(U.owner, A)])).toBe(true);
        expect(await commit(U.owner, [{ op: "update", path: tombstone, data: { deletedBy: U.admin } }])).toBe(false);
        expect(await commit(U.owner, [{ op: "delete", path: tombstone }])).toBe(false);
        expect(await commit(U.horizon, [{ op: "delete", path: tombstone }])).toBe(false);
        expect(await get(U.owner, tombstone)).toBe(true);
        expect(await get(U.horizon, tombstone)).toBe(true);
        for (const uid of [U.admin, U.viewer, U.outsider, U.newcomer, null]) expect(await get(uid, tombstone), String(uid)).toBe(false);
        expect(await list(U.owner, { collection: "deletedTeams" })).toBe(false);
        expect(await list(U.horizon, { collection: "deletedTeams" })).toBe(true);
      });

      it("lets the owner delete the library, the activity log and the invites only under the mark", async () => {
        const purge: Write[] = [
          { op: "delete", path: `teams/${A}/autos/${AUTO}/revisions/${R1}` },
          { op: "delete", path: `teams/${A}/autos/${AUTO}/revisions/${R2}` },
          { op: "delete", path: `teams/${A}/autos/${AUTO}` },
          { op: "delete", path: `teams/${A}/activity/entry1` },
          ...Object.values(INVITE).map((code): Write => ({ op: "delete", path: `invites/${code}` })),
        ];
        for (const write of purge) expect(await commit(U.owner, [write]), write.path).toBe(false);
        expect(await commit(U.owner, [tombstoneWrite(U.owner, A), ...purge])).toBe(true);
        expect(await h.peek(`teams/${A}/autos/${AUTO}/revisions/${R1}`)).toBeNull();
        expect(await h.peek(`invites/${INVITE.live}`)).toBeNull();

        await h.reset({ ...world(), [tombstone]: { deletedBy: U.owner, deletedAt: PAST } });
        for (const uid of [U.admin, U.editor, U.outsider, U.horizon]) {
          expect(await commit(uid, [{ op: "delete", path: `teams/${A}/autos/${AUTO}/revisions/${R1}` }]), uid).toBe(false);
          expect(await commit(uid, [{ op: "delete", path: `teams/${A}/activity/entry1` }]), uid).toBe(false);
          expect(await commit(uid, [{ op: "delete", path: `invites/${INVITE.live}` }]), uid).toBe(false);
          expect(await commit(uid, [{ op: "delete", path: `teams/${A}/autos/${AUTO}` }]), uid).toBe(false);
        }
        expect(await commit(U.owner, [{ op: "delete", path: `teams/${A}/autos/${AUTO}/revisions/${R1}` }])).toBe(true);
        // Another team's owner under their own mark still cannot touch this team.
        expect(await commit(U.outsider, [tombstoneWrite(U.outsider, B), { op: "delete", path: `invites/${INVITE.auto}` }])).toBe(false);
      });

      it("deletes as many documents in one write as a batch holds", async () => {
        const docs = world();
        for (let i = 0; i < 400; i += 1) docs[`teams/${A}/activity/bulk${String(i)}`] = { at: PAST, by: U.owner, kind: "auto.create" };
        await h.reset(docs);
        const writes: Write[] = [tombstoneWrite(U.owner, A)];
        for (let i = 0; i < 400; i += 1) writes.push({ op: "delete", path: `teams/${A}/activity/bulk${String(i)}` });
        expect(await commit(U.owner, writes)).toBe(true);
      });

      it("lets a Horizon admin list and remove a team's members only under its mark, so a share made to it stops opening for them", async () => {
        const members = `teams/${B}/members`;
        const removals = [U.outsider, U.outsiderEditor, U.outsiderViewer, U.outsiderPending].map((uid): Write => ({ op: "delete", path: `${members}/${uid}` }));
        expect(await get(U.outsiderEditor, `shares/${SHARE.view}`)).toBe(true);
        // Without the mark, a Horizon admin neither lists nor removes them.
        expect(await list(U.horizon, { collection: members })).toBe(false);
        for (const write of removals) expect(await commit(U.horizon, [write]), write.path).toBe(false);
        expect(await commit(U.horizon, [tombstoneWrite(U.horizon, B)])).toBe(true);
        expect(await list(U.horizon, { collection: members })).toBe(true);
        // The mark lets nobody else in: not another team's owner, not someone in no team.
        for (const uid of [U.owner, U.newcomer]) {
          expect(await list(uid, { collection: members }), uid).toBe(false);
          expect(await commit(uid, [{ op: "delete", path: `${members}/${U.outsiderEditor}` }]), uid).toBe(false);
        }
        expect(await commit(U.horizon, [...removals, { op: "delete", path: `teams/${B}` }])).toBe(true);
        expect(await h.peek(`${members}/${U.outsiderEditor}`)).toBeNull();
        for (const uid of [U.outsider, U.outsiderEditor, U.outsiderViewer]) {
          expect(await get(uid, `shares/${SHARE.view}`), uid).toBe(false);
          expect(await get(uid, `shares/${SHARE.propose}`), uid).toBe(false);
        }
      });

      it("deletes the team document only under the mark", async () => {
        const last: Write[] = [{ op: "delete", path: `teams/${A}` }, { op: "delete", path: `teams/${A}/members/${U.owner}` }];
        expect(await commit(U.owner, last)).toBe(false);
        expect(await commit(U.admin, [tombstoneWrite(U.admin, A), ...last])).toBe(false);
        expect(await commit(U.owner, [tombstoneWrite(U.owner, A), ...last])).toBe(true);
        expect(await h.peek(`teams/${A}`)).toBeNull();
      });

      it("never lets anyone found a team again under a deleted team's id, nor take its claim that way", async () => {
        await h.reset(worldWithoutTeamA({ [tombstone]: { deletedBy: U.owner, deletedAt: PAST } }));
        expect(await commit(U.newcomer, foundWrites(U.newcomer, A))).toBe(false);
        // The claim on 36596 still names A, which would otherwise pass for this write's own claim.
        expect(await commit(U.newcomer, foundWrites(U.newcomer, A, 36596))).toBe(false);
        expect(await h.peek(`teams/${A}`)).toBeNull();
        expect(await commit(U.newcomer, foundWrites(U.newcomer, "teamFreshFFFFFFFFFFFFF"))).toBe(true);
      });

      it("adds nobody by an invite of a team that is gone or being deleted", async () => {
        await h.reset(worldWithoutTeamA());
        expect(await commit(U.newcomer, joinWrites(U.newcomer, INVITE.auto, "viewer", "viewer", 1))).toBe(false);
        expect(await commit(U.newcomer, joinWrites(U.newcomer, INVITE.live, "pending", "editor", 1))).toBe(false);
        await h.reset({ ...world(), [tombstone]: { deletedBy: U.owner, deletedAt: PAST } });
        expect(await commit(U.newcomer, joinWrites(U.newcomer, INVITE.auto, "viewer", "viewer", 1))).toBe(false);
        expect(await h.peek(`teams/${A}/members/${U.newcomer}`)).toBeNull();
      });

      it("gives members of a team that is gone nothing, even when their membership was left behind", async () => {
        await h.reset(worldWithoutTeamA());
        for (const uid of [U.owner, U.viewer]) {
          expect(await get(uid, `teams/${A}/autos/${AUTO}/revisions/${R2}`), uid).toBe(false);
          expect(await list(uid, { collection: `teams/${A}/autos` }), uid).toBe(false);
          expect(await list(uid, { collection: `teams/${A}/autos/${AUTO}/revisions` }), uid).toBe(false);
          expect(await list(uid, { collection: `teams/${A}/members` }), uid).toBe(false);
          expect(await get(uid, `teams/${A}/settings/sharing`), uid).toBe(false);
          expect(await get(uid, `shares/${SHARE.revoked}`), uid).toBe(false);
          expect(await list(uid, { collection: "shares", where: [{ field: "ownerTeamId", value: A }] }), uid).toBe(false);
          expect(await get(uid, "proposals/proposal1"), uid).toBe(false);
          expect(await list(uid, { collection: "proposals", where: [{ field: "ownerTeamId", value: A }] }), uid).toBe(false);
        }
        expect(await list(U.owner, { collection: `teams/${A}/activity` })).toBe(false);
        // The other team of the proposal still reads it.
        expect(await get(U.outsiderViewer, "proposals/proposal1")).toBe(true);
      });
    });

    describe("claims of a deleted team", () => {
      // Foxtrot holds 44444, verified after a decided dispute: three steps of history.
      const release = (uid: string, over: DocData = {}): Write[] => [
        { op: "update", path: "claims/44444", data: { teamId: null, status: "unverified", historyCount: 4, ...over } },
        stepWrite(44444, 3, claimEntry("release", F, uid)),
      ];
      const T = "teamAfterTTTTTTTTTTTTT";
      const reclaim = (uid: string): Write[] => [
        ...foundWrites(uid, T, 44444),
        { op: "update", path: "claims/44444", data: { teamId: T, status: "unverified", claimedAt: SERVER_TIME, historyCount: 5 } },
        stepWrite(44444, 4, claimEntry("claim", T, uid)),
      ];

      beforeEach(async () => {
        await h.reset(verificationWorld());
      });

      it("keeps a claim with history, detached from the team, only in the write that deletes it", async () => {
        expect(await commit(V.fay, release(V.fay))).toBe(false);
        expect(await commit(V.gus, [tombstoneWrite(V.gus, G), ...release(V.gus)])).toBe(false);
        expect(await commit(V.fay, [tombstoneWrite(V.fay, F), ...release(V.fay, { status: "verified" })])).toBe(false);
        expect(await commit(V.fay, [tombstoneWrite(V.fay, F), ...release(V.fay, { teamId: G })])).toBe(false);
        expect(await commit(V.fay, [tombstoneWrite(V.fay, F), ...release(V.fay)])).toBe(true);
        expect(await h.peek("claims/44444")).toMatchObject({ teamId: null, status: "unverified", historyCount: 4 });
        expect(await h.peek("claims/44444/history/2")).toMatchObject({ kind: "decision", teamId: F });
      });

      it("lets a new team claim a released number afresh, unverified, without reading its old history", async () => {
        expect(await commit(U.newcomer, reclaim(U.newcomer))).toBe(false);
        expect(await commit(V.fay, [tombstoneWrite(V.fay, F), ...release(V.fay)])).toBe(true);
        expect(await commit(U.newcomer, reclaim(U.newcomer).map((w) => (w.path === "claims/44444" ? { ...w, data: { ...(w as { data: DocData }).data, status: "verified" } } as Write : w)))).toBe(false);
        expect(await commit(U.newcomer, reclaim(U.newcomer))).toBe(true);
        expect(await h.peek("claims/44444")).toMatchObject({ teamId: T, status: "unverified", historyCount: 5 });
        expect(await get(U.newcomer, "claims/44444/history/4")).toBe(true);
        expect(await get(U.newcomer, "claims/44444/history/2")).toBe(false);
        expect(await get(U.horizon, "claims/44444/history/2")).toBe(true);
      });

      it("leaves a review of the number open for its reviewer, and nobody claims the number meanwhile", async () => {
        // Delta held 55555 under review by Echo. Deleting Delta keeps the review; Echo may still win it.
        const releaseDelta: Write[] = [
          tombstoneWrite(V.dora, D),
          { op: "update", path: "claims/55555", data: { teamId: null, historyCount: 3 } },
          stepWrite(55555, 2, claimEntry("release", D, V.dora)),
        ];
        expect(await commit(V.dora, releaseDelta)).toBe(true);
        expect(await h.peek("claims/55555")).toMatchObject({ teamId: null, status: "contested", disputeId: DISPUTE.open });
        const U2 = "teamUnderReviewUUUUUUU";
        expect(await commit(U.newcomer, [
          ...foundWrites(U.newcomer, U2, 55555),
          { op: "update", path: "claims/55555", data: { teamId: U2, status: "unverified", claimedAt: SERVER_TIME, historyCount: 4 } },
          stepWrite(55555, 3, claimEntry("claim", U2, U.newcomer)),
        ])).toBe(false);
      });
    });

    // Spec 13 section 13: a Horizon admin's access is used only for reviews and support, and logged.
    // ------------------------------------------------------------------ spec 14: keys and ciphertext

    describe("device records", () => {
      const mine = deviceOf(U.newcomer, 2);
      const path = `users/${U.newcomer}/devices/${mine}`;
      const record = (over: DocData = {}): Write => ({ op: "set", path, data: { ...deviceDoc(), createdAt: SERVER_TIME, ...over } });

      it("are read by id by anyone signed in, and listed only by their user", async () => {
        const owners = `users/${U.owner}/devices/${deviceOf(U.owner)}`;
        for (const uid of [U.owner, U.outsider, U.newcomer, U.horizon]) expect(await get(uid, owners), uid).toBe(true);
        expect(await get(null, owners)).toBe(false);
        expect(await list(U.owner, { collection: `users/${U.owner}/devices` })).toBe(true);
        for (const uid of [U.admin, U.horizon, null]) expect(await list(uid, { collection: `users/${U.owner}/devices` }), String(uid)).toBe(false);
      });

      it("are added by their user with two 91-byte keys and a 32-byte fingerprint, and never changed", async () => {
        expect(await commit(U.owner, [{ ...record(), path: `users/${U.newcomer}/devices/${mine}` }])).toBe(false);
        expect(await commit(U.newcomer, [record({ encSpki: bytes(90) })])).toBe(false);
        expect(await commit(U.newcomer, [record({ fingerprint: "a".repeat(32) })])).toBe(false);
        expect(await commit(U.newcomer, [record({ v: 2 })])).toBe(false);
        expect(await commit(U.newcomer, [record({ label: "laptop" })])).toBe(false);
        expect(await commit(U.newcomer, [{ ...record(), path: `users/${U.newcomer}/devices/short` }])).toBe(false);
        expect(await commit(U.newcomer, [record()])).toBe(true);
        expect(await commit(U.newcomer, [{ op: "update", path, data: { encSpki: bytes(91, 8) } }])).toBe(false);
        expect(await commit(U.owner, [{ op: "delete", path }])).toBe(false);
        expect(await commit(U.newcomer, [{ op: "delete", path }])).toBe(true);
      });
    });

    describe("a team's keys when it is founded", () => {
      const T = "teamKeyedKKKKKKKKKKKKK";
      const without = (drop: string): Write[] => foundWrites(U.newcomer, T).filter((w) => !w.path.endsWith(drop));
      const withTeam = (over: DocData): Write[] =>
        foundWrites(U.newcomer, T).map((w) => (w.path === `teams/${T}` ? ({ ...w, data: { ...(w as { data: DocData }).data, ...over } } as Write) : w));

      it("needs encKey, team key record 1, the recovery record and nothing else in the team document", async () => {
        expect(await commit(U.newcomer, without("/teamKeys/1"))).toBe(false);
        expect(await commit(U.newcomer, without("/recovery/current"))).toBe(false);
        expect(await commit(U.newcomer, withTeam({ encKey: undefined }).map((w) => w))).toBe(false);
        const { encKey: _drop, ...plain } = (foundWrites(U.newcomer, T)[0] as { data: DocData }).data;
        expect(await commit(U.newcomer, [{ op: "set", path: `teams/${T}`, data: plain }, ...foundWrites(U.newcomer, T).slice(1)])).toBe(false);
        expect(await commit(U.newcomer, foundWrites(U.newcomer, T))).toBe(true);
      });

      it("refuses a public key whose fingerprint is not its SHA-256, a first version other than 1, or a record of another key", async () => {
        expect(await commit(U.newcomer, withTeam({ encKey: { ...encKey(NEW_SEED), fingerprint: bytes(32) } }))).toBe(false);
        expect(await commit(U.newcomer, withTeam({ encKey: encKey(NEW_SEED, 2) }))).toBe(false);
        expect(await commit(U.newcomer, withTeam({ encKey: encKey(NEW_SEED + 1) }))).toBe(false);
        expect(await commit(U.newcomer, withTeam({ rotationPending: false }))).toBe(false);
      });

      it("needs a 91-byte signing key the key record repeats, and no signature at version 1", async () => {
        const key = encKey(NEW_SEED);
        expect(await commit(U.newcomer, withTeam({ encKey: { ...key, sig: bytes(64) } }))).toBe(false);
        expect(await commit(U.newcomer, withTeam({ encKey: { ...key, signSpki: bytes(90) } }))).toBe(false);
        expect(await commit(U.newcomer, withTeam({ encKey: { ...key, signSpki: bytes(91, 77) } }))).toBe(false);
        const { sig: _sig, ...unsigned } = key;
        expect(await commit(U.newcomer, withTeam({ encKey: unsigned }))).toBe(false);
        expect(await commit(U.newcomer, withTeam({ encKey: { ...key, note: "x" } }))).toBe(false);
        expect(await commit(U.newcomer, withTeam({}))).toBe(true);
      });

      it("lets only the founder write key 1, and only in the founding batch; a new recovery record is the owner's alone", async () => {
        const keys = keyFoundingWrites(U.owner, A);
        const recovery = keys.find((w) => w.path.endsWith("/recovery/current"));
        for (const write of keys.filter((w) => w !== recovery)) expect(await commit(U.owner, [write]), write.path).toBe(false);
        // A new recovery code replaces the whole record, which only the owner may do, and it rotates the
        // key too, so a record of the same key version is refused even to the owner (security review M3).
        if (recovery === undefined) throw new Error("the founding writes have no recovery record");
        expect(await commit(U.admin, [recovery])).toBe(false);
        expect(await commit(U.owner, [recovery])).toBe(false);
        expect(await commit(U.newcomer, keyFoundingWrites(U.newcomer, T).slice(0, 1))).toBe(false);
        expect(await commit(U.newcomer, foundWrites(U.newcomer, T))).toBe(true);
      });
    });

    describe("team keys and the recovery record", () => {
      it("are listed by the team's active members only; a key record, public keys and ciphertext, is got by id by anyone signed in", async () => {
        for (const uid of [U.owner, U.admin, U.editor, U.viewer]) {
          expect(await get(uid, `teams/${A}/teamKeys/1`), uid).toBe(true);
          expect(await list(uid, { collection: `teams/${A}/teamKeys` }), uid).toBe(true);
          expect(await get(uid, `teams/${A}/recovery/current`), uid).toBe(true);
        }
        for (const uid of [U.pending, U.removed, U.outsider, U.horizon, null]) {
          expect(await list(uid, { collection: `teams/${A}/teamKeys` }), String(uid)).toBe(false);
          expect(await get(uid, `teams/${A}/recovery/current`), String(uid)).toBe(false);
        }
        // A partner team walks the signatures from the version it pinned, so it reads records by id.
        for (const uid of [U.pending, U.removed, U.outsider, U.horizon]) expect(await get(uid, `teams/${A}/teamKeys/1`), uid).toBe(true);
        expect(await get(null, `teams/${A}/teamKeys/1`)).toBe(false);
      });

      it("hold no creator and no time, since anyone signed in gets a key record by id", async () => {
        const T = "teamNoCreatorKKKKKKKKK";
        const withCreator = (over: DocData): Write[] =>
          foundWrites(U.newcomer, T).map((w) => (w.path.endsWith("/teamKeys/1") ? ({ ...w, data: { ...(w as { data: DocData }).data, ...over } } as Write) : w));
        expect(await commit(U.newcomer, withCreator({ createdBy: U.newcomer, createdAt: SERVER_TIME }))).toBe(false);
        expect(await commit(U.newcomer, withCreator({ createdBy: U.newcomer }))).toBe(false);
        expect(await commit(U.newcomer, withCreator({ createdAt: SERVER_TIME }))).toBe(false);
        expect(await commit(U.newcomer, withCreator({}))).toBe(true);
        const record = await h.peek(`teams/${T}/teamKeys/1`);
        expect(Object.keys(record ?? {}).sort()).toEqual(["kv", "pairPrivate", "pairSpki", "prev", "roster", "rosterSig", "sig", "signPrivate", "signSpki", "v"]);
      });

      it("hold a sealed device roster of their own version and its 64-byte signature", async () => {
        const T = "teamRosterShapeRRRRRRR";
        const withRecord = (over: DocData, drop: string | null = null): Write[] =>
          foundWrites(U.newcomer, T).map((w) => {
            if (!w.path.endsWith("/teamKeys/1")) return w;
            const data: DocData = { ...(w as { data: DocData }).data, ...over };
            if (drop !== null) delete data[drop];
            return { ...w, data } as Write;
          });
        expect(await commit(U.newcomer, withRecord({}, "roster"))).toBe(false);
        expect(await commit(U.newcomer, withRecord({}, "rosterSig"))).toBe(false);
        expect(await commit(U.newcomer, withRecord({ roster: env(2, 400) }))).toBe(false);
        expect(await commit(U.newcomer, withRecord({ roster: env(1, MAX_ROSTER_BYTES + 1) }))).toBe(false);
        expect(await commit(U.newcomer, withRecord({ roster: bytes(400) }))).toBe(false);
        expect(await commit(U.newcomer, withRecord({ rosterSig: bytes(63) }))).toBe(false);
        expect(await commit(U.newcomer, withRecord({ rosterSig: null }))).toBe(false);
        expect(await commit(U.newcomer, withRecord({ roster: env(1, MAX_ROSTER_BYTES) }))).toBe(true);
      });

      it("never change a team key record", async () => {
        expect(await commit(U.owner, [{ op: "update", path: `teams/${A}/teamKeys/1`, data: { pairPrivate: env(1, 154) } }])).toBe(false);
        expect(await commit(U.owner, [{ op: "delete", path: `teams/${A}/teamKeys/1` }])).toBe(false);
      });

      /** The rest of a rotation to key 2 by `uid`: the team's key, the new key record and every grant moved on. */
      const keyMovesOn = (uid: string): Write[] => [
        { op: "update", path: `teams/${A}`, data: { encKey: encKey(SEED.A, 2) } },
        { op: "set", path: `teams/${A}/teamKeys/2`, data: { v: 1, kv: 2, prev: sealedKey(2), pairPrivate: env(2, 154), ...recordKeys(SEED.A, 2) } },
        ...[U.owner, U.admin, U.editor, U.viewer].map((holder): Write => ({
          op: "update", path: `teams/${A}/keyGrants/${deviceOf(holder)}`,
          data: { kv: 2, wrap: keyWrap(), proof: sealedKey(2), approverDeviceId: deviceOf(uid), approverUid: uid, signature: bytes(64), updatedAt: SERVER_TIME },
        })),
      ];

      it("let only an owner make a new recovery code; an admin only moves the same one on", async () => {
        const replace = (uid: string, spki: Uint8Array, kv = 2): Write => ({
          op: "update", path: `teams/${A}/recovery/current`,
          data: { kv, spki, privateKey: env(1, 150), signSpki: bytes(91, 13), signPrivate: env(1, 150), teamKey: keyWrap(), check: sealedKey(kv), updatedBy: uid, updatedAt: SERVER_TIME },
        });
        expect(await commit(U.admin, [...keyMovesOn(U.admin), replace(U.admin, bytes(91, 11))])).toBe(false);
        expect(await commit(U.editor, [...keyMovesOn(U.editor), replace(U.editor, bytes(91, 11))])).toBe(false);
        expect(await commit(U.owner, [...keyMovesOn(U.owner), replace(U.owner, bytes(91, 11))])).toBe(true);
        // The record always holds the newest key.
        await h.reset(world());
        expect(await commit(U.owner, [replace(U.owner, bytes(91, 12))])).toBe(false);
      });

      it("change the recovery record only one key version up, so nobody puts a wrap of the same version in place of the real one", async () => {
        const sameVersion = (uid: string, over: DocData = {}): Write => ({
          op: "update", path: `teams/${A}/recovery/current`,
          data: { teamKey: keyWrap(), check: sealedKey(1), updatedBy: uid, updatedAt: SERVER_TIME, ...over },
        });
        expect(await commit(U.admin, [sameVersion(U.admin)])).toBe(false);
        expect(await commit(U.owner, [sameVersion(U.owner)])).toBe(false);
        expect(await commit(U.owner, [sameVersion(U.owner, { spki: bytes(91, 11) })])).toBe(false);
        expect(await commit(U.owner, [{ op: "set", path: `teams/${A}/recovery/current`, data: { v: 1, kv: 1, ...recoveryKeys(), teamKey: keyWrap(), check: sealedKey(1), updatedBy: U.owner, updatedAt: SERVER_TIME } }])).toBe(false);
        expect(await commit(U.admin, [...keyMovesOn(U.admin), sameVersion(U.admin, { kv: 2, check: sealedKey(2) })])).toBe(true);
      });

      it("keep the recovery signing pair, which an admin moving the record on may not change", async () => {
        const moveOn = (over: DocData): Write => ({
          op: "update", path: `teams/${A}/recovery/current`,
          data: { kv: 2, teamKey: keyWrap(), check: sealedKey(2), updatedBy: U.admin, updatedAt: SERVER_TIME, ...over },
        });
        expect(await commit(U.admin, [...keyMovesOn(U.admin), moveOn({ signSpki: bytes(91, 44) })])).toBe(false);
        expect(await commit(U.admin, [...keyMovesOn(U.admin), moveOn({ signPrivate: env(1, 150) })])).toBe(false);
        expect(await commit(U.admin, [...keyMovesOn(U.admin), moveOn({})])).toBe(true);
        const whole = (over: DocData): Write => ({
          op: "set", path: `teams/${A}/recovery/current`,
          data: { v: 1, kv: 2, ...recoveryKeys(), teamKey: keyWrap(), check: sealedKey(2), updatedBy: U.owner, updatedAt: SERVER_TIME, ...over },
        });
        for (const [name, over] of [["short signing key", { signSpki: bytes(90) }], ["wrong version", { signPrivate: env(2, 154) }], ["oversize", { signPrivate: env(1, MAX_PRIVATE_KEY_BYTES + 1) }]] as [string, DocData][]) {
          await h.reset(world());
          expect(await commit(U.owner, [...keyMovesOn(U.owner), whole(over)]), name).toBe(false);
        }
        await h.reset(world());
        const { signSpki: _signSpki, ...unsigned } = (whole({}) as { data: DocData }).data;
        expect(await commit(U.owner, [...keyMovesOn(U.owner), { ...whole({}), data: unsigned } as Write])).toBe(false);
        expect(await commit(U.owner, [...keyMovesOn(U.owner), whole({})])).toBe(true);
      });
    });

    describe("key grants", () => {
      const grantPath = (teamId: string, deviceId: string) => `teams/${teamId}/keyGrants/${deviceId}`;
      const grant = (teamId: string, uid: string, deviceId: string, approver: string, approverDeviceId: string, over: DocData = {}): Write => ({
        op: "set",
        path: grantPath(teamId, deviceId),
        data: { ...grantDoc(teamId, uid, deviceId, 1, approver, approverDeviceId), createdAt: SERVER_TIME, updatedAt: SERVER_TIME, ...over },
      });
      const newDevice = (uid: string, n: number): Write => ({
        op: "set", path: `users/${uid}/devices/${deviceOf(uid, n)}`, data: { ...deviceDoc(), createdAt: SERVER_TIME },
      });
      const approve = (uid: string, role: string): Write => ({ op: "update", path: `teams/${A}/members/${uid}`, data: { role } });

      it("are deleted by an admin only when the member goes, the key is marked pending, or it rotates, never wholesale", async () => {
        const del = (uid: string): Write => ({ op: "delete", path: grantPath(A, deviceOf(uid)) });
        const pending: Write = { op: "update", path: `teams/${A}`, data: { rotationPending: true } };
        // An admin may not delete grants of members who stay, one or all, with nothing else changing.
        expect(await commit(U.admin, [del(U.editor)])).toBe(false);
        expect(await commit(U.admin, [U.owner, U.editor, U.viewer].map(del))).toBe(false);
        // Nor the owners' grants while marking the key pending: only an owner deletes an owner's grant that way.
        expect(await commit(U.admin, [del(U.owner), pending])).toBe(false);
        expect(await commit(U.admin, [del(U.owner), del(U.editor), del(U.viewer), pending])).toBe(false);
        // A device taken off without a rotation, which marks the key pending.
        expect(await commit(U.admin, [del(U.editor), pending])).toBe(true);
        await h.reset(world());
        expect(await commit(U.owner, [del(U.admin), pending])).toBe(true);
        // A member removed in the same write.
        await h.reset(world());
        expect(await commit(U.admin, [del(U.viewer), { op: "delete", path: `teams/${A}/members/${U.viewer}` }])).toBe(true);
        // A member's own grant, as ever.
        expect(await commit(U.editor, [del(U.editor)])).toBe(true);
      });

      it("are read by their own member while active and by owners and admins, never by a removed member", async () => {
        expect(await get(U.viewer, grantPath(A, deviceOf(U.viewer)))).toBe(true);
        expect(await get(U.viewer, grantPath(A, deviceOf(U.owner)))).toBe(false);
        expect(await list(U.viewer, { collection: `teams/${A}/keyGrants`, where: [{ field: "uid", value: U.viewer }] })).toBe(true);
        expect(await list(U.viewer, { collection: `teams/${A}/keyGrants` })).toBe(false);
        for (const uid of [U.owner, U.admin]) expect(await list(uid, { collection: `teams/${A}/keyGrants` }), uid).toBe(true);
        expect(await get(U.removed, grantPath(A, deviceOf(U.removed)))).toBe(false);
        expect(await list(U.removed, { collection: `teams/${A}/keyGrants`, where: [{ field: "uid", value: U.removed }] })).toBe(false);
        for (const uid of [U.pending, U.outsider, U.horizon, null]) expect(await list(uid, { collection: `teams/${A}/keyGrants` }), String(uid)).toBe(false);
      });

      it("go to a new member from an owner's or admin's device in the Approve write, and not before", async () => {
        const device = deviceOf(U.pending);
        expect(await commit(U.admin, [grant(A, U.pending, device, U.admin, deviceOf(U.admin))])).toBe(false);
        expect(await commit(U.editor, [approve(U.pending, "editor"), grant(A, U.pending, device, U.editor, deviceOf(U.editor))])).toBe(false);
        expect(await commit(U.admin, [
          approve(U.pending, "editor"),
          grant(A, U.pending, device, U.admin, deviceOf(U.admin)),
          { op: "delete", path: `teams/${A}/keyRequests/${device}` },
        ])).toBe(true);
        expect(await get(U.pending, grantPath(A, device))).toBe(true);
      });

      it("name the caller as approver, from a device of the caller's that holds the newest key", async () => {
        const device = deviceOf(U.pending);
        // Another person's device, a device of the caller's with no grant, another approver uid.
        expect(await commit(U.admin, [approve(U.pending, "editor"), grant(A, U.pending, device, U.admin, deviceOf(U.owner))])).toBe(false);
        expect(await commit(U.admin, [approve(U.pending, "editor"), newDevice(U.admin, 2), grant(A, U.pending, device, U.admin, deviceOf(U.admin, 2))])).toBe(false);
        expect(await commit(U.admin, [approve(U.pending, "editor"), grant(A, U.pending, device, U.owner, deviceOf(U.owner))])).toBe(false);
      });

      it("hold the newest key version, for a device whose record exists, in the shape the app writes", async () => {
        const device = deviceOf(U.pending);
        const approved = (over: DocData) => commit(U.admin, [approve(U.pending, "editor"), grant(A, U.pending, device, U.admin, deviceOf(U.admin), over)]);
        expect(await approved({ kv: 2, proof: sealedKey(2) })).toBe(false);
        expect(await approved({ proof: sealedKey(2) })).toBe(false);
        expect(await approved({ wrap: { ...keyWrap(), ct: bytes(47) } })).toBe(false);
        expect(await approved({ signature: bytes(63) })).toBe(false);
        expect(await approved({ teamId: B })).toBe(false);
        expect(await approved({ note: "hi" })).toBe(false);
        expect(await commit(U.admin, [approve(U.pending, "editor"), grant(A, U.pending, deviceOf(U.pending, 7), U.admin, deviceOf(U.admin))])).toBe(false);
        expect(await approved({})).toBe(true);
      });

      it("carry at most an approval MAC of 32 bytes, for the key version the grant gives", async () => {
        const device = deviceOf(U.pending);
        const approved = (approval: unknown) => commit(U.admin, [approve(U.pending, "editor"), grant(A, U.pending, device, U.admin, deviceOf(U.admin), { approval })]);
        expect(await approved({ v: 1, kv: 2, mac: bytes(32) })).toBe(false);
        expect(await approved({ v: 1, kv: 1, mac: bytes(31) })).toBe(false);
        expect(await approved({ v: 2, kv: 1, mac: bytes(32) })).toBe(false);
        expect(await approved({ v: 1, kv: 1, mac: bytes(32), code: "7K2QXD-M9A1RT-4ZC8PW" })).toBe(false);
        expect(await approved("7K2QXD-M9A1RT-4ZC8PW")).toBe(false);
        expect(await approved({ v: 1, kv: 1, mac: bytes(32) })).toBe(true);
      });

      it("are never given by a device to itself while a rotation is pending, unless the same write rotates", async () => {
        const third = deviceOf(U.viewer, 3);
        expect(await commit(U.viewer, [{ op: "update", path: `teams/${A}`, data: { rotationPending: true } }])).toBe(true);
        // The recovery code on a new device, and a device re-signing its own grant, both wait for the rotation.
        expect(await commit(U.viewer, [newDevice(U.viewer, 3), grant(A, U.viewer, third, U.viewer, third)])).toBe(false);
        expect(await commit(U.admin, [{
          op: "update", path: grantPath(A, deviceOf(U.admin)),
          data: { wrap: keyWrap(), proof: sealedKey(1), approverDeviceId: deviceOf(U.admin), approverUid: U.admin, signature: bytes(64), updatedAt: SERVER_TIME },
        }])).toBe(false);
        // A grant from another device that holds the key is still made.
        expect(await commit(U.viewer, [newDevice(U.viewer, 2), grant(A, U.viewer, deviceOf(U.viewer, 2), U.viewer, deviceOf(U.viewer))])).toBe(true);
      });

      it("are never approved by a grant made in the same write: two new grants cannot name each other", async () => {
        // A device taken off while a rotation is pending (its grant is gone, its session still open)
        // adds a device record and two grants that approve each other.
        const revoked = deviceOf(U.viewer, 2);
        const other = deviceOf(U.viewer, 3);
        expect(await commit(U.viewer, [newDevice(U.viewer, 2)])).toBe(true);
        expect(await commit(U.viewer, [{ op: "update", path: `teams/${A}`, data: { rotationPending: true } }])).toBe(true);
        expect(await commit(U.viewer, [
          newDevice(U.viewer, 3),
          grant(A, U.viewer, revoked, U.viewer, other),
          grant(A, U.viewer, other, U.viewer, revoked),
        ])).toBe(false);
        // An active member whose device holds no grant, with no rotation pending, cannot either.
        const docs = world();
        delete docs[grantPath(A, deviceOf(U.editor))];
        await h.reset(docs);
        const first = deviceOf(U.editor, 2);
        const second = deviceOf(U.editor, 3);
        expect(await commit(U.editor, [
          newDevice(U.editor, 2),
          newDevice(U.editor, 3),
          grant(A, U.editor, first, U.editor, second),
          grant(A, U.editor, second, U.editor, first),
        ])).toBe(false);
      });

      it("go to a member's new device from another of their own devices, or from the device itself", async () => {
        const second = deviceOf(U.viewer, 2);
        const third = deviceOf(U.viewer, 3);
        expect(await commit(U.viewer, [newDevice(U.viewer, 2), grant(A, U.viewer, second, U.viewer, deviceOf(U.viewer))])).toBe(true);
        // A device of theirs that holds no grant does not approve another.
        expect(await commit(U.viewer, [newDevice(U.viewer, 3), newDevice(U.viewer, 4), grant(A, U.viewer, third, U.viewer, deviceOf(U.viewer, 4))])).toBe(false);
        // The device granting itself is how the recovery code is used, and only such a grant carries
        // the recovery key's 64-byte endorsement.
        expect(await commit(U.viewer, [newDevice(U.viewer, 3), grant(A, U.viewer, third, U.viewer, third, { recoverySig: bytes(63) })])).toBe(false);
        expect(await commit(U.viewer, [newDevice(U.viewer, 3), grant(A, U.viewer, third, U.viewer, third, { recoverySig: bytes(64) })])).toBe(true);
        expect(await commit(U.viewer, [newDevice(U.viewer, 5), grant(A, U.viewer, deviceOf(U.viewer, 5), U.viewer, deviceOf(U.viewer), { recoverySig: bytes(64) })])).toBe(false);
        // Nobody else's device, and not a teammate's.
        expect(await commit(U.editor, [newDevice(U.editor, 2), grant(A, U.viewer, deviceOf(U.editor, 2), U.editor, deviceOf(U.editor))])).toBe(false);
        expect(await commit(U.editor, [grant(A, U.viewer, deviceOf(U.viewer), U.editor, deviceOf(U.editor))])).toBe(false);
      });

      it("go from any active member to another's device only when the team allows it", async () => {
        const writes = [newDevice(U.viewer, 2), grant(A, U.viewer, deviceOf(U.viewer, 2), U.editor, deviceOf(U.editor))];
        // The new device is written by its own user; the grant by the editor.
        expect(await commit(U.viewer, [writes[0] as Write])).toBe(true);
        expect(await commit(U.editor, [writes[1] as Write])).toBe(false);
        expect(await commit(U.admin, [{ op: "set", path: `teams/${A}/settings/sharing`, data: { membersMayApproveDevices: true } }])).toBe(true);
        expect(await commit(U.editor, [writes[1] as Write])).toBe(true);
        // Never to a member who is still pending.
        expect(await commit(U.editor, [approve(U.pending, "editor"), grant(A, U.pending, deviceOf(U.pending), U.editor, deviceOf(U.editor))])).toBe(false);
      });

      it("are never written into a team by an outsider, a pending or a removed member", async () => {
        for (const uid of [U.outsider, U.pending, U.removed]) {
          expect(await commit(uid, [newDevice(uid, 2), grant(A, uid, deviceOf(uid, 2), uid, deviceOf(uid, 2))]), uid).toBe(false);
        }
      });

      it("are updated only to a key at least as new, and deleted by their member, owners and admins (who mark the key pending)", async () => {
        const path = grantPath(A, deviceOf(U.viewer));
        const moved = (uid: string, over: DocData = {}): Write => ({
          op: "update", path,
          data: { wrap: keyWrap(), proof: sealedKey(1), approverDeviceId: deviceOf(uid), approverUid: uid, signature: bytes(64), updatedAt: SERVER_TIME, ...over },
        });
        expect(await commit(U.editor, [moved(U.editor)])).toBe(false);
        expect(await commit(U.admin, [moved(U.admin, { uid: U.editor })])).toBe(false);
        expect(await commit(U.admin, [moved(U.admin)])).toBe(true);
        expect(await commit(U.editor, [{ op: "delete", path }])).toBe(false);
        expect(await commit(U.viewer, [{ op: "delete", path }])).toBe(true);
        expect(await commit(U.admin, [{ op: "delete", path: grantPath(A, deviceOf(U.editor)) }, { op: "update", path: `teams/${A}`, data: { rotationPending: true } }])).toBe(true);
      });
    });

    describe("key requests", () => {
      const path = (deviceId: string) => `teams/${A}/keyRequests/${deviceId}`;
      const request = (uid: string, deviceId: string, over: DocData = {}): Write => ({
        op: "set", path: path(deviceId), data: { uid, deviceId, createdAt: SERVER_TIME, ...over },
      });

      it("are made by a member for a device of their own, pending or active, even in the write that joins", async () => {
        expect(await commit(U.viewer, [request(U.viewer, deviceOf(U.viewer))])).toBe(true);
        expect(await commit(U.viewer, [request(U.viewer, deviceOf(U.viewer, 5))])).toBe(false);
        expect(await commit(U.viewer, [request(U.owner, deviceOf(U.owner))])).toBe(false);
        expect(await commit(U.outsider, [request(U.outsider, deviceOf(U.outsider))])).toBe(false);
        expect(await commit(U.newcomer, [request(U.newcomer, deviceOf(U.newcomer))])).toBe(false);
        expect(await commit(U.newcomer, [...joinWrites(U.newcomer, INVITE.live, "pending", "editor", 1), request(U.newcomer, deviceOf(U.newcomer))])).toBe(true);
        expect(await commit(U.viewer, [request(U.viewer, deviceOf(U.pending), { uid: U.viewer })])).toBe(false);
      });

      it("are deleted by another member only in the write that grants them, not because an old grant exists", async () => {
        expect(await commit(U.admin, [{ op: "set", path: `teams/${A}/settings/sharing`, data: { membersMayApproveDevices: true } }])).toBe(true);
        // The viewer's device already holds a grant, made by the owner long ago; the viewer asks again.
        expect(await commit(U.viewer, [request(U.viewer, deviceOf(U.viewer))])).toBe(true);
        expect(await commit(U.editor, [{ op: "delete", path: path(deviceOf(U.viewer)) }])).toBe(false);
        // A new device of the viewer's, granted by the editor, and its request deleted in that write.
        expect(await commit(U.viewer, [
          { op: "set", path: `users/${U.viewer}/devices/${deviceOf(U.viewer, 2)}`, data: { ...deviceDoc(), createdAt: SERVER_TIME } },
          request(U.viewer, deviceOf(U.viewer, 2)),
        ])).toBe(true);
        expect(await commit(U.editor, [{ op: "delete", path: path(deviceOf(U.viewer, 2)) }])).toBe(false);
        expect(await commit(U.editor, [
          {
            op: "set", path: `teams/${A}/keyGrants/${deviceOf(U.viewer, 2)}`,
            data: { ...grantDoc(A, U.viewer, deviceOf(U.viewer, 2), 1, U.editor, deviceOf(U.editor)), createdAt: SERVER_TIME, updatedAt: SERVER_TIME },
          },
          { op: "delete", path: path(deviceOf(U.viewer, 2)) },
        ])).toBe(true);
      });

      it("are never taken over by another member who puts a device of their own at the same id", async () => {
        const patDevice = deviceOf(U.pending);
        const squat: Write[] = [
          { op: "set", path: `users/${U.viewer}/devices/${patDevice}`, data: { ...deviceDoc(), createdAt: SERVER_TIME } },
          {
            op: "set", path: `teams/${A}/keyGrants/${patDevice}`,
            data: { ...grantDoc(A, U.viewer, patDevice, 1, U.viewer, patDevice), createdAt: SERVER_TIME, updatedAt: SERVER_TIME },
          },
        ];
        // Neither the grant with the request's deletion, nor the grant alone, which would block the owner's.
        expect(await commit(U.viewer, [...squat, { op: "delete", path: path(patDevice) }])).toBe(false);
        expect(await commit(U.viewer, squat)).toBe(false);
        expect(await h.peek(path(patDevice))).not.toBeNull();
        // The device record alone is the viewer's to write; the owner still grants Pat's device.
        expect(await commit(U.viewer, squat.slice(0, 1))).toBe(true);
        expect(await commit(U.owner, [
          { op: "update", path: `teams/${A}/members/${U.pending}`, data: { role: "editor" } },
          {
            op: "set", path: `teams/${A}/keyGrants/${patDevice}`,
            data: { ...grantDoc(A, U.pending, patDevice, 1, U.owner, deviceOf(U.owner)), createdAt: SERVER_TIME, updatedAt: SERVER_TIME },
          },
          { op: "delete", path: path(patDevice) },
        ])).toBe(true);
      });

      it("squatted at another member's device id are cleared by an owner or admin in the write that grants the real device", async () => {
        const target = deviceOf(U.editor, 7);
        // A pending member puts a device record and a key request of their own at the id the
        // editor's next device will have, which the rules cannot tell from a real one.
        expect(await commit(U.pending, [
          { op: "set", path: `users/${U.pending}/devices/${target}`, data: { ...deviceDoc(), createdAt: SERVER_TIME } },
          request(U.pending, target),
        ])).toBe(true);
        expect(await commit(U.editor, [{ op: "set", path: `users/${U.editor}/devices/${target}`, data: { ...deviceDoc(), createdAt: SERVER_TIME } }])).toBe(true);
        const grantFor = (approver: string, approverDevice: string): Write => ({
          op: "set", path: `teams/${A}/keyGrants/${target}`,
          data: { ...grantDoc(A, U.editor, target, 1, approver, approverDevice), createdAt: SERVER_TIME, updatedAt: SERVER_TIME },
        });
        const clear: Write = { op: "delete", path: path(target) };
        // While the squatting request waits, nobody grants the editor's device, and the editor cannot delete it.
        expect(await commit(U.editor, [request(U.editor, target)])).toBe(false);
        expect(await commit(U.editor, [grantFor(U.editor, deviceOf(U.editor))])).toBe(false);
        expect(await commit(U.editor, [clear, grantFor(U.editor, deviceOf(U.editor))])).toBe(false);
        expect(await commit(U.owner, [grantFor(U.owner, deviceOf(U.owner))])).toBe(false);
        // An owner deletes it and grants the real device in one write.
        expect(await commit(U.owner, [clear, grantFor(U.owner, deviceOf(U.owner))])).toBe(true);
        expect(await h.peek(path(target))).toBeNull();
        expect((await h.peek(`teams/${A}/keyGrants/${target}`))?.uid).toBe(U.editor);
      });

      it("are read by their member and by whoever may grant them", async () => {
        const pendingRequest = path(deviceOf(U.pending));
        expect(await get(U.pending, pendingRequest)).toBe(true);
        expect(await get(U.admin, pendingRequest)).toBe(true);
        expect(await list(U.admin, { collection: `teams/${A}/keyRequests` })).toBe(true);
        expect(await list(U.pending, { collection: `teams/${A}/keyRequests`, where: [{ field: "uid", value: U.pending }] })).toBe(true);
        for (const uid of [U.editor, U.outsider, U.horizon]) {
          expect(await get(uid, pendingRequest), uid).toBe(false);
          expect(await list(uid, { collection: `teams/${A}/keyRequests` }), uid).toBe(false);
        }
        expect(await commit(U.admin, [{ op: "set", path: `teams/${A}/settings/sharing`, data: { membersMayApproveDevices: true } }])).toBe(true);
        expect(await list(U.editor, { collection: `teams/${A}/keyRequests` })).toBe(true);
        expect(await commit(U.editor, [{ op: "delete", path: pendingRequest }])).toBe(false);
        expect(await commit(U.admin, [{ op: "delete", path: pendingRequest }])).toBe(true);
      });
    });

    describe("rotating the team key", () => {
      const next = 2;
      /** Rotation to key 2 by `uid` from their device, re-granting `kept` devices. */
      const rotation = (uid: string, kept: [string, string][], over: DocData = {}): Write[] => [
        { op: "update", path: `teams/${A}`, data: { encKey: encKey(SEED.A, next), ...over } },
        {
          op: "set", path: `teams/${A}/teamKeys/${String(next)}`,
          data: { v: 1, kv: next, prev: sealedKey(next), pairPrivate: env(next, 154), ...recordKeys(SEED.A, next) },
        },
        {
          op: "update", path: `teams/${A}/recovery/current`,
          data: { kv: next, teamKey: keyWrap(), check: sealedKey(next), updatedBy: uid, updatedAt: SERVER_TIME },
        },
        ...kept.map(([, deviceId]): Write => ({
          op: "update", path: `teams/${A}/keyGrants/${deviceId}`,
          data: { kv: next, wrap: keyWrap(), proof: sealedKey(next), approverDeviceId: deviceOf(uid), approverUid: uid, signature: bytes(64), updatedAt: SERVER_TIME },
        })),
      ];
      const everyone = (): [string, string][] => [U.owner, U.admin, U.editor, U.viewer].map((uid) => [uid, deviceOf(uid)]);

      it("is done by an owner or admin in one write, and by nobody else", async () => {
        const removal: Write[] = [
          { op: "delete", path: `teams/${A}/members/${U.editor}` },
          { op: "delete", path: `teams/${A}/keyGrants/${deviceOf(U.editor)}` },
        ];
        const kept = everyone().filter(([uid]) => uid !== U.editor);
        expect(await commit(U.editor, rotation(U.editor, everyone()))).toBe(false);
        expect(await commit(U.viewer, rotation(U.viewer, everyone()))).toBe(false);
        expect(await commit(U.admin, [...removal, ...rotation(U.admin, kept)])).toBe(true);
        expect((await h.peek(`teams/${A}`))?.encKey).toMatchObject({ v: 2 });
        expect((await h.peek(`teams/${A}/keyGrants/${deviceOf(U.viewer)}`))?.kv).toBe(2);
      });

      it("lets an admin delete a revoked device's grant in the write that rotates, though its member stays", async () => {
        const kept = everyone().filter(([uid]) => uid !== U.viewer);
        expect(await commit(U.admin, [{ op: "delete", path: `teams/${A}/keyGrants/${deviceOf(U.viewer)}` }, ...rotation(U.admin, kept)])).toBe(true);
        expect(await h.peek(`teams/${A}/keyGrants/${deviceOf(U.viewer)}`)).toBe(null);
      });

      it("needs the new key record and the recovery record moved on, one version up", async () => {
        const writes = rotation(U.admin, everyone());
        expect(await commit(U.admin, writes.filter((w) => !w.path.endsWith("/teamKeys/2")))).toBe(false);
        expect(await commit(U.admin, writes.filter((w) => !w.path.endsWith("/recovery/current")))).toBe(false);
        expect(await commit(U.admin, [writes[0] as Write])).toBe(false);
        expect(await commit(U.admin, [{ op: "update", path: `teams/${A}`, data: { encKey: encKey(SEED.A, 3) } }])).toBe(false);
        // The rotating device must hold the new key itself.
        expect(await commit(U.admin, rotation(U.admin, everyone().filter(([uid]) => uid !== U.admin)))).toBe(false);
      });

      it("re-grants every device of a big team in one write, within the documents a batch may read", async () => {
        const docs = world();
        const kept: [string, string][] = [[U.admin, deviceOf(U.admin)]];
        for (let i = 0; i < 24; i++) {
          const uid = `member${String(i)}`;
          docs[`users/${uid}`] = { displayName: uid, createdAt: PAST };
          docs[`teams/${A}/members/${uid}`] = member(A, uid, "editor");
          for (const n of [1, 2]) {
            const deviceId = deviceOf(uid, n);
            docs[`users/${uid}/devices/${deviceId}`] = deviceDoc();
            docs[`teams/${A}/keyGrants/${deviceId}`] = grantDoc(A, uid, deviceId, 1, U.owner, deviceOf(U.owner));
            kept.push([uid, deviceId]);
          }
        }
        await h.reset(docs);
        const removal: Write[] = [
          { op: "delete", path: `teams/${A}/members/${U.viewer}` },
          { op: "delete", path: `teams/${A}/keyGrants/${deviceOf(U.viewer)}` },
          { op: "set", path: `teams/${A}/activity/rotateXXXXXXXXXXXXXXXX`, data: { at: SERVER_TIME, by: U.admin, kind: "key.rotate", target: "2" } },
        ];
        expect(kept.length).toBe(49);
        expect(await commit(U.admin, [...removal, ...rotation(U.admin, kept)])).toBe(true);
      });

      it("removes an approval over the old key from each grant it moves on, so no grant keeps one", async () => {
        // The viewer's device was approved with its code under key 1 and has not opened its grant yet.
        const docs = world();
        const viewerGrant = `teams/${A}/keyGrants/${deviceOf(U.viewer)}`;
        docs[viewerGrant] = { ...(docs[viewerGrant] as DocData), approval: { v: 1, kv: 1, mac: bytes(32) } };
        await h.reset(docs);
        const rotate = rotation(U.admin, everyone());
        expect(await commit(U.admin, rotate)).toBe(false);
        const dropped = rotate.map((w): Write => (w.op === "update" && w.path === viewerGrant ? { ...w, data: { ...w.data, approval: DELETE_FIELD } } : w));
        expect(await commit(U.admin, dropped)).toBe(true);
        const after = await h.peek(viewerGrant);
        expect(after?.kv).toBe(2);
        expect(after !== null && after !== undefined && Object.hasOwn(after, "approval")).toBe(false);
      });

      it("seals nothing new under the old key in the write that rotates it", async () => {
        const rotate = rotation(U.owner, everyone());
        const title = (kv: number): Write => ({
          op: "set", path: `teams/${A}/autos/autoRotXXXXXXXXXXXXXXX`,
          data: { title: env(kv), titleGen: 1, createdBy: U.owner, createdAt: SERVER_TIME, updatedAt: SERVER_TIME },
        });
        const retitle = (kv: number): Write => ({ op: "update", path: `teams/${A}/autos/${AUTO}`, data: { title: env(kv), titleGen: 2, updatedAt: SERVER_TIME } });
        const logged = (kv: number): Write => ({
          op: "set", path: `teams/${A}/activity/rotActXXXXXXXXXXXXXXXX`, data: { at: SERVER_TIME, by: U.owner, kind: "auto.create", target: AUTO, detail: env(kv) },
        });
        const shared = (kv: number): Write => newShare(U.owner, "shareRotXXXXXXXXXXXXXX", { ownerWrap: sealedKey(kv) });
        const cases: [string, (kv: number) => Write][] = [
          ["revision", (kv) => revisionWrite(U.owner, "000003-rotateXX", { content: env(kv) })],
          ["new title", title],
          ["title", retitle],
          ["activity", logged],
          ["share", shared],
        ];
        for (const [name, write] of cases) {
          await h.reset(world());
          expect(await commit(U.owner, [...rotate, write(1)]), name).toBe(false);
          expect(await commit(U.owner, [...rotate, write(2)]), name).toBe(true);
        }
      });

      it("is marked pending by any active member, and the mark is cleared only by the rotation", async () => {
        const mark = (value: unknown): Write => ({ op: "update", path: `teams/${A}`, data: { rotationPending: value } });
        for (const uid of [U.pending, U.removed, U.outsider]) expect(await commit(uid, [mark(true)]), uid).toBe(false);
        expect(await commit(U.viewer, [mark("yes")])).toBe(false);
        expect(await commit(U.viewer, [mark(true)])).toBe(true);
        expect(await commit(U.viewer, [mark(false)])).toBe(false);
        expect(await commit(U.admin, rotation(U.admin, everyone(), { rotationPending: false }))).toBe(true);
        expect((await h.peek(`teams/${A}`))?.rotationPending).toBe(false);
      });

      it("leaves a removed member nothing: no key record, grant or recovery record, and no mark", async () => {
        for (const path of [`teams/${A}/recovery/current`, `teams/${A}/keyGrants/${deviceOf(U.removed)}`]) {
          expect(await get(U.removed, path), path).toBe(false);
        }
        // Key record 1 is public keys and ciphertext under key 1, which anyone signed in may get by id.
        expect(await list(U.removed, { collection: `teams/${A}/teamKeys` })).toBe(false);
        expect(await commit(U.removed, [{ op: "update", path: `teams/${A}`, data: { rotationPending: true } }])).toBe(false);
        expect(await commit(U.removed, [{ op: "set", path: `teams/${A}/keyRequests/${deviceOf(U.removed)}`, data: { uid: U.removed, deviceId: deviceOf(U.removed), createdAt: SERVER_TIME } }])).toBe(false);
      });
    });

    describe("ciphertext the rules can check", () => {
      /** The world after a rotation to key 2: content under key 1 is refused from then on. */
      const rotatedWorld = (): Record<string, DocData> => {
        const docs = { ...world(), ...keyDocs(A, SEED.A, 2, U.owner) };
        docs[`teams/${A}`] = { ...(docs[`teams/${A}`] as DocData), encKey: encKey(SEED.A, 2) };
        return docs;
      };

      it("refuses plaintext where the app writes ciphertext", async () => {
        expect(await commit(U.editor, [revisionWrite(U.editor, "000003-plainXXX", { content: '{"v":3}' })])).toBe(false);
        expect(await commit(U.editor, [{
          op: "set", path: `teams/${A}/autos/autoPlainXXXXXXXXXXXXX`, data: { title: "Far side", titleGen: 1, createdBy: U.editor, createdAt: SERVER_TIME, updatedAt: SERVER_TIME },
        }])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "sharePlainXXXXXXXXXXXX", { projection: '{"kind":"projection"}' })])).toBe(false);
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalPlainXXXXXXXXX", SHARE.propose, { diff: "[]" })])).toBe(false);
        expect(await commit(U.editor, [revisionWrite(U.editor, "000003-envStrXX", { content: { ...env(1), ct: "not bytes" } })])).toBe(false);
      });

      it("counts an auto's title generations up by one, and seals a revision's git commit id with its content", async () => {
        const retitle = (titleGen: unknown): Write => ({ op: "update", path: `teams/${A}/autos/${AUTO}`, data: { title: env(1), titleGen, updatedAt: SERVER_TIME } });
        expect(await commit(U.editor, [retitle(1)])).toBe(false);
        expect(await commit(U.editor, [retitle(3)])).toBe(false);
        expect(await commit(U.editor, [{ op: "update", path: `teams/${A}/autos/${AUTO}`, data: { title: env(1), updatedAt: SERVER_TIME } }])).toBe(false);
        expect(await commit(U.editor, [retitle(2)])).toBe(true);
        const made = (over: DocData): Write => ({
          op: "set", path: `teams/${A}/autos/autoGenXXXXXXXXXXXXXXX`, data: { title: env(1), createdBy: U.editor, createdAt: SERVER_TIME, updatedAt: SERVER_TIME, ...over },
        });
        expect(await commit(U.editor, [made({})])).toBe(false);
        expect(await commit(U.editor, [made({ titleGen: 2 })])).toBe(false);
        expect(await commit(U.editor, [made({ titleGen: 1 })])).toBe(true);

        expect(await commit(U.editor, [revisionWrite(U.editor, "000003-shaPlain", { gitSha: "0123abc" })])).toBe(false);
        expect(await commit(U.editor, [revisionWrite(U.editor, "000003-shaOldKy", { gitSha: env(2) })])).toBe(false);
        expect(await commit(U.editor, [revisionWrite(U.editor, "000003-shaBigXX", { gitSha: env(1, 1025) })])).toBe(false);
        expect(await commit(U.editor, [revisionWrite(U.editor, "000003-shaOkXXX", { gitSha: env(1, 56) })])).toBe(true);
      });

      it("refuses new content under a team key the team has rotated away from", async () => {
        await h.reset(rotatedWorld());
        expect(await commit(U.editor, [revisionWrite(U.editor, "000003-oldKeyXX")])).toBe(false);
        expect(await commit(U.editor, [revisionWrite(U.editor, "000003-newKeyXX", { content: env(2) })])).toBe(true);
        expect(await commit(U.editor, [revisionWrite(U.editor, "000003-mixedXXX", { content: env(2), robot: env(1) })])).toBe(false);
        expect(await commit(U.editor, [{
          op: "update", path: `teams/${A}/autos/${AUTO}`, data: { title: env(1), titleGen: 2, updatedAt: SERVER_TIME },
        }])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareOldOwnerWrapXXXXX")])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareNewOwnerWrapXXXXX", { ownerWrap: sealedKey(2) })])).toBe(true);
      });

      it("holds a share's wraps to exactly its teams, and a link share to its secret alone", async () => {
        expect(await commit(U.owner, [newShare(U.owner, "shareMissingWrapXXXXXX", { teamIds: [B, C], keyWraps: { [B]: shareWrap() } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareExtraWrapXXXXXXXX", { keyWraps: { [B]: shareWrap(), [C]: shareWrap() } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareBadWrapXXXXXXXXXX", { keyWraps: { [B]: keyWrap() } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareNoOwnerWrapXXXXXX", { ownerWrap: undefined })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareKeyTwoXXXXXXXXXXX", { projection: env(2) })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareTwoTeamsXXXXXXXXX", { teamIds: [B, C] })])).toBe(true);
        const link = { audience: "link", teamIds: [] };
        expect(await commit(U.owner, [newShare(U.owner, "shareLinkWrapsXXXXXXXX", { ...link, keyWraps: {} })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareLinkOwnerXXXXXXXX", { ...link, ownerWrap: sealedKey(1) })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareLinkSecretXXXXXXX", { ...link, linkWrap: sealedKey(1) })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareTeamLinkWrapXXXXX", { linkWrap: env(1, 32) })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareLinkOkXXXXXXXXXXX", link)])).toBe(true);
      });

      it("holds a signed manifest of the fifth version on every share, a link share too, of a bounded size, with the signing device's signature and keys and the terms signature and keys", async () => {
        const without = (field: string): DocData => Object.fromEntries(Object.entries(manifest()).filter(([key]) => key !== field));
        expect(await commit(U.owner, [newShare(U.owner, "shareNoManifestXXXXXXX", { manifest: undefined })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestPlainXXXX", { manifest: { ...manifest(), body: "zenith/v2/share-manifest" } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestShortSigX", { manifest: { ...manifest(), sig: bytes(63) } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestExtraXXXX", { manifest: { ...manifest(), note: "x" } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestV1XXXXXXX", { manifest: { ...manifest(), v: 1 } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestV2XXXXXXX", { manifest: { v: 2, body: bytes(120), sig: bytes(64) } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestV3XXXXXXX", { manifest: { v: 3, body: bytes(120), sig: bytes(64), dsig: bytes(64), dkeys: bytes(182) } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestV4XXXXXXX", { manifest: { v: 4, body: bytes(120), sig: bytes(64), dsig: bytes(64), dkeys: bytes(182), osig: bytes(64) } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestV4TsigXXX", { manifest: { ...manifest(), v: 4 } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestOsigXXXXX", { manifest: { ...without("tsig"), osig: bytes(64) } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestNoDsigXXX", { manifest: without("dsig") })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestShortDsig", { manifest: { ...manifest(), dsig: bytes(63) } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestNoDkeysXX", { manifest: without("dkeys") })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestNoTsigXXX", { manifest: without("tsig") })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestNoTkeysXX", { manifest: without("tkeys") })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestTsig63XXX", { manifest: { ...manifest(), tsig: bytes(63) } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestTsigTxtXX", { manifest: { ...manifest(), tsig: "x".repeat(64) } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestTkeys181X", { manifest: { ...manifest(), tkeys: bytes(181) } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestTkeysTxtX", { manifest: { ...manifest(), tkeys: "x".repeat(182) } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestDkeys181X", { manifest: { ...manifest(), dkeys: bytes(181) } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestDkeysTxtX", { manifest: { ...manifest(), dkeys: "x".repeat(182) } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestBigXXXXXX", { manifest: manifest(1, 2561) })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareManifestCapXXXXXX", { manifest: manifest(1, 2560) })])).toBe(true);
        const link = { audience: "link", teamIds: [] };
        expect(await commit(U.owner, [newShare(U.owner, "shareLinkNoManifestXXX", { ...link, manifest: undefined })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareLinkManifestV1XXX", { ...link, manifest: { ...manifest(), v: 1 } })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareLinkManifestXXXXX", { ...link, manifest: manifest(1, 2560) })])).toBe(true);
        // A link share cannot be turned into a share to teams, which would need a manifest.
        expect(await commit(U.owner, [{
          op: "update", path: `shares/${SHARE.link}`,
          data: { audience: "teams", teamIds: [B], keyWraps: { [B]: shareWrap() }, ownerWrap: sealedKey(1), manifest: manifest(), linkWrap: null, updatedAt: SERVER_TIME },
        }])).toBe(false);
      });

      it("signs a new manifest in the same write as every change of a share's level, mode or revocation, on a link share too", async () => {
        const change = (id: keyof typeof SHARE, data: DocData): Write => ({ op: "update", path: `shares/${SHARE[id]}`, data: { ...data, updatedAt: SERVER_TIME } });
        expect(await commit(U.owner, [change("view", { level: "propose" })])).toBe(false);
        expect(await commit(U.owner, [change("view", { level: "propose", manifest: { ...manifest(2), v: 1 } })])).toBe(false);
        expect(await commit(U.owner, [change("view", { level: "propose", manifest: manifest(2) })])).toBe(true);
        expect(await commit(U.owner, [change("view", { mode: "follow" })])).toBe(false);
        expect(await commit(U.owner, [change("view", { mode: "follow", manifest: manifest(3) })])).toBe(true);
        expect(await commit(U.owner, [change("link", { mode: "follow" })])).toBe(false);
        expect(await commit(U.owner, [change("link", { mode: "follow", manifest: manifest(2) })])).toBe(true);
        expect(await commit(U.owner, [change("link", { revokedAt: SERVER_TIME })])).toBe(false);
        expect(await commit(U.owner, [change("link", { revokedAt: SERVER_TIME, manifest: manifest(3) })])).toBe(true);
        // Extending a share, or publishing to it under the same key, changes its end or its revision,
        // which the manifest names too.
        expect(await commit(U.owner, [change("view", { expiresAt: new Date(Date.now() + 30 * DAY_MS) })])).toBe(false);
        expect(await commit(U.owner, [change("view", { expiresAt: new Date(Date.now() + 30 * DAY_MS), manifest: manifest(4) })])).toBe(true);
        expect(await commit(U.owner, [change("view", { revision: R1, projection: env(1, 77) })])).toBe(false);
        expect(await commit(U.owner, [change("view", { revision: R1, projection: env(1, 77), manifest: manifest(5) })])).toBe(true);
      });

      it("keeps the sharer's choices sealed under the owner team's newest key, written once when the share is made", async () => {
        expect(await commit(U.owner, [newShare(U.owner, "shareChoiceXXXXXXXXXXX", { ownerChoice: env(1, 1024) })])).toBe(true);
        expect(await commit(U.owner, [newShare(U.owner, "shareChoiceBigXXXXXXXX", { ownerChoice: env(1, 1025) })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareChoiceOldKeyXXXXX", { ownerChoice: env(2) })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareChoicePlainXXXXXX", { ownerChoice: "coarse" })])).toBe(false);
        expect(await commit(U.owner, [newShare(U.owner, "shareLinkChoiceXXXXXXX", { audience: "link", teamIds: [], ownerChoice: env(1) })])).toBe(true);
        expect(await commit(U.owner, [{ op: "update", path: "shares/shareChoiceXXXXXXXXXXX", data: { ownerChoice: env(1, 41), updatedAt: SERVER_TIME } }])).toBe(false);
        expect(await commit(U.owner, [{ op: "update", path: `shares/${SHARE.view}`, data: { ownerChoice: env(1), manifest: manifest(2), updatedAt: SERVER_TIME } }])).toBe(false);
      });

      it("re-keys a share to take a team off it, keeping the old key under the new one, and never goes back", async () => {
        await h.reset({
          ...world(),
          [`shares/${SHARE.view}`]: { ...(world()[`shares/${SHARE.view}`] as DocData), teamIds: [B, C], keyWraps: { [B]: shareWrap(), [C]: shareWrap() } },
        });
        const path = `shares/${SHARE.view}`;
        const change = (data: DocData): Write => ({ op: "update", path, data: { ...data, updatedAt: SERVER_TIME } });
        const off = { teamIds: [B], keyWraps: { [B]: shareWrap() } };
        expect(await commit(U.owner, [change(off)])).toBe(false);
        expect(await commit(U.owner, [change({ ...off, projection: env(2) })])).toBe(false);
        expect(await commit(U.owner, [change({ ...off, projection: env(2), prevKeys: { "1": sealedKey(1) } })])).toBe(false);
        expect(await commit(U.owner, [change({ ...off, projection: env(3), prevKeys: { "1": sealedKey(3) } })])).toBe(false);
        // Every change to the wraps or the older keys signs a new manifest in the same write.
        expect(await commit(U.owner, [change({ ...off, projection: env(2), ownerWrap: sealedKey(1), prevKeys: { "1": sealedKey(2) } })])).toBe(false);
        expect(await commit(U.owner, [change({ ...off, projection: env(2), ownerWrap: sealedKey(1), prevKeys: { "1": sealedKey(2) }, manifest: manifest(2) })])).toBe(true);
        // The version never drops and a kept key never changes.
        expect(await commit(U.owner, [change({ projection: env(1) })])).toBe(false);
        expect(await commit(U.owner, [change({ projection: env(3), prevKeys: { "1": sealedKey(3), "2": sealedKey(3) }, manifest: manifest(3) })])).toBe(false);
        expect(await commit(U.owner, [change({ projection: env(3), prevKeys: { "1": sealedKey(2), "2": sealedKey(3) } })])).toBe(false);
        expect(await commit(U.owner, [change({ projection: env(3), prevKeys: { "1": sealedKey(2), "2": sealedKey(3) }, manifest: manifest(3) })])).toBe(true);
        // Adding a team needs no new key, but a new manifest.
        expect(await commit(U.owner, [change({ teamIds: [B, C], keyWraps: { [B]: shareWrap(), [C]: shareWrap() } })])).toBe(false);
        expect(await commit(U.owner, [change({ teamIds: [B, C], keyWraps: { [B]: shareWrap(), [C]: shareWrap() }, manifest: manifest(4) })])).toBe(true);
      });

      it("moves a following share under the same key, or a new key for the same teams, and a link share's secret never", async () => {
        await h.reset({
          ...world(),
          [`shares/${SHARE.view}`]: { ...(world()[`shares/${SHARE.view}`] as DocData), mode: "follow", createdBy: U.admin },
        });
        const path = `shares/${SHARE.view}`;
        const move = (data: DocData): Write => ({ op: "update", path, data: { revision: R1, ...data, updatedAt: SERVER_TIME } });
        const follow = (projection: DocData): Write => move({ projection, manifest: manifest(9) });
        expect(await commit(U.editor, [follow(env(2))])).toBe(false);
        expect(await commit(U.editor, [move({ projection: env(1, 77) })])).toBe(false);
        expect(await commit(U.editor, [follow(env(1, 77))])).toBe(true);
        // An editor who did not make the share re-keys it for the teams it names, when a team key it
        // was wrapped under changed, but changes nothing else with it.
        const rekey = { projection: env(2), keyWraps: { [B]: shareWrap(2) }, ownerWrap: { ...sealedKey(1), iv: bytes(12, 3) }, prevKeys: { "1": sealedKey(2) }, manifest: manifest(2) };
        expect(await commit(U.editor, [move({ projection: env(1, 78), keyWraps: { [B]: shareWrap(2) } })])).toBe(false);
        expect(await commit(U.editor, [move({ projection: env(1, 78), keyWraps: { [B]: shareWrap(2) }, manifest: manifest(2) })])).toBe(false);
        // The manifest the share already holds is not a new one.
        expect(await commit(U.editor, [move({ ...rekey, manifest: manifest(9) })])).toBe(false);
        expect(await commit(U.editor, [move({ ...rekey, prevKeys: {} })])).toBe(false);
        expect(await commit(U.editor, [move({ ...rekey, level: "propose" })])).toBe(false);
        expect(await commit(U.editor, [move({ ...rekey, teamIds: [B, C], keyWraps: { [B]: shareWrap(2), [C]: shareWrap() } })])).toBe(false);
        expect(await commit(U.viewer, [move(rekey)])).toBe(false);
        expect(await commit(U.editor, [move(rekey)])).toBe(true);
        expect(await commit(U.owner, [{ op: "update", path: `shares/${SHARE.link}`, data: { linkWrap: { ...env(1, 32), iv: bytes(12, 2) }, updatedAt: SERVER_TIME } }])).toBe(false);
      });

      it("takes a proposal only under its own key, with the key sealed for the proposing team", async () => {
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalOldKeyXXXXXXXX", SHARE.propose, { diff: env(2) })])).toBe(false);
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalNoWrapXXXXXXXX", SHARE.propose, { fromWrap: undefined })])).toBe(false);
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalBadWrapXXXXXXX", SHARE.propose, { fromWrap: keyWrap() })])).toBe(false);
        expect(await commit(U.outsiderEditor, [proposalWrite(U.outsiderEditor, "proposalOkKeyXXXXXXXXX", SHARE.propose)])).toBe(true);
      });

      it("keeps the one sealed activity detail to an auto's creation", async () => {
        const entry = (kind: string, detail: unknown): Write => ({
          op: "set", path: `teams/${A}/activity/sealed-${kind}`, data: { at: SERVER_TIME, by: U.editor, kind, target: AUTO, detail },
        });
        expect(await commit(U.editor, [entry("share.create", env(1))])).toBe(false);
        expect(await commit(U.editor, [entry("auto.create", env(1, 1025))])).toBe(false);
        // An auto's title never goes into the log in the clear, nor sealed under a key that is not the newest.
        expect(await commit(U.editor, [entry("auto.create", "Far side seven ball")])).toBe(false);
        expect(await commit(U.editor, [entry("auto.create", undefined)])).toBe(false);
        expect(await commit(U.editor, [entry("auto.create", env(2))])).toBe(false);
        expect(await commit(U.editor, [entry("auto.create", env(1))])).toBe(true);
      });
    });

    // The engine evaluates at most 1,000 expressions for one document, and refuses a write that
    // needs more, whatever the rules would have said. A share's update checks a wrap for each team it
    // names, so these cases make each update the app makes, to shares of 2, 3, 4 and 8 teams (the
    // most a share names), after the sharing team's key changed from version 1 to 2.
    describe("updates of a share to up to 8 teams, within the engine's limit of expressions", () => {
      const extra = ["teamT1", "teamT2", "teamT3", "teamT4", "teamT5", "teamT6"].map((t) => `${t}XXXXXXXXXXXXXXXX`);
      /** The first `n` of the teams a share can name: B, C and six more. */
      const teamsOf = (n: number): string[] => [B, C, ...extra].slice(0, n);
      /** A wrap to each of `teamIds` at public key `ekv`, its IV filled with `fill` so it differs from an older one. */
      const wrapsFor = (teamIds: string[], ekv = 1, fill = 1): DocData =>
        Object.fromEntries(teamIds.map((teamId) => [teamId, { ...shareWrap(ekv), iv: bytes(12, fill) }]));
      /** The largest manifest body one can have (test/sizeCaps.test.ts), bytes, so the engine's count of expressions is measured at its worst. */
      const LONGEST_MANIFEST = 2472;
      /** The fields that move a share from key 1 to key 2 wrapped to `teamIds`, sealed under team key 2, with a new manifest. */
      const rekeyFor = (teamIds: string[]): DocData => ({
        projection: env(2), keyWraps: wrapsFor(teamIds, 1, 2), ownerWrap: sealedKey(2), prevKeys: { "1": sealedKey(2) }, manifest: manifest(2, LONGEST_MANIFEST),
      });
      const path = `shares/${SHARE.view}`;
      const change = (data: DocData): Write => ({ op: "update", path, data: { ...data, updatedAt: SERVER_TIME } });

      /** The world after team A's key changed to version 2, with a following share, made by the admin, to `teamIds`. */
      const manyTeamsWorld = (teamIds: string[]): Record<string, DocData> => {
        const docs = { ...world(), ...keyDocs(A, SEED.A, 2, U.owner) };
        docs[`teams/${A}`] = { ...(docs[`teams/${A}`] as DocData), encKey: encKey(SEED.A, 2) };
        for (const [index, teamId] of extra.entries()) {
          docs[`teams/${teamId}`] = { number: null, name: `Extra ${String(index)}`, status: "unverified", createdBy: `x${String(index)}`, createdAt: PAST };
        }
        const [sharePath, data] = share("view", { teamIds, keyWraps: wrapsFor(teamIds), mode: "follow", createdBy: U.admin });
        docs[sharePath] = data;
        return docs;
      };

      for (const n of [2, 3, 4, 8]) {
        const teams = teamsOf(n);

        it(`an owner re-keys a share to ${String(n)} teams for the same teams`, async () => {
          await h.reset(manyTeamsWorld(teams));
          expect(await commit(U.owner, [change(rekeyFor(teams))])).toBe(true);
        });

        it(`an owner takes a team off a share to ${String(n)} teams`, async () => {
          await h.reset(manyTeamsWorld(teams));
          const kept = teams.slice(0, -1);
          expect(await commit(U.owner, [change({ ...rekeyFor(kept), teamIds: kept })])).toBe(true);
        });

        it(`an owner adds a team to make a share to ${String(n)} teams`, async () => {
          const before = teams.slice(0, -1);
          await h.reset(manyTeamsWorld(before));
          expect(await commit(U.owner, [change({ teamIds: teams, keyWraps: wrapsFor(teams) })])).toBe(false);
          expect(await commit(U.owner, [change({ teamIds: teams, keyWraps: wrapsFor(teams), manifest: manifest(3, LONGEST_MANIFEST) })])).toBe(true);
        });

        it(`an owner revokes a share to ${String(n)} teams, signing a manifest that says so`, async () => {
          await h.reset(manyTeamsWorld(teams));
          expect(await commit(U.owner, [change({ revokedAt: SERVER_TIME })])).toBe(false);
          expect(await commit(U.owner, [change({ revokedAt: SERVER_TIME, manifest: manifest(3, LONGEST_MANIFEST) })])).toBe(true);
        });

        it(`an owner raises a share to ${String(n)} teams to propose, signing a manifest that says so`, async () => {
          await h.reset(manyTeamsWorld(teams));
          expect(await commit(U.owner, [change({ level: "propose", manifest: manifest(3, LONGEST_MANIFEST) })])).toBe(true);
        });

        it(`the editor who made a share to ${String(n)} teams pins it, signing a manifest that says so`, async () => {
          const docs = manyTeamsWorld(teams);
          docs[path] = { ...(docs[path] as DocData), createdBy: U.editor };
          await h.reset(docs);
          expect(await commit(U.editor, [change({ mode: "pinned" })])).toBe(false);
          expect(await commit(U.editor, [change({ mode: "pinned", manifest: manifest(3, LONGEST_MANIFEST) })])).toBe(true);
        });

        it(`an editor publishes to a following share to ${String(n)} teams`, async () => {
          await h.reset(manyTeamsWorld(teams));
          expect(await commit(U.editor, [change({ revision: R1, projection: env(1, 77), manifest: manifest(3, LONGEST_MANIFEST) })])).toBe(true);
        });

        it(`an admin extends a share to ${String(n)} teams`, async () => {
          await h.reset(manyTeamsWorld(teams));
          expect(await commit(U.admin, [change({ expiresAt: new Date(Date.now() + 30 * DAY_MS), manifest: manifest(3, LONGEST_MANIFEST) })])).toBe(true);
        });

        it(`an editor who did not make a following share to ${String(n)} teams re-keys it when she publishes after a key change`, async () => {
          await h.reset(manyTeamsWorld(teams));
          const rekey = rekeyFor(teams);
          expect(await commit(U.viewer, [change({ revision: R1, ...rekey })])).toBe(false);
          expect(await commit(U.editor, [change({ revision: R1, ...rekey, teamIds: teams.slice(0, -1) })])).toBe(false);
          expect(await commit(U.editor, [change({ revision: R1, ...rekey })])).toBe(true);
        });
      }

      it("makes a share to 8 teams", async () => {
        await h.reset(manyTeamsWorld([B]));
        const teams = teamsOf(8);
        expect(await commit(U.owner, [newShare(U.owner, "shareToEightTeamsXXXXX", { teamIds: teams, keyWraps: wrapsFor(teams), ownerWrap: sealedKey(2) })])).toBe(true);
        // With the largest manifest and the sharer's choices at their cap.
        expect(await commit(U.owner, [newShare(U.owner, "shareToEightChoiceXXXX", {
          teamIds: teams, keyWraps: wrapsFor(teams), ownerWrap: sealedKey(2), manifest: manifest(1, LONGEST_MANIFEST), ownerChoice: env(2, 1024),
        })])).toBe(true);
      });

      it("checks every wrap of a re-key, the last of a share to 5, 6, 7 or 8 teams included", async () => {
        const bad: DocData[] = [
          keyWrap(),
          { ...shareWrap(2), epk: bytes(64) },
          { ...shareWrap(2), iv: "x".repeat(12) },
          { ...shareWrap(2), ct: bytes(49) },
          { ...shareWrap(2), ekv: 0 },
          { ...shareWrap(2), extra: 1 },
          { ...shareWrap(2), v: 2 },
          { ...shareWrap(2), epk: "x".repeat(65) },
        ];
        for (const n of [5, 6, 7, 8]) {
          const teams = teamsOf(n);
          await h.reset(manyTeamsWorld(teams));
          const rekey = rekeyFor(teams);
          const indexes = n === 8 ? [0, 1, 2, 3, 4, 5, 6, 7] : [n - 1];
          for (const index of indexes) {
            const teamId = teams[index] as string;
            const wraps = { ...(rekey.keyWraps as DocData), [teamId]: bad[index] as DocData };
            expect(await commit(U.owner, [change({ ...rekey, keyWraps: wraps })]), `${String(n)} teams, wrap ${String(index)}`).toBe(false);
          }
          expect(await commit(U.owner, [change(rekey)]), `${String(n)} teams`).toBe(true);
        }
      });

      it("checks the new owner wrap, the kept key and the projection of a re-key of a share to 8 teams", async () => {
        const teams = teamsOf(8);
        await h.reset(manyTeamsWorld(teams));
        const rekey = rekeyFor(teams);
        const refusedRekeys: DocData[] = [
          { ownerWrap: { ...sealedKey(1), iv: bytes(12, 5) } },
          { ownerWrap: { ...sealedKey(2), iv: "x".repeat(12) } },
          { ownerWrap: { ...sealedKey(2), ct: bytes(47) } },
          { prevKeys: { "1": sealedKey(3) } },
          { prevKeys: { "1": { ...sealedKey(2), ct: "x".repeat(48) } } },
          { prevKeys: { "1": sealedKey(2), "2": sealedKey(2) } },
          { prevKeys: {} },
          { projection: env(3) },
          { projection: { ...env(2), iv: bytes(11) } },
          { projection: { ...env(2), ct: "x".repeat(40) } },
          { keyWraps: wrapsFor(teams.slice(0, -1), 1, 2) },
          { keyWraps: { ...wrapsFor(teams, 1, 2), [A]: shareWrap() } },
          { teamIds: [...teams, A], keyWraps: { ...wrapsFor(teams, 1, 2), [A]: shareWrap() } },
          { teamIds: [...teams, "teamNineXXXXXXXXXXXXXX"], keyWraps: wrapsFor([...teams, "teamNineXXXXXXXXXXXXXX"], 1, 2) },
          { level: "sealed" },
          { ownerTeamId: B },
          { linkWrap: env(1, 32) },
        ];
        for (const over of refusedRekeys) {
          expect(await commit(U.owner, [change({ ...rekey, ...over })]), JSON.stringify(Object.keys(over))).toBe(false);
        }
        expect(await commit(U.owner, [change(rekey)])).toBe(true);
      });
    });

    describe("deleting a team's keys", () => {
      it("is done only by the owner under the team's tombstone", async () => {
        const keys: Write[] = [
          { op: "delete", path: `teams/${A}/teamKeys/1` },
          { op: "delete", path: `teams/${A}/recovery/current` },
          { op: "delete", path: `teams/${A}/keyGrants/${deviceOf(U.viewer)}` },
          { op: "delete", path: `teams/${A}/keyRequests/${deviceOf(U.pending)}` },
        ];
        expect(await commit(U.owner, keys.slice(0, 2))).toBe(false);
        expect(await commit(U.admin, [tombstoneWrite(U.admin, A), ...keys])).toBe(false);
        expect(await commit(U.owner, [tombstoneWrite(U.owner, A), ...keys])).toBe(true);
        expect(await h.peek(`teams/${A}/teamKeys/1`)).toBeNull();
      });
    });

    describe("the Horizon admin access log", () => {
      const entry = (uid: string, id = "adminLogEntryXXXXXXXXX", over: DocData = {}): Write => ({
        op: "set", path: `adminLog/${id}`, data: { by: uid, at: SERVER_TIME, action: "queue.open", target: "requestOneXXXXXXXXXXXX", ...over },
      });

      it("is written only by Horizon admins, as themselves, at the moment of the request", async () => {
        for (const uid of [U.owner, U.admin, U.viewer, U.newcomer, null]) expect(await commit(uid, [entry(uid ?? "x")]), String(uid)).toBe(false);
        expect(await commit(U.horizon, [entry(U.owner)])).toBe(false);
        expect(await commit(U.horizon, [entry(U.horizon, "short")])).toBe(false);
        expect(await commit(U.horizon, [entry(U.horizon, undefined, { at: PAST })])).toBe(false);
        expect(await commit(U.horizon, [entry(U.horizon, undefined, { action: "share.revoke" })])).toBe(false);
        // Admins never open a share's content, so there is no kind for it.
        expect(await commit(U.horizon, [entry(U.horizon, undefined, { action: "share.preview", target: SHARE.view })])).toBe(false);
        expect(await commit(U.horizon, [entry(U.horizon, undefined, { target: "t".repeat(129) })])).toBe(false);
        expect(await commit(U.horizon, [entry(U.horizon, undefined, { projection: "{}" })])).toBe(false);
        expect(await commit(U.horizon, [entry(U.horizon)])).toBe(true);
        const { target: _target, ...noTarget } = (entry(U.horizon) as { data: DocData }).data;
        expect(await commit(U.horizon, [{ op: "set", path: "adminLog/adminLogListXXXXXXXXXX", data: { ...noTarget, action: "shares.list" } }])).toBe(true);
      });

      it("is never changed or deleted, not even by a Horizon admin", async () => {
        expect(await commit(U.horizon, [entry(U.horizon)])).toBe(true);
        expect(await commit(U.horizon, [{ op: "update", path: "adminLog/adminLogEntryXXXXXXXXX", data: { action: "shares.list" } }])).toBe(false);
        expect(await commit(U.horizon, [{ op: "delete", path: "adminLog/adminLogEntryXXXXXXXXX" }])).toBe(false);
        expect(await commit(U.horizon, [entry(U.horizon)])).toBe(false);
      });

      it("is read only by Horizon admins", async () => {
        expect(await commit(U.horizon, [entry(U.horizon)])).toBe(true);
        expect(await get(U.horizon, "adminLog/adminLogEntryXXXXXXXXX")).toBe(true);
        expect(await list(U.horizon, { collection: "adminLog" })).toBe(true);
        for (const uid of [U.owner, U.viewer, U.newcomer, null]) {
          expect(await get(uid, "adminLog/adminLogEntryXXXXXXXXX"), String(uid)).toBe(false);
          expect(await list(uid, { collection: "adminLog", where: [{ field: "by", value: U.horizon }] }), String(uid)).toBe(false);
        }
      });
    });

    describe("bug reports", () => {
      const REPORT = "bugReportOneXXXXXXXXXX";
      const setup = (over: DocData = {}): DocData => ({
        appVersion: "0.1.1", surface: "web", hostMode: false, browser: "Chrome 131", os: "Windows 10",
        windowWidthPx: 1440, windowHeightPx: 900, theme: "dark", cloudMode: "firebase",
        problems: "E-REACH: The robot cannot reach the waypoint.", recentActions: "run.validate, help.reportBug", ...over,
      });
      const report = (uid: string, over: DocData = {}, id = REPORT): Write => ({
        op: "set",
        path: `bugReports/${id}`,
        data: { reporter: uid, createdAt: SERVER_TIME, status: "new", whatHappened: "The path vanished.", setup: setup(), ...over },
      });
      const seeded = { reporter: U.viewer, createdAt: PAST, status: "new", whatHappened: "The path vanished.", setup: setup() };
      const triage = (uid: string, over: DocData = {}): Write => ({
        op: "update", path: `bugReports/${REPORT}`, data: { status: "triaged", updatedBy: uid, updatedAt: SERVER_TIME, ...over },
      });

      it("are sent by a signed-in user with a profile, as themselves, at the moment of the request, with status new", async () => {
        expect(await commit(null, [report("x")])).toBe(false);
        // No profile, no report.
        expect(await commit("kid", [report("kid")])).toBe(false);
        expect(await commit(U.viewer, [report(U.owner)])).toBe(false);
        expect(await commit(U.viewer, [report(U.viewer, { createdAt: PAST })])).toBe(false);
        expect(await commit(U.viewer, [report(U.viewer, { status: "triaged" })])).toBe(false);
        expect(await commit(U.viewer, [report(U.viewer, {}, "short")])).toBe(false);
        expect(await commit(U.viewer, [report(U.viewer)])).toBe(true);
        expect(await commit(U.newcomer, [report(U.newcomer, { expected: "It stays.", steps: "Open, drag, save.", autoFile: "{}" }, "bugReportTwoXXXXXXXXXX")])).toBe(true);
      });

      it("hold exactly the fields the dialog shows, each within its size", async () => {
        const refused: DocData[] = [
          { whatHappened: "" },
          { whatHappened: "w".repeat(4001) },
          { expected: "" },
          { expected: "e".repeat(2001) },
          { steps: "s".repeat(4001) },
          // A snapshot of the auto file is accepted up to its cap and refused over it, and an auto
          // under any other field name is refused as an unknown field.
          { autoFile: "a".repeat(200_001) },
          { autoFile: "" },
          { auto: "{}" },
          { displayName: "Ada" },
          { email: "ada@example.org" },
          { setup: setup({ displayName: "Ada" }) },
          { setup: setup({ surface: "phone" }) },
          { setup: setup({ hostMode: "no" }) },
          { setup: setup({ browser: "" }) },
          { setup: setup({ os: "o".repeat(81) }) },
          { setup: setup({ windowWidthPx: -1 }) },
          { setup: setup({ windowHeightPx: 1.5 }) },
          { setup: setup({ theme: "blue" }) },
          { setup: setup({ cloudMode: "other" }) },
          { setup: setup({ problems: "p".repeat(8001) }) },
          { setup: setup({ recentActions: ["run.validate"] }) },
          { setup: "Chrome" },
        ];
        for (const over of refused) expect(await commit(U.viewer, [report(U.viewer, over)]), JSON.stringify(over).slice(0, 60)).toBe(false);
        expect(await commit(U.viewer, [report(U.viewer, { autoFile: "a".repeat(200_000), setup: setup({ problems: "", recentActions: "" }) })])).toBe(true);
      });

      it("are read, listed, marked and deleted only by Horizon admins, never by their reporter", async () => {
        await h.reset({ ...world(), [`bugReports/${REPORT}`]: seeded });
        for (const uid of [U.viewer, U.owner, U.newcomer, null]) {
          expect(await get(uid, `bugReports/${REPORT}`), String(uid)).toBe(false);
          expect(await list(uid, { collection: "bugReports", where: [{ field: "reporter", value: uid }] }), String(uid)).toBe(false);
          expect(await commit(uid, [triage(uid ?? "x")]), String(uid)).toBe(false);
          expect(await commit(uid, [{ op: "delete", path: `bugReports/${REPORT}` }]), String(uid)).toBe(false);
        }
        expect(await get(U.horizon, `bugReports/${REPORT}`)).toBe(true);
        expect(await list(U.horizon, { collection: "bugReports" })).toBe(true);
        expect(await commit(U.horizon, [triage(U.horizon, { status: "done" })])).toBe(false);
        expect(await commit(U.horizon, [triage(U.owner)])).toBe(false);
        expect(await commit(U.horizon, [triage(U.horizon, { updatedAt: PAST })])).toBe(false);
        expect(await commit(U.horizon, [triage(U.horizon, { whatHappened: "Changed." })])).toBe(false);
        expect(await commit(U.horizon, [triage(U.horizon)])).toBe(true);
        expect(await commit(U.horizon, [triage(U.horizon, { status: "closed" })])).toBe(true);
        expect(await commit(U.horizon, [{ op: "delete", path: `bugReports/${REPORT}` }])).toBe(true);
      });

      it("are never changed by their reporter, even to a valid status", async () => {
        await h.reset({ ...world(), [`bugReports/${REPORT}`]: seeded });
        expect(await commit(U.viewer, [{ op: "update", path: `bugReports/${REPORT}`, data: { whatHappened: "Edited." } }])).toBe(false);
        expect(await commit(U.viewer, [report(U.viewer)])).toBe(false);
      });

      it("log a Horizon admin's list and status change in the admin access log", async () => {
        const entry = (action: string, target?: string): Write => ({
          op: "set",
          path: `adminLog/adminLog${action.replace(".", "")}XXXXXXXXXX`.slice(0, 31),
          data: { by: U.horizon, at: SERVER_TIME, action, ...(target === undefined ? {} : { target }) },
        });
        expect(await commit(U.horizon, [entry("reports.list")])).toBe(true);
        await h.reset({ ...world(), [`bugReports/${REPORT}`]: seeded });
        expect(await commit(U.horizon, [triage(U.horizon), entry("report.status", REPORT)])).toBe(true);
      });
    });

    describe("the private beta", () => {
      const TESTER = "tess"; // named by the owner in betaTesters, no profile yet
      const STRANGER = "stan"; // signed in, not named, no profile yet
      const profile = (uid: string): Write => ({
        op: "set", path: `users/${uid}`, data: { displayName: uid, createdAt: SERVER_TIME },
      });
      const redeem = (uid: string) => joinWrites(uid, INVITE.live, "pending", "editor", 1);
      /**
       * The world as a real project starts it, with no config/access, so the beta is closed; Tess named
       * as a tester; and the Horizon admin's profile not yet made. The newcomer has a profile from
       * before and is not named.
       */
      const closedWorld = (extra: Record<string, DocData> = {}): Record<string, DocData> => {
        const docs: Record<string, DocData> = { ...world(), [`betaTesters/${TESTER}`]: { name: "Tess" }, ...extra };
        delete docs[`users/${U.horizon}`];
        return docs;
      };

      beforeEach(async () => {
        await raw.reset(closedWorld());
      });

      it("is closed by default: nobody who is not named creates a profile or redeems an invite", async () => {
        expect(await commit(STRANGER, [profile(STRANGER)])).toBe(false);
        expect(await commit(U.newcomer, redeem(U.newcomer))).toBe(false);
        expect(await commit(null, [profile(STRANGER)])).toBe(false);
        expect(await h.peek(`users/${STRANGER}`)).toBeNull();
        expect(await h.peek(`teams/${A}/members/${U.newcomer}`)).toBeNull();
      });

      it("lets a named tester create a profile and redeem an invite", async () => {
        expect(await commit(TESTER, [profile(TESTER)])).toBe(true);
        expect(await commit(TESTER, redeem(TESTER))).toBe(true);
        expect((await h.peek(`teams/${A}/members/${TESTER}`))?.role).toBe("pending");
        // Naming one person lets in nobody else.
        expect(await commit(STRANGER, [profile(STRANGER)])).toBe(false);
      });

      it("lets a Horizon admin in without being named", async () => {
        expect(await commit(U.horizon, [profile(U.horizon)])).toBe(true);
        expect(await commit(U.horizon, redeem(U.horizon))).toBe(true);
      });

      it("opens to everyone when config/access says betaOpen: true", async () => {
        await raw.reset(closedWorld({ "config/access": { betaOpen: true } }));
        expect(await commit(STRANGER, [profile(STRANGER)])).toBe(true);
        expect(await commit(U.newcomer, redeem(U.newcomer))).toBe(true);
        expect(await commit(null, [profile(STRANGER)])).toBe(false);
      });

      it("stays closed when betaOpen is false, missing or anything but true", async () => {
        for (const access of [{ betaOpen: false }, {}, { betaOpen: "true" }, { betaOpen: 1 }, { betaOpen: null }]) {
          await raw.reset(closedWorld({ "config/access": access }));
          expect(await commit(STRANGER, [profile(STRANGER)]), JSON.stringify(access)).toBe(false);
          expect(await commit(U.newcomer, redeem(U.newcomer)), JSON.stringify(access)).toBe(false);
        }
      });

      it("refuses every write to the switch from the app, even a Horizon admin's, and any change to a tester entry", async () => {
        await raw.reset(closedWorld({ "config/access": { betaOpen: false } }));
        for (const uid of [U.horizon, STRANGER, TESTER]) {
          expect(await commit(uid, [{ op: "update", path: `betaTesters/${TESTER}`, data: { name: "Changed" } }]), uid).toBe(false);
          expect(await commit(uid, [{ op: "update", path: "config/access", data: { betaOpen: true } }]), uid).toBe(false);
          expect(await commit(uid, [{ op: "set", path: "config/access", data: { betaOpen: true } }]), uid).toBe(false);
          expect(await commit(uid, [{ op: "delete", path: "config/access" }]), uid).toBe(false);
        }
        expect(await h.peek("config/access")).toEqual({ betaOpen: false });
        expect(await h.peek(`betaTesters/${TESTER}`)).toEqual({ name: "Tess" });
      });

      // ---------------------------------------------------------------- the beta dashboard (2026-10-02)

      const ask = (uid: string, over: DocData = {}): Write => ({
        op: "set", path: `betaRequests/${uid}`, data: { name: "Stan", createdAt: SERVER_TIME, ...over },
      });
      const logEntry = (action: string, target: string, id = "adminLogBetaXXXXXXXXXX"): Write => ({
        op: "set", path: `adminLog/${id}`, data: { by: U.horizon, at: SERVER_TIME, action, target },
      });

      it("lets nobody ask for beta access any more, nor change a request left from before (issue #99)", async () => {
        // Asking was removed on 2026-10-03: a person sends their user code to a Horizon admin instead.
        expect(await commit(null, [ask(STRANGER)])).toBe(false);
        expect(await commit(STRANGER, [ask(STRANGER)])).toBe(false);
        expect(await commit(STRANGER, [ask(STRANGER, { email: "stan@example.org", emailVerified: false })])).toBe(false);
        expect(await commit(TESTER, [ask(TESTER)])).toBe(false);
        expect(await commit(U.horizon, [ask(STRANGER)])).toBe(false);
        expect(await commit(U.horizon, [ask(U.horizon)])).toBe(false);
        await raw.reset(closedWorld({ "config/access": { betaOpen: true } }));
        expect(await commit(STRANGER, [ask(STRANGER)])).toBe(false);
        expect(await h.peek(`betaRequests/${STRANGER}`)).toBeNull();
        // A leftover request is never changed or replaced, by its sender or by an admin.
        await raw.reset(closedWorld({ [`betaRequests/${STRANGER}`]: { name: "Stan", createdAt: PAST } }));
        for (const uid of [STRANGER, U.horizon]) {
          expect(await commit(uid, [ask(STRANGER, { name: "Stanley" })]), uid).toBe(false);
          expect(await commit(uid, [{ op: "update", path: `betaRequests/${STRANGER}`, data: { name: "Changed" } }]), uid).toBe(false);
        }
        expect(await h.peek(`betaRequests/${STRANGER}`)).toMatchObject({ name: "Stan" });
      });

      it("lets the sender and Horizon admins read and delete a leftover request, nobody else, and only admins list them", async () => {
        const seeded = { [`betaRequests/${STRANGER}`]: { name: "Stan", createdAt: PAST } };
        await raw.reset(closedWorld(seeded));
        expect(await get(STRANGER, `betaRequests/${STRANGER}`)).toBe(true);
        expect(await get(TESTER, `betaRequests/${STRANGER}`)).toBe(false);
        expect(await get(U.owner, `betaRequests/${STRANGER}`)).toBe(false);
        expect(await get(null, `betaRequests/${STRANGER}`)).toBe(false);
        expect(await get(U.horizon, `betaRequests/${STRANGER}`)).toBe(true);
        expect(await list(U.horizon, { collection: "betaRequests" })).toBe(true);
        expect(await list(STRANGER, { collection: "betaRequests" })).toBe(false);
        expect(await list(STRANGER, { collection: "betaRequests", where: [{ field: "name", value: "Stan" }] })).toBe(false);
        expect(await commit(U.owner, [{ op: "delete", path: `betaRequests/${STRANGER}` }])).toBe(false);
        expect(await commit(TESTER, [{ op: "delete", path: `betaRequests/${STRANGER}` }])).toBe(false);
        expect(await commit(STRANGER, [{ op: "delete", path: `betaRequests/${STRANGER}` }])).toBe(true);
        await raw.reset(closedWorld(seeded));
        expect(await commit(U.horizon, [{ op: "delete", path: `betaRequests/${STRANGER}` }])).toBe(true);
        expect(await h.peek(`betaRequests/${STRANGER}`)).toBeNull();
      });

      it("lets only Horizon admins add and remove beta testers, with exactly a name, so nobody adds themselves", async () => {
        await raw.reset(closedWorld({ [`betaRequests/${STRANGER}`]: { name: "Stan", createdAt: PAST } }));
        // Adding by user code deletes the person's leftover request in the same write.
        const add: Write[] = [
          { op: "set", path: `betaTesters/${STRANGER}`, data: { name: "Stan" } },
          { op: "delete", path: `betaRequests/${STRANGER}` },
        ];
        // The person, a tester and a team owner cannot add anyone, not even themselves.
        for (const uid of [STRANGER, TESTER, U.owner]) {
          expect(await commit(uid, add), uid).toBe(false);
          expect(await commit(uid, [{ op: "set", path: `betaTesters/${uid}`, data: { name: uid } }]), uid).toBe(false);
        }
        expect(await h.peek(`betaRequests/${STRANGER}`)).not.toBeNull();
        expect(await commit(U.horizon, [{ op: "set", path: `betaTesters/${STRANGER}`, data: { name: "" } }])).toBe(false);
        expect(await commit(U.horizon, [{ op: "set", path: `betaTesters/${STRANGER}`, data: { name: "n".repeat(81) } }])).toBe(false);
        expect(await commit(U.horizon, [{ op: "set", path: `betaTesters/${STRANGER}`, data: { name: "Stan", email: "stan@example.org" } }])).toBe(false);
        expect(await commit(U.horizon, [...add, logEntry("beta.add", STRANGER)])).toBe(true);
        expect(await h.peek(`betaTesters/${STRANGER}`)).toEqual({ name: "Stan" });
        expect(await h.peek(`betaRequests/${STRANGER}`)).toBeNull();
        expect(await commit(STRANGER, [{ op: "set", path: `users/${STRANGER}`, data: { displayName: "Stan", createdAt: SERVER_TIME } }])).toBe(true);
        // Removing: a tester cannot take themselves or anyone else off; an admin can.
        expect(await commit(TESTER, [{ op: "delete", path: `betaTesters/${TESTER}` }])).toBe(false);
        expect(await commit(STRANGER, [{ op: "delete", path: `betaTesters/${TESTER}` }])).toBe(false);
        expect(await commit(U.horizon, [{ op: "delete", path: `betaTesters/${TESTER}` }, logEntry("beta.remove", TESTER, "adminLogBetaRemoveXXXX")])).toBe(true);
        expect(await h.peek(`betaTesters/${TESTER}`)).toBeNull();
      });

      it("lets Horizon admins add and remove admins with exactly a name, and never remove themselves", async () => {
        const SECOND = "sue"; // a second Horizon admin
        await raw.reset(closedWorld({ [`admins/${SECOND}`]: { name: "Sue" } }));
        expect(await commit(STRANGER, [{ op: "set", path: `admins/${STRANGER}`, data: { name: "Stan" } }])).toBe(false);
        expect(await commit(TESTER, [{ op: "set", path: `admins/${STRANGER}`, data: { name: "Stan" } }])).toBe(false);
        expect(await commit(U.horizon, [{ op: "set", path: `admins/${STRANGER}`, data: {} }])).toBe(false);
        expect(await commit(U.horizon, [{ op: "set", path: `admins/${STRANGER}`, data: { name: "Stan", role: "owner" } }])).toBe(false);
        expect(await commit(U.horizon, [{ op: "update", path: `admins/${SECOND}`, data: { name: "Changed" } }])).toBe(false);
        expect(await commit(U.horizon, [{ op: "set", path: `admins/${STRANGER}`, data: { name: "Stan" } }, logEntry("admin.add", STRANGER)])).toBe(true);
        // Nobody removes themselves, so no admin locks themselves out; anyone else may go.
        expect(await commit(U.horizon, [{ op: "delete", path: `admins/${U.horizon}` }])).toBe(false);
        expect(await commit(STRANGER, [{ op: "delete", path: `admins/${STRANGER}` }])).toBe(false);
        expect(await commit(U.owner, [{ op: "delete", path: `admins/${SECOND}` }])).toBe(false);
        expect(await commit(U.horizon, [{ op: "delete", path: `admins/${SECOND}` }, logEntry("admin.remove", SECOND, "adminLogAdminRemoveXXX")])).toBe(true);
        // The admin just added may remove the one who added them.
        expect(await commit(STRANGER, [{ op: "delete", path: `admins/${U.horizon}` }])).toBe(true);
        expect(await h.peek(`admins/${U.horizon}`)).toBeNull();
        expect(await h.peek(`admins/${STRANGER}`)).toEqual({ name: "Stan" });
      });

      it("takes the beta dashboard's entries in the admin access log", async () => {
        for (const [index, action] of ["beta.list", "beta.approve", "beta.decline", "beta.add", "beta.remove", "admin.add", "admin.remove"].entries()) {
          expect(await commit(U.horizon, [logEntry(action, STRANGER, `adminLogBeta${String(index)}XXXXXXXXX`)]), action).toBe(true);
        }
        expect(await commit(U.horizon, [logEntry("beta.open", STRANGER, "adminLogBetaOpenXXXXXX")])).toBe(false);
      });

      it("lets a tester read their own entry and not another's, and Horizon admins read and list them all", async () => {
        expect(await get(TESTER, `betaTesters/${TESTER}`)).toBe(true);
        // Their own, missing: how the app tells a person they are not on the list yet.
        expect(await get(STRANGER, `betaTesters/${STRANGER}`)).toBe(true);
        expect(await get(STRANGER, `betaTesters/${TESTER}`)).toBe(false);
        expect(await get(null, `betaTesters/${TESTER}`)).toBe(false);
        expect(await list(TESTER, { collection: "betaTesters" })).toBe(false);
        expect(await list(TESTER, { collection: "betaTesters", where: [{ field: "name", value: "Tess" }] })).toBe(false);
        expect(await get(U.horizon, `betaTesters/${TESTER}`)).toBe(true);
        expect(await list(U.horizon, { collection: "betaTesters" })).toBe(true);
      });

      it("lets anyone signed in read the switch, and nobody list it", async () => {
        expect(await get(STRANGER, "config/access")).toBe(true);
        expect(await get(null, "config/access")).toBe(false);
        await raw.reset(closedWorld({ "config/access": { betaOpen: true } }));
        expect(await get(STRANGER, "config/access")).toBe(true);
        expect(await list(U.horizon, { collection: "config" })).toBe(false);
        expect(await get(STRANGER, "config/other")).toBe(false);
      });

      it("never gates what someone already has: changing their name, leaving a team, removing devices and deleting their profile", async () => {
        expect(await commit(U.newcomer, [{ op: "update", path: `users/${U.newcomer}`, data: { displayName: "Nina" } }])).toBe(true);
        expect(await commit(U.viewer, [{ op: "delete", path: `teams/${A}/members/${U.viewer}` }])).toBe(true);
        expect(await commit(U.newcomer, [{ op: "delete", path: `users/${U.newcomer}/devices/${deviceOf(U.newcomer)}` }])).toBe(true);
        expect(await commit(U.newcomer, [{ op: "delete", path: `users/${U.newcomer}` }])).toBe(true);
        // A tester taken off the list deletes their account and data just the same.
        await raw.reset(closedWorld({ [`users/${TESTER}`]: { displayName: TESTER, createdAt: PAST } }));
        expect(await commit(TESTER, [{ op: "delete", path: `users/${TESTER}` }])).toBe(true);
      });

      it("gates founding a team and sending a bug report through the profile", async () => {
        const T = "teamStrangerSSSSSSSSSS";
        const founding: Write[] = [
          { op: "set", path: `teams/${T}`, data: { number: null, name: "Strangers", status: "unverified", createdBy: STRANGER, createdAt: SERVER_TIME, encKey: encKey(NEW_SEED) } },
          { op: "set", path: `teams/${T}/members/${STRANGER}`, data: { uid: STRANGER, teamId: T, role: "owner", displayName: STRANGER, joinedAt: SERVER_TIME } },
          ...keyFoundingWrites(STRANGER, T, { withDevice: true }),
        ];
        expect(await commit(STRANGER, [profile(STRANGER), ...founding])).toBe(false);
        expect(await h.peek(`teams/${T}`)).toBeNull();
      });

      // The whole founding batch: the team, the owner membership, the claim on a number and its first
      // history step, team key record 1, the recovery record and the founder's grant. With the beta
      // check it stays within 10 reads for the team's write and 20 distinct documents for the batch.
      const foundsWithNumber = (uid: string, teamId: string, teamNumber: number): Write[] => [
        {
          op: "set",
          path: `teams/${teamId}`,
          data: { number: teamNumber, name: "Founded", status: "unverified", createdBy: uid, createdAt: SERVER_TIME, encKey: encKey(NEW_SEED) },
        },
        { op: "set", path: `teams/${teamId}/members/${uid}`, data: { uid, teamId, role: "owner", displayName: uid, joinedAt: SERVER_TIME } },
        { op: "set", path: `claims/${String(teamNumber)}`, data: { teamId, status: "unverified", claimedAt: SERVER_TIME, historyCount: 1 } },
        stepWrite(teamNumber, 0, claimEntry("claim", teamId, uid)),
        ...keyFoundingWrites(uid, teamId),
      ];
      const bugReport = (uid: string): Write => ({
        op: "set",
        path: "bugReports/bugReportBetaXXXXXXXXX",
        data: {
          reporter: uid, createdAt: SERVER_TIME, status: "new", whatHappened: "The path vanished.",
          setup: {
            appVersion: "0.1.1", surface: "web", hostMode: false, browser: "Chrome 131", os: "Windows 10",
            windowWidthPx: 1440, windowHeightPx: 900, theme: "dark", cloudMode: "firebase", problems: "", recentActions: "",
          },
        },
      });

      it("refuses founding a team, claiming a number and sending a bug report to a profile that is not on the list", async () => {
        // The newcomer has a profile from before the gate, as a tester taken off the list does.
        const T = "teamNewcomerNNNNNNNNNN";
        expect(await commit(U.newcomer, foundsWithNumber(U.newcomer, T, 424242))).toBe(false);
        expect(await commit(U.newcomer, foundWrites(U.newcomer, T))).toBe(false);
        expect(await h.peek(`teams/${T}`)).toBeNull();
        expect(await h.peek("claims/424242")).toBeNull();
        expect(await commit(U.newcomer, [bugReport(U.newcomer)])).toBe(false);
        expect(await h.peek("bugReports/bugReportBetaXXXXXXXXX")).toBeNull();
      });

      it("lets a named tester with a profile found a team with a number, keys and a grant, and send a bug report", async () => {
        await raw.reset(
          closedWorld({
            [`users/${TESTER}`]: { displayName: TESTER, createdAt: PAST },
            [`users/${TESTER}/devices/${deviceOf(TESTER)}`]: deviceDoc(),
          }),
        );
        const T = "teamTesterTTTTTTTTTTTT";
        expect(await commit(TESTER, foundsWithNumber(TESTER, T, 424242))).toBe(true);
        expect((await h.peek(`teams/${T}/members/${TESTER}`))?.role).toBe("owner");
        expect((await h.peek("claims/424242"))?.teamId).toBe(T);
        expect(await commit(TESTER, [bugReport(TESTER)])).toBe(true);
        // A Horizon admin founds one without being named.
        await raw.reset(closedWorld());
        expect(await commit(U.horizon, [profile(U.horizon)])).toBe(true);
        expect(await commit(U.horizon, foundsWithNumber(U.horizon, "teamHorizonHHHHHHHHHHH", 424243)), "closed").toBe(true);
      });
    });

    describe("user profiles", () => {
      it("are read and written only by their owner, with exactly a display name and the time", async () => {
        expect(await get(U.owner, `users/${U.owner}`)).toBe(true);
        expect(await get(U.admin, `users/${U.owner}`)).toBe(false);
        expect(await get(null, `users/${U.owner}`)).toBe(false);
        const profile = { displayName: "Kid", createdAt: SERVER_TIME };
        // The age-screen answer is gone (owner ruling 2026-10-02), and no other field is taken in its place.
        expect(await commit("kid", [{ op: "set", path: "users/kid", data: { ...profile, over13: true } }])).toBe(false);
        expect(await commit("kid", [{ op: "set", path: "users/kid", data: { ...profile, birthYear: 2012 } }])).toBe(false);
        expect(await commit("kid", [{ op: "set", path: "users/kid", data: { ...profile, createdAt: PAST } }])).toBe(false);
        expect(await commit("kid", [{ op: "set", path: "users/kid", data: { createdAt: SERVER_TIME } }])).toBe(false);
        expect(await commit("kid", [{ op: "set", path: "users/other", data: profile }])).toBe(false);
        expect(await commit("kid", [{ op: "set", path: "users/kid", data: profile }])).toBe(true);
        expect(await commit(U.owner, [{ op: "update", path: `users/${U.owner}`, data: { birthYear: 2012 } }])).toBe(false);
      });

      it("made before the age screen was removed still change their name, and keep nothing new", async () => {
        await h.reset({ ...world(), "users/old": { displayName: "Old", over13: true, createdAt: PAST } });
        expect(await commit("old", [{ op: "update", path: "users/old", data: { displayName: "Renamed" } }])).toBe(true);
        const renamed = await h.peek("users/old");
        expect(Object.keys(renamed ?? {}).sort()).toEqual(["createdAt", "displayName", "over13"]);
        expect(renamed?.displayName).toBe("Renamed");
        expect(await commit("old", [{ op: "update", path: "users/old", data: { over13: false } }])).toBe(false);
        expect(await commit("old", [{ op: "delete", path: "users/old" }])).toBe(true);
      });

      // Measured on the emulator: a rules string's size() counts UTF-16 code units, as JavaScript's
      // length does, not code points, characters or bytes. An emoji outside the Basic Multilingual
      // Plane is two units, so 40 of them fill a limit of 80 exactly.
      it("count a name's length in UTF-16 code units, as the rules engine does", async () => {
        const named = (uid: string, displayName: string): Write[] => [
          { op: "set", path: `users/${uid}`, data: { displayName, createdAt: SERVER_TIME } },
        ];
        expect(await commit("kid1", named("kid1", "\u{1F600}".repeat(40)))).toBe(true);
        expect(await commit("kid2", named("kid2", `${"\u{1F600}".repeat(40)}a`))).toBe(false);
        expect(await commit("kid3", named("kid3", "e\u0301".repeat(40)))).toBe(true);
        expect(await commit("kid4", named("kid4", "\u20ac".repeat(80)))).toBe(true);
        expect(await commit("kid5", named("kid5", "\u20ac".repeat(81)))).toBe(false);
      });
    });
  });
}
