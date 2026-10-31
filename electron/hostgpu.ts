// Which GPU drives this machine's display — the one the engine's "real GPU" means.
//
// The engine's rule is "the adapter that drives the display" (DXGI adapter 0 on Windows). The GPU
// model picker needs the same answer: the strongest coherence comes from claiming a model of this
// machine's own GPU maker, because driver limits (max texture size, extensions, precision formats)
// follow the real card, so a claim from another maker is falsifiable in a few WebGL calls.
//
// Windows asks WMI through PowerShell — the one tool every Windows install has — and prefers the
// controller that has a resolution, i.e. the one with a display attached. Linux reads the DRM
// class under /sys and prefers the boot VGA device. macOS is reported as unknown: an Apple Silicon
// GPU is none of the picker's vendors, so the picker simply lists every vendor.
//
// It also says what kind of adapter it is: a real GPU, none (Microsoft's basic or remote display adapter, a VM's
// plain virtual display, a Linux machine or container without a DRM card — the engine then draws in software), or
// a virtual machine's 3D adapter (VMware, VirtualBox, Parallels). Device profiles matches devices captured the
// same way to those computers.
//
// The parsers are pure functions over the text those sources produce, so the fixtures in
// tests/hostgpu.test.ts are real PowerShell JSON shapes (one object vs an array; null resolution)
// rather than a mock of WMI.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type HostGpuVendor = "nvidia" | "intel" | "amd" | "unknown";
/** "software" = no graphics card: the engine draws with SwiftShader. Absent when it could not be told. */
export type HostGpuKind = "gpu" | "software" | "vm";
export type HostVm = "vmware" | "virtualbox" | "parallels";

export interface HostGpu {
  vendor: HostGpuVendor;
  /** The controller's own name, e.g. "NVIDIA GeForce RTX 3070"; "" when nothing was found. */
  name: string;
  /** PCI device id (DEV_xxxx), when the id could be read. */
  deviceId: number | null;
  kind?: HostGpuKind;
  /** Which virtual machine, when kind is "vm". */
  vm?: HostVm;
}

export const UNKNOWN_GPU: HostGpu = { vendor: "unknown", name: "", deviceId: null };

/** PCI vendor ids. 0x1414 is Microsoft's Basic Render Driver — software, so "unknown". */
export const PCI_VENDORS: Record<number, HostGpuVendor> = {
  0x10de: "nvidia",
  0x8086: "intel",
  0x1002: "amd",
};

export function vendorFromPciId(vendorId: number | null): HostGpuVendor {
  return vendorId === null ? "unknown" : (PCI_VENDORS[vendorId] ?? "unknown");
}

/** Virtual machines whose adapter does 3D, so Chrome draws on it and reports it (as the dataset's VM captures do). */
const VM_PCI: Record<number, HostVm> = { 0x15ad: "vmware", 0x80ee: "virtualbox", 0x1ab8: "parallels" };
/** Display adapters without 3D: Microsoft's basic/Hyper-V video, QEMU's virtio/QXL/Bochs, Cirrus. Chrome draws in
 *  software on them. */
const SOFTWARE_PCI = new Set([0x1414, 0x1af4, 0x1b36, 0x1234, 0x1013]);

/** What kind of adapter this is, from its PCI vendor id and name; undefined when neither tells. */
export function adapterKind(vendorId: number | null, name: string): { kind?: HostGpuKind; vm?: HostVm } {
  const n = name.toLowerCase();
  const vm = (vendorId !== null ? VM_PCI[vendorId] : undefined) ??
    (/vmware|svga/.test(n) ? "vmware" : /virtualbox/.test(n) ? "virtualbox" : /parallels/.test(n) ? "parallels" : undefined);
  if (vm) return { kind: "vm", vm };
  if ((vendorId !== null && SOFTWARE_PCI.has(vendorId)) || /microsoft basic|remote display|hyper-v video|llvmpipe|swiftshader/.test(n))
    return { kind: "software" };
  if (vendorId !== null && PCI_VENDORS[vendorId]) return { kind: "gpu" };
  return {};
}

/** The exact command the Windows path runs. One line, so it is quotable in a bug report. */
export const WINDOWS_GPU_COMMAND = {
  file: "powershell",
  args: [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_VideoController | Select-Object Name,PNPDeviceID,CurrentHorizontalResolution | ConvertTo-Json",
  ],
};

/** VEN_xxxx / DEV_xxxx out of a PNP device id such as
 *  `PCI\VEN_10DE&DEV_2484&SUBSYS_88D9103C&REV_A1\4&32396228&0&0009`. */
export function parsePnpDeviceId(pnp: string | null | undefined): { vendorId: number | null; deviceId: number | null } {
  const s = String(pnp ?? "");
  const ven = /VEN_([0-9A-Fa-f]{4})/.exec(s);
  const dev = /DEV_([0-9A-Fa-f]{4})/.exec(s);
  return { vendorId: ven ? parseInt(ven[1], 16) : null, deviceId: dev ? parseInt(dev[1], 16) : null };
}

interface WinController {
  Name?: unknown;
  PNPDeviceID?: unknown;
  CurrentHorizontalResolution?: unknown;
}

