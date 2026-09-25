/**
 * @horizon36596/zenith-seasons: the one place that turns a `field.json` into the `SeasonRules` the core runs
 * against, so the editor, the CLI and the MCP server never disagree about which season a project is.
 *
 * A season package implements `SeasonRules` and knows nothing about this registry; this package
 * knows the registry and nothing about a season's rules. Adding a season is one entry below plus a
 * dependency, and every consumer picks it up.
 */
import { noSeasonRules, type SeasonRules } from "@horizon36596/zenith-core";
import { loadSeason as loadBiobuzz, seasonId as biobuzzSeasonId } from "@horizon36596/zenith-season-biobuzz";
import type { Field } from "@horizon36596/zenith-schema";

/** One season the registry knows, as the open dialog and `zenith init` list them. */
export interface SeasonInfo {
  /** The `rules.plugin` value in `field.json` that selects it. */
  readonly plugin: string;
  /** The `season` value in `field.json`, which selects it too when `rules.plugin` is absent. */
  readonly season: string;
  /** What a human calls it. */
  readonly label: string;
}

/**
 * What `field.json` resolved to. `known` is false when the file names a plugin this build does not
 * carry: the rules are then `noSeasonRules`, the routine still plans and estimates, and every
 * season-dependent check and ledger row is simply absent. `warnings` says so in full sentences; it
 * is returned rather than logged, because core's callers include a pure CLI and an MCP server whose
 * stdout is a protocol.
 */
export interface SeasonResolution {
  readonly rules: SeasonRules;
  readonly known: boolean;
  /** The plugin name the field file asked for, or null when it names none. */
  readonly plugin: string | null;
  readonly warnings: readonly string[];
}

interface Registration extends SeasonInfo {
  readonly load: (field: Field) => SeasonRules;
}

const REGISTRY: readonly Registration[] = [
  {
    plugin: "season-biobuzz",
    season: biobuzzSeasonId,
    label: "BIOBUZZ presented by RTX (FTC 2026-27)",
    load: loadBiobuzz,
  },
];

/** Every season this build carries, for a picker or a `--help` listing. */
export const listSeasons = (): SeasonInfo[] =>
  REGISTRY.map(({ plugin, season, label }) => ({ plugin, season, label }));

/** The registration a field file selects, by `rules.plugin` first and by `season` second. */
function find(field: Field): Registration | null {
  const plugin = field.rules?.plugin;
  if (typeof plugin === "string" && plugin !== "") {
    return REGISTRY.find((entry) => entry.plugin === plugin) ?? null;
  }
  return REGISTRY.find((entry) => entry.season === field.season) ?? null;
}

/** The rules for a field file, with everything the caller needs to explain a miss. */
export function resolveSeason(field: Field): SeasonResolution {
  const plugin = field.rules?.plugin ?? null;
  const found = find(field);
  if (found !== null) {
    return { rules: found.load(field), known: true, plugin: found.plugin, warnings: [] };
  }
  const named =
    plugin === null
      ? `The field file "${field.name}" names no season plugin`
      : `The field file "${field.name}" names the season plugin "${plugin}", which this build does not carry`;
  return {
    rules: noSeasonRules,
    known: false,
    plugin,
    warnings: [
      `${named}, so the season checks and the ledger are inert. Known plugins: ${REGISTRY.map(
        (entry) => entry.plugin,
      ).join(", ")}.`,
    ],
  };
}

/** The rules for a field file. The common case, when the caller has nothing to say about a miss. */
export const seasonFor = (field: Field): SeasonRules => resolveSeason(field).rules;
