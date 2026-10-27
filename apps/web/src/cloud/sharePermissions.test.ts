/**
 * Who may make and change a share (spec 13 section 4.3, with its two team settings), as the share
 * dialog and the Sharing page check it: `whyCannotMakeShare` and `whyCannotChangeShare`. The second
 * half runs every check against the in-memory cloud's real rules, so a button the page enables is
 * one the rules accept, and a button it disables is one they refuse.
 */
import { describe, expect, it } from "vitest";
import type { ActiveRole, CloudBackend, Queued, Share as CloudShare } from "@horizon36596/zenith-cloud";
import { MemoryBackend } from "@horizon36596/zenith-cloud/memory";
import { NOW_MS, cloudWorld, fixedRandom, publishTo, type CloudWorld } from "./cloudFixture.test";
import { whyCannotChangeShare, whyCannotMakeShare, type ShareActor } from "./shareModel";

const DEFAULTS = { editorsMayProposeShare: false, editorsMayLinkShare: false };
const actor = (role: ShareActor["role"], uid = "me", settings = DEFAULTS): ShareActor => ({ role, uid, settings });
const share = (patch: Partial<Pick<CloudShare, "audience" | "level" | "createdBy">> = {}) => ({
  audience: "teams" as const,
  level: "view" as const,
  createdBy: "me",
  ...patch,
});

describe("who may make a share", () => {
  it("lets owners and admins make any share, and editors a view share to teams unless the team allows more", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(whyCannotMakeShare(actor(role), { audience: "link", level: "view" })).toBeNull();
      expect(whyCannotMakeShare(actor(role), { audience: "teams", level: "propose" })).toBeNull();
    }
    expect(whyCannotMakeShare(actor("editor"), { audience: "teams", level: "view" })).toBeNull();
    expect(whyCannotMakeShare(actor("editor"), { audience: "teams", level: "propose" })).toBe(
      "Only admins can share at the propose level in this team.",
    );
    expect(whyCannotMakeShare(actor("editor"), { audience: "link", level: "view" })).toBe(
      "Only admins can make an anyone-with-the-link share in this team.",
    );
    const open = { editorsMayProposeShare: true, editorsMayLinkShare: true };
    expect(whyCannotMakeShare(actor("editor", "me", open), { audience: "teams", level: "propose" })).toBeNull();
    expect(whyCannotMakeShare(actor("editor", "me", open), { audience: "link", level: "view" })).toBeNull();
    expect(whyCannotMakeShare(actor("viewer"), { audience: "teams", level: "view" })).toMatch(/^Viewers cannot share/);
  });
});

describe("who may change a share", () => {
  it("lets owners and admins change any share", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(whyCannotChangeShare(actor(role), share({ createdBy: "someone else" }))).toBeNull();
      expect(whyCannotChangeShare(actor(role), share({ createdBy: "someone else" }), { level: "propose" })).toBeNull();
    }
  });

  it("lets an editor change only the shares they made, and only within what they may make", () => {
    expect(whyCannotChangeShare(actor("editor"), share())).toBeNull();
    expect(whyCannotChangeShare(actor("editor"), share({ createdBy: "someone else" }))).toBe(
      "Only the team's owners and admins, or the editor who made this share, can change it.",
    );
    // Raising their own share to propose needs the team's setting.
    expect(whyCannotChangeShare(actor("editor"), share(), { level: "propose" })).toBe(
      "Only admins can share at the propose level in this team.",
    );
    const open = { editorsMayProposeShare: true, editorsMayLinkShare: false };
    expect(whyCannotChangeShare(actor("editor", "me", open), share(), { level: "propose" })).toBeNull();
    // Lowering a propose share they made to view is always theirs to do.
    expect(whyCannotChangeShare(actor("editor"), share({ level: "propose" }), { level: "view" })).toBeNull();
  });

  it("refuses viewers, pending members and someone in no team, each with its own reason", () => {
    expect(whyCannotChangeShare(actor("viewer"), share())).toBe("Viewers cannot change shares. Ask an admin to make you an editor.");
    expect(whyCannotChangeShare(actor("pending"), share())).toMatch(/waiting for an owner or admin/);
    expect(whyCannotChangeShare(actor(null), share())).toBe("Choose a team first.");
  });
});

// ------------------------------------------------------------------------------------------------
// Against the rules
// ------------------------------------------------------------------------------------------------

const DAY = 86_400_000;

/** Whether the rules accept a write: it resolves once the server has it, or rejects. */
async function accepted(work: () => Promise<Queued<unknown>>): Promise<boolean> {
  try {
    await (await work()).sent;
    return true;
  } catch {
    return false;
  }
}

interface Member {
  uid: string;
  role: ActiveRole;
  backend: MemoryBackend;
}

let seed = 1000;

