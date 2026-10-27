/**
 * Device keys (spec 14 section 4.1): each device has a P-256 ECDH pair, to which team keys are
 * wrapped, and a P-256 ECDSA pair, with which it signs the grants it makes. Both private halves are
 * made non-extractable, so script can use them but never read them out. The public halves are stored
 * in `users/{uid}/devices/{deviceId}` as a `DeviceRecord`.
 */
import { base64urlEncode, bytesEqual, concatBytes, toBytes } from "./bytes.js";
import { CryptoError } from "./errors.js";
import { isBytes, sha256, subtle } from "./primitives.js";
import { P256_SPKI_BYTES } from "./wrap.js";

/** A device's own keys, as this device holds them. */
export interface DeviceKeys {
  /** `deviceIdFor(fingerprint)`: 22 base64url characters. */
  deviceId: string;
  /** P-256 ECDH. The private half is non-extractable and can only `deriveBits`. */
  encryption: CryptoKeyPair;
  /** P-256 ECDSA with SHA-256. The private half is non-extractable and can only `sign`. */
  signing: CryptoKeyPair;
  /** The encryption public key as a 91-byte SPKI. */
  encSpki: Uint8Array;
  /** The signing public key as a 91-byte SPKI. */
  signSpki: Uint8Array;
  /** `deviceFingerprint(encSpki, signSpki)`: 32 bytes. */
  fingerprint: Uint8Array;
}

/** `users/{uid}/devices/{deviceId}`: what other devices need to wrap to this one and check its signatures. */
export interface DeviceRecord {
  v: 1;
  /** 91-byte SPKI of the P-256 ECDH public key. */
  encSpki: Uint8Array;
  /** 91-byte SPKI of the P-256 ECDSA public key. */
  signSpki: Uint8Array;
  /** 32 bytes, SHA-256 of `encSpki` followed by `signSpki`. */
  fingerprint: Uint8Array;
}

/** A P-256 ECDSA signature in the IEEE P1363 form WebCrypto uses (r then s), bytes. */
export const SIGNATURE_BYTES = 64;

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const ECDSA = { name: "ECDSA", namedCurve: "P-256" } as const;
const ECDSA_SHA256 = { name: "ECDSA", hash: "SHA-256" } as const;

/** 32 bytes: SHA-256 of the two 91-byte SPKIs, encryption key first. Throws `bad-key` for another length. */
export async function deviceFingerprint(encSpki: Uint8Array, signSpki: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (!isBytes(encSpki, { exactly: P256_SPKI_BYTES }) || !isBytes(signSpki, { exactly: P256_SPKI_BYTES })) {
    throw new CryptoError("bad-key", "A device's public keys must each be a 91-byte P-256 SPKI.");
  }
  return sha256(concatBytes(encSpki, signSpki));
}

/**
 * The device id for a fingerprint: its first 16 bytes (128 bits) as 22 base64url characters, the
 * same shape as every other client-made id, so the rules' 128-bit id check accepts it. Deriving the id
 * from the keys ties the two together: a record whose keys do not match its id is refused.
 */
export function deviceIdFor(fingerprint: Uint8Array): string {
  if (!isBytes(fingerprint, { exactly: 32 })) throw new CryptoError("bad-key", "A fingerprint must be 32 bytes.");
  return base64urlEncode(fingerprint.subarray(0, 16));
}

/** Makes a new device's two key pairs, with non-extractable private halves. */
export async function generateDeviceKeys(): Promise<DeviceKeys> {
  const encryption = await subtle().generateKey(ECDH, false, ["deriveBits"]);
  const signing = await subtle().generateKey(ECDSA, false, ["sign", "verify"]);
  const encSpki = new Uint8Array(await subtle().exportKey("spki", encryption.publicKey));
  const signSpki = new Uint8Array(await subtle().exportKey("spki", signing.publicKey));
  const fingerprint = await deviceFingerprint(encSpki, signSpki);
  return { deviceId: deviceIdFor(fingerprint), encryption, signing, encSpki, signSpki, fingerprint };
}

