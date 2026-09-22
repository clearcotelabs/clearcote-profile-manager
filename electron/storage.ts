// Disk housekeeping for Settings → Storage: which builds can go (the rules are in cacheplan.ts),
// removing them, and doing it automatically after a newer build arrives.

import { fetchCatalog, resolveVersion, type Catalog } from "./catalog";
import { listCached, removeDirIfUnused, type CachedBuild } from "./cache";
import { planPrune, type KeepRule, type PrunePlan } from "./cacheplan";
import { resolveLicenseKey } from "./license";
import { listProfiles } from "./profiles";
import { runningBinaries } from "./launcher";
import type { Profile, Settings } from "./types";

export interface StoragePlan extends PrunePlan {
  /** The catalog could not be reached, so pins could not be resolved: nothing is removable. */
  offline: boolean;
}

export interface PlanDeps {
  catalog: () => Promise<Catalog>;
  profiles: () => Profile[];
  running: () => string[];
  cached: () => CachedBuild[];
}

const defaultDeps = (s: Settings): PlanDeps => ({
  catalog: () => fetchCatalog(s.licenseApiBase),
  profiles: listProfiles,
  running: runningBinaries,
  cached: listCached,
});

/** The keep rules for this licence: what "Latest" is now, plus every profile's pin. */
export function keepRules(cat: Catalog, profiles: Profile[], licensed: boolean): KeepRule[] {
  const rules: KeepRule[] = [];
  try {
    rules.push({ tag: resolveVersion(cat, "latest", licensed).tag, reason: "Latest" });
  } catch {
    /* no build for this OS */
  }
  for (const p of profiles) {
    const v = (p.browserVersion ?? "").trim();
    if (!v || /^(latest|auto)$/i.test(v)) continue;
    try {
      rules.push({ tag: resolveVersion(cat, v, licensed).tag, reason: `Pinned by ${p.name?.trim() || p.id}` });
    } catch {
      /* a pin the catalog no longer knows keeps nothing */
    }
  }
  return rules;
}

export async function storagePlan(s: Settings, deps: PlanDeps = defaultDeps(s)): Promise<StoragePlan> {
  const cached = deps.cached();
  const inUse = deps.running().map((path) => ({ path, reason: "Running" }));
  if (s.binaryPath) inUse.push({ path: s.binaryPath, reason: "Custom binary" });
  let cat: Catalog;
  try {
    cat = await deps.catalog();
  } catch {
    // Without the catalog a pin cannot be matched to a build, so nothing is safe to remove.
    return { keep: cached.map((build) => ({ build, reasons: ["Unknown (offline)"] })), remove: [], freeBytes: 0, offline: true };
  }
  const licensed = !!resolveLicenseKey(s.licenseKey);
  return { ...planPrune(cached, keepRules(cat, deps.profiles(), licensed), inUse), offline: false };
}

/** Remove every build the plan says nothing needs. A build a browser is running from is skipped
 *  (see removeDirIfUnused), never half-deleted. */
export async function pruneBuilds(
  s: Settings,
  deps: PlanDeps = defaultDeps(s),
): Promise<{ removed: number; freedBytes: number; skipped: number }> {
  const plan = await storagePlan(s, deps);
  let removed = 0;
  let freedBytes = 0;
  let skipped = 0;
  for (const b of plan.remove) {
    if ((await removeDirIfUnused(b.path)) === "removed") {
      removed++;
      freedBytes += b.sizeBytes;
    } else skipped++;
  }
  return { removed, freedBytes, skipped };
}
