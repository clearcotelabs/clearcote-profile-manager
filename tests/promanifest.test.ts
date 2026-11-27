// The signed Pro release manifest check (electron/proManifest.ts) on its own: the key the app pins, the test
// vectors the Clearcote SDKs share (tests/fixtures/pro_manifest_vectors.json = sdk/testdata/ in clearcote-browser),
// the Ed25519 verifier against RFC 8032, and the corners the vectors leave out. What the download does with the
// check is in promanifest.download.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  PRO_RELEASE_KEYS,
  ProManifestError,
  defaultProLauncher,
  ed25519Verify,
  proBinaryHashes,
  proPins,
  verifyProManifest,
} from "../electron/proManifest";
import {
  PINNED_BY_THE_APP,
  TEST_KEY_ID,
  VECTORS,
  manifestPayload,
  pinOnlyTestReleaseKey,
  restoreReleaseKeys,
  signProManifest,
  signedAnswer,
  type VectorCase,
} from "./helpers/prosign";

const hex = (s: string) => Buffer.from(s, "hex");

/** "ok", or the reason code of the refusal. Anything but a ProManifestError is a bug and is rethrown. */
function outcome(c: Pick<VectorCase, "meta" | "platform" | "want_revision" | "want_version">): string {
  try {
    verifyProManifest(c.meta, c.platform, c.want_revision, c.want_version);
    return "ok";
  } catch (e) {
    if (!(e instanceof ProManifestError)) throw e;
    return e.reason;
  }
}

beforeEach(pinOnlyTestReleaseKey); // the test key, for this file only
afterEach(restoreReleaseKeys);

/** A correct Windows answer, signed with the test key. */
const good = (over: Record<string, unknown> = {}) =>
  signedAnswer(
    {
      tag: "pro-158.0.8127.36-r68",
      version: "158.0.8127.36",
      asset: "a.zip",
      binary: "chrome.exe",
      sha256: "a".repeat(64),
      exe_sha256: "b".repeat(64),
      chrome_dll_sha256: "c".repeat(64),
      size: 1234,
      ...over,
    },
    "windows",
  );
const NO_PIN = { want_revision: null, want_version: null };

describe("the release keys the app pins", () => {
  it("is exactly the production key pro-2026a, the same one the SDKs pin", () => {
    expect(PINNED_BY_THE_APP).toEqual({ "pro-2026a": "5f8ad6af5350ade5d18006ae7443472a09550b68967055146d33ae0006624ff1" });
    expect(PINNED_BY_THE_APP[TEST_KEY_ID]).toBeUndefined();
  });

  it("with only that key pinned, an answer signed by the test key is refused as unknown-key", () => {
    restoreReleaseKeys();
    expect(Object.keys(PRO_RELEASE_KEYS)).toEqual(["pro-2026a"]);
    expect(outcome({ meta: good(), platform: "windows", ...NO_PIN })).toBe("unknown-key");
    // and one that names the production key but is signed by another key fails on the signature
    const forged = signProManifest({ ...manifestPayload(good(), "windows"), key: "pro-2026a" });
    expect(outcome({ meta: { ...good(), manifest: forged }, platform: "windows", ...NO_PIN })).toBe("signature");
  });

  it("no environment variable adds a key or turns the check off", () => {
    restoreReleaseKeys();
    const names = ["CLEARCOTE_PRO_RELEASE_KEYS", "CLEARCOTE_RELEASE_KEY", "CLEARCOTE_SKIP_MANIFEST", "CLEARCOTE_NO_VERIFY", "CLEARCOTE_INSECURE"];
    const old = names.map((n) => process.env[n]);
    try {
      for (const n of names) process.env[n] = `${TEST_KEY_ID}=${VECTORS.public_key_hex}`;
      expect(outcome({ meta: good(), platform: "windows", ...NO_PIN })).toBe("unknown-key");
      expect(outcome({ meta: { ...good(), manifest: undefined }, platform: "windows", ...NO_PIN })).toBe("missing");
    } finally {
      names.forEach((n, i) => (old[i] === undefined ? delete process.env[n] : (process.env[n] = old[i])));
    }
  });
});

