/**
 * The sharing adapter's partner-key check (spec 14 section 4.6), and a share to a team this device
 * never looked up, made while offline (the owner's test walk), against the in-memory cloud and its
 * real rules.
 */
import { describe, expect, it } from "vitest";
import { createTeamKeys, teamEncKeyFor } from "@horizon36596/zenith-cloud/crypto";
import type { MemoryDatabase } from "@horizon36596/zenith-cloud/memory";
import { NOW_MS, cloudWorld, publishTo, uidOf, type Caller, type CloudMember } from "./cloudFixture.test";
import { createCloudSharingApi } from "./cloudSharingApi";
import { NO_ANSWERS, answerOptions, withAnswer } from "./keyAnswers";
import type { CreateShareOptions, PartnerKeyWarning, ShareRequest } from "./types";

const DAY = 86_400_000;
const PROJECTION = '{"kind":"projection"}';

/** The options the share dialog sends once the person chose to send on every one of `warnings`. */
const answerEach = (warnings: readonly PartnerKeyWarning[]): CreateShareOptions => answerOptions(warnings.reduce(withAnswer, NO_ANSWERS));

async function setup() {
  const world = await cloudWorld([12345, 23456]);
  const at = await publishTo(world.owner, "first-auto.auto.json", '{"kind":"auto"}\n');
  const results: Array<{ ok: boolean; sentence: string }> = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const api = createCloudSharingApi(world.owner.backend, {
    now: () => NOW_MS,
    onPendingResult: (result) => {
      results.push(result);
      for (const waiter of waiters) if (results.length >= waiter.count) waiter.resolve();
    },
  });
  /**
   * Settles once `count` shares that waited for the connection have been told how they went. They
   * are made in the background after the connection is back, as long as their lookups take.
   */
  const told = (count: number): Promise<void> =>
    results.length >= count ? Promise.resolve() : new Promise((resolve) => waiters.push({ count, resolve }));
  const request = (teamNumbers: number[]): ShareRequest => ({
    autoId: at.autoId,
    audience: "teams",
    teamNumbers,
    level: "view",
    mode: "pinned",
    revision: at.n,
    revisionId: at.revisionId,
    expiresAt: new Date(NOW_MS + 7 * DAY).toISOString(),
    projection: PROJECTION,
  });
  return { world, api, request, results, told };
}

/**
 * Plays a server that shows a partner's key different from the one this device pinned for it: the
 * pin keeps its version and signing key, and only its fingerprint changes.
 */
function forgePin(backend: unknown, uid: string, teamId: string): void {
  const trust = (backend as { trust: { get(key: string): string | null; set(key: string, value: string): void } }).trust;
  const key = `zenith.pin.partner.${uid}.${teamId}`;
  const pin = JSON.parse(trust.get(key) ?? "null") as { v: number; sk: string } | null;
  if (pin === null) throw new Error("expected a pin for the partner team");
  trust.set(key, JSON.stringify({ ...pin, fp: "A".repeat(43) }));
}

describe("partner keys before a share", () => {
  it("shows a team seen for the first time with its safety code, and warns about nothing for the same key", async () => {
    const { world, api, request } = await setup();
    const shown = await api.checkPartnerKeys([12345]);
    expect(shown.map((warning) => warning.kind)).toEqual(["first-use"]);
    await api.createShare(world.owner.teamId, request([12345]), answerEach(shown));
    expect(await api.checkPartnerKeys([12345])).toEqual([]);
  });

  it("warns about a changed key with the team's safety code, and shares only once it is accepted", async () => {
    const { world, api, request } = await setup();
    const partner = world.partners[0];
    if (partner === undefined) throw new Error("no partner");
    await api.createShare(world.owner.teamId, request([12345]), answerEach(await api.checkPartnerKeys([12345])));
    forgePin(world.owner.backend, world.owner.uid, partner.teamId);

    // Team 23456 is new to this device, so it is shown with its safety code once.
    const warnings = await api.checkPartnerKeys([12345, 23456]);
    expect(warnings.map((warning) => [warning.kind, warning.teamNumber])).toEqual([
      ["key-changed", 12345],
      ["first-use", 23456],
    ]);
    expect(warnings[0]).toMatchObject({ teamNumber: 12345, teamName: "Partner team 1" });
    // The warning shows the code of the key the server shows now, the one a Continue would trust;
    // the partner's code this device knows is still the pinned key's.
    expect(warnings[0]?.safetyCode).toBe((await world.owner.backend.checkPartnerKeys([partner.teamId]))[0]?.safetyCode);
    expect(await world.owner.backend.teamSafetyCode(partner.teamId)).toMatchObject({ pinned: true, serverKeyDiffers: true });

    await expect(api.createShare(world.owner.teamId, request([12345]))).rejects.toThrow(/safety code/);
    const made = await api.createShare(world.owner.teamId, request([12345]), answerEach(warnings.slice(0, 1)));
    expect(made.teamNumbers).toEqual([12345]);
    expect(await api.checkPartnerKeys([12345])).toEqual([]);
  });
});

/**
 * `member` joins the team `owner` owns, its device is granted that team's key, and it opens an auto
 * of that team, which pins the team's key on that device.
 */
