/**
 * The account, teams and library state against the in-memory cloud, which applies the same
 * permission rules as Firestore (packages/cloud/src/memory/rules.ts). Spec 13 sections 4, 5, 6 and
 * 12.1; the contracts of M-C1 and M-C2 as the UI sees them.
 */
import { describe, expect, it } from "vitest";
import { MemoryBackend, MemoryDatabase, type CloudBackend, type Member } from "@horizon36596/zenith-cloud";
import { cloudConfigFrom, emailLinkEnabledFor, parseAppCheckSiteKey, parseFirebaseConfig } from "./config";
import {
  EXPIRY_PRESETS,
  expiresInSeconds,
  extendedMs,
  inviteState,
  joinLink,
  localDateTimeMs,
  parseJoinHash,
  timeLeftWords,
  whyCannotCreateInvite,
} from "./invites";
import { AccountModel } from "./model";
import {
  roleChoices,
  whyCannotApproveMember,
  whyCannotChangeRole,
  whyCannotDeleteTeam,
  whyCannotEditSettings,
  whyCannotInvite,
  whyCannotLeave,
  whyCannotOpenLibrary,
  whyCannotPublish,
  whyCannotRemove,
  whyCannotShare,
  whyCannotTransfer,
  whyCannotViewActivity,
} from "./permissions";
import { KEYS, memoryStorage } from "./storage";
import { outboxSummary, signOutDropsWords } from "./words";

const DAY = 86_400_000;
/** 27 September 2026, noon on this computer's clock. */
const NOW = new Date(2026, 8, 27, 12, 0, 0).getTime();

/**
 * A cloud whose server clock starts at NOW and ticks a millisecond per read of it. Its devices
 * derive approval codes' keys with few PBKDF2 iterations: the app's 600,000 take about a third of a
 * second each, which these tests do not check (`crypto.vectors.test.ts` checks the real count).
 */
function cloudAtNow(): MemoryDatabase {
  let t = NOW;
  return new MemoryDatabase({ now: () => new Date((t += 1)), approvalKdfIterations: 10 });
}

/** Within a second: the server stamps a write a few clock ticks after the device computed it. */
const near = (actual: number | undefined, expected: number) => {
  expect(Math.abs((actual ?? 0) - expected)).toBeLessThan(1000);
};

function device(database: MemoryDatabase, storage = memoryStorage(), clock = () => NOW) {
  let backend: MemoryBackend | null = null;
  const said: string[] = [];
  const model = new AccountModel({
    mode: "fake",
    storage,
    now: clock,
    pageUrl: () => "http://localhost:5173/?cloud=fake#/",
    createBackend: async () => {
      backend = new MemoryBackend({ database });
      return backend;
    },
    say: (_kind, text) => {
      said.push(text);
    },
  });
  return {
    model,
    storage,
    said,
    backend: () => {
      if (backend === null) throw new Error("not started");
      return backend;
    },
  };
}

/** A provider and a display name: a signed-in member with a profile. */
async function signedIn(d: ReturnType<typeof device>, provider: "github" | "google" | "microsoft", name: string) {
  await d.model.start();
  d.model.open("signIn");
  await d.model.signInWith(provider);
  await d.model.saveDisplayName(name);
  expect(d.model.getState().error).toBeNull();
}

const FILE = "first-auto.auto.json";
const autoText = (x: number) => `${JSON.stringify({ kind: "auto", x })}\n`;

describe("signing in without an age screen (owner ruling 2026-10-02)", () => {
  it("starts at the ways to sign in and keeps only the display name in the profile", async () => {
    const database = cloudAtNow();
    const d = device(database);
    await d.model.start();
    d.model.open("signIn");
    expect(d.model.getState().step).toBe("providers");
    await d.model.signInWith("github");
    expect(d.model.getState().step).toBe("profile");
    await d.model.saveDisplayName("Ada");
    const profile = database.peek(`users/${d.backend().currentUser()?.uid ?? ""}`);
    expect(Object.keys(profile ?? {}).sort()).toEqual(["createdAt", "displayName"]);
  });

  it("deletes the old age screen's device flag, which nothing reads any more", async () => {
    const storage = memoryStorage({ [KEYS.retiredAgeScreen]: "under13" });
    const d = device(cloudAtNow(), storage);
    await d.model.start();
    expect(storage.get(KEYS.retiredAgeScreen)).toBeNull();
    d.model.open("signIn");
    expect(d.model.getState().step).toBe("providers");
    await d.model.signInWith("github");
    expect(d.model.getState().error).toBeNull();
    expect(d.backend().currentUser()).not.toBeNull();
  });
});

