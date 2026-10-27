/**
 * Diverged revisions in the review view (spec 13 section 5.3), against the in-memory cloud and its
 * real permission rules: which side is the user's, what Keep publishes, that nothing is overwritten
 * or removed, and the base revision each Library row names (section 5.1).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints, setPose } from "@horizon36596/zenith-core";
import type { CloudBackend, Member, Revision } from "@horizon36596/zenith-cloud";
import { MemoryBackend, MemoryDatabase } from "@horizon36596/zenith-cloud/memory";
import { AccountModel } from "../account/model";
import { memoryStorage } from "../account/storage";
import { openDivergence, revisionRows } from "./libraryModel";
import { describePair, keepPlan, keepWords, pairReviewModel, publishKeep, solidWords } from "./revisionReview";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/starter/${path}`, import.meta.url)), "utf8");
const robotText = read("autos/robot.json");
const fieldText = read("autos/field/biobuzz.field.json");
const project = {
  robot: loadRobot(JSON.parse(robotText)),
  field: loadField(JSON.parse(fieldText)),
  waypoints: loadWaypoints(JSON.parse(read("autos/waypoints.json"))),
};
const TITLE = "first-auto.auto.json";
const original = loadAuto(JSON.parse(read("autos/first-auto.auto.json")));
/** The first leg's end, placed explicitly at a y of `yIn`, as a drag in the editor would. */
const version = (yIn: number): string =>
  canonicalize(
    "auto",
    setPose(original, "driveOut", { segmentIndex: 0, pointKind: "to" }, { xIn: -12, yIn, headingRad: 1.5708, provenance: "SET FROM EDITOR: test" }),
  );

const NOW = Date.parse("2026-09-27T12:00:00Z");

/**
 * A cloud whose devices derive approval codes' keys with few iterations. The app's 600,000 take about
 * a quarter of a second each and these tests make fourteen, which on a busy Windows machine was
 * enough to pass five seconds; `crypto.vectors.test.ts` checks the real count.
 */
function world() {
  let t = NOW;
  const database = new MemoryDatabase({ now: () => new Date((t += 1000)), approvalKdfIterations: 10 });
  return database;
}

/** A signed-in person on their own device, as the page's `AccountModel` sees them. */
async function person(database: MemoryDatabase, provider: "github" | "google", name: string) {
  let backend: MemoryBackend | null = null;
  const said: string[] = [];
  const model = new AccountModel({
    mode: "fake",
    storage: memoryStorage(),
    now: () => NOW,
    pageUrl: () => "http://localhost/?cloud=fake#/",
    createBackend: async () => {
      backend = new MemoryBackend({ database });
      return backend;
    },
    say: (_kind, text) => {
      said.push(text);
    },
  });
  await model.start();
  model.open("signIn");
  await model.signInWith(provider);
  await model.saveDisplayName(name);
  const own = (): MemoryBackend => {
    if (backend === null) throw new Error("not started");
    return backend;
  };
  return { model, said, uid: () => model.getState().user?.uid ?? "", backend: own };
}

/**
 * Gives the team key to each waiting device, typing the approval code its screen shows, as `granter`
 * (spec 14).
 */
async function grantWaiting(granter: CloudBackend, teamId: string, ...waiting: CloudBackend[]): Promise<void> {
  for (const device of waiting) {
    const status = await device.teamKeyStatus(teamId);
    if (status.state !== "waiting") continue;
    await (await granter.grantDeviceKey(teamId, status.device.deviceId, status.approvalCode)).sent;
  }
}


/**
 * Ada and Grace in one team. Ada publishes revision 1; each then publishes from it, Ada first, so
 * Grace's revision 2 is the diverged one.
 */
