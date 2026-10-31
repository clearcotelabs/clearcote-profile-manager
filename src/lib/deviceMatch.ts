// Which device profiles fit this computer, best first — the Device profiles page's ranking.
//
// A device profile (a capture from the clearcote-profiles library) fits when nothing it claims can be disproved by the
// real machine underneath: WebGL limits, extensions and precision formats come from the real card, workers run at
// the real CPU's speed, and a window cannot be larger than the screen it claims to sit on. So the score is built
// from facts about THIS computer (its GPU from host:gpu, its thread count and OS), and every point given or taken
// away comes with a reason the page shows in words.
//
// PURE: no React, no Electron. The page, the bulk "Assign devices" action and the tests import it.

import type { LibraryProfile } from "./ipc";
import type { Profile } from "@/types/profile";
import { tx } from "./i18n";

export type GpuMaker = "nvidia" | "intel" | "amd";
export type HostOsName = "windows" | "linux" | "macos";

/** What the ranking knows about this computer. Anything unknown simply earns no points either way. */
export interface HostFacts {
  /** GPU maker of the adapter driving the display; "unknown" on macOS or when detection failed. */
  vendor: GpuMaker | "unknown";
  /** The adapter's own name, e.g. "NVIDIA GeForce RTX 3070". */
  gpuName?: string;
  threads?: number;
  os?: HostOsName;
}

/** One reason, as a translatable sentence with its values. `good` = it raised the score. */
export interface Reason {
  text: string;
  params?: Record<string, string | number>;
  good: boolean;
}

export interface DeviceMatch {
  lib: LibraryProfile;
  score: number;
  /** False = it can be disproved on this computer (another GPU maker, a screen too small for a window). */
  fits: boolean;
  reasons: Reason[];
  /** Ids of the profiles that already use this device. */
  usedBy: string[];
}

/** Integrated or dedicated, and a band of cards close enough to report alike (same generation or line). */
export interface GpuClass {
  maker: GpuMaker | null;
  kind: "integrated" | "dedicated" | null;
  band: string | null;
}

const MAKER_LABEL: Record<GpuMaker, string> = { nvidia: "NVIDIA", intel: "Intel", amd: "AMD" };

/** Bands of one maker in generation order: a neighbour reports closer values than a card two generations away. */
const BAND_ORDER = [
  ["older", "gtx-10-16", "rtx-20", "rtx-30", "rtx-40+"],
  ["hd", "uhd", "iris", "iris-xe"],
  ["rx-500", "rx-5000", "rx-6000", "rx-7000", "rx-9000"],
];
function bandDistance(a: string, b: string): number {
  for (const order of BAND_ORDER) {
    const i = order.indexOf(a), j = order.indexOf(b);
    if (i >= 0 && j >= 0) return Math.abs(i - j);
  }
  return Infinity;
}

/** Screen sizes most desktops report, most common first: a rare size is a small tell of its own. */
const COMMON_SCREENS = [
  "1920x1080", "1536x864", "2560x1440", "1366x768", "1440x900", "1600x900", "1680x1050", "1920x1200",
  "1280x1024", "2560x1080", "3440x1440", "3840x2160",
];

export function makerOf(s: string | undefined): GpuMaker | null {
  const v = (s || "").toLowerCase();
  if (/nvidia|geforce|quadro/.test(v)) return "nvidia";
  if (/\bamd\b|radeon|\bati\b/.test(v)) return "amd";
  if (/intel/.test(v)) return "intel";
  return null;
}

