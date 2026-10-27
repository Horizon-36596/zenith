/**
 * A received share on its own, read only (spec 13 section 9: "With no project open it shows the
 * partner's auto alone"): what a `#/s/<id>` link or a Load in the Partners panel opens when no auto
 * is open. It shows exactly the projection the other team shared, drawn on the public season field
 * by the same preview the share dialog uses, and nothing is saved.
 */
import { useMemo } from "react";
import type { Field } from "@horizon36596/zenith-schema";
import { timeAgo } from "../account/words";
import { receivedShareWords } from "../alliance/cloudSource";
import { readPartnerText, type PartnerLoad } from "../alliance/source";
import { loadExampleProject } from "../project/example";
import { ProjectionPreview } from "./ProjectionPreview";
import { Sheet, SheetButton } from "./controls";
import { closeSharingSheet, cloudNow, useCloud } from "./store";
import type { ReceivedShare } from "./types";
import { fromTeamWords, sharedByWords } from "./words";
import styles from "./cloud.module.css";

/** The public field of the season a projection names, when this build carries it. */
export function seasonField(season: string): Field | null {
  const field = loadExampleProject().field;
  return field.season === season ? field : null;
}

/**
 * The share's projection read for the viewer, with its season's field. A refusal is one sentence
 * that names the share by who shared it and asks that team to share it again, as the Partners
 * panel says it, so the viewer shows it as it is.
 */
export function readViewedShare(share: ReceivedShare): { loaded: PartnerLoad; field: Field | null } {
  const loaded = readPartnerText(fromTeamWords(share), share.projection, receivedShareWords(share));
  return { loaded, field: loaded.ok ? seasonField(loaded.projection.season) : null };
}

export function SharedAutoViewer() {
  const { viewing } = useCloud();
  const read = useMemo(() => (viewing === null ? null : readViewedShare(viewing)), [viewing]);
  if (viewing === null || read === null) return null;
  const { loaded, field } = read;
  const nowMs = cloudNow();
  const by = sharedByWords(viewing);
  const title = `${by.charAt(0).toUpperCase()}${by.slice(1)}`;
  const version =
    viewing.mode === "follow"
      ? `It follows their latest version and last changed ${timeAgo(new Date(viewing.updatedAt), nowMs)}.`
      : `It is revision ${String(viewing.revision)} of their auto.`;

  return (
    <Sheet
      title={title}
      help="partners"
      testId="share-viewer"
      widthPx={480}
      onClose={closeSharingSheet}
      lead={
        <p className={styles.sentence} data-testid="share-viewer-sentence">
          Read only. {version}
        </p>
      }
      footer={
        <SheetButton kind="primary" tooltip="Close this panel" onClick={closeSharingSheet} testId="share-viewer-close">
          Close
        </SheetButton>
      }
    >
      {!loaded.ok ? (
        <p className={styles.error} role="alert" data-testid="share-viewer-problem">
          {loaded.reason}
        </p>
      ) : field === null ? (
        <p className={styles.error} role="alert" data-testid="share-viewer-problem">
          This share is for the {loaded.projection.season} season, whose field this version of Zenith does not carry.
        </p>
      ) : (
        <ProjectionPreview
          projection={loaded.projection}
          canonical={viewing.projection}
          bytes={new TextEncoder().encode(viewing.projection).length}
          field={field}
        />
      )}

    </Sheet>
  );
}
