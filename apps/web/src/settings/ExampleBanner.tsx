/**
 * The one banner a Settings window shows while the bundled example is open (issue #246, UI_GUIDE
 * section 9.13 rule 8): what is read only and the way out, Open project. The Robot and Commands
 * sections used to each carry a note saying the same thing; now the window says it once, above
 * whichever of them is showing, and the sections keep only the values. General holds the person's own
 * switches, which the example does not limit, so it shows no banner (issue #414).
 */
import { SheetButton } from "../cloud/controls";
import { setDialog, useEditor } from "../state/store";
import { closeSettings } from "./store";
import styles from "./Settings.module.css";

export function ExampleBanner() {
  const { project } = useEditor();
  if (project?.source.kind !== "example") return null;
  return (
    <div className={styles.banner} role="note" data-testid="settings-example-banner">
      <span>The example is read only. Open your own project to edit these.</span>
      <SheetButton
        tooltip="Open project"
        hint="Open your own robot project to change its robot, its commands and its command library."
        onClick={() => {
          closeSettings();
          setDialog("open");
        }}
        testId="settings-example-open-project"
      >
        Open project…
      </SheetButton>
    </div>
  );
}
