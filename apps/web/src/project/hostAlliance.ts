/**
 * What host mode says about alliances (site/docs/host-protocol.md). A host auto is drawn in one
 * alliance's frame, the file's own `alliance`, which for a new one is the field's canonical
 * alliance, and the host mirrors it with the field's `frame.mirror` when the other alliance plays
 * it. A person drawing for DSIM needs to know which side to draw on, so the host bar says so.
 */
import type { MirrorMode } from "@horizon36596/zenith-core";

type Alliance = "RED" | "BLUE";

export const otherAlliance = (alliance: Alliance): Alliance => (alliance === "RED" ? "BLUE" : "RED");

/** How a mirror turns the drawn alliance's routine into the other's, as a phrase after the host's name. */
const HOW: Record<Exclude<MirrorMode, "none">, string> = {
  pointSymmetry: "turns it half a turn around the centre of the field",
  mirrorX: "reflects it across the x axis",
  mirrorY: "reflects it across the y axis",
};

export interface AllianceLine {
  /** The whole line: `Draw for RED. DSIM mirrors it when you play BLUE.` */
  text: string;
  /** The host bar's short form, under the robot's name: `Draw for RED · DSIM mirrors for BLUE`. */
  short: string;
  /** The tooltip under it, which says how the mirror works. */
  hint: string;
}

/** The host bar's alliance line for a file drawn for `alliance` on a field that mirrors by `mirror`. */
export function allianceLine(alliance: Alliance, mirror: MirrorMode, hostName: string): AllianceLine {
  const other = otherAlliance(alliance);
  // Plain words only: the field file's own name for the mirror (`pointSymmetry`) is not shown (sweep W4-5).
  if (mirror === "none") {
    return {
      text: `Draw for ${alliance}.`,
      short: `Draw for ${alliance}`,
      hint: `This auto is drawn for ${alliance}. This field is not mirrored, so ${hostName} has no ${other} version of it.`,
    };
  }
  return {
    text: `Draw for ${alliance}. ${hostName} mirrors it when you play ${other}.`,
    short: `Draw for ${alliance} · ${hostName} mirrors for ${other}`,
    hint: `This auto is drawn for ${alliance}. When you play ${other}, ${hostName} ${HOW[mirror]}, so put every point where ${alliance}'s robot goes.`,
  };
}
