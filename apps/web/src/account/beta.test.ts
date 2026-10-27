/**
 * The private-beta screen (owner ruling 2026-10-01, "Private beta allowlist"):
 * an account that signed in but is not on the beta list stops there instead of making a profile or
 * joining a team. The in-memory cloud is open by default, so these tests answer `hasBetaAccess()`
 * themselves, and play the server refusing a write with a permission error.
 */
import { describe, expect, it } from "vitest";
import { CloudError, MemoryBackend, MemoryDatabase, type Member, type Queued } from "@horizon36596/zenith-cloud";
import { AccountModel, STILL_NOT_ON_BETA_LIST } from "./model";
import { memoryStorage } from "./storage";

/** 27 September 2026, noon on this computer's clock. */
const NOW = new Date(2026, 8, 27, 12, 0, 0).getTime();

function cloudAtNow(betaGate: "open" | "closed" = "open"): MemoryDatabase {
  let t = NOW;
  return new MemoryDatabase({ now: () => new Date((t += 1)), approvalKdfIterations: 10, betaGate });
}

const refused = () => new CloudError("permission-denied", "The database's access rules do not allow this.");

/** A device whose answer to `hasBetaAccess()` the test sets, and which counts the questions. */
function device(database: MemoryDatabase, access: { value: boolean }) {
  let backend: MemoryBackend | null = null;
  const asked = { count: 0 };
  const model = new AccountModel({
    mode: "fake",
    storage: memoryStorage(),
    now: () => NOW,
    pageUrl: () => "http://localhost:5173/?cloud=fake#/",
    createBackend: async () => {
      backend = new MemoryBackend({ database });
      (backend as unknown as { hasBetaAccess: () => Promise<boolean> }).hasBetaAccess = async () => {
        asked.count += 1;
        return access.value;
      };
      return backend;
    },
  });
  return {
    model,
    asked,
    backend: () => {
      if (backend === null) throw new Error("not started");
      return backend;
    },
  };
}

