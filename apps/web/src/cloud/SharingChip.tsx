/**
 * The sharing chip beside the auto's name in the title bar (spec 13
 * section 8.4): "Team only", "Shared with 2 teams" or "Anyone with the link", each with its own
 * icon and colour, and a tooltip that lists who can see it and until when. An auto the team library
 * does not hold yet reads "Not in the team library", since not even the team can see it. Clicking it
 * opens the share dialog. It shows only while signed in to the cloud with an auto open; signed out,
 * the toolbar's Share button says "Sign in to share" instead.
 */
import { Globe, Lock, Users, type LucideIcon } from "lucide-react";
import { sharingChip, type SharingTone } from "@horizon36596/zenith-core";
import { Tooltip } from "../components/Tooltip";
import { useEditor } from "../state/store";
import { utcOffsetAt } from "./shareModel";
import { cloudNow, openSharingSheet, sharesOf, useCloud } from "./store";
import { libraryAutoIdOf, useOpenAutoStatus } from "./openAuto";
import styles from "./cloud.module.css";

const ICONS: Record<SharingTone, LucideIcon> = { team: Lock, teams: Users, link: Globe };

/** The chip's words for an auto the team library does not hold yet. */
const NOT_IN_LIBRARY = "Not in the team library";

export function SharingChip() {
  const editor = useEditor();
  const cloud = useCloud();
  // An auto the team library does not hold yet has no shares, and the team cannot see it either.
  const autoId = libraryAutoIdOf(useOpenAutoStatus());
  if (!cloud.session.signedIn || editor.auto === null) return null;

  const nowMs = cloudNow();
  // A share whose every team was deleted gives nobody access, so the chip does not count it.
  const open = sharesOf(cloud.shares, autoId).filter((share) => share.everyTeamDeleted !== true);
  const shared = sharingChip(open, nowMs, { utcOffsetMinutes: utcOffsetAt(null, nowMs) });
  const chip = autoId === null ? { ...shared, label: NOT_IN_LIBRARY } : shared;
  const Icon = ICONS[chip.tone];
  const hint =
    autoId === null
      ? "Your team library does not have this auto yet, so nobody else can see it in Zenith. Click to share it, which publishes it to the library first."
      : chip.lines.length === 0
        ? "Only your team can see this auto. Click to share it."
        : `${chip.lines.join(" ")} Click to share it again or change who can see it.`;

  return (
    <Tooltip label={chip.label} hint={hint}>
      <button
        type="button"
        className={styles.chip}
        data-tone={chip.tone}
        data-testid="sharing-chip"
        onClick={() => {
          openSharingSheet("share");
        }}
      >
        <Icon size={12} strokeWidth={1.75} aria-hidden />
        {chip.label}
      </button>
    </Tooltip>
  );
}
