import { parseAuto, parseField, SCHEMA_ID, type Field } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { plan } from "./plan.js";
import { render } from "./render.js";
import { resolve } from "./resolve.js";
import { testField, testRobot } from "./testing/fixtures.js";

/** Item 1's field image, as `core.render` draws it for a pull request. */

const auto = parseAuto({
  $schema: SCHEMA_ID.auto,
  formatVersion: 2,
  name: "image-fixture",
  alliance: "RED",
  start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
  steps: [{ id: "hold", kind: "wait", seconds: 1 }],
});

const withImage = (image: unknown): Field => parseField({ ...testField, formatVersion: 2, image });
const svgOf = (field: Field, fieldImage?: { href: string; widthPx?: number; heightPx?: number }): string =>
  render(plan(resolve(auto), testRobot, field), null, [], [], {
    widthPx: 720,
    ...(fieldImage === undefined ? {} : { fieldImage }),
  });

describe("render: the field image", () => {
  const fullBleed = withImage({ src: "f.webp", credit: "c", pxBoundsIn: "fullBleed", rotationDeg: 90 });

  it("draws vector alone when the caller hands over no picture", () => {
    expect(svgOf(fullBleed)).not.toContain("<image");
  });

  it("embeds a full-bleed picture over the field, turned clockwise, and drops the grid under it", () => {
    const svg = svgOf(fullBleed, { href: "data:image/webp;base64,AAAA" });
    // The field is 720 px square at x 16..736; its centre is where the turn is made.
    expect(svg).toMatch(/<image href="data:image\/webp;base64,AAAA" x="16" y="\d+(\.\d+)?" width="720" height="720" preserveAspectRatio="none" transform="rotate\(90 376 \d+(\.\d+)?\)"\/>/);
    expect(svg.indexOf("<image")).toBeLessThan(svg.indexOf("<rect x="));
    const vectorOnly = svgOf(fullBleed);
    expect((svg.match(/<line /g) ?? []).length).toBeLessThan((vectorOnly.match(/<line /g) ?? []).length);
  });

  it("crops to a pixel box when it knows the stored image's size, and not otherwise", () => {
    const cropped = withImage({
      src: "f.png",
      credit: "c",
      pxBoundsIn: { left: 10, top: 20, right: 1010, bottom: 1020 },
    });
    const svg = svgOf(cropped, { href: "f.png", widthPx: 1100, heightPx: 1100 });
    expect(svg).toContain('viewBox="10 20 1000 1000"');
    expect(svg).toContain('<image href="f.png" width="1100" height="1100"/>');
    expect(svgOf(cropped, { href: "f.png" })).not.toContain("<image");
  });

  it("draws nothing extra for a field with no image", () => {
    expect(svgOf(testField, { href: "x.png" })).not.toContain("<image");
  });
});
