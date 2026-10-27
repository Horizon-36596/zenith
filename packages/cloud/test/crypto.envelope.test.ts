/**
 * The byte helpers, the AAD builders and the AES-256-GCM envelope (spec 14 section 4.1): round
 * trips, and every way of opening with the wrong thing throwing a typed error rather than returning
 * garbage.
 */
import { describe, expect, it } from "vitest";
import {
  aadFor,
  base64urlDecode,
  base64urlEncode,
  bytesEqual,
  CryptoError,
  DEFAULT_MAX_PLAINTEXT_BYTES,
  openBytes,
  openJson,
  openText,
  sealBytes,
  sealJson,
  sealText,
  sortedJson,
  toBytes,
  utf8Decode,
  utf8Encode,
  type Envelope,
  type VersionedKey,
} from "../src/crypto/index.js";
import { counting, flip, rejectsWith, throwsWith } from "./cryptoHelpers.js";

async function aesKey(version = 1, fill = 7): Promise<VersionedKey> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32).fill(fill), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { version, key };
}

const aad = aadFor.revision({ teamId: "t1", autoId: "a1", revisionId: "000004-abcdEFGH", field: "content", kv: 1 });

describe("base64url", () => {
  it("round-trips every length from 0 to 40 bytes without padding", () => {
    for (let n = 0; n <= 40; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);
      const text = base64urlEncode(bytes);
      expect(text).not.toMatch(/[=+/]/);
      expect(text.length).toBe(Math.ceil((n * 8) / 6));
      expect(base64urlDecode(text)).toEqual(bytes);
    }
  });

  it("matches Node's base64url for the RFC 4648 test strings", () => {
    for (const text of ["", "f", "fo", "foo", "foob", "fooba", "foobar"]) {
      expect(base64urlEncode(utf8Encode(text))).toBe(Buffer.from(text).toString("base64url"));
    }
    const all = new Uint8Array(256).map((_, i) => i);
    expect(base64urlEncode(all)).toBe(Buffer.from(all).toString("base64url"));
  });

  it("refuses padding, other alphabets, impossible lengths and non-canonical last characters", () => {
    throwsWith(() => base64urlDecode("Zg=="), "bad-input");
    throwsWith(() => base64urlDecode("a+b/"), "bad-input");
    throwsWith(() => base64urlDecode("abcde"), "bad-input");
    throwsWith(() => base64urlDecode("Zh"), "bad-input"); // "Zg" is the one text for "f".
    expect(base64urlDecode("Zg")).toEqual(utf8Encode("f"));
  });
});

describe("byte helpers", () => {
  it("copies any view into its own buffer", () => {
    const backing = new Uint8Array([9, 1, 2, 3, 9]);
    const copy = toBytes(backing.subarray(1, 4));
    expect(copy).toEqual(new Uint8Array([1, 2, 3]));
    backing[1] = 0;
    expect(copy[0]).toBe(1);
    expect(toBytes(new Uint8Array([4, 5]).buffer)).toEqual(new Uint8Array([4, 5]));
  });

  it("compares bytes and refuses invalid UTF-8", () => {
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
    expect(utf8Decode(utf8Encode("héllo ✓"))).toBe("héllo ✓");
    throwsWith(() => utf8Decode(new Uint8Array([0xff, 0xfe])), "bad-input");
  });
});

