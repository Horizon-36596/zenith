/**
 * The M-C7 flows through `MemoryBackend` with a clock the test moves, which the emulator suites
 * cannot do: the 14-day appeal window, and one Horizon admin deciding everything alone (owner ruling
 * 2026-10-01): an appeal of their own decision, and a request from a team they are a member of.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { isCloudError } from "../src/errors.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";
import { MemoryDatabase } from "../src/memory/memoryStore.js";
import { SERVER_TIME } from "../src/store.js";

const DAY_MS = 24 * 60 * 60 * 1000;

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "allowed";
  } catch (error) {
    if (isCloudError(error)) return error.code;
    throw error;
  }
}

describe("verification with a moving clock (MemoryBackend)", () => {
  let clock: number;
  let database: MemoryDatabase;
  const user = async (uid: string, profile = true) => {
    const backend = new MemoryBackend({ database, now: () => new Date(clock) });
    backend.signInAs(uid);
    if (profile) await (await backend.saveProfile({ displayName: uid })).sent;
    return backend;
  };

  /** Alice holds 36596, Olga contests it, Hana gives it to Olga. */
  const decided = async () => {
    const alice = await user("alice");
    const holder = await alice.createTeam({ number: 36596, name: "Horizon" });
    await holder.sent;
    const olga = await user("olga");
    const challenger = await olga.createTeam({ number: null, name: "Other" });
    await challenger.sent;
    const claimed = await olga.claimNumber(challenger.value.id, 36596);
    await claimed.sent;
    const disputeId = claimed.value.outcome === "contested" ? claimed.value.dispute.id : "";
    const hana = await user("hana", false);
    await (await hana.decideDispute(disputeId, { winner: challenger.value.id, reason: "Listed at an event as 36596." })).sent;
    return { alice, olga, hana, disputeId, holderId: holder.value.id, challengerId: challenger.value.id };
  };

  beforeEach(() => {
    clock = Date.parse("2026-10-01T12:00:00Z");
    database = new MemoryDatabase({ now: () => new Date(clock) });
    database.seed("admins/hana", { name: "The one reviewer" });
  });

  it("takes an appeal on day 13 of the window", async () => {
    const { alice, disputeId, holderId } = await decided();
    clock += 13 * DAY_MS;
    expect(await code(alice.appealDispute(disputeId, { team: holderId, reason: "Our banner shows it." }).then((q) => q.sent))).toBe("allowed");
  });

  it("refuses an appeal after 14 days, in the client and in the rules", async () => {
    const { alice, disputeId, holderId } = await decided();
    clock += 15 * DAY_MS;
    expect(await code(alice.appealDispute(disputeId, { team: holderId, reason: "Late." }))).toBe("invalid");
    const raw = alice.connection.commit([
      { op: "update", path: `disputes/${disputeId}`, data: { status: "appealed", appeal: { team: holderId, by: "alice", reason: "Late.", at: SERVER_TIME } } },
    ]);
    expect(await code(raw.sent)).toBe("permission-denied");
  });

  it("lets the reviewer who made the first decision decide the appeal alone, and records who", async () => {
    const { alice, olga, disputeId, holderId, challengerId } = await decided();
    clock += DAY_MS;
    await (await alice.appealDispute(disputeId, { team: holderId, reason: "Our banner shows it." })).sent;
    // A team admin who is not a Horizon admin still cannot decide it, even past the client.
    const raw = olga.connection.commit([
      { op: "update", path: `disputes/${disputeId}`, data: { status: "final", appealDecision: { winner: challengerId, reason: "Ours.", by: "olga", at: SERVER_TIME } } },
    ]);
    expect(await code(raw.sent)).toBe("permission-denied");

    const hana = await user("hana", false);
    expect((await hana.listReviewQueue()).appeals.map((d) => d.id)).toEqual([disputeId]);
    await (await hana.decideAppeal(disputeId, { winner: holderId, reason: "The banner photo carries the claim code." })).sent;
    expect(await alice.getDispute(disputeId)).toMatchObject({ status: "final", decision: { by: "hana" }, appealDecision: { winner: holderId, by: "hana" } });
    expect(await alice.getClaim(36596)).toMatchObject({ teamId: holderId, status: "verified" });
    expect(await alice.getTeam(challengerId)).toMatchObject({ number: null, status: "unverified" });
  });

  it("lets a Horizon admin who is a member of the team verify its number, and records who", async () => {
    const hana = await user("hana");
    const team = await hana.createTeam({ number: 36596, name: "Horizon" });
    await team.sent;
    const asked = await hana.requestVerification(team.value.id, [{ kind: "statement", summary: "We are 36596." }]);
    await asked.sent;
    await (await hana.decideVerification(asked.value.id, { verdict: "verified", reason: "The event results list this team as 36596." })).sent;
    expect(await hana.getTeam(team.value.id)).toMatchObject({ number: 36596, status: "verified" });
    const history = (await hana.getClaim(36596, team.value.id))?.history ?? [];
    expect(history.map((e) => [e.kind, e.by])).toEqual([["claim", "hana"], ["request", "hana"], ["verify", "hana"]]);
  });

  it("will not let a team contest a second number while its first review is open", async () => {
    const alice = await user("alice");
    await (await alice.createTeam({ number: 11111, name: "One" })).sent;
    const olga = await user("olga");
    const team = await olga.createTeam({ number: null, name: "Other" });
    await team.sent;
    await (await olga.claimNumber(team.value.id, 11111)).sent;
    expect(await code(olga.claimNumber(team.value.id, 22222))).toBe("conflict");
  });
});
