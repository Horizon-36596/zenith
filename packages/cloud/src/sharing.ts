/**
 * The sharing limits, the revision-id arithmetic and the number a team's name reads as, on their own, as
 * `@horizon36596/zenith-cloud/sharing`, so the web app's share dialog can check a request before it
 * sends one without loading the Firebase SDK that the package's main entry brings in. The stores'
 * own failure sentences are here too, so the app's error translator can tell them apart.
 */
export { DEFAULT_EXPIRY_S, MAX_PROPOSAL_DIFF_BYTES, MAX_SHARE_PROJECTION_BYTES, MAX_SHARE_TEAMS, TIME_REQUEST_REASONS } from "./types.js";
export { revisionNumber } from "./ids.js";
export { numberInTeamName } from "./teamNumbers.js";
export { NOT_FOUND, OFFLINE_NOT_SAVED, RULES_REFUSED } from "./errors.js";
