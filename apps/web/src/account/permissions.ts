/**
 * What each role may do in a team (spec 13 section 4.3), as the controls
 * see it: every function answers null when the control can act, or the sentence its tooltip shows
 * when it cannot. The database's rules (cloud/firestore.rules) are what actually enforce this; these
 * only keep the buttons honest, so nobody is offered something the rules would refuse.
 */
import type { ActiveRole, Member, Role, TeamSettings } from "@horizon36596/zenith-cloud";

const ADMIN_ONLY = "Only the team's owners and admins can do this.";
const OWNER_ONLY = "Only an owner of the team can do this.";
const PENDING = "Your membership is waiting for an owner or admin to approve it.";

export const isActive = (role: Role | null): role is ActiveRole => role !== null && role !== "pending";
export const isAdminRole = (role: Role | null): boolean => role === "owner" || role === "admin";
export const isEditorRole = (role: Role | null): boolean => role === "owner" || role === "admin" || role === "editor";

/** Why this role cannot open the team library, or null. Every active role reads it. */
export function whyCannotOpenLibrary(role: Role | null): string | null {
  if (role === null) return "Choose a team first.";
  if (role === "pending") return PENDING;
  return null;
}

/** Why this role cannot publish a revision, or null. Editors and up publish. */
export function whyCannotPublish(role: Role | null): string | null {
  const closed = whyCannotOpenLibrary(role);
  if (closed !== null) return closed;
  return isEditorRole(role)
    ? null
    : "Viewers can open the library but not publish to it. Ask an admin to make you an editor.";
}

export function whyCannotInvite(role: Role | null): string | null {
  if (role === "pending") return PENDING;
  return isAdminRole(role) ? null : ADMIN_ONLY;
}

export const whyCannotApprove = whyCannotInvite;
export const whyCannotEditSettings = whyCannotInvite;
export const whyCannotViewActivity = whyCannotInvite;

export function whyCannotDeleteTeam(role: Role | null): string | null {
  return role === "owner" ? null : OWNER_ONLY;
}

export function whyCannotLeave(role: Role | null): string | null {
  if (role === "owner")
    return "An owner cannot leave. Make another member an owner, and ask them to change your role first.";
  return role === null ? "You are not in this team." : null;
}

/**
 * The roles `actor` may give `target`. Owners give any active role, owner included; admins give
 * admin, editor and viewer, never owner, and never to an owner. Nobody changes their own role.
 */
export function roleChoices(actorRole: Role | null, actorUid: string, target: Member): ActiveRole[] {
  if (target.uid === actorUid) return [];
  if (actorRole === "owner") return ["owner", "admin", "editor", "viewer"];
  if (actorRole === "admin" && target.role !== "owner") return ["admin", "editor", "viewer"];
  return [];
}

export function whyCannotChangeRole(actorRole: Role | null, actorUid: string, target: Member): string | null {
  if (target.uid === actorUid) return "Nobody can change their own role. Ask another owner or admin.";
  if (target.role === "pending") return "Approve this member first; then their role can change.";
  if (!isAdminRole(actorRole)) return ADMIN_ONLY;
  if (actorRole === "admin" && target.role === "owner") return "Admins cannot change an owner's role.";
  return null;
}

export function whyCannotRemove(actorRole: Role | null, actorUid: string, target: Member): string | null {
  if (target.uid === actorUid) return "To leave the team yourself, use Leave team.";
  if (!isAdminRole(actorRole)) return ADMIN_ONLY;
  if (actorRole === "admin" && target.role === "owner") return "Admins cannot remove an owner.";
  return null;
}

export function whyCannotApproveMember(actorRole: Role | null, target: Member): string | null {
  const why = whyCannotApprove(actorRole);
  if (why !== null) return why;
  return target.role === "pending" ? null : "This member is already approved.";
}

/**
 * Transferring ownership makes another active member an owner. The rules let an owner give the
 * owner role and nobody change their own, so the old owner stays an owner until the new one changes
 * their role: a team always has at least one.
 */
export function whyCannotTransfer(actorRole: Role | null, actorUid: string, target: Member): string | null {
  if (actorRole !== "owner") return OWNER_ONLY;
  if (target.uid === actorUid) return "You are already an owner.";
  if (target.role === "pending") return "Approve this member first.";
  if (target.role === "owner") return "This member is already an owner.";
  return null;
}

/** Shares, for the sharing UI (section 4.3's two settings). Editors share with teams at view level. */
export function whyCannotShare(
  role: Role | null,
  settings: Pick<TeamSettings, "editorsMayProposeShare" | "editorsMayLinkShare">,
  share: { audience: "teams" | "link"; level: "view" | "propose" },
): string | null {
  const closed = whyCannotOpenLibrary(role);
  if (closed !== null) return closed;
  if (!isEditorRole(role)) return "Viewers cannot share. Ask an admin to make you an editor.";
  if (isAdminRole(role)) return null;
  if (share.audience === "link" && !settings.editorsMayLinkShare) {
    return "Only admins can make an anyone-with-the-link share in this team.";
  }
  if (share.level === "propose" && !settings.editorsMayProposeShare) {
    return "Only admins can share at the propose level in this team.";
  }
  return null;
}

/** The words for a role, in sentence case. */
export const ROLE_WORDS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
  pending: "Waiting for approval",
};

/** What a role can do, in one sentence, for the role picker's tooltips. */
export const ROLE_DOES: Record<ActiveRole, string> = {
  owner: "Everything, plus deleting the team and transferring ownership.",
  admin: "Invites, approves and removes members, changes roles, and makes and revokes any share.",
  editor:
    "Publishes to the team library, opens alliance views, sends proposals and shares with specific teams at view level.",
  viewer: "Opens the team library and received shares, and uses the alliance view. Cannot publish or share.",
};
