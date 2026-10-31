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

describe("higher-risk devices (the full library's no-GPU, VM and old-graphics captures)", () => {
  const SWIFT = lib("v-sw", "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)", { gpuVendor: "other", risk: "no-gpu", cores: 4 });
  const VMW = lib("v-vmw", "ANGLE (VMware, VMware SVGA 3D Direct3D11 vs_5_0 ps_5_0, D3D11)", { gpuVendor: "other", risk: "vm", vm: "vmware", cores: 4 });
  const OLD = lib("v-old", "ANGLE (Intel, Intel(R) HD Graphics 3000 Direct3D9Ex vs_3_0 ps_3_0, igdumd64.dll)", { risk: "old-gpu" });
  const ODD = lib("v-odd", "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)", { risk: "likely-vm", cores: 7 });
  const NO_GPU_HOST: HostFacts = { vendor: "unknown", kind: "software", threads: 8, os: "linux" };
  const VMWARE_HOST: HostFacts = { vendor: "unknown", kind: "vm", vm: "vmware", gpuName: "VMware SVGA 3D", threads: 4, os: "windows" };
  const text = (m: ReturnType<typeof scoreDevice>) => m.reasons.map((r) => r.text).join(" | ");

  it("on a computer with a graphics card: none fit, each says why it is riskier, and they rank last", () => {
    for (const d of [SWIFT, VMW, OLD]) {
      const m = scoreDevice(d, HOST);
      expect(m.fits).toBe(false);
      expect(m.reasons[0]).toMatchObject({ good: false, text: expect.stringMatching(/^Higher risk:/) });
    }
    expect(text(scoreDevice(SWIFT, HOST))).toContain("Fits only a computer without a graphics card");
    expect(scoreDevice(VMW, HOST).reasons.find((r) => /Fits only/.test(r.text))?.params).toEqual({ vm: "VMware" });
    // Possibly a VM: still a real NVIDIA card, so it fits, but lower than the same card without the risk.
    const odd = scoreDevice(ODD, HOST);
    expect(odd.fits).toBe(true);
    expect(odd.score).toBeLessThan(scoreDevice(RTX3060, HOST).score);
    const order = rankDevices([SWIFT, ODD, VMW, RTX3060, OLD], HOST, []).map((m) => m.lib.name);
    expect(order[0]).toBe("n-3060.json");
    expect(order[1]).toBe("v-odd.json");
  });

  it("on a computer without a graphics card: the no-GPU captures fit and come first; real-GPU ones can be disproved", () => {
    const sw = scoreDevice(SWIFT, NO_GPU_HOST);
    expect(sw.fits).toBe(true);
    expect(text(sw)).toContain("Drawn in software with {renderer}, like this computer");
    const card = scoreDevice(RTX3060, NO_GPU_HOST);
    expect(card.fits).toBe(false);
    expect(text(card)).toContain("This computer has no graphics card");
    expect(scoreDevice(VMW, NO_GPU_HOST).fits).toBe(false);
    expect(pickUnused(rankDevices([RTX3060, SWIFT, VMW, OLD], NO_GPU_HOST, []), 5).map((l) => l.name)).toEqual(["v-sw.json"]);
  });

  it("without a graphics card, the software renderer must match: WARP on Windows, SwiftShader on Linux (w01, 10-31)", () => {
    // On w01 every launch drew the same pixels (WARP) whatever the device claimed; forcing SwiftShader drew others.
    const WARP = lib("v-warp", "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)", { gpuVendor: "other", risk: "no-gpu", cores: 4 });
    const winServer: HostFacts = { vendor: "unknown", kind: "software", threads: 32, os: "windows" };
    expect(scoreDevice(WARP, winServer).fits).toBe(true);
    const sw = scoreDevice(SWIFT, winServer);
    expect(sw.fits).toBe(false);
    expect(sw.reasons.find((r) => /sites can tell/.test(r.text))?.params).toEqual({ theirs: "SwiftShader", mine: "WARP (Microsoft)" });
    expect(scoreDevice(SWIFT, NO_GPU_HOST).fits).toBe(true); // Linux: SwiftShader
    expect(scoreDevice(WARP, NO_GPU_HOST).fits).toBe(false);
    // OS unknown: neither is ruled out.
    expect([WARP, SWIFT].map((d) => scoreDevice(d, { vendor: "unknown", kind: "software" }).fits)).toEqual([true, true]);
    expect(pickUnused(rankDevices([SWIFT, WARP, RTX3060], winServer, []), 3).map((l) => l.name)).toEqual(["v-warp.json"]);
  });

  it("on a VMware virtual machine: only VMware captures fit; old graphics never do", () => {
    expect(scoreDevice(VMW, VMWARE_HOST)).toMatchObject({ fits: true });
    expect(text(scoreDevice(VMW, VMWARE_HOST))).toContain("Same virtual machine as this computer");
    expect(scoreDevice({ ...VMW, vm: "parallels" }, VMWARE_HOST).fits).toBe(false);
    expect(scoreDevice(RTX3060, VMWARE_HOST).fits).toBe(false);
    expect(scoreDevice(SWIFT, VMWARE_HOST).fits).toBe(false);
    expect(scoreDevice(OLD, VMWARE_HOST).fits).toBe(false);
  });

  it("when the kind of computer is unknown, a higher-risk device is never offered as a fit", () => {
    const unknown: HostFacts = { vendor: "unknown" };
    expect([SWIFT, VMW, OLD].map((d) => scoreDevice(d, unknown).fits)).toEqual([false, false, false]);
    expect(scoreDevice(RTX3060, unknown).fits).toBe(true);
  });
});
