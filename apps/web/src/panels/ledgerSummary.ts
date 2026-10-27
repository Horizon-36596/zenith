/**
 * The folded ledger's one line (UI_GUIDE section 9.8, site/docs/editor.md "Ledger"): what the
 * routine collected and launched, such as "4 pollen in, 3 launched" (issue #316).
 */
import type { LedgerEntry, LedgerRun, SeasonRules } from "@horizon36596/zenith-core";

type Holds = Readonly<Record<string, number>>;

/**
 * What a collecting step put in the robot, by kind, from its holds before and after. The ledger
 * launches before it collects, so the change in the holds is what was collected less what was
 * launched: the launched pieces (no more than the robot held) are added back, first to the kinds
 * whose count fell, and any left to the one kind the robot held, or else to the kind that gained
 * most. A robot already full gains nothing, so it collected nothing.
 */
export function collectedByKind(before: Holds, entry: LedgerEntry): Map<string, number> {
  const after = entry.holds;
  const kinds = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const change = new Map(kinds.map((kind) => [kind, (after[kind] ?? 0) - (before[kind] ?? 0)]));
  const held = kinds.reduce((sum, kind) => sum + Math.max(0, before[kind] ?? 0), 0);
  let removed = Math.min(Math.max(0, entry.launched), held);
  const out = new Map<string, number>();
  for (const kind of kinds) {
    const fell = Math.min(removed, Math.max(0, -(change.get(kind) ?? 0)));
    removed -= fell;
    out.set(kind, (change.get(kind) ?? 0) + fell);
  }
  if (removed > 0) {
    const heldKinds = kinds.filter((kind) => (before[kind] ?? 0) > 0);
    const most = [...kinds].sort((a, b) => (out.get(b) ?? 0) - (out.get(a) ?? 0))[0];
    const kind = heldKinds.length === 1 ? heldKinds[0] : most;
    if (kind !== undefined) out.set(kind, (out.get(kind) ?? 0) + removed);
  }
  for (const [kind, count] of out) if (count <= 0) out.delete(kind);
  return out;
}

/**
 * Collected pieces are counted from what the robot's holds gained and named by kind ("pollen"). A
 * plugin that does not track holds counts them as "pieces" by the number each step asked for; the
 * two are never mixed. Launched pieces are a total.
 */
export function ledgerSummary(run: LedgerRun | null, season: Pick<SeasonRules, "holds">): string | undefined {
  if (run === null || run.rows.length === 0) return undefined;
  const collected = new Map<string, number>();
  let launched = 0;
  const add = (kind: string, count: number) => collected.set(kind, (collected.get(kind) ?? 0) + count);
  for (const entry of run.entries) {
    launched += entry.launched;
    if (entry.collected === null) continue;
    if (season.holds === undefined) add("pieces", entry.collected.count);
    else for (const [kind, count] of collectedByKind(season.holds(entry.before), entry)) add(kind, count);
  }
  const words = [...collected].filter(([, count]) => count > 0).map(([kind, count]) => `${String(count)} ${kind}`);
  // Short enough for the folded header beside "Ledger", which cuts off anything past about 27
  // characters: "in" rather than "collected".
  return `${words.length === 0 ? "0" : words.join(", ")} in, ${String(launched)} launched`;
}
