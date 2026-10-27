/**
 * The team a share is from, when it claims an FTC number. The server writes a team's number, name and
 * status, so a team of its own can claim the number of a team this device shares with. A proposal to
 * a share whose team claims a number this device and user pinned to another team is refused before
 * anything is sealed to that team's key. Against `MemoryBackend`, whose rules are the in-memory copy
 * of cloud/firestore.rules; `database.seed` plays a server that writes whatever it likes.
 */
import { describe, expect, it } from "vitest";
import { MemoryDeviceKeyStore } from "../src/crypto/index.js";
import { isCloudError, type CloudErrorCode } from "../src/errors.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import { MemoryTrustStore } from "../src/keys/trust.js";
import { numberInTeamName } from "../src/teamNumbers.js";
import type { DocData } from "../src/store.js";

/** Few PBKDF2 iterations for approval codes, as in `memory.keys.test.ts`: the count does not change what an approval checks. */
const FAST_APPROVAL_KDF = 10;

async function code(promise: Promise<unknown>): Promise<CloudErrorCode | "allowed"> {
  try {
    await promise;
  } catch (error) {
    if (isCloudError(error)) return error.code;
    throw error;
  }
  return "allowed";
}

async function teamWithAuto(database: MemoryDatabase, uid: string, number: number | null, name: string) {
  const owner = new MemoryBackend({ database, deviceKeys: new MemoryDeviceKeyStore(), trust: new MemoryTrustStore() });
  owner.signInAs(uid);
  await (await owner.saveProfile({ displayName: uid })).sent;
  const created = await owner.createTeam({ number, name });
  await created.sent;
  const teamId = created.value.id;
  const auto = await owner.createAuto(teamId, { title: `${name} auto` });
  await auto.sent;
  const r1 = await owner.publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: "{}" });
  await r1.sent;
  return { owner, teamId, autoId: auto.value.id, r1: r1.value.id };
}

describe("a proposal to a share", () => {
  it("is refused when the sharing team claims a number this device pinned to another team", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    // Partner shares with Alpha, so Partner's device pins 1111 to Alpha.
    p.owner.pinTeamNumber(1111, a.teamId, { safetyCodeSeen: true });
    // The server's own team takes number 1111 and shares with Partner.
    const fake = await teamWithAuto(database, "server", 9999, "Fake");
    const fakeDoc = database.peek(`teams/${fake.teamId}`) as DocData;
    database.seed(`teams/${fake.teamId}`, { ...fakeDoc, number: 1111, name: "Alpha" });
    const made = await fake.owner.createShare({ teamId: fake.teamId, autoId: fake.autoId, revision: fake.r1, audience: "teams", teamIds: [p.teamId], level: "propose", projection: "{}" });
    await made.sent;
    const propose = () => p.owner.sendProposal({ shareId: made.value.id, fromTeamId: p.teamId, baseRevision: fake.r1, diff: '{"v":"idea"}' }).then((q) => q.sent);
    expect(await code(propose())).toBe("key-changed");
    expect(await fake.owner.listProposals(fake.teamId, "received")).toEqual([]);

    // Pinned to the sharing team itself, the same proposal goes.
    p.owner.pinTeamNumber(1111, fake.teamId, { safetyCodeSeen: true });
    expect(await code(propose())).toBe("allowed");
  });
});

describe("a proposal to a share from a team with no number", () => {
  /** Partner pins 1111 to Alpha; the server's own team drops its number and takes the name `name`. */
  async function numberlessFake(name: string) {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const a = await teamWithAuto(database, "alice", 1111, "Alpha");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    p.owner.pinTeamNumber(1111, a.teamId, { safetyCodeSeen: true });
    const fake = await teamWithAuto(database, "server", 9999, "Fake");
    const fakeDoc = database.peek(`teams/${fake.teamId}`) as DocData;
    database.seed(`teams/${fake.teamId}`, { ...fakeDoc, number: null, name });
    const made = await fake.owner.createShare({ teamId: fake.teamId, autoId: fake.autoId, revision: fake.r1, audience: "teams", teamIds: [p.teamId], level: "propose", projection: "{}" });
    await made.sent;
    const propose = () => p.owner.sendProposal({ shareId: made.value.id, fromTeamId: p.teamId, baseRevision: fake.r1, diff: '{"v":"idea"}' }).then((q) => q.sent);
    return { p, fake, propose };
  }

  for (const name of ["1111", "Team 1111", "#1111", "\uff11\uff11\uff11\uff11"]) {
    it(`is refused when its name, ${JSON.stringify(name)}, reads as a number this device pinned to another team`, async () => {
      const { p, fake, propose } = await numberlessFake(name);
      expect(await code(propose())).toBe("key-changed");
      expect(await fake.owner.listProposals(fake.teamId, "received")).toEqual([]);

      // Pinned to the sharing team itself, the same proposal goes.
      p.owner.pinTeamNumber(1111, fake.teamId, { safetyCodeSeen: true });
      expect(await code(propose())).toBe("allowed");
    });
  }

  it("goes when its name reads as no number this device pinned, on the key it first saw, as a first share from a number does", async () => {
    const { propose } = await numberlessFake("Spare Parts");
    expect(await code(propose())).toBe("allowed");
    const other = await numberlessFake("3333");
    expect(await code(other.propose())).toBe("allowed");
  });

  it("goes from an honest team made with no number", async () => {
    const database = new MemoryDatabase({ approvalKdfIterations: FAST_APPROVAL_KDF });
    const spare = await teamWithAuto(database, "sam", null, "Spare Parts");
    const p = await teamWithAuto(database, "olga", 2222, "Partner");
    const made = await spare.owner.createShare({ teamId: spare.teamId, autoId: spare.autoId, revision: spare.r1, audience: "teams", teamIds: [p.teamId], level: "propose", projection: "{}" });
    await made.sent;
    await (await p.owner.sendProposal({ shareId: made.value.id, fromTeamId: p.teamId, baseRevision: spare.r1, diff: '{"v":"idea"}' })).sent;
    expect((await spare.owner.listProposals(spare.teamId, "received")).map((proposal) => proposal.diff)).toEqual(['{"v":"idea"}']);
  });
});

describe("the number a team's name reads as", () => {
  it("reads a name a person would take for a team number", () => {
    for (const name of ["36596", " 36596 ", "Team 36596", "team36596", "TEAM #36596", "#36596", "FTC 36596", "\uff13\uff16\uff15\uff19\uff16", "36\u200b596", "36 596", "036596"]) {
      expect(numberInTeamName(name), name).toBe(36596);
    }
  });

  it("reads nothing from a name that is not a number", () => {
    for (const name of ["Horizon", "Team Horizon", "36596 Horizon", "Horizon 36596", "", "Team", "#", "3.14", "-36596", "1e5"]) {
      expect(numberInTeamName(name), name).toBeNull();
    }
  });
});
