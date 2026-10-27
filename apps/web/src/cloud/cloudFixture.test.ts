/**
 * A small cloud for the sharing tests: one in-memory database with the real permission rules
 * (`packages/cloud/src/memory/rules.ts`), Horizon's team and three partner teams on it, each with
 * its own signed-in member, and a way to publish a revision to Horizon's library. Every test of the
 * sharing adapter and store runs against it, so none of them depends on a fake that could accept
 * what the real rules refuse.
 *
 * The partner teams' names are placeholders; the only real team named is Horizon (FTC 36596).
 */
import { describe, expect, it } from "vitest";
import type { RandomBytes } from "@horizon36596/zenith-cloud";
import { MemoryBackend, MemoryDatabase } from "@horizon36596/zenith-cloud/memory";

/** 27 September 2026, noon UTC: the device clock of every sharing test. */
/** Who a read of the in-memory database comes from, as `MemoryDatabase.read` takes it. */
export type Caller = Parameters<MemoryDatabase["read"]>[0];

/** The uid a caller of the in-memory database signs in as, or null when signed out. */
export function uidOf(caller: Caller): string | null {
  return caller;
}

export const NOW_MS = Date.parse("2026-09-27T12:00:00Z");

/**
 * Random bytes from a fixed sequence, so every id in a test is the same on every run and a check
 * that searches stored text for a secret cannot pass or fail by chance.
 */
export function fixedRandom(seed: number): RandomBytes {
  let state = seed >>> 0;
  return (length) => {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      bytes[i] = state >>> 24;
    }
    return bytes;
  };
}

export interface CloudMember {
  uid: string;
  backend: MemoryBackend;
  teamId: string;
  teamNumber: number;
}

export interface CloudWorld {
  database: MemoryDatabase;
  /** Horizon's owner, whose team shares. */
  owner: CloudMember;
  /** One owner per partner team, in the order of the numbers asked for. */
  partners: CloudMember[];
  /** A backend on the same database with nobody signed in: someone opening a link. */
  stranger: MemoryBackend;
}

let seeds = 1;

/** A signed-in member with a profile and a team of their own. */
export async function memberWithTeam(database: MemoryDatabase, uid: string, teamNumber: number, name: string): Promise<CloudMember> {
  const backend = new MemoryBackend({ database, random: fixedRandom(seeds++) });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: name })).sent;
  const team = await backend.createTeam({ number: teamNumber, name });
  await team.sent;
  return { uid, backend, teamId: team.value.id, teamNumber };
}

/** Horizon and its partners on one database whose server clock starts at `NOW_MS`. */
export async function cloudWorld(partnerNumbers: readonly number[] = [12345, 23456, 34567]): Promise<CloudWorld> {
  let t = NOW_MS;
  // Few iterations for an approval code's key: each team made here derives one, and the app's
  // 600,000 take about a quarter of a second each. `crypto.vectors.test.ts` checks the real count.
  const database = new MemoryDatabase({ now: () => new Date((t += 1)), approvalKdfIterations: 10 });
  const owner = await memberWithTeam(database, "horizon-owner", 36596, "Horizon");
  const partners: CloudMember[] = [];
  for (const [index, number] of partnerNumbers.entries()) {
    partners.push(await memberWithTeam(database, `partner-${String(index + 1)}`, number, `Partner team ${String(index + 1)}`));
  }
  return { database, owner, partners, stranger: new MemoryBackend({ database, random: fixedRandom(seeds++) }) };
}

/**
 * Records on the owner's device that the person saw each partner's safety code under its number,
 * as a share made earlier through the dialog would. A share made online to a team whose code this
 * device never showed is refused, so every test that is not about the first share with a team
 * starts from here.
 */
export function ownerSawPartnerCodes(world: CloudWorld): void {
  for (const partner of world.partners) {
    world.owner.backend.pinTeamNumber(partner.teamNumber, partner.teamId, { safetyCodeSeen: true });
  }
}

export interface PublishedAt {
  autoId: string;
  revisionId: string;
  n: number;
}

/** Publishes `content` as the next revision of the library auto titled `title`, making it on first use. */
export async function publishTo(
  member: CloudMember,
  title: string,
  content: string,
  files: { robot?: string; field?: string; waypoints?: string } = {},
): Promise<PublishedAt> {
  const { backend, teamId } = member;
  const autos = await backend.listAutos(teamId);
  let auto = autos.find((entry) => entry.title === title);
  if (auto === undefined) {
    const made = await backend.createAuto(teamId, { title });
    await made.sent;
    auto = made.value;
  }
  const revisions = await backend.listRevisions(teamId, auto.id);
  const base = revisions[revisions.length - 1]?.id ?? null;
  const published = await backend.publishRevision({ teamId, autoId: auto.id, baseRevision: base, content, ...files });
  await published.sent;
  return { autoId: auto.id, revisionId: published.value.id, n: published.value.n };
}

describe("the sharing tests' cloud", () => {
  it("holds Horizon and its partners, each a team of its own on its own number", async () => {
    const world = await cloudWorld([12345]);
    expect((await world.owner.backend.findTeamByNumber(36596))?.id).toBe(world.owner.teamId);
    expect((await world.owner.backend.findTeamByNumber(12345))?.id).toBe(world.partners[0]?.teamId);
    const first = await publishTo(world.owner, "first-auto.auto.json", "{}\n");
    const second = await publishTo(world.owner, "first-auto.auto.json", "{ }\n");
    expect([first.n, second.n]).toEqual([1, 2]);
    expect(second.autoId).toBe(first.autoId);
  });
});
