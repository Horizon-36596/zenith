import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDeploy } from "../src/main/deploy.js";
import { GitHubAuth, type SecretBox } from "../src/main/github.js";
import { menuTemplate } from "../src/main/menu.js";
import { PRODUCTION_CSP, isAppUrl, isExternalWebUrl, resolveAppFile } from "../src/main/security.js";
import { RECENT_LIMIT, pushRecent } from "../src/main/settings.js";
import { initialBounds, isVisible } from "../src/main/windowState.js";
import { exampleProject, patchLink } from "./support.js";

let root = "";
let cleanup: () => void = () => undefined;

beforeEach(() => {
  ({ root, cleanup } = exampleProject());
});

afterEach(() => {
  cleanup();
});

describe("the zenith:// scheme", () => {
  const dir = join("C:", "app", "renderer");

  it("serves files inside the renderer folder and index.html for in-app routes", () => {
    expect(resolveAppFile(dir, "zenith://app/")).toBe(join(dir, "index.html"));
    expect(resolveAppFile(dir, "zenith://app/review/owner/repo/3")).toBe(join(dir, "index.html"));
    expect(resolveAppFile(dir, "zenith://app/assets/index-abc.js")).toBe(join(dir, "assets", "index-abc.js"));
    expect(resolveAppFile(dir, "zenith://app/fonts/jost-latin-var.woff2")).toBe(join(dir, "fonts", "jost-latin-var.woff2"));
  });

  it("refuses anything that would leave it", () => {
    expect(resolveAppFile(dir, "zenith://app/..%2F..%2Fsecrets.txt")).toBeNull();
    // The URL parser folds encoded dot segments itself, so this one lands inside the folder.
    expect(resolveAppFile(dir, "zenith://app/%2e%2e/%2e%2e/secrets.txt")).toBe(join(dir, "secrets.txt"));
    expect(resolveAppFile(dir, "zenith://other/index.html")).toBeNull();
    expect(resolveAppFile(dir, "file:///C:/Windows/win.ini")).toBeNull();
    expect(resolveAppFile(dir, "zenith://app/a%00.js")).toBeNull();
  });

  it("keeps the page on its own origin and sends only web links to the browser", () => {
    expect(isAppUrl("zenith://app/#/review/a/b/1", null)).toBe(true);
    expect(isAppUrl("https://evil.example/", null)).toBe(false);
    expect(isAppUrl("http://localhost:5190/src/main.tsx", "http://localhost:5190")).toBe(true);
    expect(isAppUrl("http://localhost:5191/", "http://localhost:5190")).toBe(false);
    expect(isExternalWebUrl("https://github.com/example-team/robot/pull/7")).toBe(true);
    expect(isExternalWebUrl("file:///C:/Windows/System32/calc.exe")).toBe(false);
    expect(isExternalWebUrl("javascript:alert(1)")).toBe(false);
    expect(isExternalWebUrl("ms-settings:privacy")).toBe(false);
  });

  it("serves a policy with no inline or remote script", () => {
    const script = PRODUCTION_CSP.split("; ").find((part) => part.startsWith("script-src"));
    expect(script).toBe("script-src 'self'");
    expect(PRODUCTION_CSP).toContain("object-src 'none'");
    expect(PRODUCTION_CSP).toContain("base-uri 'none'");
  });
});

describe("Deploy", () => {
  it("previews what would change without writing, then writes exactly that", () => {
    const preview = runDeploy(root, true);
    expect(preview.dryRun).toBe(true);
    expect(preview.deployDir).toBe("TeamCode/src/main/assets/autos");
    // The starter names SolversLib in deploy.commandLibrary, and the preview says so.
    expect(preview.commandLibrary).toBe("solverslib");
    expect(existsSync(join(root, "TeamCode", "src", "main", "assets", "autos"))).toBe(false);
    expect(preview.changed).toBeGreaterThan(0);

    const applied = runDeploy(root, false);
    expect(applied.actions.map((action) => [action.kind, action.path, action.changed])).toEqual(
      preview.actions.map((action) => [action.kind, action.path, action.changed]),
    );
    const robot = join(root, "TeamCode", "src", "main", "assets", "autos", "robot.json");
    expect(readFileSync(robot, "utf8")).toBe(readFileSync(join(root, "autos", "robot.json"), "utf8"));

    const again = runDeploy(root, true);
    expect(again.changed).toBe(0);
    expect(again.actions.filter((action) => action.kind === "write")).toEqual([]);
  });

  it("refuses a deploy directory outside the repository", () => {
    patchLink(root, (link) => {
      (link["deploy"] as Record<string, string>)["dir"] = "../../ESCAPED";
    });
    expect(() => runDeploy(root, false)).toThrow(/outside the project root/);
  });

  it("says what is missing when zenith.json has no deploy section", () => {
    patchLink(root, (link) => {
      delete link["deploy"];
    });
    expect(() => runDeploy(root, true)).toThrow(/no "deploy" section/);
  });

  it("refuses to preview or deploy until zenith.json names a command library", () => {
    patchLink(root, (link) => {
      delete (link["deploy"] as Record<string, string>)["commandLibrary"];
    });
    expect(() => runDeploy(root, true)).toThrow(/does not say which command library/);
    expect(existsSync(join(root, "TeamCode", "src", "main", "assets", "autos"))).toBe(false);
  });

  it("deploys without a command library when there is no codegen section, since it then writes no Java", () => {
    patchLink(root, (link) => {
      delete (link["deploy"] as Record<string, string>)["commandLibrary"];
      delete link["codegen"];
    });
    const preview = runDeploy(root, true);
    expect(preview.commandLibrary).toBeNull();
    expect(preview.actions.filter((action) => action.path.endsWith(".java"))).toEqual([]);
    expect(preview.actions.length).toBeGreaterThan(0);
  });
});

