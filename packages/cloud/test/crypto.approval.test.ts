/**
 * The approval code (crypto/approval.ts) and the team signing chain (crypto/team.ts): how a code is
 * typed and read, that its first part is bound to the device's keys, the team, the member and the
 * secret, that the MAC binds the team key
 * and who is approved, and that each team key version must be signed by the one below it.
 */
import { describe, expect, it } from "vitest";
import {
  APPROVAL_CODE_CHARACTERS,
  approvalCodeFor,
  approvalKey,
  approvalPublicPart,
  approvalSecretFrom,
  checkApprovalMac,
  checkTeamKeyStep,
  createTeamKeys,
  formatApprovalCode,
  generateDeviceKeys,
  makeApprovalMac,
  newApprovalSecret,
  normaliseApprovalCode,
  openChain,
  rotateTeamKeys,
  teamKeyFingerprint,
} from "../src/crypto/index.js";
import { counting, flip, rejectsWith } from "./cryptoHelpers.js";

const teamId = "t_team0000000000000001";
/** Few PBKDF2 iterations, so these tests stay fast; the known-answer test uses the real count. */
const FAST = 10;

describe("approval codes", () => {
  it("is 18 characters in three groups of six, and reads back whatever the case, spacing and look-alikes", async () => {
    const device = await generateDeviceKeys();
    const secret = newApprovalSecret();
    const subject = { teamId, uid: "ada", fingerprint: device.fingerprint };
    const code = await approvalCodeFor(subject, secret);
    expect(APPROVAL_CODE_CHARACTERS).toBe(18);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}-[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(normaliseApprovalCode(code)).toHaveLength(18);
    expect(formatApprovalCode(code.replaceAll("-", ""))).toBe(code);
    const typed = ` ${code.toLowerCase().replaceAll("-", " ")} `.replaceAll("0", "o").replaceAll("1", "l");
    expect(await approvalSecretFrom(typed, subject)).toEqual(secret);
    expect(normaliseApprovalCode("ab-c d_e.f")).toBe("ABCDEF");
    expect(normaliseApprovalCode("oil")).toBe("011");
    expect(formatApprovalCode("abcdefghjkmn")).toBe("ABCDEF-GHJKMN");
  });

  it("gives another device, team, member or secret a different first part, so the approver's check refuses the code", async () => {
    const real = await generateDeviceKeys();
    const forged = await generateDeviceKeys();
    const secret = newApprovalSecret();
    const subject = { teamId, uid: "ada", fingerprint: real.fingerprint };
    const code = await approvalCodeFor(subject, secret);
    const part = await approvalPublicPart(subject, secret);
    expect(await approvalPublicPart({ ...subject, fingerprint: forged.fingerprint }, secret)).not.toBe(part);
    expect(await approvalPublicPart({ ...subject, teamId: "t_team0000000000000002" }, secret)).not.toBe(part);
    expect(await approvalPublicPart({ ...subject, uid: "eve" }, secret)).not.toBe(part);
    expect(await approvalPublicPart(subject, newApprovalSecret())).not.toBe(part);
    expect(await approvalSecretFrom(code, { ...subject, fingerprint: forged.fingerprint })).toBeNull();
    expect(await approvalSecretFrom(code, { ...subject, teamId: "t_team0000000000000002" })).toBeNull();
    expect(await approvalSecretFrom(code, { ...subject, uid: "eve" })).toBeNull();
    // A typo in the random last part is caught too, because that part is hashed into the first.
    const last = code.slice(-1);
    expect(await approvalSecretFrom(`${code.slice(0, -1)}${last === "0" ? "1" : "0"}`, subject)).toBeNull();
    expect(await approvalSecretFrom(code.slice(0, -1), subject)).toBeNull();
    expect(await approvalSecretFrom(`${code}0`, subject)).toBeNull();
    expect(await approvalSecretFrom(code.replace(/.$/, "U"), subject)).toBeNull();
    expect(await approvalSecretFrom("", subject)).toBeNull();
  });

  it("checks a MAC only for the same secret, device, member, team key, team public keys and device roster", async () => {
    const device = await generateDeviceKeys();
    const team = await createTeamKeys(teamId);
    const other = await createTeamKeys(teamId);
    const secret = newApprovalSecret(counting(7));
    const key = await approvalKey({ teamId, deviceId: device.deviceId, secret, iterations: FAST });
    const rosterDigest = new Uint8Array(32).fill(3);
    const subject = { teamId, deviceId: device.deviceId, uid: "ada", teamKey: team.key, encFingerprint: team.pair.fingerprint, signSpki: team.pair.signSpki, rosterDigest };
    const mac = await makeApprovalMac(key, subject);
    expect(await checkApprovalMac(key, subject, mac)).toBe(true);
    expect(await checkApprovalMac(key, subject, flip(mac))).toBe(false);
    expect(await checkApprovalMac(key, { ...subject, uid: "eve" }, mac)).toBe(false);
    expect(await checkApprovalMac(key, { ...subject, deviceId: "d_other0000000000000001" }, mac)).toBe(false);
    // A team key the server made up, even with the real team's public keys, does not check.
    expect(await checkApprovalMac(key, { ...subject, teamKey: other.key }, mac)).toBe(false);
    expect(await checkApprovalMac(key, { ...subject, encFingerprint: other.pair.fingerprint }, mac)).toBe(false);
    expect(await checkApprovalMac(key, { ...subject, signSpki: other.pair.signSpki }, mac)).toBe(false);
    // Nor does another device roster under the same key: the new device takes the one the approver checked.
    expect(await checkApprovalMac(key, { ...subject, rosterDigest: new Uint8Array(32).fill(4) }, mac)).toBe(false);
    await rejectsWith(makeApprovalMac(key, { ...subject, rosterDigest: new Uint8Array(31) }), "bad-key");
    const wrongSecret = await approvalKey({ teamId, deviceId: device.deviceId, secret: flip(secret), iterations: FAST });
    expect(await checkApprovalMac(wrongSecret, subject, mac)).toBe(false);
    const otherSalt = await approvalKey({ teamId: "t_team0000000000000002", deviceId: device.deviceId, secret, iterations: FAST });
    expect(await checkApprovalMac(otherSalt, subject, mac)).toBe(false);
    await rejectsWith(approvalKey({ teamId, deviceId: device.deviceId, secret: new Uint8Array(4) }), "bad-input");
  });
});