async function joinWithKey(owner: CloudMember, member: CloudMember): Promise<void> {
  await (await owner.backend.createAuto(owner.teamId, { title: "Partner auto" })).sent;
  const invite = await owner.backend.createInvite(owner.teamId, { role: "editor", autoApprove: true });
  await invite.sent;
  await (await member.backend.redeemInvite(invite.value.code)).sent;
  const status = await member.backend.teamKeyStatus(owner.teamId);
  if (status.state !== "waiting") throw new Error("That device already holds the team key.");
  await (await owner.backend.grantDeviceKey(owner.teamId, status.device.deviceId, status.approvalCode)).sent;
  expect(await member.backend.listAutos(owner.teamId)).toHaveLength(1);
}

describe("a partner team the sharer is a member of, shown with a key that is not its own", () => {
  it("is refused before the dialog asks anything, and no answer makes the share", async () => {
    const { world, api, request } = await setup();
    const partner = world.partners[0];
    if (partner === undefined) throw new Error("no partner");
    await joinWithKey(partner, world.owner);
    // The server shows the owner's device a key of its own for team 12345, at the same version.
    const forged = teamEncKeyFor((await createTeamKeys(partner.teamId)).pair);
    const db = world.database as MemoryDatabase;
    const realRead = db.read.bind(db);
    db.read = (caller: Caller, path: string) => {
      const doc = realRead(caller, path);
      return uidOf(caller) === world.owner.uid && path === `teams/${partner.teamId}` && doc !== null ? ({ ...doc, encKey: forged } as never) : doc;
    };
    const [check] = await world.owner.backend.checkPartnerKeys([partner.teamId]);
    expect(check?.status).toBe("member-key-differs");

    await expect(api.checkPartnerKeys([12345])).rejects.toThrow(
      "Team 12345 shows a key that is not the one this device holds for it. You are a member of that team, so this device holds its real key, and the key shown may be the server's own. Nothing was sent.",
    );
    const answers: CreateShareOptions = {
      acceptKeyChanges: [12345],
      safetyCodesSeen: [12345],
      shownKeys: { 12345: { teamId: partner.teamId, keyId: check?.keyId ?? "" } },
    };
    await expect(api.createShare(world.owner.teamId, request([12345]), answers)).rejects.toThrow(/holds that team's real key/);
    expect(await api.listShares(world.owner.teamId)).toEqual([]);
  });
});

describe("a share to a team not looked up yet, made offline", () => {
  it("waits on the page instead of failing, and once back asks for the team's safety code to be seen first", async () => {
    const { world, api, request, results, told } = await setup();
    await world.owner.backend.setOnline(false);
    // Offline, the team cannot be checked yet: nothing to warn about now.
    expect(await api.checkPartnerKeys([23456])).toEqual([]);
    const waiting = await api.createShare(world.owner.teamId, request([23456]));
    expect(waiting).toMatchObject({ queued: true, waitsForConnection: true, teamNumbers: [23456] });
    expect(await world.owner.backend.listTeamShares(world.owner.teamId)).toEqual([]);

    // This device never showed team 23456's safety code, so the share is not made without it.
    await world.owner.backend.setOnline(true);
    // The share that waited sends in the background once the connection is back.
    await told(1);
    expect(results).toEqual([
      {
        ok: false,
        sentence:
          "Did not share with team 23456: this device has not shown you that team's safety code yet. Share again to see it, and compare it with that team.",
        // The share dialog that showed "Waiting to share" finds its result by this id.
        waitingId: waiting.id,
      },
    ]);
    expect(await api.listShares(world.owner.teamId)).toEqual([]);
  });

  it("says plainly, once online, when the number turns out to be nobody's", async () => {
    const { world, api, request, results, told } = await setup();
    await world.owner.backend.setOnline(false);
    await api.createShare(world.owner.teamId, request([99999]));
    await world.owner.backend.setOnline(true);
    // The share that waited sends in the background once the connection is back.
    await told(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.sentence).toMatch(/^Did not share with team 99999: No team on Zenith has claimed number 99999/);
  });

  it("still shares offline at once, through the Outbox, with a team looked up before", async () => {
    const { world, api, request } = await setup();
    expect((await api.checkPartnerKeys([12345])).map((warning) => warning.kind)).toEqual(["first-use"]);
    await world.owner.backend.setOnline(false);
    const made = await api.createShare(world.owner.teamId, request([12345]));
    expect(made.queued).toBe(true);
    expect(made.waitsForConnection).toBeUndefined();
  });

  it("marks a share queued when the connection drops while it is being made", async () => {
    const { world, api, request } = await setup();
    const backend = world.owner.backend;
    const options = answerEach(await api.checkPartnerKeys([12345]));
    const create = backend.createShare.bind(backend);
    // Online when the send starts, offline by the time the create returns: the share waits in the Outbox.
    backend.createShare = async (input) => {
      const queued = await create(input);
      await backend.setOnline(false);
      return queued;
    };
    const made = await api.createShare(world.owner.teamId, request([12345]), options);
    expect(made.queued).toBe(true);
  });
});
