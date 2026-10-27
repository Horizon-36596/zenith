import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  loadAuto,
  loadField,
  loadLink,
  loadRobot,
  loadWaypoints,
  plan as planAuto,
  projectShare,
  resolve,
  runLedger,
  simulateRun,
} from "@horizon36596/zenith-core";
import { seasonFor } from "@horizon36596/zenith-seasons";
import { childLists, parseProjection, type Auto, type Projection, type Step } from "@horizon36596/zenith-schema";
import { describe, expect, it, vi } from "vitest";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { runSim } from "../state/sim";
import { closeProject, currentDerived, openAuto, openProject } from "../state/store";
import { projectTexts } from "../library/libraryModel";
import { NOW_MS, cloudWorld, ownerSawPartnerCodes, publishTo, type CloudWorld, type PublishedAt } from "./cloudFixture.test";
import { createCloudSharingApi } from "./cloudSharingApi";
import {
  boxCornersAt,
  buildProjection,
  includesCommands,
  isCoarsened,
  levelOf,
  projectionBuildCount,
  projectionTitle,
  storedChoice,
  projectionEndS,
  projectionPoseAt,
  structureRows,
  type ProjectionSource,
} from "./projectionModel";
import {
  addTeam,
  DEFAULT_DRAFT,
  draftProjectionChoice,
  draftSettings,
  draftToRequest,
  newerRevisionFor,
  withAudience,
  type ShareDraft,
} from "./shareModel";
import { revisionProjector } from "./revisionProjection";
import {
  createShare,
  getCloud,
  publishFollowedShares,
  revokeShare,
  setShareLevel,
  setSharingBackend,
  updateShareToRevision,
} from "./store";
import { sentenceFor } from "./words";
import { shareSentence } from "@horizon36596/zenith-core";

/**
 * "See it as they will" and the share request (spec 13 sections 8.2 to
 * 8.4), over every auto of `examples/starter`:
 *
 * - the projection the dialog shows is exactly `projectShare`'s, for both levels and with Coarsen;
 * - what the cloud stores where another team can read it (the share and its inbox entries) holds
 *   no command name, note or `robot.json` string (SCRUB);
 * - the Coarsen checkbox changes the stored projection;
 * - a projection rebuilt from the published revision is the one the dialog showed;
 * - a follow-latest share is rebuilt at its own level and coarseness on publish, and a change of
 *   level rebuilds the projection from the revision the share is on.
 */

// These tests drive the in-memory cloud, which makes real P-256 keys and signatures for every device
// and team, like the cloud package's own tests (see vitest.config.ts). Each takes well under a second on
// an idle machine, but late in `pnpm ship`'s full run a laptop held to its sustained power limit runs
// them three or four times slower and the 5-second default fails them. 30 seconds still catches a hang.
vi.setConfig({ testTimeout: 30_000 });

