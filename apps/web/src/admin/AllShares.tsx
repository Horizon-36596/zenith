/**
 * The admin dashboard's All shares view (spec 13 section 13): every share of every team, newest
 * first, with filters for status and audience and a search over team numbers and names. It shows a
 * share's settings and the teams it involves, and never what the share shows: Horizon admins must
 * never see a team's paths (the owner's ruling of 2026-09-28), so nothing here reads, decodes or
 * draws a share's projection, its title or its command names. The view changes nothing, because
 * the database lets an admin change a share only through a team role.
 *
 * It fills the review page's two panes: the list on the left, and on the right a note of what an
 * admin can and cannot see, with any error.
 */
import { useEffect, useMemo, useState } from "react";
import { Ban, CircleCheck, Clock, Trash, type LucideIcon } from "lucide-react";
import type { CloudBackend, ShareSummary as Share, Team } from "@horizon36596/zenith-cloud";
import { STATUS_DOES, STATUS_WORDS } from "../account/words";
import { Tooltip } from "../components/Tooltip";
import { StatusBadge, TextField } from "./controls";
import { Segmented } from "../components/Segmented";
import { logAdminAccess } from "./store";
import {
  countWords,
  filterShareRows,
  NO_FILTERS,
  SHARE_STATUS_WORDS,
  shareRows,
  shareTeamIds,
  type AudienceFilter,
  type ShareFilters,
  type ShareRow,
  type ShareStatus,
  type StatusFilter,
} from "./shares";
import styles from "./admin.module.css";
import { cloudErrorSentence } from "../cloud/errorSentence";

const STATUS_ICONS: Record<ShareStatus, LucideIcon> = {
  live: CircleCheck,
  expired: Clock,
  revoked: Ban,
  "team-deleted": Trash,
};

const STATUS_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string; does: string }> = [
  { value: "all", label: "All", does: "Shows shares in every state." },
  { value: "live", label: "Live", does: "Shows the shares other teams can open now." },
  { value: "expired", label: "Expired", does: "Shows the shares whose end time has passed." },
  { value: "revoked", label: "Revoked", does: "Shows the shares their team revoked." },
  { value: "team-deleted", label: "Team deleted", does: "Shows the shares of teams that were deleted, and the shares to teams that were all deleted." },
];

const AUDIENCE_OPTIONS: ReadonlyArray<{ value: AudienceFilter; label: string; does: string }> = [
  { value: "all", label: "All", does: "Shows every share, whoever it is for." },
  { value: "teams", label: "Teams", does: "Shows the shares made to specific teams." },
  { value: "link", label: "Link", does: "Shows the shares anyone with the link can open." },
];

function message(error: unknown): string {
  return cloudErrorSentence(error);
}

/** A share's state as an icon and a word, with what it means in the tooltip; never colour alone. */
function ShareStatusBadge({ status, testId }: { status: ShareStatus; testId?: string }) {
  const Icon = STATUS_ICONS[status];
  const words = SHARE_STATUS_WORDS[status];
  return (
    <Tooltip label={words.label} hint={words.meaning}>
      <span className={styles.badge} data-share-status={status} tabIndex={0} data-testid={testId}>
        <Icon size={12} strokeWidth={1.75} aria-hidden />
        {words.label}
      </span>
    </Tooltip>
  );
}

function ShareListRow({ row }: { row: ShareRow }) {
  return (
    <li className={styles.shareRow} data-testid={`admin-share-${row.id}`} data-status={row.status}>
      <span className={styles.shareHead}>
        <span className={styles.sideName} data-testid="admin-share-owner">{row.owner}</span>
        {row.ownerStatus === null ? null : (
          <StatusBadge badge={{ status: row.ownerStatus, label: STATUS_WORDS[row.ownerStatus], meaning: STATUS_DOES[row.ownerStatus] }} />
        )}
        <span className={styles.spacer} />
        <ShareStatusBadge status={row.status} testId="admin-share-status" />
      </span>
      <span className={styles.mono} data-testid="admin-share-id">{row.shortId}</span>
      <span className={styles.meta}>
        <span data-testid="admin-share-audience">{row.audience}</span>
        <span data-testid="admin-share-level">{row.level}</span>
        <span data-testid="admin-share-version">{row.version}</span>
      </span>
      <span className={styles.times}>
        <span>{row.expiryLabel}</span>
        <span className={styles.mono} data-testid="admin-share-expiry">{row.expiry}</span>
        <span>Created</span>
        <span className={styles.mono}>{row.created}</span>
        <span>Updated</span>
        <span className={styles.mono}>{row.updated}</span>
      </span>
    </li>
  );
}

