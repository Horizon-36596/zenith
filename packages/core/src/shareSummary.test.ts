import { describe, expect, it } from "vitest";
import {
  EXPIRY_WARNING_DAYS,
  effectiveShareLevel,
  expiresSoon,
  instantMs,
  isShareActive,
  shareDateWords,
  shareSentence,
  sharingChip,
  timeLeftWords,
  type ShareAudience,
  type ShareLevel,
  type ShareMode,
  type ShareRecord,
  type ShareSettings,
} from "./shareSummary.js";

/**
 * The share dialog's sentence and the sharing chip (spec 13 section 8.4).
 * The M-C3 contract says the dialog's sentence matches the stored share for every combination of
 * level, audience, mode, expiry and whether command names are included; this file holds the sentence itself to that, over every
 * combination, and pins a golden list so a wording change is a reviewed change.
 */

const NOW = "2026-09-27T12:00:00Z";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const AUDIENCES: ReadonlyArray<{ audience: ShareAudience; teamNumbers: number[] }> = [
  { audience: "teams", teamNumbers: [12345] },
  { audience: "teams", teamNumbers: [12345, 23456] },
  { audience: "teams", teamNumbers: [12345, 23456, 34567] },
  { audience: "link", teamNumbers: [] },
];
const LEVELS: readonly ShareLevel[] = ["view", "propose"];
const MODES: readonly ShareMode[] = ["pinned", "follow"];
/** The "Include command names" checkbox: absent (a share made before it existed), off and on. */
const INCLUDES: ReadonlyArray<boolean | undefined> = [undefined, false, true];
const EXPIRIES: ReadonlyArray<{ name: string; at: string | null; until: string | null }> = [
  { name: "no end date", at: null, until: "until you stop sharing it" },
  { name: "later today", at: "2026-09-27T17:30:00Z", until: "until 17:30 today" },
  { name: "a date this year", at: "2026-10-04T12:00:00Z", until: "until Sun 4 Oct" },
  { name: "a date next year", at: "2027-05-03T12:00:00Z", until: "until Mon 3 May 2027" },
  { name: "a date that has passed", at: "2026-09-20T12:00:00Z", until: null },
];

function* everyCombination(): Generator<{ settings: ShareSettings; expiry: (typeof EXPIRIES)[number] }> {
  for (const who of AUDIENCES) {
    for (const level of LEVELS) {
      for (const mode of MODES) {
        for (const expiry of EXPIRIES) {
          for (const includeCommands of INCLUDES) {
            const settings: ShareSettings = { ...who, level, mode, expiresAt: expiry.at };
            yield { settings: includeCommands === undefined ? settings : { ...settings, includeCommands }, expiry };
          }
        }
      }
    }
  }
}