/** The public record for `users/{uid}/devices/{keys.deviceId}`. */
export function deviceRecord(keys: DeviceKeys): DeviceRecord {
  return { v: 1, encSpki: toBytes(keys.encSpki), signSpki: toBytes(keys.signSpki), fingerprint: toBytes(keys.fingerprint) };
}

/**
 * Checks a device record read from the server before anything is wrapped to it or verified with
 * it: version 1, a fingerprint that is the SHA-256 of its keys, an id derived from that fingerprint,
 * and two keys that WebCrypto imports as P-256 public keys, the first for ECDH and the second for
 * ECDSA. Importing checks that each is a point on the curve, so a record whose keys are any other 91
 * bytes, which costs nothing to make in bulk, is refused. Throws `bad-envelope` or `bad-key`.
 */
export async function checkDeviceRecord(deviceId: string, record: DeviceRecord): Promise<void> {
  if (typeof record !== "object" || record === null || record.v !== 1) throw new CryptoError("bad-envelope", "The device record has a version this app does not know.");
  const fingerprint = await deviceFingerprint(record.encSpki, record.signSpki);
  if (!isBytes(record.fingerprint, { exactly: 32 }) || !bytesEqual(fingerprint, record.fingerprint)) {
    throw new CryptoError("bad-key", "The device record's fingerprint does not match its keys.");
  }
  if (deviceIdFor(fingerprint) !== deviceId) throw new CryptoError("bad-key", "The device record's keys do not match its device id.");
  try {
    await subtle().importKey("spki", toBytes(record.encSpki), ECDH, true, []);
  } catch (error) {
    throw new CryptoError("bad-key", "The device record's encryption key is not a P-256 public key.", { cause: error });
  }
  try {
    await subtle().importKey("spki", toBytes(record.signSpki), ECDSA, true, ["verify"]);
  } catch (error) {
    throw new CryptoError("bad-key", "The device record's signing key is not a P-256 public key.", { cause: error });
  }
}

/** An ECDSA P-256 SHA-256 signature of `bytes` with a device's private signing key: 64 bytes. */
export async function sign(privateSigningKey: CryptoKey, bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(await subtle().sign(ECDSA_SHA256, privateSigningKey, toBytes(bytes)));
  } catch (error) {
    throw new CryptoError("bad-key", "That key cannot sign: it must be a device's private ECDSA P-256 key.", { cause: error });
  }
}

/**
 * True when `signature` is a valid ECDSA P-256 SHA-256 signature of `bytes` by the key whose 91-byte
 * SPKI is `publicSpki`. A signature of the wrong length is simply false; a malformed key throws `bad-key`.
 */
export async function verify(publicSpki: Uint8Array, signature: Uint8Array, bytes: Uint8Array): Promise<boolean> {
  if (!isBytes(publicSpki, { exactly: P256_SPKI_BYTES })) throw new CryptoError("bad-key", "A P-256 public key must be a 91-byte SPKI.");
  let key: CryptoKey;
  try {
    key = await subtle().importKey("spki", toBytes(publicSpki), ECDSA, true, ["verify"]);
  } catch (error) {
    throw new CryptoError("bad-key", "That signing key is not a valid P-256 key.", { cause: error });
  }
  if (!isBytes(signature, { exactly: SIGNATURE_BYTES })) return false;
  return subtle().verify(ECDSA_SHA256, key, toBytes(signature), toBytes(bytes));
}

/** Refuses to keep device keys whose private halves could be exported, or that are not whole. */
function assertStorable(keys: DeviceKeys): void {
  if (!isDeviceKeys(keys)) throw new CryptoError("bad-key", "Those are not device keys.");
  if (keys.encryption.privateKey.extractable || keys.signing.privateKey.extractable) {
    throw new CryptoError("bad-key", "A device's private keys must be non-extractable before they are kept.");
  }
}

/**
 * Where a device keeps its own keys between sessions. `slot` is the signed-in user's uid, so two
 * people who use one browser profile each get their own device keys.
 */
export interface DeviceKeyStore {
  /** The keys saved for `slot`, or null when there are none. */
  load(slot: string): Promise<DeviceKeys | null>;
  /** Saves `keys` for `slot`, replacing any saved before. Throws `bad-key` if a private half is extractable. */
  save(slot: string, keys: DeviceKeys): Promise<void>;
  /** Forgets the keys for `slot`. Doing so for a slot with none is not an error. */
  remove(slot: string): Promise<void>;
}

