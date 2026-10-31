import { describe, expect, it } from "vitest";
import { canTakeDevice, gpuClass, makerOf, pickUnused, planAssign, rankDevices, scoreDevice, type HostFacts } from "../src/lib/deviceMatch";
import type { LibraryProfile } from "../src/lib/ipc";
import type { Profile } from "../src/types/profile";

// Renderer strings as the clearcote-profiles index carries them.
const lib = (id: string, renderer: string, extra: Partial<LibraryProfile> = {}): LibraryProfile => ({
  name: `${id}.json`,
  downloadUrl: `https://raw.githubusercontent.com/clearcotelabs/clearcote-profiles/main/samples/${id}.json`,
  gpuVendor: makerOf(renderer) === "nvidia" ? "NVIDIA" : makerOf(renderer) === "amd" ? "AMD" : "Intel",
  renderer,
  screen: "1920x1080",
  cores: 8,
  memory: 8,
  ...extra,
});
const RTX3060 = lib("n-3060", "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)");
const RTX4070 = lib("n-4070", "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)");
const GTX1650 = lib("n-1650", "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F82) Direct3D11 vs_5_0 ps_5_0, D3D11)");
const UHD620 = lib("i-uhd", "ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)");
const RADEON = lib("a-apu", "ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)");
const HOST: HostFacts = { vendor: "nvidia", gpuName: "NVIDIA GeForce RTX 3070", threads: 16, os: "windows" };
const profile = (id: string, extra: Partial<Profile> = {}): Profile => ({ id, name: id, platform: "windows", ...extra }) as Profile;

describe("GPU class", () => {
  it("tells built-in graphics from a card, and groups cards of one generation", () => {
    expect(gpuClass("NVIDIA GeForce RTX 3070")).toEqual({ maker: "nvidia", kind: "dedicated", band: "rtx-30" });
    expect(gpuClass(RTX3060.renderer).band).toBe("rtx-30");
    expect(gpuClass(GTX1650.renderer).band).toBe("gtx-10-16");
    expect(gpuClass("NVIDIA GeForce GTX 960").band).toBe("older");
    expect(gpuClass(UHD620.renderer)).toEqual({ maker: "intel", kind: "integrated", band: "uhd" });
    expect(gpuClass("Intel(R) Arc(TM) A770 Graphics").kind).toBe("dedicated");
    expect(gpuClass("Intel(R) Iris(R) Xe Graphics").band).toBe("iris-xe");
    expect(gpuClass(RADEON.renderer)).toEqual({ maker: "amd", kind: "integrated", band: "apu" });
    expect(gpuClass("AMD Radeon RX 6700 XT").band).toBe("rx-6000");
    expect(gpuClass("Apple M2").maker).toBeNull();
  });
});

describe("scoring one device", () => {
  it("gives a same-generation, unused, common-screen device on Windows the full 100", () => {
    const m = scoreDevice(RTX3060, HOST);
    expect(m.fits).toBe(true);
    expect(m.score).toBe(100);
    expect(m.reasons.every((r) => r.good)).toBe(true);
  });

  it("marks another GPU maker as not fitting, with the reason", () => {
    const m = scoreDevice(UHD620, HOST);
    expect(m.fits).toBe(false);
    expect(m.reasons[0]).toMatchObject({ good: false, params: { maker: "Intel", host: "NVIDIA" } });
  });

  it("takes points for an older card, a device in use, more threads than the computer has and a rare screen", () => {
    expect(scoreDevice(GTX1650, HOST).score).toBe(85); // same kind, two generations away: 15 of 30
    expect(scoreDevice(RTX4070, HOST).score).toBe(93); // the next generation: 23 of 30
    expect(scoreDevice(RTX3060, HOST, ["p1"]).score).toBe(75);
    expect(scoreDevice({ ...RTX3060, cores: 24 }, HOST).score).toBe(65); // -20 instead of +15
    expect(scoreDevice({ ...RTX3060, screen: "1494x934" }, HOST).score).toBe(93);
  });

  it("hides a screen too small for a window", () => {
    const m = scoreDevice({ ...RTX3060, screen: "1024x600", screenWarning: "too small" }, HOST);
    expect(m.fits).toBe(false);
  });

  it("earns nothing either way for what it does not know, and warns off Windows", () => {
    const m = scoreDevice(RTX3060, { vendor: "unknown", os: "macos" });
    expect(m.fits).toBe(true);
    expect(m.score).toBe(40); // unused 25 + common screen 15
    expect(m.reasons.some((r) => !r.good && r.params?.os === "macOS")).toBe(true);
  });
});

describe("ranking and assigning", () => {
  const all = [UHD620, GTX1650, RTX4070, RTX3060, RADEON];

  it("puts fitting devices first, best score first, the used one below the unused ones", () => {
    const ranked = rankDevices(all, HOST, [profile("p1", { fingerprintProfile: "n-3060.json" })]);
    expect(ranked.map((m) => m.lib.name)).toEqual(["n-4070.json", "n-1650.json", "n-3060.json", "a-apu.json", "i-uhd.json"]);
    expect(ranked.find((m) => m.lib.name === "n-3060.json")!.usedBy).toEqual(["p1"]);
  });

  it("picks different unused devices for new profiles and stops when they run out", () => {
    const ranked = rankDevices(all, HOST, [profile("p1", { fingerprintProfile: "n-3060.json" })]);
    expect(pickUnused(ranked, 5).map((l) => l.name)).toEqual(["n-4070.json", "n-1650.json"]);
  });

  it("gives each selected profile its own device, keeps devices already set, and skips non-Windows personas", () => {
    const ps = [profile("a"), profile("b", { fingerprintProfile: "n-1650.json" }), profile("c", { platform: "linux" }), profile("d")];
    const plan = planAssign(ps, all, HOST, ps);
    expect(plan.pairs.map((x) => [x.profile.id, x.lib.name])).toEqual([["a", "n-3060.json"], ["d", "n-4070.json"]]);
    expect(plan.kept.map((p) => p.id)).toEqual(["b"]);
    expect(plan.wrongPlatform.map((p) => p.id)).toEqual(["c"]);
    expect(plan.short).toEqual([]);
  });

  it("with replace, a profile may get the device it gives up, and runs short honestly", () => {
    const ps = [profile("b", { fingerprintProfile: "n-4070.json" }), profile("e"), profile("f"), profile("g")];
    const plan = planAssign(ps, all, HOST, ps, { replace: true });
    expect(plan.pairs.map((x) => x.lib.name)).toEqual(["n-3060.json", "n-4070.json", "n-1650.json"]);
    expect(plan.short.map((p) => p.id)).toEqual(["g"]);
    expect(canTakeDevice(profile("x", { platform: "android" } as Partial<Profile>))).toBe(false);
  });
});
