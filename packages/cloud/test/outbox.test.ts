/**
 * The Outbox's states around a sign-out (issue #319): only a sign-out marks an entry dropped, a
 * failed sign-out puts its entries back, and a rejection that merely says "signed-out" stays a
 * refusal with its own words.
 */
import { describe, expect, it } from "vitest";
import { CloudError } from "../src/errors.js";
import { Outbox, SIGNED_OUT_NOTE } from "../src/outbox.js";

/** A write whose settlement the test decides. */
function pending() {
  let resolve: () => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const sent = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  sent.catch(() => undefined);
  return { sent, resolve, reject };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function outbox() {
  return new Outbox(() => new Date(2026, 9, 10), () => true);
}

describe("Outbox around a sign-out (issue #319)", () => {
  it("keeps a signed-out rejection with no sign-out as failed, with the real message", async () => {
    const box = outbox();
    const write = pending();
    const { outboxId } = box.track("publish", "Publish revision 1.", write.sent);
    write.reject(new CloudError("signed-out", "Your sign-in expired. Sign in again."));
    await settled();
    expect(box.status().entries.find((e) => e.id === outboxId)).toMatchObject({
      state: "failed",
      error: "Your sign-in expired. Sign in again.",
    });
    expect(box.status()).toMatchObject({ failed: 1, dropped: 0 });
  });

  it("marks queued entries dropped, and a rejection after the sign-out finished leaves them dropped", async () => {
    const box = outbox();
    const write = pending();
    const { outboxId } = box.track("publish", "Publish revision 1.", write.sent);
    const drop = box.dropQueued();
    drop.done();
    write.reject(new CloudError("signed-out", "Signed out before this change was sent."));
    await settled();
    expect(box.status().entries.find((e) => e.id === outboxId)).toMatchObject({ state: "dropped", error: SIGNED_OUT_NOTE });
    expect(box.status()).toMatchObject({ queued: 0, dropped: 1 });
  });

  it("puts the entries back when the sign-out fails", () => {
    const box = outbox();
    const write = pending();
    const { outboxId } = box.track("publish", "Publish revision 1.", write.sent);
    box.dropQueued().restore();
    expect(box.status().entries.find((e) => e.id === outboxId)).toMatchObject({ state: "queued", error: null, settledAt: null });
    expect(box.status()).toMatchObject({ queued: 1, dropped: 0 });
  });

  it("keeps what the server said while a failed sign-out was in progress", async () => {
    const box = outbox();
    const write = pending();
    const { outboxId } = box.track("publish", "Publish revision 1.", write.sent);
    const drop = box.dropQueued();
    write.reject(new CloudError("permission-denied", "The access rules refused it."));
    await settled();
    expect(box.status().entries.find((e) => e.id === outboxId)?.state).toBe("dropped");
    drop.restore();
    expect(box.status().entries.find((e) => e.id === outboxId)).toMatchObject({ state: "failed", error: "The access rules refused it." });
  });

  it("turns a dropped write the server acknowledges after all into sent", async () => {
    const box = outbox();
    const write = pending();
    const { outboxId } = box.track("publish", "Publish revision 1.", write.sent);
    box.dropQueued().done();
    write.resolve();
    await settled();
    expect(box.status().entries.find((e) => e.id === outboxId)).toMatchObject({ state: "sent", error: null });
  });
});