/** Adds a member to Horizon's team with `role`, through an invite that lets them in at once. */
async function join(world: CloudWorld, uid: string, role: Exclude<ActiveRole, "owner">): Promise<Member> {
  // An admin invite never approves at once (owner ruling 2026-10-25): an admin waits, and is approved with the key.
  const invite = await world.owner.backend.createInvite(world.owner.teamId, { role, autoApprove: role !== "admin" });
  await invite.sent;
  const backend = new MemoryBackend({ database: world.database, random: fixedRandom((seed += 1)) });
  backend.signInAs(uid);
  await (await backend.saveProfile({ displayName: uid })).sent;
  await (await backend.redeemInvite(invite.value.code)).sent;
  if (role === "admin") {
    const status = await backend.teamKeyStatus(world.owner.teamId);
    if (status.state !== "waiting") throw new Error("already holds the key");
    await (await world.owner.backend.approveMember(world.owner.teamId, uid, { deviceId: status.device.deviceId, approvalCode: status.approvalCode })).sent;
  } else {
    await grantWaiting(world.owner.backend, world.owner.teamId, backend);
  }
  return { uid, role, backend };
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


describe("the Sharing page's checks agree with the rules", () => {
  it("for every role, share maker, level and team setting, on extend, a change of level and revoke", async () => {
    const world = await cloudWorld([12345]);
    const partner = world.partners[0]?.teamId ?? "";
    const at = await publishTo(world.owner, "first-auto.auto.json", '{"kind":"auto"}\n');
    const owner: Member = { uid: world.owner.uid, role: "owner", backend: world.owner.backend };
    const members = [
      owner,
      await join(world, "the-admin", "admin"),
      await join(world, "the-editor", "editor"),
      await join(world, "other-editor", "editor"),
      await join(world, "the-viewer", "viewer"),
    ];
    const editor = members[2] as Member;
    const teamId = world.owner.teamId;

    const makeShare = async (by: Member, audience: "teams" | "link", level: "view" | "propose"): Promise<CloudShare> => {
      const made = await by.backend.createShare({
        teamId,
        autoId: at.autoId,
        revision: at.revisionId,
        audience,
        teamIds: audience === "teams" ? [partner] : [],
        level,
        mode: "pinned",
        expiresAt: new Date(NOW_MS + 7 * DAY),
        projection: '{"kind":"projection"}',
      });
      await made.sent;
      return made.value;
    };
    const setSettings = async (patch: { editorsMayProposeShare: boolean; editorsMayLinkShare: boolean }): Promise<void> => {
      await (await world.owner.backend.updateTeamSettings(teamId, patch)).sent;
    };

    // Shares made while editors may do everything, so the editor has one of each kind to change.
    await setSettings({ editorsMayProposeShare: true, editorsMayLinkShare: true });
    const kinds = [
      { by: owner, audience: "teams", level: "view" },
      { by: owner, audience: "teams", level: "propose" },
      { by: owner, audience: "link", level: "view" },
      { by: editor, audience: "teams", level: "view" },
      { by: editor, audience: "teams", level: "propose" },
      { by: editor, audience: "link", level: "view" },
    ] as const;

    let checked = 0;
    for (const settings of [
      { editorsMayProposeShare: false, editorsMayLinkShare: false },
      { editorsMayProposeShare: true, editorsMayLinkShare: false },
      { editorsMayProposeShare: false, editorsMayLinkShare: true },
    ]) {
      await setSettings({ editorsMayProposeShare: true, editorsMayLinkShare: true });
      const made = [];
      for (const kind of kinds) made.push(await makeShare(kind.by, kind.audience, kind.level));
      await setSettings(settings);

      for (const member of members) {
        const who = actor(member.role, member.uid, settings);
        for (const stored of made) {
          const label = `${member.uid} on ${stored.createdBy}'s ${stored.audience} ${stored.level} share, settings ${JSON.stringify(settings)}`;

          const extendOk = await accepted(() => member.backend.extendShare(stored.id, new Date(NOW_MS + 10 * DAY)));
          expect(whyCannotChangeShare(who, stored) === null, `extend: ${label}`).toBe(extendOk);

          if (stored.audience === "teams") {
            const next = stored.level === "propose" ? "view" : "propose";
            const levelOk = await accepted(() => member.backend.setShareLevel(stored.id, next));
            expect(whyCannotChangeShare(who, stored, { level: next }) === null, `level: ${label}`).toBe(levelOk);
            // Put it back as it was, as the owner, for the next member.
            if (levelOk) await (await world.owner.backend.setShareLevel(stored.id, stored.level)).sent;
          }
          checked += 1;
        }
      }

      // Revoke is final, so it goes last, on a fresh set of shares for each member.
      for (const member of members) {
        await setSettings({ editorsMayProposeShare: true, editorsMayLinkShare: true });
        const fresh = [];
        for (const kind of kinds) fresh.push(await makeShare(kind.by, kind.audience, kind.level));
        await setSettings(settings);
        const who = actor(member.role, member.uid, settings);
        for (const stored of fresh) {
          const revokeOk = await accepted(() => member.backend.revokeShare(stored.id));
          expect(whyCannotChangeShare(who, stored) === null, `revoke: ${member.uid} on ${stored.createdBy}'s ${stored.audience} ${stored.level}`).toBe(
            revokeOk,
          );
        }
      }
    }
    expect(checked).toBe(3 * members.length * kinds.length);
    // Every change of level and every revoke signs a new manifest, so the whole sweep takes seconds.
  }, 60_000);
});
