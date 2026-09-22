// Which downloaded browser builds can go. PURE — the rules live here, where they are tested; the
// main process only gathers the inputs (electron/storage.ts) and deletes what this returns.
//
// A build is KEPT when anything could still launch it:
//   - it is what a profile set to "Latest" resolves to now,
//   - a profile pins it (a major or a version keeps the newest revision of it; a revision pin keeps
//     exactly that revision),
//   - a running browser was started from it, or it holds the custom binary chosen in Settings.
// Everything else is re-downloadable and only costs disk. On this machine that was 12 of 13 builds.

export interface CachedLike {
  tag: string;
  version: string;
  tier: "free" | "pro";
  sizeBytes: number;
  path: string;
}

export interface KeepRule {
  /** A catalog tag: "pro-153.0.8010.36", or with a revision "pro-151.0.7922.108-r18", or a free
   *  release tag "v0.1.0-pre.22". */
  tag: string;
  /** Why, as the UI shows it: "Latest", "Pinned by Bank". */
  reason: string;
}

export interface PrunePlan {
  keep: { build: CachedLike; reasons: string[] }[];
  remove: CachedLike[];
  freeBytes: number;
}

const revisionOf = (tag: string): number => {
  const m = /-r(\d+)$/.exec(tag);
  return m ? Number(m[1]) : 0;
};
const hasRevision = (tag: string) => /-r\d+$/.test(tag);

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
/** Is `file` inside `dir` (case-insensitive — Windows paths)? */
export function isInside(file: string, dir: string): boolean {
  const f = norm(file);
  const d = norm(dir);
  return f === d || f.startsWith(d + "/");
}

export function planPrune(
  cached: CachedLike[],
  keep: KeepRule[],
  inUse: { path: string; reason: string }[] = [],
): PrunePlan {
  const reasons = new Map<string, string[]>();
  const add = (tag: string, why: string) => {
    const list = reasons.get(tag) ?? [];
    if (!list.includes(why)) list.push(why);
    reasons.set(tag, list);
  };

  for (const rule of keep) {
    if (hasRevision(rule.tag) || !rule.tag.startsWith("pro-")) {
      // An exact build: a revision pin, or a free release tag.
      if (cached.some((b) => b.tag === rule.tag)) add(rule.tag, rule.reason);
      continue;
    }
    // A version without a revision: the newest revision of it that is on disk launches.
    const best = cached
      .filter((b) => b.tag === rule.tag || b.tag.startsWith(rule.tag + "-r"))
      .sort((a, b) => revisionOf(b.tag) - revisionOf(a.tag))[0];
    if (best) add(best.tag, rule.reason);
  }
  for (const u of inUse) {
    for (const b of cached) if (isInside(u.path, b.path)) add(b.tag, u.reason);
  }

  const kept = cached.filter((b) => reasons.has(b.tag));
  const remove = cached.filter((b) => !reasons.has(b.tag));
  return {
    keep: kept.map((build) => ({ build, reasons: reasons.get(build.tag)! })),
    remove,
    freeBytes: remove.reduce((s, b) => s + b.sizeBytes, 0),
  };
}
