/**
 * The auto-properties dialog's "Holds at start" (`Dialogs.tsx`): one number for the first element kind
 * the auto's `start.holds` names. The file may preload several kinds (the schema's holds is a record),
 * so an edit changes that one kind and keeps the others; writing `{ [kind]: count }` dropped every
 * other kind (issue #403).
 */
import type { Auto, Field } from "@horizon36596/zenith-schema";

/** The count the field shows: the first kind's, or null when the auto preloads nothing. */
export const firstHold = (auto: Auto): number | null => Object.values(auto.start.holds ?? {})[0] ?? null;

/**
 * The element kind the count is of: the first one the auto preloads, or, for an auto that preloads
 * nothing yet, the one kind of game piece the field file places (issue #502). Null
 * when the field names none, or several, so the dialog never guesses which.
 */
export function startHoldKind(auto: Auto, field: Field | null): string | null {
  const own = Object.keys(auto.start.holds ?? {})[0];
  if (own !== undefined) return own;
  // A game piece names the container it sits in, or null when it lies loose; a container is not one.
  const pieces = new Set(
    (field?.elements ?? []).filter((element) => element.kind !== "container" && "container" in element).map((element) => element.kind),
  );
  return pieces.size === 1 ? ([...pieces][0] as string) : null;
}

/**
 * The auto with its first preloaded kind set to `count` and every other kind kept. An auto with no
 * holds gets `{ [kind]: count }` for the `kind` given (`startHoldKind`); with none it is returned as
 * it is.
 */
export function setFirstHold(auto: Auto, count: number, kind: string | null = null): Auto {
  const holds = auto.start.holds;
  const first = Object.keys(holds ?? {})[0] ?? kind;
  if (first === null) return auto;
  return { ...auto, start: { ...auto.start, holds: { ...holds, [first]: count } } };
}
