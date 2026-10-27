/**
 * One signed-in cloud session (spec 13 sections 4.1, 8 and 9), in node
 * against the in-memory cloud: the account's sign-in is the sharing store's and the verification
 * UI's, on the account's own backend; a publish moves the shares that follow the latest version; a
 * share another team made shows in the Partners panel's list and loads into the alliance view; and
 * a `#/s/<id>` link opens without signing in.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize, loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { MemoryBackend, MemoryDatabase } from "@horizon36596/zenith-cloud/memory";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verificationBackend } from "../admin/store";
import { receivedShareSource } from "../alliance/cloudSource";
import { getAllianceState, resetAlliance } from "../alliance/store";
import { NOW_MS, fixedRandom } from "../cloud/cloudFixture.test";
import { createCloudSharingApi } from "../cloud/cloudSharingApi";
import { onAutoPublished } from "../cloud/followLatest";
import { followShareLink, loadReceivedShare, openShareSecret, takeShareSecret } from "../cloud/received";
import { revisionProjector } from "../cloud/revisionProjection";
import { DEFAULT_DRAFT, addTeam, draftToRequest, withAudience } from "../cloud/shareModel";
import {
  SIGNED_OUT,
  closeSharingSheet,
  createShare,
  getCloud,
  refreshReceived,
  refreshSharing,
  setSharingBackend,
} from "../cloud/store";
import { commitFor, forgetCommits, rememberCommit } from "../library/gitCommits";
import type { ProjectBackend } from "../project/backend";
import type { Project } from "../project/types";
import { closeProject, currentDerived, openAuto, openProject } from "../state/store";
import { runSim } from "../state/sim";
import { AccountModel } from "./model";
import { memoryStorage } from "./storage";
import { publishedRevisionOf, sharingSessionOf, wireCloudSession } from "./wiring";

const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${starter}${relative}`, "utf8"));
const link = loadLink(read("zenith.json"));
const project: Project = {
  source: { kind: "example" },
  name: "examples/starter",
  link,
  robot: loadRobot(read(link.robot)),
  field: loadField(read(link.field)),
  waypoints: loadWaypoints(read(link.waypoints ?? "autos/waypoints.json")),
  autoFiles: [],
  autoTexts: {},
};
const canonicalOf = (name: string): string => canonicalize("auto", loadAuto(read(`autos/${name}.auto.json`)));
const FILE = "collect-and-score.auto.json";
const files = { robot: project.robot, field: project.field, waypoints: project.waypoints };

function cloud(): MemoryDatabase {
  let t = NOW_MS;
  return new MemoryDatabase({ now: () => new Date((t += 1)) });
}

let seed = 100;

/** One person at one computer: an account model on its own backend over the shared database. */
function device(database: MemoryDatabase, options: { gitSha?: string } = {}) {
  let backend: MemoryBackend | null = null;
  const model = new AccountModel({
    mode: "fake",
    storage: memoryStorage(),
    now: () => NOW_MS,
    pageUrl: () => "http://localhost:5173/?cloud=fake#/",
    createBackend: async () => {
      backend = new MemoryBackend({ database, random: fixedRandom(seed++) });
      return backend;
    },
    gitShaFor: (fileName, canonical) => (options.gitSha === undefined ? commitFor(fileName, canonical) : options.gitSha),
    onPublished: (revision) => onAutoPublished(publishedRevisionOf(revision)),
  });
  return {
    model,
    backend: () => {
      if (backend === null) throw new Error("not started");
      return backend;
    },
  };
}

/** A provider, a display name and a team: a signed-in owner. */
async function owner(d: ReturnType<typeof device>, provider: "github" | "google", name: string, team: { number: number; name: string }) {
  await d.model.start();
  d.model.open("signIn");
  await d.model.signInWith(provider);
  await d.model.saveDisplayName(name);
  expect(await d.model.createTeam(team)).toBe(true);
  await d.model.refreshLibrary();
}

