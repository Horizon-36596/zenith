/**
 * With the cloud off (no `VITE_ZENITH_FIREBASE_CONFIG` and no `?cloud=fake`), no cloud control is
 * anywhere in the editor: the toolbar, the command palette and the shortcut sheet all read the one
 * action table, and the cloud's actions are left out of it by the one gate, `cloudEnabled`. With the
 * cloud on, the same table has them, so the gate is what hides them and not a missing action.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudConfigFrom, cloudEnabled } from "../account/config";
import { matchesQuery } from "../palette/match";
import { ACTIONS, TOOLBAR_GROUPS, shortcutOf } from "./actions";
import { cloudLinkKind, cloudOffNotice } from "./cloudLinks";

const CLOUD_PREFIXES = ["share.", "account."];
const isCloud = (id: string): boolean => CLOUD_PREFIXES.some((prefix) => id.startsWith(prefix));

const found = (needle: string): string[] =>
  ACTIONS.filter((action) => matchesQuery({ label: action.label, group: action.group, keywords: action.keywords }, needle)).map(
    (action) => action.id,
  );

describe("the editor with the cloud off", () => {
  it("runs with the cloud off in a test, as in a build without a Firebase config", () => {
    expect(cloudEnabled()).toBe(false);
  });

  it("ignores ?cloud=fake and the stored fake switch in a release build", () => {
    const config = '{"apiKey":"k","projectId":"p"}';
    expect(cloudConfigFrom({ allowFake: false, search: "?cloud=fake", fakeFlag: "on", firebaseJson: undefined }).mode).toBe("off");
    expect(cloudConfigFrom({ allowFake: false, search: "?cloud=fake", fakeFlag: "on", firebaseJson: config }).mode).toBe("firebase");
    expect(cloudConfigFrom({ allowFake: true, search: "?cloud=fake", fakeFlag: null, firebaseJson: undefined }).mode).toBe("fake");
  });

  it("has no sharing or account action, so the palette and the shortcut sheet list none", () => {
    expect(ACTIONS.map((action) => action.id).filter(isCloud)).toEqual([]);
    for (const action of ACTIONS) {
      if (isCloud(action.id)) expect(shortcutOf(action), action.id).toBeUndefined();
    }
  });

  it("puts no Share or Sharing button in the toolbar", () => {
    expect(TOOLBAR_GROUPS.flat().filter(isCloud)).toEqual([]);
    for (const group of TOOLBAR_GROUPS) expect(group.length).toBeGreaterThan(0);
  });

  it("finds only the offline share file when the palette is searched for share", () => {
    for (const word of ["share", "sharing", "invite", "team", "admin", "library", "outbox", "sign in"]) {
      expect(found(word).filter(isCloud), word).toEqual([]);
    }
    expect(found("share")).toEqual(expect.arrayContaining(["project.downloadShareFile", "project.downloadProposeShareFile"]));
  });

  it("describes the share file without shares or a cloud", () => {
    for (const id of ["project.downloadShareFile", "project.downloadProposeShareFile"]) {
      const action = ACTIONS.find((entry) => entry.id === id);
      expect(action?.does, id).toContain("share file");
      expect(action?.does, id).not.toMatch(/cloud|a share of/i);
    }
  });
});

describe("the editor with the cloud on", () => {
  afterEach(() => {
    vi.doUnmock("../account/config");
    vi.resetModules();
  });

  it("has the Share and Sharing actions and their toolbar group", async () => {
    vi.resetModules();
    vi.doMock("../account/config", async (importOriginal) => {
      const original = await importOriginal<typeof import("../account/config")>();
      return { ...original, cloudEnabled: () => true };
    });
    const actions = await import("./actions");
    const ids = actions.ACTIONS.map((action) => action.id);
    expect(ids).toEqual(expect.arrayContaining(["share.open", "share.page"]));
    expect(actions.TOOLBAR_GROUPS).toContainEqual(["share.open", "share.page"]);
  });
});

describe("cloud links with the cloud off", () => {
  it("tells a share link, an invite link and the admin page apart from every other address", () => {
    expect(cloudLinkKind("#/s/AAAAAAAAAAAAAAAAAAAAAA")).toBe("share");
    expect(cloudLinkKind("#/s/short")).toBe("share");
    expect(cloudLinkKind("#/join/abcdefgh12")).toBe("join");
    expect(cloudLinkKind("#/admin")).toBe("admin");
    expect(cloudLinkKind("#/admin/")).toBe("admin");
    expect(cloudLinkKind("")).toBeNull();
    expect(cloudLinkKind("#/review/horizon/robot/12")).toBeNull();
    expect(cloudLinkKind("#/administrator")).toBeNull();
  });

  it("says in plain words that sharing, teams and the admin page are not in this build, and what works instead", () => {
    const share = cloudOffNotice("share");
    expect(share.title).toBe("Sharing isn't available in this build");
    expect(share.paragraphs.join(" ")).toContain("share file");
    expect(share.paragraphs.join(" ")).toContain("Partners panel");
    const join = cloudOffNotice("join");
    expect(join.title).toBe("Teams aren't available in this build");
    expect(join.paragraphs.join(" ")).toContain("without an account");
    const admin = cloudOffNotice("admin");
    expect(admin.title).toBe("The admin page isn't available in this build");
    expect(admin.paragraphs.join(" ")).toContain("Horizon admins");
    expect(admin.paragraphs.join(" ")).toContain("without an account");
  });
});