describe("signing out", () => {
  it("starts the next person at this computer at the ways to sign in", async () => {
    const d = device(cloudAtNow());
    await signedIn(d, "github", "Ada");
    await d.model.signOut();
    d.model.open("signIn");
    expect(d.model.getState().step).toBe("providers");
  });

  it("says a publish still waiting offline was dropped, not refused, and never sends it (issue #319)", async () => {
    const database = cloudAtNow();
    const d = device(database);
    await signedIn(d, "github", "Ada");
    await d.model.createTeam({ number: 36596, name: "Horizon" });
    d.model.dismissRecoveryCode();
    await d.backend().setOnline(false);
    await d.model.publish({ fileName: FILE, canonical: autoText(1), project: null });
    const waiting = d.model.getState().outbox?.queued ?? 0;
    expect(waiting).toBeGreaterThan(0);

    await d.model.signOut();
    expect(d.model.getState().notice).toBe(
      `Signed out. The team library's offline copy on this computer was cleared, and ${String(waiting)} changes waiting in the Outbox were dropped; they may not have reached the server.`,
    );
    const outbox = d.model.getState().outbox;
    expect(outbox).toMatchObject({ queued: 0, failed: 0, dropped: waiting });
    const unsent = outbox?.entries.filter((e) => e.state !== "sent") ?? [];
    expect(unsent).toHaveLength(waiting);
    expect(unsent.every((e) => e.state === "dropped" && !/refused/i.test(e.error ?? ""))).toBe(true);

    // Back online and signed in again: nothing from before the sign-out reached the library.
    await d.backend().setOnline(true);
    await d.model.signInWith("github");
    expect(d.model.getState().library.autos).toEqual([]);
  });

  it("says nothing about dropped changes when the Outbox was empty", async () => {
    const d = device(cloudAtNow());
    await signedIn(d, "github", "Ada");
    await d.model.signOut();
    expect(d.model.getState().notice).toBe("Signed out. The team library's offline copy on this computer was cleared.");
  });
});

describe("the Outbox's words (issue #319)", () => {
  it("never says everything is sent over a change a sign-out dropped", () => {
    expect(outboxSummary(true, 0, 0)).toBe("Online. Everything is sent.");
    expect(outboxSummary(true, 0, 2)).toBe("Online. Nothing is waiting. 2 changes dropped by signing out may not have reached the server.");
    expect(outboxSummary(true, 1, 0)).toBe("Online. Sending 1 change.");
    expect(outboxSummary(false, 3, 1)).toBe("Offline. 3 changes are waiting to be sent. 1 change dropped by signing out may not have reached the server.");
    expect(outboxSummary(false, 0, 0)).toBe("Offline. Nothing is waiting to be sent.");
  });

  it("warns before a sign-out that would drop waiting changes, and says may, since one may be on its way", () => {
    expect(signOutDropsWords(1, false)).toBe(
      "1 change in the Outbox is not confirmed by the server yet. Signing out clears it from this computer, so it may never reach the server. Your saved auto files stay where they are. To keep it, stay signed in until this computer is back online and the Outbox has sent it.",
    );
    // Online, nobody is told to wait for a connection they already have.
    expect(signOutDropsWords(2, true)).toBe(
      "2 changes in the Outbox are not confirmed by the server yet. Signing out clears them from this computer, so they may never reach the server. Your saved auto files stay where they are. To keep them, stay signed in until the Outbox has sent them.",
    );
  });
});

describe("cloud mode", () => {
  it("uses the fake with ?cloud=fake or the flag, Firebase with a config, and is otherwise off", () => {
    const config = '{"apiKey":"k","projectId":"p"}';
    expect(cloudConfigFrom({ allowFake: true, search: "?cloud=fake", fakeFlag: null, firebaseJson: undefined }).mode).toBe("fake");
    expect(cloudConfigFrom({ allowFake: true, search: "", fakeFlag: "on", firebaseJson: config }).mode).toBe("fake");
    expect(cloudConfigFrom({ allowFake: true, search: "", fakeFlag: null, firebaseJson: config }).mode).toBe("firebase");
    expect(cloudConfigFrom({ allowFake: true, search: "", fakeFlag: null, firebaseJson: undefined }).mode).toBe("off");
  });

  it("turns App Check on only for the real cloud and only with a site key", () => {
    const config = JSON.stringify({ apiKey: "k", projectId: "p" });
    expect(parseAppCheckSiteKey(undefined)).toBeNull();
    expect(parseAppCheckSiteKey("  ")).toBeNull();
    expect(parseAppCheckSiteKey("two words")).toBeNull();
    expect(parseAppCheckSiteKey(" 6LcKEY ")).toEqual({ provider: "recaptcha-enterprise", siteKey: "6LcKEY" });
    expect(cloudConfigFrom({ allowFake: true, search: "", fakeFlag: null, firebaseJson: config }).appCheck).toBeNull();
    expect(cloudConfigFrom({ allowFake: true, search: "", fakeFlag: null, firebaseJson: config, appCheckSiteKey: "6LcKEY" }).appCheck).toEqual({
      provider: "recaptcha-enterprise",
      siteKey: "6LcKEY",
    });
    expect(cloudConfigFrom({ allowFake: true, search: "?cloud=fake", fakeFlag: null, firebaseJson: config, appCheckSiteKey: "6LcKEY" }).appCheck).toBeNull();
    expect(cloudConfigFrom({ allowFake: true, search: "", fakeFlag: null, firebaseJson: undefined, appCheckSiteKey: "6LcKEY" }).appCheck).toBeNull();
    expect(parseFirebaseConfig("{not json")).toBeNull();
    expect(parseFirebaseConfig('{"apiKey":"k"}')).toBeNull();
  });
});

