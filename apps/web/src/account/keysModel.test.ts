/**
 * The account model's key flows (spec 14) against the in-memory cloud, and the two offline bugs of
 * the owner's test walk: the recovery code shown once and cleared, a waiting device's approval code,
 * a member's second device approved by their first with its code, the recovery code unlocking a
 * device, a new recovery code replacing the old one, and the fake cloud following the browser's
 * offline state with a publish that says it waits in the Outbox.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryBackend, MemoryDatabase, type CloudBackend } from "@horizon36596/zenith-cloud";
import { AccountModel, REMOVED_LINKS_STAY, REMOVED_STATUS, REMOVED_SUGGEST_NEW_CODE, lostTeams, seenTeamsOf, stoppedSharesNotice } from "./model";
import { removedFromWords } from "./words";
import { memoryStorage } from "./storage";

const NOW = new Date(2026, 8, 28, 12, 0, 0).getTime();

/** `code` with one character of its first part, which comes from the device's keys, changed. */
const otherFirstPart = (code: string): string => `${code.startsWith("0") ? "1" : "0"}${code.slice(1)}`;
/** `code` with one character of its random last part changed. */
const otherLastPart = (code: string): string => `${code.slice(0, -1)}${code.endsWith("0") ? "1" : "0"}`;
const FILE = "first-auto.auto.json";

/**
 * A cloud whose devices derive approval codes' keys with few iterations. The app's 600,000 take
 * about a quarter of a second each and these tests make fourteen; `crypto.vectors.test.ts`
 * checks the real count.
 */
const cloud = (): MemoryDatabase => new MemoryDatabase({ approvalKdfIterations: 10 });