/**
 * Device keys held in memory only, gone when the page closes. For shared computers (the owner's
 * ruling: device keys in memory only there, with a fresh approval each session) and for tests.
 */
export class MemoryDeviceKeyStore implements DeviceKeyStore {
  private readonly keys = new Map<string, DeviceKeys>();

  async load(slot: string): Promise<DeviceKeys | null> {
    return this.keys.get(slot) ?? null;
  }

  async save(slot: string, keys: DeviceKeys): Promise<void> {
    assertStorable(keys);
    this.keys.set(slot, keys);
  }

  async remove(slot: string): Promise<void> {
    this.keys.delete(slot);
  }
}

/** The IndexedDB database the device keys live in. */
export const DEVICE_KEY_DATABASE = "zenith-keys";
/** The object store inside it, keyed by slot. */
export const DEVICE_KEY_OBJECT_STORE = "devices";

function isDeviceKeys(value: unknown): value is DeviceKeys {
  if (typeof value !== "object" || value === null) return false;
  const keys = value as Partial<DeviceKeys>;
  const pair = (candidate: unknown) =>
    typeof candidate === "object" && candidate !== null && (candidate as CryptoKeyPair).privateKey instanceof CryptoKey && (candidate as CryptoKeyPair).publicKey instanceof CryptoKey;
  return typeof keys.deviceId === "string" && pair(keys.encryption) && pair(keys.signing) && isBytes(keys.encSpki) && isBytes(keys.signSpki) && isBytes(keys.fingerprint);
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed."));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction was aborted."));
  });
}

/**
 * Device keys kept in IndexedDB (database `zenith-keys`, object store `devices`). The `CryptoKey`
 * objects are stored as they are, which structured clone allows for non-extractable keys, so the
 * private halves are never exported. IndexedDB is looked up only when a method runs, so importing
 * this module where there is none (Node) is safe; a method called there throws `unavailable`.
 */
export class IndexedDbDeviceKeyStore implements DeviceKeyStore {
  private database: Promise<IDBDatabase> | null = null;

  /** `factory` defaults to `globalThis.indexedDB`, looked up on first use. */
  constructor(private readonly factory?: IDBFactory) {}

  private open(): Promise<IDBDatabase> {
    if (this.database !== null) return this.database;
    const factory = this.factory ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (factory === undefined) {
      return Promise.reject(new CryptoError("unavailable", "This browser has no IndexedDB, so device keys cannot be kept; they will last only until the page closes."));
    }
    const req = factory.open(DEVICE_KEY_DATABASE, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DEVICE_KEY_OBJECT_STORE)) req.result.createObjectStore(DEVICE_KEY_OBJECT_STORE);
    };
    this.database = request(req).catch((error: unknown) => {
      this.database = null;
      throw new CryptoError("unavailable", "The device key database could not be opened.", { cause: error });
    });
    return this.database;
  }

  async load(slot: string): Promise<DeviceKeys | null> {
    const database = await this.open();
    const tx = database.transaction(DEVICE_KEY_OBJECT_STORE, "readonly");
    const value: unknown = await request(tx.objectStore(DEVICE_KEY_OBJECT_STORE).get(slot));
    if (value === undefined) return null;
    if (!isDeviceKeys(value)) throw new CryptoError("bad-key", "The device keys saved in this browser are damaged.");
    return value;
  }

  async save(slot: string, keys: DeviceKeys): Promise<void> {
    assertStorable(keys);
    const database = await this.open();
    const tx = database.transaction(DEVICE_KEY_OBJECT_STORE, "readwrite");
    tx.objectStore(DEVICE_KEY_OBJECT_STORE).put(keys, slot);
    await finished(tx);
  }

  async remove(slot: string): Promise<void> {
    const database = await this.open();
    const tx = database.transaction(DEVICE_KEY_OBJECT_STORE, "readwrite");
    tx.objectStore(DEVICE_KEY_OBJECT_STORE).delete(slot);
    await finished(tx);
  }
}
