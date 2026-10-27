/**
 * The Inspector's quiet chip for something made with a tool the person's settings turn off: "Made with
 * Step groups, which your settings turn off", with a Turn on button beside it. Hiding a feature's tools
 * never hides or changes what a file already has, so the step or pin still shows and edits as usual
 * under the chip.
 */
import { TextButton } from "../components/primitives";
import { featureLabel, madeWithLine, setFeature, type Feature } from "../state/features";
import { setStatus } from "../state/store";
import styles from "./Inspector.module.css";

export function MadeWithChip({ feature }: { feature: Feature }) {
  const label = featureLabel(feature);
  return (
    <div className={styles.madeWith} data-testid="inspector-made-with" data-feature={feature}>
      <span className={styles.madeWithText}>{madeWithLine(feature)}.</span>
      <TextButton
        label={`Turn on ${label}`}
        hint="Turns it on in Settings, General. Your files stay the same either way."
        testId="inspector-made-with-turn-on"
        onClick={() => {
          setFeature(feature, true);
          setStatus("ok", `Turned on ${label} in Settings, General.`);
        }}
      />
    </div>
  );
}
