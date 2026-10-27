/**
 * The Ledger (UI_GUIDE section 9.8): where the pieces are, drawn with the field's own piece glyphs.
 * A strip at the top follows the playhead with what the robot carries and what our hive's up cell
 * holds; below it, one line per step that moved pieces, each movement drawn the same way, from a
 * place to a place with the pieces on the arrow; last, where every piece lies at the end of the
 * auto. While the routine plays, the running step is marked, the steps still to come are drawn
 * hollow, and the list keeps the running step in view, as the step list does. Each line's hint is
 * the ledger's row in words.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Bot,
  CircleDashed,
  Flower2,
  Grid2x2,
  Hand,
  Hexagon,
  LogOut,
  MapPin,
  RotateCw,
  Sprout,
  SquareDashed,
  TableProperties,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { CountPart } from "../canvas/fieldCounts";
import { EmptyState, Unavailable } from "../components/primitives";
import { autoRobotOf, selectStep, useDerived, useEditor } from "../state/store";
import {
  ledgerEnd,
  ledgerNow,
  ledgerStepLines,
  type FlowEnd,
  type HiveNow,
  type LedgerFlow,
  type LedgerPlace,
} from "./ledgerView";
import { useLedgerPhases } from "./useLedgerPhases";
import styles from "./LedgerPanel.module.css";

/** After the person scrolls the Ledger, it stops following the running step for this long (issue #411). */
const FOLLOW_PAUSE_MS = 3000;
/** Scroll events this soon after the Ledger scrolled itself are its own. */
const OWN_SCROLL_MS = 400;

