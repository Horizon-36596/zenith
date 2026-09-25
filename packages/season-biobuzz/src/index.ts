/**
 * @horizon36596/zenith-season-biobuzz: the BIOBUZZ field file and the `SeasonRules` plugin that reads it
 * (site/docs/seasons.md).
 *
 * The field file is the season: every rule below is derived from `field/biobuzz.field.json`, so a
 * team that corrects a measurement in their own copy gets the corrected rules with it.
 */
export const seasonId = "biobuzz";

export * from "./state.js";
export * from "./rules.js";
