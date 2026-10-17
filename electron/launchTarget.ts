// What a profile on "Latest" will launch right now — drives the header pill.
//
// Same precedence as the launcher (electron/launcher.ts resolveBrowserBinary): an explicit binary
// wins for every profile; otherwise the catalog resolves "latest" for this licence tier. The shape
// is mirrored in src/lib/launchTarget.ts, which words it for the UI.

import fs from "node:fs";
import { fetchCatalog, resolveVersion, MAC_NEEDS_LICENSE, type Catalog } from "./catalog";
import { resolveLicenseKey } from "./license";
import { listCached } from "./cache";
import { buildPlatformFor, bundleExecutable } from "./macos";
import type { Settings } from "./types";

export interface LaunchTarget {
  /** unavailable: this Mac has no managed build to launch (no licence key, or not Apple Silicon). */
  mode: "custom" | "managed" | "offline" | "unavailable";
  /** Why, for "unavailable". */
  reason?: string;
  path?: string;
  licensed?: boolean;
  plan?: string;
  version?: string;
  major?: number;
  downloaded?: boolean;
}

/** The catalog changes when a build ships, not per click — keep it for a few minutes. */
const CATALOG_TTL_MS = 5 * 60 * 1000;
let cached: { base: string; at: number; cat: Catalog } | null = null;

async function catalogFor(base: string | undefined, timeoutMs: number): Promise<Catalog> {
  const key = base || "";
  if (cached && cached.base === key && Date.now() - cached.at < CATALOG_TTL_MS) return cached.cat;
  const cat = await Promise.race([
    fetchCatalog(base),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("catalog timeout")), timeoutMs)),
  ]);
  cached = { base: key, at: Date.now(), cat };
  return cat;
}

/** Forget the cached catalog (the licence key changed, so "latest" may mean another build). */
export function resetLaunchTargetCache(): void {
  cached = null;
}

export async function launchTarget(
  s: Settings,
  opts: { timeoutMs?: number; platform?: NodeJS.Platform; arch?: string } = {},
): Promise<LaunchTarget> {
  const explicit = [s.binaryPath, process.env.CLEARCOTE_BINARY].find((c): c is string => !!c && fs.existsSync(c));
  if (explicit) return { mode: "custom", path: bundleExecutable(explicit) };

  const licensed = !!resolveLicenseKey(s.licenseKey);
  const plan = licensed ? s.lastPlan : undefined;
  // A Mac has a managed build only with a licence key and an Apple Silicon CPU. Say which is missing
  // rather than "offline", which would send someone to check their network.
  if ((opts.platform ?? process.platform) === "darwin") {
    try {
      buildPlatformFor("darwin", opts.arch ?? process.arch);
    } catch (e) {
      return { mode: "unavailable", licensed, plan, reason: String((e as Error).message) };
    }
    if (!licensed) return { mode: "unavailable", licensed, plan, reason: MAC_NEEDS_LICENSE };
  }
  try {
    const cat = await catalogFor(s.licenseApiBase, opts.timeoutMs ?? 8000);
    const r = resolveVersion(cat, "latest", licensed);
    // The catalog tag has no revision ("pro-153.0.8010.36"); the cache dir does ("…-r27").
    const downloaded = listCached().some((b) => b.tag === r.tag || b.tag.startsWith(r.tag + "-"));
    return { mode: "managed", licensed, plan, version: r.version, major: r.major, downloaded };
  } catch {
    return { mode: "offline", licensed, plan };
  }
}
