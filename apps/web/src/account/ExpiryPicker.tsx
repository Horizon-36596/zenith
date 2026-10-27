/**
 * The one expiry picker for invites and shares (owner ruling 2026-09-27: expiries are calendar times
 * only): 1, 7 or 30 days, or a date and time on this computer's clock. The Teams sheet uses it to
 * make and extend invites, and the Sharing page uses it to extend shares and invites, so both offer
 * exactly the same choices.
 */
import { Segmented } from "../components/Segmented";
import { Tooltip } from "../components/Tooltip";
import { EXPIRY_PRESETS, MS_PER_DAY, toLocalInput, type InviteExpiryChoice } from "./invites";
import styles from "./account.module.css";

type ExpiryKey = "1" | "7" | "30" | "at";

const keyOf = (choice: InviteExpiryChoice): ExpiryKey =>
  choice.kind === "at" ? "at" : (String(choice.days) as ExpiryKey);

export function ExpiryPicker({
  value,
  onChange,
  testId,
  verb,
  subject = "invite",
  startMs,
}: {
  value: InviteExpiryChoice;
  onChange: (choice: InviteExpiryChoice) => void;
  testId: string;
  /** "ends" when making one, "extends" when giving one more time. */
  verb: "ends" | "extends";
  /** What the picker is for, in its words: "invite" or "share". */
  subject?: "invite" | "share";
  /**
   * Where the date and time starts when that choice is pressed, in epoch milliseconds: a week after
   * this instant. Defaults to now; extending passes the current end, so the picker starts later.
   */
  startMs?: number;
}) {
  const options = [
    ...EXPIRY_PRESETS.map((preset) => ({
      value: String(preset.days) as ExpiryKey,
      label: verb === "ends" ? preset.label : `${preset.label} more`,
      does:
        verb === "ends"
          ? subject === "invite"
            ? preset.does
            : `The share stops working ${preset.label} from now.`
          : `Adds ${preset.label} to the ${subject}'s current end, or to now if it has already ended.`,
    })),
    {
      value: "at" as const,
      label: "Date and time",
      does:
        verb === "ends"
          ? `The ${subject} stops working at a date and time you pick, on this computer's clock.`
          : `The ${subject} works until a date and time you pick, on this computer's clock. It must be later than when it ends now.`,
    },
  ];
  return (
    <div className={styles.stack}>
      <Segmented
        label={verb === "ends" ? `${subject === "invite" ? "Invite" : "Share"} ends` : "Extend by"}
        options={options}
        value={keyOf(value)}
        testId={testId}
        onChange={(key) => {
          if (key === "at") onChange({ kind: "at", local: toLocalInput(Math.max(startMs ?? 0, Date.now()) + 7 * MS_PER_DAY) });
          else onChange({ kind: "days", days: Number(key) as 1 | 7 | 30 });
        }}
      />
      {value.kind === "at" ? (
        <Tooltip label="Ends at" hint="A date and time on this computer's clock.">
          <input
            className={styles.input}
            type="datetime-local"
            aria-label="Ends at"
            value={value.local}
            data-testid={`${testId}-at`}
            onChange={(event) => {
              onChange({ kind: "at", local: event.target.value });
            }}
          />
        </Tooltip>
      ) : null}
    </div>
  );
}
