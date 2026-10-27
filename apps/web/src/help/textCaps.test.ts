import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../app/actions";
import { ACTION_DOES_CAP, TOOLTIP_HINT_CAP, actionDoesLiterals, hintLiterals, overCap } from "./textCaps";

/**
 * The second line of a tooltip stays short (issue #247): an action's `does` line is at most 100
 * characters, and a `hint=` literal on a Tooltip at most 160.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

const files = (extension: string): Array<{ path: string; text: string }> =>
  readdirSync(SRC, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension) && !entry.name.includes(".test."))
    .map((entry) => {
      const full = join(entry.parentPath, entry.name);
      return { path: relative(SRC, full).split(sep).join("/"), text: readFileSync(full, "utf8") };
    });

describe("the action 'does' cap", () => {
  it("keeps every action's line to 100 characters", () => {
    const long = ACTIONS.filter((action) => action.does.length > ACTION_DOES_CAP).map(
      (action) => `${action.id}: ${String(action.does.length)} characters`,
    );
    expect(long).toEqual([]);
  });

  it("keeps every literal 'does' in the files that define actions to 100 characters, the host and desktop ones too", () => {
    const defining = ["app/actions.ts", "account/actions.ts", "project/desktopActions.ts"];
    const found = files(".ts")
      .filter((file) => defining.includes(file.path))
      .flatMap((file) => actionDoesLiterals(file.path, file.text));
    // Every action has one, and the scan reads the wrapped ones.
    expect(found.length).toBeGreaterThan(60);
    expect(overCap(found, ACTION_DOES_CAP)).toEqual([]);
  });

  it("finds a long line in a fixture, wrapped or in a template", () => {
    const long = "x".repeat(101);
    expect(overCap(actionDoesLiterals("f.ts", `{ does: "${long}", icon: A }`), ACTION_DOES_CAP)).toHaveLength(1);
    expect(overCap(actionDoesLiterals("f.ts", `{\n    does:\n      "${long}",\n}`), ACTION_DOES_CAP)).toHaveLength(1);
    expect(overCap(actionDoesLiterals("f.ts", "{ does: `Send it to ${name}. " + "x".repeat(80) + "`, }"), ACTION_DOES_CAP)).toHaveLength(1);
    expect(overCap(actionDoesLiterals("f.ts", `{ does: "${"x".repeat(100)}" }`), ACTION_DOES_CAP)).toEqual([]);
  });

  it("finds a long line in a 'doesFor' function, in either branch of a ternary", () => {
    const long = "x".repeat(101);
    const problems = (text: string) => overCap(actionDoesLiterals("f.ts", text), ACTION_DOES_CAP);
    expect(problems(`{ doesFor: (s) => (cond(s) ? "${long}" : undefined), icon: A }`)).toHaveLength(1);
    expect(problems(`{ doesFor: (s) =>\n  cond(s)\n    ? "Short."\n    : "${long}",\n}`)).toHaveLength(1);
    expect(problems("{ doesFor: (s) => `Sends it to ${s.name}. " + long + "` }")).toHaveLength(1);
    expect(problems(`{ doesFor: (s) => (cond(s) ? "${"x".repeat(100)}" : undefined), does: "Short." }`)).toEqual([]);
    expect(problems(`{ doesFor: undefined, does: "Short." }`)).toEqual([]);
  });

  it("measures the Save action's 'doesFor' text in the real source", () => {
    const actions = files(".ts").find((file) => file.path === "app/actions.ts")!;
    expect(actionDoesLiterals(actions.path, actions.text).some((entry) => entry.value.startsWith("Read-only project"))).toBe(true);
  });
});

describe("the Tooltip hint cap", () => {
  it("keeps every literal hint in a component to 160 characters", () => {
    const found = files(".tsx").flatMap((file) => hintLiterals(file.path, file.text));
    expect(found.length).toBeGreaterThan(100);
    expect(overCap(found, TOOLTIP_HINT_CAP)).toEqual([]);
  });

  it("finds a long hint in a fixture, in a string, a ternary or a template", () => {
    const long = "y".repeat(161);
    const problems = (text: string) => overCap(hintLiterals("F.tsx", text), TOOLTIP_HINT_CAP);
    expect(problems(`<Tooltip label="A" hint="${long}">`)).toHaveLength(1);
    expect(problems(`<Tooltip label="A" hint={ok ? "Short." : "${long}"}>`)).toHaveLength(1);
    expect(problems("<Tooltip label=\"A\" hint={`Sends it to ${who}. " + long + "`}>")).toHaveLength(1);
    expect(problems(`<Tooltip label="A" hint="${"y".repeat(160)}">`)).toEqual([]);
    expect(problems("<Tooltip label=\"A\" hint={HINTS.save}>")).toEqual([]);
  });
});