describe("aadFor", () => {
  it("spells each purpose in the zenith/v1 format", () => {
    expect(aad).toBe("zenith/v1/revision|team=t1|auto=a1|rev=000004-abcdEFGH|field=content|kv=1");
    expect(aadFor.autoTitle({ teamId: "t1", autoId: "a1", gen: 3, kv: 2 })).toBe("zenith/v1/auto-title|team=t1|auto=a1|gen=3|kv=2");
    expect(aadFor.activityDetail({ teamId: "t1", entryId: "e1", kv: 2 })).toBe("zenith/v1/activity-detail|team=t1|entry=e1|kv=2");
    expect(aadFor.shareProjection({ shareId: "s1", autoId: "a1", kv: 1 })).toBe("zenith/v1/share-projection|share=s1|auto=a1|kv=1");
    expect(aadFor.ownerChoice({ shareId: "s1", teamId: "t1", kv: 3 })).toBe("zenith/v1/owner-choice|share=s1|team=t1|kv=3");
    const binding = { proposalId: "p1", shareId: "s1", ownerTeamId: "t1", fromTeamId: "t2", okv: 3, fkv: 5 };
    expect(aadFor.proposalDiff(binding)).toBe("zenith/v1/proposal-diff|proposal=p1|share=s1|owner=t1|from=t2|okv=3|fkv=5");
    expect(aadFor.proposalOwnerWrap(binding)).toBe("zenith/v1/proposal-owner-wrap|proposal=p1|share=s1|owner=t1|from=t2|okv=3|fkv=5");
    expect(aadFor.proposalFromWrap(binding)).toBe("zenith/v1/proposal-from-wrap|proposal=p1|share=s1|owner=t1|from=t2|okv=3|fkv=5");
    expect(aadFor.teamKeyChain({ teamId: "t1", kv: 3 })).toBe("zenith/v1/team-key-chain|team=t1|kv=3");
    expect(aadFor.teamKeyPair({ teamId: "t1", kv: 3, fingerprint: new Uint8Array([255, 254]) })).toBe("zenith/v1/team-key-pair|team=t1|kv=3|fp=__4");
    expect(aadFor.keyGrant({ teamId: "t1", deviceId: "d1", kv: 3 })).toBe("zenith/v1/key-grant|team=t1|device=d1|kv=3");
    expect(aadFor.recovery({ teamId: "t1", kv: 3 })).toBe("zenith/v1/recovery|team=t1|kv=3");
    expect(aadFor.recoveryKeyPair({ teamId: "t1" })).toBe("zenith/v1/recovery-key-pair|team=t1");
    expect(aadFor.recoveryCheck({ teamId: "t1", kv: 3 })).toBe("zenith/v1/recovery-check|team=t1|kv=3");
    expect(aadFor.shareWrap({ shareId: "s1", teamId: "t2", kv: 1, ekv: 4 })).toBe("zenith/v1/share-wrap|share=s1|team=t2|kv=1|ekv=4");
    expect(aadFor.ownerWrap({ shareId: "s1", teamId: "t1", kv: 3, skv: 1 })).toBe("zenith/v1/owner-wrap|share=s1|team=t1|kv=3|skv=1");
    expect(aadFor.linkWrap({ shareId: "s1", teamId: "t1", autoId: "a1", kv: 3 })).toBe("zenith/v1/link-wrap|share=s1|team=t1|auto=a1|kv=3");
  });

  it("refuses values that could make two inputs give one text", () => {
    throwsWith(() => aadFor.autoTitle({ teamId: "t1|auto=x", autoId: "a1", gen: 1, kv: 1 }), "bad-input");
    throwsWith(() => aadFor.autoTitle({ teamId: "t1", autoId: "a=1", gen: 1, kv: 1 }), "bad-input");
    throwsWith(() => aadFor.autoTitle({ teamId: "", autoId: "a1", gen: 1, kv: 1 }), "bad-input");
    throwsWith(() => aadFor.autoTitle({ teamId: "t1", autoId: "a1", gen: 1, kv: 0 }), "bad-input");
    throwsWith(() => aadFor.autoTitle({ teamId: "t1", autoId: "a1", gen: 1, kv: 1.5 }), "bad-input");
    throwsWith(() => aadFor.autoTitle({ teamId: "t1", autoId: "a1", gen: 0, kv: 1 }), "bad-input");
    throwsWith(() => aadFor.revision({ teamId: "t1", autoId: "a1", revisionId: "r", field: "title" as "content", kv: 1 }), "bad-input");
  });
});

