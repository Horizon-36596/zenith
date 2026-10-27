/**
 * The host allowlist (site/docs/host-protocol.md, origin rules): a message is accepted only
 * from an origin on the host's own list, on the build's extra list, or from a local dev server
 * when the host allows those. Everything else, including look-alike domains, is refused.
 */
import { describe, expect, it } from "vitest";
import {
  HOSTS,
  hostById,
  hostIdFromSearch,
  isAllowedOrigin,
  isLocalDevOrigin,
  normalizeOrigin,
  outdatedHostLine,
  parseOriginList,
  refusedSaveLine,
  runFailedLine,
  runTimeoutLine,
  type HostInfo,
} from "./hostOrigins";

const dsim = HOSTS["dsim"] as HostInfo;

describe("hostById and hostIdFromSearch", () => {
  it("knows DSIM by its short name, and nothing else", () => {
    expect(hostById("dsim")?.displayName).toBe("DSIM");
    expect(hostById("DSIM")).toBeNull();
    expect(hostById("toString")).toBeNull();
    expect(hostById("constructor")).toBeNull();
    expect(hostById("")).toBeNull();
    expect(hostById(null)).toBeNull();
  });

  it("reads ?host= from a query string", () => {
    expect(hostIdFromSearch("?host=dsim")).toBe("dsim");
    expect(hostIdFromSearch("?foo=1&host=dsim")).toBe("dsim");
    expect(hostIdFromSearch("?host=")).toBeNull();
    expect(hostIdFromSearch("")).toBeNull();
  });
});

describe("normalizeOrigin", () => {
  it("keeps scheme, host and port, lower-cased, without a trailing slash", () => {
    expect(normalizeOrigin("https://www.playdsim.com")).toBe("https://www.playdsim.com");
    expect(normalizeOrigin("https://WWW.PlayDSIM.com/")).toBe("https://www.playdsim.com");
    expect(normalizeOrigin("http://localhost:5173")).toBe("http://localhost:5173");
  });

  it("refuses what is not an http or https origin", () => {
    expect(normalizeOrigin("null")).toBeNull();
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin("file:///tmp/host.html")).toBeNull();
    expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeOrigin("https://playdsim.com/path")).toBeNull();
    // a URL that carries a user name and password is never an origin
    const withCredentials = new URL("https://playdsim.com");
    withCredentials.username = "user";
    withCredentials.password = "secret";
    expect(normalizeOrigin(withCredentials.href)).toBeNull();
    expect(normalizeOrigin("not an origin")).toBeNull();
  });
});

