// Downloaded-browser cache management — list the browser builds already downloaded + verified
// under the cache root (one dir per tag, e.g. `pro-150.0.7871.114`, `v0.1.0-pre.21`), and remove
// one so the next launch re-downloads it. Explicit-binary / dev-build paths aren't in the cache
// and aren't listed here.

import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cacheRoot } from "./proBinary";

export interface CachedBuild {
  tag: string; // cache dir name (the removal key)
  version: string; // best-effort human version
  tier: "free" | "pro";
  sizeBytes: number;
  path: string;
}

function dirSize(dir: string): number {
  let total = 0;
  let stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else {
        try {
          total += statSync(full).size;
        } catch {
          /* skip */
        }
      }
    }
  }
  return total;
}

/** List the browser builds currently downloaded + verified in the cache. */
export function listCached(): CachedBuild[] {
  const root = cacheRoot();
  if (!existsSync(root)) return [];
  const out: CachedBuild[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const tag = entry.name;
    const dir = join(root, tag);
    // Only count real cached builds (a finished download leaves browser/ + .verified). This skips
    // stray/partial dirs (e.g. a lone .incoming) so the list only shows launchable builds.
    if (!existsSync(join(dir, "browser")) || !existsSync(join(dir, ".verified"))) continue;
    const tier: "free" | "pro" = tag.startsWith("pro-") ? "pro" : "free";
    const version = tier === "pro" ? tag.slice(4) : tag;
    out.push({ tag, version, tier, sizeBytes: dirSize(dir), path: dir });
  }
  // Newest tag first (pro-150… above v0.1.0-pre.21 by string sort is unreliable, so pro before free,
  // then reverse-lexical within each — good enough; the UI shows the version + size explicitly).
  return out.sort((a, b) => (a.tier === b.tier ? b.tag.localeCompare(a.tag) : a.tier === "pro" ? -1 : 1));
}

/** Remove one cached build (by tag) so the next launch re-downloads it. Path-traversal guarded. */
export function removeCached(tag: string): boolean {
  if (!tag || tag.includes("/") || tag.includes("\\") || tag.includes("..")) {
    throw new Error("Invalid cache tag.");
  }
  const dir = join(cacheRoot(), tag);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