describe("shareSentence, over every combination of audience, level, mode, expiry and command names", () => {
  const all = [...everyCombination()];

  it("covers all 240 combinations", () => {
    expect(all).toHaveLength(AUDIENCES.length * LEVELS.length * MODES.length * EXPIRIES.length * INCLUDES.length);
  });

  for (const { settings, expiry } of all) {
    const names = settings.includeCommands === undefined ? "names unset" : settings.includeCommands ? "names on" : "names off";
    const name = `${settings.audience} ${String(settings.teamNumbers.length)}, ${settings.level}, ${settings.mode}, ${expiry.name}, ${names}`;

    it(`says exactly what the settings do: ${name}`, () => {
      const sentence = shareSentence(settings, NOW);
      const level = effectiveShareLevel(settings);

      expect(sentence).not.toMatch(/undefined|NaN|null|\s{2}|\.\./);
      expect(sentence.endsWith(".")).toBe(true);

      // Who: every team number, or anyone with the link, without signing in.
      if (settings.audience === "link") {
        expect(sentence).toContain("Anyone with the link");
        if (expiry.until !== null) expect(sentence).toContain("without signing in");
      } else {
        for (const team of settings.teamNumbers) expect(sentence).toContain(String(team));
        expect(sentence).toContain(settings.teamNumbers.length === 1 ? "Team 12345 " : "Teams 12345");
        expect(sentence).not.toContain("without signing in");
      }

      if (expiry.until === null) {
        // An ended share says so, and promises nothing about what they will see.
        expect(sentence.startsWith("This share has ended:")).toBe(true);
        expect(sentence).toContain("until Sun 20 Sep");
        expect(sentence).not.toContain("They will see");
        return;
      }

      // Until when.
      expect(sentence).toContain(expiry.until);
      // What they may do.
      expect(sentence.includes("propose changes to it")).toBe(level === "propose");
      expect(sentence.includes("They cannot propose changes.")).toBe(level === "view");
      // Which version.
      expect(sentence.includes("They will see this version:")).toBe(settings.mode === "pinned");
      expect(sentence.includes("the latest version")).toBe(settings.mode === "follow");
      // What they see, and what they never see.
      expect(sentence).toContain("where your robot drives and when");
      expect(sentence.includes("the order and shape of its steps")).toBe(level === "propose");
      if (settings.includeCommands === true) {
        expect(sentence).toContain("They will see command names and their settings, but not your code, notes or any robot settings.");
        expect(sentence).not.toContain("They will not see command names");
      } else {
        expect(sentence).toContain("They will not see command names, notes or any robot settings.");
        expect(sentence).not.toContain("They will see command names");
      }
    });
  }

  it("gives the same sentence for an ISO string and for epoch milliseconds", () => {
    for (const { settings } of all) {
      const asNumbers = {
        ...settings,
        expiresAt: settings.expiresAt === null ? null : instantMs(settings.expiresAt),
      };
      expect(shareSentence(asNumbers, instantMs(NOW))).toBe(shareSentence(settings, NOW));
    }
  });
});

