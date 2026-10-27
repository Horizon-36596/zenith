/**
 * The outbox (spec 13 section 6): every write made on this computer, from
 * the moment it is applied here until the server takes or refuses it. Offline, writes wait here and
 * are sent in order when the connection comes back. A sign-out drops whatever still waits; those
 * rows say "Dropped", never "Refused", since the server did not refuse them (issue #319).
 */
import { useState } from "react";
import type { OutboxEntry } from "@horizon36596/zenith-cloud";
import { Sheet, SheetButton } from "../cloud/controls";
import { Inbox } from "lucide-react";
import { EmptyState } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { Feedback } from "./Feedback";
import { account, useAccount } from "./store";
import { outboxSummary, timeAgo } from "./words";
import styles from "./account.module.css";

const STATE_WORDS: Record<OutboxEntry["state"], string> = { queued: "Waiting", sent: "Sent", failed: "Refused", dropped: "Dropped" };
const STATE_DOES: Record<OutboxEntry["state"], string> = {
  queued: "Applied on this computer and waiting to be sent. Other teams and teammates do not see it yet.",
  sent: "The server has it.",
  failed: "The server refused it, and the change was undone on this computer.",
  dropped: "Signing out dropped it before the server confirmed it, so it may not have reached the server. Check, and do it again if it is missing.",
};

export function OutboxSheet() {
  const state = useAccount();
  const [showSent, setShowSent] = useState(false);
  const entries = [...(state.outbox?.entries ?? [])].reverse();
  const shown = showSent ? entries : entries.filter((e) => e.state !== "sent");
  const queued = state.outbox?.queued ?? 0;
  const dropped = state.outbox?.dropped ?? 0;
  const nowMs = Date.now();
  return (
    <Sheet
      title="Outbox"
      help="outbox"
      testId="outbox-sheet"
      widthPx={400}
      onClose={() => {
        account.close();
      }}
      lead={
        <p className={styles.lead} data-testid="outbox-summary">
          {outboxSummary(state.online, queued, dropped)}
        </p>
      }
    >
      <section className={styles.section}>
        <div className={styles.row}>
          <Tooltip label="Show sent changes" hint="Include the changes the server already has.">
            <label className={styles.inlineLabel}>
              <input
                className={styles.checkbox}
                type="checkbox"
                checked={showSent}
                data-testid="outbox-show-sent"
                onChange={(event) => {
                  setShowSent(event.target.checked);
                }}
              />
              Show sent changes
            </label>
          </Tooltip>
          {account.isFake() ? (
            <SheetButton
              kind="text"
              tooltip={state.online ? "Go offline (fake cloud)" : "Come back online (fake cloud)"}
              hint="The fake cloud's connection switch, to try the outbox without unplugging anything."
              testId="outbox-fake-online"
              onClick={() => void account.setFakeOnline(!state.online)}
            >
              {state.online ? "Go offline" : "Come back online"}
            </SheetButton>
          ) : null}
        </div>
        {shown.length === 0 ? (
          <EmptyState
            icon={Inbox}
            headline={entries.length === 0 ? "No changes yet" : "Nothing is waiting"}
            line={
              entries.length === 0
                ? "What you publish, share or change in a team shows here until the server has it."
                : "The server has every change made on this computer."
            }
            testId="outbox-empty"
          />
        ) : (
          <ul className={styles.list} data-testid="outbox-list">
            {shown.map((entry) => (
              <li key={entry.id} className={styles.item} data-testid={`outbox-${entry.id}`} data-state={entry.state}>
                <div className={styles.itemMain}>
                  <span className={styles.itemTitle}>{entry.summary}</span>
                  <span className={styles.itemMeta}>
                    <Tooltip label={STATE_WORDS[entry.state]} hint={STATE_DOES[entry.state]}>
                      <span
                        className={styles.chip}
                        tabIndex={0}
                        data-tone={entry.state === "failed" || entry.state === "dropped" ? "warn" : undefined}
                      >
                        {STATE_WORDS[entry.state]}
                      </span>
                    </Tooltip>
                    <span>{timeAgo(entry.queuedAt, nowMs)}</span>
                  </span>
                  {entry.error === null ? null : <span className={styles.error}>{entry.error}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}

      </section>
      <Feedback />
    </Sheet>
  );
}
