/**
 * The in-app expiry warning (spec 13 section 8.4): which shares and invites it lists, in what
 * words, and dismissals that are kept per item, per end, on this device, surviving storage that
 * refuses every read and write.
 */
import { describe, expect, it } from "vitest";
import { memoryStorage, type DeviceStorage } from "../account/storage";
import {
  DISMISSED_KEY,
  EXPIRY_NOTICE_HOURS,
  MAX_DISMISSALS,
  createDismissals,
  endsWithinNotice,
  expiringItems,
  noticeKey,
  receivedEndingWords,
  type ExpiringInput,
} from "./expiryNoticeModel";
import type { Invite, Share } from "./types";

const NOW_MS = Date.parse("2026-09-27T12:00:00Z");
const HOUR = 3_600_000;
const at = (hours: number): string => new Date(NOW_MS + hours * HOUR).toISOString();

const share = (id: string, hours: number | null, patch: Partial<Share> = {}): Share => ({
  id,
  autoId: `auto-${id}`,
  audience: "teams",
  teamNumbers: [12345],
  level: "view",
  mode: "pinned",
  revision: 1,
  revisionId: "000001-AAAAAAAAAAA",
  projection: "{}",
  expiresAt: hours === null ? null : at(hours),
  revokedAt: null,
  createdAt: at(-24),
  createdBy: "me",
  ...patch,
});

const invite = (code: string, hours: number, patch: Partial<Invite> = {}): Invite => ({
  code,
  role: "editor",
  expiresAt: at(hours),
  maxUses: 1,
  uses: 0,
  autoApprove: false,
  revoked: false,
  ...patch,
});

const input = (patch: Partial<ExpiringInput> = {}): ExpiringInput => ({
  shares: [],
  invites: [],
  nowMs: NOW_MS,
  mayChange: () => true,
  mayExtendInvites: true,
  shareLabel: (entry) => `First auto, shared with Team ${String(entry.teamNumbers[0])}`,
  dismissed: new Set(),
  ...patch,
});

describe("the expiry warning's window", () => {
  it("is 48 hours, the Sharing page's two days", () => {
    expect(EXPIRY_NOTICE_HOURS).toBe(48);
    expect(endsWithinNotice(at(47.9), NOW_MS)).toBe(true);
    expect(endsWithinNotice(at(48), NOW_MS)).toBe(true);
    expect(endsWithinNotice(at(48.1), NOW_MS)).toBe(false);
    expect(endsWithinNotice(at(0), NOW_MS)).toBe(false);
    expect(endsWithinNotice(at(-1), NOW_MS)).toBe(false);
    expect(endsWithinNotice(null, NOW_MS)).toBe(false);
  });
});

describe("what the warning lists", () => {
  it("lists live shares and invites ending within 48 hours, soonest first, in plain words", () => {
    const items = expiringItems(
      input({
        shares: [share("later", 30), share("soon", 5), share("far", 72), share("never", null)],
        invites: [invite("INVITE0123456789", 20), invite("FARINVITE0000000", 100)],
      }),
    );
    expect(items.map((item) => `${item.kind}:${item.id}`)).toEqual(["share:soon", "invite:INVITE0123456789", "share:later"]);
    expect(items[0]).toMatchObject({
      autoId: "auto-soon",
      key: noticeKey("share", "soon", at(5)),
      words: "First auto, shared with Team 12345: 5 hours left.",
    });
    expect(items[1]?.words).toBe("The editor invite: 20 hours left.");
    expect(items[1]?.autoId).toBeNull();
  });

  it("leaves out revoked and ended shares, and used-up and revoked invites", () => {
    const items = expiringItems(
      input({
        shares: [share("revoked", 5, { revokedAt: at(-1) }), share("ended", -1)],
        invites: [invite("USEDUP0000000000", 5, { uses: 1 }), invite("REVOKED000000000", 5, { revoked: true })],
      }),
    );
    expect(items).toEqual([]);
  });

  it("lists only what the member could extend: shares they may change, invites for owners and admins", () => {
    const items = expiringItems(
      input({
        shares: [share("mine", 5), share("theirs", 5, { createdBy: "someone else" })],
        invites: [invite("INVITE0123456789", 5)],
        mayChange: (entry) => entry.createdBy === "me",
        mayExtendInvites: false,
      }),
    );
    expect(items.map((item) => item.id)).toEqual(["mine"]);
  });

  it("tells two invites of one role apart by the start of their codes, and only then", () => {
    const items = expiringItems(
      input({
        invites: [invite("AAAAAA0000000000", 20), invite("BBBBBB0000000000", 30), invite("CCCCCC0000000000", 10, { role: "viewer" })],
      }),
    );
    expect(items.map((item) => item.words)).toEqual([
      "The viewer invite: 10 hours left.",
      "The editor invite AAAAAA…: 20 hours left.",
      "The editor invite BBBBBB…: 1 day left.",
    ]);
    // With one of the two dismissed, the other reads plainly again.
    const dismissed = new Set([noticeKey("invite", "BBBBBB0000000000", at(30))]);
    const left = expiringItems(input({ invites: [invite("AAAAAA0000000000", 20), invite("BBBBBB0000000000", 30)], dismissed }));
    expect(left.map((item) => item.words)).toEqual(["The editor invite: 20 hours left."]);
  });

  it("leaves out a dismissed line, until the share has a new end", () => {
    const soon = share("soon", 5);
    const dismissed = new Set([noticeKey("share", "soon", at(5))]);
    expect(expiringItems(input({ shares: [soon], dismissed }))).toEqual([]);
    // Extended, and then near its new end again: warned about again.
    expect(expiringItems(input({ shares: [{ ...soon, expiresAt: at(40) }], dismissed })).map((item) => item.id)).toEqual(["soon"]);
  });
});