/** Lets the outbox's refusals and the model's handlers of them run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the private beta (ruled 2026-10-01)", () => {
  it("stops an account that is not on the list at the private-beta screen, and Check again continues", async () => {
    const access = { value: false };
    const d = device(cloudAtNow(), access);
    await d.model.start();
    d.model.open("signIn");
    await d.model.signInWith("github");
    const state = d.model.getState();
    expect(state.step).toBe("beta");
    expect(state.betaAccess).toBe(false);
    expect(state.profile).toBeNull();
    expect(state.user?.uid).toBe(d.backend().currentUser()?.uid);

    // Reopening the sheet keeps the person on the screen.
    d.model.close();
    d.model.open("signIn");
    expect(d.model.getState().step).toBe("beta");

    await d.model.checkBetaAgain();
    expect(d.model.getState().step).toBe("beta");
    expect(d.model.getState().error).toBe(STILL_NOT_ON_BETA_LIST);

    access.value = true;
    await d.model.checkBetaAgain();
    expect(d.model.getState().error).toBeNull();
    expect(d.model.getState().step).toBe("profile");
    await d.model.saveDisplayName("Ada");
    await settle();
    expect(d.model.getState().profile?.displayName).toBe("Ada");
    expect(d.model.getState().panel).toBe("teams");
  });

  it("goes on to the display name after Check again for an account that signed in earlier", async () => {
    const access = { value: false };
    const database = cloudAtNow();
    const d = device(database, access);
    await d.model.start();
    d.backend().signInAs("u-new");
    await settle();
    expect(d.model.getState().step).toBe("beta");
    access.value = true;
    await d.model.checkBetaAgain();
    expect(d.model.getState().step).toBe("profile");
  });

  it("goes straight on for an account on the list", async () => {
    const access = { value: true };
    const d = device(cloudAtNow(), access);
    await d.model.start();
    d.model.open("signIn");
    await d.model.signInWith("github");
    expect(d.model.getState().step).toBe("profile");
    expect(d.model.getState().betaAccess).toBe(true);
  });

  it("never asks an account that already has a profile", async () => {
    const database = cloudAtNow();
    const first = device(database, { value: true });
    await first.model.start();
    first.model.open("signIn");
    await first.model.signInWith("github");
    await first.model.saveDisplayName("Ada");
    await settle();

    const access = { value: false };
    const again = device(database, access);
    await again.model.start();
    again.model.open("signIn");
    await again.model.signInWith("github");
    expect(again.asked.count).toBe(0);
    expect(again.model.getState().profile?.displayName).toBe("Ada");
    expect(again.model.getState().step).not.toBe("beta");
    expect(again.model.getState().betaAccess).toBeNull();
  });

  it("takes a refused new profile back and shows the private-beta screen", async () => {
    const access = { value: true };
    const d = device(cloudAtNow(), access);
    await d.model.start();
    d.model.open("signIn");
    await d.model.signInWith("github");
    expect(d.model.getState().step).toBe("profile");

    // Taken off the list meanwhile: the write is shown at once, then the server refuses it.
    access.value = false;
    const backend = d.backend();
    const save = backend.saveProfile.bind(backend);
    backend.saveProfile = async (input) => {
      const queued = await save(input);
      const sent = Promise.reject(refused());
      sent.catch(() => undefined);
      return { ...queued, sent };
    };
    await d.model.saveDisplayName("Ada");
    await settle();
    const state = d.model.getState();
    expect(state.step).toBe("beta");
    expect(state.panel).toBe("signIn");
    expect(state.profile).toBeNull();
    expect(state.error).toBeNull();
  });

  it("shows the private-beta screen when the cloud refuses an invite, and Check again goes back to it", async () => {
    const database = cloudAtNow();
    const owner = device(database, { value: true });
    await owner.model.start();
    owner.model.open("signIn");
    await owner.model.signInWith("github");
    await owner.model.saveDisplayName("Ada");
    expect(await owner.model.createTeam({ number: 36596, name: "Horizon" })).toBe(true);
    const invite = await owner.model.createInvite({ role: "editor", expiry: { kind: "days", days: 1 }, maxUses: 2, autoApprove: false });
    expect(invite).not.toBeNull();
    const code = invite?.code ?? "";

    // A member with a profile from before the gate, who is not on the list.
    const access = { value: true };
    const joiner = device(database, access);
    await joiner.model.start();
    joiner.model.open("signIn");
    await joiner.model.signInWith("google");
    await joiner.model.saveDisplayName("Grace");
    await settle();
    access.value = false;

    // Refused as the request is made.
    const backend = joiner.backend();
    const redeem = backend.redeemInvite.bind(backend);
    backend.redeemInvite = async () => {
      throw refused();
    };
    await joiner.model.openJoin(code);
    expect(joiner.model.getState().step).toBe("join");
    expect(await joiner.model.redeemJoin()).toBe(false);
    expect(joiner.model.getState().step).toBe("beta");
    expect(joiner.model.getState().error).toBeNull();
    expect(joiner.model.getState().join?.code).toBe(code);

    // Refused by the server after it was shown here.
    joiner.model.open("signIn");
    access.value = true;
    await joiner.model.checkBetaAgain();
    expect(joiner.model.getState().step).toBe("join");
    access.value = false;
    backend.redeemInvite = async (c): Promise<Queued<Member>> => {
      const sent = Promise.reject(refused());
      sent.catch(() => undefined);
      return {
        value: { uid: "x", teamId: "t", role: "pending", displayName: "Grace", joinedAt: new Date(NOW), invite: c } as unknown as Member,
        outboxId: "w0",
        sent,
      };
    };
    await joiner.model.redeemJoin();
    await settle();
    expect(joiner.model.getState().step).toBe("beta");
    expect(joiner.model.getState().join?.joinedAs).toBeNull();

    // Listed: Check again goes back to the join, which now works.
    backend.redeemInvite = redeem;
    access.value = true;
    await joiner.model.checkBetaAgain();
    expect(joiner.model.getState().step).toBe("join");
    expect(await joiner.model.redeemJoin()).toBe(true);
    expect(joiner.model.getState().join?.joinedAs).toBe("pending");
  });

  it("works against an in-memory cloud with the gate closed, until the tester is listed", async () => {
    let t = NOW;
    const database = new MemoryDatabase({ now: () => new Date((t += 1)), approvalKdfIterations: 10, betaGate: "closed" });
    let backend: MemoryBackend | null = null;
    const model = new AccountModel({
      mode: "fake",
      storage: memoryStorage(),
      now: () => NOW,
      pageUrl: () => "http://localhost:5173/?cloud=fake#/",
      createBackend: async () => (backend = new MemoryBackend({ database })),
    });
    await model.start();
    model.open("signIn");
    await model.signInWith("github");
    expect(model.getState().step).toBe("beta");
    const uid = model.getState().user?.uid ?? "";
    expect(uid).toBe((backend as MemoryBackend | null)?.currentUser()?.uid);

    // The owner lists the user code from the console.
    database.seed(`betaTesters/${uid}`, { name: "Ada" });
    await model.checkBetaAgain();
    expect(model.getState().step).toBe("profile");
    await model.saveDisplayName("Ada");
    await settle();
    expect(model.getState().step).not.toBe("beta");
    expect(model.getState().profile?.displayName).toBe("Ada");
  });

  it("forgets the answer on sign-out", async () => {
    const d = device(cloudAtNow(), { value: false });
    await d.model.start();
    d.model.open("signIn");
    await d.model.signInWith("github");
    expect(d.model.getState().step).toBe("beta");
    await d.model.signOut();
    expect(d.model.getState().betaAccess).toBeNull();
    expect(d.model.getState().user).toBeNull();
  });
  it("forgets the answer when another account signs in without a sign-out between", async () => {
    const database = cloudAtNow();
    database.seed("users/u-b", { displayName: "Bea", createdAt: new Date(NOW - 60_000) });
    const access = { value: false };
    const d = device(database, access);
    await d.model.start();
    d.backend().signInAs("u-a");
    await settle();
    expect(d.model.getState().step).toBe("beta");
    expect(d.model.getState().betaAccess).toBe(false);

    // B already has a profile, so the app never asks the cloud about B.
    d.backend().signInAs("u-b");
    await settle();
    expect(d.model.getState().user?.uid).toBe("u-b");
    expect(d.model.getState().profile?.displayName).toBe("Bea");
    expect(d.model.getState().betaAccess).toBeNull();
    expect(d.asked.count).toBe(1);
  });

  it("leaves a newer join link alone when the server refuses an earlier join", async () => {
    const database = cloudAtNow();
    const owner = device(database, { value: true });
    await owner.model.start();
    owner.model.open("signIn");
    await owner.model.signInWith("github");
    await owner.model.saveDisplayName("Ada");
    expect(await owner.model.createTeam({ number: 36596, name: "Horizon" })).toBe(true);
    const options = { role: "editor", expiry: { kind: "days", days: 1 }, maxUses: 2, autoApprove: false } as const;
    const first = (await owner.model.createInvite(options))?.code ?? "";
    const second = (await owner.model.createInvite(options))?.code ?? "";
    expect(first).not.toBe(second);

    const access = { value: true };
    const joiner = device(database, access);
    await joiner.model.start();
    joiner.model.open("signIn");
    await joiner.model.signInWith("google");
    await joiner.model.saveDisplayName("Grace");
    await settle();
    access.value = false;

    // The first join is shown at once; the server's refusal comes after the second link is opened.
    const backend = joiner.backend();
    let refuse: (error: unknown) => void = () => undefined;
    backend.redeemInvite = async (c): Promise<Queued<Member>> => {
      const sent = new Promise<never>((_, reject) => (refuse = reject));
      sent.catch(() => undefined);
      return {
        value: { uid: "x", teamId: "t", role: "pending", displayName: "Grace", joinedAt: new Date(NOW), invite: c } as unknown as Member,
        outboxId: "w0",
        sent,
      };
    };
    await joiner.model.openJoin(first);
    await joiner.model.redeemJoin();
    await joiner.model.openJoin(second);
    expect(joiner.model.getState().join?.code).toBe(second);
    refuse(refused());
    await settle();
    await settle();
    expect(joiner.model.getState().step).toBe("beta");
    expect(joiner.model.getState().join?.code).toBe(second);
    expect(joiner.model.getState().join?.joinedAs).toBeNull();
  });
});

describe("getting in by user code (ruled 2026-10-03, issue #99)", () => {
  it("sends nothing from the private-beta screen, and Check again lets the person in once an admin adds their code", async () => {
    const database = cloudAtNow("closed");
    database.seed("admins/hana", { name: "Hana" });
    const hana = new MemoryBackend({ database });
    hana.signInAs("hana");
    const access = { value: false };
    const d = device(database, access);
    await d.model.start();
    d.model.open("signIn");
    await d.model.signInWith("github");
    await settle();
    expect(d.model.getState().step).toBe("beta");
    const uid = d.model.getState().user?.uid ?? "";
    // Nothing about the person reaches the database until an admin adds the code they sent.
    expect(database.paths().filter((path) => path.startsWith("betaRequests/") || path.endsWith(`/${uid}`))).toEqual([]);

    await d.model.checkBetaAgain();
    expect(d.model.getState().error).toBe(STILL_NOT_ON_BETA_LIST);
    expect(d.model.getState().step).toBe("beta");

    await (await hana.addBetaTester({ uid, name: "Ada Lovelace" })).sent;
    access.value = true;
    await d.model.checkBetaAgain();
    expect(d.model.getState().error).toBeNull();
    expect(d.model.getState().step).toBe("profile");
  });
});