describe("invite expiry choices (calendar times only)", () => {
  it("offers 1, 7 and 30 days and a date and time, and nothing tied to a season", () => {
    expect(EXPIRY_PRESETS.map((p) => p.days)).toEqual([1, 7, 30]);
    expect(JSON.stringify(EXPIRY_PRESETS)).not.toMatch(/season/i);
    expect(expiresInSeconds({ kind: "days", days: 7 }, NOW)).toBe(7 * 86_400);
    const at = localDateTimeMs("2026-10-03T18:30");
    expect(at).toBe(new Date(2026, 9, 3, 18, 30).getTime());
    expect(expiresInSeconds({ kind: "at", local: "2026-10-03T18:30" }, NOW)).toBe(((at ?? 0) - NOW) / 1000);
    expect(localDateTimeMs("2026-02-30T10:00")).toBeNull();
  });

  it("refuses a past or missing end and fewer than one use", () => {
    expect(whyCannotCreateInvite({ kind: "days", days: 1 }, 1, NOW)).toBeNull();
    expect(whyCannotCreateInvite({ kind: "at", local: "" }, 1, NOW)).toMatch(/Pick/);
    expect(whyCannotCreateInvite({ kind: "at", local: "2026-09-01T09:00" }, 1, NOW)).toMatch(/passed/);
    expect(whyCannotCreateInvite({ kind: "days", days: 7 }, 0, NOW)).toMatch(/at least one/);
  });

  it("extends from the later of now and the current end, and never shortens", () => {
    expect(extendedMs(NOW + DAY, { kind: "days", days: 7 }, NOW)).toBe(NOW + 8 * DAY);
    expect(extendedMs(NOW - DAY, { kind: "days", days: 1 }, NOW)).toBe(NOW + DAY);
    expect(extendedMs(NOW + 10 * DAY, { kind: "at", local: "2026-10-01T12:00" }, NOW)).toBeNull();
  });

  it("says how long is left and builds and reads join links", () => {
    expect(timeLeftWords(NOW + 3 * DAY + 5, NOW)).toBe("3 days left");
    expect(timeLeftWords(NOW + 5 * 3_600_000, NOW)).toBe("5 hours left");
    expect(timeLeftWords(NOW + 90_000, NOW)).toBe("1 minute left");
    expect(timeLeftWords(NOW - 1, NOW)).toBe("Ended");
    expect(timeLeftWords(NOW + 7 * DAY - 5, NOW)).toBe("7 days left");
    const base = { revoked: false, uses: 0, maxUses: 1, expiresAt: new Date(NOW + DAY) };
    expect(inviteState(base, NOW)).toBe("live");
    expect(inviteState({ ...base, uses: 1 }, NOW)).toBe("usedUp");
    expect(inviteState({ ...base, expiresAt: new Date(NOW) }, NOW)).toBe("expired");
    expect(inviteState({ ...base, revoked: true }, NOW)).toBe("revoked");
    const link = joinLink("AbCdEfGhIjKlMnOpQrStUv", "https://zenith.horizon36596.org/?cloud=fake#/x");
    // The fake cloud's query stays, so the link opens in the same fake cloud.
    expect(link).toBe("https://zenith.horizon36596.org/?cloud=fake#/join/AbCdEfGhIjKlMnOpQrStUv");
    expect(parseJoinHash(new URL(link).hash)).toBe("AbCdEfGhIjKlMnOpQrStUv");
    expect(parseJoinHash("#/review/a/b/1")).toBeNull();
  });
});