function device(database: MemoryDatabase, options: { online?: () => boolean; storage?: ReturnType<typeof memoryStorage> } = {}) {
  let backend: MemoryBackend | null = null;
  const said: string[] = [];
  const model = new AccountModel({
    mode: "fake",
    storage: options.storage ?? memoryStorage(),
    now: () => NOW,
    pageUrl: () => "http://localhost:5173/?cloud=fake#/",
    createBackend: async () => {
      backend = new MemoryBackend({ database });
      return backend;
    },
    createFakeDevice: async (from: CloudBackend) => new MemoryBackend({ database: (from as MemoryBackend).database }),
    ...(options.online === undefined ? {} : { deviceOnline: options.online }),
    say: (_kind, text) => {
      said.push(text);
    },
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

async function signedIn(d: ReturnType<typeof device>, provider: "github" | "google" | "microsoft", name: string) {
  await d.model.start();
  d.model.open("signIn");
  await d.model.signInWith(provider);
  await d.model.saveDisplayName(name);
  expect(d.model.getState().error).toBeNull();
}

/** An owner with a team, and a second member already approved, each on their own device. */
async function teamOfTwo() {
  return teamOfTwoOn(cloud(), memoryStorage());
}

/** As `teamOfTwo`, with the member's device keeping its values in `memberStorage`. */
async function teamOfTwoOn(database: MemoryDatabase, memberStorage: ReturnType<typeof memoryStorage>) {
  const owner = device(database);
  await signedIn(owner, "github", "Ada");
  await owner.model.createTeam({ number: 36596, name: "Horizon" });
  const invite = await owner.model.createInvite({ role: "editor", expiry: { kind: "days", days: 7 }, maxUses: 1, autoApprove: false });
  const member = device(database, { storage: memberStorage });
  await signedIn(member, "google", "Grace");
  await member.model.openJoin(invite?.code ?? "");
  await member.model.redeemJoin();
  await member.model.refreshKeys();
  await owner.model.refreshTeam();
  const uid = member.model.getState().user?.uid ?? "";
  await owner.model.approveWithCode(uid, member.model.getState().keys?.approvalCode ?? "");
  await member.model.refreshTeam();
  return { database, owner, member, uid };
}

describe("removing a member", () => {
  it("keeps the whole notice in the sheet and puts one short line on the status line", async () => {
    const { owner, uid } = await teamOfTwo();
    owner.model.dismissRecoveryCode();
    owner.said.length = 0;
    expect(await owner.model.removeMember(uid)).toBe(true);
    expect(owner.model.getState().notice).toBe(REMOVED_SUGGEST_NEW_CODE);
    expect(owner.said).toEqual([REMOVED_STATUS]);
    expect(REMOVED_STATUS.split(/\s+/).length).toBeLessThanOrEqual(10);
  });

  it("tells the removed member which team they are no longer in, in place of the empty state", async () => {
    const { owner, member, uid } = await teamOfTwo();
    expect(member.model.getState().removedFrom).toBeNull();
    expect(await owner.model.removeMember(uid)).toBe(true);
    await member.model.refreshTeam();
    const state = member.model.getState();
    expect(state).toMatchObject({ memberships: [], teamId: null, removedFrom: { number: 36596, name: "Horizon" } });
    expect(removedFromWords(state.removedFrom!)).toBe(
      "You are no longer a member of 36596 Horizon. If you did not leave it, an owner or admin removed you or deleted the team. To come back, ask an owner or admin for a new invite.",
    );
  });

  it("tells them on the next visit too, and only that account", async () => {
    const database = cloud();
    const storage = memoryStorage();
    const { owner, uid } = await teamOfTwoOn(database, storage);
    expect(await owner.model.removeMember(uid)).toBe(true);
    // Grace opens Zenith again on the same device: a new page, the same device storage.
    const again = device(database, { storage });
    await signedIn(again, "google", "Grace");
    expect(again.model.getState().removedFrom).toMatchObject({ number: 36596, name: "Horizon" });
    // Someone else on that device was never in Horizon, and is told nothing.
    const other = device(database, { storage });
    await signedIn(other, "microsoft", "Lin");
    expect(other.model.getState().removedFrom).toBeNull();
  });

  it("says nothing of the kind after leaving the team on this device", async () => {
    const { member } = await teamOfTwo();
    expect(await member.model.leaveTeam()).toBe(true);
    await member.model.refreshTeam();
    expect(member.model.getState()).toMatchObject({ memberships: [], removedFrom: null });
  });

  it("finds only the teams that were seen and are no longer listed, a request to join not counted", () => {
    const horizon = { teamId: "t1", role: "editor" as const, team: null };
    const spare = { teamId: "t2", role: "owner" as const, team: null };
    const asking = { teamId: "t3", role: "pending" as const, team: null };
    const seen = seenTeamsOf([horizon, spare, asking]);
    expect(seen.map((team) => team.teamId)).toEqual(["t1", "t2"]);
    expect(lostTeams(seen, [spare]).map((team) => team.teamId)).toEqual(["t1"]);
    expect(lostTeams(seen, [horizon, spare])).toEqual([]);
    expect(lostTeams([], [])).toEqual([]);
    expect(removedFromWords({ number: null, name: null })).toMatch(/^You are no longer a member of a team you were in\./);
  });
});
describe("the recovery code", () => {
  it("is held once after a team is created, with the date it was made, and cleared once saved", async () => {
    const d = device(cloud());
    await signedIn(d, "github", "Ada");
    await d.model.createTeam({ number: 36596, name: "Horizon" });
    const shown = d.model.getState().newRecoveryCode;
    expect(shown?.code).toMatch(/^ZNTH(-[0-9A-Z]{5,6}){5}$/);
    expect(shown).toMatchObject({ teamId: d.model.getState().teamId, madeAtMs: NOW, replacing: false });
    d.model.dismissRecoveryCode();
    expect(d.model.getState().newRecoveryCode).toBeNull();
  });

  it("is suggested again after an owner removes a member, and the suggestion opens the owner's New recovery code", async () => {
    const { owner, uid } = await teamOfTwo();
    owner.model.dismissRecoveryCode();
    expect(await owner.model.removeMember(uid)).toBe(true);
    expect(owner.model.getState()).toMatchObject({ notice: REMOVED_SUGGEST_NEW_CODE, suggestNewRecoveryCode: true, askingNewRecoveryCode: false });
    // A link the team made is not closed by the new team key, and the notice says so.
    expect(owner.model.getState().notice).toMatch(/Links the team made to share autos keep working for anyone who has them/);
    owner.model.askNewRecoveryCode(true);
    expect(owner.model.getState()).toMatchObject({ suggestNewRecoveryCode: false, askingNewRecoveryCode: true });
    expect(await owner.model.replaceRecoveryCode()).toBe(true);
    expect(owner.model.getState()).toMatchObject({ askingNewRecoveryCode: false, newRecoveryCode: { replacing: true } });
  });

  it("is replaced by an owner's new code, and the new one unlocks a device the old one no longer does", async () => {
    const { database, owner, uid } = await teamOfTwo();
    await owner.model.createTeam({ number: null, name: "Spare" });
    owner.model.dismissRecoveryCode();
    const horizon = owner.model.getState().memberships.find((m) => m.team?.name === "Horizon")?.teamId ?? null;
    owner.model.selectTeam(horizon);
    await owner.model.refreshTeam();
    expect(await owner.model.replaceRecoveryCode()).toBe(true);
    const fresh = owner.model.getState().newRecoveryCode;
    expect(fresh).toMatchObject({ teamId: horizon, replacing: true });

    // Grace's laptop: a new device, waiting, unlocked with the code on paper.
    const laptop = device(database);
    await laptop.model.start();
    await laptop.model.switchFakeUser(uid);
    laptop.model.selectTeam(horizon);
    await laptop.model.refreshTeam();
    expect(laptop.model.getState().keys?.status?.state).toBe("waiting");
    await expect(laptop.model.useRecoveryCode("ZNTH-AAAAA-AAAAA-AAAAA-AAAAA-AAAAAA")).rejects.toThrow(/./);
    await laptop.model.useRecoveryCode(fresh?.code ?? "");
    expect(laptop.model.getState().keys?.status?.state).toBe("ready");
  });
});

describe("a member's new device", () => {
  it("waits with an approval code, asks for the key, and is approved by the member's first device with that code", async () => {
    const { member } = await teamOfTwo();
    const first = member.model.getState().fakeDevice;
    expect(first).toEqual({ index: 0, count: 1 });

    // The same member on a second simulated device of the fake cloud.
    expect(await member.model.switchFakeDevice("new")).toBe(true);
    expect(member.model.getState().fakeDevice).toEqual({ index: 1, count: 2 });
    await member.model.refreshTeam();
    const keys = member.model.getState().keys;
    expect(keys?.status).toMatchObject({ state: "waiting", requested: true });
    const code = keys?.approvalCode ?? "";
    expect(code).not.toBe("");

    // Back on the first device, the request is there as the member's own.
    expect(await member.model.switchFakeDevice(0)).toBe(true);
    await member.model.refreshTeam();
    const request = member.model.getState().keys?.requests.find((r) => r.kind === "device");
    expect(request?.isYours).toBe(true);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}(-[0-9A-HJKMNP-TV-Z]{6}){2}$/);
    // The verification code, or another device's code, is not this device's approval code.
    await expect(member.model.grantDevice(request?.deviceId ?? "", request?.code ?? "")).rejects.toMatchObject({ code: "wrong-code" });
    await expect(member.model.grantDevice(request?.deviceId ?? "", otherFirstPart(code))).rejects.toThrow(/does not match/);
    await member.model.grantDevice(request?.deviceId ?? "", code);
    expect(member.model.getState().keys?.requests).toEqual([]);

    await member.model.switchFakeDevice(1);
    await member.model.refreshTeam();
    expect(member.model.getState().keys?.status?.state).toBe("ready");
  });

  it("refuses a typo in the last part of the code at the approver, and a declined device asks again", async () => {
    const { member } = await teamOfTwo();
    await member.model.switchFakeDevice("new");
    await member.model.refreshTeam();
    const code = member.model.getState().keys?.approvalCode ?? "";

    // The first part is computed from the last, so a mistake anywhere is seen before anything is sent.
    await member.model.switchFakeDevice(0);
    await member.model.refreshTeam();
    const request = member.model.getState().keys?.requests.find((r) => r.kind === "device");
    await expect(member.model.grantDevice(request?.deviceId ?? "", otherLastPart(code))).rejects.toThrow(/does not match/);
    expect(await member.model.declineDevice(request?.deviceId ?? "")).toBe(true);

    // The new device sees its request is gone, keeps the same code, and asks again.
    await member.model.switchFakeDevice(1);
    await member.model.refreshTeam();
    expect(member.model.getState().keys?.status).toMatchObject({ state: "waiting", requested: false });
    expect(member.model.getState().keys?.approvalCode).toBe(code);
    expect(await member.model.askForKeyAgain()).toBe(true);
    expect(member.model.getState().keys?.status).toMatchObject({ state: "waiting", requested: true });

    await member.model.switchFakeDevice(0);
    await member.model.refreshTeam();
    const again = member.model.getState().keys?.requests.find((r) => r.kind === "device");
    expect(again?.deviceId).toBe(request?.deviceId);
    await member.model.grantDevice(again?.deviceId ?? "", code);
    await member.model.switchFakeDevice(1);
    await member.model.refreshTeam();
    expect(member.model.getState().keys?.status?.state).toBe("ready");
  });

  it("gives a pending member the key on the device whose code was typed, not simply their newest", async () => {
    const database = cloud();
    const owner = device(database);
    await signedIn(owner, "github", "Ada");
    await owner.model.createTeam({ number: 36596, name: "Horizon" });
    const invite = await owner.model.createInvite({ role: "editor", expiry: { kind: "days", days: 7 }, maxUses: 1, autoApprove: false });
    const joiner = device(database);
    await signedIn(joiner, "google", "Grace");
    await joiner.model.openJoin(invite?.code ?? "");
    await joiner.model.redeemJoin();
    await joiner.model.refreshKeys();
    const olderCode = joiner.model.getState().keys?.approvalCode ?? "";
    // The same pending member opens the team on a second device, which asks too.
    expect(await joiner.model.switchFakeDevice("new")).toBe(true);
    await joiner.model.refreshTeam();
    expect(joiner.model.getState().keys?.status).toMatchObject({ state: "waiting", requested: true });
    const newerCode = joiner.model.getState().keys?.approvalCode ?? "";
    expect(newerCode).not.toBe(olderCode);

    // The owner reads the code off the first device.
    await owner.model.refreshTeam();
    const uid = joiner.model.getState().user?.uid ?? "";
    await owner.model.approveWithCode(uid, olderCode);
    expect(owner.model.getState().team?.members.find((m) => m.uid === uid)?.role).toBe("editor");

    await joiner.model.switchFakeDevice(0);
    await joiner.model.refreshTeam();
    expect(joiner.model.getState().keys?.status?.state).toBe("ready");
    await joiner.model.switchFakeDevice(1);
    await joiner.model.refreshTeam();
    expect(joiner.model.getState().keys?.status?.state).toBe("waiting");
  });

  it("shows a pending member's approval step only when their device has asked", async () => {
    const { owner } = await teamOfTwo();
    expect(owner.model.memberKeyRequest("nobody")).toBeNull();
    await expect(owner.model.approveWithCode("nobody", "0000 0000 0000")).rejects.toThrow(/has not asked/);
  });
});

describe("offline with the fake cloud", () => {
  it("follows the browser: offline, a publish waits in the Outbox and says so, and goes when back online", async () => {
    let online = true;
    const d = device(cloud(), { online: () => online });
    await signedIn(d, "github", "Ada");
    await d.model.createTeam({ number: 36596, name: "Horizon" });

    online = false;
    d.model.deviceConnectionChanged();
    await Promise.resolve();
    expect(d.backend().isOnline()).toBe(false);
    expect(d.model.getState().online).toBe(false);

    const revision = await d.model.publish({ fileName: FILE, canonical: '{"kind":"auto"}\n', project: null });
    expect(revision).not.toBeNull();
    expect(d.model.getState().outbox?.queued).toBeGreaterThan(0);
    const said = d.said[d.said.length - 1] ?? "";
    expect(said).toContain("waits in the Outbox");
    expect(said).not.toMatch(/^Published/);

    online = true;
    d.model.deviceConnectionChanged();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.backend().isOnline()).toBe(true);
    expect(d.model.getState().outbox?.queued).toBe(0);
  });

  it("stays offline after Go offline in the Outbox, whatever the browser does", async () => {
    let online = true;
    const d = device(cloud(), { online: () => online });
    await signedIn(d, "github", "Ada");
    await d.model.setFakeOnline(false);
    online = false;
    d.model.deviceConnectionChanged();
    online = true;
    d.model.deviceConnectionChanged();
    await Promise.resolve();
    expect(d.backend().isOnline()).toBe(false);
  });
});