export function AllShares({ backend, generation, now }: { backend: CloudBackend; generation: number; now: () => Date }) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [teams, setTeams] = useState<ReadonlyMap<string, Team | null>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ShareFilters>(NO_FILTERS);
  // Statuses are worked out at the moment the list was read, and again on each refresh.
  const [readAtMs, setReadAtMs] = useState(() => now().getTime());

  // Reads every share and names their teams, again on each refresh. `now` is not a dependency: the
  // page passes a new function on each render, and the refresh button is what reads the clock again.
  useEffect(() => {
    let live = true;
    void (async () => {
      setError(null);
      try {
        await logAdminAccess(backend, "shares.list");
        const next = await backend.listAllShares();
        const ids = shareTeamIds(next);
        const found = await Promise.all(ids.map(async (id) => [id, await backend.getTeam(id).catch(() => null)] as const));
        if (!live) return;
        setShares(next);
        setTeams(new Map(found));
        setReadAtMs(now().getTime());
      } catch (err) {
        if (live) setError(message(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [backend, generation]);

  const rows = useMemo(() => (shares === null ? [] : shareRows(shares, teams, readAtMs)), [shares, teams, readAtMs]);
  const shown = filterShareRows(rows, filters);

  return (
    <>
      <div className={styles.queue}>
        <div className={styles.section}>
          <h3 className={styles.sectionHead}>Every team&apos;s shares</h3>

          <div className={styles.filters}>
            <span className={styles.field}>
              Status
              <Segmented
                label="Status"
                options={STATUS_OPTIONS}
                value={filters.status}
                onChange={(status) => {
                  setFilters({ ...filters, status });
                }}
                testId="admin-shares-status"
              />
            </span>
            <span className={styles.field}>
              Who it is for
              <Segmented
                label="Who it is for"
                options={AUDIENCE_OPTIONS}
                value={filters.audience}
                onChange={(audience) => {
                  setFilters({ ...filters, audience });
                }}
                testId="admin-shares-audience"
              />
            </span>
            <TextField
              label="Search teams"
              tooltip="Matches the number or name of the team that shared, and of every team a share names."
              value={filters.search}
              onChange={(search) => {
                setFilters({ ...filters, search });
              }}
              placeholder="36596 or Horizon"
              testId="admin-shares-search"
            />
          </div>
          {shares === null ? (
            error === null ? <p className={styles.prose}>Loading every share…</p> : null
          ) : (
            <>
              <p className={styles.hint} data-testid="admin-shares-count">{countWords(shown.length, rows.length)}</p>
              {shown.length === 0 ? (
                <p className={styles.prose} data-testid="admin-shares-empty">
                  {rows.length === 0 ? "No team has shared an auto yet." : "No share matches these filters."}
                </p>
              ) : (
                <ul className={styles.list} data-testid="admin-shares">
                  {shown.map((row) => (
                    <ShareListRow key={row.id} row={row} />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
      <div className={styles.detail}>
        {error === null ? null : <p className={styles.error} data-testid="admin-error">{error}</p>}
        <div className={styles.section} data-testid="admin-shares-note">
          <h3 className={styles.sectionHead}>What stays private</h3>
          <p className={styles.prose}>
            What a share shows, its paths, title and commands, is for the teams it names and never for Horizon admins.
          </p>
        </div>
      </div>
    </>
  );
}
