/**
 * What the palette's search matches (QA-02): the label, the group, and the action's keywords, so
 * "tour" finds "Show me everything" and "copy" finds "Duplicate step". Case does not matter.
 */
export interface Searchable {
  label: string;
  group: string;
  keywords?: readonly string[];
}

export function matchesQuery(entry: Searchable, needle: string): boolean {
  const want = needle.trim().toLowerCase();
  if (want === "") return true;
  return (
    entry.label.toLowerCase().includes(want) ||
    entry.group.toLowerCase().includes(want) ||
    (entry.keywords ?? []).some((keyword) => keyword.toLowerCase().includes(want))
  );
}
