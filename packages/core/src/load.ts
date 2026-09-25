import {
  parseAuto,
  parseField,
  parseLink,
  parseRobot,
  parseWaypoints,
  type Auto,
  type Field,
  type Link,
  type Robot,
  type Waypoints,
} from "@horizon36596/zenith-schema";

/**
 * Parse, migrate and schema-validate. These throw SchemaError with every failing key named; the
 * CLI turns that into a SCHEMA finding. Reading the bytes is the caller's job: core has no Node
 * APIs (CLAUDE.md rule 1).
 */
export const loadAuto = (json: unknown): Auto => parseAuto(json);
export const loadRobot = (json: unknown): Robot => parseRobot(json);
export const loadField = (json: unknown): Field => parseField(json);
export const loadWaypoints = (json: unknown): Waypoints => parseWaypoints(json);
export const loadLink = (json: unknown): Link => parseLink(json);
