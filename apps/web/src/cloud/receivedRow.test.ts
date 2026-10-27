/**
 * A share made to the team, as one line of the Partners panel. Its safety code to compare is a
 * security step, so it shows without opening Details: on a first share from a team, from a team with
 * no number, and when the code changed. The version and the rest stay under Details.
 */
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { html, text } from "../account/keys/testMarkup";
import { ReceivedRow } from "./ReceivedShares";
import type { FromTeamCheck, ReceivedShare } from "./types";

const NOW_MS = Date.parse("2026-09-27T12:00:00Z");
const CODE = "0417 2958 3361 7720 5164";

const received = (fromTeamCheck: FromTeamCheck, patch: Partial<ReceivedShare> = {}): ReceivedShare => ({
  id: "shareA",
  audience: "teams",
  fromTeamNumber: 12345,
  fromTeamName: "Partner",
  fromTeamStatus: "unverified",
  fromTeamId: "team-partner",
  fromTeamCheck,
  teamIds: ["team-me"],
  level: "view",
  mode: "follow",
  revision: 2,
  revisionId: "000002-abc",
  expiresAt: "2026-10-27T12:00:00.000Z",
  updatedAt: "2026-09-27T09:00:00.000Z",
  projection: "{}",
  ...patch,
});

const drawn = (share: ReceivedShare): string => html(createElement(ReceivedRow, { share, nowMs: NOW_MS }));

describe("a received share's safety code", () => {
  it("shows on a first share from a team with Details closed", () => {
    const markup = drawn(received({ kind: "first-use", safetyCode: CODE }));
    expect(markup).toContain('data-testid="received-shareA-first"');
    expect(text(markup)).toContain(`First share from team 12345 on this device. Compare its safety code with them: ${CODE}.`);
    expect(markup).not.toContain('data-testid="received-shareA-more"');
  });

  it("shows for a team with no number with Details closed", () => {
    const markup = drawn(received({ kind: "no-number", safetyCode: CODE }, { fromTeamNumber: null }));
    expect(markup).toContain('data-testid="received-shareA-no-number"');
    expect(text(markup)).toContain(`This team has no number. Compare its safety code with them: ${CODE}.`);
  });

  it("is not shown for a team this device already knows", () => {
    expect(text(drawn(received({ kind: "known" })))).not.toContain("safety code");
  });
});
