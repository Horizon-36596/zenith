/**
 * Structural edit primitives for `*.auto.json`: pure functions
 * that take an `Auto` and return a new one, never mutate their input, and always leave the result
 * canonically valid — each one ends by parsing its candidate through `@horizon36596/zenith-schema`'s
 * `parseAuto`, which throws `EditError` with a helpful message if the edit would not validate.
 *
 * These are what `packages/mcp`'s `zenith.edit.*` tools call, and what an editor's drag/drop and
 * inspector panels would call too, so an agent or a human never hand-edits the JSON directly.
 */
export * from "./errors.js";
export * from "./ids.js";
export * from "./tree.js";
export * from "./finish.js";
export * from "./steps.js";
export * from "./groups.js";
export * from "./path.js";
export * from "./fields.js";
export * from "./command.js";
export * from "./timing.js";
export * from "./meta.js";
export * from "./template.js";
