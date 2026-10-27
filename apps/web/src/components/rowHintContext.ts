/**
 * The id of a row hint's hidden text, for the controls of the row it belongs to (issue #237). A
 * `Tooltip` inside the row adds it to its trigger's `aria-describedby`, and a control with no
 * tooltip of its own can read it with `useRowHintId`.
 */
import { createContext, useContext } from "react";

export const RowHintContext = createContext<string | undefined>(undefined);

/** The id of the hint of the row this control sits in, if that row has one. */
export const useRowHintId = (): string | undefined => useContext(RowHintContext);

/** Joins `aria-describedby` ids, leaving out the missing ones and any repeat. */
export function joinIds(...ids: ReadonlyArray<string | undefined>): string | undefined {
  const all = ids.flatMap((id) => (id === undefined ? [] : id.split(/\s+/))).filter((id) => id !== "");
  const unique = [...new Set(all)];
  return unique.length === 0 ? undefined : unique.join(" ");
}
