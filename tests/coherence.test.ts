// Coherence rules. Two properties matter equally: a rule must FIRE on the contradiction it was
// written for, and must stay SILENT otherwise — a panel that cries wolf on every profile gets
// ignored, which is worse than not having one.
//
// Every issue also has to name a field that actually exists, or the "Fix →" deep-link goes nowhere.

import { describe, it, expect } from "vitest";
import { coherenceIssues, coherenceSummary, shouldAutoEnableGeoip, type CoherenceContext } from "../src/lib/coherence";
import { engineBuild } from "../src/lib/engineBuild";
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
  // Measured on r35: CSS device-width keeps the capture's screen while screen.width takes the typed
  // one, so a capture no longer excuses a typed screen (CR-RBBFHS / CR-KUDD3V).
  it("fires when a capture is set as well", () =>
    expect(ids({ ...CLEAN, screenWidth: 1920, fingerprintProfile: "cap.json" })).toContain("screen-spoofed-by-hand"));
  it("is silent when untouched", () => expect(ids(CLEAN)).not.toContain("screen-spoofed-by-hand"));
});

describe("a typed screen, by the engine build the profile launches", () => {
  // CR-RBBFHS / CR-KUDD3V: r35 gave the typed size to screen.* but not to the CSS media queries
  // under a seed, a capture or Light stealth; 154 r36 gives it to both (SESSION-CONTEXT/186: P2, P3
  // and P5 FAIL on r35, PASS on r36). The reporter: a seed, and their own 1920x1080 monitor typed in.
  const HOST = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1032 };
  const OWN = { screenWidth: 1920, screenHeight: 1080, availWidth: 1920, availHeight: 1032 };
  const OTHER = { screenWidth: 2560, screenHeight: 1440, availWidth: 2560, availHeight: 1400 };
  const SEEDED = { ...CLEAN, fingerprint: "abc" };
  const screenIssue = (p: Record<string, unknown>, ctx: CoherenceContext) =>
    coherenceIssues(p, ctx).find((i) => i.id === "screen-spoofed-by-hand");

  describe("r35 and older", () => {
    const R35: CoherenceContext = { major: 154, revision: 35, hostScreen: HOST };

    it("keeps the seed wording, even at this machine's own size", () => {
      const i = screenIssue({ ...SEEDED, ...OWN }, R35);
      expect(i?.message).toBe(
        "A typed screen size can disagree with the screen CSS media queries report while the seed is active, so a page reads two different screens. Typing your own monitor's size does not avoid it.",
      );
      expect(i?.fix).toMatch(/^Leave the four screen fields empty/);
      expect(i?.fix).toMatch(/154 r36 and newer report the typed size to both\.$/);
    });

    it("names the capture and Light stealth the same way", () => {
      expect(screenIssue({ ...SEEDED, fingerprintProfile: "cap.json", ...OWN }, R35)?.message).toContain(
        "while the captured fingerprint is active",
      );
      const ls = screenIssue({ ...SEEDED, lightStealth: true, ...OWN }, R35);
      expect(ls?.message).toContain("while Light stealth is active");
      expect(ls?.fix).toMatch(/^Leave the four screen fields empty: Light stealth keeps the real screen/);
    });

    it("holds for every build of an older major, revision or not", () => {
      expect(screenIssue({ ...SEEDED, ...OWN }, { major: 153, hostScreen: HOST })?.message).toMatch(
        /^A typed screen size can disagree with the screen CSS media queries/,
      );
    });

    it("holds on the open build, without pointing it at a PRO revision", () => {
      const i = screenIssue({ ...SEEDED, ...OWN }, { tier: "free", hostScreen: HOST });
      expect(i?.message).toMatch(/^A typed screen size can disagree/);
      expect(i?.fix).not.toMatch(/r36/);
    });

    it("with no seed, capture or Light stealth, this machine's display needs no warning", () => {
      expect(screenIssue({ ...CLEAN, ...OWN }, R35)).toBeUndefined();
      expect(screenIssue({ ...CLEAN, ...OTHER }, R35)?.fix).toMatch(/matches this host's real display/);
    });
  });

  describe("r36 and newer", () => {
    const R36: CoherenceContext = { major: 154, revision: 36, hostScreen: HOST };

    it("says nothing when the typed screen is this machine's display", () => {
      expect(screenIssue({ ...SEEDED, ...OWN }, R36)).toBeUndefined();
      expect(screenIssue({ ...SEEDED, ...OWN }, { ...R36, revision: 37 })).toBeUndefined();
      expect(screenIssue({ ...SEEDED, fingerprintProfile: "cap.json", ...OWN }, R36)).toBeUndefined();
      expect(screenIssue({ ...SEEDED, lightStealth: true, ...OWN }, R36)).toBeUndefined();
    });

    it("falls back to the generic advice for a screen that is not this machine's", () => {
      const i = screenIssue({ ...SEEDED, ...OTHER }, R36);
      expect(i?.message).toMatch(/^Screen dimensions are spoofed by hand/);
      expect(i?.message).not.toMatch(/CSS media queries/);
      expect(i?.fix).toBe(
        "Type all four to match this host's real display, or leave them empty so the seed supplies the screen.",
      );
      expect(screenIssue({ ...SEEDED, lightStealth: true, ...OTHER }, R36)?.fix).toMatch(
        /leave them empty so Light stealth reports the real screen\.$/,
      );
    });

    it("still warns when only the size is typed: the seed fills the work area from its own screen", () => {
      expect(screenIssue({ ...SEEDED, screenWidth: 1920, screenHeight: 1080 }, R36)?.message).toMatch(
        /^Screen dimensions are spoofed by hand/,
      );
    });

    it("without a seed, an empty work area is the real one", () => {
      expect(screenIssue({ ...CLEAN, screenWidth: 1920, screenHeight: 1080 }, R36)).toBeUndefined();
    });

    it("warns when this machine's display is not known", () => {
      expect(screenIssue({ ...SEEDED, ...OWN }, { major: 154, revision: 36 })?.message).toMatch(
        /^Screen dimensions are spoofed by hand/,
      );
    });
  });

  describe("an unknown build", () => {
    it("keeps the warning, said as a pre-r36 one, with advice that is right either way", () => {
      for (const ctx of [{ hostScreen: HOST }, { major: 154, hostScreen: HOST }] as CoherenceContext[]) {
        const i = screenIssue({ ...SEEDED, ...OWN }, ctx);
        expect(i?.message).toMatch(/^On builds before 154 r36, a typed screen size can disagree/);
        expect(i?.fix).toMatch(/^Leave the four screen fields empty/);
        expect(i?.fix).not.toMatch(/and newer report/);
      }
    });
  });

  describe("which build the editor resolves", () => {
    // The download route lists the current build first; "(preview)" never answers a stable selection.
    const revisions = [
      "154.0.8037.57-r38 (preview)",
      "154.0.8037.57-r37",
      "154.0.8037.57-r36",
      "154.0.8037.57-r35",
      "153.0.8010.36-r27",
    ];
    const versions = [
      { major: 154, version: "154.0.8037.57", tier: "pro" as const },
      { major: 149, version: "149.0.7827.114", tier: "free" as const },
    ];
    const licensed = { mode: "managed", licensed: true };

    it("reads a revision pin, with or without its version", () => {
      expect(engineBuild("154.0.8037.57-r35", { revisions, versions, target: licensed })).toEqual({
        revision: 35,
        tier: "pro",
      });
      expect(engineBuild("r36", {})).toEqual({ revision: 36, tier: "pro" });
    });

    it("follows the current stable build for Latest, a major and a version", () => {
      for (const v of [undefined, "", "latest", "154", "154.0.8037.57"]) {
        expect(engineBuild(v, { revisions, versions, target: licensed }), String(v)).toEqual({
          revision: 37,
          tier: "pro",
        });
      }
      expect(engineBuild("153", { revisions, versions })).toEqual({ revision: 27, tier: "pro" });
    });

    it("knows the open build, and admits when it cannot tell", () => {
      expect(engineBuild("latest", { versions, target: { mode: "managed", licensed: false } })).toEqual({
        tier: "free",
      });
      expect(engineBuild("149", { versions })).toEqual({ tier: "free" });
      // Licensed but no list (the free plan, or offline): Latest is a PRO build of unknown revision.
      expect(engineBuild("latest", { versions, target: licensed })).toEqual({});
      expect(engineBuild("154", { versions })).toEqual({ tier: "pro" });
    });

    it("knows nothing under an explicit binary, whatever the profile pins", () => {
      expect(engineBuild("r36", { revisions, target: { mode: "custom" } })).toEqual({});
    });

    it("end to end: the reporter's profile warns pinned to r35 and not on Latest", () => {
      const p = { ...SEEDED, ...OWN };
      const ctx = (browserVersion: string): CoherenceContext => ({
        ...engineBuild(browserVersion, { revisions, versions, target: licensed }),
        hostScreen: HOST,
      });
      expect(screenIssue({ ...p, browserVersion: "154.0.8037.57-r35" }, ctx("154.0.8037.57-r35"))?.message).toMatch(
        /^A typed screen size can disagree/,
      );
      expect(screenIssue({ ...p, browserVersion: "latest" }, ctx("latest"))).toBeUndefined();
    });
  });
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

describe("device memory is left to the engine", () => {
  // MEASURED on 151 r16: asked 1 it reports 2, asked 6 it reports 4, asked 64 or 128 it reports 32.
  // The engine applies Chromium's own quantization and clamp, so a rule here would flag values the
  // browser silently corrects -- a false positive, which is the one thing this panel must not do.
  it("says nothing about any device-memory value, in range or out", () => {
    for (const v of [1, 2, 4, 6, 8, 16, 32, 64, 128]) {
      expect(coherenceIssues({ ...CLEAN, platform: "windows", deviceMemory: v }), `deviceMemory=${v}`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Auto-correct: adding a proxy switches geoip on.
//
// This is the other half of the geoip fix — the default handles NEW profiles, this handles the
// moment an existing one gains a proxy. The pair has to be exactly complementary: correct new
// intent, warn about existing state, and never fight a deliberate choice.
// ---------------------------------------------------------------------------
describe("shouldAutoEnableGeoip", () => {
  const P = "socks5://u:p@gw.example.com:10000";

  it("fires when a profile first gains a proxy", () => {
    expect(shouldAutoEnableGeoip({}, P)).toBe(true);
    expect(shouldAutoEnableGeoip({ geoip: false }, P)).toBe(true);
  });

  it("does NOT fire when geoip is already on — nothing to correct", () => {
    expect(shouldAutoEnableGeoip({ geoip: true }, P)).toBe(false);
  });

  it("does NOT fire when a location was set by hand — that is already coherent", () => {
    expect(shouldAutoEnableGeoip({ location: "48.85,2.35" }, P)).toBe(false);
  });

  it("does NOT fire while EDITING an existing proxy", () => {
    // The key anti-loop property. Someone who sets a proxy, unticks geoip, then fixes a typo in the
    // proxy must not have geoip switched back on under them.
    expect(shouldAutoEnableGeoip({ proxy: "socks5://old:1080", geoip: false }, P)).toBe(false);
  });

  it("does NOT fire when the proxy is being cleared", () => {
    expect(shouldAutoEnableGeoip({ proxy: P, geoip: false }, undefined)).toBe(false);
    expect(shouldAutoEnableGeoip({ proxy: P, geoip: false }, "")).toBe(false);
  });

  it("does NOT fire with no proxy on either side", () => {
    expect(shouldAutoEnableGeoip({}, undefined)).toBe(false);
  });

  it("treats an empty location string as unset", () => {
    expect(shouldAutoEnableGeoip({ location: "" }, P)).toBe(true);
  });

  it("is complementary to the warning, not overlapping", () => {
    // After auto-correct applies, the warning must go quiet — otherwise the user is told to fix
    // something that was just fixed for them.
    const before = { brand: "Chromium", browserVersion: "151" } as Record<string, unknown>;
    expect(shouldAutoEnableGeoip(before, P)).toBe(true);
    const after = { ...before, proxy: P, geoip: true };
    expect(coherenceIssues(after, { major: 151 }).map((i) => i.id)).not.toContain("proxy-without-geolocation");
    // ...and a profile that arrives already incoherent (saved before the default changed) still warns.
    const legacy = { ...before, proxy: P, geoip: false };
    expect(coherenceIssues(legacy, { major: 151 }).map((i) => i.id)).toContain("proxy-without-geolocation");
  });
});

describe("a GPU claim from another maker than the real card", () => {
  // Driver limits follow the real GPU, so a claim from another maker is falsifiable. The rule reads
  // the maker off the stored strings (a table model's vendor, or the maker a custom string names)
  // and compares it with the host's, which the main process detects.
  const NVIDIA = {
    gpuVendor: "Google Inc. (NVIDIA)",
    gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  };
  const AMD_LINUX = {
    gpuVendor: "Google Inc. (AMD)",
    gpuRenderer: "ANGLE (AMD, AMD Radeon RX 6700 XT (radeonsi navi22 ACO), OpenGL 4.6)",
  };

  it("fires when a table model's maker differs from the host's, in either platform form", () => {
    expect(ids({ ...CLEAN, ...AMD_LINUX }, { hostGpuVendor: "nvidia" })).toContain("gpu-claim-cross-vendor");
    expect(ids({ ...CLEAN, ...NVIDIA }, { hostGpuVendor: "intel" })).toContain("gpu-claim-cross-vendor");
    expect(ids({ ...CLEAN, ...NVIDIA }, { hostGpuVendor: "amd" })).toContain("gpu-claim-cross-vendor");
  });

  it("uses the agreed wording, and points at the picker", () => {
    const issue = coherenceIssues({ ...CLEAN, ...AMD_LINUX }, { hostGpuVendor: "nvidia" }).find((i) => i.id === "gpu-claim-cross-vendor")!;
    expect(issue.severity).toBe("warn");
    expect(issue.field).toBe("gpuModel");
    expect(fieldByKey(issue.field)).toBeDefined();
    expect(issue.message).toBe(
      "GPU claim does not match this machine's GPU maker; driver limits follow the real GPU, so a cross-vendor claim is falsifiable.",
    );
    expect(issue.fix).toContain("NVIDIA");
  });

  it("fires for hand-typed strings that name another maker", () => {
    const legacy = { gpuVendor: "Google Inc. (Intel)", gpuRenderer: "ANGLE (Intel, Intel(R) HD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)" };
    expect(ids({ ...CLEAN, ...legacy }, { hostGpuVendor: "nvidia" })).toContain("gpu-claim-cross-vendor");
    expect(ids({ ...CLEAN, ...legacy }, { hostGpuVendor: "intel" })).not.toContain("gpu-claim-cross-vendor");
  });

  it("is silent for a model of this machine's own maker", () => {
    expect(ids({ ...CLEAN, ...NVIDIA }, { hostGpuVendor: "nvidia" })).not.toContain("gpu-claim-cross-vendor");
    expect(ids({ ...CLEAN, ...AMD_LINUX }, { hostGpuVendor: "amd" })).not.toContain("gpu-claim-cross-vendor");
  });

  it("is silent on the persona default — nothing is claimed", () => {
    expect(ids({ ...CLEAN }, { hostGpuVendor: "nvidia" })).not.toContain("gpu-claim-cross-vendor");
    expect(ids({ ...CLEAN, gpuVendor: "", gpuRenderer: "" }, { hostGpuVendor: "intel" })).not.toContain("gpu-claim-cross-vendor");
  });

  it("is silent when the host is unknown or not given, rather than guessing", () => {
    expect(ids({ ...CLEAN, ...AMD_LINUX }, { hostGpuVendor: "unknown" })).not.toContain("gpu-claim-cross-vendor");
    expect(ids({ ...CLEAN, ...AMD_LINUX }, {})).not.toContain("gpu-claim-cross-vendor");
  });

  it("is silent for strings that name no maker it knows", () => {
    expect(ids({ ...CLEAN, gpuVendor: "Apple", gpuRenderer: "Apple M2" }, { hostGpuVendor: "nvidia" })).not.toContain("gpu-claim-cross-vendor");
  });

  it("is silent under 'use real GPU', where the strings are not applied at all", () => {
    expect(ids({ ...CLEAN, ...AMD_LINUX, disableGpuFingerprint: true }, { hostGpuVendor: "nvidia" })).not.toContain("gpu-claim-cross-vendor");
  });

  it("is a warning, so it sorts after errors", () => {
    const list = coherenceIssues({ brand: "Chrome", ...AMD_LINUX }, { hostGpuVendor: "nvidia" });
    expect(list[0].id).toBe("chrome-brand-without-widevine");
    expect(list.map((i) => i.id)).toContain("gpu-claim-cross-vendor");
  });
});

describe("UDP relaying only applies to SOCKS5", () => {
  it("fires when requested with an http proxy", () =>
    expect(ids({ ...CLEAN, socks5Udp: true, proxy: "http://u:p@h:8080" })).toContain(
      "udp-relay-without-socks5",
    ));
  it("fires when requested with no proxy at all", () =>
    expect(ids({ ...CLEAN, socks5Udp: true })).toContain("udp-relay-without-socks5"));
  // SOCKS4 has no UDP ASSOCIATE command, so it is as much a no-op as an http proxy.
  it("flags UDP relaying on a SOCKS4 proxy", () =>
    expect(ids({ ...CLEAN, socks5Udp: true, proxy: "socks4://h:1080" })).toContain(
      "udp-relay-without-socks5"));
  it("is silent with a socks5 proxy — the case it is for", () =>
    expect(ids({ ...CLEAN, socks5Udp: true, proxy: "socks5://u:p@h:1080", geoip: true })).not.toContain(
      "udp-relay-without-socks5",
    ));
  it("is silent when the option is off", () =>
    expect(ids({ ...CLEAN, proxy: "http://u:p@h:8080", geoip: true })).not.toContain(
      "udp-relay-without-socks5",
    ));
});
