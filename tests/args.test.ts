import { describe, it, expect } from "vitest";
import { profileToArgs, proxyString, redactProxyString, type Profile } from "../src/types/profile";

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
    const a = profileToArgs({ ...base, canvasBridgeAuth: "user:supersecret" });
    expect(a.some((s) => s.startsWith("--canvas-bridge-auth="))).toBe(true);
    expect(a.join(" ")).not.toContain("supersecret");
  });

  it("proxy → --proxy-server host:port with credentials stripped (preview)", () => {
    const a = profileToArgs({ ...base, proxy: "http://user:pass@host:8080" });
    expect(a).toContain("--proxy-server=http://host:8080");
    expect(a.join(" ")).not.toContain("pass");
  });

  it("unset optional fields emit no switch", () => {
    const a = profileToArgs(base);
    for (const pre of ["--timezone=", "--proxy-server=", "--webrtc-ip=", "--fingerprint-platform=", "--fingerprint-profile="])
      expect(a.some((s) => s.startsWith(pre))).toBe(false);
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
