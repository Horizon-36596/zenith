/**
 * The Sharing store's rebuilds of a share's projection, against a server that rewrites a share's
 * plain fields and a partner team that holds the share's key. A follow-latest publish, a change of
 * level and Update share must build only for a share whose owner-signed terms say so, and only with
 * the options the sharer chose, which the cloud keeps sealed under the sharing team's own key; the
 * projection the share carries is open to every team it was made to, so it decides nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadLink } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { KEY_ERRORS } from "../account/keys/errors";
import { NOW_MS, cloudWorld, ownerSawPartnerCodes, publishTo, type CloudWorld } from "./cloudFixture.test";
import { createCloudSharingApi } from "./cloudSharingApi";
import { includesCommands, isCoarsened, projectionTitle, type ProjectionChoice } from "./projectionModel";
import { getCloud, publishFollowedShares, setShareLevel, setSharingBackend } from "./store";
import type { ShareRequest, SharingApi } from "./types";

const DAY_MS = 86_400_000;

/**
 * A projection with every option on: fine quanta, command names and the auto's name. It stands for
 * one a partner team sealed again under the share's key, which it holds, and the server stored.
 */
const EVERYTHING_ON = JSON.stringify({
  kind: "projection",
  level: "view",
  title: "far-side 7-ball",
  commands: [],
  trajectory: { positionQuantumIn: 0.5 },
});

const root = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const readText = (relative: string): string => readFileSync(`${root}${relative}`, "utf8");
const link = loadLink(JSON.parse(readText("zenith.json")));
/** The starter's first auto with the robot and field it was made for, as the library keeps them. */
const exampleFiles = { robot: readText(link.robot), field: readText(link.field), waypoints: readText(link.waypoints ?? "autos/waypoints.json") };
const exampleAuto = canonicalize("auto", loadAuto(JSON.parse(readText("autos/first-auto.auto.json"))));

async function signedIn(): Promise<{ world: CloudWorld; api: SharingApi }> {
  const world = await cloudWorld([12345]);
  ownerSawPartnerCodes(world);
  const api = createCloudSharingApi(world.owner.backend, { now: () => NOW_MS });
  setSharingBackend(api, { signedIn: true, teamId: world.owner.teamId, teamNumber: 36596, teamName: "Horizon" }, { now: () => NOW_MS });
  return { world, api };
}

const requestFor = (at: { autoId: string; revisionId: string; n: number }, patch: Partial<ShareRequest> = {}): ShareRequest => ({
  autoId: at.autoId,
  audience: "teams",
  teamNumbers: [12345],
  level: "view",
  mode: "follow",
  revision: at.n,
  revisionId: at.revisionId,
  expiresAt: new Date(NOW_MS + 7 * DAY_MS).toISOString(),
  projection: '{"kind":"projection","level":"view"}',
  choice: { coarsen: true, includeCommands: false, title: null },
  ...patch,
});

describe("rebuilding a share's projection", () => {
  it("builds nothing for a view share of one auto that the server points at another auto, makes follow and raises to propose", async () => {
    const { world, api } = await signedIn();
    const partner = world.partners[0];
    if (partner === undefined) throw new Error("no partner");
    const shared = await publishTo(world.owner, "shared.auto.json", '{"kind":"auto"}\n');
    const secret = await publishTo(world.owner, "secret.auto.json", '{"kind":"auto","secret":1}\n');
    const share = await api.createShare(world.owner.teamId, requestFor(shared, { mode: "pinned" }));
    const doc = world.database.peek(`shares/${share.id}`) as Record<string, unknown>;
    world.database.seed(`shares/${share.id}`, { ...doc, autoId: secret.autoId, mode: "follow", level: "propose" });

    const next = await publishTo(world.owner, "secret.auto.json", '{"kind":"auto","secret":2}\n');
    const built: ProjectionChoice[] = [];
    const moved = await publishFollowedShares(secret.autoId, next.revisionId, (choice) => {
      built.push(choice);
      return '{"secret":"projection of the secret auto"}';
    });
    expect(moved).toBeNull();
    expect(getCloud().error).toBe(KEY_ERRORS.tampered);
    expect(built).toEqual([]);
    world.database.seed(`shares/${share.id}`, doc);
    expect((await partner.backend.getShare(share.id, partner.teamId))?.projection).toBe('{"kind":"projection","level":"view"}');
  });

  it("rebuilds a followed share with the sharer's own choices, not with those of a projection a partner sealed again", async () => {
    const { world, api } = await signedIn();
    const at = await publishTo(world.owner, "shared.auto.json", '{"kind":"auto"}\n');
    const share = await api.createShare(world.owner.teamId, requestFor(at));
    // What the share carries now has every option on, as a partner holding its key could make it.
    await api.updateShare(share.id, { revisionId: at.revisionId, projection: EVERYTHING_ON });
    const next = await publishTo(world.owner, "shared.auto.json", '{"kind":"auto","n":2}\n');
    const built: ProjectionChoice[] = [];
    const moved = await publishFollowedShares(at.autoId, next.revisionId, (choice) => {
      built.push(choice);
      return '{"kind":"projection","level":"view","rebuilt":true}';
    });
    expect(moved).toBe(1);
    expect(built).toEqual([{ level: "view", coarsen: true }]);
  });

  it("rebuilds a share whose choices were never kept with the most private options", async () => {
    const { world, api } = await signedIn();
    const at = await publishTo(world.owner, "shared.auto.json", '{"kind":"auto"}\n');
    const { choice: _choice, ...withoutChoice } = requestFor(at, { projection: EVERYTHING_ON });
    await api.createShare(world.owner.teamId, withoutChoice);
    const next = await publishTo(world.owner, "shared.auto.json", '{"kind":"auto","n":2}\n');
    const built: ProjectionChoice[] = [];
    await publishFollowedShares(at.autoId, next.revisionId, (choice) => {
      built.push(choice);
      return '{"kind":"projection","level":"view","rebuilt":true}';
    });
    expect(built).toEqual([{ level: "view", coarsen: true }]);
  });

  it("rebuilds at a new level with the sharer's own choices, not with those of a projection a partner sealed again", async () => {
    const { world, api } = await signedIn();
    const at = await publishTo(world.owner, "first-auto.auto.json", exampleAuto, exampleFiles);
    const share = await api.createShare(world.owner.teamId, requestFor(at, { mode: "pinned", projection: EVERYTHING_ON }));
    await setShareLevel(share.id, "propose", "Changed.");
    expect(getCloud().error).toBeNull();
    const [raised] = await api.listShares(world.owner.teamId);
    expect(raised?.level).toBe("propose");
    expect(isCoarsened(raised?.projection ?? "")).toBe(true);
    expect(includesCommands(raised?.projection ?? "")).toBe(false);
    expect(projectionTitle(raised?.projection ?? "")).toBeNull();
    expect(raised?.choice).toEqual({ coarsen: true, includeCommands: false, title: null });
  });
});
