/**
 * The Settings window's way to the Horizon admins' page at `#/admin` (its Admin section). The page
 * had no link anywhere, so an admin had to know the address. The entry shows only to a signed-in
 * Horizon admin, by the same check the admin page itself makes (`backend.isHorizonAdmin()`);
 * everyone else, and a build with the cloud off, sees nothing. A signed-out page asks nothing of the
 * database.
 */
import type { CloudBackend } from "@horizon36596/zenith-cloud";
import { SheetButton } from "../cloud/controls";
import { Group, Row } from "../settings/parts";

/** The admin page's route, as `admin/AdminRoute.tsx` follows it. */
export const ADMIN_DASHBOARD_HASH = "#/admin";

/** Whether the person signed in to `backend` is a Horizon admin. False with no cloud, signed out, or on an error. */
export async function isSignedInHorizonAdmin(backend: CloudBackend | null): Promise<boolean> {
  if (backend === null || backend.currentUser() === null) return false;
  return backend.isHorizonAdmin().catch(() => false);
}

/** Opens the admin page by its route, which `admin/AdminRoute.tsx` follows. */
export function openAdminDashboard(): void {
  window.location.hash = ADMIN_DASHBOARD_HASH;
}

/** The Admin section's content: nothing unless `admin`, else one row whose button opens the admin page. */
export function AdminDashboardEntry({ admin, onOpen }: { admin: boolean; onOpen: () => void }) {
  if (!admin) return null;
  return (
    <Group testId="account-admin">
      <Row
        label="Admin dashboard"
        description="Add beta testers and admins, and review shares and bug reports."
      >
        <SheetButton
          kind="primary"
          tooltip="Admin dashboard"
          hint="Opens the admin page and closes Settings."
          testId="account-admin-dashboard"
          onClick={onOpen}
        >
          Open admin dashboard
        </SheetButton>
      </Row>
    </Group>
  );
}
