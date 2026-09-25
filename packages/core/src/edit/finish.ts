import { parseAuto, SchemaError, type Auto } from "@horizon36596/zenith-schema";
import { EditError } from "./errors.js";
import { duplicateIds } from "./ids.js";

/**
 * Every primitive in this directory ends by calling this on the candidate document it built.
 * Parsing through the zod schema is what "keep canonical validity" means in practice: the schema
 * both validates the result and produces a fresh object tree, so a primitive can build its
 * candidate with ordinary object spreads without worrying about mutating anything the caller
 * still holds a reference to, and a mutation that would leave the file invalid throws here with
 * every failing key named, instead of writing a broken file.
 *
 * Unique effective ids are part of that validity, and the schema cannot express them: every
 * primitive addresses a step by its id and `updateStep` stops at the first match, so a document
 * with the same id twice would have its later steps silently unreachable.
 */
export function finish(candidate: unknown): Auto {
  try {
    const auto = parseAuto(candidate);
    const repeated = duplicateIds(auto.steps);
    if (repeated.length > 0) {
      throw new EditError(
        `This edit would leave two steps sharing the id ${repeated
          .map((id) => JSON.stringify(id))
          .join(", ")}, and every step is addressed by its id.`,
      );
    }
    return auto;
  } catch (error) {
    if (error instanceof SchemaError) {
      throw new EditError(
        `This edit would leave the auto invalid:\n  ${error.issues
          .map((issue) => `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`)
          .join("\n  ")}`,
      );
    }
    throw error;
  }
}
