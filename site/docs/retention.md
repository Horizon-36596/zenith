# Retention policy

**Effective: 25 October 2026.**

This page says how long Zenith keeps each kind of data, and how it gets deleted. It goes with the
[privacy notice](privacy.md).

Zenith has no server of its own. The database's access rules decide who may read or delete each
record, and they do not let the app delete some records at all, such as an auto's past versions and
shares. That keeps history safe from mistakes. The deletions that come after a waiting period are
done by an **automatic clean-up that runs every day**, and a few are **done by hand by a Horizon
admin**. The table says which.

## How long we keep each thing

| data | how long | how it is deleted |
|---|---|---|
| **Your account** (display name, sign-in record) | until you delete it | **You, in the app, at once.** The app deletes your profile, your team memberships and your sign-in account in one step. |
| **What is left of a deleted account** | **purged within 30 days** | **The daily clean-up.** Deleting your account in the app removes your profile and memberships at once, and the next clean-up removes any bug reports you sent. If an account is deleted any other way (for example by an admin, when you ask us to), the next clean-up removes the profile and team memberships it left, its bug reports, its devices' records, the team keys given to those devices and its requests for team keys; a team that loses such a key is asked to change its key. Records your team keeps (autos you published, activity log entries, shares and proposals you made, steps of a team-number claim's history) carry your account id, a random string that no longer leads to your name, and stay. |
| **A team's members, invites, settings, inbox, activity log and library** | until the team is deleted | **An owner, in the app, at once.** Deleting a team deletes all of these. See [When you delete a team](#when-you-delete-a-team). |
| **A deleted team's shares** | kept as records, like any other revoked share (see the row for shares below) | Deleting a team revokes its shares at once, so no other team can open them. |
| **A team-number claim with review history**, once its team is deleted | kept, no longer tied to the deleted team | **By hand, by an admin**, who can release the number. A claim with no history beyond the claim itself is deleted with the team. |
| **Autos and their versions** in a team library | as long as the team keeps them, or until the team is deleted | **By hand, by an admin, when the team asks**, or with the whole library when an owner deletes the team. The database lets a team's owners and admins delete an auto, but the app has no button for it yet, and an auto's past versions cannot be deleted from the app on their own. |
| **Shares that have ended or been revoked** | **kept 30 days after they end, then deleted at the next clean-up** | **The daily clean-up.** The moment a share ends or is revoked, the other team can no longer open it. The record stays for 30 days so your team can still see it on the Sharing page; the Horizon admins can see it too (see the [privacy notice](privacy.md#what-we-collect-and-why)). The receiving team's inbox keeps its pointer to the share (the share's id, the sharing team and when it arrived), which leads nowhere once the share is deleted, until that team removes it or is deleted. |
| **Invites that have expired or been revoked** | kept 30 days after they end, then deleted at the next clean-up | **The daily clean-up.** An expired or revoked invite can never add anyone. |
| **Proposals** | as long as the share they were sent on | The daily clean-up, with the share. |
| **Requests for more time** (kept under the share they ask about) | as long as the share they were made on | The daily clean-up, with the share. |
| **Team-number disputes, once decided** | **one FTC season** after the decision | **By hand, by an admin.** Nothing in Zenith records when a season ends, so this is not automatic. |
| **Bug reports** you send from **Help**, **Report a bug** | **30 days after a Horizon admin closes the report, and never more than 90 days after you sent it** | **The daily clean-up.** It also deletes every report of an account that no longer exists, at its next run. You cannot read a report back once it is sent, so to have one deleted sooner, ask us (see [Contact us](privacy.md#contact-us)). |
| **A request for beta access**, only if you sent one before 3 October 2026, when the app stopped taking them (your account id, the name you typed and your sign-in email, if your account has one) | **never more than 30 days** | **Deleted when a Horizon admin adds you** by your user code. **The daily clean-up** deletes the rest 30 days after they were sent, and the request of an account that no longer exists. |
| **The beta tester list**, during the private beta (your account id and a name, typed by a Horizon admin or from a request sent before 3 October 2026) | until your account is deleted, or a Horizon admin takes you off the list | **The daily clean-up**, with what is left of a deleted account, or **by an admin** on the review page, who takes a tester off the list. |
| **Horizon's admin access log** (which admin read or changed a team's data, when, what and why) | **1 year**, then deleted | By hand, by an admin. |
| **Request logs** (IP addresses and similar) kept by Google Firebase and GitHub Pages | **no longer than each provider's default** | By the provider. We do not copy or keep them. |
| **The copy of your team's library on your device** | until you sign out | **The app, when you sign out.** See [Using a shared computer](privacy.md#using-a-shared-computer). |

## The daily clean-up, and what is still by hand

Firebase's free plan, which Zenith uses so that it costs nothing, has no server code. So the clean-up
runs **once a day** as a scheduled GitHub Action in Zenith's public repository, not in Firebase:

- It deletes shares and invites that ended more than 30 days before, with the proposals and requests
  for more time under those shares. For any account that no longer exists, it deletes the profile and
  team memberships it left, its devices' records, the team keys given to those devices and its requests
  for team keys, in every team it was ever in, and asks each team that held such a key to change its
  key, and its entry on the beta tester list and its request for beta access. It deletes a request
  for beta access 30 days after it was sent. It deletes a bug report 30 days after it was closed, or 90 days after it was sent, whichever
  comes first, and every report of an account that no longer exists. That is what keeps the
  promises above.
- It deletes nothing else. Team libraries, activity logs, the record that a deleted team existed,
  team-number claims and their history, disputes and the admin access log are never touched by it.
- If a run fails, or GitHub skips a day, nothing is lost and nothing is kept for good: the next run
  finds everything that is due and deletes it then. GitHub tells us when a run fails.

Still done by hand by a Horizon admin:

- **At the start of each FTC season**, an admin deletes the disputes decided during the season before
  last.
- **On request**, sooner. If you ask us to delete something (see
  [Contact us](privacy.md#contact-us)), we do it within 30 days.

## Copies other teams hold

When another team opens something you shared, their app keeps a copy on their device so it works
offline. When a share ends, it closes on their device when the end time passes on their clock. When
you revoke a share, it disappears from their device at its next sync; until then they can still open
what they already downloaded. We cannot reach into another team's computer.

## Backups

We do not make backups of the database. Once something is deleted, it is gone, including for us.

## When you delete a team

Deleting a team deletes its members, invites, settings, activity and library. Its shares are revoked
and kept as records. A team-number claim with review history is kept, detached from the deleted team.
A deleted team's id is never reused. Horizon admin access is logged.

A share to other teams, or an anyone-with-the-link share, stops opening at once, as if you had revoked
it on the Sharing page. As with any revoked share, a copy another team already opened stays on their
device until its next sync, and the share's record follows the row for ended and revoked shares
above.
