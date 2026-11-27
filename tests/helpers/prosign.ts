// A stand-in for a signing release, for the tests of the Pro release manifest check (electron/proManifest.ts).
//
// Answers are signed with the TEST key of tests/fixtures/pro_manifest_vectors.json (the file the Clearcote
// SDKs share: sdk/testdata/pro_manifest_vectors.json in clearcote-browser). That key is pinned nowhere in the
// app. A test pins it with pinTestReleaseKey() and takes it out again with unpinTestReleaseKey(); the app
// itself has no way to add a key.

import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PRO_RELEASE_KEYS, type ProManifestMeta, type ProPlatform } from "../../electron/proManifest";

export interface VectorCase {
  name: string;
  platform: ProPlatform;
  want_revision: string | null;
  want_version: string | null;
  meta: ProManifestMeta;
  expect: string;
}
export const VECTORS = JSON.parse(readFileSync(path.join(__dirname, "..", "fixtures", "pro_manifest_vectors.json"), "utf8")) as {
  key_id: string;
  public_key_hex: string;
  private_seed_hex: string;
  rfc8032: Array<{ public_key_hex: string; message_hex: string; signature_hex: string }>;
  cases: VectorCase[];
};
export const TEST_KEY_ID = VECTORS.key_id;
export const TEST_PUBLIC_KEY_HEX = VECTORS.public_key_hex;

/** The keys the app pins, as they were when this module loaded (before any test pinned the test key). */
export const PINNED_BY_THE_APP: Readonly<Record<string, string>> = Object.freeze({ ...PRO_RELEASE_KEYS });

/** An Ed25519 private key from its 32-byte seed (PKCS#8 header + seed). */
export function ed25519PrivateKey(seedHex: string): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]),
    format: "der",
    type: "pkcs8",
  });
}
const TEST_PRIVATE_KEY = ed25519PrivateKey(VECTORS.private_seed_hex);

export function pinTestReleaseKey(): void {
  PRO_RELEASE_KEYS[TEST_KEY_ID] = TEST_PUBLIC_KEY_HEX;
}
export function unpinTestReleaseKey(): void {
  delete PRO_RELEASE_KEYS[TEST_KEY_ID];
}
/** Only the test key pinned (the vectors expect a key id other than it to be unknown). */
export function pinOnlyTestReleaseKey(): void {
  for (const k of Object.keys(PRO_RELEASE_KEYS)) delete PRO_RELEASE_KEYS[k];
  pinTestReleaseKey();
}
/** Back to exactly what the app pins. */
export function restoreReleaseKeys(): void {
  for (const k of Object.keys(PRO_RELEASE_KEYS)) delete PRO_RELEASE_KEYS[k];
  Object.assign(PRO_RELEASE_KEYS, PINNED_BY_THE_APP);
}

/** base64url(payload) "." base64url(Ed25519 signature over the ASCII of the first part). */
export function signProManifest(payload: unknown, key: KeyObject = TEST_PRIVATE_KEY): string {
  const text = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${text}.${sign(null, Buffer.from(text, "ascii"), key).toString("base64url")}`;
}

export interface ProAnswer {
  tag?: string;
  version?: string;
  revision?: string;
  asset?: string;
  binary?: string;
  sha256?: string;
  exe_sha256?: string;
  chrome_dll_sha256?: string;
  size?: number;
  [more: string]: unknown;
}

/** The manifest payload a release would sign for this answer. The revision is the answer's, else its tag's "-rN". */
export function manifestPayload(answer: ProAnswer, platform: ProPlatform): Record<string, unknown> {
  const binary = answer.binary ?? (platform === "windows" ? "chrome.exe" : platform === "macos" ? "Chromium" : "chrome");
  return {
    v: 1,
    product: "clearcote-pro",
    version: answer.version,
    revision: answer.revision ?? /-(r\d+)$/.exec(answer.tag ?? "")?.[1],
    platform,
    archive: { name: answer.asset, sha256: answer.sha256, size: answer.size },
    binaries: { [binary]: answer.exe_sha256, ...(platform === "windows" ? { "chrome.dll": answer.chrome_dll_sha256 } : {}) },
    key: TEST_KEY_ID,
    issued: "2026-11-26",
  };
}

/** The answer as a signing release serves it: with `revision`, `platform` and a manifest for exactly its values. */
export function signedAnswer<T extends ProAnswer>(answer: T, platform: ProPlatform): T & { revision?: string; platform: string; manifest: string } {
  const payload = manifestPayload(answer, platform);
  return { ...answer, revision: payload.revision as string | undefined, platform, manifest: signProManifest(payload) };
}
