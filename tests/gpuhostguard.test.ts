// The GPU vendor guard (electron/persona.ts, the SDK's persona.ts warnGpuHostMismatch): the GPU a persona declares
// against the one this computer renders on, as a launch warning.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  GPU_CHECK_ENV, clearPersonaCaches, gpuHostMismatch, gpuMaker, gpuSource, personaGpuFromToken, preparePersonaLaunch,
} from "../electron/persona";

const AMD = { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 6600 (0x000073FF) Direct3D11 vs_5_0 ps_5_0, D3D11)" };
const NV = { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 (0x00002184) Direct3D11 vs_5_0 ps_5_0, D3D11)" };
const INTEL = { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 770 (0x00004680) Direct3D11 vs_5_0 ps_5_0, D3D11)" };
const SWIFT = { vendor: "Google Inc. (Google)", renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)" };

function token(gpu: { vendor: string; renderer: string } | null): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { v: 1, iat: now, nbf: now - 30, exp: now + 3600, p: gpu ? { codec: 1, persona: { webgl_vendor: gpu.vendor, webgl_renderer: gpu.renderer } } : {} };
  return `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.c2ln`;
}

describe("reading the persona token", () => {
  it("reads the WebGL vendor and renderer; null for anything else", () => {
    expect(personaGpuFromToken(token(AMD))).toEqual(AMD);
    expect(personaGpuFromToken(token(null))).toBeNull();
    expect(personaGpuFromToken("tok-abc")).toBeNull();
  });
  it("names the maker of ANGLE and Chrome vendor strings", () => {
    expect(gpuMaker(AMD.renderer)).toBe("amd");
    expect(gpuMaker(NV.vendor)).toBe("nvidia");
    expect(gpuMaker(SWIFT.renderer)).toBe("google");
  });
  it("names where the GPU came from", () => {
    expect(gpuSource({ "fingerprint-gpu-vendor": "x" }, null)).toBe("options");
    expect(gpuSource({}, JSON.stringify({ webgl: { webgl1: { debug: { UNMASKED_RENDERER_WEBGL: "x" } } } }))).toBe("profile");
    expect(gpuSource({}, JSON.stringify({ screen: {} }))).toBe("engine");
  });
});

describe("gpuHostMismatch", () => {
  it("a declared vendor that is not this computer's", () => {
    const w = gpuHostMismatch(AMD, { gpu_vendor: "nvidia" }, [], "options");
    expect(w).toContain("The GPU vendor / renderer fields declare a AMD GPU");
    expect(w).toContain("this computer renders on NVIDIA");
    expect(w).toContain("card that computes");
    expect(gpuHostMismatch(INTEL, { gpu_vendor: "nvidia" }, [], "profile")).toContain("device profile captured on a computer with the same GPU maker");
  });
  it("the same vendor, a software renderer, or the real GPU strings: nothing", () => {
    expect(gpuHostMismatch(NV, { gpu_vendor: "nvidia" }, [], "options")).toBeNull();
    expect(gpuHostMismatch(SWIFT, { gpu_vendor: "nvidia" }, [], "options")).toBeNull();
    expect(gpuHostMismatch(AMD, { gpu_vendor: "nvidia" }, ["--disable-gpu-string-spoof"], "options")).toBeNull();
    expect(gpuHostMismatch(AMD, { gpu_vendor: "nvidia" }, ["--canvas-bridge-url=ws://x"], "options")).toBeNull();
  });
  it("a graphics card's name on a software-rendering computer", () => {
    expect(gpuHostMismatch(INTEL, { gpu_vendor: "none" }, [], "engine")).toContain("renders WebGL in software");
  });
});

describe("preparePersonaLaunch returns the warning", () => {
  let dir: string;
  let bin: string;
  const lease = { token: "hdr.sig", leaseId: "L1" };
  const R51 = (_b: string | undefined, name: string) => name === "cc-persona-host-facts";
  const deps = (vendor: string, gpu: typeof AMD) => ({
    supports: R51, runner: () => `{"gpu_vendor":"${vendor}"}\n`,
    fetch: async () => ({ token: token(gpu), exp: Date.now() / 1000 + 3600 }),
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-gpuguard-"));
    bin = path.join(dir, "chrome");
    fs.writeFileSync(bin, "x");
    clearPersonaCaches();
    delete process.env[GPU_CHECK_ENV];
  });
  afterEach(() => { clearPersonaCaches(); fs.rmSync(dir, { recursive: true, force: true }); delete process.env[GPU_CHECK_ENV]; });

  it("GPU vendor AMD on an NVIDIA computer: a warning; NVIDIA: none", async () => {
    const a = await preparePersonaLaunch(bin, ["--fingerprint=1", `--fingerprint-gpu-vendor=${AMD.vendor}`, `--fingerprint-gpu-renderer=${AMD.renderer}`], lease, deps("nvidia", AMD));
    expect(a.gpuWarning).toContain("this computer renders on NVIDIA");
    const b = await preparePersonaLaunch(bin, ["--fingerprint=2"], lease, deps("nvidia", NV));
    expect(b.gpuWarning).toBeUndefined();
  });

  it("a device profile of another maker", async () => {
    const prof = gzipSync(Buffer.from(JSON.stringify({ webgl: { webgl1: { debug: { UNMASKED_VENDOR_WEBGL: INTEL.vendor, UNMASKED_RENDERER_WEBGL: INTEL.renderer } } } }))).toString("base64");
    const p = await preparePersonaLaunch(bin, [`--fingerprint-profile=${prof}`], lease, deps("nvidia", INTEL));
    expect(p.gpuWarning).toContain("The device profile declares a Intel GPU");
  });

  it("CLEARCOTE_NO_GPU_HOST_CHECK=1 silences it", async () => {
    process.env[GPU_CHECK_ENV] = "1";
    const a = await preparePersonaLaunch(bin, ["--fingerprint=1", `--fingerprint-gpu-vendor=${AMD.vendor}`], lease, deps("nvidia", AMD));
    expect(a.gpuWarning).toBeUndefined();
  });
});