describe("controls enabled by role (spec 13 section 4.3)", () => {
  const member = (uid: string, role: Member["role"]): Member => ({
    uid,
    teamId: "t",
    role,
    displayName: uid,
    joinedAt: new Date(NOW),
  });
  const settings = { editorsMayProposeShare: false, editorsMayLinkShare: false, publishOnSave: false };

  it("matches the roles table for every team control", () => {
    const rows = (["owner", "admin", "editor", "viewer", "pending"] as const).map((role) => ({
      role,
      library: whyCannotOpenLibrary(role) === null,
      publish: whyCannotPublish(role) === null,
      invite: whyCannotInvite(role) === null,
      settings: whyCannotEditSettings(role) === null,
      activity: whyCannotViewActivity(role) === null,
      deleteTeam: whyCannotDeleteTeam(role) === null,
      leave: whyCannotLeave(role) === null,
      shareTeams: whyCannotShare(role, settings, { audience: "teams", level: "view" }) === null,
      shareLink: whyCannotShare(role, settings, { audience: "link", level: "view" }) === null,
      sharePropose: whyCannotShare(role, settings, { audience: "teams", level: "propose" }) === null,
    }));
    expect(rows).toEqual([
      {
        role: "owner",
        library: true,
        publish: true,
        invite: true,
        settings: true,
        activity: true,
        deleteTeam: true,
        leave: false,
        shareTeams: true,
        shareLink: true,
        sharePropose: true,
      },
      {
        role: "admin",
        library: true,
        publish: true,
        invite: true,
        settings: true,
        activity: true,
        deleteTeam: false,
        leave: true,
        shareTeams: true,
        shareLink: true,
        sharePropose: true,
      },
      {
        role: "editor",
        library: true,
        publish: true,
        invite: false,
        settings: false,
        activity: false,
        deleteTeam: false,
        leave: true,
        shareTeams: true,
        shareLink: false,
        sharePropose: false,
      },
      {
        role: "viewer",
        library: true,
        publish: false,
        invite: false,
        settings: false,
        activity: false,
        deleteTeam: false,
        leave: true,
        shareTeams: false,
        shareLink: false,
        sharePropose: false,
      },
      {
        role: "pending",
        library: false,
        publish: false,
        invite: false,
        settings: false,
        activity: false,
        deleteTeam: false,
        leave: true,
        shareTeams: false,
        shareLink: false,
        sharePropose: false,
      },
    ]);
    // The two team settings open the editor's two share kinds.
    const open = { ...settings, editorsMayLinkShare: true, editorsMayProposeShare: true };
    expect(whyCannotShare("editor", open, { audience: "link", level: "view" })).toBeNull();
    expect(whyCannotShare("editor", open, { audience: "teams", level: "propose" })).toBeNull();
  });

  it("offers role changes, removal, approval and transfer only where the rules allow them", () => {
    const owner = member("o", "owner");
    const admin = member("a", "admin");
    const editor = member("e", "editor");
    const pending = member("p", "pending");
    expect(roleChoices("owner", "o", editor)).toEqual(["owner", "admin", "editor", "viewer"]);
    expect(roleChoices("admin", "a", editor)).toEqual(["admin", "editor", "viewer"]);
    expect(roleChoices("admin", "a", owner)).toEqual([]);
    expect(roleChoices("editor", "e", member("v", "viewer"))).toEqual([]);
    expect(roleChoices("owner", "o", owner)).toEqual([]);
    expect(whyCannotChangeRole("owner", "o", owner)).toMatch(/own role/);
    expect(whyCannotChangeRole("admin", "a", owner)).toMatch(/owner/);
    expect(whyCannotChangeRole("admin", "a", editor)).toBeNull();
    expect(whyCannotRemove("admin", "a", owner)).toMatch(/owner/);
    expect(whyCannotRemove("admin", "a", editor)).toBeNull();
    expect(whyCannotRemove("editor", "e", member("v", "viewer"))).not.toBeNull();
    expect(whyCannotApproveMember("admin", pending)).toBeNull();
    expect(whyCannotApproveMember("editor", pending)).not.toBeNull();
    expect(whyCannotApproveMember("owner", editor)).toMatch(/already/);
    expect(whyCannotTransfer("owner", "o", admin)).toBeNull();
    expect(whyCannotTransfer("admin", "a", editor)).not.toBeNull();
    expect(whyCannotTransfer("owner", "o", pending)).not.toBeNull();
  });
});

