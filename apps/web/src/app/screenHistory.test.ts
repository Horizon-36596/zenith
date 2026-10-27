/**
 * Back and forward between screens (issue #83): the history behaves like a browser's, a place is
 * where the person is and never what they did, one press counts once however it arrives, and a step
 * back opens the auto before it moves any sheet.
 */
import { describe, expect, it } from "vitest";
import type { ReceivedShare } from "../cloud/types";
import {
  HISTORY_LIMIT,
  NOWHERE,
  NavInputGate,
  SAME_PRESS_MS,
  ScreenHistory,
  keyDirection,
  mouseButtonDirection,
  restorePlan,
  samePlace,
  type Place,
} from "./screenHistory";

const at = (patch: Partial<Place>): Place => ({ ...NOWHERE, file: "a.auto.json", ...patch });
const share = (id: string): ReceivedShare => ({ id }) as ReceivedShare;

describe("the screen history", () => {
  it("goes back and forward through the places visited, like a browser", () => {
    const history = new ScreenHistory<string>("editor", (a, b) => a === b);
    history.visit("account");
    history.visit("teams");
    history.visit("admin");
    expect(history.go("back")).toBe("teams");
    expect(history.go("back")).toBe("account");
    expect(history.current).toBe("account");
    expect(history.go("forward")).toBe("teams");
    expect(history.go("forward")).toBe("admin");
    expect(history.go("forward")).toBeNull();
    expect(history.current).toBe("admin");
  });

  it("stops at either end", () => {
    const history = new ScreenHistory<string>("editor", (a, b) => a === b);
    expect(history.canGo("back")).toBe(false);
    expect(history.go("back")).toBeNull();
    expect(history.canGo("forward")).toBe(false);
    expect(history.current).toBe("editor");
  });

  it("drops the places ahead when a new one is visited after going back", () => {
    const history = new ScreenHistory<string>("editor", (a, b) => a === b);
    history.visit("account");
    history.visit("teams");
    history.go("back");
    history.visit("library");
    expect(history.canGo("forward")).toBe(false);
    expect(history.go("back")).toBe("account");
    expect(history.size).toBe(3);
  });

  it("adds nothing for the place it is already on", () => {
    const history = new ScreenHistory<Place>(at({}), samePlace);
    history.visit(at({}));
    history.visit(at({ account: "teams" }));
    history.visit(at({ account: "teams" }));
    expect(history.size).toBe(2);
  });

  it("peeks without moving, and corrects the current place without adding one", () => {
    const history = new ScreenHistory<string>("editor", (a, b) => a === b);
    history.visit("account");
    expect(history.peek("back")).toBe("editor");
    expect(history.current).toBe("account");
    history.replace("teams");
    expect(history.size).toBe(2);
    expect(history.current).toBe("teams");
    history.reset("other project");
    expect(history.size).toBe(1);
    expect(history.canGo("back")).toBe(false);
  });

  it(`keeps the last ${String(HISTORY_LIMIT)} places`, () => {
    const history = new ScreenHistory<number>(0, (a, b) => a === b);
    for (let n = 1; n <= HISTORY_LIMIT + 20; n += 1) history.visit(n);
    expect(history.size).toBe(HISTORY_LIMIT);
    let oldest = history.current;
    while (history.canGo("back")) oldest = history.go("back") as number;
    expect(oldest).toBe(21);
  });
});

describe("a place", () => {
  it("is the open auto and what shows over it", () => {
    expect(samePlace(at({}), at({}))).toBe(true);
    expect(samePlace(at({}), at({ file: "b.auto.json" }))).toBe(false);
    expect(samePlace(at({}), at({ dialog: "shortcuts" }))).toBe(false);
    expect(samePlace(at({}), at({ account: "teams" }))).toBe(false);
    expect(samePlace(at({}), at({ settings: "account" }))).toBe(false);
    // Each Settings section is a screen of its own.
    expect(samePlace(at({ settings: "account" }), at({ settings: "general" }))).toBe(false);
    expect(samePlace(at({ settings: "general" }), at({ settings: "general" }))).toBe(true);
    expect(samePlace(at({}), at({ admin: true }))).toBe(false);
    expect(samePlace(at({}), at({ sharing: { sheet: "share" } }))).toBe(false);
  });

  it("tells sharing pages for different autos, and viewers of different shares, apart", () => {
    expect(samePlace(at({ sharing: { sheet: "sharing", autoId: "x" } }), at({ sharing: { sheet: "sharing", autoId: "x" } }))).toBe(true);
    expect(samePlace(at({ sharing: { sheet: "sharing", autoId: "x" } }), at({ sharing: { sheet: "sharing", autoId: null } }))).toBe(false);
    expect(samePlace(at({ sharing: { sheet: "viewer", share: share("1") } }), at({ sharing: { sheet: "viewer", share: share("1") } }))).toBe(true);
    expect(samePlace(at({ sharing: { sheet: "viewer", share: share("1") } }), at({ sharing: { sheet: "viewer", share: share("2") } }))).toBe(false);
  });
});

