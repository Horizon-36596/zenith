# Desktop files and recovery

This page describes the published 0.1.1 desktop app. The browser editor is covered in
[Getting started](getting-started.md).

## Open and save a robot project

Open **Menu** (`F10`), then **File > Open robot repo…**. Choose the folder containing `zenith.json`.
**File > Open Recent** lists projects opened before. The app tries to reopen the last project when
it starts.

`Ctrl+S` writes the open auto to that project. The bundled example and files opened through the
read-only picker download a copy instead; they do not become an editable project folder.

Opening another auto or closing normally with unsaved edits asks **Save**, **Discard** or **Cancel**.
A failed save cancels the close or switch. Check the status message before trying again.

## When another program changes a file

With no unsaved edits, the app reloads an outside change to the open auto. A change to the robot,
field, waypoints or project configuration reloads the project so the checks use the new inputs.

With unsaved edits, 0.1.1 shows a status message and keeps the editor's version. It does not merge
the two versions or offer a conflict-choice dialog. Saving the open auto can
overwrite the outside change. Keep a copy of the disk version before choosing which edits to retain;
reopen the project after discarding editor changes if you want the disk version.

## Run the high-fidelity simulation

Choose **Robot > Run high-fidelity sim** (`Ctrl+F5`). It runs the command configured under `sim` in
`zenith.json`, using the file on disk. With unsaved edits, the panel offers **Save and run**. Read its
output when the command fails; use **Robot > Cancel the sim** to stop a running command.

Install the project's JDK, Android SDK and dependencies before relying on this offline. A successful
run is evidence about the supplied simulation model, not a measurement from your robot.
[Simulation](simulation.md#high-fidelity-sim) explains configuration and traces.

## Deploy the auto

Choose **Robot > Deploy autos into the robot repo** (`Ctrl+Shift+D`), review the listed changes, then
choose **Deploy**. This copies assets and generates OpMode stubs when configured; it does not build
or install the APK. Build and install through Android Studio afterwards.
[Robot runtime](robot-runtime.md#deploy-autos) explains the required configuration.

## Git and GitHub

**Robot > Commit, push and open a pull request…** (`Ctrl+Shift+G`) shows the branch and changed autos.
The panel can use the GitHub CLI's login or a pasted token. On Windows with encryption available,
a pasted native-panel token is stored encrypted and can survive a restart. **Forget the saved token**
removes that copy.

In 0.1.1, this native Git panel and the browser-style GitHub-mode sign-in have separate credentials.
Clearing one does not clear the other. [Working with GitHub](github.md) describes GitHub mode.

## After a crash

The normal close prompt cannot protect edits when the process crashes. This version has no recovery
copy of unsaved edits. Reopen the project to load its saved files, and use Git history to recover
committed versions. Save before running external tools or making a large change.
