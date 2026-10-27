/**
 * The `@horizon36596/zenith-cloud/crypto` entry point: it resolves, it pulls in no Firebase code (so
 * both backends and plain Node can load it), and no private key it hands out can be exported.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as entry from "@horizon36596/zenith-cloud/crypto";

const cryptoDir = new URL("../src/crypto/", import.meta.url);

/** Every module the entry point loads: the files under src/crypto and what they import from outside it. */
function importedFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (url: URL) => {
    if (out.has(url.href)) return;
    const source = readFileSync(url, "utf8");
    out.set(url.href, source);
    for (const match of source.matchAll(/from\s+"(\.{1,2}\/[^"]+)\.js"/g)) visit(new URL(`${match[1]!}.ts`, url));
  };
  visit(new URL("index.ts", cryptoDir));
  return out;
}

describe("the crypto entry point", () => {
  it("resolves through the package name and exports the API", () => {
    for (const name of ["sealBytes", "openBytes", "sealJson", "openJson", "aadFor", "wrapToPublicKey", "unwrapWithPrivateKey", "generateDeviceKeys", "MemoryDeviceKeyStore", "IndexedDbDeviceKeyStore", "createTeamKeys", "rotateTeamKeys", "openChain", "makeKeyGrant", "openKeyGrant", "newShareKey", "deriveLinkId", "deriveLinkKey", "recoveryCodeToText", "recoveryCodeFromText", "deviceVerificationCode", "teamSafetyCode", "CryptoError"]) {
      expect(entry, name).toHaveProperty(name);
    }
  });

  it("imports nothing but its own files, the id helpers and the size caps, and never Firebase", () => {
    const files = importedFiles();
    const outside = [...files.keys()].filter((href) => !href.startsWith(cryptoDir.href)).map((href) => href.slice(href.lastIndexOf("/src/")));
    expect(outside.sort()).toEqual(["/src/ids.ts", "/src/types.ts"]);
    // types.ts holds the size caps the rules check too (the share manifest's among them), and loads
    // nothing at run time: its only import is of the encryption's own types.
    const types = [...files].find(([href]) => href.endsWith("/src/types.ts"))![1];
    expect(types.match(/^import\s(?!type\s).*$/gm)).toBeNull();
    expect(readdirSync(cryptoDir).filter((name) => name.endsWith(".ts")).length).toBe([...files.keys()].filter((href) => href.startsWith(cryptoDir.href)).length);
    for (const [href, source] of files) {
      expect(source, href).not.toMatch(/from\s+"(firebase|@firebase)/);
      expect(source, href).not.toMatch(/from\s+"(?!\.)/);
    }
  });

  it("hands out no private key that can be exported", async () => {
    const device = await entry.generateDeviceKeys();
    const v1 = await entry.createTeamKeys("t1");
    const v2 = await entry.rotateTeamKeys("t1", v1);
    const ring = await entry.openChain("t1", v2.key, [v2.record, v1.record]);
    const privates = [
      device.encryption.privateKey,
      device.signing.privateKey,
      v1.pair.privateKey,
      v2.pair.privateKey,
      ...[...ring.values()].map((version) => version.pair.privateKey),
      await entry.openTeamKeyRecord("t1", v1.key, v1.record).then((pair) => pair.privateKey),
    ];
    for (const key of privates) {
      expect(key.type).toBe("private");
      expect(key.extractable).toBe(false);
      await expect(crypto.subtle.exportKey("pkcs8", key)).rejects.toThrow();
      await expect(crypto.subtle.exportKey("jwk", key)).rejects.toThrow();
    }
    // Symmetric keys opened for everyday use cannot be exported either.
    expect(ring.get(1)!.key.key.extractable).toBe(false);
    expect((await entry.deriveLinkKey(entry.newLinkSecret())).key.extractable).toBe(false);
  });
});
