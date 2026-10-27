/**
 * The development build's count of cloud reads by screen (spec 13 sections 7.2 and 13): a get is one
 * read, a list one per document it returned, a listener snapshot one per changed document; each is
 * counted against the screen the app showed when it was made. Against the in-memory cloud and its
 * real rules, through the same counting backend a development build makes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CloudError, type DocStore, type StoredDoc } from "@horizon36596/zenith-cloud";
import { MemoryDatabase } from "@horizon36596/zenith-cloud/memory";
import { NOW_MS, fixedRandom } from "./cloudFixture.test";
import { CountingMemoryBackend, pageReads } from "./devReadsBackend";
import { ReadCounter, countingStore, readsOf, screenLabel } from "./reads";
import { closeSharingSheet, openSharingSheet } from "./store";

afterEach(() => {
  closeSharingSheet();
  pageReads.reset();
});

const doc = (id: string): StoredDoc => ({ path: `things/${id}`, id, data: {} });

/** A store that answers from a fixed list, and refuses a list of `secret`. */
function fixedStore(): DocStore {
  return {
    get: (path) => Promise.resolve(path === "things/missing" ? null : {}),
    getWithPending: (path) => Promise.resolve({ data: path === "things/missing" ? null : {}, pendingWrites: false }),
    list: (query) =>
      query.collection === "secret"
        ? Promise.reject(new CloudError("permission-denied", "No."))
        : Promise.resolve([doc("a"), doc("b"), doc("c")]),
    commit: () => ({ sent: Promise.resolve() }),
  };
}

describe("what counts as a read", () => {
  it("is one for a get, and one per document for a list or a snapshot", () => {
    expect(readsOf("get", 0)).toBe(1);
    expect(readsOf("get", 5)).toBe(1);
    expect(readsOf("list", 0)).toBe(0);
    expect(readsOf("list", 3)).toBe(3);
    expect(readsOf("snapshot", 2)).toBe(2);
    expect(() => readsOf("list", -1)).toThrow("whole number");
    expect(() => readsOf("snapshot", 1.5)).toThrow("whole number");
  });
});

describe("the read counter", () => {
  it("counts each read against the screen shown when it was made, most reads first", () => {
    let screen = "Editor";
    const counter = new ReadCounter(() => screen);
    counter.record("get");
    counter.record("list", 4);
    screen = "Sharing page";
    counter.record("list", 7);
    counter.recordSnapshot(2);
    counter.record("get");
    expect(counter.snapshot()).toEqual({
      total: 15,
      byScreen: [
        { screen: "Sharing page", reads: 10, gets: 1, lists: 7, snapshots: 2 },
        { screen: "Editor", reads: 5, gets: 1, lists: 4, snapshots: 0 },
      ],
    });
  });

  it("keeps one snapshot until the next read, tells its listeners, and starts again on reset", () => {
    const counter = new ReadCounter(() => "Editor");
    let told = 0;
    const stop = counter.subscribe(() => {
      told += 1;
    });
    const empty = counter.snapshot();
    expect(counter.snapshot()).toBe(empty);
    counter.record("get");
    expect(counter.snapshot()).not.toBe(empty);
    expect(counter.snapshot().total).toBe(1);
    counter.reset();
    expect(counter.snapshot()).toEqual({ total: 0, byScreen: [] });
    expect(told).toBe(2);
    stop();
    counter.record("get");
    expect(told).toBe(2);
  });
});

describe("a counting store", () => {
  it("counts gets, even of a missing document, and lists by what they returned; refusals and commits count nothing", async () => {
    const counter = new ReadCounter(() => "Editor");
    const store = countingStore(fixedStore(), counter);
    expect(await store.get("things/a")).toEqual({});
    expect(await store.get("things/missing")).toBeNull();
    expect(await store.getWithPending("things/a")).toEqual({ data: {}, pendingWrites: false });
    expect(await store.list({ collection: "things" })).toHaveLength(3);
    await expect(store.list({ collection: "secret" })).rejects.toThrow("No.");
    await store.commit([{ op: "delete", path: "things/a" }]).sent;
    expect(counter.snapshot().byScreen).toEqual([{ screen: "Editor", reads: 6, gets: 3, lists: 3, snapshots: 0 }]);
  });
});

describe("the screen a read is counted against", () => {
  const none = { hash: "", sharingSheet: null, accountPanel: null } as const;
  it("is the page the address names, else the open sheet, else the editor", () => {
    expect(screenLabel(none)).toBe("Editor");
    expect(screenLabel({ ...none, hash: "#/admin" })).toBe("Admin page");
    expect(screenLabel({ ...none, hash: "#/admin", sharingSheet: "sharing" })).toBe("Admin page");
    expect(screenLabel({ ...none, hash: "#/s/AAAAAAAAAAAAAAAAAAAAAA" })).toBe("Share link");
    expect(screenLabel({ ...none, sharingSheet: "share" })).toBe("Share dialog");
    expect(screenLabel({ ...none, sharingSheet: "sharing", accountPanel: "library" })).toBe("Sharing page");
    expect(screenLabel({ ...none, sharingSheet: "viewer" })).toBe("Shared auto viewer");
    expect(screenLabel({ ...none, accountPanel: "signIn" })).toBe("Sign-in sheet");
    expect(screenLabel({ ...none, accountPanel: "teams", settingsOpen: true })).toBe("Settings");
    expect(screenLabel({ ...none, accountPanel: "teams" })).toBe("Teams sheet");
    expect(screenLabel({ ...none, accountPanel: "library" })).toBe("Team library");
    expect(screenLabel({ ...none, accountPanel: "outbox" })).toBe("Outbox");
  });
});

describe("the development build's counting backend", () => {
  it("counts the client's real reads against the screen that asked, and is on window.__zenithReads only with a window", async () => {
    let t = NOW_MS;
    const database = new MemoryDatabase({ now: () => new Date((t += 1)) });
    const backend = new CountingMemoryBackend({ database, random: fixedRandom(9001) });
    backend.signInAs("horizon-owner");
    await (await backend.saveProfile({ displayName: "Horizon" })).sent;
    const team = await backend.createTeam({ number: 36596, name: "Horizon" });
    await team.sent;
    pageReads.reset();

    // In the editor: getting the team reads it.
    expect(await backend.getTeam(team.value.id)).not.toBeNull();
    const editor = pageReads.snapshot().byScreen.find((entry) => entry.screen === "Editor");
    expect(editor?.gets).toBeGreaterThanOrEqual(1);
    expect(editor?.lists).toBe(0);

    // On the Sharing page: the proposals the team sent (none, so no reads) and its members (one).
    openSharingSheet("sharing");
    await backend.listProposals(team.value.id, "sent");
    expect(pageReads.snapshot().byScreen.find((entry) => entry.screen === "Sharing page")).toMatchObject({ reads: 0, lists: 0 });
    expect(await backend.listMembers(team.value.id)).toHaveLength(1);
    const sharing = pageReads.snapshot().byScreen.find((entry) => entry.screen === "Sharing page");
    expect(sharing?.lists).toBe(1);
    // The editor's count did not move while the Sharing page was open.
    expect(pageReads.snapshot().byScreen.find((entry) => entry.screen === "Editor")).toEqual(editor);
    const counts = pageReads.snapshot();
    expect(counts.total).toBe(counts.byScreen.reduce((sum, entry) => sum + entry.reads, 0));

    // Node has no window, so nothing was put on one.
    expect(typeof window).toBe("undefined");
  });
});