describe("teams, invites and joining against the in-memory cloud", () => {
  it("shows what the newest read of the team found, when an older read answers last", async () => {
    const database = cloudAtNow();
    const owner = device(database);
    await signedIn(owner, "github", "Ada");
    expect(await owner.model.createTeam({ number: 36596, name: "Horizon" })).toBe(true);
    // Choosing a team starts a read that nothing waits for. Here it reads the invites before the
    // invite is made, and answers after the read that making the invite waits for.
    const backend = owner.backend();
    const listInvites = backend.listInvites.bind(backend);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let readFirst = () => {};
    const firstRead = new Promise<void>((resolve) => {
      readFirst = resolve;
    });
    let reads = 0;
    backend.listInvites = async (teamId) => {
      reads += 1;
      const first = reads === 1;
      const invites = await listInvites(teamId);
      if (first) {
        readFirst();
        await held;
      }
      return invites;
    };
    const older = owner.model.refreshTeam();
    await firstRead;
    const invite = await owner.model.createInvite({ role: "editor", expiry: { kind: "days", days: 1 }, maxUses: 1, autoApprove: false });
    expect(owner.model.getState().team?.invites.map((i) => i.code)).toEqual([invite?.code]);
    release();
    await older;
    expect(owner.model.getState().team?.invites.map((i) => i.code)).toEqual([invite?.code]);
  });

  it("creates an unverified team, invites with a chosen expiry, approves, changes roles and transfers ownership", async () => {
    const database = cloudAtNow();
    const owner = device(database);
    await signedIn(owner, "github", "Ada");
    expect(owner.model.getState().panel).toBe("teams");
    expect(await owner.model.createTeam({ number: 36596, name: "Horizon" })).toBe(true);
    const created = owner.model.getState();
    expect(created.memberships).toHaveLength(1);
    expect(created.memberships[0]?.team?.status).toBe("unverified");
    expect(owner.model.role()).toBe("owner");

    const invite = await owner.model.createInvite({
      role: "editor",
      expiry: { kind: "days", days: 1 },
      maxUses: 2,
      autoApprove: false,
    });
    expect(invite).not.toBeNull();
    near(invite?.expiresAt.getTime(), NOW + DAY);
    expect(owner.model.getState().team?.invites.map((i) => i.code)).toEqual([invite?.code]);

    const joiner = device(database);
    await joiner.model.start();
    await joiner.model.openJoin(invite?.code ?? "");
    // Signed out: the ways to sign in come first, even from a join link.
    expect(joiner.model.getState().step).toBe("providers");
    await joiner.model.signInWith("google");
    await joiner.model.saveDisplayName("Grace");
    expect(joiner.model.getState().step).toBe("join");
    expect(joiner.model.getState().join?.teamName).toBe("Horizon");
    expect(joiner.model.getState().join?.problem).toBeNull();
    expect(await joiner.model.redeemJoin()).toBe(true);
    expect(joiner.model.role()).toBe("pending");
    expect(whyCannotOpenLibrary(joiner.model.role())).not.toBeNull();

    await owner.model.refreshTeam();
    const pending = owner.model.getState().team?.members.find((m) => m.role === "pending");
    expect(pending?.displayName).toBe("Grace");
    // The owner types the approval code the joiner's device shows: the 18 characters of its waiting
    // state. No code, or a code that is not that device's, approves nothing.
    await joiner.model.refreshKeys();
    const teamId = owner.model.getState().teamId ?? "";
    const waiting = await joiner.backend().teamKeyStatus(teamId);
    if (waiting.state !== "waiting") throw new Error("The joiner's device should be waiting for the key.");
    const approvalCode = joiner.model.getState().keys?.approvalCode ?? "";
    expect(approvalCode).toBe(waiting.approvalCode);
    expect(approvalCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}(-[0-9A-HJKMNP-TV-Z]{6}){2}$/);
    const uid = pending?.uid ?? "";
    const wrong = `${approvalCode.startsWith("0") ? "1" : "0"}${approvalCode.slice(1)}`;
    await expect(owner.model.approveWithCode(uid, wrong)).rejects.toMatchObject({ code: "wrong-code" });
    await expect(owner.model.approveWithCode(uid, "")).rejects.toThrow(/does not match/);
    // The cloud refuses an approval without the code, whatever the screen does.
    await expect(owner.backend().approveMember(teamId, uid, { deviceId: waiting.device.deviceId, approvalCode: "" })).rejects.toMatchObject({
      code: "wrong-code",
    });
    await expect(
      owner.backend().approveMember(teamId, uid, undefined as unknown as { deviceId: string; approvalCode: string }),
    ).rejects.toThrow();
    expect(owner.model.getState().team?.members.find((m) => m.uid === uid)?.role).toBe("pending");
    expect((await joiner.backend().teamKeyStatus(teamId)).state).toBe("waiting");
    await owner.model.approveWithCode(uid, approvalCode.toLowerCase().replace(/-/g, " "));
    await joiner.model.refreshTeam();
    expect(joiner.model.getState().keys?.status?.state).toBe("ready");
    expect(owner.model.getState().team?.members.find((m) => m.uid === pending?.uid)?.role).toBe("editor");
    expect(await owner.model.setRole(pending?.uid ?? "", "admin")).toBe(true);
    expect(await owner.model.transferOwnership(pending?.uid ?? "")).toBe(true);
    expect(owner.model.getState().team?.members.find((m) => m.uid === pending?.uid)?.role).toBe("owner");
    expect(owner.model.role()).toBe("owner");

    // The activity log is there for admins, newest first.
    expect(owner.model.getState().team?.activity[0]?.kind).toBe("member.role");

    // Extend, then revoke; a revoked invite never adds anyone.
    expect(await owner.model.extendInvite(invite?.code ?? "", { kind: "days", days: 7 })).toBe(true);
    near(owner.model.getState().team?.invites[0]?.expiresAt.getTime(), NOW + 8 * DAY);
    expect(await owner.model.revokeInvite(invite?.code ?? "")).toBe(true);
    const late = device(database);
    await signedIn(late, "microsoft", "Linus");
    await late.model.openJoin(invite?.code ?? "");
    expect(late.model.getState().join?.problem).toMatch(/revoked/);
  });

  it("deletes a team only with its name typed exactly", async () => {
    const d = device(cloudAtNow());
    await signedIn(d, "github", "Ada");
    await d.model.createTeam({ number: null, name: "Horizon" });
    expect(await d.model.deleteTeam("horizon")).toBe(false);
    expect(d.model.getState().error).toMatch(/exactly/);
    expect(await d.model.deleteTeam("Horizon")).toBe(true);
    expect(d.model.getState().memberships).toEqual([]);
  });

  it("refuses to delete the account of a team owner, and deletes it otherwise", async () => {
    const d = device(cloudAtNow());
    await signedIn(d, "github", "Ada");
    await d.model.createTeam({ number: null, name: "Horizon" });
    expect(d.model.whyCannotDeleteAccount()).toMatch(/own a team/);
    expect(await d.model.deleteAccount()).toBe(false);
    const other = device(cloudAtNow());
    await signedIn(other, "google", "Grace");
    const exported = await other.model.exportMyData();
    expect(JSON.parse(exported ?? "{}").profile.displayName).toBe("Grace");
    expect(await other.model.deleteAccount()).toBe(true);
    expect(other.model.getState().user).toBeNull();
  });

  it("deletes nothing when a stale sign-in is not renewed, and says so", async () => {
    const database = cloudAtNow();
    const d = device(database);
    await signedIn(d, "google", "Grace");
    const uid = d.backend().currentUser()?.uid ?? "";
    d.backend().setSignInStale();
    d.backend().reauthentication = "cancelled";
    expect(await d.model.deleteAccount()).toBe(false);
    expect(d.model.getState().error).toMatch(/sign in again first.*Nothing was deleted/);
    expect(d.model.getState().user?.uid).toBe(uid);
    expect(database.peek(`users/${uid}`)).not.toBeNull();
    d.backend().reauthentication = "finishes";
    expect(await d.model.deleteAccount()).toBe(true);
    expect(database.peek(`users/${uid}`)).toBeNull();
  });
});

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

