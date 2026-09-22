// Downloaded-browser cache management — list the browser builds already downloaded + verified
// under the cache root (one dir per tag, e.g. `pro-150.0.7871.114`, `v0.1.0-pre.21`), and remove
// one so the next launch re-downloads it. Explicit-binary / dev-build paths aren't in the cache
// and aren't listed here.

import { existsSync, readdirSync, statSync, renameSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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

/**
 * Delete a directory only if nothing has a file open in it.
 *
 * A plain recursive delete of a folder a browser is running from half-deletes it on Windows: the
 * open files survive, everything else goes — the running browser breaks, and a cached build is
 * left with its `.verified` marker but without its files. Windows refuses to RENAME a folder with
 * open files in it, so renaming first turns that into a clean "in use". (Elsewhere the rename
 * succeeds, and deleting files a process has open is harmless to it.)
 */
export async function removeDirIfUnused(dir: string): Promise<"removed" | "in-use" | "missing"> {
  if (!existsSync(dir)) return "missing";
  const doomed = `${dir}.deleting-${Date.now()}`;
  try {
    renameSync(dir, doomed);
  } catch {
    return "in-use";
  }
  await rm(doomed, { recursive: true, force: true });
  return "removed";
}

/** Remove one cached build (by tag) so the next launch re-downloads it. Path-traversal guarded;
 *  refuses (returns false) while a browser is running from it. */
export async function removeCached(tag: string): Promise<boolean> {
  if (!tag || tag.includes("/") || tag.includes("\\") || tag.includes("..")) {
    throw new Error("Invalid cache tag.");
  }
  return (await removeDirIfUnused(join(cacheRoot(), tag))) === "removed";
}

/** Leftovers of an interrupted removal (a crash between rename and delete). */
export async function purgeDeleting(root = cacheRoot()): Promise<void> {
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const n of names) if (/\.deleting-\d+$/.test(n)) await rm(join(root, n), { recursive: true, force: true }).catch(() => {});
}

/** A copy of a browser outside the cache: a launch copy the app keeps to dodge the Windows
 *  first-launch race (electron/winlaunch.ts), or a one-off recovery copy — the Python SDK leaves
 *  one per launch and never removes it. Both are re-created when needed, so both can go. */
export interface TempCopy {
  path: string;
  kind: "launch-copy" | "leftover";
  sizeBytes: number;
}

export async function listTempCopies(tmp = tmpdir()): Promise<TempCopy[]> {
  const out: TempCopy[] = [];
  const live = join(tmp, "clearcote-live");
  let ids: string[] = [];
  try {
    ids = readdirSync(live);
  } catch {
    /* none */
  }
  for (const id of ids) {
    const p = join(live, id);
    if (statSafe(p)?.isDirectory()) out.push({ path: p, kind: "launch-copy", sizeBytes: await dirSizeAsync(p) });
  }
  let names: string[] = [];
  try {
    names = readdirSync(tmp);
  } catch {
    /* none */
  }
  for (const n of names) {
    if (!/^clearcote-recover-/.test(n)) continue;
    const p = join(tmp, n);
    if (statSafe(p)?.isDirectory()) out.push({ path: p, kind: "leftover", sizeBytes: await dirSizeAsync(p) });
  }
  return out;
}

/** Remove every temp copy nothing is running from. Takes no paths from the caller on purpose: it
 *  only ever deletes what listTempCopies() itself found. */
export async function cleanTempCopies(tmp = tmpdir()): Promise<{ removed: number; inUse: number; freedBytes: number }> {
  let removed = 0;
  let inUse = 0;
  let freedBytes = 0;
  for (const c of await listTempCopies(tmp)) {
    const r = await removeDirIfUnused(c.path);
    if (r === "removed") {
      removed++;
      freedBytes += c.sizeBytes;
    } else if (r === "in-use") inUse++;
  }
  return { removed, inUse, freedBytes };
}

function statSafe(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

async function dirSizeAsync(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (e) => {
        const p = join(d, e.name);
        if (e.isDirectory()) return walk(p);
        try {
          const { size } = await stat(p); // await first — see profiles.ts dirSizeAsync
          total += size;
        } catch {
          /* vanished */
        }
      }),
    );
  };
  await walk(dir);
  return total;
}
