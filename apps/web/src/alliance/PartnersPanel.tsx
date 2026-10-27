/**
 * The Partners panel (spec 13 section 9): where the user loads alliance partners' shared
 * projections and sets each robot's start offset. Files come in through the file picker or by
 * dropping them on the panel, and received cloud shares from the list under them; all of them go
 * through `PartnerSource` (`source.ts`). A partner from a cloud share also says when the share last
 * changed, offers Reload when a newer version arrived, and lists the proposals sent to it.
 *
 * Nothing here is modal and offsets and visibility are view settings. The one control here that
 * edits the auto is "Make it a wait step" (`OffsetToWait`), which turns the start offset into a
 * real wait; "Add a wait step" on an alliance finding is the other.
 */
import { useRef, useState, type DragEvent } from "react";
import { Eye, EyeOff, Users, X } from "lucide-react";
import { cloudEnabled } from "../account/config";
import { ReceivedShares } from "../cloud/ReceivedShares";
import { useCloud } from "../cloud/store";
import { NumberField } from "../components/fields";
import { RowButton } from "../components/primitives";
import emptyStyles from "../components/primitives.module.css";
import { Tooltip } from "../components/Tooltip";
import { useEditor } from "../state/store";
import { loadExamplePartner, loadPartnerFiles, removePartnerAndSay } from "./actions";
import { MAX_START_OFFSET_S, type PartnerEntry } from "./model";
import { OffsetToWait } from "./OffsetToWait";
import { PartnerShareInfo } from "./PartnerShareInfo";
import { setOwnOffset, setPartnerOffset, setPartnerVisible, useAllianceState } from "./store";
import type { AllianceView } from "./useAlliance";
import { suggestBlockedReason, suggestChanges } from "../proposals/proposerActions";
import styles from "./alliance.module.css";

/** The folded panel's one line: how many partners, and how many predicted findings. */
export function partnersSummary(view: Pick<AllianceView, "state" | "result">): string {
  const count = view.state.partners.length;
  if (count === 0) return "None loaded";
  const findings = view.result?.findings.length ?? 0;
  const partners = `${String(count)} ${count === 1 ? "partner" : "partners"}`;
  return findings === 0 ? partners : `${partners}, ${String(findings)} predicted ${findings === 1 ? "finding" : "findings"}`;
}

