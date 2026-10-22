// Where the connect screen sends people to download the helper: the newest helper-v* release on
// GitHub, and in it the file for their system. Helper releases are never "latest" (that one is the
// desktop app's) and GitHub's release search finds nothing useful, so the links are built from the
// release this page was built with; GitHub's API, when the browser may use it, only adds a newer one.

export const REPO = "clearcotelabs/clearcote-profile-manager";
/** The newest helper release when this page was built (next.config.mjs); "" when none existed. */
export const BUILT_HELPER_VERSION = process.env.NEXT_PUBLIC_HELPER_VERSION || "";
/** Where to send people when there is nothing better: that release's page, else every release. */
export const RELEASES_FALLBACK = BUILT_HELPER_VERSION
  ? `https://github.com/${REPO}/releases/tag/helper-v${BUILT_HELPER_VERSION}`
  : `https://github.com/${REPO}/releases`;

export type HelperOs = "Windows" | "macOS" | "Linux";
export type HelperArch = "x64" | "arm64";

export interface GhAsset {
  name: string;
  browser_download_url: string;
  size: number;
}
export interface GhRelease {
  tag_name: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GhAsset[];
}

export interface HelperDownload {
  label: string;
  os: HelperOs;
  arch: HelperArch;
  url: string;
  sizeMB: number;
}
export interface HelperRelease {
  version: string;
  page: string;
  downloads: HelperDownload[];
}

const TARGET: Record<string, { os: HelperOs; arch: HelperArch; label: string }> = {
  "win-x64": { os: "Windows", arch: "x64", label: "Windows" },
  "win-arm64": { os: "Windows", arch: "arm64", label: "Windows on Arm" },
  "mac-arm64": { os: "macOS", arch: "arm64", label: "macOS, Apple Silicon" },
  "mac-x64": { os: "macOS", arch: "x64", label: "macOS, Intel" },
  "linux-x64": { os: "Linux", arch: "x64", label: "Linux x64" },
  "linux-arm64": { os: "Linux", arch: "arm64", label: "Linux arm64" },
};

/** The release this page was built with, its download links worked out from the file names
 *  helper/build.mjs gives them: no network needed. Sizes are unknown (0). */
export function builtHelperRelease(version = BUILT_HELPER_VERSION): HelperRelease | null {
  if (!version) return null;
  const tag = `helper-v${version}`;
  const downloads = Object.entries(TARGET).map(([target, t]) => ({
    ...t,
    url: `https://github.com/${REPO}/releases/download/${tag}/clearcote-helper-${version}-${target}.${t.os === "Windows" ? "zip" : "tar.gz"}`,
    sizeMB: 0,
  }));
  return { version, page: `https://github.com/${REPO}/releases/tag/${tag}`, downloads };
}

const newer = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

/** The release to offer: GitHub's newest when it answers (and is not older), else the built-in one. */
export function bestHelperRelease(fromApi: HelperRelease | null, built = builtHelperRelease()): HelperRelease | null {
  if (fromApi && (!built || !newer(built.version, fromApi.version))) return fromApi;
  return built;
}

/** The newest published helper release in a GitHub releases list (newest first, as the API gives it). */
export function pickHelperRelease(list: GhRelease[]): HelperRelease | null {
  const rel = (Array.isArray(list) ? list : []).find((r) => r?.tag_name?.startsWith("helper-v") && !r.draft && !r.prerelease);
  if (!rel) return null;
  const downloads: HelperDownload[] = [];
  for (const a of rel.assets ?? []) {
    const m = a.name.match(/^clearcote-helper-.+-((?:win|mac|linux)-(?:x64|arm64))\.(?:zip|tar\.gz)$/);
    const t = m && TARGET[m[1]];
    if (t) downloads.push({ ...t, url: a.browser_download_url, sizeMB: Math.round(a.size / 1e6) });
  }
  const order = Object.values(TARGET).map((t) => t.label);
  downloads.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  return { version: rel.tag_name.replace(/^helper-v/, ""), page: rel.html_url, downloads };
}

/** The download for this computer: same OS, and the CPU when it is known (else x64, or Apple Silicon on a Mac). */
export function downloadFor(rel: HelperRelease, os: HelperOs, arch?: HelperArch): HelperDownload | null {
  const same = rel.downloads.filter((d) => d.os === os);
  const want = arch ?? (os === "macOS" ? "arm64" : "x64");
  return same.find((d) => d.arch === want) ?? same[0] ?? null;
}

/** Ask GitHub for the newest helper release. Null when GitHub cannot be reached (or rate-limits). */
export async function fetchHelperRelease(): Promise<HelperRelease | null> {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return null;
    return pickHelperRelease(await r.json());
  } catch {
    return null;
  }
}

/** The CPU, where the browser says (Chromium's client hints). Undefined elsewhere. */
export async function detectArch(): Promise<HelperArch | undefined> {
  try {
    const uad = (navigator as Navigator & { userAgentData?: { getHighEntropyValues(h: string[]): Promise<{ architecture?: string; bitness?: string }> } })
      .userAgentData;
    const v = await uad?.getHighEntropyValues(["architecture", "bitness"]);
    if (v?.architecture === "arm") return "arm64";
    if (v?.architecture === "x86") return "x64";
  } catch {
    /* not offered */
  }
  return undefined;
}
