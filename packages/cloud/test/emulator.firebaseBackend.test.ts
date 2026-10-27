/**
 * The real FirebaseBackend against the Authentication and Firestore emulators: email-link sign-in,
 * a first write under the rules, sign-out clearing the cache and reopening Firestore, and signing in
 * again with a native credential to delete the account, and the private beta's gate as the client
 * reads it. Runs under `pnpm test:rules`, which starts
 * both emulators; skipped, saying so, otherwise.
 */
import type { RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isCloudError } from "../src/errors.js";
import { FirebaseBackend } from "../src/firebase/firebaseBackend.js";
import type { DocData } from "../src/store.js";
import { EMULATOR_HOST, startEmulatorEnvironment, storeOf } from "./emulatorHarness.js";

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
// The Auth emulator serves the project `emulators:exec` was started with (packages/cloud/package.json).
const PROJECT = "demo-zenith";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

interface OobCode {
  email: string;
  requestType: string;
  oobLink: string;
}

async function lastSignInLink(email: string): Promise<string> {
  const response = await fetch(`http://${AUTH_HOST ?? ""}/emulator/v1/projects/${PROJECT}/oobCodes`);
  const body = (await response.json()) as { oobCodes: OobCode[] };
  const codes = body.oobCodes.filter((c) => c.email === email && c.requestType === "EMAIL_SIGNIN");
  const last = codes.at(-1);
  if (last === undefined) throw new Error(`The Auth emulator sent no sign-in link to ${email}.`);
  return last.oobLink;
}

