/**
 * Ciphertext is stored as bytes (spec 14 section 4.1): `Uint8Array` on the client, `Bytes` in
 * Firestore. Both stores must keep bytes as bytes, inside maps too, and never turn them into a map
 * of their indices.
 */
import { Bytes, Timestamp } from "firebase/firestore";
import { describe, expect, it } from "vitest";
import { fromFirestore, toFirestore } from "../src/firebase/firestoreStore.js";
import { MemoryDatabase, MemoryStore } from "../src/memory/memoryStore.js";
import { valuesEqual } from "../src/memory/rules.js";
import { SERVER_TIME } from "../src/store.js";

describe("bytes in the stores", () => {
  it("the Firestore store writes Uint8Array as Bytes and reads Bytes back as Uint8Array, nested too", () => {
    const envelope = { v: 1, kv: 2, iv: new Uint8Array([1, 2, 3]), ct: new Uint8Array([9, 8]) };
    const stored = toFirestore({ title: envelope, at: new Date(0) }) as { title: { iv: unknown; ct: unknown }; at: unknown };
    expect(stored.title.iv).toBeInstanceOf(Bytes);
    expect(stored.title.ct).toBeInstanceOf(Bytes);
    expect(stored.at).toBeInstanceOf(Timestamp);
    const back = fromFirestore(stored) as { title: { iv: Uint8Array; ct: Uint8Array } };
    expect(back.title.iv).toBeInstanceOf(Uint8Array);
    expect([...back.title.iv]).toEqual([1, 2, 3]);
    expect([...back.title.ct]).toEqual([9, 8]);
  });

  it("the memory store keeps bytes as bytes through a write, the cache and a read", async () => {
    const database = new MemoryDatabase();
    database.seed("users/u1", { displayName: "u1", createdAt: SERVER_TIME });
    const store = new MemoryStore(database, () => "u1");
    const spki = new Uint8Array(91).fill(7);
    const fingerprint = new Uint8Array(32).fill(3);
    await store.commit([
      { op: "set", path: "users/u1/devices/deviceAAAAAAAAAAAAAAAA", data: { v: 1, encSpki: spki, signSpki: spki, fingerprint, createdAt: SERVER_TIME } },
    ]).sent;
    const read = await store.get("users/u1/devices/deviceAAAAAAAAAAAAAAAA");
    expect(read?.encSpki).toBeInstanceOf(Uint8Array);
    expect((read?.encSpki as Uint8Array).byteLength).toBe(91);
    // The stored copy is not the caller's array.
    spki[0] = 0;
    expect((database.peek("users/u1/devices/deviceAAAAAAAAAAAAAAAA")?.encSpki as Uint8Array)[0]).toBe(7);
  });

  it("compares bytes by value, as the rules language does", () => {
    expect(valuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(valuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(valuesEqual(new Uint8Array([1, 2]), new Uint8Array([1]))).toBe(false);
    expect(valuesEqual(new Uint8Array([1]), { 0: 1 })).toBe(false);
  });
});

describe("the rules' SHA-256", () => {
  it("matches Node's for the empty message, a block boundary and a long message", async () => {
    const { createHash } = await import("node:crypto");
    const { sha256Sync } = await import("../src/memory/sha256.js");
    for (const n of [0, 1, 55, 56, 63, 64, 65, 91, 1000, 70_000]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
      expect(Buffer.from(sha256Sync(data)).toString("hex"), `${n} bytes`).toBe(createHash("sha256").update(data).digest("hex"));
    }
  });
});