/**
 * Records on the sharer's device that the person saw the partner's safety code under number 12345,
 * as the share dialog would before a first share. A share made online to a team whose code this
 * device never showed is refused.
 */
function sawCode(sharer: ReturnType<typeof device>, partner: ReturnType<typeof device>): void {
  sharer.backend().pinTeamNumber(12345, partner.model.getState().teamId ?? "", { safetyCodeSeen: true });
}

let stops: Array<() => void> = [];
const wire = (d: ReturnType<typeof device>): void => {
  for (const stop of stops) stop();
  stops = [wireCloudSession(d.model, { now: () => NOW_MS })];
};

/** Waits for the store's session to settle after the account changed. */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  resetAlliance();
  closeSharingSheet();
  forgetCommits();
});

afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  setSharingBackend(createCloudSharingApi(new MemoryBackend()), SIGNED_OUT);
});

describe("one sign-in for the account, sharing and verification", () => {
  it("signs the sharing store in to the account's team, on the account's own backend", async () => {
    const database = cloud();
    const ada = device(database);
    await ada.model.start();
    wire(ada);
    expect(getCloud().session).toEqual(SIGNED_OUT);
    expect(verificationBackend()).toBe(ada.backend());

    await owner(ada, "github", "Ada", { number: 36596, name: "Horizon" });
    await settled();
    expect(getCloud().session).toEqual({
      signedIn: true,
      teamId: ada.model.getState().teamId,
      teamNumber: 36596,
      teamName: "Horizon",
    });
    expect(sharingSessionOf(ada.model.getState())).toEqual(getCloud().session);

    // A share made through the store is in the account's backend: there is no second cloud.
    const grace = device(database);
    await owner(grace, "google", "Grace", { number: 12345, name: "Partner team" });
    sawCode(ada, grace);
    wire(ada);
    await settled();
    const at = await ada.model.publish({ fileName: FILE, canonical: canonicalOf("collect-and-score"), project: files });
    if (at === null) throw new Error(ada.model.getState().error ?? "not published");
    const request = draftToRequest(addTeam(DEFAULT_DRAFT, 12345), at.autoId, { id: at.id, n: at.n }, NOW_MS, "{}");
    const share = await createShare(request, "Shared.");
    expect(getCloud().error).toBeNull();
    expect((await ada.backend().listTeamShares(ada.model.getState().teamId ?? "")).map((s) => s.id)).toEqual([share?.id]);

    // Signing out signs sharing out too.
    await ada.model.signOut();
    await settled();
    expect(getCloud().session).toEqual(SIGNED_OUT);
  });

  it("follows the fake cloud's switch of user to the other team, with no second sign-in", async () => {
    const database = cloud();
    const ada = device(database);
    await owner(ada, "github", "Ada", { number: 36596, name: "Horizon" });
    const grace = device(database);
    await owner(grace, "google", "Grace", { number: 12345, name: "Partner team" });
    sawCode(ada, grace);
    wire(ada);
    await settled();
    expect(getCloud().session.teamNumber).toBe(36596);

    expect(ada.model.fakeUsers().map((user) => user.displayName)).toEqual(["Ada", "Grace"]);
    const graceUid = grace.backend().currentUser()?.uid ?? "";
    expect(await ada.model.switchFakeUser(graceUid)).toBe(true);
    await settled();
    expect(ada.model.getState().user?.uid).toBe(graceUid);
    expect(getCloud().session).toMatchObject({ signedIn: true, teamNumber: 12345, teamName: "Partner team" });
    expect(await ada.model.switchFakeUser("nobody")).toBe(false);
    expect(ada.model.getState().error).toMatch(/no profile/);
  });
});

