/**
 * The team a proposal is from, and the team a sent proposal went to, are named by the number the
 * server writes on that team. When this device pinned that number to a different team, the name
 * says the team only claims it, as a received share from such a team does.
 */
import { describe, expect, it } from "vitest";
import type { MemoryDatabase } from "@horizon36596/zenith-cloud/memory";
import { cloudWorld, ownerSawPartnerCodes, publishTo, uidOf, type Caller, type CloudWorld } from "./cloudFixture.test";
import { createCloudProposalsApi } from "./proposalsApi";
import { fromTeamWords } from "./words";

/** A propose share from the owner to both partners, and a proposal from the second partner on it. */
async function proposalFromSecondPartner(world: CloudWorld) {
  ownerSawPartnerCodes(world);
  const { owner } = world;
  const [partner, third] = world.partners as [CloudWorld["partners"][0], CloudWorld["partners"][0]];
  const at = await publishTo(owner, "first-auto.auto.json", '{"kind":"auto"}\n');
  const checks = await owner.backend.checkPartnerKeys([partner.teamId, third.teamId]);
  const made = await owner.backend.createShare({
    teamId: owner.teamId, autoId: at.autoId, revision: at.revisionId, audience: "teams", teamIds: [partner.teamId, third.teamId], level: "propose",
    mode: "pinned", projection: '{"s":"one"}', expectedKeys: Object.fromEntries(checks.map((check) => [check.teamId, check.keyId])),
  });
  await made.sent;
  await (await third.backend.sendProposal({ shareId: made.value.id, fromTeamId: third.teamId, baseRevision: at.revisionId, diff: '{"from":"23456"}' })).sent;
  return { partner, third };
}

/** Makes the server say team `teamId` holds `number`, to the device of `uid` only. */
function serverSaysNumber(world: CloudWorld, uid: string, teamId: string, number: number): void {
  const db = world.database as MemoryDatabase;
  const realRead = db.read.bind(db);
  db.read = (caller: Caller, path: string) => {
    const doc = realRead(caller, path);
    return uidOf(caller) === uid && path === `teams/${teamId}` && doc !== null ? ({ ...doc, number } as never) : doc;
  };
}

describe("the team a received proposal is from", () => {
  it("is a team claiming the number when this device pinned that number to another team", async () => {
    const world = await cloudWorld([12345, 23456]);
    const { partner, third } = await proposalFromSecondPartner(world);
    serverSaysNumber(world, world.owner.uid, third.teamId, 12345);
    expect(world.owner.backend.teamNumberPin(12345)?.teamId).toBe(partner.teamId);

    const listed = await createCloudProposalsApi(world.owner.backend).list(world.owner.teamId, "received");
    expect(listed.map((proposal) => [proposal.fromTeamId, proposal.fromTeam, proposal.text])).toEqual([
      [third.teamId, "A team claiming to be 12345", '{"from":"23456"}'],
    ]);
    // The same words a received share from that team has.
    expect(listed[0]?.fromTeam).toBe(fromTeamWords({ fromTeamNumber: 12345, fromTeamName: "Partner team 2", fromTeamCheck: { kind: "mismatch" } }));
  });

  it("is named by its number when this device pinned that number to that team", async () => {
    const world = await cloudWorld([12345, 23456]);
    const { third } = await proposalFromSecondPartner(world);
    expect(world.owner.backend.teamNumberPin(23456)?.teamId).toBe(third.teamId);

    const listed = await createCloudProposalsApi(world.owner.backend).list(world.owner.teamId, "received");
    expect(listed.map((proposal) => [proposal.fromTeamId, proposal.fromTeam])).toEqual([[third.teamId, "Team 23456 (unverified)"]]);
  });
});

describe("the team a sent proposal went to", () => {
  it("is a team claiming the number when the proposing device pinned that number to another team", async () => {
    const world = await cloudWorld([12345, 23456]);
    const { partner, third } = await proposalFromSecondPartner(world);
    // The third team's device knows 36596 as another team, and the server says the owner holds it.
    third.backend.pinTeamNumber(36596, partner.teamId, { safetyCodeSeen: true });

    const listed = await createCloudProposalsApi(third.backend).list(third.teamId, "sent");
    expect(listed.map((proposal) => [proposal.ownerTeamId, proposal.ownerTeam])).toEqual([[world.owner.teamId, "A team claiming to be 36596"]]);
    third.backend.pinTeamNumber(36596, world.owner.teamId, { safetyCodeSeen: true });
    const again = await createCloudProposalsApi(third.backend).list(third.teamId, "sent");
    expect(again.map((proposal) => proposal.ownerTeam)).toEqual(["Team 36596 (unverified)"]);
  });
});