describe("Ed25519 (RFC 8032 section 7.1)", () => {
  it("has the three vectors", () => {
    expect(VECTORS.rfc8032).toHaveLength(3);
  });

  it.each(VECTORS.rfc8032.map((v, i) => [i + 1, v] as const))("vector %i verifies, and fails when one byte changes", (_n, v) => {
    const key = hex(v.public_key_hex);
    const msg = hex(v.message_hex);
    const sig = hex(v.signature_hex);
    expect(ed25519Verify(key, msg, sig)).toBe(true);
    for (const at of [0, 31, 32, 63]) {
      const bad = Buffer.from(sig);
      bad[at] ^= 0x01;
      expect(ed25519Verify(key, msg, bad), `signature byte ${at}`).toBe(false);
    }
    const otherKey = Buffer.from(key);
    otherKey[5] ^= 0x01;
    expect(ed25519Verify(otherKey, msg, sig), "key byte").toBe(false);
    const otherMsg = msg.length ? Buffer.from(msg) : Buffer.from([0]);
    if (msg.length) otherMsg[0] ^= 0x01;
    expect(ed25519Verify(key, otherMsg, sig), "message byte").toBe(false);
  });

  it("a key or signature of the wrong length is false, not an exception", () => {
    const v = VECTORS.rfc8032[1];
    const key = hex(v.public_key_hex);
    const msg = hex(v.message_hex);
    const sig = hex(v.signature_hex);
    expect(ed25519Verify(key, msg, sig.subarray(0, 63))).toBe(false);
    expect(ed25519Verify(key, msg, Buffer.concat([sig, Buffer.alloc(1)]))).toBe(false);
    expect(ed25519Verify(key, msg, Buffer.alloc(0))).toBe(false);
    expect(ed25519Verify(key.subarray(0, 31), msg, sig)).toBe(false);
    expect(ed25519Verify(Buffer.concat([key, Buffer.alloc(1)]), msg, sig)).toBe(false);
    expect(ed25519Verify(Buffer.alloc(0), msg, sig)).toBe(false);
  });

  it("the test key of the vectors file is the public half of its seed", () => {
    const [text, sig] = signProManifest({ key: TEST_KEY_ID }).split(".");
    expect(ed25519Verify(hex(VECTORS.public_key_hex), Buffer.from(text, "ascii"), Buffer.from(sig, "base64url"))).toBe(true);
  });
});

describe("release manifest test vectors (shared with the SDKs)", () => {
  it("covers every reason code", () => {
    expect(VECTORS.cases.length).toBeGreaterThanOrEqual(27);
    expect([...new Set(VECTORS.cases.map((c) => c.expect))].sort()).toEqual(
      ["archive", "binary", "malformed", "missing", "ok", "platform", "product", "revision", "signature", "unknown-key", "version"],
    );
  });

  it.each(VECTORS.cases.map((c) => [c.name, c.expect, c] as const))("%s -> %s", (_name, want, c) => {
    expect(outcome(c)).toBe(want);
  });

  it("a passing case returns the signed payload, and the files an install is checked against", () => {
    const c = VECTORS.cases.find((x) => x.name === "valid windows")!;
    const p = verifyProManifest(c.meta, c.platform);
    expect(p).toMatchObject({ v: 1, product: "clearcote-pro", version: "158.0.8127.36", revision: "r68", platform: "windows", key: TEST_KEY_ID });
    expect(p.archive.sha256).toBe(c.meta.sha256);
    expect(proBinaryHashes(p, "chrome.exe")).toEqual({ "chrome.exe": c.meta.exe_sha256, "chrome.dll": c.meta.chrome_dll_sha256 });
    const l = VECTORS.cases.find((x) => x.name === "valid linux")!;
    expect(proBinaryHashes(verifyProManifest(l.meta, l.platform), "chrome")).toEqual({ chrome: l.meta.exe_sha256 });
  });

  it("with no key pinned every case that reaches the key check is refused as unknown-key", () => {
    for (const k of Object.keys(PRO_RELEASE_KEYS)) delete PRO_RELEASE_KEYS[k];
    const early = new Set(["missing", "malformed"]);
    for (const c of VECTORS.cases) {
      const got = outcome(c);
      // "unknown manifest version" is malformed at step 5, behind the key check
      if (early.has(c.expect) && c.name !== "unknown manifest version") expect(got, c.name).toBe(c.expect);
      else expect(got, c.name).toBe("unknown-key");
    }
  });
});