describe("the team library (spec 13 section 5)", () => {
  async function team() {
    const database = cloudAtNow();
    const a = device(database);
    await signedIn(a, "github", "Ada");
    await a.model.createTeam({ number: 36596, name: "Horizon" });
    // The new team's recovery code is held once, in the account state, until it is dismissed.
    const recovery = a.model.getState().newRecoveryCode;
    expect(recovery?.teamId).toBe(a.model.getState().teamId);
    expect(recovery?.code).toMatch(/^ZNTH/);
    a.model.dismissRecoveryCode();
    expect(a.model.getState().newRecoveryCode).toBeNull();
    const invite = await a.model.createInvite({
      role: "editor",
      expiry: { kind: "days", days: 7 },
      maxUses: 1,
      autoApprove: true,
    });
    const b = device(database);
    await signedIn(b, "google", "Grace");
    await b.model.openJoin(invite?.code ?? "");
    await b.model.redeemJoin();
    expect(b.model.role()).toBe("editor");
    await grantWaiting(a.backend(), a.model.getState().teamId ?? "", b.backend());
    return { database, a, b };
  }

  it("publishes revisions, skips an unchanged file, and marks two publishes from one base diverged", async () => {
    const { a, b } = await team();
    const r1 = await a.model.publish({ fileName: FILE, canonical: autoText(1), project: null });
    expect(r1?.n).toBe(1);
    expect(await a.model.publish({ fileName: FILE, canonical: autoText(1), project: null })).toBeNull();
    expect(a.model.getState().notice).toMatch(/already revision 1/);

    // Grace opens revision 1; both then publish from it.
    await b.model.refreshLibrary();
    const autoId = b.model.getState().library.autos[0]?.id ?? "";
    b.model.markOpened(autoId, r1?.id ?? "");
    const r2a = await a.model.publish({ fileName: FILE, canonical: autoText(2), project: null });
    const r2b = await b.model.publish({ fileName: FILE, canonical: autoText(3), project: null });
    expect(r2a?.n).toBe(2);
    expect(r2a?.diverged).toBe(false);
    expect(r2b?.n).toBe(2);
    expect(r2b?.diverged).toBe(true);
    expect(b.model.getState().notice).toMatch(/diverged/);

    await a.model.refreshLibrary();
    const revisions = a.model.getState().library.revisions[autoId] ?? [];
    expect(revisions.map((r) => [r.n, r.diverged])).toEqual([
      [1, false],
      [2, false],
      [2, true],
    ]);
    // Nothing was overwritten: every content is still there.
    expect(revisions.map((r) => r.content)).toEqual([autoText(1), autoText(2), autoText(3)]);
  });

  it("does not let a viewer publish, and publishes on save only when the team setting is on", async () => {
    const { a, b } = await team();
    const saved = { fileName: FILE, canonical: autoText(1), project: null };
    expect(await a.model.onEditorSaved(saved)).toBeNull();
    expect(await a.model.updateSettings({ publishOnSave: true })).toBe(true);
    expect((await a.model.onEditorSaved(saved))?.n).toBe(1);

    await a.model.refreshTeam();
    const grace = a.model.getState().team?.members.find((m) => m.displayName === "Grace");
    await a.model.setRole(grace?.uid ?? "", "viewer");
    await b.model.refreshTeam();
    expect(b.model.role()).toBe("viewer");
    expect(await b.model.publish({ fileName: FILE, canonical: autoText(9), project: null })).toBeNull();
    expect(b.model.getState().error).toMatch(/Viewers/);
  });

  it("queues a publish made offline in the outbox and sends it once when the connection returns", async () => {
    const { a, b } = await team();
    await a.model.setFakeOnline(false);
    expect(a.model.getState().online).toBe(false);
    const queued = await a.model.publish({ fileName: FILE, canonical: autoText(1), project: null });
    expect(queued?.n).toBe(1);
    const waiting = a.model.getState().outbox;
    expect(waiting?.queued).toBeGreaterThan(0);
    expect(waiting?.entries.some((e) => e.kind === "publish" && e.state === "queued")).toBe(true);
    // Grace sees nothing until it is sent.
    await b.model.refreshLibrary();
    expect(b.model.getState().library.autos).toEqual([]);

    await a.model.setFakeOnline(true);
    expect(a.model.getState().online).toBe(true);
    expect(a.model.getState().outbox?.queued).toBe(0);
    await b.model.refreshLibrary();
    const autoId = b.model.getState().library.autos[0]?.id ?? "";
    expect(b.model.getState().library.revisions[autoId]?.map((r) => r.n)).toEqual([1]);
  });

  it("builds Download project from the newest revision of every auto", async () => {
    const { a } = await team();
    await a.model.publish({ fileName: FILE, canonical: autoText(1), project: null });
    await a.model.publish({ fileName: FILE, canonical: autoText(2), project: null });
    await a.model.publish({ fileName: "second.auto.json", canonical: autoText(5), project: null });
    const entries = a.model.projectEntries();
    expect(entries.map((e) => [e.path, e.text])).toEqual([
      [`autos/${FILE}`, autoText(2)],
      ["autos/second.auto.json", autoText(5)],
    ]);
  });
});

