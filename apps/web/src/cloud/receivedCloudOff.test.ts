/**
 * The Partners panel's shares with the cloud off (no Firebase config and no `?cloud=fake`): the link
 * shares kept or opened on this computer are not listed, since nothing could open them again and
 * the editor shows nothing of the cloud. With the cloud on, the same list shows them.
 */
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudEnabled } from "../account/config";
import { memoryStorage } from "../account/storage";
import { html, text } from "../account/keys/testMarkup";
import { openedLinksToList, type KeptShare } from "./keptShares";

const LINK: KeptShare = { id: "linkA", secret: "aAAAAAAAAAAAAAAAAAAAAA", label: "Shared link", via: "link", kept: true };
const TEAM: KeptShare = { id: "teamShare", label: "Team 12345", via: "team", kept: true };

describe("the link shares the Partners panel lists as opened here", () => {
  it("are every opened or kept link not already listed as made to the team, with the cloud on", () => {
    const other: KeptShare = { ...LINK, id: "linkB", kept: false };
    expect(openedLinksToList([LINK, TEAM, other], new Set(), true)).toEqual([LINK, other]);
    expect(openedLinksToList([LINK, TEAM, other], new Set(["linkB"]), true)).toEqual([LINK]);
  });

  it("are none with the cloud off", () => {
    expect(openedLinksToList([LINK, TEAM], new Set(), false)).toEqual([]);
  });
});

// Each case imports the Partners panel afresh, after resetModules, and the first import transforms
// the whole panel, which takes 7 to 8 seconds on a cold cache: past the 5-second default.
const FRESH_IMPORT_MS = 60_000;

describe("the Partners panel's shares", () => {
  afterEach(() => {
    vi.doUnmock("../account/config");
    vi.resetModules();
  });

  /** The panel's shares section as the page draws it, with one kept link on this computer. */
  async function drawn(): Promise<string> {
    const { keptShares } = await import("./keptSharesStore");
    const { ReceivedShares } = await import("./ReceivedShares");
    keptShares.useStorage(memoryStorage());
    keptShares.setKept(LINK, true);
    return html(createElement(ReceivedShares));
  }

  it("shows nothing with the cloud off, not even a link kept here", async () => {
    expect(cloudEnabled()).toBe(false);
    vi.resetModules();
    expect(await drawn()).toBe("");
  }, FRESH_IMPORT_MS);

  it("lists the kept link with the cloud on", async () => {
    vi.resetModules();
    vi.doMock("../account/config", async (importOriginal) => {
      const original = await importOriginal<typeof import("../account/config")>();
      return { ...original, cloudEnabled: () => true };
    });
    const shown = text(await drawn());
    expect(shown).toContain("Links opened here");
    expect(shown).toContain("Kept for offline on this computer");
  }, FRESH_IMPORT_MS);
});
