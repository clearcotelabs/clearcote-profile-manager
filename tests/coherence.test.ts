// Coherence rules. Two properties matter equally: a rule must FIRE on the contradiction it was
// written for, and must stay SILENT otherwise — a panel that cries wolf on every profile gets
// ignored, which is worse than not having one.
//
// Every issue also has to name a field that actually exists, or the "Fix →" deep-link goes nowhere.

import { describe, it, expect } from "vitest";
import { coherenceIssues, coherenceSummary } from "../src/lib/coherence";
import { fieldByKey } from "../src/lib/fields";

const ids = (p: Record<string, unknown>, ctx = {}) => coherenceIssues(p, ctx).map((i) => i.id);

/** A profile with nothing to complain about: Chromium brand, no proxy, current build. */
const CLEAN = { brand: "Chromium", browserVersion: "151" };

describe("every issue can be navigated to", () => {
  it("names a field that exists in the schema", () => {
    // Exercise a profile that trips as many rules at once as possible.
    const messy = {
      brand: "Chrome",
      browserVersion: "150",
      proxy: "socks5://u:p@h:1080",
      screenWidth: 1920,
      canvasBridgeUrl: "ws://h:1",
      disableGpuFingerprint: true,
      shaderDialect: "hlsl",
      portableProfile: true,
      lightStealth: true,
      fingerprintProfile: "x.json",
      platform: "android",
      maxTouchPoints: 0,
    };
    const issues = coherenceIssues(messy, { major: 150, hostPlatform: "windows", capturedScreenWarning: "too small" });
    expect(issues.length).toBeGreaterThan(5);
    for (const i of issues) {
      expect(fieldByKey(i.field), `${i.id} points at unknown field "${i.field}"`).toBeDefined();
      expect(i.message, i.id).toBeTruthy();
      expect(i.fix, i.id).toBeTruthy();
    }
  });

  it("has no duplicate issue ids", () => {
    const all = coherenceIssues(
      { brand: "Chrome", proxy: "socks5://u:p@h:1", screenWidth: 1, canvasBridgeUrl: "ws://h", disableGpuFingerprint: true },
      { major: 149 },
    ).map((i) => i.id);
    expect(all.filter((k, i) => all.indexOf(k) !== i)).toEqual([]);
  });

  it("puts errors before warnings", () => {
    const issues = coherenceIssues({ brand: "Chrome", proxy: "http://h:1" }, {});
    const firstWarn = issues.findIndex((i) => i.severity === "warn");
    const lastError = issues.map((i) => i.severity).lastIndexOf("error");
    if (firstWarn !== -1 && lastError !== -1) expect(lastError).toBeLessThan(firstWarn);
  });
});

describe("the Chrome brand commits you to Widevine", () => {
  it("fires on the default profile — brand is unset, which means Chrome", () => {
    // This is the audit row a real customer hit, and it fires for EVERY untouched profile.
    expect(ids({})).toContain("chrome-brand-without-widevine");
  });
  it("fires on an explicit Chrome brand", () => {
    expect(ids({ brand: "Chrome" })).toContain("chrome-brand-without-widevine");
  });
  it("is silent once the CDM is seeded", () => {
    expect(ids({ brand: "Chrome", widevine: true })).not.toContain("chrome-brand-without-widevine");
  });
  it("is silent for a build that does not claim the brand", () => {
    expect(ids({ brand: "Chromium" })).not.toContain("chrome-brand-without-widevine");
    expect(ids({ brand: "Edge" })).not.toContain("chrome-brand-without-widevine");
  });
});

describe("authenticated SOCKS5 needs the engine that can authenticate", () => {
  const proxy = "socks5://user:pass@gw.example.com:10000";
  it("fires on 150", () => expect(ids({ ...CLEAN, proxy }, { major: 150 })).toContain("socks5-auth-needs-151"));
  it("fires on 149", () => expect(ids({ ...CLEAN, proxy }, { major: 149 })).toContain("socks5-auth-needs-151"));
  it("is silent on 151", () => expect(ids({ ...CLEAN, proxy }, { major: 151 })).not.toContain("socks5-auth-needs-151"));
  it("is silent when the major is unknown, rather than guessing", () =>
    expect(ids({ ...CLEAN, proxy }, {})).not.toContain("socks5-auth-needs-151"));
  it("is silent for a credential-less socks5 proxy", () =>
    expect(ids({ ...CLEAN, proxy: "socks5://h:1080" }, { major: 149 })).not.toContain("socks5-auth-needs-151"));
  it("is silent for an authenticated http proxy — the relay carries it", () =>
    expect(ids({ ...CLEAN, proxy: "http://u:p@h:8080" }, { major: 149 })).not.toContain("socks5-auth-needs-151"));
});

describe("a proxy moves the IP, not the position", () => {
  it("fires with a proxy and neither geoip nor a location", () =>
    expect(ids({ ...CLEAN, proxy: "http://h:1" })).toContain("proxy-without-geolocation"));
  it("is silent once geoip fills it at launch", () =>
    expect(ids({ ...CLEAN, proxy: "http://h:1", geoip: true })).not.toContain("proxy-without-geolocation"));
  it("is silent once a location is set by hand", () =>
    expect(ids({ ...CLEAN, proxy: "http://h:1", location: "39.1,-94.5" })).not.toContain("proxy-without-geolocation"));
  it("is silent with no proxy — there is no exit region to match", () =>
    expect(ids(CLEAN)).not.toContain("proxy-without-geolocation"));
});