if (EMULATOR_HOST === undefined || AUTH_HOST === undefined) {
  describe("FirebaseBackend (emulators)", () => {
    it.skip("FirebaseBackend tests skipped: run `pnpm test:rules` to start the Firestore and Auth emulators.", () => undefined);
  });
} else {
  let env: RulesTestEnvironment | undefined;
  /** Writes or deletes a document as the Firebase console would, outside the rules. */
  const asConsole = async (path: string, data: DocData | null) => {
    await env?.withSecurityRulesDisabled(async (ctx) => {
      await storeOf(ctx.firestore()).commit([data === null ? { op: "delete", path } : { op: "set", path, data }]).sent;
    });
  };
  beforeAll(async () => {
    env = await startEmulatorEnvironment(PROJECT);
    await env.clearFirestore();
    // The emulator starts as a closed private beta; these tests sign in as new users, so open it.
    await asConsole("config/access", { betaOpen: true });
  });
  afterAll(async () => {
    await env?.cleanup();
  });

  describe("FirebaseBackend (emulators)", () => {
    it("signs in by email link, writes under the rules, and signs out clearing the cache", async () => {
      const [host, port] = EMULATOR_HOST.split(":");
      const backend = new FirebaseBackend({
        config: { projectId: PROJECT, apiKey: "demo-api-key", authDomain: `${PROJECT}.firebaseapp.com` },
        persistence: false,
        emulators: { firestore: { host: host ?? "127.0.0.1", port: Number(port) }, authUrl: `http://${AUTH_HOST}` },
        appName: "backend-test",
      });
      const email = `coach-${String(Date.now())}@example.org`;
      await backend.sendSignInLink(email, "http://localhost:5173/zenith/app/");
      const link = await lastSignInLink(email);
      expect(backend.isSignInLink(link)).toBe(true);
      expect(backend.isSignInLink("http://localhost:5173/zenith/app/")).toBe(false);

      const user = await backend.completeSignInLink(email, link);
      expect(user.email).toBe(email);
      expect(backend.currentUser()?.uid).toBe(user.uid);

      await (await backend.saveProfile({ displayName: "Coach" })).sent;
      const team = await backend.createTeam({ number: null, name: "Horizon" });
      await team.sent;
      expect((await backend.listMyTeams()).map((m) => m.role)).toEqual(["owner"]);

      await backend.signOut();
      expect(backend.currentUser()).toBe(null);
      await expect(backend.listMyTeams()).rejects.toSatisfy((e: unknown) => isCloudError(e, "signed-out"));

      // Signing in again uses the fresh Firestore instance that sign-out opened.
      await backend.sendSignInLink(email, "http://localhost:5173/zenith/app/");
      await backend.completeSignInLink(email, await lastSignInLink(email));
      expect((await backend.listMyTeams()).map((m) => m.team?.name)).toEqual(["Horizon"]);
    });

    it("signs in with each provider's native credential through signInWithCredential", async () => {
      const [host, port] = EMULATOR_HOST.split(":");
      const backend = new FirebaseBackend({
        config: { projectId: PROJECT, apiKey: "demo-api-key", authDomain: `${PROJECT}.firebaseapp.com` },
        persistence: false,
        emulators: { firestore: { host: host ?? "127.0.0.1", port: Number(port) }, authUrl: `http://${AUTH_HOST}` },
        appName: "native-credential-test",
      });
      // The Auth emulator accepts plain JSON claims as a fake token and checks no signature or nonce,
      // so this pins the request the client sends, not the providers' own checks (ADR 0011).
      const stamp = String(Date.now());
      const claims = (who: string) => JSON.stringify({ sub: `${who}-${stamp}`, email: `${who}-${stamp}@example.org` });
      const google = await backend.signInWithNativeCredential({ provider: "google", idToken: claims("google") });
      expect(google.providerIds).toEqual(["google.com"]);
      await backend.signOut();
      const microsoft = await backend.signInWithNativeCredential({
        provider: "microsoft",
        idToken: claims("microsoft"),
        rawNonce: "raw-nonce",
      });
      expect(microsoft.providerIds).toEqual(["microsoft.com"]);
      await backend.signOut();
      const github = await backend.signInWithNativeCredential({ provider: "github", accessToken: claims("github") });
      expect(github.providerIds).toEqual(["github.com"]);
      expect(backend.currentUser()?.uid).toBe(github.uid);
      await backend.signOut();
    });

    it("deletes an account after the desktop sign-in hands back its own credential, and refuses another account's", async () => {
      const [host, port] = EMULATOR_HOST.split(":");
      const backend = new FirebaseBackend({
        config: { projectId: PROJECT, apiKey: "demo-api-key", authDomain: `${PROJECT}.firebaseapp.com` },
        persistence: false,
        emulators: { firestore: { host: host ?? "127.0.0.1", port: Number(port) }, authUrl: `http://${AUTH_HOST}` },
        appName: "native-reauth-test",
      });
      const stamp = String(Date.now());
      const token = (who: string) => JSON.stringify({ sub: `${who}-${stamp}`, email: `${who}-${stamp}@example.org` });
      const user = await backend.signInWithNativeCredential({ provider: "google", idToken: token("vic") });
      // With the beta closed, the client reads its own tester entry: none, then the one the owner adds.
      await asConsole("config/access", null);
      expect(await backend.hasBetaAccess()).toBe(false);
      await expect((await backend.saveProfile({ displayName: "Vic" })).sent).rejects.toSatisfy((e: unknown) =>
        isCloudError(e, "permission-denied"),
      );
      await asConsole(`betaTesters/${user.uid}`, { name: "Vic" });
      expect(await backend.hasBetaAccess()).toBe(true);
      await (await backend.saveProfile({ displayName: "Vic" })).sent;

      const asked: string[] = [];
      await expect(
        backend.deleteAccount({
          reauthenticate: async (provider) => {
            asked.push(provider);
            return { provider: "google", idToken: token("someone-else") };
          },
        }),
      ).rejects.toSatisfy((e: unknown) => isCloudError(e, "reauth-required") && /different account\. Nothing was deleted/.test((e as Error).message));
      expect(asked).toEqual(["google"]);
      expect(backend.currentUser()?.uid).toBe(user.uid);
      expect(await backend.getProfile()).toMatchObject({ displayName: "Vic" });

      await backend.deleteAccount({ reauthenticate: async () => ({ provider: "google", idToken: token("vic") }) });
      expect(backend.currentUser()).toBe(null);
      await asConsole("config/access", { betaOpen: true });
    });
  });
}