describe("publishing moves the shares that follow the latest version", () => {
  it("rebuilds a followed share from the new revision, leaves a pinned one, and records the commit", async () => {
    const database = cloud();
    const ada = device(database);
    await owner(ada, "github", "Ada", { number: 36596, name: "Horizon" });
    const grace = device(database);
    await owner(grace, "google", "Grace", { number: 12345, name: "Partner team" });
    sawCode(ada, grace);
    wire(ada);
    await settled();

    rememberCommit(FILE, canonicalOf("collect-and-score"), "0123456789abcdef0123456789abcdef01234567");
    const first = await ada.model.publish({ fileName: FILE, canonical: canonicalOf("collect-and-score"), project: files });
    if (first === null) throw new Error(ada.model.getState().error ?? "not published");
    expect(first.gitSha).toBe("0123456789abcdef0123456789abcdef01234567");

    const projectorOf = (revision: typeof first) => {
      const built = revisionProjector(publishedRevisionOf(revision).files, null, revision.n);
      if (!built.ok) throw new Error(built.reason);
      return built.build;
    };
    const view = projectorOf(first)({ level: "view", coarsen: false }) ?? "";
    const draft = addTeam(DEFAULT_DRAFT, 12345);
    const followed = await createShare(draftToRequest({ ...draft, mode: "follow" }, first.autoId, { id: first.id, n: 1 }, NOW_MS, view), "Shared.");
    const pinned = await createShare(draftToRequest(draft, first.autoId, { id: first.id, n: 1 }, NOW_MS, view), "Shared.");
    if (followed === null || pinned === null) throw new Error(getCloud().error ?? "not shared");

    // Revision 2 of the same file: another auto's routine stands in for an edit.
    const second = await ada.model.publish({ fileName: FILE, canonical: canonicalOf("cycle-and-park"), project: files });
    if (second === null) throw new Error(ada.model.getState().error ?? "not published");
    // This text was never committed, so the revision names no commit.
    expect(second.gitSha).toBeUndefined();
    await refreshSharing();
    const byId = new Map(getCloud().shares.map((share) => [share.id, share]));
    expect(byId.get(followed.id)).toMatchObject({
      revision: 2,
      revisionId: second.id,
      projection: projectorOf(second)({ level: "view", coarsen: false }),
    });
    expect(byId.get(pinned.id)).toMatchObject({ revision: 1, revisionId: first.id, projection: view });

    // The team that received it sees the new version.
    const [received] = await createCloudSharingApi(grace.backend()).listReceived(grace.model.getState().teamId ?? "");
    expect(received).toMatchObject({ mode: "follow", revision: 2 });
  });
});

