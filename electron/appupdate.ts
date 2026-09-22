// App update: tell the user a new release exists, and fetch it with the checksum checked.
//
// DELIBERATELY NOT electron-updater. That installs in the background on quit, and on Windows it
// verifies the downloaded update's Authenticode signature — which this build does not have, so it
// would have to run with `verifyUpdateCodeSignature: false`. That turns the update channel into an
// unattended install path with no publisher verification, for an audience that chose this tool
// partly for its verifiability. The README tells people the provenance attestation and checksums
// are the trust anchor; silently installing unsigned binaries would contradict that.
//
// So: check, tell, download-and-verify, and let the PERSON run the installer.
//
// WHAT THE CHECKSUM ACTUALLY BUYS. SHA256SUMS.txt ships from the same release as the binary, so it
// catches a corrupted or tampered DOWNLOAD — not a compromised release, where both would move
// together. Only signing or the provenance attestation covers that. Verifying here is a real
// improvement over an unchecked download and is not a substitute for signing; the UI says so.

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const REPO = "clearcotelabs/clearcote-profile-manager";
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
/**
 * Whether the app asks GitHub for a newer release when it starts. On unless the person turned it
 * off in Settings — the only remembered way to stop the suggestion. It runs on EVERY start: a
 * once-a-day throttle meant someone who restarted after a fix shipped could go a day without
 * hearing of it, and one request per start is far inside GitHub's unauthenticated limit
 * (60 an hour per address).
 */
export function startupCheckEnabled(s: { updateCheck?: boolean }): boolean {
  return s.updateCheck !== false;
}

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
}

export interface UpdateInfo {
  available: boolean;
  /** The newest published version, whether or not it is newer than ours. */
  latest: string;
  current: string;
  /** Release page, for "what's new" and for anyone who would rather download by hand. */
  releaseUrl: string;
  notes?: string;
  /** The asset matching how this copy was installed, when one could be identified. */
  asset?: UpdateAsset;
  /** The checksums file, when the release publishes one. */
  sumsUrl?: string;
}

/**
 * Compare two dotted versions numerically. Returns >0 when `a` is newer.
 *
 * A string compare is wrong here in a way that bites exactly once and confusingly: "0.9.0" sorts
 * ABOVE "0.10.0", so the app would go quiet at precisely the release that renamed the minor. A
 * pre-release suffix ("0.10.0-rc.1") sorts BELOW the release it precedes, which is what semver
 * means and what a user expects.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = String(v).replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre: pre ?? "" };
  };
  const A = split(a);
  const B = split(b);
  for (let i = 0; i < Math.max(A.nums.length, B.nums.length); i++) {
    const d = (A.nums[i] ?? 0) - (B.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (A.pre === B.pre) return 0;
  if (!A.pre) return 1; // a release beats its own pre-releases
  if (!B.pre) return -1;
  return A.pre < B.pre ? -1 : 1;
}

/**
 * Which asset suits THIS copy of the app.
 *
 * A release carries every platform's downloads, so the first cut is the host OS — offering a
 * Windows installer to someone on Linux is not a near miss, it is an unusable file.
 *
 * Within an OS, the shape of the install decides. On Windows an NSIS install sits beside its
 * uninstaller and the portable zip does not; handing a zip user an installer would silently create
 * a second, separate installation. On Linux the same question is whether this copy is running as an
 * AppImage (the launcher exports APPIMAGE with the path to it) or from an unpacked tarball. When it
 * cannot be decided, no asset is offered and the UI points at the release page — better than
 * guessing wrong about where somebody's app lives.
 */
export function pickAsset(
  assets: UpdateAsset[],
  opts: {
    execPath: string;
    existsSync?: (p: string) => boolean;
    platform?: NodeJS.Platform;
    /** The AppImage this process was launched from, when it was — `process.env.APPIMAGE`. */
    appImage?: string;
  } = { execPath: process.execPath },
): UpdateAsset | undefined {
  const platform = opts.platform ?? process.platform;
  const find = (re: RegExp) => assets.find((a) => re.test(a.name));

  if (platform === "linux") {
    const appImage = find(/\.AppImage$/i);
    const tarball = find(/\.tar\.gz$/i);
    const runningAsAppImage = !!(opts.appImage ?? process.env.APPIMAGE);
    return runningAsAppImage ? appImage ?? tarball : tarball ?? appImage;
  }

  const exists = opts.existsSync ?? existsSync;
  const dir = path.dirname(opts.execPath);
  let installed = false;
  try {
    installed = exists(path.join(dir, "Uninstall Clearcote Profile Manager.exe")) || exists(path.join(dir, "Uninstall.exe"));
  } catch {
    installed = false;
  }
  const setup = find(/setup\.exe$/i);
  const zip = find(/\.zip$/i);
  return installed ? setup : zip ?? setup;
}

/** Parse a `sha256sum`-style file into { filename: hash }. */
export function parseSums(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (m) out[m[2]] = m[1].toLowerCase();
  }
  return out;
}

interface GhAsset { name: string; browser_download_url: string; size: number }
interface GhRelease { tag_name: string; html_url: string; body?: string; draft?: boolean; prerelease?: boolean; assets?: GhAsset[] }