describe("isAllowedOrigin", () => {
  it("accepts every DSIM production origin", () => {
    for (const origin of [
      "https://www.playdsim.com",
      "https://playdsim.com",
      "https://alpha.playdsim.com",
      "https://beta.playdsim.com",
    ]) {
      expect(isAllowedOrigin(dsim, origin), origin).toBe(true);
    }
  });

  it("accepts a local dev server on any port, over http only", () => {
    expect(isAllowedOrigin(dsim, "http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin(dsim, "http://127.0.0.1:4173")).toBe(true);
    expect(isAllowedOrigin(dsim, "http://localhost")).toBe(true);
    expect(isLocalDevOrigin("https://localhost:5173")).toBe(false);
    expect(isAllowedOrigin(dsim, "https://localhost:5173")).toBe(false);
  });

  it("refuses look-alikes, other schemes and other subdomains", () => {
    for (const origin of [
      "http://playdsim.com",
      "https://evil-playdsim.com",
      "https://playdsim.com.evil.example",
      "https://gamma.playdsim.com",
      "https://www.playdsim.co",
      "http://localhost.evil.example",
      "http://127.0.0.2:5173",
      "http://0.0.0.0:5173",
      "null",
    ]) {
      expect(isAllowedOrigin(dsim, origin), origin).toBe(false);
    }
  });

  it("refuses local dev servers for a host that does not allow them", () => {
    const strict: HostInfo = { ...dsim, allowLocalDev: false };
    expect(isAllowedOrigin(strict, "http://localhost:5173")).toBe(false);
    expect(isAllowedOrigin(strict, "https://playdsim.com")).toBe(true);
  });

  it("accepts the build's extra origins, and only those", () => {
    const extra = parseOriginList(" https://dsim-git-feature.vercel.app , https://preview.example/ ,, junk ");
    expect(extra).toEqual(["https://dsim-git-feature.vercel.app", "https://preview.example"]);
    expect(isAllowedOrigin(dsim, "https://dsim-git-feature.vercel.app", extra)).toBe(true);
    expect(isAllowedOrigin(dsim, "https://preview.example", extra)).toBe(true);
    expect(isAllowedOrigin(dsim, "https://other.vercel.app", extra)).toBe(false);
    expect(parseOriginList(undefined)).toEqual([]);
  });
});

describe("outdatedHostLine", () => {
  const withMinimum: HostInfo = { ...dsim, minBuild: 42 };

  it("says the host needs an update, what is off, what still works, and the two builds", () => {
    expect(outdatedHostLine(withMinimum, 41)).toBe(
      "DSIM needs an update before it can read autos from this Zenith, so Save to DSIM and Simulate in DSIM are off. " +
        "Save a copy keeps your work. " +
        "This DSIM page is build 41, and this Zenith needs build 42 or later; if DSIM has been updated, reload it and open Zenith from it again.",
    );
  });

  it("says nothing for a build that is new enough, a host that sent none, or a host with no minimum", () => {
    expect(outdatedHostLine(withMinimum, 42)).toBeNull();
    expect(outdatedHostLine(withMinimum, 43)).toBeNull();
    expect(outdatedHostLine(withMinimum, undefined)).toBeNull();
    const noMinimum: HostInfo = { id: "other", displayName: "Other", origins: [], allowLocalDev: false };
    expect(outdatedHostLine(noMinimum, 1)).toBeNull();
  });

  it("expects DSIM build 2, the first that reads the auto format this Zenith writes (sweep W4-1)", () => {
    expect(dsim.minBuild).toBe(2);
    // DSIM build 1 vendors Zenith 0.1.1, which refuses format 4 autos, so it needs an update.
    expect(outdatedHostLine(dsim, 1)).toContain("DSIM needs an update before it can read autos from this Zenith");
    expect(outdatedHostLine(dsim, 1)).toContain("build 1, and this Zenith needs build 2 or later");
    expect(outdatedHostLine(dsim, 0)).not.toBeNull();
    expect(outdatedHostLine(dsim, 2)).toBeNull();
    // A DSIM page from before builds were numbered sends none, and is not called out of date.
    expect(outdatedHostLine(dsim, undefined)).toBeNull();
  });
});

describe("refusedSaveLine", () => {
  it("does not add a second full stop to a reason that already ends its sentence", () => {
    const line = refusedSaveLine("DSIM", "first-auto", "Reload DSIM, then save again.", "did not save");
    expect(line).toBe("DSIM did not save first-auto: Reload DSIM, then save again.");
    expect(line).not.toContain("..");
    expect(refusedSaveLine("DSIM", "first-auto", "Is the disk full?", "could not save")).not.toMatch(/[.!?]{2}$/);
  });

  it("ends a reason without a full stop, and says when the host gave none", () => {
    expect(refusedSaveLine("DSIM", "first-auto", "full", "did not save")).toBe("DSIM did not save first-auto: full.");
    expect(refusedSaveLine("DSIM", "first-auto", undefined, "could not save")).toBe(
      "DSIM could not save first-auto: no reason given.",
    );
    expect(refusedSaveLine("DSIM", "first-auto", "  ", "could not save")).toBe("DSIM could not save first-auto: no reason given.");
  });
});

describe("runFailedLine and runTimeoutLine (sweep W4-2)", () => {
  it("gives the host's reason for a run it could not do, ending the sentence once", () => {
    expect(runFailedLine("DSIM", "first-auto.auto.json", "This auto file is formatVersion 4")).toBe(
      "DSIM could not simulate first-auto.auto.json: This auto file is formatVersion 4.",
    );
    expect(runFailedLine("DSIM", "first-auto.auto.json", "No robot.")).toBe("DSIM could not simulate first-auto.auto.json: No robot.");
  });

  it("says what to do next when the host never answers a run", () => {
    expect(runTimeoutLine("DSIM", 60)).toBe("DSIM did not send a trace back within 60 s. Check DSIM's window, then try again.");
  });
});
