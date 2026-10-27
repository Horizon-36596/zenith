/**
 * The first run's preset card (UI_GUIDE section 10.4): "How much of Zenith do you want to see?" It
 * shows once, on the true first run, over the example, and is non-modal like the tour's own cards.
 * Basic, Essential or Full applies the preset and starts the core tour; Essential is the recommended
 * one, and Esc or Skip counts as Essential. Import takes a preset file a teammate sent. Each choice
 * says what the person gets, never a list of what it turns off (issue #414). Which preset to offer and
 * what a choice does are `settings/presets.ts` and `tour/store.ts`; this file only draws the card.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Compass, FileUp, Layers, Sprout, type LucideIcon } from "lucide-react";
import { MAX_PRESET_FILE_BYTES, presetTooLargeMessage } from "../settings/presetFile";
import { BUILT_IN_PRESETS } from "../settings/presets";
import type { BuiltInPresetId } from "../settings/registry";
import { getState } from "../state/store";
import { anyMenuOpen } from "../state/ui";
import { choosePresetOnFirstRun, importPresetOnFirstRun } from "./firstRun";
import { usePresetCardOpen } from "./store";
import styles from "./Tour.module.css";

const ICONS: Record<BuiltInPresetId, LucideIcon> = { basic: Sprout, essential: Compass, full: Layers };

/** The preset a person who does not choose gets (spec 15 section 9): the recommended one. */
const RECOMMENDED: BuiltInPresetId = "essential";

export function PresetCard() {
  return usePresetCardOpen() ? <Card /> : null;
}

function Card() {
  const titleId = useId();
  const bodyId = useId();
  const recommended = useRef<HTMLButtonElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [problem, setProblem] = useState("");

  // Focus goes to the recommended choice, so Enter takes it and Tab reaches the rest.
  useEffect(() => {
    recommended.current?.focus();
  }, []);

  // Esc is Essential, but only while focus is in the card: anywhere else every key is the app's,
  // as with the tour's cards (UI_GUIDE section 10.2). An open menu or the palette takes it first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const inCard = event.target instanceof HTMLElement && event.target.closest("[data-preset-card]") !== null;
      if (!inCard || anyMenuOpen() || getState().paletteOpen || getState().dialog !== null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      choosePresetOnFirstRun(RECOMMENDED);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  const importFile = async (file: File): Promise<void> => {
    if (file.size > MAX_PRESET_FILE_BYTES) {
      setProblem(presetTooLargeMessage(file.name));
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setProblem(`${file.name} could not be read. Pick it again, or another one.`);
      return;
    }
    const result = importPresetOnFirstRun(text, file.name);
    if (!result.ok) setProblem(result.reason);
  };

  return (
    <div className={styles.layer} data-tour-layer data-testid="preset-layer">
      <div
        className={`${styles.choice} ${styles.presetCard}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-tour-card
        data-preset-card
        data-testid="preset-card"
      >
        <h2 id={titleId} className={styles.choiceTitle}>
          How much of Zenith do you want to see?
        </h2>
        <p id={bodyId} className={styles.body}>
          Pick what suits you. Skip or Esc chooses Essential. You can change it any time in Settings, Presets.
        </p>
        <div className={`${styles.options} ${styles.presetOptions}`} role="group" aria-labelledby={titleId}>
          {BUILT_IN_PRESETS.map((preset) => {
            const Icon = ICONS[preset.id];
            const isRecommended = preset.id === RECOMMENDED;
            return (
              <button
                key={preset.id}
                ref={isRecommended ? recommended : undefined}
                type="button"
                className={`${styles.option} ${isRecommended ? styles.optionDefault : ""}`}
                data-testid={`preset-card-${preset.id}`}
                onClick={() => {
                  choosePresetOnFirstRun(preset.id);
                }}
              >
                <Icon size={32} strokeWidth={1.75} aria-hidden className={styles.optionIcon} />
                <span className={styles.optionTitle}>
                  {preset.name}
                  {isRecommended ? <span className={styles.recommended}>Recommended</span> : null}
                </span>
                {/* What you get, in the words Settings uses. The badge says Recommended, so the sentence is cut short here. */}
                <span className={styles.optionBody} data-testid={`preset-card-gets-${preset.id}`}>
                  {preset.description.replace(/ Recommended\.$/, "")}
                </span>
              </button>
            );
          })}
        </div>
        {/* Always there, with room for its line, so a refused file moves nothing on the card (UX review, S5). */}
        <p className={styles.presetProblem} role="alert" data-testid="preset-card-problem">
          {problem}
        </p>
        <div className={`${styles.buttons} ${styles.presetButtons}`}>
          <button
            type="button"
            className={styles.ghost}
            data-testid="preset-card-import"
            onClick={() => {
              fileInput.current?.click();
            }}
          >
            <FileUp size={16} strokeWidth={1.75} aria-hidden className={styles.buttonIcon} />
            Import a preset file…
          </button>
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept=".json,application/json"
            tabIndex={-1}
            aria-label="Preset file"
            data-testid="preset-card-file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file !== undefined) void importFile(file);
            }}
          />
          <span className={styles.spacer} />
          <button
            type="button"
            className={styles.ghost}
            data-testid="preset-card-skip"
            onClick={() => {
              choosePresetOnFirstRun(RECOMMENDED);
            }}
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}