async function divergedTeam() {
  const database = world();
  const ada = await person(database, "github", "Ada");
  await ada.model.createTeam({ number: 36596, name: "Horizon" });
  const invite = await ada.model.createInvite({ role: "editor", expiry: { kind: "days", days: 7 }, maxUses: 1, autoApprove: true });
  const grace = await person(database, "google", "Grace");
  await grace.model.openJoin(invite?.code ?? "");
  await grace.model.redeemJoin();
  await grantWaiting(ada.backend(), ada.model.getState().teamId ?? "", grace.backend());

  const r1 = await ada.model.publish({ fileName: TITLE, canonical: version(-36), project });
  await grace.model.refreshLibrary();
  const autoId = grace.model.getState().library.autos[0]?.id ?? "";
  grace.model.markOpened(autoId, r1?.id ?? "");
  const r2ada = await ada.model.publish({ fileName: TITLE, canonical: version(-48), project });
  const r2grace = await grace.model.publish({ fileName: TITLE, canonical: version(-24), project });
  await ada.model.refreshLibrary();
  await ada.model.refreshTeam();
  const revisions = (): Revision[] => ada.model.getState().library.revisions[autoId] ?? [];
  const members = (): Member[] => ada.model.getState().team?.members ?? [];
  if (r1 === null || r2ada === null || r2grace === null) throw new Error("a publish failed");
  return { ada, grace, autoId, r1, r2ada, r2grace, revisions, members };
}

