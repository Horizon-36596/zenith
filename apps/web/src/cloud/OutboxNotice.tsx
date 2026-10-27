/**
 * The line a confirmation shows when its write is still waiting on this computer (spec 13 section
 * 6): the write applies here at once, but the other team sees nothing until the Outbox sends it,
 * so the confirmation says so plainly and links to the Outbox.
 */
import { TriangleAlert } from "lucide-react";
import { openAccountPanel } from "../account/store";
import { SheetButton } from "./controls";
import styles from "./cloud.module.css";

export function OutboxNotice({ text, testId }: { text: string; testId: string }) {
  return (
    <div className={styles.caution} role="status" data-testid={testId}>
      <TriangleAlert className={styles.cautionIcon} size={16} strokeWidth={1.75} aria-hidden />
      <span>
        {text}{" "}
        <SheetButton
          kind="text"
          tooltip="Open the Outbox"
          hint="See what is waiting on this computer to be sent, and whether anything was refused."
          onClick={() => {
            openAccountPanel("outbox");
          }}
          testId={`${testId}-outbox`}
        >
          Open the Outbox
        </SheetButton>
      </span>
    </div>
  );
}