describe("shareSentence, the golden list", () => {
  const view: ShareSettings = {
    audience: "teams",
    teamNumbers: [12345],
    level: "view",
    mode: "pinned",
    expiresAt: "2026-10-04T12:00:00Z",
  };

  const golden: ReadonlyArray<[ShareSettings, string]> = [
    [
      view,
      "Team 12345 can view this auto until Sun 4 Oct. They will see this version: where your robot drives and when. They will not see command names, notes or any robot settings. They cannot propose changes.",
    ],
    [
      { ...view, teamNumbers: [12345, 23456] },
      "Teams 12345 and 23456 can view this auto until Sun 4 Oct. They will see this version: where your robot drives and when. They will not see command names, notes or any robot settings. They cannot propose changes.",
    ],
    [
      { ...view, teamNumbers: [12345, 23456, 34567], mode: "follow" },
      "Teams 12345, 23456 and 34567 can view this auto until Sun 4 Oct. They will see the latest version, updated each time you publish: where your robot drives and when. They will not see command names, notes or any robot settings. They cannot propose changes.",
    ],
    [
      { ...view, level: "propose" },
      "Team 12345 can view this auto and propose changes to it until Sun 4 Oct. They will see this version: where your robot drives and when, and the order and shape of its steps. They will not see command names, notes or any robot settings. They can propose changes, and none is kept until you accept it.",
    ],
    [
      { ...view, level: "propose", mode: "follow", expiresAt: null },
      "Team 12345 can view this auto and propose changes to it until you stop sharing it. They will see the latest version, updated each time you publish: where your robot drives and when, and the order and shape of its steps. They will not see command names, notes or any robot settings. They can propose changes, and none is kept until you accept it.",
    ],
    [
      { ...view, expiresAt: "2026-09-27T17:30:00Z" },
      "Team 12345 can view this auto until 17:30 today. They will see this version: where your robot drives and when. They will not see command names, notes or any robot settings. They cannot propose changes.",
    ],
    [
      { ...view, expiresAt: "2027-05-03T12:00:00Z" },
      "Team 12345 can view this auto until Mon 3 May 2027. They will see this version: where your robot drives and when. They will not see command names, notes or any robot settings. They cannot propose changes.",
    ],
    [
      { ...view, audience: "link", teamNumbers: [] },
      "Anyone with the link can view this auto until Sun 4 Oct, without signing in. They will see this version: where your robot drives and when. They will not see command names, notes or any robot settings. They cannot propose changes.",
    ],
    [
      // A link is view only (section 8.1), so a stored "propose" on one is described as view.
      { ...view, audience: "link", teamNumbers: [], level: "propose", mode: "follow" },
      "Anyone with the link can view this auto until Sun 4 Oct, without signing in. They will see the latest version, updated each time you publish: where your robot drives and when. They will not see command names, notes or any robot settings. They cannot propose changes.",
    ],
    [
      { ...view, includeCommands: true },
      "Team 12345 can view this auto until Sun 4 Oct. They will see this version: where your robot drives and when. They will see command names and their settings, but not your code, notes or any robot settings. They cannot propose changes.",
    ],
    [
      { ...view, level: "propose", includeCommands: true },
      "Team 12345 can view this auto and propose changes to it until Sun 4 Oct. They will see this version: where your robot drives and when, and the order and shape of its steps. They will see command names and their settings, but not your code, notes or any robot settings. They can propose changes, and none is kept until you accept it.",
    ],
    [
      { ...view, includeCommands: false },
      "Team 12345 can view this auto until Sun 4 Oct. They will see this version: where your robot drives and when. They will not see command names, notes or any robot settings. They cannot propose changes.",
    ],
    [
      // "Include the auto's name" (spec 13 section 8.2) on its own.
      { ...view, includeTitle: true },
      "Team 12345 can view this auto until Sun 4 Oct. They will see this version: where your robot drives and when. They will see this auto's name, but not command names, notes or any robot settings. They cannot propose changes.",
    ],
    [
      { ...view, includeTitle: true, includeCommands: true },
      "Team 12345 can view this auto until Sun 4 Oct. They will see this version: where your robot drives and when. They will see this auto's name, command names and their settings, but not your code, notes or any robot settings. They cannot propose changes.",
    ],
    [
      // Off is exactly the sentence from before the option existed.
      { ...view, includeTitle: false },
      "Team 12345 can view this auto until Sun 4 Oct. They will see this version: where your robot drives and when. They will not see command names, notes or any robot settings. They cannot propose changes.",
    ],
    [
      { ...view, expiresAt: "2026-09-20T12:00:00Z" },
      "This share has ended: Team 12345 could view this auto until Sun 20 Sep, and no longer can. Extend it to share this auto again.",
    ],
    [
      { ...view, teamNumbers: [] },
      "Nobody outside your team can see this auto yet. Add a team number to share it with that team.",
    ],
    [
      // A team added twice is one team.
      { ...view, teamNumbers: [12345, 12345] },
      "Team 12345 can view this auto until Sun 4 Oct. They will see this version: where your robot drives and when. They will not see command names, notes or any robot settings. They cannot propose changes.",
    ],
  ];

  for (const [settings, sentence] of golden) {
    it(sentence.slice(0, 60), () => {
      expect(shareSentence(settings, NOW)).toBe(sentence);
    });
  }
});

describe("dates in the viewer's time zone", () => {
  it("reads the calendar day in UTC unless given an offset", () => {
    expect(shareDateWords("2026-10-04T23:30:00Z", NOW)).toBe("Sun 4 Oct");
    expect(shareDateWords("2026-10-04T23:30:00Z", NOW, { utcOffsetMinutes: 60 })).toBe("Mon 5 Oct");
    expect(shareDateWords("2026-10-04T00:30:00Z", NOW, { utcOffsetMinutes: -300 })).toBe("Sat 3 Oct");
  });

  it("shows the year only when it is not this year", () => {
    expect(shareDateWords("2026-12-31T12:00:00Z", NOW)).toBe("Thu 31 Dec");
    expect(shareDateWords("2027-01-01T12:00:00Z", NOW)).toBe("Fri 1 Jan 2027");
  });

  it("says today with a clock time in the viewer's zone", () => {
    const sentence = shareSentence(
      { audience: "teams", teamNumbers: [12345], level: "view", mode: "pinned", expiresAt: "2026-09-27T17:30:00Z" },
      NOW,
      { utcOffsetMinutes: 120 },
    );
    expect(sentence).toContain("until 19:30 today");
  });

  it("refuses a string that is not a date", () => {
    expect(() => instantMs("next Tuesday")).toThrow(/not a date/);
  });
});

const record = (patch: Partial<ShareRecord>): ShareRecord => ({
  audience: "teams",
  teamNumbers: [12345],
  level: "view",
  mode: "pinned",
  expiresAt: "2026-10-04T12:00:00Z",
  revokedAt: null,
  ...patch,
});

