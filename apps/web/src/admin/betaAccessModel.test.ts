/**
 * The admin page's Beta access view model (`betaAccessModel.ts`): what the fields say when they cannot
 * be sent, the count line, and which rows offer which change.
 */
import { describe, expect, it } from "vitest";
import { CloudError, type BetaAccessLists } from "@horizon36596/zenith-cloud";
import {
  ALREADY_HANDLED,
  adminName,
  grantErrorWords,
  isAdmin,
  isTester,
  makeAdminProblem,
  nameProblem,
  removeAdminProblem,
  testerCountWords,
  userCodeProblem,
} from "./betaAccessModel";

const lists: BetaAccessLists = {
  testers: [{ uid: "tess", name: "Tess" }],
  admins: [{ uid: "hana", name: "Hana" }, { uid: "sue", name: null }],
};

describe("the beta access view", () => {
  it("says why a name or a user code cannot be sent", () => {
    expect(nameProblem("  ")).toBe("Type the person's name.");
    expect(nameProblem("n".repeat(81))).toBe("A name has at most 80 characters.");
    expect(nameProblem(` ${"n".repeat(80)} `)).toBeNull();
    expect(userCodeProblem("")).toBe("Paste the person's user code.");
    expect(userCodeProblem("a/b")).toBe("A user code has at most 128 characters and no slash.");
    expect(userCodeProblem("c".repeat(129))).toBe("A user code has at most 128 characters and no slash.");
    expect(userCodeProblem(" abc123 ")).toBeNull();
  });

  it("refuses user codes Firestore cannot use as a document id, before writing", () => {
    const words = "That is not a user code. Copy it again from the person's private-beta screen.";
    for (const code of [".", "..", " .. ", "__x__", "____", "__name__"]) expect(userCodeProblem(code), code).toBe(words);
    expect(userCodeProblem("a/b/c")).toBe("A user code has at most 128 characters and no slash.");
    for (const code of ["...", "a.b", "__x", "x__", "_x_"]) expect(userCodeProblem(code), code).toBeNull();
  });

  it("says another admin got there first when an add is refused", () => {
    expect(ALREADY_HANDLED).toBe("Another admin already added this person; refresh.");
    expect(grantErrorWords(new CloudError("permission-denied", "The database's access rules do not allow this write."))).toBe(ALREADY_HANDLED);
    expect(grantErrorWords(new CloudError("not-found", "That request does not exist, or you cannot open it."))).toBe(ALREADY_HANDLED);
    expect(grantErrorWords(new CloudError("unavailable", "You are offline."))).toBe("You are offline.");
    expect(grantErrorWords("boom")).toBe("The request failed. Try again in a moment.");
  });

  it("counts the testers", () => {
    expect(testerCountWords(1)).toBe("1 tester");
    expect(testerCountWords(0)).toBe("0 testers");
  });

  it("knows who is a tester or an admin, and never lets an admin remove themselves", () => {
    expect(isTester(lists, "tess")).toBe(true);
    expect(isTester(lists, "stan")).toBe(false);
    expect(removeAdminProblem("hana", "hana")).toBe("You cannot remove yourself. Another Horizon admin can.");
    expect(removeAdminProblem("sue", "hana")).toBeNull();
    expect(isAdmin(lists, "sue")).toBe(true);
    expect(makeAdminProblem(lists, "sue")).toBe("This person is already a Horizon admin.");
    expect(makeAdminProblem(lists, "stan")).toBeNull();
  });

  it("names an admin with no name by their user code", () => {
    expect(adminName({ uid: "sue", name: null })).toBe("sue");
    expect(adminName({ uid: "hana", name: "Hana" })).toBe("Hana");
  });
});