export function PartnersPanel({ view }: { view: AllianceView }) {
  const { project, auto } = useEditor();
  const { partners, ownOffsetS } = useAllianceState();
  const input = useRef<HTMLInputElement | null>(null);
  const [dropping, setDropping] = useState(false);
  const example = project?.source.kind === "example";
  const choose = () => {
    input.current?.click();
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropping(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) void loadPartnerFiles(files);
  };

  return (
    <div
      className={styles.panel}
      data-testid="partners-body"
      data-drop={dropping ? "true" : undefined}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => {
        setDropping(false);
      }}
      onDrop={onDrop}
    >
      <input
        ref={input}
        className={styles.hiddenInput}
        type="file"
        accept=".json,application/json"
        multiple
        data-testid="partners-file-input"
        aria-label="Partner share files"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length > 0) void loadPartnerFiles(files);
        }}
      />

      {partners.length === 0 ? (
        // UI_GUIDE section 9.12: with no partner loaded, the start offset has nothing to line up
        // with, so the panel is an empty state and the offset row waits for a partner.
        <div className={`${emptyStyles.empty} ${styles.emptyState}`} data-testid="partners-empty">
          <Users size={20} strokeWidth={1.5} aria-hidden />
          <p className={emptyStyles.emptyLine}>No partners loaded</p>
          <p className={emptyStyles.emptyHint}>
            Load or drop a partner&apos;s share file to see both robots on one field and one clock.
          </p>
          <div className={styles.loadRow}>
            <LoadShareFile className={emptyStyles.emptyAction} onClick={choose} />
            {example ? <LoadExample /> : null}
          </div>
        </div>
      ) : (
        <div className={styles.loadRow}>
          <LoadShareFile className={styles.textButton} onClick={choose} />
          {example ? <LoadExample /> : null}
        </div>
      )}

      <ReceivedShares />

      {auto === null || partners.length === 0 ? null : (
        <>
          <NumberField
            label="Your start offset"
            value={ownOffsetS}
            unit="s"
            step={0.1}
            digits={1}
            min={0}
            max={MAX_START_OFFSET_S}
            testId="partners-own-offset"
            hint="How long your robot waits at its start pose, in 0.1 s steps. It changes nothing in the auto; Add a wait step does."
            onChange={(value: number) => {
              setOwnOffset(value);
            }}
          />
          <OffsetToWait />
        </>
      )}

      {view.own !== null && !view.own.ok ? (
        <p className={styles.unavailable} data-testid="partners-unavailable">
          Your robot could not be predicted, so there is nothing to compare: {view.own.reason}
        </p>
      ) : null}

      {partners.length === 0 ? null : (
        <ul className={styles.partnerList} data-testid="partners-list">
          {partners.map((partner) => (
            <PartnerRow
              key={partner.id}
              partner={partner}
              mirrored={auto !== null && partner.projection.alliance !== auto.alliance}
              ownAlliance={auto?.alliance ?? partner.projection.alliance}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PartnerRow({
  partner,
  mirrored,
  ownAlliance,
}: {
  partner: PartnerEntry;
  mirrored: boolean;
  ownAlliance: "RED" | "BLUE";
}) {
  return (
    <li
      className={styles.partner}
      data-testid={`partner-${partner.id}`}
      data-visible={partner.visible ? "true" : "false"}
    >
      <div className={styles.partnerHead}>
        <span className={styles.swatch} data-colour={String(partner.colour)} aria-hidden />
        <Tooltip label={partner.label} hint={`From ${partner.fileName}. Its outline, lane and findings use this colour.`}>
          <span className={styles.partnerName} tabIndex={0} data-testid="partner-label">
            {partner.label}
          </span>
        </Tooltip>
        <Tooltip
          label={`Written for ${partner.projection.alliance}`}
          hint={
            mirrored
              ? `This auto was written for ${partner.projection.alliance}, so it is mirrored onto ${ownAlliance} by the field's own mirror.`
              : `The same alliance as your auto, so it is drawn as it was shared.`
          }
        >
          <span className={styles.alliancePill} data-alliance={partner.projection.alliance} tabIndex={0}>
            {partner.projection.alliance}
          </span>
        </Tooltip>
        <RowButton
          icon={partner.visible ? Eye : EyeOff}
          label={partner.visible ? `Hide ${partner.label}` : `Show ${partner.label}`}
          hint={
            partner.visible
              ? "Takes this partner off the field, the timeline and the alliance findings, without unloading it."
              : "Puts this partner back on the field, the timeline and the alliance findings."
          }
          testId={`partner-visible-${partner.id}`}
          onClick={() => {
            setPartnerVisible(partner.id, !partner.visible);
          }}
        />
        <RowButton
          icon={X}
          label={`Remove ${partner.label}`}
          hint="Unloads this partner from the alliance view. Load its file again to bring it back."
          testId={`partner-remove-${partner.id}`}
          onClick={() => {
            removePartnerAndSay(partner);
          }}
        />
      </div>
      {partner.share === undefined ? null : <PartnerShareInfo partner={partner} share={partner.share} />}
      {partner.projection.level === "propose" ? <SuggestChanges partner={partner} /> : null}
      <NumberField
        label="Start offset"
        value={partner.offsetS}
        unit="s"
        step={0.1}
        digits={1}
        min={0}
        max={MAX_START_OFFSET_S}
        testId={`partner-offset-${partner.id}`}
        hint={`How long ${partner.label} waits at its start pose before its auto begins, in 0.1 s steps: agree it with them.`}
        onChange={(value: number) => {
          setPartnerOffset(partner.id, value);
        }}
      />
    </li>
  );
}

/** The Load share file… button, the empty state's action and the loaded panel's first. */
function LoadShareFile({ className, onClick }: { className: string | undefined; onClick: () => void }) {
  return (
    <Tooltip
      label="Load a share file"
      hint="Choose one or more share files (.projection.json) a partner sent you. They stay in this window and are never saved into your project."
    >
      <button type="button" className={className} data-testid="partners-load" onClick={onClick}>
        Load share file…
      </button>
    </Tooltip>
  );
}

/** Load the example partner, offered only while the example project is open. */
function LoadExample() {
  return (
    <Tooltip
      label="Load the example partner"
      hint="The starter's first auto, shared from the next tile west, so you can try the alliance view without a partner."
    >
      <button
        type="button"
        className={styles.textButton}
        data-testid="partners-load-example"
        onClick={() => void loadExamplePartner()}
      >
        Load the example partner
      </button>
    </Tooltip>
  );
}

/**
 * "Suggest changes" on a partner shared at the propose level (spec 13 section 14): opens the
 * proposer's editor on its structure. Nothing it does touches the user's own auto.
 */
function SuggestChanges({ partner }: { partner: PartnerEntry }) {
  const editor = useEditor();
  const { session } = useCloud();
  const blocked = suggestBlockedReason(partner, editor, session.teamId);
  return (
    <Tooltip
      label="Suggest changes"
      hint={
        blocked === null
          ? `Edit ${partner.label}'s routine as a proposal. Your auto is not touched, and nothing leaves this computer until you ${cloudEnabled() ? "save or send" : "save"} the proposal.`
          : `Unavailable: ${blocked}`
      }
    >
      <button
        type="button"
        className={styles.textButton}
        aria-disabled={blocked === null ? undefined : true}
        data-testid={`partner-suggest-${partner.id}`}
        onClick={() => {
          if (blocked === null) suggestChanges(partner);
        }}
      >
        Suggest changes…
      </button>
    </Tooltip>
  );
}
