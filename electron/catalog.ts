// Browser-version catalog — fetch the public GET /api/v1/versions list and resolve a requested
// version to a concrete build + tier, mirroring the clearcote SDK's version selection so the
// profile manager launches exactly what the SDK would.
//
//   FREE builds carry a GitHub url + sha256 (downloaded directly, no license).
//   PRO builds advertise existence only — the binary comes from the authenticated
//   /api/v1/download/pro route (see proBinary.ts).
//
// Precedence for launch: an explicit Settings/CLEARCOTE_BINARY path wins (handled in launcher);
// otherwise the profile's `browserVersion` resolves here.

import { apiBase } from "./license";

export type Tier = "free" | "pro";

export interface CatalogPlatform {
  asset?: string;
  url?: string;
  sha256?: string;
  exeSha256?: string;
  size?: number;
  archive: "zip" | "tar.xz";
  binary: string;
}
export interface CatalogBuild {
  major: number;
  version: string;
  tier: Tier;
  tag: string;
  platforms: Partial<Record<"windows" | "linux", CatalogPlatform>>;
}
export interface Catalog {
  schema: number;
  builds: CatalogBuild[];
}

export interface ResolvedBuild {
  tier: Tier;
  version: string;
  major: number;
  tag: string;
  platform: CatalogPlatform;
  /** Pinned PRO rebuild ("r10"), when the request asked for one. */
  revision?: string;
  /** What to send as /api/v1/download/pro?version= — the revision-qualified selector when one was
   *  pinned, else the plain version. The public /versions catalog lists only ONE entry per major
   *  (no revisions), so the revision must be carried separately or it is silently dropped and the
   *  caller gets the current pin instead of the build they asked for. */
  selector: string;
}

/** A UI-facing summary of one catalog build for the current OS (drives the version dropdown). */
export interface VersionOption {
  version: string;
  major: number;
  tier: Tier;
  tag: string;
}

export function platformTag(): "windows" | "linux" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  throw new Error("Clearcote ships Windows x64 and Linux x64 only.");
}

export async function fetchCatalog(licenseApiBase?: string): Promise<Catalog> {
  const base = apiBase(licenseApiBase);
  const res = await fetch(`${base}/api/v1/versions`, {
    headers: { "user-agent": "clearcote-profile-manager" },
  });
  if (!res.ok) throw new Error(`Version catalog fetch failed (HTTP ${res.status}).`);
  const cat = (await res.json()) as Catalog;
  if (!cat || !Array.isArray(cat.builds)) throw new Error("Version catalog is malformed.");
  return cat;
}

/** Builds available for THIS OS, newest major first — for the UI dropdown. */
export function listVersions(cat: Catalog): VersionOption[] {
  const plat = platformTag();
  return cat.builds
    .filter((b) => b.platforms[plat])
    .sort((a, b) => b.major - a.major)
    .map((b) => ({ version: b.version, major: b.major, tier: b.tier, tag: b.tag }));
}

/**
 * Resolve `wanted` ("latest" | "150" | "150.0.7871.114" | "" | undefined) to a concrete build
 * for this OS + tier. `hasLicense` gates PRO builds. Throws a clear, user-facing error otherwise.
 */
export function resolveVersion(cat: Catalog, wanted: string | undefined, hasLicense: boolean): ResolvedBuild {
  const plat = platformTag();
  const withPlat = cat.builds.filter((b) => b.platforms[plat]);
  const byMajorDesc = [...withPlat].sort((a, b) => b.major - a.major);
  const freeLatest = byMajorDesc.find((b) => b.tier === "free");
  const proLatest = byMajorDesc.find((b) => b.tier === "pro");

  const pick = (b: CatalogBuild, revision?: string): ResolvedBuild => {
    if (b.tier === "pro" && !hasLicense) {
      const free = freeLatest ? ` (the free build is ${freeLatest.version})` : "";
      throw new Error(
        `Clearcote ${b.version} is a PRO build — set a license key in Settings to use it${free}.`,
      );
    }
    if (revision && b.tier !== "pro") {
      throw new Error(
        `Revision pins like "${revision}" exist only for PRO rebuilds — ${b.version} is a free build.`,
      );
    }
    return {
      tier: b.tier,
      version: b.version,
      major: b.major,
      tag: revision ? `${b.tag}-${revision}` : b.tag,
      platform: b.platforms[plat]!,
      revision,
      selector: revision ? `${b.version}-${revision}` : b.version,
    };
  };

  const raw = (wanted ?? "latest").trim().toLowerCase();

  // Split off a trailing revision pin: "150.0.7871.114-r10" -> base "150.0.7871.114" + "r10",
  // and a bare "r10" -> the newest PRO build at that revision. The public catalog carries only one
  // entry per major with no revision, so the base must be matched against it separately.
  const revMatch = /^(?:(.*)-)?(r\d+)$/.exec(raw);
  const revision = revMatch ? revMatch[2] : undefined;
  const w = revMatch ? (revMatch[1] ?? "") : raw;

  if (revision && (w === "" || w === "latest" || w === "auto")) {
    if (!proLatest) throw new Error(`No PRO build is available for this OS to pin "${revision}" against.`);
    return pick(proLatest, revision);
  }

  if (w === "" || w === "latest" || w === "auto") {
    // Latest reachable for the tier: a licensed user gets the newest overall (incl. PRO);
    // an unlicensed user gets the newest FREE build.
    const cand = hasLicense ? byMajorDesc[0] : freeLatest;
    if (!cand) throw new Error("No browser build is available for this OS.");
    return pick(cand);
  }

  const isMajor = /^\d+$/.test(w);
  const match = byMajorDesc.find((b) =>
    isMajor ? String(b.major) === w : b.version.toLowerCase() === w,
  );
  if (!match) {
    const avail = byMajorDesc.map((b) => `${b.major} (${b.tier})`).join(", ") || "none";
    throw new Error(`No build matches "${wanted}". Available: ${avail}.`);
  }
  return pick(match, revision);
}

/**
 * The PRO revisions currently published for this OS, newest first (e.g. ["150.0.7871.114-r10",
 * "150.0.7871.114-r9", "150.0.7871.114-r3"]).
 *
 * There is no dedicated list endpoint: the public /api/v1/versions catalog carries one entry per
 * major with no revision at all, and /download/pro returns a single build. The route DOES enumerate
 * its selectors in the 404 body when asked for one that doesn't exist, so that is the channel used
 * here — a deliberately invalid selector, reading `available` off the error. Best-effort by design:
 * any failure returns [] and the UI just offers "latest" plus the plain versions.
 */
export async function fetchProRevisions(licenseKey?: string, licenseApiBase?: string): Promise<string[]> {
  if (!licenseKey) return []; // revisions are PRO-only; without a key there is nothing to offer
  try {
    const base = apiBase(licenseApiBase);
    const res = await fetch(
      `${base}/api/v1/download/pro?platform=${platformTag()}&version=__list__`,
      { headers: { authorization: `Bearer ${licenseKey}`, "user-agent": "clearcote-profile-manager" } },
    );
    const body = (await res.json()) as { available?: unknown };
    return Array.isArray(body?.available) ? body.available.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
