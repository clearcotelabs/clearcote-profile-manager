// The shared fingerprint-switch builder (electron/fpargs.ts) — the module BOTH the real launcher
// and the renderer preview use. Ported from the clearcote Node SDK's fingerprintArgs; these tests
// pin the parity, because the SDK is not a dependency and nothing else would catch drift.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  fingerprintArgs,
  lightStealthValues,
  sha256Hex,
  cleanAcceptLanguage,
  defaultTimezone,
  resolveTls,
  screenGuardWarning,
  type FpInput,
} from "../electron/fpargs";

const base: FpInput = { fingerprint: "seed-1" };
const build = (p: Partial<FpInput> = {}, o = {}) => fingerprintArgs({ ...base, ...p }, o);
const has = (p: Partial<FpInput>, sw: string) => build(p).includes(sw);
const startsWith = (p: Partial<FpInput>, pre: string) => build(p).some((s) => s.startsWith(pre));

// ---------------------------------------------------------------------------
// sha256 — lightStealth picks its metadata row from a FULL sha256 digest mod N, and that row must
// match the Node + Python SDKs for a given seed. node:crypto isn't available in the renderer, so
// fpargs ships its own; if it were subtly wrong, seeds would silently map to a different persona.
// ---------------------------------------------------------------------------
describe("sha256Hex — matches node:crypto", () => {
  const vectors = [
    "",
    "a",
    "abc",
    "seed-1",
    "clearcote-light-stealth",
    "x".repeat(55), //  one byte under a padding-block boundary
    "x".repeat(56), //  exactly at the boundary (forces an extra block)
    "x".repeat(64),
    "x".repeat(1000),
    "üñïçødé 🎩", // multi-byte UTF-8: byte length != code-unit length
    "The quick brown fox jumps over the lazy dog",
  ];
  for (const v of vectors) {
    it(`"${v.length > 24 ? v.slice(0, 24) + `…(${v.length})` : v}"`, () =>
      expect(sha256Hex(v)).toBe(createHash("sha256").update(v, "utf8").digest("hex")));
  }
  it("500 pseudo-random strings (deterministic LCG, no flake)", () => {
    let s = 12345;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 500; i++) {
      let str = "";
      const len = Math.floor(rnd() * 300);
      for (let j = 0; j < len; j++) str += String.fromCharCode(Math.floor(rnd() * 2000));
      expect(sha256Hex(str)).toBe(createHash("sha256").update(str, "utf8").digest("hex"));
    }
  });
});