describe("sealBytes and openBytes", () => {
  it("round-trips and writes the envelope spec 14 shows", async () => {
    const key = await aesKey(3);
    const envelope = await sealBytes(key, utf8Encode("paths"), aad);
    expect(envelope.v).toBe(1);
    expect(envelope.alg).toBe("A256GCM");
    expect(envelope.kv).toBe(3);
    expect(envelope.iv.length).toBe(12);
    expect(envelope.ct.length).toBe(5 + 16);
    expect(utf8Decode(await openBytes(key, envelope, aad))).toBe("paths");
  });

  it("uses a fresh IV every time", async () => {
    const key = await aesKey();
    const ivs = new Set<string>();
    for (let i = 0; i < 50; i++) ivs.add(base64urlEncode((await sealBytes(key, new Uint8Array(1), aad)).iv));
    expect(ivs.size).toBe(50);
  });

  it("is deterministic with injected randomness", async () => {
    const key = await aesKey();
    const a = await sealBytes(key, utf8Encode("same"), aad, counting());
    const b = await sealBytes(key, utf8Encode("same"), aad, counting());
    expect(a).toEqual(b);
    expect(a.iv).toEqual(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
  });

  it("throws decrypt-failed for a wrong key, wrong AAD, or a flipped bit in the IV or ciphertext", async () => {
    const key = await aesKey();
    const envelope = await sealBytes(key, utf8Encode("secret"), aad);
    await rejectsWith(openBytes(await aesKey(1, 8), envelope, aad), "decrypt-failed");
    await rejectsWith(openBytes(key, envelope, aadFor.revision({ teamId: "t1", autoId: "a1", revisionId: "000004-abcdEFGH", field: "robot", kv: 1 })), "decrypt-failed");
    await rejectsWith(openBytes(key, envelope, aadFor.revision({ teamId: "t2", autoId: "a1", revisionId: "000004-abcdEFGH", field: "content", kv: 1 })), "decrypt-failed");
    await rejectsWith(openBytes(key, { ...envelope, iv: flip(envelope.iv) }, aad), "decrypt-failed");
    await rejectsWith(openBytes(key, { ...envelope, ct: flip(envelope.ct, 0) }, aad), "decrypt-failed");
    await rejectsWith(openBytes(key, { ...envelope, ct: flip(envelope.ct, -1) }, aad), "decrypt-failed");
    await rejectsWith(openBytes(key, { ...envelope, ct: envelope.ct.subarray(0, envelope.ct.length - 1) }, aad), "decrypt-failed");
  });

  it("throws wrong-key-version when the envelope names another version, even with the right bytes", async () => {
    const key = await aesKey(2);
    const envelope = await sealBytes(key, utf8Encode("secret"), aad);
    await rejectsWith(openBytes({ ...key, version: 3 }, envelope, aad), "wrong-key-version");
    // A server that relabels the version is caught by the version check and, with a matching key, by the AAD.
    await rejectsWith(openBytes(key, { ...envelope, kv: 3 }, aad), "wrong-key-version");
  });

  it("throws bad-envelope for an unknown version or algorithm and malformed fields", async () => {
    const key = await aesKey();
    const envelope = await sealBytes(key, utf8Encode("secret"), aad);
    const bad = (patch: Partial<Record<keyof Envelope, unknown>>) => openBytes(key, { ...envelope, ...patch } as Envelope, aad);
    await rejectsWith(bad({ v: 2 }), "bad-envelope");
    await rejectsWith(bad({ alg: "A128GCM" }), "bad-envelope");
    await rejectsWith(bad({ kv: 0 }), "bad-envelope");
    await rejectsWith(bad({ iv: new Uint8Array(11) }), "bad-envelope");
    await rejectsWith(bad({ ct: new Uint8Array(15) }), "bad-envelope");
    await rejectsWith(bad({ ct: "not bytes" }), "bad-envelope");
    await rejectsWith(openBytes(key, null as unknown as Envelope, aad), "bad-envelope");
  });

  it("never puts the plaintext in an error", async () => {
    const key = await aesKey();
    const envelope = await sealText(key, "far-side 7-ball", aad);
    try {
      await openText(await aesKey(1, 9), envelope, aad);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoError);
      expect(String((error as Error).message)).not.toContain("7-ball");
      expect(JSON.stringify(error)).not.toContain("7-ball");
    }
  });
});

describe("sealText, sealJson and their opens", () => {
  it("gzip before encrypting, so repetitive text shrinks", async () => {
    const key = await aesKey();
    const text = JSON.stringify({ steps: Array.from({ length: 200 }, (_, i) => ({ kind: "path", id: `s${String(i)}`, x_in: 12.5, y_in: -30 })) });
    const envelope = await sealText(key, text, aad);
    expect(envelope.ct.length).toBeLessThan(text.length / 3);
    expect(await openText(key, envelope, aad)).toBe(text);
  });

  it("round-trips JSON with sorted keys, so one value gives one plaintext", async () => {
    const key = await aesKey();
    expect(sortedJson({ b: 1, a: [true, null, "x", { d: 2, c: undefined }] })).toBe('{"a":[true,null,"x",{"d":2}],"b":1}');
    const value = { z: "last", a: { nested: [1, 2.5, -3e-7] } };
    expect(await openJson(key, await sealJson(key, value, aad), aad)).toEqual(value);
    throwsWith(() => sortedJson({ bad: Number.NaN }), "bad-input");
    throwsWith(() => sortedJson({ when: new Date(0) }), "bad-input");
    throwsWith(() => sortedJson(new Uint8Array(2)), "bad-input");
  });

  it("stops a compression bomb with too-large", async () => {
    const key = await aesKey();
    const envelope = await sealText(key, "0".repeat(200_000), aad);
    expect(envelope.ct.length).toBeLessThan(1_000);
    await rejectsWith(openText(key, envelope, aad, { maxBytes: 100_000 }), "too-large");
    expect(DEFAULT_MAX_PLAINTEXT_BYTES).toBe(8 * 1024 * 1024);
  });

  it("throws bad-envelope when the sealed bytes are not gzip or not JSON, without quoting them", async () => {
    const key = await aesKey();
    await rejectsWith(openText(key, await sealBytes(key, utf8Encode("plain, not gzip"), aad), aad), "bad-envelope");
    await rejectsWith(openJson(key, await sealText(key, "{far-side 7-ball", aad), aad), "bad-envelope");
    const error = await openJson(key, await sealText(key, "{far-side 7-ball", aad), aad).catch((caught: unknown) => caught as Error);
    expect(error.message).not.toContain("7-ball");
    expect(String(error.cause ?? "")).not.toContain("7-ball");
  });

  it("throws bad-key, not a platform error, for a key that cannot seal", async () => {
    const hmac = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    await rejectsWith(sealBytes({ version: 1, key: hmac }, new Uint8Array(1), aad), "bad-key");
  });
});
