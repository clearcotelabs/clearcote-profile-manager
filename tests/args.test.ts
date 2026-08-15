import { describe, it, expect } from "vitest";
import { profileToArgs, profileToEnv, proxyString, redactProxyString, resolveTlsProfile, type Profile } from "../src/types/profile";

const base: Profile = { id: "t", name: "t", fingerprint: "seed-1", createdAt: "", updatedAt: "" };
const has = (p: Partial<Profile>, sw: string) => profileToArgs({ ...base, ...p }).includes(sw);
const startsWith = (p: Partial<Profile>, pre: string) =>
  profileToArgs({ ...base, ...p }).some((s) => s.startsWith(pre));

// Verifies the profile-manager maps each setting to the right Clearcote switch. (Whether the
// *engine* then honors a given switch is covered by tests/confirm-applied.py + tests/README.md —
// notably gpuVendor/gpuRenderer and location are emitted here but are currently engine no-ops.)
describe("profileToArgs — every setting maps to its switch", () => {
  it("fingerprint seed (always present)", () => expect(has({}, "--fingerprint=seed-1")).toBe(true));
  it("platform", () => expect(has({ platform: "windows" }, "--fingerprint-platform=windows")).toBe(true));
  it("brand", () => expect(has({ brand: "Chrome" }, "--fingerprint-brand=Chrome")).toBe(true));
  it("gpuVendor", () =>
    expect(has({ gpuVendor: "Google Inc. (NVIDIA)" }, "--fingerprint-gpu-vendor=Google Inc. (NVIDIA)")).toBe(true));
  it("gpuRenderer", () =>
    expect(has({ gpuRenderer: "ANGLE (NVIDIA)" }, "--fingerprint-gpu-renderer=ANGLE (NVIDIA)")).toBe(true));
  it("hardwareConcurrency", () =>
    expect(has({ hardwareConcurrency: 24 }, "--fingerprint-hardware-concurrency=24")).toBe(true));
  it("timezone", () => expect(has({ timezone: "Asia/Tokyo" }, "--timezone=Asia/Tokyo")).toBe(true));
  it("acceptLanguage", () => expect(has({ acceptLanguage: "fr-FR,fr" }, "--accept-lang=fr-FR,fr")).toBe(true));
  it("location", () => expect(has({ location: "35.6,139.6" }, "--fingerprint-location=35.6,139.6")).toBe(true));
  it("webrtcIp", () => expect(has({ webrtcIp: "203.0.113.7" }, "--webrtc-ip=203.0.113.7")).toBe(true));
  it("extraArgs appended verbatim", () =>
    expect(profileToArgs({ ...base, extraArgs: ["--foo", "--bar=1"] })).toEqual(
      expect.arrayContaining(["--foo", "--bar=1"]),
    ));
  it("fingerprintProfile → a --fingerprint-profile switch", () =>
    expect(startsWith({ fingerprintProfile: "x.json" }, "--fingerprint-profile=")).toBe(true));

  // ---- advanced stealth (this session's new switches) ----
  it("platformVersion", () =>
    expect(has({ platformVersion: "15.0.0" }, "--fingerprint-platform-version=15.0.0")).toBe(true));
  it("brandVersion", () =>
    expect(has({ brandVersion: "149.0.0.0" }, "--fingerprint-brand-version=149.0.0.0")).toBe(true));
  // TLS: "match-persona" is an SDK abstraction the ENGINE ignores (verified empirically vs pre.19);
  // the manager must resolve it to a concrete chrome-<brandVersion major> or emit nothing.
  it("tlsProfile match-persona → resolves to chrome-<brandVersion major> (never emits raw match-persona)", () => {
    expect(has({ tlsProfile: "match-persona", brandVersion: "120.0.6099.109" }, "--fingerprint-tls-profile=chrome-120")).toBe(true);
    expect(startsWith({ tlsProfile: "match-persona", brandVersion: "120.0.6099.109" }, "--fingerprint-tls-profile=match-persona")).toBe(false);
  });
  it("tlsProfile default (unset) follows brandVersion, like the SDK", () =>
    expect(has({ brandVersion: "131.0.1" }, "--fingerprint-tls-profile=chrome-131")).toBe(true));
  it("tlsProfile match-persona with NO brandVersion → no switch (native)", () =>
    expect(startsWith({ tlsProfile: "match-persona" }, "--fingerprint-tls-profile")).toBe(false));
  it("tlsProfile native/off → no switch (build's native TLS)", () => {
    expect(startsWith({ tlsProfile: "native", brandVersion: "120" }, "--fingerprint-tls-profile")).toBe(false);
    expect(startsWith({ tlsProfile: "off", brandVersion: "120" }, "--fingerprint-tls-profile")).toBe(false);
  });
  it("tlsProfile chrome-<major> pins it", () =>
    expect(has({ tlsProfile: "chrome-124" }, "--fingerprint-tls-profile=chrome-124")).toBe(true));
  it("resolveTlsProfile unit — every shape", () => {
    expect(resolveTlsProfile({ ...base, tlsProfile: "match-persona", brandVersion: "120.0.1" })).toBe("chrome-120");
    expect(resolveTlsProfile({ ...base, brandVersion: "149" })).toBe("chrome-149"); // unset default
    expect(resolveTlsProfile({ ...base, tlsProfile: "match-persona" })).toBe(null);  // no brandVersion
    expect(resolveTlsProfile({ ...base, tlsProfile: "native", brandVersion: "120" })).toBe(null);
    expect(resolveTlsProfile({ ...base, tlsProfile: "chrome-124" })).toBe("chrome-124");
    expect(resolveTlsProfile({ ...base, tlsProfile: "131" })).toBe("chrome-131");
  });
  it("platform=android → mobile persona + a phone window-size", () => {
    expect(has({ platform: "android" }, "--fingerprint-platform=android")).toBe(true);
    expect(has({ platform: "android" }, "--window-size=412,915")).toBe(true);
  });
  it("a desktop platform emits no window-size", () =>
    expect(startsWith({ platform: "windows" }, "--window-size")).toBe(false));
  it("storageQuota", () =>
    expect(has({ storageQuota: 250000 }, "--fingerprint-storage-quota=250000")).toBe(true));
  it("disableGpuFingerprint → --disable-gpu-fingerprint", () =>
    expect(has({ disableGpuFingerprint: true }, "--disable-gpu-fingerprint")).toBe(true));
  it("fingerprintNoise=false → --disable-fingerprint-noise", () =>
    expect(has({ fingerprintNoise: false }, "--disable-fingerprint-noise")).toBe(true));
  it("fingerprintNoise default/true emits no noise switch", () => {
    expect(startsWith({}, "--disable-fingerprint-noise")).toBe(false);
    expect(startsWith({ fingerprintNoise: true }, "--disable-fingerprint-noise")).toBe(false);
  });
  it("canvasBridgeUrl → --canvas-bridge-url", () =>
    expect(has({ canvasBridgeUrl: "ws://h:8443/render" }, "--canvas-bridge-url=ws://h:8443/render")).toBe(true));
  it("canvasBridgeAuth → switch present, secret redacted in the preview", () => {
    // Auth only means something once the bridge is enabled, so it now rides along with the url
    // (matching the SDK). A dangling --canvas-bridge-auth with no --canvas-bridge-url was a
    // switch combination no real launch produces.
    const a = profileToArgs({ ...base, canvasBridgeUrl: "ws://h:8443", canvasBridgeAuth: "user:supersecret" });
    expect(a.some((s) => s.startsWith("--canvas-bridge-auth="))).toBe(true);
    expect(a.join(" ")).not.toContain("supersecret");
  });
  it("canvasBridgeAuth WITHOUT a url emits nothing (the bridge isn't enabled)", () =>
    expect(startsWith({ canvasBridgeAuth: "user:supersecret" }, "--canvas-bridge")).toBe(false));

  it("proxy → --proxy-server host:port with credentials stripped (preview)", () => {
    const a = profileToArgs({ ...base, proxy: "http://user:pass@host:8080" });
    expect(a).toContain("--proxy-server=http://host:8080");
    expect(a.join(" ")).not.toContain("pass");
  });

  it("unset optional fields emit no switch", () => {
    const a = profileToArgs(base);
    for (const pre of ["--proxy-server=", "--webrtc-ip=", "--fingerprint-profile=", "--fingerprint-location="])
      expect(a.some((s) => s.startsWith(pre))).toBe(false);
  });

  // Four switches are now emitted even when the profile sets nothing, because their ABSENCE is
  // itself the tell: Chromium would otherwise fall back to the host's OS/locale/timezone and leak
  // it (e.g. UTC on a VM, or en-GB under an en-US persona). Covered in depth in fpargs.test.ts.
  it("locale/persona defaults are always present, not left to the host", () => {
    const a = profileToArgs(base);
    expect(a).toContain("--accept-lang=en-US,en");
    expect(a).toContain("--lang=en-US");
    expect(a).toContain("--timezone=America/New_York");
    expect(a).toContain("--fingerprint-brand=chrome");
    expect(a.some((s) => s.startsWith("--fingerprint-platform="))).toBe(true);
  });

  it("a fully-populated profile emits all switches at once", () => {
    const a = profileToArgs({
      ...base, platform: "windows", brand: "Chrome", hardwareConcurrency: 16,
      timezone: "Europe/Paris", acceptLanguage: "fr-FR,fr", webrtcIp: "203.0.113.9",
      proxy: "http://u:p@h:8080",
    });
    expect(a).toEqual(expect.arrayContaining([
      "--fingerprint=seed-1", "--fingerprint-platform=windows", "--fingerprint-brand=Chrome",
      "--fingerprint-hardware-concurrency=16", "--timezone=Europe/Paris", "--accept-lang=fr-FR,fr",
      "--webrtc-ip=203.0.113.9", "--proxy-server=http://h:8080",
    ]));
  });
});

