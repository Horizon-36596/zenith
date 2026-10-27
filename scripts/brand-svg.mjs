// Builds the Zenith wordmark from the master mark and the "enith" outlines. Pure string work, no
// dependencies, so scripts/brand-icons.mjs writes the wordmarks with it and scripts/check-brand.mjs
// rebuilds them in memory to prove the files on disk are still exactly that.
//
// The Z is the master's route and waypoints, without the tile, scaled 20 times so the Z's outer height
// (y 14 to 50 on the master's 64 unit grid, stroke ends included) is 720 units, the cap height of the
// letters. The letters are "enith" in Jost 550, in the same units, moved right by 180 so the space
// between the Z and the e is what it was when the wordmark was first drawn.

const SCALE = 20;
const Z_LEFT = 10;
const Z_BOTTOM = 50;
const LETTER_SHIFT = 180;
const VIEW_BOX = { x: 0, y: -780, width: 3107, height: 804 };

/**
 * @param {string} master the master mark's SVG source
 * @param {string} letters the SVG source that holds the "enith" outline as its one path
 * @param {{ letters: string } | { mono: string }} colour either the letters' colour, with the Z in the
 *   master's own colours, or one colour for everything (the Z loses its gradients and sheen and keeps
 *   its shape, gap rings included)
 */
export function wordmarkSvg(master, letters, colour) {
  const prefix = (text) => text.replace(/id="zenith-/g, 'id="zenith-word-').replace(/url\(#zenith-/g, "url(#zenith-word-");
  const defs = master.match(/<defs>[\s\S]*<\/defs>/)?.[0];
  const tile = master.match(/<rect width="64"[^>]*\/>/)?.[0];
  const d = letters.match(/<path d="([^"]+)"/)?.[1];
  if (!defs || !tile || !d) throw new Error("brand-svg: the master or the letters file is not in the expected form");
  let route = master.slice(master.indexOf(tile) + tile.length, master.lastIndexOf("</svg>")).trim();
  if ("mono" in colour) {
    route = route
      .replace(/<path [^>]*stroke="url\(#zenith-h\d\)"[^>]*\/>/g, "")
      .replace(/stroke="url\(#zenith-s\d\)"/g, `stroke="${colour.mono}"`)
      .replace(/fill="url\(#zenith-d\d\)"/g, `fill="${colour.mono}"`);
  }
  const letterFill = "mono" in colour ? colour.mono : colour.letters;
  const tileGradient = /<linearGradient id="zenith-tile"[\s\S]*?<\/linearGradient>/;
  const height = 64;
  const width = Math.round((height * VIEW_BOX.width * 10) / VIEW_BOX.height) / 10;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW_BOX.x} ${VIEW_BOX.y} ${VIEW_BOX.width} ${VIEW_BOX.height}" width="${width}" height="${height}" role="img" aria-label="Zenith">`,
    "  <title>Zenith</title>",
    `  ${prefix(defs.replace(tileGradient, ""))}`,
    `  <g transform="matrix(${SCALE} 0 0 ${SCALE} ${-Z_LEFT * SCALE} ${-Z_BOTTOM * SCALE})">${prefix(route)}</g>`,
    `  <path transform="translate(${LETTER_SHIFT} 0)" d="${d}" fill="${letterFill}"/>`,
    "</svg>",
    "",
  ].join("\n");
}