describe("release manifest: order and corners", () => {
  it("a correct answer passes, with or without a matching pin", () => {
    expect(outcome({ meta: good(), platform: "windows", ...NO_PIN })).toBe("ok");
    expect(outcome({ meta: good(), platform: "windows", want_revision: "r68", want_version: "158.0.8127.36" })).toBe("ok");
    expect(verifyProManifest(good(), "windows", undefined, undefined).revision).toBe("r68");
  });

  it("the error names the reason, says what was wrong and that the build is refused", () => {
    let err: unknown;
    try {
      verifyProManifest(good({ revision: "r68" }), "windows", "r69");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProManifestError);
    const e = err as ProManifestError;
    expect(e.name).toBe("ProManifestError");
    expect(e.reason).toBe("revision");
    expect(e.message).toMatch(/^Clearcote Pro release manifest check failed \(revision\): .*'r68'.*'r69'.*\. Refusing to use this build\.$/);
  });

  it("the first failing check wins", () => {
    const m = good();
    expect(outcome({ meta: m, platform: "linux", want_revision: "r1", want_version: "1.2.3.4" })).toBe("platform");
    expect(outcome({ meta: m, platform: "windows", want_revision: "r1", want_version: "1.2.3.4" })).toBe("version");
    expect(outcome({ meta: m, platform: "windows", want_revision: "r1", want_version: null })).toBe("revision");
    expect(outcome({ meta: { ...m, sha256: "0".repeat(64), exe_sha256: "0".repeat(64) }, platform: "windows", ...NO_PIN })).toBe("archive");
    const [text] = m.manifest.split(".");
    const other = signProManifest({ ...manifestPayload(m, "windows"), key: "other" }).split(".")[0];
    expect(outcome({ meta: { ...m, manifest: `${other}.AAAA` }, platform: "windows", ...NO_PIN })).toBe("unknown-key");
    expect(outcome({ meta: { ...m, manifest: `${text}.AAAA` }, platform: "windows", ...NO_PIN })).toBe("signature");
  });

  it("nothing in the payload counts before the signature: a forged payload that matches the answer is refused", () => {
    const m = good();
    const forger = generateKeyPairSync("ed25519").privateKey;
    const forged = signProManifest(manifestPayload(m, "windows"), forger); // names the pinned key id, signed by another key
    expect(outcome({ meta: { ...m, manifest: forged }, platform: "windows", ...NO_PIN })).toBe("signature");
    const wrong = signProManifest({ ...manifestPayload(m, "windows"), product: "x" }, forger);
    expect(outcome({ meta: { ...m, manifest: wrong }, platform: "windows", ...NO_PIN })).toBe("signature");
  });

  it("refuses base64 that is not base64url without padding", () => {
    const m = good();
    const [text, sig] = m.manifest.split(".");
    const std = Buffer.from(sig, "base64url").toString("base64"); // "+", "/" and "=" padding
    expect(std).toMatch(/=$/);
    for (const manifest of [`${text}.${std}`, `${text}=.${sig}`, `${text} .${sig}`, `${text}.${sig}\n`, `*${text.slice(1)}.${sig}`]) {
      expect(outcome({ meta: { ...m, manifest }, platform: "windows", ...NO_PIN }), manifest.slice(-12)).toBe("malformed");
    }
    expect(outcome({ meta: { ...m, manifest: `${text}.` }, platform: "windows", ...NO_PIN })).toBe("signature");
    expect(outcome({ meta: { ...m, manifest: `.${sig}` }, platform: "windows", ...NO_PIN })).toBe("malformed");
    expect(outcome({ meta: { ...m, manifest: "." }, platform: "windows", ...NO_PIN })).toBe("malformed");
  });

  it("a payload that is JSON but not an object is malformed", () => {
    for (const payload of [[1, 2], "text", 7, null, true]) {
      const manifest = signProManifest(payload);
      expect(outcome({ meta: { ...good(), manifest }, platform: "windows", ...NO_PIN }), JSON.stringify(payload)).toBe("malformed");
    }
  });

  it("a key id is looked up among the pinned keys only (no inherited object properties)", () => {
    const m = good();
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty", "", 7, null, undefined, { a: 1 }]) {
      const manifest = signProManifest({ ...manifestPayload(m, "windows"), key });
      expect(outcome({ meta: { ...m, manifest }, platform: "windows", ...NO_PIN }), String(key)).toBe("unknown-key");
    }
  });

  it("the launcher's default name per platform", () => {
    expect([defaultProLauncher("windows"), defaultProLauncher("linux"), defaultProLauncher("macos")]).toEqual(["chrome.exe", "chrome", "Chromium"]);
  });
});

describe("what a version selector pins", () => {
  it("a revision, a version, both, or neither", () => {
    expect(proPins("158.0.8127.36-r68")).toEqual({ revision: "r68", version: "158.0.8127.36" });
    expect(proPins("pro-158.0.8127.36-r68")).toEqual({ revision: "r68", version: "158.0.8127.36" });
    expect(proPins("158.0.8127.36")).toEqual({ revision: undefined, version: "158.0.8127.36" });
    expect(proPins("r68")).toEqual({ revision: "r68", version: undefined });
    expect(proPins("R68")).toEqual({ revision: "r68", version: undefined });
    for (const none of ["", undefined, "158", "latest", "auto", " "]) expect(proPins(none)).toEqual({ revision: undefined, version: undefined });
  });
});