/**
 * The display adapter out of `ConvertTo-Json`'s output. PowerShell prints ONE controller as a bare
 * object and several as an array, and a controller with no display attached has a null
 * CurrentHorizontalResolution — so the one with a resolution is the one driving a screen. With no
 * resolution anywhere, the first hardware controller (not Microsoft's software renderer) is taken.
 */
export function parseWindowsControllers(json: string): HostGpu {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.trim() || "null");
  } catch {
    return UNKNOWN_GPU;
  }
  const list: WinController[] = Array.isArray(parsed)
    ? parsed.filter((x): x is WinController => !!x && typeof x === "object")
    : parsed && typeof parsed === "object"
      ? [parsed as WinController]
      : [];
  if (!list.length) return UNKNOWN_GPU;

  const hasResolution = (c: WinController) => typeof c.CurrentHorizontalResolution === "number" && c.CurrentHorizontalResolution > 0;
  const isSoftware = (c: WinController) => parsePnpDeviceId(String(c.PNPDeviceID ?? "")).vendorId === 0x1414;
  const chosen = list.find(hasResolution) ?? list.find((c) => !isSoftware(c)) ?? list[0];

  const { vendorId, deviceId } = parsePnpDeviceId(String(chosen.PNPDeviceID ?? ""));
  const name = typeof chosen.Name === "string" ? chosen.Name.trim() : "";
  return { vendor: vendorFromPciId(vendorId), name, deviceId, ...adapterKind(vendorId, name) };
}

export interface DrmCard {
  /** Contents of /sys/class/drm/cardN/device/vendor, e.g. "0x10de\n". */
  vendor: string | null;
  /** Contents of .../device/device, e.g. "0x2484\n". */
  device: string | null;
  /** Contents of .../device/boot_vga ("1" for the boot display), or null when absent. */
  bootVga: string | null;
  /** A name for the report, when one is known (the picker only needs the vendor). */
  name?: string;
}

const hexOrNull = (s: string | null) => {
  const m = /^\s*(?:0x)?([0-9A-Fa-f]{1,4})\s*$/.exec(s ?? "");
  return m ? parseInt(m[1], 16) : null;
};

/** The boot VGA card, else the first card with a vendor id. `null` = /sys/class/drm could not be read (unknown);
 *  an empty list = it could and there is no card, so the engine draws in software (a VPS, a container). */
export function parseLinuxDrm(cards: DrmCard[] | null): HostGpu {
  if (cards && cards.length === 0) return { ...UNKNOWN_GPU, kind: "software" };
  const known = (cards ?? []).filter((c) => hexOrNull(c.vendor) !== null);
  if (!known.length) return UNKNOWN_GPU;
  const chosen = known.find((c) => (c.bootVga ?? "").trim() === "1") ?? known[0];
  const vendorId = hexOrNull(chosen.vendor);
  const name = chosen.name ?? "";
  return { vendor: vendorFromPciId(vendorId), name, deviceId: hexOrNull(chosen.device), ...adapterKind(vendorId, name) };
}

export interface DetectOptions {
  platform?: NodeJS.Platform;
  /** Runs a command and resolves with its stdout. Injected by tests; execFile otherwise. */
  run?: (file: string, args: string[]) => Promise<string>;
  /** Reads /sys/class/drm (null when it can't be read). Injected by tests; node:fs otherwise. */
  readDrm?: () => DrmCard[] | null;
  timeoutMs?: number;
}

function execText(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

function readDrmCards(): DrmCard[] | null {
  const root = "/sys/class/drm";
  const read = (p: string): string | null => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  // cardN only — "card0-DP-1" and friends are connectors, not devices.
  return names
    .filter((n) => /^card\d+$/.test(n))
    .sort()
    .map((n) => {
      const dev = path.join(root, n, "device");
      return { vendor: read(path.join(dev, "vendor")), device: read(path.join(dev, "device")), bootVga: read(path.join(dev, "boot_vga")) };
    });
}

/** Detect once. Never throws: anything that goes wrong is "unknown", and the picker lists every vendor. */
export async function detectHostGpu(opts: DetectOptions = {}): Promise<HostGpu> {
  const platform = opts.platform ?? process.platform;
  try {
    if (platform === "win32") {
      const run = opts.run ?? ((f, a) => execText(f, a, opts.timeoutMs ?? 15000));
      return parseWindowsControllers(await run(WINDOWS_GPU_COMMAND.file, WINDOWS_GPU_COMMAND.args));
    }
    if (platform === "linux") return parseLinuxDrm((opts.readDrm ?? readDrmCards)());
  } catch {
    /* fall through */
  }
  return UNKNOWN_GPU;
}

let cached: Promise<HostGpu> | null = null;

/** The host GPU, detected once per app run. The hardware does not change while the app is open,
 *  and PowerShell takes a second or two to answer, so the answer is kept for the whole run. */
export function hostGpuCached(opts?: DetectOptions): Promise<HostGpu> {
  if (!cached) {
    cached = detectHostGpu(opts).catch(() => UNKNOWN_GPU);
  }
  return cached;
}

/** Tests only: forget the cached answer. */
export function resetHostGpuCache(): void {
  cached = null;
}
