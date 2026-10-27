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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

import java.util.Arrays;

class AutoTraceTest {

    /** A run of a sim that checks contacts and counts pieces, with one of each record. */
    private static AutoTrace fullRun() {
        AutoTrace trace = new AutoTrace("sample-auto", 0.02);
        trace.sha("abc123");
        trace.capability(AutoTrace.STRUCTURE_CONTACTS);
        trace.capability(AutoTrace.LEDGER);
        trace.tick(0.0);
        trace.stepStarted("volley1");
        trace.pose(-40.0, -63.0, 1.5708);
        trace.tick(2.61);
        trace.stepEnded("volley1", false);
        trace.ledger().held(1).launches(3).tips("RED", 0);
        trace.tick(6.3);
        trace.event("tipStarted", "RED");
        trace.event("matchPaused");
        trace.tick(12.4);
        trace.structureContact("hiveRedPivotBar", 1.3);
        trace.ledger().tips("RED", 1).tips("BLUE", 0);
        return trace;
    }

    @Test
    void writesContactsLedgerAndEventsAtTheirTicks() {
        String text = fullRun().render();
        assertTrue(text.contains(
                "{ \"timeS\": 12.400, \"obstacle\": \"hiveRedPivotBar\", \"penetrationIn\": 1.300 }"), text);
        assertTrue(text.contains(
                "{ \"timeS\": 2.610, \"held\": 1, \"launches\": 3, \"tips\": { \"RED\": 0 } }"), text);
        assertTrue(text.contains("{ \"timeS\": 12.400, \"tips\": { \"RED\": 1, \"BLUE\": 0 } }"), text);
        assertTrue(text.contains("{ \"timeS\": 6.300, \"kind\": \"tipStarted\", \"alliance\": \"RED\" }"), text);
        assertTrue(text.contains("{ \"timeS\": 6.300, \"kind\": \"matchPaused\" }"), text);
    }

    /** What the trace format defines, read back by the runtime's own strict JSON reader. */
    @Test
    void theTraceIsJsonInTheTraceFormat() {
        Json root = Json.parse(fullRun().render(), "sample-auto.trace.json");
        assertEquals(AutoTrace.FORMAT_VERSION, root.integer("formatVersion"));
        assertEquals("abc123", root.str("sha"));
        assertEquals(Arrays.asList("formatVersion", "auto", "sha", "simTimeS", "tickS", "capabilities",
                "steps", "poses", "truthPoses", "structureContacts", "ledger", "events"), root.keys());

        Json contact = root.get("structureContacts").at(0);
        assertEquals("hiveRedPivotBar", contact.str("obstacle"));
        assertEquals(1.3, contact.num("penetrationIn"));

        Json ledger = root.get("ledger");
        assertEquals(2, ledger.size());
        assertEquals(3, ledger.at(0).integer("launches"));
        assertFalse(ledger.at(1).has("held"), "an unset value is left out, not written as zero");
        assertEquals(Arrays.asList("RED", "BLUE"), ledger.at(1).get("tips").keys());

        Json events = root.get("events");
        assertEquals(2, events.size());
        assertFalse(events.at(1).has("alliance"));
    }

    /** A clean run has no contacts, and its declared capability is what says they were checked. */
    @Test
    void declaredCapabilitiesSurviveARunThatRecordedNone() {
        AutoTrace trace = new AutoTrace("clean", 0.02);
        trace.capability(AutoTrace.STRUCTURE_CONTACTS);
        trace.capability(AutoTrace.LEDGER);
        trace.tick(0.0);
        trace.pose(0.0, 0.0, 0.0);
        String text = trace.render();
        assertTrue(text.contains(
                "\"capabilities\": [\"steps\", \"structureContacts\", \"ledger\", \"poses\"]"), text);
        assertTrue(text.contains("\"structureContacts\": [],\n  \"ledger\": [],\n  \"events\": []\n}"), text);
    }

    @Test
    void recordingAddsItsCapability() {
        AutoTrace trace = new AutoTrace("auto", 0.02);
        trace.structureContact("wall", 0.5);
        trace.ledger().held(2);
        trace.event("tipStarted");
        Json capabilities = Json.parse(trace.render(), "auto.trace.json").get("capabilities");
        assertEquals(4, capabilities.size());
        assertEquals("structureContacts", capabilities.at(1).text());
        assertEquals("ledger", capabilities.at(2).text());
        assertEquals("events", capabilities.at(3).text());
    }

    /** Without a sha and with nothing beyond steps, the trace is what it always was. */
    @Test
    void anUnsetShaIsLeftOut() {
        AutoTrace trace = new AutoTrace("auto", 0.02);
        assertFalse(trace.render().contains("\"sha\""));
    }

    @Test
    void namesWithQuotesAndControlCharactersStayValidJson() {
        AutoTrace trace = new AutoTrace("auto", 0.02);
        trace.event("say \"hi\"\n", "RED\\BLUE");
        Json event = Json.parse(trace.render(), "auto.trace.json").get("events").at(0);
        assertEquals("say \"hi\"\n", event.str("kind"));
        assertEquals("RED\\BLUE", event.str("alliance"));
    }

    @Test
    void twoRunsProduceTheSameTraceByteForByte() {
        assertEquals(fullRun().render(), fullRun().render());
    }
}