describe("the GitHub token", () => {
  /** Reversible, but never the plain text: enough to prove the slot never holds the token itself. */
  const box = (available = true): SecretBox => ({
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`sealed:${Buffer.from(plain).toString("hex")}`),
    decryptString: (sealed) => Buffer.from(sealed.toString().replace(/^sealed:/, ""), "hex").toString(),
  });

  const slot = () => {
    let value: string | null = null;
    return { get: () => value, set: (next: string | null) => (value = next), peek: () => value };
  };

  it("keeps a pasted token encrypted and never in plain text", async () => {
    const s = slot();
    const auth = new GitHubAuth({ box: box(), slot: s, ghToken: async () => null, whoAmI: async () => "octo-member" });
    const status = await auth.setToken("  ghp_secret123  ");
    expect(status).toEqual({ source: "stored", login: "octo-member", canStore: true });
    expect(s.peek()).not.toBeNull();
    expect(Buffer.from(s.peek() as string, "base64").toString()).not.toContain("ghp_secret123");
    expect(await auth.token()).toBe("ghp_secret123");
    expect(JSON.stringify(auth)).not.toContain("ghp_secret123");
  });

  it("uses the GitHub CLI's token when nothing is stored, and stores nothing for it", async () => {
    const s = slot();
    const auth = new GitHubAuth({ box: box(), slot: s, ghToken: async () => "gho_fromgh", whoAmI: async () => "octo-member" });
    expect(await auth.status()).toEqual({ source: "gh", login: "octo-member", canStore: true });
    expect(s.peek()).toBeNull();
  });

  it("keeps the token for this session only when the OS has no encryption", async () => {
    const s = slot();
    const auth = new GitHubAuth({ box: box(false), slot: s, ghToken: async () => null, whoAmI: async () => "me" });
    expect(await auth.setToken("ghp_x")).toMatchObject({ source: "session", canStore: false });
    expect(s.peek()).toBeNull();
  });

  it("refuses a token GitHub does not accept, and forgets on request", async () => {
    const s = slot();
    const whoAmI = vi.fn(async (token: string) => {
      if (token !== "good") throw new Error("401");
      return "me";
    });
    const auth = new GitHubAuth({ box: box(), slot: s, ghToken: async () => null, whoAmI });
    await expect(auth.setToken("bad")).rejects.toThrow(/did not accept/);
    expect(s.peek()).toBeNull();
    await auth.setToken("good");
    expect((await auth.forgetToken()).source).toBeNull();
    expect(s.peek()).toBeNull();
    await expect(auth.token()).rejects.toThrow(/needs a GitHub token/);
  });
});

describe("window bounds and the recent list", () => {
  const screen = [{ x: 0, y: 0, width: 1920, height: 1040 }];

  it("reopens where it was when that is still on a screen, and centred on the default size when not", () => {
    expect(initialBounds({ x: 100, y: 80, width: 1500, height: 900, maximized: true }, screen)).toEqual({
      bounds: { x: 100, y: 80, width: 1500, height: 900 },
      maximized: true,
    });
    expect(initialBounds({ x: 4000, y: 80, width: 1500, height: 900, maximized: false }, screen).bounds).toEqual({ width: 1440, height: 900 });
    expect(isVisible({ x: 1850, y: 1000, width: 800, height: 600 }, screen)).toBe(false);
  });

  it("keeps the newest folder first, once, and at most eight", () => {
    let recent = pushRecent([], "C:\\a", 1);
    recent = pushRecent(recent, "C:\\b", 2);
    recent = pushRecent(recent, "C:\\a", 3);
    expect(recent.map((entry) => entry.root)).toEqual(["C:\\a", "C:\\b"]);
    for (let i = 0; i < 20; i += 1) recent = pushRecent(recent, `C:\\p${String(i)}`, 10 + i);
    expect(recent).toHaveLength(RECENT_LIMIT);
  });
});

describe("the native menu", () => {
  it("has the owner's items and sends web action ids for them", () => {
    const send = vi.fn();
    const template = menuTemplate([{ root: "C:\\robot-repo", name: "robot-repo", openedAt: 1 }], {
      send,
      about: vi.fn(),
      quit: vi.fn(),
      isDev: false,
    });
    const labels = template.map((menu) => menu.label?.replace("&", ""));
    expect(labels).toEqual(["File", "Edit", "View", "Robot", "Help"]);
    const items = template.flatMap((menu) => (Array.isArray(menu.submenu) ? menu.submenu : []));
    const byLabel = (label: string) => items.find((item) => item.label?.replace(/&/g, "") === label);
    expect(byLabel("Open robot repo…")).toBeDefined();
    expect(byLabel("Save")?.registerAccelerator).toBe(false);
    expect(byLabel("Tour")).toBeDefined();
    (byLabel("Tour")?.click as () => void)();
    (byLabel("Show me everything")?.click as () => void)();
    (byLabel("Keyboard shortcuts")?.click as () => void)();
    expect(byLabel("Keyboard shortcuts")).toBeDefined();
    expect(byLabel("About Zenith")).toBeDefined();
    expect(items.some((item) => item.role === "toggleDevTools")).toBe(false);

    (byLabel("Run high-fidelity sim")?.click as () => void)();
    const recent = (items.find((item) => item.label === "Open &Recent")?.submenu as { click: () => void }[])[0];
    recent?.click();
    expect(send.mock.calls).toEqual([
      [{ action: "help.tour" }],
      [{ action: "help.fullTour" }],
      [{ action: "help.shortcuts" }],
      [{ action: "desktop.sim" }],
      [{ action: "desktop.openRecent", arg: "C:\\robot-repo" }],
    ]);
  });
});