/** A type check that MemoryBackend is a CloudBackend, so the model's tests stand for the real one. */
export const backendIsCloudBackend: (backend: MemoryBackend) => CloudBackend = (backend) => backend;

describe("email-link sign-in (spec 13 section 4.1)", () => {
  it("is off with the real cloud unless the build turns it on, and on in the fake", () => {
    expect(emailLinkEnabledFor("firebase", undefined)).toBe(false);
    expect(emailLinkEnabledFor("firebase", "on")).toBe(true);
    expect(emailLinkEnabledFor("fake", undefined)).toBe(true);
    expect(emailLinkEnabledFor("off", "on")).toBe(false);
  });
});

describe("two join links opened one after the other", () => {
  it("keeps the newer link when the older one's lookup answers last", async () => {
    const database = cloudAtNow();
    const first = device(database);
    await signedIn(first, "github", "Ada");
    expect(await first.model.createTeam({ number: 36596, name: "Horizon" })).toBe(true);
    const older = await first.model.createInvite({ role: "editor", expiry: { kind: "days", days: 7 }, maxUses: 1, autoApprove: false });
    const second = device(database);
    await signedIn(second, "microsoft", "Linus");
    expect(await second.model.createTeam({ number: 12345, name: "Partner team" })).toBe(true);
    const newer = await second.model.createInvite({ role: "editor", expiry: { kind: "days", days: 7 }, maxUses: 1, autoApprove: false });

    const joiner = device(database);
    await signedIn(joiner, "google", "Grace");
    const backend = joiner.backend();
    const getInvite = backend.getInvite.bind(backend);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The older link's lookup is slow and answers after the newer one's.
    backend.getInvite = async (code) => {
      if (code === older?.code) await held;
      return getInvite(code);
    };
    const slow = joiner.model.openJoin(older?.code ?? "");
    await joiner.model.openJoin(newer?.code ?? "");
    release();
    await slow;
    expect(joiner.model.getState().join?.code).toBe(newer?.code);
    expect(joiner.model.getState().join?.teamName).toBe("Partner team");
  });
});

