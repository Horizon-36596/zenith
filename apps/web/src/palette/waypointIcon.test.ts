/**
 * Waypoints have their own glyph, the lucide Flag (issue #235, decision wp-icon), so the Marker tool's
 * MapPin is the only pin icon left and a student can tell which button makes waypoints.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("the waypoint icon", () => {
  it("uses MapPin only for the Marker tool", () => {
    const actions = source("../app/actions.ts");
    const uses = actions.split(/\r?\n/).filter((line) => /\bMapPin\w*\b/.test(line) && !/^\s*MapPin,$/.test(line));
    expect(uses).toEqual(["    icon: MapPin,"]);
    const marker = actions.indexOf('id: "tool.marker"');
    const at = actions.indexOf("icon: MapPin,");
    expect(marker).toBeGreaterThan(0);
    expect(at - marker).toBeGreaterThan(0);
    expect(at - marker).toBeLessThan(500);
    for (const file of ["../palette/CommandPalette.tsx", "../panels/Inspector.tsx", "../panels/WaypointSection.tsx", "../panels/Toolbar.tsx"]) {
      expect(source(file), file).not.toMatch(/\bMapPin\w*\b/);
    }
  });

  it("gives the palette's waypoint rows and the waypoint actions the Flag, and the Waypoints section none", () => {
    expect(source("../palette/CommandPalette.tsx")).toMatch(/group: "Waypoints",\s+icon: Flag,/);
    expect(source("../app/actions.ts")).toMatch(/id: "waypoint\.add"[\s\S]*?icon: Flag,/);
    // The Waypoints section's own title carries no glyph since issue #410: the count and the words say it.
    expect(source("../panels/WaypointSection.tsx")).not.toMatch(/icon=\{<Flag /);
  });
});