/** The class of a GPU from its name or its WebGL renderer string ("ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 …)"). */
export function gpuClass(s: string | undefined): GpuClass {
  const v = (s || "").toLowerCase();
  const maker = makerOf(v);
  if (maker === "nvidia") {
    if (/\bquadro\b|\brtx a\d{3,4}\b|\brtx \d{4} ada\b/.test(v)) return { maker, kind: "dedicated", band: "workstation" };
    const m = /\b(rtx|gtx|gt|mx)\s*(\d{3,4})/.exec(v);
    if (!m) return { maker, kind: "dedicated", band: null };
    if (m[1] === "mx") return { maker, kind: "dedicated", band: "mx" };
    const n = Number(m[2]);
    const series = Math.floor(n / 100); // 3070 -> 30, 1650 -> 16, 960 -> 9
    const band = series >= 40 ? "rtx-40+" : series >= 30 ? "rtx-30" : series >= 20 ? "rtx-20" : series >= 10 ? "gtx-10-16" : "older";
    return { maker, kind: "dedicated", band };
  }
  if (maker === "intel") {
    if (/\barc\b/.test(v)) return { maker, kind: "dedicated", band: "arc" };
    if (/iris\(?r?\)?\s*xe|iris xe/.test(v)) return { maker, kind: "integrated", band: "iris-xe" };
    if (/iris/.test(v)) return { maker, kind: "integrated", band: "iris" };
    if (/\buhd\b/.test(v)) return { maker, kind: "integrated", band: "uhd" };
    if (/\bhd\b/.test(v)) return { maker, kind: "integrated", band: "hd" };
    return { maker, kind: "integrated", band: null };
  }
  if (maker === "amd") {
    const m = /\brx\s*(\d{3,4})/.exec(v);
    if (m) {
      const n = m[1];
      return { maker, kind: "dedicated", band: n.length === 4 ? `rx-${n[0]}000` : "rx-500" };
    }
    if (/radeon\s*(\(tm\)\s*)?(graphics|vega)|\bvega\b/.test(v)) return { maker, kind: "integrated", band: "apu" };
    return { maker, kind: "dedicated", band: null };
  }
  return { maker: null, kind: null, band: null };
}

