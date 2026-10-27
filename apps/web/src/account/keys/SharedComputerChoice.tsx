/**
 * The sign-in choice between the member's own device and a shared computer. On a shared computer the
 * device keys live in memory only, so they go when the app closes and every session needs a fresh
 * approval; on the member's own device they are kept, and it is approved once. The two options are
 * native radio buttons, so the arrow keys move between them.
 */
import { useId } from "react";
import { Tooltip } from "../../components/Tooltip";
import { SHARED_COMPUTER } from "./words";
import account from "../account.module.css";
import styles from "./keys.module.css";

/** Whose device this is: the member's own, or a shared computer such as one in a school lab. */
export type DeviceOwnership = "own" | "shared";

export interface SharedComputerChoiceProps {
  value: DeviceOwnership;
  onChange: (value: DeviceOwnership) => void;
  /** True in the desktop app, where the advice to use the desktop app is left out. */
  inDesktopApp?: boolean;
}

const OPTIONS: ReadonlyArray<{ value: DeviceOwnership; label: string; detail: string; hint: string }> = [
  { value: "own", label: SHARED_COMPUTER.own, detail: SHARED_COMPUTER.ownDetail, hint: SHARED_COMPUTER.ownHint },
  {
    value: "shared",
    label: SHARED_COMPUTER.shared,
    detail: SHARED_COMPUTER.sharedDetail,
    hint: SHARED_COMPUTER.sharedHint,
  },
];

export function SharedComputerChoice({ value, onChange, inDesktopApp = false }: SharedComputerChoiceProps) {
  const name = useId();
  return (
    <section className={account.section} data-testid="shared-computer-choice">
      <fieldset className={styles.choices}>
        <legend className={styles.legend}>{SHARED_COMPUTER.legend}</legend>
        {OPTIONS.map((option) => (
          <label key={option.value} className={styles.choice}>
            <Tooltip label={option.label} hint={option.hint}>
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={value === option.value}
                data-testid={`shared-computer-${option.value}`}
                onChange={() => {
                  onChange(option.value);
                }}
              />
            </Tooltip>
            <span>{option.label}</span>
            <span className={styles.choiceDetail}>{option.detail}</span>
          </label>
        ))}
      </fieldset>
      {inDesktopApp ? null : <p className={account.hint}>{SHARED_COMPUTER.desktop}</p>}
    </section>
  );
}
