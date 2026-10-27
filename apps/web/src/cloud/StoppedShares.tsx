/**
 * The Sharing page's notice of the shares the team made that stopped when its key changed, each with
 * "Share again". It holds no state: the page says which to list and why one cannot be shared again
 * now, and "Share again" opens the share dialog with the stopped share's settings.
 */
import { TriangleAlert } from "lucide-react";
import { shareDateWords } from "@horizon36596/zenith-core";
import { SheetButton } from "./controls";
import { utcOffsetAt } from "./shareModel";
import { STOPPED_SHARES, levelWords, modeWords, stoppedWhoWords } from "./words";
import type { StoppedShare } from "./types";
import styles from "./cloud.module.css";

export interface StoppedShareItem {
  share: StoppedShare;
  /** The auto it was made from, as the Sharing page names it. */
  autoLabel: string;
  /** Why "Share again" cannot open the dialog now, or null when it can. */
  whyNot: string | null;
}

export interface StoppedSharesProps {
  items: readonly StoppedShareItem[];
  nowMs: number;
  onShareAgain: (share: StoppedShare) => void;
}

export function StoppedShares({ items, nowMs, onShareAgain }: StoppedSharesProps) {
  if (items.length === 0) return null;
  return (
    <section className={styles.section} aria-label={STOPPED_SHARES.heading} data-testid="stopped-shares">
      <h3 className={styles.sectionHead}>{STOPPED_SHARES.heading}</h3>
      <p className={styles.caution} role="status">
        <TriangleAlert className={styles.cautionIcon} size={16} strokeWidth={1.75} aria-hidden />
        {STOPPED_SHARES.lead}
      </p>
      <ul className={styles.list}>
        {items.map(({ share, autoLabel, whyNot }) => {
          const testId = `stopped-share-${share.id}`;
          return (
            <li key={share.id} className={styles.item} data-testid={testId} data-reason={share.reason}>
              <div className={styles.itemMain}>
                <span className={styles.itemWho} data-testid={`${testId}-who`}>
                  {stoppedWhoWords(share)}
                </span>
                <span className={styles.itemAuto}>
                  {autoLabel}
                  <span className={styles.mono}>{` · revision ${String(share.revision)}`}</span>
                </span>
                <span className={styles.itemMeta}>
                  <span data-testid={`${testId}-reason`}>{STOPPED_SHARES.reason[share.reason]}</span>
                  <span aria-hidden>·</span>
                  <span>{levelWords(share)}</span>
                  <span aria-hidden>·</span>
                  <span>{modeWords(share)}</span>
                  <span aria-hidden>·</span>
                  <span>{STOPPED_SHARES.ends(shareDateWords(share.expiresAt, nowMs, { utcOffsetMinutes: utcOffsetAt(share.expiresAt, nowMs) }))}</span>
                </span>
              </div>
              <div className={styles.itemActions}>
                <SheetButton
                  tooltip={STOPPED_SHARES.shareAgainTooltip}
                  hint={STOPPED_SHARES.shareAgainHint}
                  whyDisabled={whyNot}
                  onClick={() => {
                    onShareAgain(share);
                  }}
                  testId={`${testId}-again`}
                >
                  {STOPPED_SHARES.shareAgain}
                </SheetButton>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
