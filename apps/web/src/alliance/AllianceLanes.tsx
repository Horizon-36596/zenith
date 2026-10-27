/**
 * The alliance view's timeline lanes (spec 13 section 9): one lane per
 * visible partner under the routine's own track, on the same scale, with the partner's start offset
 * as a hollow block, each phase as a bar and each envelope window hatched. Every block has a
 * tooltip saying what it is and when; clicking one moves the scrubber to its start.
 */
import { Tooltip } from "../components/Tooltip";
import { seconds as fmtSeconds } from "../lib/format";
import { setPlayback } from "../state/store";
import { laneGeometry, partnerLane, type AlignedPartner, type LaneBlock } from "./model";
import styles from "./alliance.module.css";

const PHASE_WORD: Record<NonNullable<LaneBlock["label"]>, string> = {
  drive: "Driving",
  score: "Scoring",
  collect: "Collecting",
  wait: "Waiting",
  park: "Parking",
  other: "Working",
};

function blockLabel(block: LaneBlock): string {
  if (block.kind === "offset") return "Start offset";
  if (block.kind === "envelope") return "Envelope";
  return PHASE_WORD[block.label ?? "other"];
}

function blockHint(block: LaneBlock, name: string): string {
  const span = `${fmtSeconds(block.startS)} s to ${fmtSeconds(block.endS)} s on the alliance clock.`;
  if (block.kind === "offset") return `${name} waits at its start pose before its auto begins. ${span}`;
  if (block.kind === "envelope") {
    return `${name} has reserved an area on the field while its path is not known, hatched on the field while active. ${span}`;
  }
  const commands = block.commands === undefined ? "" : ` Commands: ${block.commands.join(", ")}.`;
  return `${name}'s share says it is ${blockLabel(block).toLowerCase()}. ${span}${commands}`;
}

export function AllianceLanes({ partners, scaleS }: { partners: readonly AlignedPartner[]; scaleS: number }) {
  if (partners.length === 0) return null;
  return (
    <div className={styles.lanes} data-testid="alliance-lanes">
      {partners.map(({ entry }) => (
        <div key={entry.id} className={styles.laneRow}>
          <Tooltip label={entry.label} hint="A partner in the alliance view: its phases, from what it shared.">
            <span className={styles.laneName} data-colour={String(entry.colour)} tabIndex={0}>
              {entry.label}
            </span>
          </Tooltip>
          <div className={styles.lane} data-testid={`alliance-lane-${entry.id}`}>
            {partnerLane(entry).map((block, index) => {
              const { leftPct, widthPct } = laneGeometry(block, scaleS);
              return (
                <Tooltip key={`${block.kind}-${String(index)}`} label={`${entry.label} · ${blockLabel(block)}`} hint={blockHint(block, entry.label)}>
                  <button
                    type="button"
                    className={styles.laneBlock}
                    data-kind={block.kind}
                    data-colour={String(entry.colour)}
                    data-commands={block.commands?.join(", ")}
                    aria-label={`${entry.label}: ${blockLabel(block)} from ${fmtSeconds(block.startS)} s`}
                    style={{ left: `${String(leftPct)}%`, width: `max(2px, ${String(widthPct)}%)` }}
                    onClick={() => {
                      setPlayback(block.startS);
                    }}
                  />
                </Tooltip>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The user's own start offset at the front of their track, as a hollow hatched block the width of
 * the wait, so the routine's bars start where the robot really starts on the alliance clock.
 */
export function OwnOffsetBlock({ offsetS, scaleS }: { offsetS: number; scaleS: number }) {
  if (offsetS <= 0 || !(scaleS > 0)) return null;
  return (
    <Tooltip
      label="Your start offset"
      hint={`Your robot waits ${fmtSeconds(offsetS)} s at its start pose before its auto begins. It is an alliance view setting and changes nothing in the auto.`}
    >
      <button
        type="button"
        className={styles.ownOffset}
        aria-label={`Your start offset, ${fmtSeconds(offsetS)} s`}
        data-testid="alliance-own-offset-block"
        style={{ flexGrow: Math.max(0.02, offsetS / scaleS) }}
        onClick={() => {
          setPlayback(0);
        }}
      />
    </Tooltip>
  );
}
