/**
 * A share's revision and end date are plain fields the server writes, so the owner team's manifest
 * signs them too. These tests have the server move each one without the owner, and check that the
 * Sharing store refuses to rebuild or seal anything from what the server says: a level change on a
 * pinned share never hands the partner a revision that was not shared, and a follow-latest publish
 * never reaches a partner whose share has ended.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadLink } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { NOW_MS, cloudWorld, ownerSawPartnerCodes, publishTo } from "./cloudFixture.test";
import { createCloudSharingApi } from "./cloudSharingApi";
import { getCloud, publishFollowedShares, setShareLevel, setSharingBackend } from "./store";

const DAY = 86_400_000;
const root = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const readText = (relative: string): string => readFileSync(`${root}${relative}`, "utf8");
const link = loadLink(JSON.parse(readText("zenith.json")));
const waypoints = readText(link.waypoints ?? "autos/waypoints.json");
const files1 = { robot: readText(link.robot), field: readText(link.field), waypoints };
const files2 = { ...files1, waypoints: waypoints.replace('"yIn": -36,\n      "headingRad": 1.5708', '"yIn": -20,\n      "headingRad": 1.5708') };
const exampleAuto = canonicalize("auto", loadAuto(JSON.parse(readText("autos/first-auto.auto.json"))));

describe("a pinned share's revision is the one the owner team signed", () => {
  it("refuses a level change on a pinned share the server pointed at a revision that was never shared", async () => {
    expect(files2.waypoints).not.toBe(files1.waypoints);
    const world = await cloudWorld([12345]);
    ownerSawPartnerCodes(world);
    const partner = world.partners[0]!;
    const api = createCloudSharingApi(world.owner.backend, { now: () => NOW_MS });
    setSharingBackend(api, { signedIn: true, teamId: world.owner.teamId, teamNumber: 36596, teamName: "Horizon" }, { now: () => NOW_MS });
    const r1 = await publishTo(world.owner, "first-auto.auto.json", exampleAuto, files1);
    const share = await api.createShare(world.owner.teamId, {
      autoId: r1.autoId, audience: "teams", teamNumbers: [12345], level: "view", mode: "pinned",
      revision: r1.n, revisionId: r1.revisionId, expiresAt: new Date(NOW_MS + 7 * DAY).toISOString(),
      projection: '{"kind":"projection","level":"view"}', choice: { coarsen: true, includeCommands: false, title: null },
    });
    const before = (await partner.backend.getShare(share.id, partner.teamId))?.projection;
    // A later revision, kept in the library and never shared.
    const r2 = await publishTo(world.owner, "first-auto.auto.json", exampleAuto, files2);
    // The server points the pinned share at r2.
    const doc = world.database.peek(`shares/${share.id}`) as Record<string, unknown>;
    world.database.seed(`shares/${share.id}`, { ...doc, revision: r2.revisionId });

    expect(await setShareLevel(share.id, "propose", "Changed.")).toBeNull();
    expect(getCloud().error).toMatch(/did not pass its check/);
    // Nothing was sealed for the partner: the share still shows what it showed, at view.
    world.database.seed(`shares/${share.id}`, doc);
    const seen = await partner.backend.getShare(share.id, partner.teamId);
    expect(seen?.projection).toBe(before);
    expect(seen?.level).toBe("view");
    expect(seen?.revision).toBe(r1.revisionId);
  });

  it("rebuilds a level change from the revision the share was signed at", async () => {
    const world = await cloudWorld([12345]);
    ownerSawPartnerCodes(world);
    const partner = world.partners[0]!;
    const api = createCloudSharingApi(world.owner.backend, { now: () => NOW_MS });
    setSharingBackend(api, { signedIn: true, teamId: world.owner.teamId, teamNumber: 36596, teamName: "Horizon" }, { now: () => NOW_MS });
    const r1 = await publishTo(world.owner, "first-auto.auto.json", exampleAuto, files1);
    const share = await api.createShare(world.owner.teamId, {
      autoId: r1.autoId, audience: "teams", teamNumbers: [12345], level: "view", mode: "pinned",
      revision: r1.n, revisionId: r1.revisionId, expiresAt: new Date(NOW_MS + 7 * DAY).toISOString(),
      projection: '{"kind":"projection","level":"view"}', choice: { coarsen: true, includeCommands: false, title: null },
    });
    const r2 = await publishTo(world.owner, "first-auto.auto.json", exampleAuto, files2);
    const later = await api.createShare(world.owner.teamId, {
      autoId: r2.autoId, audience: "teams", teamNumbers: [12345], level: "view", mode: "pinned",
      revision: r2.n, revisionId: r2.revisionId, expiresAt: new Date(NOW_MS + 7 * DAY).toISOString(),
      projection: '{"kind":"projection","level":"view"}', choice: { coarsen: true, includeCommands: false, title: null },
    });
    expect(await setShareLevel(share.id, "propose", "Changed.")).not.toBeNull();
    expect(await setShareLevel(later.id, "propose", "Changed.")).not.toBeNull();
    expect(getCloud().error).toBeNull();
    const seen = await partner.backend.getShare(share.id, partner.teamId);
    const fromR2 = await partner.backend.getShare(later.id, partner.teamId);
    expect(seen?.level).toBe("propose");
    expect(seen?.revision).toBe(r1.revisionId);
    expect(fromR2?.revision).toBe(r2.revisionId);
    // Each is rebuilt from its own signed revision, so the two differ.
    expect(seen?.projection.length).toBeGreaterThan(0);
    expect(seen?.projection).not.toBe(fromR2?.projection);
  });
});

describe("a share's end date is the one the owner team signed", () => {
  it("stops sealing into an ended follow share whose end date the server moved on", async () => {
    const world = await cloudWorld([12345]);
    ownerSawPartnerCodes(world);
    const partner = world.partners[0]!;
    let clockMs = NOW_MS;
    const api = createCloudSharingApi(world.owner.backend, { now: () => clockMs });
    setSharingBackend(api, { signedIn: true, teamId: world.owner.teamId, teamNumber: 36596, teamName: "Horizon" }, { now: () => clockMs });
    const r1 = await publishTo(world.owner, "a.auto.json", '{"kind":"auto"}\n');
    const share = await api.createShare(world.owner.teamId, {
      autoId: r1.autoId, audience: "teams", teamNumbers: [12345], level: "view", mode: "follow",
      revision: r1.n, revisionId: r1.revisionId, expiresAt: new Date(NOW_MS + 1 * DAY).toISOString(),
      projection: '{"v":"one"}', choice: { coarsen: true, includeCommands: false, title: null },
    });
    // Three days on, the share ended two days ago.
    clockMs = NOW_MS + 3 * DAY;
    const r2 = await publishTo(world.owner, "a.auto.json", '{"kind":"auto","n":2}\n');
    expect(await publishFollowedShares(r1.autoId, r2.revisionId, () => '{"v":"two"}')).toBe(0);
    // The server moves the end date on, without the owner.
    const doc = world.database.peek(`shares/${share.id}`) as Record<string, unknown>;
    world.database.seed(`shares/${share.id}`, { ...doc, expiresAt: new Date(NOW_MS + 60 * DAY) });
    const r3 = await publishTo(world.owner, "a.auto.json", '{"kind":"auto","n":3}\n');
    expect(await publishFollowedShares(r1.autoId, r3.revisionId, () => '{"v":"three, after the end"}')).toBeNull();
    expect(getCloud().error).toMatch(/did not pass its check/);
    world.database.seed(`shares/${share.id}`, doc);
    expect((await partner.backend.getShare(share.id, partner.teamId))?.projection).toBe('{"v":"one"}');
  });
});
