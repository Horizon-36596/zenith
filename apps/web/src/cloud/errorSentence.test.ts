/**
 * One translator for every failed cloud call (the 0.1.2 UX review, C6): the same offline or refused
 * call reads the same on Sharing, the account and team sheets, the library and the admin pages, and
 * the SDK's developer text never reaches the screen.
 */
import { describe, expect, it } from "vitest";
import { CloudError, OFFLINE_NOT_SAVED, RULES_REFUSED, toCloudError } from "@horizon36596/zenith-cloud";
import { grantErrorWords } from "../admin/betaAccessModel";
import { sharingErrorSentence } from "./cloudSharingApi";
import { OFFLINE, REQUEST_FAILED, cloudErrorSentence, isRulesRefusal } from "./errorSentence";

/** A Firestore SDK error, as the SDK throws it. */
const firestoreError = (code: string, message: string): Error => Object.assign(new Error(message), { name: "FirebaseError", code });

describe("cloudErrorSentence", () => {
  it("words what the stores say the way Sharing does, with what to do next", () => {
    expect(OFFLINE).toBe(OFFLINE_NOT_SAVED);
    const offline = toCloudError(firestoreError("unavailable", "Failed to get document because the client is offline."));
    expect(cloudErrorSentence(offline)).toBe(
      "This computer cannot reach the cloud, and has no copy of that saved for offline use. Try again once it is back online.",
    );
    expect(sharingErrorSentence(offline)).toBe(cloudErrorSentence(offline));
    expect(cloudErrorSentence(toCloudError(firestoreError("permission-denied", "Missing or insufficient permissions.")))).toBe(RULES_REFUSED);
  });

  it("never shows the SDK's own text", () => {
    const raw = toCloudError(firestoreError("invalid-argument", "Function setDoc() called with invalid data. Unsupported field value: undefined."));
    expect(raw.message).not.toContain("setDoc");
    expect(cloudErrorSentence(raw)).toBe("The cloud could not take that request. Try again in a moment.");
    expect(cloudErrorSentence(firestoreError("auth/popup-closed-by-user", "Firebase: Error (auth/popup-closed-by-user)."))).toBe(REQUEST_FAILED);
    expect(cloudErrorSentence(firestoreError("auth/network-request-failed", "Firebase: Error (auth/network-request-failed)."))).toBe(OFFLINE);
    expect(cloudErrorSentence(new TypeError("Failed to fetch"))).toBe(REQUEST_FAILED);
    expect(cloudErrorSentence("thrown text")).toBe(REQUEST_FAILED);
  });

  it("says a call the server did not finish may work again, and claims a change only for a lost transaction", () => {
    for (const code of ["deadline-exceeded", "cancelled"]) {
      const error = toCloudError(firestoreError(code, "x"));
      expect([error.code, error.message], code).toEqual(["unavailable", OFFLINE_NOT_SAVED]);
    }
    for (const code of ["resource-exhausted", "internal"]) {
      const error = toCloudError(firestoreError(code, "x"));
      expect([error.code, error.message], code).toEqual(["invalid", "The cloud could not take that request. Try again in a moment."]);
    }
    expect(toCloudError(firestoreError("failed-precondition", "The query requires an index.")).message).toBe(
      "The cloud could not take that request. Try again in a moment.",
    );
    expect(toCloudError(firestoreError("aborted", "x")).code).toBe("conflict");
  });

  it("keeps the client's own sentences, which say exactly what is wrong", () => {
    expect(cloudErrorSentence(new CloudError("permission-denied", "Only an owner of the team can delete it."))).toBe("Only an owner of the team can delete it.");
    expect(cloudErrorSentence(new CloudError("conflict", "This person is already a Horizon admin."))).toBe("This person is already a Horizon admin.");
    expect(cloudErrorSentence(new CloudError("signed-out", "Sign in to delete your account."))).toBe("Sign in to delete your account.");
    expect(cloudErrorSentence(new CloudError("signed-out", "x"))).toBe("Sign in, then try again.");
    expect(cloudErrorSentence(new CloudError("signed-out", "x"), { signedOut: "Sign in to share." })).toBe("Sign in to share.");
  });

  it("tells a refusal by the rules from the client's own refusals", () => {
    expect(isRulesRefusal(new CloudError("permission-denied", RULES_REFUSED))).toBe(true);
    expect(isRulesRefusal(new CloudError("permission-denied", "Only an owner of the team can delete it."))).toBe(false);
    expect(isRulesRefusal(new CloudError("unavailable", RULES_REFUSED))).toBe(false);
  });

  it("is what the admin pages fall back to", () => {
    expect(grantErrorWords(firestoreError("unknown", "INTERNAL ASSERTION FAILED: Unexpected state"))).toBe(REQUEST_FAILED);
  });
});
