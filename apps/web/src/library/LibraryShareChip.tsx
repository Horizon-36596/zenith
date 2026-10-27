/**
 * The sharing chip on one auto in the team library list (spec 13 section 8.4): the toolbar chip's
 * three states, "Team only", "Shared with 2 teams" and "Anyone with the link", with the same icon,
 * colour and tooltip, but for a library auto by its id rather than the open one. It is read only:
 * clicking it opens the Sharing page narrowed to this auto's shares, where each is extended,
 * changed or revoked, with "Show all" for the rest. Sharing itself starts from the auto, in the
 * share dialog.
 */
import { Globe, Lock, Users, type LucideIcon } from "lucide-react";
import { sharingChip, type SharingTone } from "@horizon36596/zenith-core";
import { Tooltip } from "../components/Tooltip";
import { utcOffsetAt } from "../cloud/shareModel";
import { cloudNow, openSharingSheet, sharesOf, useCloud } from "../cloud/store";
import cloudStyles from "../cloud/cloud.module.css";

const ICONS: Record<SharingTone, LucideIcon> = { team: Lock, teams: Users, link: Globe };

export function LibraryShareChip({ autoId, testId }: { autoId: string; testId?: string }) {
  const cloud = useCloud();
  if (!cloud.session.signedIn) return null;

  const nowMs = cloudNow();
  // A share whose every team was deleted gives nobody access, so the chip does not count it.
  const open = sharesOf(cloud.shares, autoId).filter((share) => share.everyTeamDeleted !== true);
  const chip = sharingChip(open, nowMs, { utcOffsetMinutes: utcOffsetAt(null, nowMs) });
  const Icon = ICONS[chip.tone];
  const hint =
    chip.lines.length === 0
      ? "Only your team can see this auto. Click to open the Sharing page on this auto's shares."
      : `${chip.lines.join(" ")} Click to open the Sharing page on this auto's shares, where each can be extended, changed or revoked.`;

  return (
    <Tooltip label={chip.label} hint={hint}>
      <button
        type="button"
        className={cloudStyles.chip}
        data-tone={chip.tone}
        data-testid={testId}
        onClick={() => {
          openSharingSheet("sharing", { autoId });
        }}
      >
        <Icon size={12} strokeWidth={1.75} aria-hidden />
        {chip.label}
      </button>
    </Tooltip>
  );
}
