/**
 * A code people read out or compare by eye: a waiting device's approval code, such as
 * `7K2QXD-M9A1RT-4ZC8PW`, or a team's safety code, such as `0417 2958 3361 7720 5164`. The characters are large and in groups (split at spaces or
 * dashes); a screen reader hears them one character at a time.
 */
import { useId } from "react";
import { spokenCode } from "./words";
import styles from "./keys.module.css";

export interface VerificationCodeProps {
  /** The code as the crypto module writes it, in groups split by spaces or dashes. */
  code: string;
  /** One short line under the code saying whose code it is, such as "This device's code". */
  caption: string;
  testId?: string;
}

export function VerificationCode({ code, caption, testId }: VerificationCodeProps) {
  const captionId = useId();
  const groups = code.trim().split(/[\s-]+/);
  return (
    <figure className={styles.codeBlock} aria-labelledby={captionId} data-testid={testId}>
      <p className={styles.code}>
        <span className="visually-hidden">{spokenCode(code)}</span>
        {groups.map((group, index) => (
          <span key={index} aria-hidden="true">
            {group}
          </span>
        ))}
      </p>
      <figcaption id={captionId} className={styles.caption}>
        {caption}
      </figcaption>
    </figure>
  );
}