const root = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${root}${relative}`, "utf8"));

const AUTOS = ["first-auto", "collect-and-score", "all-step-kinds", "cycle-and-park"] as const;
const LEVELS = ["view", "propose"] as const;
const COARSEN = [false, true] as const;


const linkJson = read("zenith.json");
const link = loadLink(linkJson);
const robotJson = read(link.robot);
const waypointsJson = read(link.waypoints ?? "autos/waypoints.json");
const robot = loadRobot(robotJson);
const field = loadField(read(link.field));
const waypoints = loadWaypoints(waypointsJson);

const project: Project = {
  source: { kind: "example" },
  name: "examples/starter",
  link,
  robot,
  field,
  waypoints,
  autoFiles: AUTOS.map((name) => `${name}.auto.json`),
  autoTexts: {},
};

const autoJsonOf = (name: string): unknown => read(`autos/${name}.auto.json`);

/**
 * Opens an example auto in the editor and returns what the share dialog builds from: the editor's
 * plan (`useDerived().plan`) and the instant sim's run of it (`useSim`, which runs `runSim`).
 */
function dialogSource(name: string): ProjectionSource {
  const auto: Auto = loadAuto(autoJsonOf(name));
  openProject(project, { kind: "local" } as unknown as ProjectBackend);
  openAuto(`${name}.auto.json`, auto, canonicalize("auto", auto));
  const plan = currentDerived().plan;
  if (plan === null) throw new Error(`${name} did not plan in the editor.`);
  const trace = runSim(plan, plan.robot, plan.field).run?.trace;
  if (trace === undefined) throw new Error(`${name} did not simulate in the editor.`);
  return { plan, trace };
}

/** `projectShare` straight from the files, with nothing of the editor in between. */
function expectedProjection(name: string, level: "view" | "propose", coarsen: boolean): Projection {
  const planned = planAuto(resolve(loadAuto(autoJsonOf(name)), waypoints, robot), robot, field);
  const season = seasonFor(field);
  const ledger = runLedger(planned, field, season);
  // The instant sim runs with the ledger, as the editor's does, so a condition the ledger can
  // read ends a path or picks a branch the same way in both.
  const trace = simulateRun(planned, robot, field, { ledger, season }).trace;
  return projectShare({ plan: planned, trace, robot, field, ledger }, { level, coarsen });
}

const draftFor = (level: "view" | "propose", coarsen: boolean): ShareDraft => ({
  ...addTeam(DEFAULT_DRAFT, 12345),
  level,
  coarsen,
});

/** Horizon's cloud, signed in to the sharing store, and the revisions it has published by auto. */
interface SharingCloud {
  world: CloudWorld;
  published: Map<string, PublishedAt>;
}

async function freshCloud(): Promise<SharingCloud> {
  const world = await cloudWorld();
  ownerSawPartnerCodes(world);
  const session = { signedIn: true, teamId: world.owner.teamId, teamNumber: 36596, teamName: "Horizon" };
  setSharingBackend(createCloudSharingApi(world.owner.backend, { now: () => NOW_MS }), session, { now: () => NOW_MS });
  return { world, published: new Map() };
}

/** Publishes an example auto to Horizon's library as the next revision, with the example's robot and field. */
async function publishExample(cloud: SharingCloud, name: string, as = name): Promise<PublishedAt> {
  const at = await publishTo(
    cloud.world.owner,
    `${as}.auto.json`,
    canonicalize("auto", loadAuto(autoJsonOf(name))),
    projectTexts(project),
  );
  cloud.published.set(as, at);
  return at;
}

/**
 * Shares a draft of the open auto the way the dialog's Share button does, from the revision the
 * library holds of it, and returns what was sent.
 */
async function shareThroughDialog(
  cloud: SharingCloud,
  name: string,
  source: ProjectionSource,
  draft: ShareDraft,
  autoName?: string,
): Promise<string> {
  const built = buildProjection(source, draftProjectionChoice(draft, autoName));
  if (!built.ok) throw new Error(built.reason);
  const at = cloud.published.get(name) ?? (await publishExample(cloud, name));
  const request = draftToRequest(draft, at.autoId, { id: at.revisionId, n: at.n }, NOW_MS, built.canonical);
  const share = await createShare(request, "Shared.");
  if (share === null) throw new Error(getCloud().error ?? "the share was refused");
  return built.canonical;
}

/** Every share the cloud holds, as the other team reads it, in the order they were made. */
async function storedShares(cloud: SharingCloud): Promise<Array<{ id: string; projection: string; revisionId: string }>> {
  const shares = await createCloudSharingApi(cloud.world.owner.backend).listShares(cloud.world.owner.teamId);
  return shares.reverse();
}

describe("the dialog's preview is projectShare's projection", () => {
  for (const name of AUTOS) {
    for (const level of LEVELS) {
      for (const coarsen of COARSEN) {
        it(`${name} at ${level}${coarsen ? ", coarsened" : ""}`, () => {
          const built = buildProjection(dialogSource(name), { level, coarsen });
          if (!built.ok) throw new Error(built.reason);
          const expected = expectedProjection(name, level, coarsen);
          expect(built.projection).toEqual(expected);
          expect(built.canonical).toBe(canonicalize("projection", expected));
          expect(built.bytes).toBe(Buffer.byteLength(built.canonical, "utf8"));
          // What is sent reads back under the strict projection schema.
          expect(parseProjection(JSON.parse(built.canonical))).toEqual(expected);
          expect(isCoarsened(built.canonical)).toBe(coarsen);
          expect(levelOf(built.canonical)).toBe(level);
        });
      }
    }
  }

  it("projects an anyone-with-the-link share at the view level, whatever the draft said", () => {
    const draft = withAudience({ ...DEFAULT_DRAFT, level: "propose" }, "link");
    expect(draftProjectionChoice({ ...draft, level: "propose" })).toEqual({ level: "view", coarsen: false });
  });

  it("builds once per sim run and choice, so re-rendering the dialog rebuilds nothing", () => {
    const source = dialogSource("cycle-and-park");
    const before = projectionBuildCount();
    const first = buildProjection(source, { level: "view", coarsen: false });
    // A re-render hands in a new source object around the same plan and trace.
    const again = buildProjection({ plan: source.plan, trace: source.trace }, { level: "view", coarsen: false });
    expect(again).toBe(first);
    expect(projectionBuildCount()).toBe(before + 1);
    buildProjection(source, { level: "view", coarsen: true });
    expect(projectionBuildCount()).toBe(before + 2);
  });
});

/** Every string value in a JSON value, with the key it sits under. */
function stringsWithKeys(value: unknown, key = "", out: Array<{ key: string; value: string }> = []): Array<{ key: string; value: string }> {
  if (typeof value === "string") out.push({ key, value });
  else if (Array.isArray(value)) for (const item of value) stringsWithKeys(item, key, out);
  else if (typeof value === "object" && value !== null) {
    for (const [childKey, child] of Object.entries(value)) stringsWithKeys(child, childKey, out);
  }
  return out;
}

/** Every string anywhere in a JSON document, and every key of a `params` table. */
function allStrings(value: unknown, out: Set<string> = new Set(), parentKey = ""): Set<string> {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out, parentKey);
  else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (parentKey === "params") out.add(key);
      allStrings(child, out, key);
    }
  }
  return out;
}

/** The strings under the given keys, anywhere in a JSON document. */
function valuesUnder(value: unknown, keys: readonly string[], out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) valuesUnder(item, keys, out);
  else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (keys.includes(key)) allStrings(child, out);
      valuesUnder(child, keys, out);
    }
  }
  return out;
}

/**
 * The keys whose values are fixed words of the share or projection format: a share's audience,
 * level and mode, and the projection's kind, level, season, alliance, phase labels, claim actions
 * and step, segment and heading kinds. The starter robot has a command called `score` and an auto a
 * step called `collect`, and finding the format's own word "score" as a phase label says nothing
 * about them, so these values are not searched. Every other string that is stored is: ids, dates,
 * tokens, element ids and the projection's text itself.
 */
const FORMAT_KEYS: ReadonlySet<string> = new Set(["$schema", "kind", "level", "season", "alliance", "label", "action", "mode", "audience"]);

/**
 * Every string the cloud holds where another team can read it, the projection opened up, minus
 * format words: each share document, and the inbox entries that point the receiving teams at it.
 */
function storedText(world: CloudWorld, options: { withoutCommands?: boolean } = {}): string[] {
  const values: string[] = [];
  for (const path of world.database.paths()) {
    if (!path.startsWith("shares/") && !/^teams\/[^/]+\/inbox\//.test(path)) continue;
    const doc = world.database.peek(path) ?? {};
    const { projection, ...rest } = doc;
    for (const entry of stringsWithKeys(rest)) if (!FORMAT_KEYS.has(entry.key)) values.push(entry.value);
    if (typeof projection === "string") {
      const parsed = JSON.parse(projection) as Record<string, unknown>;
      // With "Include command names" the one exempt part is the commands list, which the SCRUB
      // test with names on checks on its own; everything else is searched as always.
      if (options.withoutCommands === true) delete parsed["commands"];
      for (const entry of stringsWithKeys(parsed)) if (!FORMAT_KEYS.has(entry.key)) values.push(entry.value);
    }
  }
  return values;
}

/** The shortest secret searched for inside other strings; shorter ones only as whole values. */
const MIN_SUBSTRING_LENGTH = 4;

function expectAbsent(values: readonly string[], secret: string, what: string): void {
  if (secret.length === 0) return;
  expect(values, `${what} ${JSON.stringify(secret)} as a whole value`).not.toContain(secret);
  if (secret.length >= MIN_SUBSTRING_LENGTH) {
    const holder = values.find((value) => value.includes(secret));
    expect(holder, `${what} ${JSON.stringify(secret)} inside ${JSON.stringify(holder)}`).toBeUndefined();
  }
}

describe("what the cloud stores for the other team holds nothing private (SCRUB)", () => {
  for (const name of AUTOS) {
    it(`${name}, shared at every level, coarsened and not, as a pinned and a followed share`, async () => {
      const cloud = await freshCloud();
      const source = dialogSource(name);
      for (const level of LEVELS) {
        for (const coarsen of COARSEN) {
          await shareThroughDialog(cloud, name, source, draftFor(level, coarsen));
          await shareThroughDialog(cloud, name, source, { ...draftFor(level, coarsen), mode: "follow" });
        }
      }
      await shareThroughDialog(cloud, name, source, withAudience(DEFAULT_DRAFT, "link"));
      expect(await storedShares(cloud)).toHaveLength(9);

      const text = storedText(cloud.world);
      const autoJson = autoJsonOf(name) as Record<string, unknown>;

      const robotStrings = [...allStrings(robotJson)];
      expect(robotStrings.length).toBeGreaterThan(20);
      for (const secret of robotStrings) expectAbsent(text, secret, "robot.json string");

      const commandNames = [...valuesUnder(robotJson, ["commands"])].filter((value) =>
        (robotJson as { commands: Array<{ name: string }> }).commands.some((command) => command.name === value),
      );
      expect(commandNames.length).toBeGreaterThan(2);
      for (const secret of commandNames) expectAbsent(text, secret, "command name");

      const authored = new Set<string>([
        ...valuesUnder(autoJson, ["notes", "description", "authors", "created", "provenance", "args"]),
        ...valuesUnder(autoJson, ["name", "condition", "until", "deadline", "ref", "robot", "field", "id"]),
        String(autoJson["name"]),
        String(autoJson["title"]),
      ]);
      for (const secret of authored) expectAbsent(text, secret, "auto string");

      for (const secret of allStrings(linkJson)) expectAbsent(text, secret, "zenith.json string");
      for (const waypoint of Object.keys((waypointsJson as { waypoints: Record<string, unknown> }).waypoints)) {
        expectAbsent(text, waypoint, "waypoint name");
      }
      expectAbsent(text, `${name}.auto.json`, "file name");
      // Nine shares through the dialog: under a cold start or the full gate this passes 5 s (issue #423).
    }, 30_000);
  }

  it("the starter autos do carry notes, so the note check has something to find", () => {
    const notes = AUTOS.flatMap((name) => [...valuesUnder(autoJsonOf(name), ["notes"])]);
    expect(notes.length).toBeGreaterThan(0);
  });
});

describe("the Coarsen checkbox", () => {
  it("changes the stored projection, at both levels", async () => {
    for (const level of LEVELS) {
      const cloud = await freshCloud();
      const source = dialogSource("cycle-and-park");
      const fine = await shareThroughDialog(cloud, "cycle-and-park", source, draftFor(level, false));
      const coarse = await shareThroughDialog(cloud, "cycle-and-park", source, draftFor(level, true));
      const [first, second] = await storedShares(cloud);
      expect(first?.projection).toBe(fine);
      expect(second?.projection).toBe(coarse);
      expect(coarse).not.toBe(fine);
      const parsed = parseProjection(JSON.parse(coarse));
      expect(parsed.trajectory.positionQuantumIn).toBe(2);
      expect(parseProjection(JSON.parse(fine)).trajectory.positionQuantumIn).toBe(0.5);
      for (const phase of parsed.phases) {
        expect((phase.startS / 0.25) % 1).toBeCloseTo(0);
        expect((phase.endS / 0.25) % 1).toBeCloseTo(0);
      }
      for (const [xIn, yIn] of parsed.trajectory.poses) {
        expect(Math.abs(xIn % 2)).toBeCloseTo(0);
        expect(Math.abs(yIn % 2)).toBeCloseTo(0);
      }
    }
  });

  it("is off by default", () => {
    expect(DEFAULT_DRAFT.coarsen).toBe(false);
  });
});

describe("a projection rebuilt from the team library", () => {
  for (const name of AUTOS) {
    it(`${name}: the published revision projects exactly as the dialog showed, at both levels and coarsenesses`, async () => {
      const cloud = await freshCloud();
      const at = await publishExample(cloud, name);
      const files = await createCloudSharingApi(cloud.world.owner.backend).revisionFiles(cloud.world.owner.teamId, at.autoId, at.revisionId);
      if (files === null) throw new Error("the revision is not in the library");
      // Published with its robot and field, it needs nothing from the open project.
      const projector = revisionProjector(files, null, at.n);
      if (!projector.ok) throw new Error(projector.reason);
      const source = dialogSource(name);
      for (const level of LEVELS) {
        for (const coarsen of COARSEN) {
          const shown = buildProjection(source, { level, coarsen });
          expect(projector.build({ level, coarsen })).toBe(shown.ok ? shown.canonical : "");
        }
      }
    });
  }

  it("says to open the robot's project for a revision published without robot.json and a field", () => {
    const content = canonicalize("auto", loadAuto(autoJsonOf("first-auto")));
    const alone = revisionProjector({ content }, null, 3);
    expect(alone).toEqual({
      ok: false,
      reason: "Revision 3 was published without robot.json and a field, so its projection cannot be rebuilt here. Open the robot's project first, then try again.",
    });
    const withProject = revisionProjector({ content }, { robot, field, waypoints }, 3);
    expect(withProject.ok).toBe(true);
    expect(revisionProjector({ content: "not json" }, { robot, field, waypoints }, 4)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^Revision 4 could not be projected: /),
    });
  });
});

describe("follow the latest version", () => {
  it("rebuilds each live followed share on publish at its own level and coarseness, and leaves the rest", async () => {
    const cloud = await freshCloud();
    const name = "collect-and-score";
    const source = dialogSource(name);
    await shareThroughDialog(cloud, name, source, { ...draftFor("propose", true), mode: "follow" });
    await shareThroughDialog(cloud, name, source, { ...draftFor("view", false), mode: "follow" });
    await shareThroughDialog(cloud, name, source, draftFor("view", false));
    await shareThroughDialog(cloud, name, source, { ...draftFor("view", false), mode: "follow" });
    const [coarseFollow, fineFollow, pinned, revokedFollow] = await storedShares(cloud);
    if (coarseFollow === undefined || fineFollow === undefined || pinned === undefined || revokedFollow === undefined) {
      throw new Error("expected four shares");
    }
    await revokeShare(revokedFollow.id, "Revoked.");
    const first = cloud.published.get(name);

    // The next version: another auto's content published as revision 2 of the same library auto.
    const next = await publishExample(cloud, "cycle-and-park", name);
    expect(next.autoId).toBe(first?.autoId);
    const nextSource = dialogSource("cycle-and-park");
    const built: Array<{ level: string; coarsen: boolean }> = [];
    const updated = await publishFollowedShares(next.autoId, next.revisionId, (choice) => {
      built.push(choice);
      const result = buildProjection(nextSource, choice);
      return result.ok ? result.canonical : null;
    });
    expect(getCloud().error).toBeNull();
    expect(updated).toBe(2);
    expect(built.sort((a, b) => a.level.localeCompare(b.level))).toEqual([
      { level: "propose", coarsen: true },
      { level: "view", coarsen: false },
    ]);

    const after = new Map((await storedShares(cloud)).map((share) => [share.id, share]));
    const nextProjection = (level: "view" | "propose", coarsen: boolean): string => {
      const result = buildProjection(nextSource, { level, coarsen });
      return result.ok ? result.canonical : "";
    };
    expect(after.get(coarseFollow.id)).toMatchObject({ revisionId: next.revisionId, projection: nextProjection("propose", true) });
    expect(after.get(fineFollow.id)).toMatchObject({ revisionId: next.revisionId, projection: nextProjection("view", false) });
    expect(after.get(pinned.id)).toMatchObject({ revisionId: first?.revisionId, projection: pinned.projection });
    expect(after.get(revokedFollow.id)).toMatchObject({ revisionId: first?.revisionId, projection: revokedFollow.projection });

    // Publishing the same revision again moves nothing: they are already on it.
    expect(await publishFollowedShares(next.autoId, next.revisionId, () => "{}")).toBe(0);
  });

  it("refuses a share or an update with no projection", async () => {
    const cloud = await freshCloud();
    const at = await publishExample(cloud, "first-auto");
    const api = createCloudSharingApi(cloud.world.owner.backend, { now: () => NOW_MS });
    const revision = { id: at.revisionId, n: at.n };
    await expect(api.createShare(cloud.world.owner.teamId, draftToRequest(draftFor("view", false), at.autoId, revision, NOW_MS, ""))).rejects.toThrow(
      /projection/,
    );
    const share = await api.createShare(cloud.world.owner.teamId, draftToRequest(draftFor("view", false), at.autoId, revision, NOW_MS, "{}"));
    await expect(api.updateShare(share.id, { revisionId: at.revisionId, projection: "" })).rejects.toThrow(/projection/);
    await api.revokeShare(share.id);
    await expect(api.updateShare(share.id, { revisionId: at.revisionId, projection: "{}" })).rejects.toThrow(/revoked/);
  });
});

describe("changing a share's level", () => {
  it("rebuilds what they see from the revision the share is on, keeping its coarseness", async () => {
    const cloud = await freshCloud();
    const name = "cycle-and-park";
    const source = dialogSource(name);
    await shareThroughDialog(cloud, name, source, draftFor("view", true));
    // The editor moves on to another auto: the rebuild reads the library, not the editor.
    dialogSource("first-auto");
    const [share] = await storedShares(cloud);
    if (share === undefined) throw new Error("no share");
    const expected = (level: "view" | "propose"): string => {
      const result = buildProjection(source, { level, coarsen: true });
      return result.ok ? result.canonical : "";
    };

    await setShareLevel(share.id, "propose", "Changed.");
    expect(getCloud().error).toBeNull();
    const [raised] = await storedShares(cloud);
    expect(raised).toMatchObject({ level: "propose", revisionId: share.revisionId, projection: expected("propose") });
    expect(levelOf(raised?.projection ?? "")).toBe("propose");

    await setShareLevel(share.id, "view", "Changed.");
    const [lowered] = await storedShares(cloud);
    expect(lowered).toMatchObject({ level: "view", projection: expected("view") });
    expect(isCoarsened(lowered?.projection ?? "")).toBe(true);
  });

  it("says why when the revision can no longer be projected, and changes nothing", async () => {
    const cloud = await freshCloud();
    const at = await publishTo(cloud.world.owner, "bare.auto.json", canonicalize("auto", loadAuto(autoJsonOf("first-auto"))));
    const api = createCloudSharingApi(cloud.world.owner.backend, { now: () => NOW_MS });
    const made = await api.createShare(
      cloud.world.owner.teamId,
      draftToRequest(draftFor("view", false), at.autoId, { id: at.revisionId, n: at.n }, NOW_MS, "{}"),
    );
    // Nothing open, and the revision was published without robot.json and a field.
    closeProject();
    await setShareLevel(made.id, "propose", "Changed.");
    expect(getCloud().error).toMatch(/published without robot\.json and a field/);
    const [unchanged] = await storedShares(cloud);
    expect(unchanged).toMatchObject({ level: "view", projection: "{}" });
  });
});

describe("playing a projection back", () => {
  const built = buildProjection(dialogSource("cycle-and-park"), { level: "propose", coarsen: false });
  if (!built.ok) throw new Error(built.reason);
  const projection = built.projection;

  it("reads poses off the 10 Hz rows, blending between them", () => {
    const [first, second] = projection.trajectory.poses;
    if (first === undefined || second === undefined) throw new Error("no rows");
    expect(projectionPoseAt(projection, 0)).toMatchObject({ xIn: first[0], yIn: first[1] });
    const half = projectionPoseAt(projection, 0.05);
    expect(half.xIn).toBeCloseTo((first[0] + second[0]) / 2);
    expect(half.yIn).toBeCloseTo((first[1] + second[1]) / 2);
    const last = projection.trajectory.poses[projection.trajectory.poses.length - 1];
    expect(projectionPoseAt(projection, projectionEndS(projection) + 10)).toMatchObject({ xIn: last?.[0], yIn: last?.[1] });
  });

  it("draws the bounding box the projection carries, round the pose", () => {
    const pose = { xIn: 10, yIn: -5, headingRad: Math.PI / 2 };
    const corners = boxCornersAt(projection, pose);
    const xs = corners.map((corner) => corner.xIn);
    const ys = corners.map((corner) => corner.yIn);
    // Turned a quarter, the box's length runs along y and its width along x.
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(projection.boundingBox.lengthIn);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(projection.boundingBox.widthIn);
  });

  it("lists the structure by opaque ids and tokens only", () => {
    const rows = structureRows(projection);
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) expect(row.id).toMatch(/^(s[1-9][0-9]*|then|else)$/);
    const words = rows.map((row) => row.words).join(" ");
    expect(words).toMatch(/cmd1/);
    expect(words).toMatch(/cond1/);
    for (const command of (robotJson as { commands: Array<{ name: string }> }).commands) {
      expect(words).not.toMatch(new RegExp(`\\b${command.name}\\b`));
    }
    const view = buildProjection(dialogSource("cycle-and-park"), { level: "view", coarsen: false });
    expect(view.ok && structureRows(view.projection)).toEqual([]);
  });
});

/**
 * "Include command names" (owner ruling 2026-09-27), from the dialog's checkbox to what the cloud
 * stores and what every later rebuild of the share keeps.
 */
describe("the Include command names checkbox", () => {
  const named = (draft: ShareDraft): ShareDraft => ({ ...draft, includeCommands: true });

  it("is off by default, and off leaves the projection exactly as it was", () => {
    expect(DEFAULT_DRAFT.includeCommands).toBe(false);
    expect(draftProjectionChoice(draftFor("view", false))).toEqual({ level: "view", coarsen: false });
    for (const name of AUTOS) {
      for (const level of LEVELS) {
        const off = buildProjection(dialogSource(name), draftProjectionChoice(draftFor(level, false)));
        if (!off.ok) throw new Error(off.reason);
        expect(off.canonical).toBe(canonicalize("projection", expectedProjection(name, level, false)));
        expect(includesCommands(off.canonical)).toBe(false);
      }
    }
  });

  it("adds the names and settings to what is sent, and the sentence says so", () => {
    const source = dialogSource("collect-and-score");
    for (const level of LEVELS) {
      const draft = named(draftFor(level, false));
      expect(draftProjectionChoice(draft)).toEqual({ level, coarsen: false, includeCommands: true });
      const built = buildProjection(source, draftProjectionChoice(draft));
      if (!built.ok) throw new Error(built.reason);
      expect(includesCommands(built.canonical)).toBe(true);
      const names = (built.projection.commands ?? []).map((entry) => entry.name);
      expect(names).toContain("intakeOn");
      expect(names).toContain("score");
      expect(shareSentence(draftSettings(draft, NOW_MS), NOW_MS)).toContain("They will see command names and their settings");
    }
  });

  it("stores a share whose sentence, read back, still says the names are included", async () => {
    const cloud = await freshCloud();
    const source = dialogSource("cycle-and-park");
    const draft = named(draftFor("view", false));
    const sent = await shareThroughDialog(cloud, "cycle-and-park", source, draft);
    const [stored] = await createCloudSharingApi(cloud.world.owner.backend).listShares(cloud.world.owner.teamId);
    if (stored === undefined) throw new Error("no share");
    expect(stored.projection).toBe(sent);
    expect(Object.keys(stored)).not.toContain("includeCommands");
    expect(sentenceFor(stored, NOW_MS)).toContain("They will see command names and their settings");
  });

  it("names each token in the structure rows when on, and keeps tokens when off", () => {
    const on = buildProjection(dialogSource("cycle-and-park"), { level: "propose", coarsen: false, includeCommands: true });
    if (!on.ok) throw new Error(on.reason);
    const words = structureRows(on.projection).map((row) => row.words).join(" ");
    expect(words).toMatch(/\bscore \(count 4\)/);
    expect(words).not.toMatch(/\bcmd[0-9]+\b/);
    // Conditions are never named: they stay tokens.
    expect(words).toMatch(/cond1/);
  });

  for (const name of AUTOS) {
    it(`${name}: what the cloud stores holds nothing private beyond the command names and settings (SCRUB)`, async () => {
      const cloud = await freshCloud();
      const source = dialogSource(name);
      for (const level of LEVELS) {
        for (const coarsen of COARSEN) await shareThroughDialog(cloud, name, source, named(draftFor(level, coarsen)));
      }
      await shareThroughDialog(cloud, name, source, named(withAudience(DEFAULT_DRAFT, "link")));
      const shares = await storedShares(cloud);
      expect(shares).toHaveLength(5);

      // Outside the commands list, every check of the SCRUB test above holds, command names included.
      const text = storedText(cloud.world, { withoutCommands: true });
      const autoJson = autoJsonOf(name) as Record<string, unknown>;
      for (const secret of allStrings(robotJson)) expectAbsent(text, secret, "robot.json string");
      const authored = new Set<string>([
        ...valuesUnder(autoJson, ["notes", "description", "authors", "created", "provenance", "args"]),
        ...valuesUnder(autoJson, ["name", "condition", "until", "deadline", "ref", "robot", "field", "id"]),
        String(autoJson["title"]),
      ]);
      for (const secret of authored) expectAbsent(text, secret, "auto string");
      for (const secret of allStrings(linkJson)) expectAbsent(text, secret, "zenith.json string");
      expectAbsent(text, `${name}.auto.json`, "file name");

      // The commands list itself holds only the names and settings the auto's own calls pass.
      const allowed = new Set<string>(["command", "marker"]);
      const allow = (call: { name: string; args?: Record<string, unknown> }): void => {
        allowed.add(call.name);
        for (const [key, arg] of Object.entries(call.args ?? {})) {
          allowed.add(key);
          if (typeof arg === "string") allowed.add(arg);
        }
      };
      // Every call the auto makes: its command steps, and the command of each marker on a path.
      const walk = (steps: readonly Step[]): void => {
        for (const step of steps) {
          if (step.kind === "command") allow(step);
          if (step.kind === "path") for (const marker of step.markers ?? []) allow(marker.command);
          for (const list of childLists(step)) walk(list);
        }
      };
      walk(loadAuto(autoJson).steps);
      const conditions = valuesUnder(autoJson, ["condition", "until"]);
      for (const share of shares) {
        const commands = (JSON.parse(share.projection) as Projection).commands ?? [];
        expect(commands.length).toBeGreaterThan(0);
        for (const entry of commands) {
          expect(Object.keys(entry).every((key) => ["token", "kind", "name", "args", "startS", "endS"].includes(key))).toBe(true);
          expect(allowed.has(entry.name), `${name} name ${entry.name}`).toBe(true);
          expect(conditions.has(entry.name)).toBe(false);
          for (const [key, arg] of Object.entries(entry.args ?? {})) {
            expect(allowed.has(key), `${name} argument ${key}`).toBe(true);
            if (typeof arg === "string") expect(allowed.has(arg)).toBe(true);
          }
        }
      }
    });
  }

  it("is kept when a following share is rebuilt on publish", async () => {
    const cloud = await freshCloud();
    const name = "collect-and-score";
    await shareThroughDialog(cloud, name, dialogSource(name), { ...named(draftFor("view", false)), mode: "follow" });
    await shareThroughDialog(cloud, name, dialogSource(name), { ...draftFor("view", false), mode: "follow" });
    const [withNames, withoutNames] = await storedShares(cloud);
    const next = await publishExample(cloud, "cycle-and-park", name);
    const nextSource = dialogSource("cycle-and-park");
    const updated = await publishFollowedShares(next.autoId, next.revisionId, (choice) => {
      const result = buildProjection(nextSource, choice);
      return result.ok ? result.canonical : null;
    });
    expect(updated).toBe(2);
    const after = new Map((await storedShares(cloud)).map((share) => [share.id, share]));
    const expected = (includeCommands: boolean): string => {
      const result = buildProjection(nextSource, { level: "view", coarsen: false, includeCommands });
      return result.ok ? result.canonical : "";
    };
    expect(after.get(withNames?.id ?? "")?.projection).toBe(expected(true));
    expect(after.get(withoutNames?.id ?? "")?.projection).toBe(expected(false));
  });

  it("is kept when a share's level changes", async () => {
    const cloud = await freshCloud();
    const name = "cycle-and-park";
    const source = dialogSource(name);
    await shareThroughDialog(cloud, name, source, named(draftFor("view", true)));
    const [share] = await storedShares(cloud);
    if (share === undefined) throw new Error("no share");
    await setShareLevel(share.id, "propose", "Changed.");
    const [raised] = await storedShares(cloud);
    const expected = buildProjection(source, { level: "propose", coarsen: true, includeCommands: true });
    expect(raised?.projection).toBe(expected.ok ? expected.canonical : "");
  });
});

describe("Update share, for a pinned share with a newer version not shared", () => {
  it("re-projects the newest revision with the share's own level, rounding and command names", async () => {
    const cloud = await freshCloud();
    const name = "collect-and-score";
    await shareThroughDialog(cloud, name, dialogSource(name), { ...draftFor("propose", true), includeCommands: true });
    await shareThroughDialog(cloud, name, dialogSource(name), draftFor("view", false));
    const [namedShare, plainShare] = await storedShares(cloud);
    if (namedShare === undefined || plainShare === undefined) throw new Error("expected two shares");
    const first = cloud.published.get(name);
    const next = await publishExample(cloud, "cycle-and-park", name);
    const revisions = await cloud.world.owner.backend.listRevisions(cloud.world.owner.teamId, next.autoId);
    const listed = await createCloudSharingApi(cloud.world.owner.backend).listShares(cloud.world.owner.teamId);
    const pinned = listed.find((share) => share.id === namedShare.id);
    if (pinned === undefined) throw new Error("the share is not listed");
    const newer = newerRevisionFor(pinned, revisions, NOW_MS);
    expect(newer?.id).toBe(next.revisionId);
    if (newer === null) throw new Error("no newer revision");

    const nextSource = dialogSource("cycle-and-park");
    const expected = (choice: { level: "view" | "propose"; coarsen: boolean; includeCommands?: boolean }): string => {
      const result = buildProjection(nextSource, choice);
      return result.ok ? result.canonical : "";
    };
    const files = { content: newer.content, ...(newer.robot === undefined ? {} : { robot: newer.robot }), ...(newer.field === undefined ? {} : { field: newer.field }) };
    for (const share of [namedShare, plainShare]) {
      await updateShareToRevision(share.id, { id: newer.id, n: newer.n, files }, "Updated.");
      expect(getCloud().error).toBeNull();
    }
    const after = new Map((await storedShares(cloud)).map((share) => [share.id, share]));
    expect(after.get(namedShare.id)).toMatchObject({
      revisionId: next.revisionId,
      projection: expected({ level: "propose", coarsen: true, includeCommands: true }),
    });
    expect(after.get(plainShare.id)).toMatchObject({ revisionId: next.revisionId, projection: expected({ level: "view", coarsen: false }) });
    expect(first?.revisionId).not.toBe(next.revisionId);

    // Once updated, nothing newer is left unshared.
    const relisted = await createCloudSharingApi(cloud.world.owner.backend).listShares(cloud.world.owner.teamId);
    for (const share of relisted) expect(newerRevisionFor(share, revisions, NOW_MS)).toBeNull();
    expect(relisted.every((share) => share.revision === next.n)).toBe(true);
  });
});

describe("the Include the auto's name checkbox", () => {
  const titled = (draft: ShareDraft): ShareDraft => ({ ...draft, includeTitle: true });

  it("is off by default, and off sends no title whatever the auto is called", () => {
    expect(DEFAULT_DRAFT.includeTitle).toBe(false);
    expect(draftProjectionChoice(draftFor("view", false), "First auto")).toEqual({ level: "view", coarsen: false });
    const off = buildProjection(dialogSource("first-auto"), draftProjectionChoice(draftFor("view", false), "First auto"));
    if (!off.ok) throw new Error(off.reason);
    expect(off.canonical).toBe(canonicalize("projection", expectedProjection("first-auto", "view", false)));
    expect(projectionTitle(off.canonical)).toBeNull();
    expect(shareSentence(draftSettings(draftFor("view", false), NOW_MS), NOW_MS)).not.toContain("this auto's name");
  });

  it("keeps the name the dialog shows, at both levels, and the sentence says so", () => {
    const source = dialogSource("collect-and-score");
    for (const level of LEVELS) {
      const draft = titled(draftFor(level, false));
      expect(draftProjectionChoice(draft, "Collect and score")).toEqual({ level, coarsen: false, title: "Collect and score" });
      const built = buildProjection(source, draftProjectionChoice(draft, "Collect and score"));
      if (!built.ok) throw new Error(built.reason);
      expect(built.projection.title).toBe("Collect and score");
      expect(projectionTitle(built.canonical)).toBe("Collect and score");
      expect(shareSentence(draftSettings(draft, NOW_MS), NOW_MS)).toContain("They will see this auto's name");
    }
    // A blank name is no name: nothing is sent rather than an empty title.
    expect(draftProjectionChoice(titled(draftFor("view", false)), "  ")).toEqual({ level: "view", coarsen: false });
  });

  it("stores a share whose sentence and stored choice, read back, still keep the name", async () => {
    const cloud = await freshCloud();
    const draft = titled(draftFor("view", true));
    const sent = await shareThroughDialog(cloud, "first-auto", dialogSource("first-auto"), draft, "First auto");
    const [stored] = await storedShares(cloud);
    if (stored === undefined) throw new Error("no share");
    expect(stored.projection).toBe(sent);
    expect(Object.keys(stored)).not.toContain("includeTitle");
    const listed = (await createCloudSharingApi(cloud.world.owner.backend).listShares(cloud.world.owner.teamId))[0];
    if (listed === undefined) throw new Error("no share listed");
    expect(sentenceFor(listed, NOW_MS)).toContain("They will see this auto's name");
    expect(storedChoice(stored.projection, "propose")).toEqual({ level: "propose", coarsen: true, title: "First auto" });
  });

  it("is kept when a share's level changes", async () => {
    const cloud = await freshCloud();
    const name = "cycle-and-park";
    const source = dialogSource(name);
    await shareThroughDialog(cloud, name, source, titled(draftFor("view", false)), "Cycle and park");
    const [share] = await storedShares(cloud);
    if (share === undefined) throw new Error("no share");
    await setShareLevel(share.id, "propose", "Changed.");
    const [raised] = await storedShares(cloud);
    const expected = buildProjection(source, { level: "propose", coarsen: false, title: "Cycle and park" });
    expect(raised?.projection).toBe(expected.ok ? expected.canonical : "");
  });

  it("is kept by a follow-latest publish and by Update share, with the new revision's own title", async () => {
    const cloud = await freshCloud();
    const name = "collect-and-score";
    await shareThroughDialog(cloud, name, dialogSource(name), { ...titled(draftFor("view", false)), mode: "follow" }, "Collect and score");
    await shareThroughDialog(cloud, name, dialogSource(name), titled(draftFor("view", false)), "Collect and score");
    await shareThroughDialog(cloud, name, dialogSource(name), draftFor("view", false));
    const [followed, pinned, plain] = await storedShares(cloud);
    if (followed === undefined || pinned === undefined || plain === undefined) throw new Error("expected three shares");

    // The next revision is cycle-and-park's content published as the same auto, so its title is
    // "Cycle and park": a share that keeps the name shows the name the revision now has.
    const next = await publishExample(cloud, "cycle-and-park", name);
    const revision = (await cloud.world.owner.backend.listRevisions(cloud.world.owner.teamId, next.autoId)).find(
      (each) => each.id === next.revisionId,
    );
    if (revision === undefined) throw new Error("no revision");
    const files = {
      content: revision.content,
      ...(revision.robot === undefined ? {} : { robot: revision.robot }),
      ...(revision.field === undefined ? {} : { field: revision.field }),
    };
    const projector = revisionProjector(files, null, next.n);
    if (!projector.ok) throw new Error(projector.reason);
    expect(await publishFollowedShares(next.autoId, next.revisionId, projector.build)).toBe(1);
    await updateShareToRevision(pinned.id, { id: next.revisionId, n: next.n, files }, "Updated.");
    await updateShareToRevision(plain.id, { id: next.revisionId, n: next.n, files }, "Updated.");
    expect(getCloud().error).toBeNull();

    const after = new Map((await storedShares(cloud)).map((share) => [share.id, share.projection]));
    expect(projectionTitle(after.get(followed.id) ?? "")).toBe("Cycle and park");
    expect(projectionTitle(after.get(pinned.id) ?? "")).toBe("Cycle and park");
    expect(projectionTitle(after.get(plain.id) ?? "")).toBeNull();
  });

  it("keeps the name the share carries when the revision's auto has no title of its own", () => {
    const auto = autoJsonOf("first-auto") as Record<string, unknown>;
    const untitled = Object.fromEntries(Object.entries(auto).filter(([key]) => key !== "title"));
    const projector = revisionProjector(
      { content: canonicalize("auto", loadAuto(untitled)) },
      { robot, field, waypoints },
      2,
    );
    if (!projector.ok) throw new Error(projector.reason);
    expect(projectionTitle(projector.build({ level: "view", coarsen: false, title: "first-auto.auto.json" }) ?? "")).toBe(
      "first-auto.auto.json",
    );
    expect(projectionTitle(projector.build({ level: "view", coarsen: false }) ?? "")).toBeNull();
  });
});
