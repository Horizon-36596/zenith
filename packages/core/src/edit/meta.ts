import type { Auto } from "@horizon36596/zenith-schema";
import { finish } from "./finish.js";

/** Replaces the auto's `start` (pose and holds) outright. */
export function setStart(auto: Auto, start: Auto["start"]): Auto {
  return finish({ ...auto, start });
}

/** The auto-level fields `setMeta` may change. Passing `undefined` for a field clears it. */
export interface AutoMeta {
  title?: string;
  description?: string;
  authors?: string[];
}

/**
 * Merges `title`, `description` and `authors` into the auto. A field left out of `meta` is
 * unchanged; a field present with an explicit `undefined` is cleared.
 */
export function setMeta(auto: Auto, meta: AutoMeta): Auto {
  return finish({ ...auto, ...meta });
}
