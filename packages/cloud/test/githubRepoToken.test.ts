/**
 * "Sign in with GitHub" for GitHub mode in a browser: Firebase's GitHub popup asks for the `repo`
 * scope on a second, in-memory Firebase app, and only GitHub's token comes back. A Firebase user the
 * popup newly made is deleted again, an existing one is only signed out of the second app, and an
 * email already on another provider's account still yields GitHub's token. Firebase's popup is a
 * stand-in, so nothing leaves the test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCloudError } from "../src/errors.js";
import { GITHUB_REPO_SCOPES, githubRepoToken } from "../src/firebase/githubRepoToken.js";

const appNames = vi.hoisted((): string[] => []);

const auth = vi.hoisted(() => ({
  signInWithPopup: vi.fn(),
  deleteUser: vi.fn(),
  signOut: vi.fn(),
  getAdditionalUserInfo: vi.fn(),
  // Node's build of the SDK has no popup resolver, so the second app's Auth is a stand-in that
  // records which Firebase app it was made for.
  initializeAuth: vi.fn((app: { name: string }) => {
    appNames.push(app.name);
    return { app };
  }),
}));

vi.mock("firebase/auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("firebase/auth")>()), ...auth }));

const CONFIG = { projectId: "demo-zenith", apiKey: "demo-api-key", authDomain: "demo-zenith.firebaseapp.com" };
const USER = { uid: "u1" };

/** What Firebase's popup resolves with: the user and GitHub's OAuth credential. */
const popupResult = (accessToken: string | undefined) => ({
  user: USER,
  providerId: "github.com",
  operationType: "signIn",
  _tokenResponse: accessToken === undefined ? {} : { oauthAccessToken: accessToken, providerId: "github.com" },
});

beforeEach(() => {
  for (const fn of [auth.signInWithPopup, auth.deleteUser, auth.signOut, auth.getAdditionalUserInfo]) fn.mockReset();
  auth.deleteUser.mockResolvedValue(undefined);
  auth.signOut.mockResolvedValue(undefined);
});

describe("githubRepoToken", () => {
  it("asks for the repo scope and deletes a Firebase user it newly made", async () => {
    auth.signInWithPopup.mockResolvedValue(popupResult("gho_new"));
    auth.getAdditionalUserInfo.mockReturnValue({ isNewUser: true });

    expect(await githubRepoToken(CONFIG)).toBe("gho_new");
    const provider = auth.signInWithPopup.mock.calls[0]?.[1] as { getScopes(): string[] };
    expect(provider.getScopes()).toEqual([...GITHUB_REPO_SCOPES]);
    expect(GITHUB_REPO_SCOPES).toEqual(["repo"]);
    expect(auth.deleteUser).toHaveBeenCalledWith(USER);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("only signs an existing Zenith account out of the second app", async () => {
    auth.signInWithPopup.mockResolvedValue(popupResult("gho_existing"));
    auth.getAdditionalUserInfo.mockReturnValue({ isNewUser: false });

    expect(await githubRepoToken(CONFIG)).toBe("gho_existing");
    expect(auth.deleteUser).not.toHaveBeenCalled();
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it("runs on its own in-memory Firebase app, never the page's", async () => {
    auth.signInWithPopup.mockResolvedValue(popupResult("gho_t"));
    auth.getAdditionalUserInfo.mockReturnValue({ isNewUser: false });
    appNames.length = 0;
    await githubRepoToken(CONFIG);
    await githubRepoToken(CONFIG);
    const [first, second] = appNames;
    expect(first).toMatch(/^zenith-github-repo-\d+$/);
    expect(second).not.toBe(first);
  });

  it("still returns GitHub's token when the email is on an account with another provider", async () => {
    const error = Object.assign(new Error("exists"), {
      code: "auth/account-exists-with-different-credential",
      customData: { _tokenResponse: { oauthAccessToken: "gho_linked", providerId: "github.com" } },
    });
    auth.signInWithPopup.mockRejectedValue(error);
    expect(await githubRepoToken(CONFIG)).toBe("gho_linked");
    expect(auth.deleteUser).not.toHaveBeenCalled();
  });

  it("says one sentence when the popup is blocked or closed", async () => {
    auth.signInWithPopup.mockRejectedValue(Object.assign(new Error("blocked"), { code: "auth/popup-blocked" }));
    await expect(githubRepoToken(CONFIG)).rejects.toThrow("Allow pop-ups for this site");
    auth.signInWithPopup.mockRejectedValue(Object.assign(new Error("closed"), { code: "auth/popup-closed-by-user" }));
    const failure = await githubRepoToken(CONFIG).catch((e: unknown) => e);
    expect(isCloudError(failure, "invalid")).toBe(true);
    expect((failure as Error).message).toBe("Sign-in was cancelled.");
  });

  it("refuses a sign-in that came back without GitHub's token", async () => {
    auth.signInWithPopup.mockResolvedValue(popupResult(undefined));
    auth.getAdditionalUserInfo.mockReturnValue({ isNewUser: true });
    await expect(githubRepoToken(CONFIG)).rejects.toThrow("GitHub did not send a token.");
    // The user it made is still deleted.
    expect(auth.deleteUser).toHaveBeenCalledWith(USER);
  });
});