describe("failures that never go unsaid, and reads that always end", () => {
  /** A device whose status line is recorded with its kind, and whose sheets may or may not show the account's last result. */
  function watched(database: MemoryDatabase, feedback: { shown: boolean }) {
    let backend: MemoryBackend | null = null;
    const said: Array<[string, string]> = [];
    const model = new AccountModel({
      mode: "fake",
      storage: memoryStorage(),
      now: () => NOW,
      pageUrl: () => "http://localhost:5173/?cloud=fake#/",
      createBackend: async () => {
        backend = new MemoryBackend({ database });
        return backend;
      },
      say: (kind, text) => {
        said.push([kind, text]);
      },
      feedbackShown: () => feedback.shown,
    });
    return {
      model,
      said,
      backend: () => {
        if (backend === null) throw new Error("not started");
        return backend;
      },
    };
  }

  it("puts a refused publish on the status line when no sheet shows it, and only in the sheet when one does", async () => {
    const feedback = { shown: false };
    const d = watched(cloudAtNow(), feedback);
    await d.model.start();
    d.model.open("signIn");
    await d.model.signInWith("github");
    await d.model.saveDisplayName("Ada");
    d.model.close();
    d.said.length = 0;
    // From the command palette, with no sheet open: nobody is in a team yet, so the publish is refused.
    expect(await d.model.publish({ fileName: FILE, canonical: autoText(1), project: null })).toBeNull();
    expect(d.model.getState().error).toBe("Choose a team first.");
    expect(d.said).toEqual([["error", `Did not publish ${FILE}: Choose a team first.`]]);

    // With the Library sheet open, its own line shows the failure, so the status line stays quiet.
    feedback.shown = true;
    d.said.length = 0;
    expect(await d.model.publish({ fileName: FILE, canonical: autoText(1), project: null })).toBeNull();
    expect(d.model.getState().error).toBe("Choose a team first.");
    expect(d.said).toEqual([]);
  });

  it("turns Reading the library into why it failed and back into the library once a read works", async () => {
    const d = watched(cloudAtNow(), { shown: true });
    await d.model.start();
    d.model.open("signIn");
    await d.model.signInWith("github");
    await d.model.saveDisplayName("Ada");
    expect(await d.model.createTeam({ number: 36596, name: "Horizon" })).toBe(true);
    d.model.dismissRecoveryCode();
    const backend = d.backend();
    const listAutos = backend.listAutos.bind(backend);
    backend.listAutos = () => Promise.reject(new Error("The server did not answer."));
    d.model.selectTeam(d.model.getState().teamId);
    await d.model.refreshLibrary();
    expect(d.model.getState().library).toMatchObject({ loaded: false, readError: "Could not read the team library. The server did not answer." });

    backend.listAutos = listAutos;
    await d.model.refreshLibrary();
    expect(d.model.getState().library).toMatchObject({ loaded: true, readError: null, autos: [] });

    // A later read that fails keeps what the last one found, and says so.
    backend.listAutos = () => Promise.reject(new Error("The server did not answer."));
    await d.model.refreshLibrary();
    expect(d.model.getState().library).toMatchObject({ loaded: true, readError: "Could not read the team library. The server did not answer." });
  });

  it("turns Reading the team into why it failed, with Try again reading it afresh", async () => {
    const d = watched(cloudAtNow(), { shown: true });
    await d.model.start();
    d.model.open("signIn");
    await d.model.signInWith("github");
    await d.model.saveDisplayName("Ada");
    expect(await d.model.createTeam({ number: 36596, name: "Horizon" })).toBe(true);
    d.model.dismissRecoveryCode();
    const backend = d.backend();
    const listMembers = backend.listMembers.bind(backend);
    backend.listMembers = () => Promise.reject(new Error("The server did not answer."));
    d.model.selectTeam(d.model.getState().teamId);
    await d.model.refreshTeam();
    expect(d.model.getState().team).toBeNull();
    expect(d.model.getState().teamReadError).toBe("Could not read the team. The server did not answer.");

    backend.listMembers = listMembers;
    await d.model.refreshTeam();
    expect(d.model.getState().team?.members.map((m) => m.displayName)).toEqual(["Ada"]);
    expect(d.model.getState().teamReadError).toBeNull();
  });

  it("says a failed read again of a team already shown, keeping the lists it shows", async () => {
    const d = watched(cloudAtNow(), { shown: true });
    await d.model.start();
    d.model.open("signIn");
    await d.model.signInWith("github");
    await d.model.saveDisplayName("Ada");
    expect(await d.model.createTeam({ number: 36596, name: "Horizon" })).toBe(true);
    d.model.dismissRecoveryCode();
    await d.model.refreshTeam();
    expect(d.model.getState().team?.members.map((m) => m.displayName)).toEqual(["Ada"]);
    const backend = d.backend();
    backend.listMembers = () => Promise.reject(new Error("The server did not answer."));
    await d.model.refreshTeam();
    expect(d.model.getState().team?.members.map((m) => m.displayName)).toEqual(["Ada"]);
    expect(d.model.getState().error).toBe("Could not read the team again. The server did not answer. The lists here may be out of date.");
  });
});