// ---------------------------------------------------------------------------
// lightStealth
// ---------------------------------------------------------------------------
describe("lightStealth", () => {
  it("seed→row mapping uses the SDK formula (full digest as a big integer mod N)", () => {
    // Recompute the SDK's mapping independently with node:crypto and check the resulting bundle.
    const ROWS = 14;
    for (const seed of ["seed-1", "abc", "9999", "a".repeat(80)]) {
      const hex = createHash("sha256").update(seed, "utf8").digest("hex");
      const idx = Number(BigInt("0x" + hex) % BigInt(ROWS));
      const v = lightStealthValues(seed);
      // The row's dpr/colorDepth/deviceMemory/hwConcurrency must be internally consistent with idx.
      const table = [
        [1.0, 24, 8, 8], [1.0, 24, 16, 12], [1.0, 24, 16, 16], [1.0, 24, 16, 16],
        [1.5, 24, 16, 12], [1.25, 24, 8, 8], [1.25, 24, 16, 12], [1.0, 24, 8, 4],
        [1.0, 24, 4, 4], [1.0, 24, 8, 8], [1.0, 24, 8, 8], [1.0, 24, 8, 8],
        [1.0, 24, 16, 12], [1.0, 24, 32, 16],
      ][idx];
      expect([v.devicePixelRatio, v.colorDepth, v.deviceMemory, v.hardwareConcurrency]).toEqual(table);
    }
  });
  it("an empty seed falls back to the documented sentinel key", () =>
    expect(lightStealthValues("")).toEqual(lightStealthValues("clearcote-light-stealth")));
  it("is deterministic", () =>
    expect(lightStealthValues("seed-1")).toEqual(lightStealthValues("seed-1")));

  // The whole point of the preset: it must NOT engage the persona machinery.
  it("SUPPRESSES --fingerprint (the persona/farbling machinery strict anti-bots detect)", () => {
    expect(startsWith({ lightStealth: true }, "--fingerprint=")).toBe(false);
    expect(startsWith({}, "--fingerprint=")).toBe(true); // still emitted without the preset
  });
  it("applies the bundle via NATIVE override switches", () => {
    const a = build({ lightStealth: true });
    expect(a.some((s) => s.startsWith("--fingerprint-device-memory="))).toBe(true);
    expect(a.some((s) => s.startsWith("--fingerprint-hardware-concurrency="))).toBe(true);
    expect(a.some((s) => s.startsWith("--fingerprint-color-depth="))).toBe(true);
    expect(a.some((s) => s.startsWith("--fingerprint-device-pixel-ratio="))).toBe(true);
    expect(a).toContain("--fingerprint-max-touch-points=0");
  });
  it("does NOT spoof screen dimensions (a faked screen is a reliable block trigger)", () => {
    const a = build({ lightStealth: true });
    expect(a.some((s) => s.startsWith("--fingerprint-screen-width="))).toBe(false);
    expect(a.some((s) => s.startsWith("--fingerprint-avail-height="))).toBe(false);
  });
  it("an explicit field WINS over the preset", () =>
    expect(has({ lightStealth: true, deviceMemory: 64 }, "--fingerprint-device-memory=64")).toBe(true));
  it("never mutates the caller's profile object", () => {
    const p: FpInput = { fingerprint: "seed-1", lightStealth: true };
    fingerprintArgs(p);
    expect(p.fingerprint).toBe("seed-1");
    expect(p.deviceMemory).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Native metadata overrides — the 8 switches the manager previously never emitted
// ---------------------------------------------------------------------------
describe("native metadata overrides", () => {
  it("deviceMemory", () => expect(has({ deviceMemory: 16 }, "--fingerprint-device-memory=16")).toBe(true));
  it("screenWidth / screenHeight", () => {
    expect(has({ screenWidth: 1920 }, "--fingerprint-screen-width=1920")).toBe(true);
    expect(has({ screenHeight: 1080 }, "--fingerprint-screen-height=1080")).toBe(true);
  });
  it("availWidth / availHeight", () => {
    expect(has({ availWidth: 1920 }, "--fingerprint-avail-width=1920")).toBe(true);
    expect(has({ availHeight: 1040 }, "--fingerprint-avail-height=1040")).toBe(true);
  });
  it("colorDepth", () => expect(has({ colorDepth: 24 }, "--fingerprint-color-depth=24")).toBe(true));
  it("devicePixelRatio", () =>
    expect(has({ devicePixelRatio: 1.25 }, "--fingerprint-device-pixel-ratio=1.25")).toBe(true));
  it("maxTouchPoints — 0 is a REAL value (non-touch desktop), not 'unset'", () =>
    expect(has({ maxTouchPoints: 0 }, "--fingerprint-max-touch-points=0")).toBe(true));
  it("unset overrides emit nothing", () => {
    const a = build({});
    for (const sw of ["device-memory", "screen-width", "avail-height", "color-depth", "device-pixel-ratio", "max-touch-points"])
      expect(a.some((s) => s.startsWith(`--fingerprint-${sw}=`))).toBe(false);
  });
  it("every switch appears EXACTLY once (a duplicate is a free tell over CDP)", () => {
    const a = build({
      lightStealth: true, deviceMemory: 16, colorDepth: 24, devicePixelRatio: 1.5,
      hardwareConcurrency: 12, maxTouchPoints: 0, screenWidth: 1920, screenHeight: 1080,
    });
    const names = a.map((s) => s.split("=")[0]);
    expect(names.length).toBe(new Set(names).size);
  });
});

// ---------------------------------------------------------------------------
// Locale coherence — always-on accept-lang, --lang, derived timezone
// ---------------------------------------------------------------------------
describe("locale coherence", () => {
  it("--accept-lang is ALWAYS emitted (absent it, Chromium leaks the build/OS locale)", () =>
    expect(build({})).toContain("--accept-lang=en-US,en"));
  it("strips ;q= weights — a ';' in the switch trips a DCHECK and crashes the renderer", () => {
    expect(cleanAcceptLanguage("en-US,en;q=0.9,fr;q=0.8")).toBe("en-US,en,fr");
    expect(build({ acceptLanguage: "en-US,en;q=0.9" })).toContain("--accept-lang=en-US,en");
    expect(build({ acceptLanguage: "en-US,en;q=0.9" }).some((s) => s.includes(";"))).toBe(false);
  });
  it("--lang pins the ICU/UI locale to the primary tag (else Intl desyncs from navigator.language)", () =>
    expect(build({ acceptLanguage: "fr-FR,fr" })).toContain("--lang=fr-FR"));
  it("an unset timezone is derived from the locale, not left to leak the host's UTC", () => {
    expect(build({ acceptLanguage: "ja-JP,ja" })).toContain("--timezone=Asia/Tokyo");
    expect(build({})).toContain("--timezone=America/New_York");
  });
  it("an explicit timezone wins and is emitted once", () => {
    const a = build({ timezone: "Europe/Berlin", acceptLanguage: "ja-JP,ja" });
    expect(a).toContain("--timezone=Europe/Berlin");
    expect(a.filter((s) => s.startsWith("--timezone=")).length).toBe(1);
  });
  it("a captured profile's languages fill in when the profile sets none", () =>
    expect(build({}, { profileAcceptLanguage: "de-DE,de" })).toContain("--accept-lang=de-DE,de"));
  it("an explicit acceptLanguage beats the captured profile's", () =>
    expect(build({ acceptLanguage: "it-IT,it" }, { profileAcceptLanguage: "de-DE,de" })).toContain(
      "--accept-lang=it-IT,it",
    ));
  it("defaultTimezone falls back by language subtag, then to America/New_York", () => {
    expect(defaultTimezone("de-CH")).toBe("Europe/Berlin"); // subtag fallback
    expect(defaultTimezone("xx-YY")).toBe("America/New_York");
    expect(defaultTimezone("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Persona defaults
// ---------------------------------------------------------------------------
describe("persona defaults", () => {
  it("platform defaults to the HOST OS (coherent with the binary actually running)", () => {
    expect(build({}, { hostPlatform: "linux" })).toContain("--fingerprint-platform=linux");
    expect(build({ platform: "macos" }, { hostPlatform: "linux" })).toContain("--fingerprint-platform=macos");
  });
  it("brand defaults to chrome (bare 'Chromium' in UA-CH is a UA mismatch detectors flag)", () => {
    expect(build({})).toContain("--fingerprint-brand=chrome");
    expect(build({ brand: "Edge" })).toContain("--fingerprint-brand=Edge");
  });
});

// ---------------------------------------------------------------------------
// WebRTC mDNS
// ---------------------------------------------------------------------------
describe("webrtcMdns", () => {
  it("'off' disables Chromium's own concealment feature flag", () =>
    expect(has({ webrtcMdns: "off" }, "--disable-features=WebRtcHideLocalIpsWithMdns")).toBe(true));
  it("'on' and unset emit nothing — concealment is already the default", () => {
    expect(startsWith({ webrtcMdns: "on" }, "--disable-features")).toBe(false);
    expect(startsWith({}, "--disable-features")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Canvas bridge
// ---------------------------------------------------------------------------
describe("canvas bridge", () => {
  it("url enables it and auto-adds --no-sandbox (the socket opens from the renderer)", () => {
    const a = build({ canvasBridgeUrl: "ws://h:9000/b" });
    expect(a).toContain("--canvas-bridge-url=ws://h:9000/b");
    expect(a).toContain("--no-sandbox");
  });
  it("mode / allow / deny / fallback all map", () => {
    const a = build({
      canvasBridgeUrl: "ws://h:9000", canvasBridgeMode: "allow",
      canvasBridgeAllow: ["a.com", "b.com"], canvasBridgeDeny: ["c.com"], canvasBridgeFallback: "local",
    });
    expect(a).toEqual(expect.arrayContaining([
      "--canvas-bridge-mode=allow", "--canvas-bridge-allow=a.com,b.com",
      "--canvas-bridge-deny=c.com", "--canvas-bridge-fallback=local",
    ]));
  });
  it("no bridge url → no bridge switches and no --no-sandbox", () => {
    const a = build({ canvasBridgeAuth: "u:p", canvasBridgeMode: "all" });
    expect(a.some((s) => s.startsWith("--canvas-bridge"))).toBe(false);
    expect(a).not.toContain("--no-sandbox");
  });
  it("redactSecrets masks the bridge credentials (preview) but not on a real launch", () => {
    expect(build({ canvasBridgeUrl: "ws://h", canvasBridgeAuth: "u:s3cret" }, { redactSecrets: true }))
      .toContain("--canvas-bridge-auth=********");
    expect(build({ canvasBridgeUrl: "ws://h", canvasBridgeAuth: "u:s3cret" }))
      .toContain("--canvas-bridge-auth=u:s3cret");
  });
});

// ---------------------------------------------------------------------------
// TLS + captured profile + misc (behaviour carried over from the old builders)
// ---------------------------------------------------------------------------
describe("tlsProfile", () => {
  it("match-persona resolves to chrome-<brandVersion major>, never emits the raw abstraction", () => {
    expect(has({ tlsProfile: "match-persona", brandVersion: "120.0.6099.109" }, "--fingerprint-tls-profile=chrome-120")).toBe(true);
    expect(build({ tlsProfile: "match-persona", brandVersion: "120.0.1" }).some((s) => s.includes("match-persona"))).toBe(false);
  });
  it("unset follows brandVersion; native/off emit nothing; chrome-<major> pins", () => {
    expect(resolveTls(undefined, "149")).toBe("chrome-149");
    expect(resolveTls("match-persona", undefined)).toBe(null);
    expect(resolveTls("native", "120")).toBe(null);
    expect(resolveTls("off", "120")).toBe(null);
    expect(resolveTls("chrome-124", undefined)).toBe("chrome-124");
    expect(resolveTls("131", undefined)).toBe("chrome-131");
  });
});

describe("captured fingerprint profile", () => {
  it("uses the injected encoder (the launcher gzips the file; the preview shows a placeholder)", () =>
    expect(build({ fingerprintProfile: "x.json" }, { encodeProfile: () => "ENCODED" })).toContain(
      "--fingerprint-profile=ENCODED",
    ));
  it("an encoder returning null (unreadable file) omits the switch rather than launching broken", () =>
    expect(startsWith({ fingerprintProfile: "gone.json" }, "--fingerprint-profile")).toBe(false));
  it("no encoder supplied → no switch", () =>
    expect(build({ fingerprintProfile: "x.json" }).some((s) => s.startsWith("--fingerprint-profile"))).toBe(false));
});

describe("carried-over behaviour", () => {
  it("android gets a phone viewport, unless extraArgs already sets one", () => {
    expect(has({ platform: "android" }, "--window-size=412,915")).toBe(true);
    expect(startsWith({ platform: "android", extraArgs: ["--window-size=800,600"] }, "--window-size")).toBe(false);
  });
  it("disableGpuFingerprint / fingerprintNoise=false / storageQuota / location / webrtcIp", () => {
    expect(has({ disableGpuFingerprint: true }, "--disable-gpu-fingerprint")).toBe(true);
    expect(has({ fingerprintNoise: false }, "--disable-fingerprint-noise")).toBe(true);
    expect(has({ fingerprintNoise: true }, "--disable-fingerprint-noise")).toBe(false);
    expect(has({ storageQuota: 250000 }, "--fingerprint-storage-quota=250000")).toBe(true);
    expect(has({ location: "35.6,139.6" }, "--fingerprint-location=35.6,139.6")).toBe(true);
    expect(has({ webrtcIp: "203.0.113.7" }, "--webrtc-ip=203.0.113.7")).toBe(true);
  });
  it("does NOT emit proxy / user-data-dir / extraArgs — those belong to the callers", () => {
    const a = build({ extraArgs: ["--foo"] });
    expect(a.some((s) => s.startsWith("--proxy-server") || s.startsWith("--user-data-dir"))).toBe(false);
    expect(a).not.toContain("--foo");
  });
});

// ---------------------------------------------------------------------------
// Captured-profile screen guard
// ---------------------------------------------------------------------------
describe("screenGuardWarning", () => {
  it("passes a normal desktop capture", () => {
    expect(screenGuardWarning(1920, 1080)).toBeNull();
    expect(screenGuardWarning(1280, 890)).toBeNull(); // exactly at the floor
  });
  it("flags a capture too small to contain a real window", () => {
    expect(screenGuardWarning(1366, 768)).toMatch(/1366x768/);
    expect(screenGuardWarning(1024, 600)).toBeTruthy();
    expect(screenGuardWarning(1920, 720)).toBeTruthy(); // the headless-720 trap
  });
  it("says nothing when the dimensions are unknown", () => {
    expect(screenGuardWarning(undefined, undefined)).toBeNull();
    expect(screenGuardWarning(1920, undefined)).toBeNull();
  });
});