describe("after the team key changes", () => {
  it("says after a removal how many shares stopped, made on the removed member's device, and names none when nothing stopped", async () => {
    const { owner, member, uid } = await teamOfTwo();
    owner.model.dismissRecoveryCode();
    const teamId = owner.model.getState().teamId ?? "";
    await (await owner.backend().updateTeamSettings(teamId, { editorsMayLinkShare: true })).sent;
    const auto = await member.backend().createAuto(teamId, { title: FILE });
    await auto.sent;
    const revision = await member.backend().publishRevision({ teamId, autoId: auto.value.id, baseRevision: null, content: '{"s":"one"}' });
    await revision.sent;
    const made = await member.backend().createShare({ teamId, autoId: auto.value.id, revision: revision.value.id, audience: "link", projection: '{"s":"one"}' });
    await made.sent;
    expect(await owner.model.removeMember(uid)).toBe(true);
    expect(owner.model.getState().notice).toBe(`${REMOVED_SUGGEST_NEW_CODE} ${stoppedSharesNotice(1)}`);
    expect(stoppedSharesNotice(1)).toBe("1 share stopped, made or last changed on a removed device. Share it again from the Sharing page.");
    expect(stoppedSharesNotice(2)).toMatch(/^2 shares stopped, .* Share them again/);
    // A write that stops nothing new says nothing of the share that stopped before.
    expect(await owner.model.completeKeyRotation()).toBe(true);
    expect(owner.model.getState().notice).toBe("Made a new team key. Every device still on the team has it.");
    expect(REMOVED_LINKS_STAY).not.toContain("stopped");
  });

  it("carries the team's shares forward in the background once a device holding the key opens the team, once a page load", async () => {
    const d = device(new MemoryDatabase());
    await d.model.start();
    const carry = vi.spyOn(d.backend(), "carryForwardShares");
    d.model.open("signIn");
    await d.model.signInWith("github");
    await d.model.saveDisplayName("Ada");
    await d.model.createTeam({ number: 36596, name: "Horizon" });
    const teamId = d.model.getState().teamId ?? "";
    await d.model.refreshKeys();
    await d.model.refreshKeys();
    expect(carry.mock.calls).toEqual([[teamId]]);
  });
});
