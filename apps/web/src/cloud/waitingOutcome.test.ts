/**
 * What a share made while offline turns into once its write settles. The share dialog says "Waiting
 * to share" only while the write waits: a write that went says it is shared, and one the cloud
 * refused, or that signing out dropped, says why so the person can share again.
 */
import { describe, expect, it } from "vitest";
import { waitingOutcome } from "./ShareSheet";
import type { PendingShareResult, Share } from "./types";

const base = {
  id: "share-1",
  autoId: "auto-1",
  audience: "teams",
  teamNumbers: [12345],
  level: "view",
  mode: "follow",
  revision: 2,
  revisionId: "rev-2",
  projection: "{}",
  expiresAt: null,
} as unknown as Share;

const inOutbox: Share = { ...base, queued: true, outboxId: "w-1" };

describe("waitingOutcome", () => {
  it("waits while the Outbox entry is still queued, or when the share never waited", () => {
    expect(waitingOutcome(inOutbox, {}, [{ id: "w-1", state: "queued", error: null }])).toBeNull();
    expect(waitingOutcome(inOutbox, {}, [])).toBeNull();
    expect(waitingOutcome(base, {}, [{ id: "w-1", state: "failed", error: "No." }])).toBeNull();
  });

  it("turns into the share, without its Outbox marks, once the write was sent", () => {
    const outcome = waitingOutcome(inOutbox, {}, [{ id: "w-1", state: "sent", error: null }]);
    expect(outcome).toEqual({ ok: true, share: base });
  });

  it("says why when the cloud refused the write, or signing out dropped it", () => {
    expect(waitingOutcome(inOutbox, {}, [{ id: "w-1", state: "failed", error: "That team does not exist." }])).toEqual({
      ok: false,
      sentence: "Did not share with team 12345: That team does not exist.",
    });
    expect(waitingOutcome({ ...inOutbox, teamNumbers: [12345, 23456] }, {}, [{ id: "w-1", state: "dropped", error: null }])).toEqual({
      ok: false,
      sentence: "Did not share with teams 12345, 23456: signing out dropped it before it was sent.",
    });
  });

  it("follows a share held on the page for its connection by what it reported", () => {
    const held: Share = { ...base, waitsForConnection: true };
    expect(waitingOutcome(held, {}, [])).toBeNull();
    const made: PendingShareResult = { ok: true, sentence: "Shared with team 12345.", waitingId: "share-1", share: { ...base, id: "share-9" } };
    expect(waitingOutcome(held, { "share-1": made }, [])).toEqual({ ok: true, share: { ...base, id: "share-9" } });
    const refused: PendingShareResult = { ok: false, sentence: "Did not share with team 12345: No key.", waitingId: "share-1" };
    expect(waitingOutcome(held, { "share-1": refused }, [])).toEqual({ ok: false, sentence: "Did not share with team 12345: No key." });
  });
});