function parseScreen(s: string | undefined): { w: number; h: number } | null {
  const m = /^(\d{3,5})\s*[x×]\s*(\d{3,5})$/.exec((s || "").trim());
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** The library file a profile uses: library downloads are stored under their own name (`vinyzu-09961.json`). */
export function usage(profiles: Profile[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of profiles) {
    const f = p.fingerprintProfile;
    if (!f) continue;
    out.set(f, [...(out.get(f) || []), p.id]);
  }
  return out;
}

/** How well one library device fits this computer. */
export function scoreDevice(lib: LibraryProfile, host: HostFacts, usedBy: string[] = []): DeviceMatch {
  const reasons: Reason[] = [];
  let score = 0;
  let fits = true;

  // GPU maker: required. A claim from another maker is falsifiable in a few WebGL calls.
  const maker = makerOf(lib.gpuVendor) || makerOf(lib.renderer);
  if (host.vendor !== "unknown" && maker) {
    if (maker === host.vendor) {
      reasons.push({ text: tx("Same GPU maker as this computer ({maker})"), params: { maker: MAKER_LABEL[maker] }, good: true });
    } else {
      fits = false;
      reasons.push({
        text: tx("Different GPU maker ({maker}) than this computer ({host}): sites can tell"),
        params: { maker: MAKER_LABEL[maker], host: MAKER_LABEL[host.vendor] },
        good: false,
      });
    }
  }

  // GPU class: integrated vs dedicated (15), then the same generation or line (15; the next one: 8). Up to 30.
  const mine = gpuClass(host.gpuName);
  const theirs = gpuClass(lib.renderer || lib.gpuFamily);
  if (fits && mine.kind && theirs.kind) {
    if (mine.kind === theirs.kind) {
      score += 15;
      const near = mine.band && theirs.band ? bandDistance(mine.band, theirs.band) : Infinity;
      if (near === 0) {
        score += 15;
        reasons.push({ text: tx("Same class of graphics card as this computer"), good: true });
      } else if (near === 1) {
        score += 8;
        reasons.push({ text: tx("Graphics one generation from this computer's"), good: true });
      } else {
        reasons.push({
          text: mine.kind === "integrated" ? tx("Built-in graphics, like this computer") : tx("Dedicated graphics card, like this computer"),
          good: true,
        });
      }
    } else {
      reasons.push({
        text: theirs.kind === "integrated" ? tx("Built-in graphics, but this computer has a graphics card") : tx("Graphics card, but this computer has built-in graphics"),
        good: false,
      });
    }
  }

  // In use: two profiles on one device link their accounts. 25.
  if (usedBy.length === 0) {
    score += 25;
    reasons.push({ text: tx("Not used by any of your profiles"), good: true });
  } else {
    reasons.push({
      text: usedBy.length === 1 ? tx("Already used by 1 of your profiles") : tx("Already used by {n} of your profiles"),
      params: { n: usedBy.length },
      good: false,
    });
  }

  // Threads: claiming more than the machine has shows in worker timing. 15, or -20.
  if (lib.cores && host.threads) {
    if (lib.cores <= host.threads) {
      score += 15;
      reasons.push({ text: tx("{n} threads, no more than this computer has"), params: { n: lib.cores }, good: true });
    } else {
      score -= 20;
      reasons.push({ text: tx("Claims {n} threads; this computer has {host}"), params: { n: lib.cores, host: host.threads }, good: false });
    }
  }

  // Screen: large enough for a real window, and a size many desktops have. Up to 15.
  const scr = parseScreen(lib.screen);
  if (lib.screenWarning) {
    fits = false;
    reasons.push({ text: tx("Screen too small to hold a browser window"), good: false });
  } else if (scr) {
    const label = `${scr.w}×${scr.h}`;
    if (COMMON_SCREENS.includes(`${scr.w}x${scr.h}`)) {
      score += 15;
      reasons.push({ text: tx("Common screen size ({size})"), params: { size: label }, good: true });
    } else {
      score += 8;
      reasons.push({ text: tx("Less common screen size ({size})"), params: { size: label }, good: false });
    }
  }

  // Platform: every library device is a Windows Chrome capture. 15 on Windows, a warning elsewhere.
  if (host.os === "windows") {
    score += 15;
  } else if (host.os) {
    reasons.push({ text: tx("Captured on Windows; this computer runs {os}"), params: { os: host.os === "macos" ? "macOS" : "Linux" }, good: false });
  }

  return { lib, score: Math.max(0, Math.min(100, score)), fits, reasons, usedBy };
}

function screenRank(lib: LibraryProfile): number {
  const scr = parseScreen(lib.screen);
  const i = scr ? COMMON_SCREENS.indexOf(`${scr.w}x${scr.h}`) : -1;
  return i < 0 ? COMMON_SCREENS.length : i;
}

/** Every device, best first: fitting ones before the rest, then score, then the least used, then the commoner screen. */
export function rankDevices(list: LibraryProfile[], host: HostFacts, profiles: Profile[]): DeviceMatch[] {
  const used = usage(profiles);
  return list
    .map((lib) => scoreDevice(lib, host, used.get(lib.name) || []))
    .sort((a, b) =>
      Number(b.fits) - Number(a.fits) || b.score - a.score || a.usedBy.length - b.usedBy.length || screenRank(a.lib) - screenRank(b.lib) ||
      a.lib.name.localeCompare(b.lib.name));
}

/** Up to `n` different fitting devices that no profile uses yet, best first: one per new profile. */
export function pickUnused(ranked: DeviceMatch[], n: number, taken: Set<string> = new Set()): LibraryProfile[] {
  const out: LibraryProfile[] = [];
  for (const m of ranked) {
    if (out.length >= n) break;
    if (!m.fits || m.usedBy.length || taken.has(m.lib.name)) continue;
    out.push(m.lib);
  }
  return out;
}

/** Profiles a library device can go on: desktop Windows personas. A library device is a Windows capture, so a Linux,
 *  macOS or phone persona would claim one platform and report another's values. */
export function canTakeDevice(p: Profile): boolean {
  return !p.platform || p.platform === "windows";
}

/** A device for each profile that has none (or every one, with `replace`), each a different unused fitting device.
 *  Returns the pairs; profiles left out are those that keep theirs, cannot take one, or ran out of devices. */
export function planAssign(
  profiles: Profile[],
  library: LibraryProfile[],
  host: HostFacts,
  allProfiles: Profile[],
  opts: { replace?: boolean } = {},
): { pairs: Array<{ profile: Profile; lib: LibraryProfile }>; kept: Profile[]; wrongPlatform: Profile[]; short: Profile[] } {
  const kept: Profile[] = [];
  const wrongPlatform: Profile[] = [];
  const want: Profile[] = [];
  for (const p of profiles) {
    if (!canTakeDevice(p)) wrongPlatform.push(p);
    else if (p.fingerprintProfile && !opts.replace) kept.push(p);
    else want.push(p);
  }
  // A device a selected profile is giving up counts as free: ranked as if that profile had none.
  const leaving = new Set(want.map((p) => p.id));
  const others = allProfiles.map((p) => (leaving.has(p.id) ? { ...p, fingerprintProfile: undefined } : p));
  const libs = pickUnused(rankDevices(library, host, others), want.length);
  return {
    pairs: libs.map((lib, i) => ({ profile: want[i], lib })),
    kept,
    wrongPlatform,
    short: want.slice(libs.length),
  };
}