describe("shares received from another team", () => {
  async function sharedWithGrace(audience: "teams" | "link" = "teams") {
    const database = cloud();
    const ada = device(database);
    await owner(ada, "github", "Ada", { number: 36596, name: "Horizon" });
    const grace = device(database);
    await owner(grace, "google", "Grace", { number: 12345, name: "Partner team" });
    sawCode(ada, grace);
    wire(ada);
    await settled();
    const at = await ada.model.publish({ fileName: FILE, canonical: canonicalOf("collect-and-score"), project: files });
    if (at === null) throw new Error("not published");
    const built = revisionProjector(publishedRevisionOf(at).files, null, at.n);
    if (!built.ok) throw new Error(built.reason);
    const projection = built.build({ level: "view", coarsen: false }) ?? "";
    const draft = audience === "link" ? withAudience(DEFAULT_DRAFT, "link") : addTeam(DEFAULT_DRAFT, 12345);
    const share = await createShare(draftToRequest(draft, at.autoId, { id: at.id, n: at.n }, NOW_MS, projection), "Shared.");
    if (share === null) throw new Error(getCloud().error ?? "not shared");
    return { database, ada, grace, share, projection };
  }

  it("lists a share in the receiving team's Partners panel as from team 36596, and loads it beside the open auto", async () => {
    const { grace, share, projection } = await sharedWithGrace();
    wire(grace);
    await settled();
    await refreshReceived();
    expect(getCloud().received).toHaveLength(1);
    const [received] = getCloud().received;
    if (received === undefined) throw new Error("nothing received");
    expect(received).toMatchObject({ id: share.id, fromTeamNumber: 36596, fromTeamName: "Horizon", projection });

    const loads = await receivedShareSource(received).load();
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({ ok: true, fileName: "Team 36596 (unverified)" });

    // With an auto open, Load puts the partner in the alliance view.
    openProject(project, { kind: "local" } as unknown as ProjectBackend);
    const own = loadAuto(read("autos/first-auto.auto.json"));
    openAuto("first-auto.auto.json", own, canonicalize("auto", own));
    await loadReceivedShare(received);
    expect(getAllianceState().partners.map((partner) => partner.label)).toEqual(["Team 36596 (unverified)"]);
    expect(getCloud().sheet).toBeNull();

    // The alliance view compares the two: the shared projection is the one Grace sees drawn.
    const plan = currentDerived().plan;
    expect(plan).not.toBeNull();
    if (plan !== null) expect(runSim(plan, plan.robot, plan.field).run).not.toBeNull();
  });

  it("opens a received share alone, read only, when no auto is open", async () => {
    const { grace } = await sharedWithGrace();
    wire(grace);
    await settled();
    await refreshReceived();
    const [received] = getCloud().received;
    if (received === undefined) throw new Error("nothing received");
    closeProject();
    await loadReceivedShare(received);
    expect(getCloud().sheet).toBe("viewer");
    expect(getCloud().viewing?.id).toBe(received.id);
    expect(getAllianceState().partners).toEqual([]);
  });

  it("opens an anyone-with-the-link share from #/s/<secret> with nobody signed in", async () => {
    const { database, share, projection } = await sharedWithGrace("link");
    const stranger = device(database);
    await stranger.model.start();
    wire(stranger);
    await settled();
    expect(getCloud().session.signedIn).toBe(false);
    closeProject();
    let cleared = false;
    expect(
      await followShareLink(`#/s/${share.linkSecret ?? ""}`, () => {
        cleared = true;
      }),
    ).toBe(true);
    expect(cleared).toBe(true);
    expect(getCloud().sheet).toBe("viewer");
    expect(getCloud().viewing).toMatchObject({ id: share.id, audience: "link", projection });
    // Any other address is left alone.
    expect(await followShareLink("#/join/abc", () => undefined)).toBe(false);
  });

  it("takes a link's secret out of the address before the cloud is even there, and opens it later", async () => {
    const { database, share, projection } = await sharedWithGrace("link");
    const secret = share.linkSecret ?? "";
    // Before any backend exists, the secret leaves the address and is held in memory only.
    let address = `#/s/${secret}`;
    const held = takeShareSecret(address, () => {
      address = "";
    });
    expect(held).toBe(secret);
    expect(address).toBe("");
    expect(takeShareSecret("#/join/abc", () => undefined)).toBeNull();

    const stranger = device(database);
    await stranger.model.start();
    wire(stranger);
    await settled();
    closeProject();
    await openShareSecret(held ?? "");
    expect(getCloud().viewing).toMatchObject({ id: share.id, audience: "link", projection });
  });

  it("opens nothing from a share's id in a #/s/ address: only a link share's secret opens it", async () => {
    const { database, grace, share } = await sharedWithGrace();
    const later = device(database);
    await later.model.start();
    wire(later);
    await settled();
    closeProject();
    // Even Grace, whose team the share was made to, opens it from her Partners panel, not a link.
    const graceUid = grace.backend().currentUser()?.uid ?? "";
    expect(await later.model.switchFakeUser(graceUid)).toBe(true);
    await settled();
    expect(await followShareLink(`#/s/${share.id}`, () => undefined)).toBe(true);
    expect(getCloud().sheet).toBeNull();
  });
});

describe("the commits Publish passes on", () => {
  it("names a commit only while the file is the text that commit holds", () => {
    rememberCommit("a.auto.json", "one", "ABCDEF1234567");
    expect(commitFor("a.auto.json", "one")).toBe("abcdef1234567");
    expect(commitFor("a.auto.json", "two")).toBeNull();
    expect(commitFor("b.auto.json", "one")).toBeNull();
    rememberCommit("c.auto.json", "one", "not a sha");
    expect(commitFor("c.auto.json", "one")).toBeNull();
  });
});
