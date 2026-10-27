# Allowing Zenith for students: a guide for Google Workspace admins

!!! note "Accounts are optional"
    Students need no account, and no approval, to use everything that works without one.

**For a teacher or coach to hand to the school's Google Workspace for Education admin.** One page.

## What Zenith is

Zenith is a free tool for planning the autonomous routines of FTC robots. It is made by Horizon
(FTC 36596), a nonprofit FTC robotics team. Students can use all of it with no account. An account is
optional; it lets a team keep its autos in a shared team library and share them with other teams.

When a student chooses **Sign in with Google**, Zenith asks Google only for basic sign-in (Google's
`profile` scope): the student's name, email address and profile picture. It asks for no access to
Gmail, Drive, Calendar, Classroom or any other Google data. What Zenith keeps is in its [privacy notice](privacy.md). Zenith does not ask
a student's age: its [terms](terms.md#who-can-have-an-account) allow an account for anyone 13 or older,
and for a student of any age who signs in with a school account the school has approved for Zenith.

## School laptops and the team's data

A team's autos in Zenith's cloud are encrypted on the students' devices, so neither Horizon nor the
school can read them, and there is no administrator reset. On a school laptop that students share, they
choose **This is a shared computer** when they sign in: Zenith then keeps no offline copy and no keys
after the app is closed, and a teammate approves the laptop again each time. If the school wipes its
laptops, for example over the summer, the team unlocks its library again with the printed **recovery
code** it was given when it made the team, so please leave that page with the coach or in the team
binder. More in [Keys and your team](teams-and-sharing.md#keys-and-your-team).

## Why students may be blocked

Since October 2023, Google Workspace for Education stops users the admin has marked as under 18 from
signing in to third-party apps the school has not configured. So a student may see an "access
blocked" message when they choose Sign in with Google in Zenith, while an adult at the same school
can sign in.

## What to change (about five minutes)

Do one of these in the Google Admin console. Choose the smallest change your school's policy allows.
Google's own help article on this setting is
<https://support.google.com/a/answer/13288950>; menu names can shift slightly over time, and that
article is the one to trust if they differ from the steps below.

### Option A: configure Zenith as a trusted or limited app (recommended)

1. Sign in to the [Google Admin console](https://admin.google.com) as an admin.
2. Go to **Security**, then **Access and data control**, then **API controls**.
3. Choose **Manage third-party app access**.
4. **Configure new app**, then search for Zenith by its **OAuth client ID** (below).
5. Choose the organizational unit or group your students are in, or the whole school.
6. Set the access to **Trusted** or **Limited**. Either works for Zenith, because Zenith requests
   nothing beyond sign-in. If your school prefers the narrower setting, choose **Limited**.
7. Save. The change can take some time to reach every account.

### Option B: allow apps that only use Google Sign-In

In the same place, under the settings for **unconfigured third-party apps**, you can choose to let
users under 18 use unconfigured apps **that only request Google Sign-In**. This allows Zenith and any
other app that asks only for sign-in, without configuring each app.

## Zenith's OAuth client ID

Zenith's Google sign-in client ID, to allow or trust in the Admin console:

```
1076313541263-gasvvqmbivlp9vk73psd59uusrcrccvp.apps.googleusercontent.com
```

## If you would rather not change anything

Students do not need Google sign-in. Zenith also accepts:

- **GitHub**, which many FTC teams already use for their robot code;
- **Microsoft**, including a school Microsoft account where the school allows it, or a personal one.

And every part of Zenith that does not need an account works with no sign-in at all.

## Questions

Write to [privacy@horizon36596.org](mailto:privacy@horizon36596.org), or contact Horizon any other way
the [privacy notice](privacy.md#contact-us) describes.