describe("going to a place", () => {
  it("changes only what differs", () => {
    expect(restorePlan(at({ account: "teams" }), at({ account: "library" }))).toEqual({
      openFile: null,
      dialog: null,
      sharing: null,
      account: { to: "library" },
      settings: null,
      admin: null,
    });
    expect(restorePlan(at({ settings: "general" }), at({ settings: "editor" }))).toEqual({
      openFile: null,
      dialog: null,
      sharing: null,
      account: null,
      settings: { to: "editor" },
      admin: null,
    });
    expect(restorePlan(at({ settings: "general" }), at({}))).toMatchObject({ settings: { to: null } });
    expect(restorePlan(at({ admin: true }), at({}))).toEqual({
      openFile: null,
      dialog: null,
      sharing: null,
      account: null,
      settings: null,
      admin: { to: false },
    });
  });

  it("opens the other auto, through the usual question, and closes what the place did not have open", () => {
    const plan = restorePlan(at({ file: "b.auto.json", dialog: "meta", sharing: { sheet: "share" } }), at({}));
    expect(plan.openFile).toBe("a.auto.json");
    expect(plan.dialog).toEqual({ to: null });
    expect(plan.sharing).toEqual({ to: null });
  });

  it("never closes the open auto for a place from before one was open", () => {
    expect(restorePlan(at({}), { ...NOWHERE }).openFile).toBeNull();
  });
});

describe("one press", () => {
  it("counts once when the side button arrives both as a mouse button and as the window's command", () => {
    const gate = new NavInputGate();
    expect(gate.accept("mouse", "back", 1000)).toBe(true);
    expect(gate.accept("appCommand", "back", 1010)).toBe(false);
    // The other order, on the next press.
    expect(gate.accept("appCommand", "forward", 3000)).toBe(true);
    expect(gate.accept("mouse", "forward", 3005)).toBe(false);
  });

  it("counts twice when the same button is pressed twice quickly", () => {
    const gate = new NavInputGate();
    expect(gate.accept("mouse", "back", 1000)).toBe(true);
    expect(gate.accept("mouse", "back", 1100)).toBe(true);
  });

  it("always counts Alt + arrows, which only ever arrive once", () => {
    const gate = new NavInputGate();
    expect(gate.accept("mouse", "back", 1000)).toBe(true);
    expect(gate.accept("key", "back", 1010)).toBe(true);
    // The key did not take the mouse's place, so the window's copy of the click is still caught.
    expect(gate.accept("appCommand", "back", 1020)).toBe(false);
  });

  it("counts a different direction, and a second source after the window has passed", () => {
    const gate = new NavInputGate();
    expect(gate.accept("mouse", "back", 1000)).toBe(true);
    expect(gate.accept("appCommand", "forward", 1010)).toBe(true);
    expect(gate.accept("mouse", "forward", 1010 + SAME_PRESS_MS)).toBe(true);
  });

  it("reads the side buttons as back and forward, and nothing else as either", () => {
    expect(mouseButtonDirection(3)).toBe("back");
    expect(mouseButtonDirection(4)).toBe("forward");
    for (const button of [0, 1, 2, 5]) expect(mouseButtonDirection(button)).toBeNull();
  });

  it("reads Alt + Left and Alt + Right, and no other chord", () => {
    const key = (k: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({
      key: k,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...mods,
    });
    expect(keyDirection(key("ArrowLeft", { altKey: true }))).toBe("back");
    expect(keyDirection(key("ArrowRight", { altKey: true }))).toBe("forward");
    expect(keyDirection(key("ArrowLeft"))).toBeNull();
    expect(keyDirection(key("ArrowUp", { altKey: true }))).toBeNull();
    expect(keyDirection(key("ArrowLeft", { altKey: true, shiftKey: true }))).toBeNull();
    expect(keyDirection(key("ArrowLeft", { altKey: true, ctrlKey: true }))).toBeNull();
  });
});
