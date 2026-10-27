/** Document and collection paths. The layout is part of the contract with cloud/firestore.rules. */

export const paths = {
  user: (uid: string) => `users/${uid}`,
  admins: () => "admins",
  admin: (uid: string) => `admins/${uid}`,
  betaTesters: () => "betaTesters",
  /** A private beta tester, added by a Horizon admin. */
  betaTester: (uid: string) => `betaTesters/${uid}`,
  /** A request for beta access sent before 2026-10-03; its id is the sender's uid. */
  betaRequest: (uid: string) => `betaRequests/${uid}`,
  /** The console's switch that opens the private beta to everyone. */
  accessConfig: () => "config/access",
  team: (teamId: string) => `teams/${teamId}`,
  /** A deleted team's tombstone, which keeps its id from ever being used again. */
  deletedTeam: (teamId: string) => `deletedTeams/${teamId}`,
  members: (teamId: string) => `teams/${teamId}/members`,
  member: (teamId: string, uid: string) => `teams/${teamId}/members/${uid}`,
  settingsCollection: (teamId: string) => `teams/${teamId}/settings`,
  settings: (teamId: string) => `teams/${teamId}/settings/sharing`,
  autos: (teamId: string) => `teams/${teamId}/autos`,
  auto: (teamId: string, autoId: string) => `teams/${teamId}/autos/${autoId}`,
  revisions: (teamId: string, autoId: string) => `teams/${teamId}/autos/${autoId}/revisions`,
  revision: (teamId: string, autoId: string, revisionId: string) =>
    `teams/${teamId}/autos/${autoId}/revisions/${revisionId}`,
  inbox: (teamId: string) => `teams/${teamId}/inbox`,
  inboxEntry: (teamId: string, shareId: string) => `teams/${teamId}/inbox/${shareId}`,
  activity: (teamId: string) => `teams/${teamId}/activity`,
  activityEntry: (teamId: string, entryId: string) => `teams/${teamId}/activity/${entryId}`,
  invite: (code: string) => `invites/${code}`,
  shares: () => "shares",
  share: (shareId: string) => `shares/${shareId}`,
  /** A collection group id: every share's requests for more time. */
  timeRequestsGroup: () => "timeRequests",
  timeRequest: (shareId: string, teamId: string) => `shares/${shareId}/timeRequests/${teamId}`,
  proposals: () => "proposals",
  proposal: (proposalId: string) => `proposals/${proposalId}`,
  claim: (teamNumber: number) => `claims/${String(teamNumber)}`,
  claimHistory: (teamNumber: number) => `claims/${String(teamNumber)}/history`,
  claimStep: (teamNumber: number, index: number) => `claims/${String(teamNumber)}/history/${String(index)}`,
  disputes: () => "disputes",
  dispute: (disputeId: string) => `disputes/${disputeId}`,
  verifications: () => "verifications",
  verification: (requestId: string) => `verifications/${requestId}`,
  adminLog: () => "adminLog",
  adminLogEntry: (entryId: string) => `adminLog/${entryId}`,
  bugReports: () => "bugReports",
  bugReport: (reportId: string) => `bugReports/${reportId}`,
} as const;
