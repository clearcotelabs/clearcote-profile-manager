// Which engine build a profile launches, as far as the editor can tell without launching it.
//
// Some coherence rules hold only before an engine fix (a typed screen that the CSS media queries
// ignored, fixed in 154 r36), and a bare major cannot say which side of it a build is on. The
// editor has three best-effort sources: the profile's own version selection, the PRO revisions the
// licence can download (electron/catalog.ts fetchProRevisions; the download route lists the current
// build first), and what "Latest" resolves to for this licence (electron/launchTarget.ts). What it
// cannot pin down stays undefined, so a rule can tell "an older build" from "don't know".
//
// Mirrors electron/catalog.ts resolveVersion and the route's selector order. PURE: the editor and
// the tests call it directly.

export interface EngineBuild {
  /** PRO rebuild number ("154.0.8037.57-r36" -> 36), when known. */
  revision?: number;
  /** "free" is the open build, which never carries the PRO-only fixes. */
  tier?: "free" | "pro";
}

export interface EngineBuildSources {
  /** listRevisions(): published PRO selectors, the current build first. "(preview)" marks a
   *  preview-channel build, which a stable selection never resolves to. [] without a licence key,
   *  on the free plan (the route refuses to list) or offline. */
  revisions?: readonly string[];
  /** listVersions(): the public catalog for this OS. */
  versions?: readonly { major: number; version: string; tier: "free" | "pro" }[];
  /** launchTarget(): "custom" means an explicit binary runs whatever the profile asks for. */
  target?: { mode: string; licensed?: boolean } | null;
}

interface ListedRevision {
  version: string;
  major: number;
  revision: number;
}

/** "154.0.8037.57-r36" -> its parts; null for a preview build or anything else. */
export function parseRevisionSelector(sel: string): ListedRevision | null {
  const m = /^((\d+)(?:\.\d+)*)-r(\d+)$/.exec(sel.trim().toLowerCase());
  return m ? { version: m[1], major: Number(m[2]), revision: Number(m[3]) } : null;
}

export function engineBuild(browserVersion: string | undefined, src: EngineBuildSources = {}): EngineBuild {
  // An explicit binary wins for every profile (electron/launcher.ts), so its build is unknowable.
  if (src.target?.mode === "custom") return {};

  const raw = (browserVersion ?? "").trim().toLowerCase();
  const listed = (src.revisions ?? []).map(parseRevisionSelector).filter((r): r is ListedRevision => r !== null);

  // A revision pin names its build: "154.0.8037.57-r36", or a bare "r36".
  const pin = /^(?:.*-)?r(\d+)$/.exec(raw);
  if (pin) return { revision: Number(pin[1]), tier: "pro" };

  if (raw === "" || raw === "latest" || raw === "auto") {
    // Only a licence lists revisions, and a licensed "Latest" is the route's current build.
    if (listed.length) return { revision: listed[0].revision, tier: "pro" };
    // No key at all: "Latest" is the newest open build.
    if (src.target?.mode === "managed" && src.target.licensed === false) return { tier: "free" };
    return {};
  }

  // A major or an exact version follows the newest revision of it, which the route lists first.
  const isMajor = /^\d+$/.test(raw);
  const rev = listed.find((r) => (isMajor ? String(r.major) === raw : r.version === raw));
  if (rev) return { revision: rev.revision, tier: "pro" };
  const cat = src.versions?.find((v) => (isMajor ? String(v.major) === raw : v.version.toLowerCase() === raw));
  return cat ? { tier: cat.tier } : {};
}