describe("a received share that ends soon", () => {
  it("gets a line in the Partners panel, and one that does not gets none", () => {
    expect(receivedEndingWords({ expiresAt: at(3) }, NOW_MS)).toBe("Ends soon: 3 hours left. Ask them for more time if you still need it.");
    expect(receivedEndingWords({ expiresAt: at(49) }, NOW_MS)).toBeNull();
  });
});

describe("dismissals on this device", () => {
  it("are kept per item in storage, and read back by a new page", () => {
    const storage = memoryStorage();
    const first = createDismissals(storage);
    let heard = 0;
    first.subscribe(() => {
      heard += 1;
    });
    first.dismiss(["share:a@x"]);
    first.dismiss(["invite:b@y", "share:a@x"]);
    expect([...first.get()].sort()).toEqual(["invite:b@y", "share:a@x"]);
    expect(heard).toBe(2);
    expect([...createDismissals(storage).get()].sort()).toEqual(["invite:b@y", "share:a@x"]);
  });

  it("keeps at most the newest 200", () => {
    const storage = memoryStorage();
    const store = createDismissals(storage);
    store.dismiss(Array.from({ length: MAX_DISMISSALS + 5 }, (_, index) => `share:${String(index)}@x`));
    expect(store.get().size).toBe(MAX_DISMISSALS);
    expect(store.get().has("share:0@x")).toBe(false);
    expect(store.get().has(`share:${String(MAX_DISMISSALS + 4)}@x`)).toBe(true);
  });

  it("start empty from a stored value that is not a list, and survive storage that refuses everything", () => {
    expect(createDismissals(memoryStorage({ [DISMISSED_KEY]: "not json" })).get().size).toBe(0);
    expect(createDismissals(memoryStorage({ [DISMISSED_KEY]: '{"a":1}' })).get().size).toBe(0);
    const refusing: DeviceStorage = {
      get: () => {
        throw new Error("blocked");
      },
      set: () => {
        throw new Error("blocked");
      },
      remove: () => undefined,
    };
    // `browserStorage` catches these itself; a store handed a raw one still must not throw, and
    // keeps the dismissal for this page.
    const store = createDismissals(refusing);
    expect(store.get().size).toBe(0);
    store.dismiss(["share:a@x"]);
    expect(store.get().has("share:a@x")).toBe(true);
  });

  it("keep an earlier dismissal on this page when storage refused to save it", () => {
    const saved = new Map<string, string>();
    const readOnly: DeviceStorage = {
      get: (key) => saved.get(key) ?? null,
      set: () => {
        throw new Error("full");
      },
      remove: () => undefined,
    };
    const store = createDismissals(readOnly);
    store.dismiss(["share:a@x"]);
    store.dismiss(["invite:b@y"]);
    expect([...store.get()].sort()).toEqual(["invite:b@y", "share:a@x"]);
  });
});
