// The GPU model table behind the editor's "GPU model" picker.
//
// WHY. Every profile used to report the same GPU: the engine picks one model per host vendor, and
// the only way to change it was two free-text fields that expected the exact WebGL strings — which
// nobody has to hand (customer report CR-5Q7RKX). This table holds the pre-checked models and
// produces both strings in the form the engine prints for each platform, so a profile claims a
// different card by picking a name rather than by typing an ANGLE renderer string from memory.
//
// Two forms per model, because the renderer string names the backend: on Windows the engine prints
// ANGLE's Direct3D11 form with the PCI device id, on Linux its OpenGL form on top of the driver
// (NVIDIA's own, Mesa for Intel and AMD). A Windows persona on a Linux host still claims the
// Direct3D11 form, so the PROFILE's platform picks the form, not the host.
//
// PURE: no React, no `node:` imports, no Electron. The renderer, the coherence rules and the tests
// all import it. The DATA here is provisional and will be replaced by a corpus-validated list; the
// exported shape and the helpers are the contract, so keep both stable.

export type GpuVendor = "nvidia" | "intel" | "amd";

export interface GpuModel {
  vendor: GpuVendor;
  /** Human label, e.g. "GeForce RTX 4070". */
  name: string;
  /** PCI device id, e.g. 0x2786. */
  deviceId: number;
  /** Dawn spelling, e.g. "lovelace", "gen-12lp", "rdna-2". */
  architecture: string;
  windows: { vendor: string; renderer: string };
  linux: { vendor: string; renderer: string };
}

/** ANGLE prints the device id as "0x" + 8 upper-case hex digits. */
const hex8 = (id: number) => "0x" + id.toString(16).toUpperCase().padStart(8, "0");

const VENDOR_TOKEN: Record<GpuVendor, string> = { nvidia: "NVIDIA", intel: "Intel", amd: "AMD" };

/** The Windows pair: `Google Inc. (<Tok>)` and ANGLE's D3D11 form around the device description. */
function windowsStrings(vendor: GpuVendor, desc: string, deviceId: number) {
  const tok = VENDOR_TOKEN[vendor];
  return {
    vendor: `Google Inc. (${tok})`,
    renderer: `ANGLE (${tok}, ${desc} (${hex8(deviceId)}) Direct3D11 vs_5_0 ps_5_0, D3D11)`,
  };
}

/** The Linux pairs, one per driver family. */
const linuxNvidia = (desc: string) => ({
  vendor: "Google Inc. (NVIDIA Corporation)",
  renderer: `ANGLE (NVIDIA Corporation, ${desc}/PCIe/SSE2, OpenGL 4.5.0)`,
});
const linuxIntel = (mesaName: string, codename: string) => ({
  vendor: "Google Inc. (Intel)",
  renderer: `ANGLE (Intel, Mesa ${mesaName} (${codename}), OpenGL 4.6)`,
});
const linuxAmd = (desc: string, chip: string) => ({
  vendor: "Google Inc. (AMD)",
  renderer: `ANGLE (AMD, ${desc} (radeonsi, ${chip}, LLVM 15.0.7, DRM 3.54, 6.5.0-generic), OpenGL 4.6)`,
});

function nvidia(name: string, deviceId: number, architecture: string): GpuModel {
  const desc = `NVIDIA ${name}`;
  return { vendor: "nvidia", name, deviceId, architecture, windows: windowsStrings("nvidia", desc, deviceId), linux: linuxNvidia(desc) };
}
/** `mesaName` is what Mesa calls the part when it differs from the Windows description. */
function intel(name: string, deviceId: number, architecture: string, codename: string, mesaName?: string): GpuModel {
  const desc = `Intel(R) ${name}`;
  return {
    vendor: "intel",
    name,
    deviceId,
    architecture,
    windows: windowsStrings("intel", desc, deviceId),
    linux: linuxIntel(mesaName ?? desc, codename),
  };
}
function amd(name: string, deviceId: number, architecture: string, chip: string): GpuModel {
  const desc = `AMD ${name}`;
  return { vendor: "amd", name, deviceId, architecture, windows: windowsStrings("amd", desc, deviceId), linux: linuxAmd(desc, chip) };
}

/** Provisional. Host-vendor order (NVIDIA, Intel, AMD), then newest architecture last. */
export const GPU_MODELS: readonly GpuModel[] = Object.freeze([
  nvidia("GeForce RTX 3060", 0x2504, "ampere"),
  nvidia("GeForce RTX 3070", 0x2484, "ampere"),
  nvidia("GeForce RTX 4060", 0x2882, "lovelace"),
  nvidia("GeForce RTX 4070", 0x2786, "lovelace"),
  intel("UHD Graphics 770", 0xa780, "gen-12lp", "RPL-S"),
  intel("UHD Graphics 730", 0x4682, "gen-12lp", "ADL-S GT1"),
  intel("Iris(R) Xe Graphics", 0x9a49, "gen-12lp", "TGL GT2", "Intel(R) Xe Graphics"),
  amd("Radeon RX 6700 XT", 0x73df, "rdna-2", "navi22"),
  amd("Radeon RX 7800 XT", 0x747e, "rdna-3", "navi32"),
]);

/** The models of one vendor; every model when the host vendor is unknown. */
export function modelsForVendor(v: GpuVendor | "unknown"): GpuModel[] {
  return v === "unknown" ? [...GPU_MODELS] : GPU_MODELS.filter((m) => m.vendor === v);
}

/**
 * The table entry a stored vendor/renderer pair denotes, in either platform's form, or null when
 * the pair matches none (including a pair with only one half set). Whitespace at the ends is
 * forgiven, because the strings travel through text inputs; nothing else is, because a renderer
 * string that differs by one character is a different claim.
 */
export function findModel(gpuVendor: string | undefined, gpuRenderer: string | undefined): GpuModel | null {
  const v = (gpuVendor ?? "").trim();
  const r = (gpuRenderer ?? "").trim();
  if (!v || !r) return null;
  for (const m of GPU_MODELS) {
    if ((m.windows.vendor === v && m.windows.renderer === r) || (m.linux.vendor === v && m.linux.renderer === r)) return m;
  }
  return null;
}

/** The pair to store for a model on a platform, keyed as the profile stores them. */
export function stringsFor(m: GpuModel, platform: "windows" | "linux"): { gpuVendor: string; gpuRenderer: string } {
  const s = platform === "linux" ? m.linux : m.windows;
  return { gpuVendor: s.vendor, gpuRenderer: s.renderer };
}

/**
 * A model drawn uniformly from the vendor's table (every model when the vendor is unknown), never
 * `exclude` — unless it is the only candidate, in which case there is nothing else to return.
 * `rnd` is Math.random by default; tests inject their own.
 */
export function randomModel(v: GpuVendor | "unknown", exclude?: GpuModel | null, rnd: () => number = Math.random): GpuModel {
  const all = modelsForVendor(v);
  // By identity of the model (vendor + device id), not by object reference, so a structural copy
  // of a table entry excludes it just as well.
  const pool = exclude ? all.filter((m) => !(m.vendor === exclude.vendor && m.deviceId === exclude.deviceId)) : all;
  const from = pool.length ? pool : all;
  if (!from.length) throw new Error(`no GPU models for vendor ${v}`);
  // Clamp: a `rnd` that returns exactly 1 (or more) must not index past the end.
  const i = Math.min(from.length - 1, Math.max(0, Math.floor(rnd() * from.length)));
  return from[i];
}
