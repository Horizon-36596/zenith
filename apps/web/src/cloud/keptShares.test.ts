/**
 * Save for offline on a received share, and the link shares opened on this device (spec 13 section
 * 6), against the in-memory cloud, whose per-device cache behaves like Firestore's: a document read
 * once opens again offline, and one never read does not. That is the whole of what Keep relies on,
 * so the list itself holds only each share's id, the team label and, for a link, its secret.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { MemoryBackend, MemoryDatabase } from "@horizon36596/zenith-cloud/memory";
import { AccountModel } from "../account/model";
import { KEYS, memoryStorage } from "../account/storage";
import { NOW_MS, cloudWorld, publishTo, type CloudWorld } from "./cloudFixture.test";
import { createCloudSharingApi } from "./cloudSharingApi";
import { KeptShares, OPENED_LINK_LIMIT, keptSharesStorage } from "./keptShares";
import { keepForOffline, keptShares, reopenKept } from "./keptSharesStore";
import { getCloud, openShareByLink, setSharingBackend, SIGNED_OUT } from "./store";
import type { Share } from "./types";

const DAY = 86_400_000;
const PROJECTION = '{"kind":"projection"}';

/** A made-up 22-character link secret, the shape the list accepts. */
const secretFor = (name: string): string => `${name}${"A".repeat(22)}`.slice(0, 22);

describe("the list of kept shares", () => {
  it("lists an opened link once, newest first, keeps and unkeeps it, and forgets it", () => {
    const storage = memoryStorage();
    const list = new KeptShares(storage);
    list.recordOpenedLink({ id: "linkA", secret: secretFor("a"), label: "Shared link" });
    list.recordOpenedLink({ id: "linkB", secret: secretFor("b"), label: "Team 12345" });
    list.recordOpenedLink({ id: "linkA", secret: secretFor("a"), label: "Shared link" });
    expect(list.list().map((entry) => entry.id)).toEqual(["linkA", "linkB"]);
    expect(list.list()).toBe(list.list());

    list.setKept({ id: "linkB", label: "Team 12345", via: "link" }, true);
    expect(list.isKept("linkB")).toBe(true);
    // Unkept, a link stays listed as one opened here.
    list.setKept({ id: "linkB", label: "Team 12345", via: "link" }, false);
    expect(list.list().find((entry) => entry.id === "linkB")).toMatchObject({ via: "link", secret: secretFor("b"), kept: false });
    list.forget("linkB");
    expect(list.list().map((entry) => entry.id)).toEqual(["linkA"]);
  });

  it("stores only each share's id, the team label, how it came, whether it is kept and a link's secret", () => {
    const storage = memoryStorage();
    const list = new KeptShares(storage);
    list.setKept({ id: "teamShare1", label: "Team 36596", via: "team" }, true);
    expect(JSON.parse(storage.dump()[KEYS.keptShares] ?? "[]")).toEqual([
      { id: "teamShare1", label: "Team 36596", via: "team", kept: true },
    ]);
    // A team share no longer kept leaves the list: the Partners panel lists it anyway.
    list.setKept({ id: "teamShare1", label: "Team 36596", via: "team" }, false);
    expect(storage.dump()[KEYS.keptShares]).toBeUndefined();
    // A link share keeps its secret, the only thing that opens it again.
    list.recordOpenedLink({ id: "link1", secret: secretFor("s"), label: "Shared link" });
    expect(JSON.parse(storage.dump()[KEYS.keptShares] ?? "[]")).toEqual([
      { id: "link1", secret: secretFor("s"), label: "Shared link", via: "link", kept: false },
    ]);
  });

  it("reads back nothing it cannot trust, and remembers a bounded number of opened links", () => {
    const storage = memoryStorage({
      [KEYS.keptShares]: JSON.stringify([
        { id: "ok1", label: "Team 1", via: "team", kept: true },
        { id: "bad id with spaces", label: "x", via: "link", kept: false },
        { id: "ok2", label: 5, via: "link", kept: false },
        // A link kept before shares were encrypted has no secret, so it cannot be opened any more.
        { id: "oldLink", label: "Shared link", via: "link", kept: true },
        { id: "shortSecret", secret: "abc", label: "Shared link", via: "link", kept: true },
        "junk",
      ]),
    });
    const list = new KeptShares(storage);
    expect(list.list().map((entry) => entry.id)).toEqual(["ok1"]);
    expect(new KeptShares(memoryStorage({ [KEYS.keptShares]: "{not json" })).list()).toEqual([]);

    for (let index = 0; index < OPENED_LINK_LIMIT + 5; index += 1) list.recordOpenedLink({ id: `link${String(index)}`, secret: secretFor(String(index)), label: "Shared link" });
    const entries = list.list();
    expect(entries.filter((entry) => !entry.kept)).toHaveLength(OPENED_LINK_LIMIT);
    // The kept one survives, and the oldest opened ones went first.
    expect(entries.some((entry) => entry.id === "ok1")).toBe(true);
    expect(entries.some((entry) => entry.id === "link0")).toBe(false);
  });
});