export function LedgerPanel() {
  const editor = useEditor();
  const { auto, selection, playing } = editor;
  const derived = useDerived();
  const run = derived.ledgerRun;
  const alliance = auto?.alliance ?? "RED";

  // The capacity of the robot the ledger was run with, the auto's own when it sets one (issue #403).
  const capacity = autoRobotOf(editor)?.capacity?.max ?? null;

  const lines = useMemo(
    () => (run === null ? [] : ledgerStepLines(run, derived.season, alliance)),
    [run, derived.season, alliance],
  );
  const end = useMemo(() => (run === null ? null : ledgerEnd(run, derived.season, alliance)), [run, derived.season, alliance]);
  const stepIds = useMemo(() => lines.map((line) => line.stepId), [lines]);
  const phases = useLedgerPhases(stepIds);
  const phaseOf = useMemo(() => {
    const byId = new Map(stepIds.map((id, index) => [id, phases[index] ?? "idle"]));
    return (stepId: string) => byId.get(stepId) ?? "idle";
  }, [stepIds, phases]);
  const now = useMemo(
    () => (run === null ? null : ledgerNow(run, derived.season, alliance, (stepId) => phaseOf(stepId) === "done")),
    [run, derived.season, alliance, phaseOf],
  );
  const running = lines.find((line) => phaseOf(line.stepId) === "now")?.stepId ?? null;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  // While playing, keep the running step in view below the strip, scrolling only the panel's own
  // body, unless the person scrolled it in the last few seconds: they are reading something else.
  const scrolledAt = useRef(Number.NEGATIVE_INFINITY);
  const ownScrollAt = useRef(Number.NEGATIVE_INFINITY);
  // The panel's body, set when the ledger itself is drawn: the early returns below draw no root, so
  // the scroll listener follows the element rather than any one render's state (issue #411).
  const [body, setBody] = useState<HTMLElement | null>(null);
  const setRoot = useCallback((element: HTMLDivElement | null) => {
    rootRef.current = element;
    setBody(element?.parentElement ?? null);
  }, []);
  useEffect(() => {
    if (body === null) return;
    const onScroll = (): void => {
      if (performance.now() - ownScrollAt.current > OWN_SCROLL_MS) scrolledAt.current = performance.now();
    };
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      body.removeEventListener("scroll", onScroll);
    };
  }, [body]);
  useEffect(() => {
    if (!playing || running === null) return;
    if (performance.now() - scrolledAt.current < FOLLOW_PAUSE_MS) return;
    const row = rowRefs.current.get(running);
    const body = rootRef.current?.parentElement;
    if (row === undefined || body === null || body === undefined) return;
    const top = body.getBoundingClientRect().top + (stripRef.current?.offsetHeight ?? 0);
    const bottom = body.getBoundingClientRect().bottom;
    const box = row.getBoundingClientRect();
    const by = box.top < top ? box.top - top : box.bottom > bottom ? box.bottom - bottom : 0;
    if (by === 0) return;
    ownScrollAt.current = performance.now();
    body.scrollTop += by;
  }, [playing, running]);

  if (auto === null) return null;
  if (derived.ledgerReason !== null) return <Unavailable>{derived.ledgerReason}</Unavailable>;
  if (derived.seasonWarnings.length > 0) {
    return <Unavailable>{derived.seasonWarnings.join(" ")}</Unavailable>;
  }
  if (run === null || run.rows.length === 0 || now === null || end === null) {
    return (
      <EmptyState
        icon={TableProperties}
        headline="Nothing in the ledger yet"
        line="It fills in as soon as a step collects or launches."
        testId="ledger-empty"
      />
    );
  }

  return (
    <div ref={setRoot} className={styles.ledger} data-testid="ledger" data-running={running ?? undefined}>
      <div ref={stripRef} className={styles.strip} data-testid="ledger-now">
        <div className={styles.stripCell}>
          <span className={styles.caption}>Robot</span>
          <Hopper hopper={now.hopper} parts={now.robot} held={now.held} capacity={capacity} />
        </div>
        {now.hive === null ? null : (
          <div className={styles.stripCell} data-testid="ledger-now-hive">
            <span className={styles.caption}>
              Hive{now.hive.tips > 0 ? ` · ${String(now.hive.tips)} ${now.hive.tips === 1 ? "tip" : "tips"}` : ""}
            </span>
            <HiveMeter hive={now.hive} />
          </div>
        )}
      </div>

      <ol className={styles.lines} aria-label="Steps that moved pieces">
        {lines.map((line) => {
          const phase = phaseOf(line.stepId);
          const over = capacity !== null && line.held > capacity;
          return (
            <li key={line.stepId}>
              <button
                type="button"
                ref={(element) => {
                  if (element === null) rowRefs.current.delete(line.stepId);
                  else rowRefs.current.set(line.stepId, element);
                }}
                className={styles.line}
                data-testid={`ledger-step-${line.stepId}`}
                data-phase={phase}
                data-selected={selection.stepId === line.stepId ? "true" : undefined}
                data-over={over ? "true" : undefined}
                data-collected={line.collected}
                data-launched={line.launched}
                title={line.words}
                onClick={() => {
                  selectStep(line.stepId);
                }}
              >
                <span className={styles.lineHead}>
                  <span className={styles.stepId}>{line.stepId}</span>
                  {over ? <span className={styles.error}>over capacity</span> : null}
                </span>
                <span className={styles.flows}>
                  {line.flows.map((flow, index) => (
                    <Flow key={index} flow={flow} hollow={phase === "next"} />
                  ))}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <section className={styles.end} aria-label="At the end of the auto" data-testid="ledger-end">
        <h3 className={styles.caption}>At the end</h3>
        <Place place={end.robot} testId="ledger-end-robot" empty="empty" />
        {end.hive === null ? null : (
          <div className={styles.place} title={end.hive.words} data-testid="ledger-end-hive">
            <span className={styles.placeLabel}>
              {end.hive.id}
              {end.hive.tips > 0 ? <span className={styles.lo}> · {end.hive.tips} {end.hive.tips === 1 ? "tip" : "tips"}</span> : null}
            </span>
            <span className={styles.counts}>
              {end.hive.upCell.length === 0 ? <span className={styles.lo}>empty</span> : <Counts parts={end.hive.upCell} />}
              {end.hive.needed === null ? null : (
                <span className={styles.lo}>{Math.max(0, end.hive.needed - end.hive.pollen)} to tip</span>
              )}
            </span>
          </div>
        )}
        {end.flowers.length === 0 ? null : (
          <div className={styles.place} data-testid="ledger-end-flowers">
            <span className={styles.placeLabel}>Flowers</span>
            <span className={styles.counts}>
              {end.flowers.map((flower) => (
                <span key={flower.id} className={styles.flower} title={flower.words} data-place={flower.id}>
                  {flower.count === 0 ? <span className={styles.lo}>0</span> : <Counts parts={flower.parts} />}
                </span>
              ))}
            </span>
          </div>
        )}
        {end.others.map((place) => (
          <Place key={place.id} place={place} testId={`ledger-end-${place.id}`} />
        ))}
      </section>
    </div>
  );
}

/** The robot's hopper: one slot per piece of its capacity, filled bottom first, then the counts. */
function Hopper({ hopper, parts, held, capacity }: { hopper: string[]; parts: CountPart[]; held: number; capacity: number | null }) {
  const slots = capacity === null ? [] : Array.from({ length: Math.max(capacity, held) }, (_, index) => hopper[index] ?? null);
  const kindOf = new Map(parts.map((part) => [part.kind, part]));
  return (
    <span className={styles.meter} aria-label={held === 0 ? "empty" : partsWords(parts)}>
      {slots.length === 0 ? null : (
        <span className={styles.slots} aria-hidden>
          {slots.map((kind, index) => {
            const part = kind === null ? undefined : kindOf.get(kind);
            return (
              <Glyph
                key={index}
                piece={part?.piece ?? "other"}
                alliance={part?.alliance ?? null}
                empty={kind === null}
                over={capacity !== null && index >= capacity}
                size={12}
              />
            );
          })}
        </span>
      )}
      {slots.length > 0 ? (
        <span className={styles.num} data-over={capacity !== null && held > capacity ? "true" : undefined}>
          {held}
          <span className={styles.lo}>/{capacity}</span>
        </span>
      ) : held === 0 ? (
        <span className={styles.lo}>empty</span>
      ) : (
        <Counts parts={parts} />
      )}
    </span>
  );
}

/**
 * Our hive's up cell: the nectar in it, then a slot for each pollen it takes to tip, filled by the
 * pollen there. Nectar is heavier, so with nectar in the cell there are fewer pollen slots: the
 * cell tips sooner.
 */
function HiveMeter({ hive }: { hive: HiveNow }) {
  const needed = hive.needed ?? 0;
  const nectar = hive.upCell.filter((part) => part.piece === "nectar");
  const others = hive.upCell.filter((part) => part.piece !== "nectar" && part.piece !== "pollen");
  const hint =
    hive.needed === null
      ? undefined
      : hive.nectar > 0 && hive.neededWithout !== null
        ? `${String(hive.nectar)} nectar in the up cell: it tips at ${String(hive.needed)} pollen instead of ${String(hive.neededWithout)}`
        : `The up cell tips at ${String(hive.needed)} pollen`;
  return (
    <span className={styles.meter} title={hint}>
      {nectar.map((part) => (
        <span key={part.kind} className={styles.slots} aria-label={`${String(part.count)} ${kindWords(part)}`}>
          {Array.from({ length: part.count }, (_, index) => (
            <Glyph key={index} piece="nectar" alliance={part.alliance} size={12} />
          ))}
        </span>
      ))}
      {needed > 0 ? (
        <span className={styles.slots} aria-hidden>
          {Array.from({ length: Math.max(needed, hive.pollen) }, (_, index) => (
            <Glyph key={index} piece="pollen" alliance={null} empty={index >= hive.pollen} size={12} />
          ))}
        </span>
      ) : null}
      <span className={styles.num}>
        {hive.pollen}
        {hive.needed === null ? null : <span className={styles.lo}>/{hive.needed}</span>}
      </span>
      {others.length > 0 ? <Counts parts={others} /> : null}
    </span>
  );
}

const PLACE_ICON: Readonly<Record<string, LucideIcon>> = {
  robot: Bot,
  partner: Users,
  hiveCell: Hexagon,
  flower: Flower2,
  garden: Sprout,
  floor: Grid2x2,
  loadingZone: SquareDashed,
  loose: CircleDashed,
  humanPlayer: Hand,
  offField: LogOut,
};

/** One end of a flow: the place's icon and its short name. */
function End({ end, label, tone }: { end: FlowEnd; label?: string; tone?: "warn" }) {
  const Icon = PLACE_ICON[end.kind] ?? MapPin;
  return (
    <span className={styles.end} data-place={end.id} data-tone={tone}>
      <Icon size={12} strokeWidth={1.75} aria-hidden className={styles.endIcon} />
      <span className={styles.endLabel}>{label ?? end.label}</span>
    </span>
  );
}

/**
 * One movement, always the same pattern: where the pieces came from, the pieces on an arrow, and
 * where they went. A tip starts at the hive with a tip mark; a missed shot ends at "missed".
 */
function Flow({ flow, hollow }: { flow: LedgerFlow; hollow: boolean }) {
  const words = `${flow.parts.map((part) => `${String(part.count)} ${kindWords(part)}`).join(", ") || "pieces"} from ${flow.from.label} to ${flow.to.label}`;
  return (
    <span className={styles.flow} data-flow={flow.what} title={flow.what === "tip" ? `${flow.from.label} tips: ${words}` : words}>
      {flow.what === "tip" ? (
        <span className={styles.end} data-place={flow.from.id}>
          <RotateCw size={12} strokeWidth={1.75} aria-hidden className={styles.endIcon} />
          <span className={styles.endLabel}>{flow.from.label} tips</span>
        </span>
      ) : (
        <End end={flow.from} />
      )}
      <span className={styles.move}>
        {flow.problem !== undefined && flow.problem !== null ? (
          <span className={styles.error}>not moved</span>
        ) : (
          <>
            <Counts parts={flow.parts} hollow={hollow} />
            <ArrowRight size={12} strokeWidth={1.75} aria-hidden className={styles.arrow} />
          </>
        )}
      </span>
      <End end={flow.to} tone={flow.what === "miss" && !hollow ? "warn" : undefined} />
    </span>
  );
}

function Place({ place, testId, empty }: { place: LedgerPlace; testId: string; empty?: string }) {
  return (
    <div className={styles.place} title={place.words} data-testid={testId} data-place={place.id}>
      <span className={styles.placeLabel}>{place.label}</span>
      <span className={styles.counts}>
        {place.count === 0 ? <span className={styles.lo}>{empty ?? "0"}</span> : <Counts parts={place.parts} />}
      </span>
    </div>
  );
}

/** "4 ●" per kind: the number, then the piece's glyph. */
function Counts({ parts, hollow = false }: { parts: readonly CountPart[]; hollow?: boolean }) {
  return (
    <>
      {parts.map((part) => (
        <span key={part.kind} className={styles.count} aria-label={`${String(part.count)} ${kindWords(part)}`}>
          <span className={styles.num} data-alliance={part.alliance ?? undefined}>
            {part.count}
          </span>
          <Glyph piece={part.piece} alliance={part.alliance} empty={hollow} size={10} />
        </span>
      ))}
    </>
  );
}

/**
 * A piece as the field draws it (`fieldCounts.ts`): pollen a gold disc, nectar a ring round a dot in
 * its alliance's colour, anything else a small square. Empty is a neutral outline, for a free slot in
 * the hopper or the hive, which either piece may fill, or a step the playhead has not reached, where
 * nectar keeps its dot so the two pieces still read apart.
 */
function Glyph({
  piece,
  alliance,
  empty = false,
  over = false,
  size,
}: {
  piece: CountPart["piece"];
  alliance: CountPart["alliance"];
  empty?: boolean;
  over?: boolean;
  size: number;
}) {
  const kind = piece === "nectar" ? (alliance === "BLUE" ? "nectarBlue" : "nectarRed") : piece;
  return (
    <svg
      className={styles.glyph}
      data-piece={kind}
      data-empty={empty ? "true" : undefined}
      data-over={over ? "true" : undefined}
      width={size}
      height={size}
      viewBox="0 0 10 10"
      aria-hidden
    >
      {piece === "other" && !empty ? (
        <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" className={styles.body} />
      ) : (
        <circle cx="5" cy="5" r="4" className={styles.body} />
      )}
      {piece === "nectar" ? <circle cx="5" cy="5" r="1.6" className={styles.dot} /> : null}
    </svg>
  );
}

function kindWords(part: CountPart): string {
  if (part.piece === "pollen") return "pollen";
  if (part.piece === "nectar") return part.alliance === null ? "nectar" : `${part.alliance === "RED" ? "red" : "blue"} nectar`;
  return part.kind;
}

const partsWords = (parts: readonly CountPart[]): string =>
  parts.map((part) => `${String(part.count)} ${kindWords(part)}`).join(", ");