describe("the team signing chain", () => {
  it("signs each version's public keys with the version below, and a partner can walk it", async () => {
    const v1 = await createTeamKeys(teamId);
    const v2 = await rotateTeamKeys(teamId, v1);
    const v3 = await rotateTeamKeys(teamId, v2);
    expect(v1.encKey.sig).toBeNull();
    expect(await checkTeamKeyStep(teamId, v1.encKey.signSpki, v2.encKey)).toBe(true);
    expect(await checkTeamKeyStep(teamId, v2.encKey.signSpki, v3.encKey)).toBe(true);
    // Not by a version two below, not for another team, and not with a swapped key.
    expect(await checkTeamKeyStep(teamId, v1.encKey.signSpki, v3.encKey)).toBe(false);
    expect(await checkTeamKeyStep("t_elsewhere0000000000001", v1.encKey.signSpki, v2.encKey)).toBe(false);
    expect(await checkTeamKeyStep(teamId, v1.encKey.signSpki, { ...v2.encKey, fingerprint: v3.encKey.fingerprint })).toBe(false);
    expect(await checkTeamKeyStep(teamId, v1.encKey.signSpki, { ...v2.encKey, signSpki: v3.encKey.signSpki })).toBe(false);
    expect(await checkTeamKeyStep(teamId, v1.encKey.signSpki, { ...v2.encKey, sig: null })).toBe(false);
  });

  it("refuses a rotation the server made up with its own signing key", async () => {
    const real = await createTeamKeys(teamId);
    const forgedBase = await createTeamKeys(teamId);
    const forged = await rotateTeamKeys(teamId, forgedBase);
    expect(await checkTeamKeyStep(teamId, real.encKey.signSpki, forged.encKey)).toBe(false);
  });

  it("refuses a chain whose record carries a signature by another key", async () => {
    const v1 = await createTeamKeys(teamId);
    const v2 = await rotateTeamKeys(teamId, v1);
    const stranger = await rotateTeamKeys(teamId, await createTeamKeys(teamId));
    await rejectsWith(openChain(teamId, v2.key, [{ ...v2.record, sig: stranger.record.sig }, v1.record]), "bad-signature");
    await rejectsWith(openChain(teamId, v2.key, [{ ...v2.record, signSpki: stranger.record.signSpki }, v1.record]), "decrypt-failed");
    expect(await teamKeyFingerprint(v2.record.pairSpki)).toEqual(v2.encKey.fingerprint);
  });
});
