# Desktop files, simulation and recovery

The Windows app has the same editor as the web app, with access to local folders, your robot
repository's simulator, deployment and Git. [Getting started](getting-started.md) covers installation.

## Save to the right place

Open your robot repository with **Open a folder…**. Once it is open, `Ctrl S` writes the auto there.
The dot after the auto's name means there are unsaved edits. If a save fails, keep the window open,
read the error, fix the file permission, missing folder or full disk, and save again.

The bundled example is read only. Save asks whether to create a **Full project** in a new, empty
folder or save **Just this auto** into an existing project. A full project includes the robot, field
and waypoints the autos need. See [Saving the example](editor.md#saving-the-example-or-files-opened-on-their-own).
**Save a copy** and picture downloads use a native Save dialog. Cancelling that dialog leaves the
destination unchanged; Zenith reports a save only after it writes the file.

## When a file changes outside Zenith

The app watches the project files. If a file changes on disk while you have unsaved edits, it offers:

- **Keep mine** to keep your edits in the editor. Review the outside change before saving over it.
- **Reload from disk** to replace the open version with the file on disk.

This is a choice between versions, not a merge tool. Use your repository's diff to compare changes
when both versions matter.

## Run the high-fidelity sim

The project needs a `sim` section in `zenith.json`, Java and the robot repository's headless test
setup. [Full sim with SimLoop](full-sim-simloop.md) walks through that setup. The first Gradle run may
download dependencies.

Open **Run high-fidelity sim**. If the auto has unsaved edits, choose **Save and run** when asked
so the simulator reads the file you just edited. Run the sim, read its output, then inspect the
recorded run at the **Full sim** playback level. **Cancel** stops a running sim; cancelling does not
produce a successful result.

If Java, `gradlew` or the configured program is missing, fix the prerequisite named in the message
and run again. A sim that exits without a readable trace cannot provide Full sim playback.

## Deploy and review the generated files

**Deploy autos into the robot repo** previews the files that would change. Set
`deploy.commandLibrary` to `solverslib` or `ivy` and provide the robot class your project uses before
writing Java. Save unsaved auto edits when prompted. Review the preview before writing, then build
and test the robot project. [Robot runtime](robot-runtime.md) explains the runtime and generated code.

If deployment skips an auto, read the warning and fix that auto before treating the project as
fully deployed. A running deployment has no Cancel button; let it finish and inspect the result.

## Commit, push and open a pull request

The Git panel names the next available action and explains disabled actions. You need Git installed
and a local repository. Opening a pull request also needs the GitHub CLI installed and signed in;
use **Check again** after fixing either prerequisite.

Commit asks to save unsaved edits first. **Open pull request** pushes the branch before opening the
PR, so it needs a network connection. You can close the panel while an action runs; its outcome then
appears on the status line. A failed push leaves the local commit available to retry.

GitHub repository access and team-library accounts serve different purposes. Follow the sign-in
dialog's explanation of which access is needed. A network error reaching GitHub does not, by
itself, mean your token was refused.

## Recover a stopped editor

If the editor page crashes or stops responding, the desktop app offers **Reload**, **Save edits as…**
and **Close Zenith**. Reload restores the draft held by the running app as unsaved edits. Save edits
as writes a copy you can open later.

That draft is held in memory for the running app. It is not a backup after an app exit, power loss or
system restart. Save files to disk and use Git for history.

Closing while a sim, deployment or Git action is running asks whether to close anyway. Wait for the
result when you need to know whether it completed. After an interrupted push or PR action, check
the branch on GitHub before retrying.

For a bug report, open **Help**, **Report a bug**. Include the version from **About**, what you were
doing, and the error sentence. Review the report and any optional auto snapshot before sending it.
