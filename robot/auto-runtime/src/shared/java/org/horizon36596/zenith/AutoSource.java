/*
 * MIT License
 *
 * Copyright (c) 2026 Horizon (FTC 36596)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
 * OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

package org.horizon36596.zenith;

import android.content.Context;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;

/**
 * Where an auto file's bytes come from. Two implementations, one per place the runtime runs.
 *
 * <p><b>On the robot</b> the files are inside the APK, under {@code assets/autos/}, and are read through
 * {@code hardwareMap.appContext.getAssets()}. That is {@link #assets(Context)} and it is what
 * each runtime's {@code AutoFromFile} uses unless told otherwise.
 *
 * <p><b>In a headless sim</b> there is no APK and no {@code Context}; a fake hardware map has no
 * {@code appContext} to hand out. The test reads the same JSON straight out of the source tree with
 * {@link #directory(File)} and hands it to the OpMode through {@code AutoFromFile.setAutoSource(...)}
 * before init: an interface with a robot implementation and a headless one, assigned before
 * {@code init}, the same shape as {@link RobotClock}.
 *
 * <p>An implementation must be deterministic and must not read a clock. Both of these are.
 */
public interface AutoSource {

    /**
     * Open one file by its name within the autos folder, for example {@code "first-auto.auto.json"} or
     * {@code "waypoints.json"}. The caller closes the stream.
     *
     * @param fileName a file name inside the autos folder
     * @return the open stream
     * @throws java.io.FileNotFoundException when this source does not have that file
     * @throws IOException when the file exists and cannot be opened
     */
    InputStream open(String fileName) throws IOException;

    /** @return where this source reads from, for an error message a human can act on */
    String describe();

    /**
     * The APK's {@code assets/autos/} folder. The robot's source.
     *
     * @param appContext the OpMode's {@code hardwareMap.appContext}
     * @return a source reading the APK's assets
     */
    static AutoSource assets(final Context appContext) {
        if (appContext == null) {
            throw new IllegalStateException(
                    "no Android context to read assets from. On the robot hardwareMap.appContext is"
                            + " set by the SDK; off the robot call AutoFromFile.setAutoSource("
                            + "AutoSource.directory(dir)) before the OpMode is initialised.");
        }
        return new AutoSource() {
            @Override
            public InputStream open(String fileName) throws IOException {
                return appContext.getAssets().open("autos/" + fileName);
            }

            @Override
            public String describe() {
                return "the APK's assets/autos/";
            }
        };
    }

    /**
     * A folder on disk. A headless sim's source, for example {@code TeamCode/src/main/assets/autos}.
     *
     * @param dir the folder holding the auto files and {@code waypoints.json}
     * @return a source reading that folder
     */
    static AutoSource directory(final File dir) {
        return new AutoSource() {
            @Override
            public InputStream open(String fileName) throws IOException {
                File file = new File(dir, fileName);
                if (!file.isFile()) {
                    throw new FileNotFoundException(file.getAbsolutePath()
                            + " does not exist. The auto files live in the project's autos/ folder"
                            + " and zenith deploy copies them into TeamCode/src/main/assets/autos/;"
                            + " run zenith deploy, or copy them by hand.");
                }
                return new FileInputStream(file);
            }

            @Override
            public String describe() {
                return dir.getAbsolutePath();
            }
        };
    }
}
