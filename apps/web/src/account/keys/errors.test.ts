/**
 * The key errors the cloud client throws (no-key, tampered, key-changed, wrong-code) read as plain
 * sentences wherever the app shows a failure: the account sheets and the sharing screens.
 */
import { describe, expect, it } from "vitest";
import { CannotRotateError, CloudError } from "@horizon36596/zenith-cloud";
import { sharingErrorSentence } from "../../cloud/cloudSharingApi";
import { KEY_ERRORS, keyErrorSentence } from "./errors";

const cloudError = (code: string, message: string): Error => Object.assign(new Error(message), { name: "CloudError", code });

describe("the key errors in plain words", () => {
  it("says what happened and what to do, not what the client checked", () => {
    const tampered = new CloudError("tampered", "The team's public key is not the one its key records hold.");
    expect(keyErrorSentence(tampered)).toBe(KEY_ERRORS.tampered);
    expect(sharingErrorSentence(tampered)).toBe(KEY_ERRORS.tampered);
    const noKey = new CloudError("no-key", "No grant for device abc at kv 3.");
    expect(keyErrorSentence(noKey)).toBe(KEY_ERRORS.noKey);
    expect(sharingErrorSentence(noKey)).toBe(KEY_ERRORS.noKey);
    expect(keyErrorSentence(cloudError("wrong-code", "x"))).toBe(KEY_ERRORS.wrongCode);
  });

  it("keeps the client's key-changed sentence when it names the safety code, and a plain one otherwise", () => {
    const named = new CloudError("key-changed", "A team you are sharing with shows a different key. Compare its safety code, 1234 5678 9012 3456 7890, with that team before sharing with it.");
    expect(keyErrorSentence(named)).toBe(named.message);
    expect(keyErrorSentence(new CloudError("key-changed", "pin mismatch"))).toBe(KEY_ERRORS.keyChanged);
  });

  it("explains why a device cannot make the team's new key, whatever the client's own sentence", () => {
    expect(keyErrorSentence(new CannotRotateError())).toBe(KEY_ERRORS.cannotRotate);
    expect(keyErrorSentence(Object.assign(new Error("x"), { name: "CannotRotateError", code: "permission-denied" }))).toBe(KEY_ERRORS.cannotRotate);
  });

  it("leaves every other failure to its caller, and never throws on odd values", () => {
    expect(keyErrorSentence(new CloudError("permission-denied", "No."))).toBeNull();
    expect(keyErrorSentence(new Error("plain"))).toBeNull();
    expect(keyErrorSentence(undefined)).toBeNull();
    expect(keyErrorSentence("no-key")).toBeNull();
    for (const sentence of Object.values(KEY_ERRORS)) expect(sentence).toMatch(/^[A-Z].*\.$/);
  });
});