/**
 * Ask GitHub for the newest release. Never throws — an update check is a convenience, and a
 * network blip must not surface as an error in an app that is otherwise working.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(API, {
      headers: { accept: "application/vnd.github+json", "user-agent": "clearcote-profile-manager" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const rel = (await res.json()) as GhRelease;
    if (!rel?.tag_name || rel.draft) return null;

    const latest = rel.tag_name.replace(/^v/, "");
    const assets: UpdateAsset[] = (rel.assets ?? []).map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
    }));
    return {
      available: compareVersions(latest, currentVersion) > 0,
      latest,
      current: currentVersion,
      releaseUrl: rel.html_url,
      notes: rel.body,
      asset: pickAsset(assets),
      sumsUrl: assets.find((a) => /^SHA256SUMS/i.test(a.name))?.url,
    };
  } catch {
    return null;
  }
}

export interface UpdateProgress {
  (pct: number, seenMB: number, totalMB: number): void;
}

/** Where a downloaded update lands. Its own directory, so a stale one can be cleared wholesale. */
export function updateDir(): string {
  return path.join(tmpdir(), "clearcote-update");
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = require("node:fs").createReadStream(file) as NodeJS.ReadableStream;
    s.on("data", (d: Buffer) => h.update(d));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}

export interface DownloadResult {
  ok: boolean;
  path?: string;
  error?: string;
  /** False when the release published no checksums file, so nothing could be checked. Surfaced
   *  rather than hidden: "downloaded" and "downloaded and verified" are different claims. */
  verified?: boolean;
}

/** Downloads in flight in this process, by asset URL — a second request joins the first. */
const inFlight = new Map<string, Promise<DownloadResult>>();

/** Leftover per-download dirs older than this are pruned; younger ones may belong to a download
 *  still running in another copy of the app, so they are left alone. */
const STALE_DOWNLOAD_MS = 24 * 60 * 60 * 1000;

function pruneStaleDownloads(root: string): void {
  try {
    for (const name of readdirSync(root)) {
      const p = path.join(root, name);
      try {
        if (Date.now() - statSync(p).mtimeMs > STALE_DOWNLOAD_MS) rmSync(p, { recursive: true, force: true });
      } catch {
        /* in use or already gone */
      }
    }
  } catch {
    /* no root yet */
  }
}

/**
 * Download an update asset and check it against the release's SHA256SUMS.
 *
 * A mismatch deletes the file and fails — a half-trusted installer must never be left sitting on
 * disk where somebody might run it anyway.
 *
 * Every download writes into its OWN directory. It used to wipe one shared %TEMP%\clearcote-update
 * and write a fixed filename, so two overlapping downloads (a second app window — there was no
 * single-instance lock — or a repeated click) truncated and deleted each other's file: the first
 * then failed the checksum and was deleted, the second found an empty file. Reproduced 1:1.
 */
export function downloadUpdate(info: UpdateInfo, onProgress?: UpdateProgress): Promise<DownloadResult> {
  if (!info.asset) return Promise.resolve({ ok: false, error: "No downloadable asset for this installation." });
  const key = info.asset.url;
  const running = inFlight.get(key);
  if (running) return running;
  const p = downloadUpdateOnce(info, onProgress).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function downloadUpdateOnce(info: UpdateInfo, onProgress?: UpdateProgress): Promise<DownloadResult> {
  const asset = info.asset!;
  const root = updateDir();
  pruneStaleDownloads(root);
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(path.join(root, "dl-"));
  const dest = path.join(dir, asset.name);
  const part = dest + ".part";
  const info_ = { ...info, asset };
  const discard = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  const r = await fetchAndVerify(info_, part, onProgress);
  if (!r.ok) {
    discard();
    return r;
  }
  try {
    renameSync(part, dest);
  } catch (e) {
    discard();
    return { ok: false, error: `Could not finalise the download: ${String((e as Error)?.message || e)}` };
  }
  return { ...r, path: dest };
}

async function fetchAndVerify(
  info: UpdateInfo & { asset: UpdateAsset },
  dest: string,
  onProgress?: UpdateProgress,
): Promise<DownloadResult> {
  try {
    const res = await fetch(info.asset.url, {
      headers: { "user-agent": "clearcote-profile-manager" },
      redirect: "follow",
    });
    if (!res.ok || !res.body) return { ok: false, error: `Download failed (HTTP ${res.status}).` };

    const total = Number(res.headers.get("content-length")) || info.asset.size || 0;
    let seen = 0;
    const src = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    src.on("data", (c: Buffer) => {
      seen += c.length;
      if (onProgress && total) onProgress(Math.round((seen / total) * 100), seen / 1048576, total / 1048576);
    });
    await pipeline(src, createWriteStream(dest));

    if (!existsSync(dest) || statSync(dest).size === 0) {
      return { ok: false, error: "Download produced an empty file." };
    }
    // A short transfer is a network problem, not tampering — say so rather than "checksum mismatch".
    const got = statSync(dest).size;
    if (info.asset.size && got !== info.asset.size) {
      return { ok: false, error: `Download incomplete (${got} of ${info.asset.size} bytes) — please try again.` };
    }

    // Verify, when the release published sums. Absence is reported, not silently treated as a pass.
    if (!info.sumsUrl) return { ok: true, path: dest, verified: false };

    const sumsRes = await fetch(info.sumsUrl, { headers: { "user-agent": "clearcote-profile-manager" }, redirect: "follow" });
    if (!sumsRes.ok) return { ok: true, path: dest, verified: false };
    const expected = parseSums(await sumsRes.text())[info.asset.name];
    if (!expected) return { ok: true, path: dest, verified: false };

    const actual = await sha256File(dest);
    if (actual !== expected) {
      // The caller deletes the whole per-download directory on any failure.
      return {
        ok: false,
        error: `Checksum mismatch — the download does not match the published SHA-256 and has been deleted. Expected ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}….`,
      };
    }
    return { ok: true, path: dest, verified: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}
