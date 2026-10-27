import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@horizon36596/zenith-github";
import { runDeploy } from "../src/main/deploy.js";
import { GitHubAuth, type SecretBox } from "../src/main/github.js";
import { DESKTOP_KEYS } from "../../web/src/project/desktopKeys.js";
import { BridgeError } from "../src/main/confine.js";
import { RECENT_PATH_CHARS, acceptMenuKeys, menuTemplate, trimMiddle } from "../src/main/menu.js";
import { DEFAULT_MENU_KEYS, toAccelerator, type MenuKeys } from "../../web/src/project/menuKeys.js";
import { FULL_SIM_DEFAULT } from "../../web/src/state/fullSimSwitch.js";
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
    // Report a bug with the cloud off links the public new-issue page; the system browser opens it (#495).
    expect(isExternalWebUrl("https://github.com/Horizon-36596/zenith/issues/new")).toBe(true);
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
    // It has a codegen section, so the deploy writes the OpMode stubs.
    expect(preview.stubs).toBe(true);
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
    expect(preview.stubs).toBe(false);
    expect(preview.actions.filter((action) => action.path.endsWith(".java"))).toEqual([]);
    expect(preview.actions.length).toBeGreaterThan(0);
  });

  it("says it writes no stubs when there is no codegen section, even with a command library named (issue #156)", () => {
    patchLink(root, (link) => {
      delete link["codegen"];
    });
    const preview = runDeploy(root, true);
    expect(preview.commandLibrary).toBe("solverslib");
    expect(preview.stubs).toBe(false);
    expect(preview.actions.filter((action) => action.path.endsWith(".java"))).toEqual([]);
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
      if (token !== "good") throw new AuthError("GitHub rejected this token (401).", 401);
      return "me";
    });
    const auth = new GitHubAuth({ box: box(), slot: s, ghToken: async () => null, whoAmI });
    await expect(auth.setToken("bad")).rejects.toThrow(/did not accept/);
    expect(s.peek()).toBeNull();
    await auth.setToken("good");
    expect((await auth.forgetToken()).source).toBeNull();
    expect(s.peek()).toBeNull();
    await expect(auth.token()).rejects.toThrow("Sign in to GitHub first: Zenith needs it to open the pull request.");
  });

  it("says GitHub could not be reached, not that a good token was refused, when offline", async () => {
    const s = slot();
    // What fetch throws with no network: a TypeError, never an answer from GitHub.
    const whoAmI = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const auth = new GitHubAuth({ box: box(), slot: s, ghToken: async () => null, whoAmI });
    await expect(auth.setToken("ghp_test_good")).rejects.toThrow("Could not reach GitHub. Check the connection and try again.");
    expect(s.peek()).toBeNull();
    // GitHub's own answer that is not a refusal keeps its words.
    whoAmI.mockRejectedValueOnce(new AuthError("Could not validate the token: GitHub returned 500.", 500));
    await expect(auth.setToken("ghp_test_good")).rejects.toThrow(/GitHub returned 500/);
  });

  it("keeps a token for this run only when the sign-in asks not to remember it", async () => {
    const s = slot();
    const auth = new GitHubAuth({ box: box(), slot: s, ghToken: async () => null, whoAmI: async () => "me" });
    expect(await auth.setToken("ghp_test_once", false)).toMatchObject({ source: "session", login: "me" });
    expect(s.peek()).toBeNull();
    expect(await auth.token()).toBe("ghp_test_once");
  });

  it("says whether the GitHub CLI could sign in when there is no token", async () => {
    const auth = (state: "ready" | "signed-out" | "missing") =>
      new GitHubAuth({ box: box(), slot: slot(), ghToken: async () => null, whoAmI: async () => "me", ghStatus: async () => ({ state }) });
    expect((await auth("missing").status()).cli).toBe("missing");
    expect((await auth("signed-out").status()).cli).toBe("signed-out");
    // With a token there is nothing to say about the CLI.
    const signedIn = auth("missing");
    await signedIn.setToken("ghp_x");
    expect((await signedIn.status()).cli).toBeUndefined();
  });
});