describe("hand-spoofed screen", () => {
  it("fires when set without a captured profile", () =>
    expect(ids({ ...CLEAN, screenWidth: 1920 })).toContain("screen-spoofed-by-hand"));
  it("fires on height alone", () =>
    expect(ids({ ...CLEAN, screenHeight: 1080 })).toContain("screen-spoofed-by-hand"));
  it("is silent when a capture carries the screen", () =>
    expect(ids({ ...CLEAN, screenWidth: 1920, fingerprintProfile: "cap.json" })).not.toContain("screen-spoofed-by-hand"));
  it("is silent when untouched", () => expect(ids(CLEAN)).not.toContain("screen-spoofed-by-hand"));
});

describe("a capture from a display too small to hold a window", () => {
  it("surfaces the import's own guard", () =>
    expect(ids({ ...CLEAN, fingerprintProfile: "tiny.json" }, { capturedScreenWarning: "800x600 display" })).toContain(
      "captured-screen-too-small",
    ));
  it("is silent without one", () =>
    expect(ids({ ...CLEAN, fingerprintProfile: "ok.json" })).not.toContain("captured-screen-too-small"));
});

describe("the bridge renders elsewhere; the real-GPU switch reports here", () => {
  it("fires when both are on", () =>
    expect(ids({ ...CLEAN, canvasBridgeUrl: "ws://h:1", disableGpuFingerprint: true })).toContain("bridge-vs-real-gpu"));
  it("is silent with only the bridge", () =>
    expect(ids({ ...CLEAN, canvasBridgeUrl: "ws://h:1" })).not.toContain("bridge-vs-real-gpu"));
  it("is silent with only the real GPU", () =>
    expect(ids({ ...CLEAN, disableGpuFingerprint: true })).not.toContain("bridge-vs-real-gpu"));
});

describe("options that would silently do nothing", () => {
  it("shader dialect is a no-op on a Windows host", () =>
    expect(ids({ ...CLEAN, shaderDialect: "hlsl" }, { hostPlatform: "windows", major: 151 })).toContain(
      "shader-dialect-on-windows",
    ));
  it("shader dialect is silent on Linux with a 151 build — the case it is for", () =>
    expect(ids({ ...CLEAN, shaderDialect: "hlsl" }, { hostPlatform: "linux", major: 151 })).toEqual([]));
  it("shader dialect warns about an older build off Windows", () =>
    expect(ids({ ...CLEAN, shaderDialect: "hlsl" }, { hostPlatform: "linux", major: 150 })).toContain(
      "shader-dialect-needs-151",
    ));
  it("reports the platform problem OR the version problem, never both", () => {
    const out = ids({ ...CLEAN, shaderDialect: "hlsl" }, { hostPlatform: "windows", major: 150 });
    expect(out).toContain("shader-dialect-on-windows");
    expect(out).not.toContain("shader-dialect-needs-151");
  });
  it("a portable profile needs 151", () =>
    expect(ids({ ...CLEAN, portableProfile: true }, { major: 150 })).toContain("portable-profile-needs-151"));
  it("a portable profile is fine on 151", () =>
    expect(ids({ ...CLEAN, portableProfile: true }, { major: 151 })).not.toContain("portable-profile-needs-151"));
});

describe("two identity sources, one switched off", () => {
  it("fires when light stealth is paired with a capture", () =>
    expect(ids({ ...CLEAN, lightStealth: true, fingerprintProfile: "cap.json" })).toContain("light-stealth-with-capture"));
  it("is silent for either alone", () => {
    expect(ids({ ...CLEAN, lightStealth: true })).not.toContain("light-stealth-with-capture");
    expect(ids({ ...CLEAN, fingerprintProfile: "cap.json" })).not.toContain("light-stealth-with-capture");
  });
});

describe("a phone with no touchscreen", () => {
  it("fires for android with touch points pinned to 0", () =>
    expect(ids({ ...CLEAN, platform: "android", maxTouchPoints: 0 })).toContain("android-without-touch"));
  it("is silent when the persona supplies them", () =>
    expect(ids({ ...CLEAN, platform: "android" })).not.toContain("android-without-touch"));
  it("is silent on a desktop platform", () =>
    expect(ids({ ...CLEAN, platform: "windows", maxTouchPoints: 0 })).not.toContain("android-without-touch"));
});

describe("silence on a coherent profile", () => {
  it("says nothing at all", () => expect(coherenceIssues(CLEAN, { major: 151 })).toEqual([]));

  it("says nothing for a fully-configured, self-consistent profile", () => {
    // The shape the e2e launches: 151, Chrome brand backed by the CDM, authenticated socks5 with
    // geoip filling the locale, portable profile. Nothing here contradicts anything.
    const good = {
      brand: "Chrome",
      widevine: true,
      browserVersion: "151",
      proxy: "socks5://u:p@gw.example.com:10000",
      geoip: true,
      portableProfile: true,
    };
    expect(coherenceIssues(good, { major: 151, hostPlatform: "windows" })).toEqual([]);
  });
});

describe("coherenceSummary", () => {
  it("counts errors and warnings apart", () => {
    const s = coherenceSummary(coherenceIssues({ brand: "Chrome", proxy: "http://h:1" }, {}));
    expect(s.errors).toBe(1);
    expect(s.warnings).toBe(1);
    expect(s.ok).toBe(false);
  });
  it("reports ok on an empty list", () => {
    expect(coherenceSummary([])).toEqual({ errors: 0, warnings: 0, ok: true });
  });
});