/** A link share's secret, which only the team that made it is given. */
function secretOf(share: Share): string {
  if (share.linkSecret === undefined) throw new Error("The share has no link secret.");
  return share.linkSecret;
}

describe("where the list is kept", () => {
  it("keeps a signed-out visitor's opened links for the tab only, and a signed-in member's on the device", () => {
    const device = memoryStorage();
    const session = memoryStorage();
    let signedInOwnDevice = false;
    const list = new KeptShares(keptSharesStorage(device, session, () => signedInOwnDevice));
    list.recordOpenedLink({ id: "link1", secret: secretFor("s"), label: "Shared link" });
    expect(device.dump()[KEYS.keptShares]).toBeUndefined();
    expect(JSON.parse(session.dump()[KEYS.keptShares] ?? "[]")).toHaveLength(1);

    signedInOwnDevice = true;
    expect(list.list()).toEqual([]);
    list.recordOpenedLink({ id: "link2", secret: secretFor("t"), label: "Shared link" });
    expect(JSON.parse(device.dump()[KEYS.keptShares] ?? "[]")).toHaveLength(1);
    expect(JSON.parse(session.dump()[KEYS.keptShares] ?? "[]")).toHaveLength(1);
  });
});

describe("Keep for offline, and reopening (spec 13 section 6)", () => {
  let world: CloudWorld;
  let link: Share;
  let other: Share;
  beforeEach(async () => {
    keptShares.useStorage(memoryStorage());
    world = await cloudWorld([12345]);
    const at = await publishTo(world.owner, "first-auto.auto.json", '{"kind":"auto"}\n');
    const owner = createCloudSharingApi(world.owner.backend, { now: () => NOW_MS });
    const request = {
      autoId: at.autoId,
      audience: "link" as const,
      teamNumbers: [],
      level: "view" as const,
      mode: "pinned" as const,
      revision: at.n,
      revisionId: at.revisionId,
      expiresAt: new Date(NOW_MS + 7 * DAY).toISOString(),
      projection: PROJECTION,
    };
    link = await owner.createShare(world.owner.teamId, request);
    other = await owner.createShare(world.owner.teamId, request);
    // Someone with no account opens links on this page.
    setSharingBackend(createCloudSharingApi(world.stranger, { now: () => NOW_MS }), SIGNED_OUT, { now: () => NOW_MS });
  });

  it("lists a link share once it is opened here, and keeps it", async () => {
    const opened = await openShareByLink(secretOf(link));
    expect(opened.ok).toBe(true);
    expect(keptShares.list()).toEqual([{ id: link.id, secret: secretOf(link), label: "Shared link", via: "link", kept: false }]);
    await keepForOffline({ id: link.id, secret: secretOf(link), label: "Shared link", via: "link" }, true);
    expect(keptShares.isKept(link.id)).toBe(true);
  });

  it("opens a kept share with no connection, and says why one never opened here cannot", async () => {
    await keepForOffline({ id: link.id, secret: secretOf(link), label: "Shared link", via: "link" }, true);
    await world.stranger.setOnline(false);

    const [entry] = keptShares.list();
    if (entry === undefined) throw new Error("nothing kept");
    await reopenKept(entry);
    expect(getCloud().sheet).toBe("viewer");
    expect(getCloud().viewing?.id).toBe(link.id);

    const never = await openShareByLink(secretOf(other));
    expect(never.ok).toBe(false);
    expect(never.ok ? "" : never.why).toMatch(/no copy of that saved for offline use/);
  });

  it("does not keep a share that cannot be read, and says why", async () => {
    await world.stranger.setOnline(false);
    await keepForOffline({ id: other.id, secret: secretOf(other), label: "Shared link", via: "link" }, true);
    expect(keptShares.isKept(other.id)).toBe(false);
  });
});

describe("signing out, and a shared computer, clear the list", () => {
  async function signedIn(storage: ReturnType<typeof memoryStorage>) {
    const database = new MemoryDatabase();
    const model = new AccountModel({
      mode: "fake",
      storage,
      now: () => NOW_MS,
      pageUrl: () => "http://localhost/?cloud=fake#/",
      createBackend: async () => new MemoryBackend({ database }),
    });
    await model.start();
    model.open("signIn");
    await model.signInWith("github");
    await model.saveDisplayName("Ada");
    return model;
  }

  it("removes the kept shares when the person signs out", async () => {
    const storage = memoryStorage();
    const model = await signedIn(storage);
    new KeptShares(storage).setKept({ id: "teamShare1", label: "Team 12345", via: "team" }, true);
    await model.signOut();
    expect(storage.get(KEYS.keptShares)).toBeNull();
  });

  it("removes them when the computer is marked as shared", async () => {
    const storage = memoryStorage();
    const model = await signedIn(storage);
    new KeptShares(storage).setKept({ id: "teamShare1", label: "Team 12345", via: "team" }, true);
    await model.setSharedComputer(true);
    expect(storage.get(KEYS.keptShares)).toBeNull();
  });
});