describe("window bounds and the recent list", () => {
  const screen = [{ x: 0, y: 0, width: 1920, height: 1040 }];

  it("reopens where it was when that is still on a screen, and centred on the default size when not", () => {
    expect(initialBounds({ x: 100, y: 80, width: 1500, height: 900, maximized: true }, screen)).toEqual({
      bounds: { x: 100, y: 80, width: 1500, height: 900 },
      maximized: true,
      minSize: { width: 1024, height: 600 },
    });
    expect(initialBounds({ x: 4000, y: 80, width: 1500, height: 900, maximized: false }, screen).bounds).toEqual({
      x: 240,
      y: 70,
      width: 1440,
      height: 900,
    });
    expect(isVisible({ x: 1850, y: 1000, width: 800, height: 600 }, screen)).toBe(false);
  });

  // Work areas in DIPs with a 40 px taskbar at the bottom, as Windows reports them (sweep D5).
  const laptop1366 = { x: 0, y: 0, width: 1366, height: 728 }; // 1366 x 768 at 100%
  const laptop1080 = { x: 0, y: 0, width: 1280, height: 672 }; // 1920 x 1080 at 150%
  const laptop1200 = { x: 0, y: 0, width: 1280, height: 752 }; // 1920 x 1200 at 150%

  it("fits the first window inside a small laptop's work area, title bar and all", () => {
    for (const area of [laptop1366, laptop1080, laptop1200]) {
      const { bounds, maximized, minSize } = initialBounds(null, [area], area);
      expect(bounds).toEqual(area);
      expect(maximized).toBe(false);
      expect(minSize).toEqual({ width: 1024, height: 600 });
      expect(minSize.width).toBeLessThanOrEqual(area.width);
      expect(minSize.height).toBeLessThanOrEqual(area.height);
    }
  });

  it("centres the default size on the primary display, not the first one listed", () => {
    const left = { x: -1920, y: 0, width: 1920, height: 1040 };
    const primary = { x: 0, y: 0, width: 1920, height: 1040 };
    expect(initialBounds(null, [left, primary], primary).bounds).toEqual({ x: 240, y: 70, width: 1440, height: 900 });
  });

  it("shrinks and moves a restored window that no longer fits, so its title bar stays on screen", () => {
    // Saved on a 1080p screen at 100%, reopened at 150%: the window is bigger than the work area.
    expect(initialBounds({ x: 240, y: 70, width: 1440, height: 900, maximized: false }, [laptop1080], laptop1080).bounds).toEqual(laptop1080);
    // Hanging off the bottom right: moved back on whole.
    expect(initialBounds({ x: 900, y: 500, width: 1100, height: 650, maximized: false }, [laptop1366], laptop1366).bounds).toEqual({
      x: 266,
      y: 78,
      width: 1100,
      height: 650,
    });
    // Title bar above the top edge: moved down to it.
    expect(initialBounds({ x: 100, y: -300, width: 1100, height: 650, maximized: true }, [laptop1366], laptop1366)).toEqual({
      bounds: { x: 100, y: 0, width: 1100, height: 650 },
      maximized: true,
      minSize: { width: 1024, height: 600 },
    });
  });

  it("fits a restored window to the monitor it is mostly on", () => {
    const primary = { x: 0, y: 0, width: 1920, height: 1040 };
    const second = { x: 1920, y: 0, width: 1280, height: 672 };
    expect(initialBounds({ x: 2000, y: 100, width: 1440, height: 900, maximized: false }, [primary, second], primary).bounds).toEqual(second);
  });

  it("puts a window saved on an unplugged monitor back on the primary one", () => {
    expect(initialBounds({ x: -1800, y: 100, width: 1440, height: 900, maximized: true }, [laptop1080], laptop1080)).toEqual({
      bounds: laptop1080,
      maximized: false,
      minSize: { width: 1024, height: 600 },
    });
  });

  it("never asks for a minimum larger than the screen", () => {
    const tiny = { x: 0, y: 0, width: 800, height: 560 };
    const { bounds, minSize } = initialBounds(null, [tiny], tiny);
    expect(bounds).toEqual(tiny);
    expect(minSize).toEqual({ width: 800, height: 560 });
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
  it("starts the Help menu with Documentation, which runs the web build's help.docs action", () => {
    const send = vi.fn();
    const template = menuTemplate([], { send, about: vi.fn(), quit: vi.fn(), isDev: false, fullSim: FULL_SIM_DEFAULT, clearRecent: vi.fn() });
    const help = template.find((menu) => menu.label?.replace("&", "") === "Help");
    const first = (Array.isArray(help?.submenu) ? help.submenu : [])[0];
    expect(first?.label?.replace("&", "")).toBe("Documentation");
    (first?.click as () => void)();
    expect(send.mock.calls).toEqual([[{ action: "help.docs" }]]);
  });

  it("has the owner's items, in the palette's words, and sends web action ids for them", () => {
    const send = vi.fn();
    const clearRecent = vi.fn();
    const template = menuTemplate([{ root: "C:\\robot-repo", name: "robot-repo", openedAt: 1 }], {
      send,
      about: vi.fn(),
      quit: vi.fn(),
      isDev: false,
      fullSim: true,
      clearRecent,
    });
    const labels = template.map((menu) => menu.label?.replace("&", ""));
    expect(labels).toEqual(["File", "Edit", "View", "Robot", "Help"]);
    const items = template.flatMap((menu) => (Array.isArray(menu.submenu) ? menu.submenu : []));
    const byLabel = (label: string) => items.find((item) => item.label?.replace(/&/g, "") === label);
    expect(byLabel("Open a folder…")).toBeDefined();
    // Ctrl+O is the page's Open project dialog, so the menu shows it there and not on the folder picker (sweep D6).
    expect(byLabel("Open a folder…")?.accelerator).toBeUndefined();
    expect(byLabel("Open project…")?.accelerator).toBe("CmdOrCtrl+O");
    expect(byLabel("Open project…")?.registerAccelerator).toBe(false);
    // Until the page sends the person's keys, the Robot menu has the web build's defaults (sweep D7).
    expect(byLabel("Run high-fidelity sim")?.accelerator).toBe(toAccelerator(DESKTOP_KEYS["desktop.sim"]));
    expect(byLabel("Run high-fidelity sim")?.accelerator).toBe("CmdOrCtrl+F5");
    expect(byLabel("Deploy autos into the robot repo")?.accelerator).toBe("CmdOrCtrl+Shift+D");
    expect(byLabel("Commit, push and open a pull request…")?.accelerator).toBe("CmdOrCtrl+Shift+G");
    expect(byLabel("Save")?.registerAccelerator).toBe(false);
    expect(byLabel("Take the tour")).toBeDefined();
    (byLabel("Take the tour")?.click as () => void)();
    (byLabel("Take the full tour")?.click as () => void)();
    expect(byLabel("Search actions")).toBeDefined();
    (byLabel("Keyboard shortcuts")?.click as () => void)();
    expect(byLabel("Keyboard shortcuts")).toBeDefined();
    expect(byLabel("About Zenith")).toBeDefined();
    expect(items.some((item) => item.role === "toggleDevTools")).toBe(false);

    // Zoom In answers Ctrl+= (no Shift on a US keyboard), Ctrl+Shift+= and the keypad, with one visible entry each (#114).
    const zoom = (role: string) => items.filter((item) => item.role === role);
    expect(zoom("zoomIn").map((item) => [item.accelerator, item.visible !== false])).toEqual([
      ["CmdOrCtrl+=", true],
      ["CmdOrCtrl+Plus", false],
      ["CmdOrCtrl+numadd", false],
    ]);
    expect(zoom("zoomOut").map((item) => [item.accelerator, item.visible !== false])).toEqual([
      [undefined, true],
      ["CmdOrCtrl+numsub", false],
    ]);
    expect(zoom("resetZoom")).toHaveLength(1);
    // Electron's own items carry the app's sentence case and an access key, not Electron's Title Case.
    expect(["cut", "copy", "paste", "selectAll", "resetZoom", "togglefullscreen"].map((role) => items.find((item) => item.role === role)?.label)).toEqual([
      "Cu&t",
      "&Copy",
      "&Paste",
      "Select &all",
      "Reset &zoom",
      "&Full screen",
    ]);

    (byLabel("Run high-fidelity sim")?.click as () => void)();
    (byLabel("Open project…")?.click as () => void)();
    (byLabel("Open a folder…")?.click as () => void)();
    const recentItems = items.find((item) => item.label === "Open &recent")?.submenu as { label?: string; click: () => void }[];
    recentItems[0]?.click();
    // The list ends with Clear recent, which the main process handles itself.
    expect(recentItems.at(-1)?.label).toBe("&Clear recent");
    recentItems.at(-1)?.click();
    expect(clearRecent).toHaveBeenCalledTimes(1);
    expect(send.mock.calls).toEqual([
      [{ action: "help.tour" }],
      [{ action: "help.fullTour" }],
      [{ action: "help.shortcuts" }],
      [{ action: "desktop.sim" }],
      [{ action: "project.open" }],
      [{ action: "project.openFolder" }],
      [{ action: "desktop.openRecent", arg: "C:\\robot-repo" }],
    ]);
  });

  it("offers the high-fidelity sim from the Full sim switch, and leaves it out when the switch is off (issue #207)", () => {
    // The switch is on again since 2026-10-14, and the app builds its menu from it.
    expect(FULL_SIM_DEFAULT).toBe(true);
    const robotLabels = (fullSim: boolean) => {
      const template = menuTemplate([], { send: vi.fn(), about: vi.fn(), quit: vi.fn(), isDev: false, fullSim, clearRecent: vi.fn() });
      const robot = template.find((menu) => menu.label === "&Robot");
      return (robot?.submenu as { label?: string; type?: string }[]).map((item) => item.label?.replace(/&/g, "") ?? item.type);
    };
    expect(robotLabels(FULL_SIM_DEFAULT)).toEqual([
      "Run high-fidelity sim",
      "Cancel the sim",
      "separator",
      "Deploy autos into the robot repo",
      "separator",
      "Commit, push and open a pull request…",
    ]);
    expect(robotLabels(false)).toEqual(["Deploy autos into the robot repo", "separator", "Commit, push and open a pull request…"]);
  });
});

describe("the native menu follows the keys the page sends (zenith:menu-keys)", () => {
  // The Full sim switch on, so the Robot menu has every item the keys can move (issue #207).
  const handlers = () => ({ send: vi.fn(), about: vi.fn(), quit: vi.fn(), isDev: false, fullSim: true, clearRecent: vi.fn() });
  const itemsOf = (template: ReturnType<typeof menuTemplate>) => template.flatMap((menu) => (Array.isArray(menu.submenu) ? menu.submenu : []));
  const named = (items: ReturnType<typeof itemsOf>, label: string) => items.find((item) => item.label?.replace(/&/g, "") === label);
  /** What the main process does with a message: validate it, then rebuild the menu from what it accepted. */
  const rebuild = (payload: unknown) => {
    let accepted: MenuKeys = DEFAULT_MENU_KEYS;
    acceptMenuKeys(payload, (keys) => {
      accepted = keys;
    });
    return menuTemplate([], handlers(), accepted);
  };
  const robotMenu = (template: ReturnType<typeof menuTemplate>) => template.find((menu) => menu.label?.replace("&", "") === "Robot");

  it("builds the same menu as before when the page has said nothing", () => {
    expect(menuTemplate([], handlers(), DEFAULT_MENU_KEYS).map((menu) => menu.label)).toEqual(menuTemplate([], handlers()).map((menu) => menu.label));
    expect(itemsOf(menuTemplate([], handlers(), DEFAULT_MENU_KEYS)).map((item) => item.accelerator)).toEqual(
      itemsOf(menuTemplate([], handlers())).map((item) => item.accelerator),
    );
  });

  it("shows a custom Save key on the File menu's Save item, which the page still handles", () => {
    const items = itemsOf(rebuild({ keys: { "run.save": "Ctrl Shift E" }, hidden: [] }));
    expect(named(items, "Save")?.accelerator).toBe("CmdOrCtrl+Shift+E");
    expect(named(items, "Save")?.registerAccelerator).toBe(false);
    // The other items keep their defaults, and a key taken away shows none.
    expect(named(items, "Open project…")?.accelerator).toBe("CmdOrCtrl+O");
    expect(named(itemsOf(rebuild({ keys: { "run.save": null }, hidden: [] })), "Save")?.accelerator).toBeUndefined();
  });

  it("refuses an unknown id, a reserved accelerator, a key the menu cannot draw and a shared key, and applies nothing", () => {
    const apply = vi.fn();
    for (const payload of [
      { keys: { "edit.paste": "Ctrl G" }, hidden: [] },
      { keys: { "desktop.sim": "Ctrl W" }, hidden: [] },
      { keys: { "run.save": "Ctrl C" }, hidden: [] },
      { keys: { "desktop.sim": "F10" }, hidden: [] },
      { keys: { "desktop.sim": "Alt F4" }, hidden: [] },
      { keys: { "desktop.deploy": "S" }, hidden: [] },
      { keys: { "run.save": "Hyper+S" }, hidden: [] },
      { keys: { "run.save": "Ctrl Shift F5", "desktop.sim": "Ctrl Shift F5" }, hidden: [] },
      { keys: { "run.save": 5 }, hidden: [] },
      { keys: {}, hidden: ["help.docs"] },
      { keys: [], hidden: [] },
      "Ctrl S",
      null,
    ]) {
      // A refusal, with its reason, not any error: a crash in the check would throw something else.
      let refused: unknown;
      try {
        acceptMenuKeys(payload, apply);
      } catch (error) {
        refused = error;
      }
      expect(refused, JSON.stringify(payload)).toBeInstanceOf(BridgeError);
      expect((refused as Error).message, JSON.stringify(payload)).toMatch(/^Refused the menu keys\. \S/);
    }
    expect(apply).not.toHaveBeenCalled();
  });

  it("hides a page-handled File, Edit or View item without letting the menu register its key", () => {
    const items = itemsOf(rebuild({ keys: {}, hidden: ["run.save", "project.open", "edit.undo", "view.palette"] }));
    for (const label of ["Save", "Open project…", "Undo", "Search actions"]) {
      const item = named(items, label);
      expect(item?.visible, label).toBe(false);
      expect(item?.registerAccelerator, label).toBe(false);
    }
    // An item left on show stays visible.
    expect(named(items, "Redo")?.visible).not.toBe(false);
    expect(named(items, "Redo")?.registerAccelerator).toBe(false);
  });

  it("registers a rebound Simulate key, so the Robot menu runs on Ctrl Shift F5 and not on Ctrl F5", () => {
    const send = vi.fn();
    const template = menuTemplate([], { send, about: vi.fn(), quit: vi.fn(), isDev: false, fullSim: true, clearRecent: vi.fn() }, (() => {
      let accepted: MenuKeys = DEFAULT_MENU_KEYS;
      acceptMenuKeys({ keys: { "desktop.sim": "Ctrl Shift F5" }, hidden: [] }, (keys) => {
        accepted = keys;
      });
      return accepted;
    })());
    const items = itemsOf(template);
    const sim = named(items, "Run high-fidelity sim");
    expect(sim?.accelerator).toBe("CmdOrCtrl+Shift+F5");
    expect(sim?.registerAccelerator).not.toBe(false);
    expect(items.some((item) => item.accelerator === "CmdOrCtrl+F5")).toBe(false);
    (sim?.click as () => void)();
    expect(send).toHaveBeenCalledWith({ action: "desktop.sim" });
  });

  it("leaves out the Robot item of a hidden feature with its accelerator, and the Robot menu when none is left", () => {
    const submenu = (hidden: string[]) => {
      const robot = robotMenu(rebuild({ keys: {}, hidden }));
      return Array.isArray(robot?.submenu) ? robot.submenu : [];
    };
    const noSim = submenu(["desktop.sim"]);
    expect(noSim.some((item) => item.label?.includes("high-fidelity sim"))).toBe(false);
    expect(noSim.some((item) => item.label?.includes("Cancel the sim"))).toBe(false);
    expect(noSim.some((item) => item.accelerator === "CmdOrCtrl+F5")).toBe(false);
    expect(noSim.some((item) => item.accelerator === "CmdOrCtrl+Shift+D")).toBe(true);
    // No separator is left at an end of the menu or twice in a row.
    expect(noSim[0]?.type).not.toBe("separator");
    expect(noSim.at(-1)?.type).not.toBe("separator");
    expect(robotMenu(rebuild({ keys: {}, hidden: ["desktop.sim", "desktop.deploy", "desktop.git"] }))).toBeUndefined();
  });

  it("keeps Exit, the zoom items and the rest as they were", () => {
    const items = itemsOf(rebuild({ keys: { "run.save": "Ctrl Shift E" }, hidden: ["desktop.git"] }));
    expect(items.filter((item) => item.role === "zoomIn")).toHaveLength(3);
    expect(named(items, "Exit")?.accelerator).toBe("Alt+F4");
    expect(items.some((item) => item.accelerator === "F10")).toBe(false);
  });
});

describe("trimMiddle", () => {
  it("keeps both ends of a long path, and leaves a short one alone", () => {
    expect(trimMiddle("C:\\robot", RECENT_PATH_CHARS)).toBe("C:\\robot");
    const long = `C:\\workspace\\member\\${"deep\\".repeat(20)}robot`;
    const short = trimMiddle(long, RECENT_PATH_CHARS);
    expect(short).toHaveLength(RECENT_PATH_CHARS);
    expect(short.startsWith("C:\\workspace\\member")).toBe(true);
    expect(short.endsWith("robot")).toBe(true);
    expect(short).toContain("…");
  });
});
