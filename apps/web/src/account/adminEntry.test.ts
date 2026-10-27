/**
 * The Settings window's Admin dashboard entry (`AdminEntry.tsx`): it shows to a signed-in Horizon admin
 * only, by the admin page's own check against the in-memory cloud, and opens `#/admin`.
 */
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { MemoryBackend, MemoryDatabase } from "@horizon36596/zenith-cloud/memory";
import { AdminDashboardEntry, isSignedInHorizonAdmin } from "./AdminEntry";
import { click, html, nothing, tagOf, text } from "./keys/testMarkup";

describe("the Settings window's admin dashboard entry", () => {
  it("is offered to a Horizon admin and to nobody else", async () => {
    const database = new MemoryDatabase();
    database.seed("admins/hana", { name: "Reviewer" });
    const hana = new MemoryBackend({ database });
    hana.signInAs("hana");
    const alice = new MemoryBackend({ database });
    alice.signInAs("alice");
    const signedOut = new MemoryBackend({ database });

    expect(await isSignedInHorizonAdmin(hana)).toBe(true);
    expect(await isSignedInHorizonAdmin(alice)).toBe(false);
    expect(await isSignedInHorizonAdmin(signedOut)).toBe(false);
    // With the cloud off there is no backend at all.
    expect(await isSignedInHorizonAdmin(null)).toBe(false);
  });

  it("shows the Admin dashboard button for an admin, and nothing for anyone else", () => {
    const shown = html(createElement(AdminDashboardEntry, { admin: true, onOpen: nothing }));
    expect(text(shown)).toContain("Admin dashboard");
    expect(tagOf(shown, "account-admin-dashboard")).toContain("button");
    expect(html(createElement(AdminDashboardEntry, { admin: false, onOpen: nothing }))).toBe("");
  });

  it("opens the admin page when pressed", () => {
    let opened = 0;
    const tree = AdminDashboardEntry({ admin: true, onOpen: () => (opened += 1) });
    click(tree, "account-admin-dashboard");
    expect(opened).toBe(1);
  });
});
