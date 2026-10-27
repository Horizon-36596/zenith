/**
 * Signing in with a credential the app got from the provider itself (ADR 0011): the desktop app's
 * route, since Firebase's popup refuses its `zenith://` page.
 */
import { describe, expect, it } from "vitest";
import type { NativeCredential } from "../src/backend.js";
import { isCloudError } from "../src/errors.js";
import { nativeAuthCredential } from "../src/firebase/firebaseBackend.js";
import { MemoryBackend } from "../src/memory/memoryBackend.js";

describe("MemoryBackend.signInWithNativeCredential", () => {
  it("signs in the same user signInWithProvider would, for each provider", async () => {
    const cases: Array<[NativeCredential, string]> = [
      [{ provider: "google", idToken: "google-id-token" }, "google.com"],
      [{ provider: "microsoft", idToken: "microsoft-id-token", rawNonce: "nonce" }, "microsoft.com"],
      [{ provider: "github", accessToken: "github-access-token" }, "github.com"],
    ];
    for (const [credential, providerId] of cases) {
      const native = new MemoryBackend();
      const popup = new MemoryBackend();
      const viaNative = await native.signInWithNativeCredential(credential);
      const viaPopup = await popup.signInWithProvider(credential.provider);
      expect(viaNative).toEqual(viaPopup);
      expect(viaNative.providerIds).toEqual([providerId]);
      expect(native.currentUser()?.uid).toBe(viaNative.uid);
    }
  });

  it("tells its listeners, as a real sign-in would", async () => {
    const backend = new MemoryBackend();
    const seen: Array<string | null> = [];
    backend.onAuthChange((user) => seen.push(user?.uid ?? null));
    await backend.signInWithNativeCredential({ provider: "github", accessToken: "token" });
    expect(seen).toEqual([null, "memory-github-user"]);
  });

  it("refuses a credential with an empty token or, for Microsoft, no raw nonce", async () => {
    const empty: NativeCredential[] = [
      { provider: "google", idToken: "" },
      { provider: "microsoft", idToken: "id", rawNonce: "" },
      { provider: "microsoft", idToken: "", rawNonce: "nonce" },
      { provider: "github", accessToken: "" },
    ];
    for (const credential of empty) {
      const backend = new MemoryBackend();
      await expect(backend.signInWithNativeCredential(credential)).rejects.toSatisfy((e: unknown) => isCloudError(e, "invalid"));
      expect(backend.currentUser()).toBeNull();
    }
  });
});

describe("the Firebase credential for each provider", () => {
  it("is Google's ID token credential", () => {
    const json = nativeAuthCredential({ provider: "google", idToken: "google-id-token" }).toJSON() as Record<string, unknown>;
    expect(json).toMatchObject({ providerId: "google.com", signInMethod: "google.com", idToken: "google-id-token" });
    expect(json["accessToken"]).toBeUndefined();
  });

  it("is microsoft.com's ID token with the raw nonce, which Firebase hashes and compares", () => {
    const json = nativeAuthCredential({ provider: "microsoft", idToken: "ms-id-token", rawNonce: "raw" }).toJSON() as Record<
      string,
      unknown
    >;
    expect(json).toMatchObject({ providerId: "microsoft.com", signInMethod: "microsoft.com", idToken: "ms-id-token", nonce: "raw" });
    expect(json["accessToken"]).toBeUndefined();
  });

  it("is GitHub's access token credential", () => {
    const json = nativeAuthCredential({ provider: "github", accessToken: "gh-token" }).toJSON() as Record<string, unknown>;
    expect(json).toMatchObject({ providerId: "github.com", signInMethod: "github.com", accessToken: "gh-token" });
    expect(json["idToken"]).toBeUndefined();
  });
});
