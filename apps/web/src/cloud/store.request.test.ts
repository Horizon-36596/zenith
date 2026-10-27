/**
 * A change that went through is reported as made even when the lists cannot be read again right
 * after it: reporting it as failed would invite a retry that makes it twice (issue #404).
 */
import { describe, expect, it } from "vitest";
import { getCloud, revokeInvite, setSharingBackend } from "./store";
import type { SharingApi } from "./types";

const refuse = (): Promise<never> => Promise.reject(new Error("unused"));

describe("a sharing request whose list refresh fails", () => {
  it("returns the change's result and shows the refresh failure as the error", async () => {
    let listsReadable = true;
    const revoked: string[] = [];
    const lists = <T,>(empty: T): Promise<T> =>
      listsReadable ? Promise.resolve(empty) : Promise.reject(new Error("The lists could not be read."));
    const api: SharingApi = {
      listShares: () => lists([]),
      listStopped: () => Promise.resolve([]),
      checkPartnerKeys: refuse,
      createShare: refuse,
      extendShare: refuse,
      setLevel: refuse,
      setMode: refuse,
      revokeShare: refuse,
      updateShare: refuse,
      listInvites: () => lists([]),
      extendInvite: refuse,
      revokeInvite: (code) => {
        revoked.push(code);
        return Promise.resolve();
      },
      listReceived: () => Promise.resolve([]),
      listWaiting: () => Promise.resolve([]),
      openShare: refuse,
      openLink: refuse,
      revisionFiles: refuse,
    };
    setSharingBackend(api, { signedIn: true, teamId: "t1", teamNumber: 36596, teamName: "Horizon" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    listsReadable = false;
    const result = await revokeInvite("ABCD", "Invite revoked.");
    expect(revoked).toEqual(["ABCD"]);
    expect(result).not.toBeNull();
    expect(getCloud().error).toBe("The lists could not be read.");
    expect(getCloud().busy).toBe(false);
  });
});