describe("sharingChip", () => {
  it("says Team only when nothing is shared, or everything shared has ended or been revoked", () => {
    expect(sharingChip([], NOW)).toEqual({ label: "Team only", tone: "team", lines: [] });
    const ended = [
      record({ expiresAt: "2026-09-26T12:00:00Z" }),
      record({ revokedAt: "2026-09-26T12:00:00Z" }),
      record({ audience: "link", teamNumbers: [], revokedAt: "2026-09-26T12:00:00Z" }),
    ];
    expect(sharingChip(ended, NOW).label).toBe("Team only");
  });

  it("counts distinct teams across every share in force", () => {
    expect(sharingChip([record({})], NOW)).toEqual({
      label: "Shared with 1 team",
      tone: "teams",
      lines: ["Team 12345 can view until Sun 4 Oct."],
    });
    const two = sharingChip(
      [record({}), record({ teamNumbers: [12345, 23456], level: "propose", expiresAt: null })],
      NOW,
    );
    expect(two.label).toBe("Shared with 2 teams");
    expect(two.tone).toBe("teams");
    expect(two.lines).toEqual([
      "Team 12345 can view until Sun 4 Oct.",
      "Teams 12345 and 23456 can view and propose with no end date.",
    ]);
  });

  it("puts anyone with the link first, and still lists the teams in the tooltip", () => {
    const chip = sharingChip([record({}), record({ audience: "link", teamNumbers: [] })], NOW);
    expect(chip.label).toBe("Anyone with the link");
    expect(chip.tone).toBe("link");
    expect(chip.lines).toEqual([
      "Team 12345 can view until Sun 4 Oct.",
      "Anyone with the link can view until Sun 4 Oct.",
    ]);
  });

  it("gives every state its own label and tone", () => {
    const states = [
      sharingChip([], NOW),
      sharingChip([record({})], NOW),
      sharingChip([record({ audience: "link", teamNumbers: [] })], NOW),
    ];
    expect(new Set(states.map((chip) => chip.tone)).size).toBe(3);
    expect(new Set(states.map((chip) => chip.label)).size).toBe(3);
  });
});

describe("expiry and time left", () => {
  const now = instantMs(NOW);

  it("warns from two days out until the moment it ends, and never for no end date", () => {
    expect(EXPIRY_WARNING_DAYS).toBe(2);
    expect(expiresSoon(null, NOW)).toBe(false);
    expect(expiresSoon(now + 2 * DAY + 1, NOW)).toBe(false);
    expect(expiresSoon(now + 2 * DAY, NOW)).toBe(true);
    expect(expiresSoon(now + 1, NOW)).toBe(true);
    expect(expiresSoon(now, NOW)).toBe(false);
    expect(expiresSoon(now - DAY, NOW)).toBe(false);
  });

  it("says the time left in whole units, rounded down", () => {
    expect(timeLeftWords(null, NOW)).toBe("No end date");
    expect(timeLeftWords(now, NOW)).toBe("Ended");
    expect(timeLeftWords(now + 59 * 60_000, NOW)).toBe("Under an hour left");
    expect(timeLeftWords(now + HOUR, NOW)).toBe("1 hour left");
    expect(timeLeftWords(now + 23.9 * HOUR, NOW)).toBe("23 hours left");
    expect(timeLeftWords(now + DAY, NOW)).toBe("1 day left");
    expect(timeLeftWords(now + 7.5 * DAY, NOW)).toBe("7 days left");
  });

  it("counts a share as active only before its expiry and while not revoked", () => {
    expect(isShareActive(record({}), NOW)).toBe(true);
    expect(isShareActive(record({ expiresAt: null }), NOW)).toBe(true);
    expect(isShareActive(record({ expiresAt: NOW }), NOW)).toBe(false);
    expect(isShareActive(record({ revokedAt: NOW }), NOW)).toBe(false);
  });

  it("treats every link as view only", () => {
    expect(effectiveShareLevel({ audience: "link", level: "propose" })).toBe("view");
    expect(effectiveShareLevel({ audience: "teams", level: "propose" })).toBe("propose");
  });
});