describe("a diverged pair in the review view (spec 13 section 5.3)", () => {
  it("names Ada's own revision mine and Grace's theirs, with the base both came from", async () => {
    const team = await divergedTeam();
    expect(team.r2grace.diverged).toBe(true);
    const pair = describePair({
      revisions: team.revisions(),
      ids: [team.r2grace.id, team.r2ada.id],
      members: team.members(),
      uid: team.ada.uid(),
      deviceBase: team.ada.model.baseOf(team.autoId),
    });
    if (typeof pair === "string") throw new Error(pair);
    expect(pair.diverged).toBe(true);
    expect(pair.commonBaseN).toBe(1);
    expect(pair.moreSiblings).toBe(0);
    expect(pair.whyNoKeep).toBeNull();
    expect([pair.first.revision.id, pair.first.name, pair.first.keepLabel]).toEqual([team.r2ada.id, "Mine", "Keep mine"]);
    expect([pair.second.revision.id, pair.second.name, pair.second.keepLabel]).toEqual([team.r2grace.id, "Theirs", "Keep theirs"]);
    expect(pair.second.authorName).toBe("Grace");
    expect(solidWords(pair, "second")).toBe("Theirs is the solid path; mine is the dashed ghost under it.");
    expect(keepWords(pair, "second")).toMatch(/^Publishes theirs as revision 3, built on mine/);
  });

  it("tells the sides apart by author on a device that has neither as its base", async () => {
    const team = await divergedTeam();
    const pair = describePair({
      revisions: team.revisions(),
      ids: [team.r2ada.id, team.r2grace.id],
      members: team.members(),
      uid: null,
      deviceBase: team.r1.id,
    });
    if (typeof pair === "string") throw new Error(pair);
    expect([pair.first.name, pair.second.name]).toEqual(["Ada's", "Grace's"]);
    expect([pair.first.keepLabel, pair.second.keepLabel]).toEqual(["Keep Ada's", "Keep Grace's"]);
    expect([pair.first.owner, pair.second.owner]).toEqual(["unknown", "unknown"]);
  });

  it("diffs the ghost against the solid side with what the change does to the time", async () => {
    const team = await divergedTeam();
    const pair = describePair({
      revisions: team.revisions(),
      ids: [team.r2ada.id, team.r2grace.id],
      members: team.members(),
      uid: team.ada.uid(),
      deviceBase: team.ada.model.baseOf(team.autoId),
    });
    if (typeof pair === "string") throw new Error(pair);
    const model = pairReviewModel(pair, "second", project);
    if (typeof model === "string") throw new Error(model);
    expect(model.identical).toBe(false);
    expect(model.rows.map((row) => [row.kind, row.stepId])).toEqual([["changed", "driveOut"]]);
    // Grace's end is 24 in from Ada's: the pose moved, and the ghost (Ada's) is the base plan.
    expect(model.rows[0]?.movedIn).toBeCloseTo(24, 5);
    expect(model.basePlan).not.toBeNull();
    // Swapped, the same change reads the other way round.
    const swapped = pairReviewModel(pair, "first", project);
    if (typeof swapped === "string") throw new Error(swapped);
    expect(swapped.totals.deltaS).toBeCloseTo(-(model.totals.deltaS ?? 0), 6);
  });

  it("keeps theirs as revision 3 built on mine, and overwrites or removes nothing", async () => {
    const team = await divergedTeam();
    const before = team.revisions().map((revision) => ({ id: revision.id, content: revision.content }));
    expect(openDivergence(team.revisions()).map((revision) => revision.id)).toEqual([team.r2ada.id, team.r2grace.id]);
    const pair = describePair({
      revisions: team.revisions(),
      ids: [team.r2ada.id, team.r2grace.id],
      members: team.members(),
      uid: team.ada.uid(),
      deviceBase: team.ada.model.baseOf(team.autoId),
    });
    if (typeof pair === "string") throw new Error(pair);
    const plan = keepPlan(pair, "second");
    if (typeof plan === "string") throw new Error(plan);
    expect([plan.keep.id, plan.over.id, plan.n]).toEqual([team.r2grace.id, team.r2ada.id, 3]);

    const kept = await publishKeep(team.ada.model, TITLE, plan, project);
    expect(kept?.n).toBe(3);
    expect(kept?.diverged).toBe(false);
    expect(kept?.baseRevision).toBe(team.r2ada.id);
    expect(kept?.content).toBe(team.r2grace.content);

    const after = team.revisions();
    // Every earlier revision is still there with its own content, and one was added.
    expect(after.filter((revision) => revision.n < 3).map((revision) => ({ id: revision.id, content: revision.content }))).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(openDivergence(after)).toEqual([]);
    // This device now builds on the kept revision.
    expect(team.ada.model.baseOf(team.autoId)).toBe(kept?.id);

    // Once revision 3 exists, the old pair is history: Keep is not offered on it again.
    const settled = describePair({
      revisions: after,
      ids: [team.r2ada.id, team.r2grace.id],
      members: team.members(),
      uid: team.ada.uid(),
      deviceBase: team.ada.model.baseOf(team.autoId),
    });
    if (typeof settled === "string") throw new Error(settled);
    expect(settled.whyNoKeep).toMatch(/Revision 3 was published after these two/);
    expect(typeof keepPlan(settled, "first")).toBe("string");
  });

  it("puts this device's base back when a Keep cannot be published", async () => {
    const team = await divergedTeam();
    await team.ada.model.refreshTeam();
    const graceUid = team.members().find((member) => member.displayName === "Grace")?.uid ?? "";
    await team.ada.model.setRole(graceUid, "viewer");
    await team.grace.model.refreshTeam();
    await team.grace.model.refreshLibrary();
    const base = team.grace.model.baseOf(team.autoId);
    const pair = describePair({
      revisions: team.grace.model.getState().library.revisions[team.autoId] ?? [],
      ids: [team.r2grace.id, team.r2ada.id],
      members: team.members(),
      uid: team.grace.uid(),
      deviceBase: base,
    });
    if (typeof pair === "string") throw new Error(pair);
    const plan = keepPlan(pair, "first");
    if (typeof plan === "string") throw new Error(plan);
    expect(await publishKeep(team.grace.model, TITLE, plan, project)).toBeNull();
    expect(team.grace.model.getState().error).toMatch(/Viewers/);
    expect(team.grace.model.baseOf(team.autoId)).toBe(base);
  });

  it("compares two revisions on one line with the older ghosted, and offers no Keep", async () => {
    const team = await divergedTeam();
    const pair = describePair({
      revisions: team.revisions(),
      ids: [team.r2ada.id, team.r1.id],
      members: team.members(),
      uid: team.ada.uid(),
      deviceBase: null,
    });
    if (typeof pair === "string") throw new Error(pair);
    expect(pair.diverged).toBe(false);
    expect([pair.first.revision.id, pair.second.revision.id]).toEqual([team.r1.id, team.r2ada.id]);
    expect(pair.whyNoKeep).toMatch(/did not diverge/);
    expect(typeof keepPlan(pair, "second")).toBe("string");
    expect(describePair({ revisions: team.revisions(), ids: [team.r1.id, "gone"], members: [], uid: null, deviceBase: null })).toMatch(
      /no longer in the library/,
    );
  });
});

describe("the base revision in each Library row (spec 13 section 5.1)", () => {
  it("names the revision each one was published from, and marks the later of two from one base", async () => {
    const team = await divergedTeam();
    const rows = revisionRows(team.revisions(), team.members(), null);
    expect(rows.map((row) => [row.n, row.authorName, row.baseN, row.diverged])).toEqual([
      [2, "Grace", 1, true],
      [2, "Ada", 1, false],
      [1, "Ada", null, false],
    ]);
  });
});