describe("proxyString / redactProxyString", () => {
  it("passes a plain string through", () =>
    expect(proxyString("http://user:pass@h:8080")).toBe("http://user:pass@h:8080"));
  it("normalizes a legacy {server,username,password} object", () => {
    const s = proxyString({ server: "http://h:8080", username: "u", password: "p" });
    expect(s).toContain("u:p@h:8080");
  });
  it("redacts the password but keeps user + host", () => {
    const r = redactProxyString("http://user:secret@h:8080");
    expect(r).not.toContain("secret");
    expect(r).toContain("user");
    expect(r).toContain("h:8080");
  });
  it("empty proxy → empty string", () => expect(proxyString(undefined)).toBe(""));
});

// ---------------------------------------------------------------------------
// Preview parity for the r14/r15 options. The preview is what the user reads before launching, so
// an option missing here reads as "this does nothing" even when the launcher emits it.
// ---------------------------------------------------------------------------
describe("preview — r14/r15 options", () => {
  it("an authenticated socks5 proxy shows its credentials switch, password masked", () => {
    const out = profileToArgs({ ...base, proxy: "socks5://user:s3cret@gw.example.com:10000" });
    expect(out).toContain("--proxy-server=socks5://gw.example.com:10000");
    expect(out).toContain("--socks5-credentials=user:********");
    expect(out.join(" ")).not.toContain("s3cret");
  });

  it("an authenticated http proxy shows no credentials switch (the relay carries them)", () => {
    const out = profileToArgs({ ...base, proxy: "http://user:s3cret@h:8080" });
    expect(out).toContain("--proxy-server=http://h:8080");
    expect(out.some((a) => a.startsWith("--socks5-credentials"))).toBe(false);
    expect(out.join(" ")).not.toContain("s3cret");
  });

  it("portable profile", () =>
    expect(has({ portableProfile: true }, "--portable-profile")).toBe(true));

  it("the cookie encryption key is never shown in clear text", () => {
    const out = profileToArgs({ ...base, encryptionKey: "my-real-key" });
    expect(out).toContain("--profile-encryption-key=********");
    expect(out.join(" ")).not.toContain("my-real-key");
  });

  it("shaderDialect is an ENV var, not a switch — it must not leak into the args", () => {
    const out = profileToArgs({ ...base, shaderDialect: "hlsl" });
    expect(out.some((a) => a.toLowerCase().includes("hlsl"))).toBe(false);
    expect(profileToEnv({ ...base, shaderDialect: "hlsl" })).toEqual({ CLEARCOTE_SHADER_DIALECT: "hlsl" });
    expect(profileToEnv(base)).toEqual({});
  });
});
