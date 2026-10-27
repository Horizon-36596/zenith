/**
 * Team-number verification in the web app (spec 13 section 4.4, M-C7). The account page mounts
 * `VerificationSection` for a team; `AdminRoute` is mounted once in the app shell and opens the Horizon
 * admins' review page at `#/admin`. `setVerificationBackend` points both at the real cloud backend.
 */
export { VerificationSection, type VerificationSectionProps } from "./VerificationSection";
export { AdminPage } from "./AdminPage";
export { AdminRoute } from "./AdminRoute";
export { isAdminHash } from "./model";
export { setVerificationBackend, useVerificationBackend } from "./store";
