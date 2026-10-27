/**
 * Whether rows draw their brief inline (issue #238): the Descriptions option of Settings, Editor,
 * Appearance, "compact" (Labels only) or "full" (With descriptions).
 */
import { useSelector, type State } from "../../state/store";
import type { Descriptions } from "../../state/prefs";
import { DESCRIPTIONS, descriptionHint, type Description, type DescriptionId } from "./index";

const selectDescriptions = (state: State): Descriptions => state.prefs.descriptions;

export const useDescriptions = (): Descriptions => useSelector(selectDescriptions);

/**
 * What a row with `describe={id}` draws: its brief, only in "full", and its hint, the brief and the
 * more together, in both modes. Both are undefined without an id. With `always`, the brief shows in
 * both modes: a row that keeps its line in Labels only (decision desc-default (b)).
 */
export function useDescribed(
  id: DescriptionId | undefined,
  always = false,
): { brief: string | undefined; hint: string | undefined } {
  const mode = useDescriptions();
  if (id === undefined) return { brief: undefined, hint: undefined };
  const entry: Description = DESCRIPTIONS[id];
  return { brief: always || mode === "full" ? entry.brief : undefined, hint: descriptionHint(entry) };
}
