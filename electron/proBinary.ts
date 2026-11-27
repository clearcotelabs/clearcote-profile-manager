// Download + verify the PRO (license-gated) browser for the profile manager.
//
// The PRO build is not on a public releases page: we ask the site for it via the
// authenticated GET /api/v1/download/pro route (Bearer license key), which returns
// a short-lived signed blob URL, the archive's SHA-256 and a signed release manifest.
// The manifest is the trust anchor (proManifest.ts): it is checked against the release
// key pinned in this app before anything is downloaded, and it names the hashes the
// archive and the binaries inside it must have. We stream the archive, verify its hash,
// extract it, check the binaries, and cache per PRO tag. An installed build's binaries
// are hashed against the manifest again on every launch, so a build that was changed on
// disk is never started. Dependency-free: extraction shells out to
// the system `tar` (bsdtar on Win10+/Linux auto-detects both .zip and .tar.xz), and on macOS to
// `ditto`, which keeps the app bundle's symlinks (see macos.ts).

import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { apiBase, licenseUserAgent, resolveLicenseKey } from "./license";
import { warmFiles } from "./winlaunch";
import { appBinary, buildPlatformFor, defaultBinaryName, extractMacBundle } from "./macos";
import { ProManifestError, proBinaryHashes, proPins, verifyProManifest } from "./proManifest";
import type { ResolvedBuild } from "./catalog";

export function cacheRoot(): string {
  const env = process.env.CLEARCOTE_CACHE;
  if (env) return env;
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "clearcote", "Cache");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "clearcote");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "clearcote");
}

/** The browser's path inside an extracted build: a macOS bundle's own executable first (never the
 *  framework or a helper app of the same tree), else the first file of that name. */
export function findFile(dir: string, name: string): string | null {
  return appBinary(dir, name) ?? findByName(dir, name);
}

function findByName(dir: string, name: string): string | null {
  const want = name.toLowerCase();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // A macOS framework holds the helper apps, never the browser itself.
      if (entry.name.endsWith(".framework")) continue;
      const hit = findByName(full, name);
      if (hit) return hit;
    } else if (entry.name.toLowerCase() === want) {
      return full;
    }
  }
  return null;
}

function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    const s = require("node:fs").createReadStream(path);
    s.on("data", (d: Buffer) => h.update(d));
    s.on("end", () => res(h.digest("hex")));
    s.on("error", rej);
  });
}

/** Extract an archive with bsdtar (handles both .zip and .tar.xz).
 *  On Windows, invoke the System32 bsdtar EXPLICITLY — a bare `tar` on PATH can resolve to an
 *  MSYS/Git GNU tar that mangles `C:\` paths and can't read .zip (fails with exit 128). Windows
 *  10 1803+ / 11 ship `%SystemRoot%\System32\tar.exe` (libarchive/bsdtar). On Linux the PATH tar
 *  is fine. */
function tarBinary(): string {
  if (process.platform !== "win32") return "tar";
  const sys = join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "tar.exe");
  return existsSync(sys) ? sys : "tar";
}
function extractArchive(archive: string, dest: string): Promise<void> {
  // The macOS build is a zipped app bundle: ditto keeps its symlinks and clears the quarantine.
  if (process.platform === "darwin" && /\.zip$/i.test(archive)) return extractMacBundle(archive, archive, dest);
  mkdirSync(dest, { recursive: true });
  return new Promise((resolve, reject) => {
    const p = spawn(tarBinary(), ["-xf", archive, "-C", dest], { stdio: "ignore", windowsHide: true });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code} extracting ${archive}`))));
  });
}

export interface ProProgress {
  (pct: number, seenMB: number, totalMB: number): void;
}

interface ProMeta {
  version?: string;
  revision?: string;
  tag?: string;
  asset?: string;
  binary?: string;
  url?: string;
  sha256?: string;
  exe_sha256?: string;
  chrome_dll_sha256?: string;
  size?: number;
  /** The signed release manifest (proManifest.ts). Untrusted, like every field here, until it has verified. */
  manifest?: unknown;
}

/** What a build is downloaded, verified and cached from. */
interface BuildMeta {
  tag: string;
  asset: string;
  binary: string;
  url: string;
  sha256: string;
  size?: number;
  /** Files inside the build and the SHA-256 each must have: a PRO build's signed manifest names them.
   *  Checked after extraction and again every time the installed build is about to be used. */
  inner?: Record<string, string>;
}

/** A folder or file name the cache may be asked to create: one path segment, nothing that climbs out. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;

/**
 * The first file of `inner` that is missing or does not hash to its value, in words; null when all of them
 * match. `exe` is the launcher that would be started, `binaryName` its name in `inner`; every other file is
 * looked for beside the launcher, where the launcher loads it from (a copy elsewhere in the build proves
 * nothing). The hashes are computed afresh on every call, never remembered: a file edited in place keeps
 * its size, and can keep its date.
 */
async function innerMismatch(exe: string, binaryName: string, inner: Record<string, string>): Promise<string | null> {
  for (const [name, want] of Object.entries(inner)) {
    const file = name === binaryName ? exe : join(dirname(exe), name);
    if (!existsSync(file)) return `${name} is missing`;
    if ((await sha256File(file)).toLowerCase() !== want.toLowerCase()) return `${name} is not the file the release manifest names`;
  }
  return null;
}

/** Transfers in flight, by build tag. A second request for the same build — a launch while
 *  Settings → "Download now" is still fetching it, or two profiles on the same build launched
 *  together — joins the first instead of writing the same `.part` file at the same time. */
const inFlight = new Map<string, { promise: Promise<string>; listeners: Set<ProProgress> }>();

/** Download + verify + extract a build from its resolved metadata; return the chrome(.exe) path.
 *  Cached per tag (works for both FREE and PRO — only the URL source differs). SHA-256 is the
 *  trust anchor. Throws on any mismatch or failure. */
function ensureFromMeta(meta: BuildMeta, onProgress?: ProProgress): Promise<string> {
  const running = inFlight.get(meta.tag);
  if (running) {
    if (onProgress) running.listeners.add(onProgress);
    return running.promise;
  }
  const listeners = new Set<ProProgress>(onProgress ? [onProgress] : []);
  const fanOut: ProProgress = (pct, seenMB, totalMB) => listeners.forEach((l) => l(pct, seenMB, totalMB));
  const promise = ensureFromMetaOnce(meta, fanOut).finally(() => inFlight.delete(meta.tag));
  inFlight.set(meta.tag, { promise, listeners });
  return promise;
}

async function ensureFromMetaOnce(meta: BuildMeta, onProgress?: ProProgress): Promise<string> {
  const tag = meta.tag;
  const binaryName = meta.binary;
  // Both become a path under the cache folder, and both come from a server answer.
  if (!SAFE_NAME.test(tag) || !SAFE_NAME.test(meta.asset)) {
    throw new Error("The download answer names a build or an archive with an unusable name. Refusing to use it.");
  }
  const destBase = join(cacheRoot(), tag);
  const browserDir = join(destBase, "browser");
  const verified = join(destBase, ".verified");
  /** Why the installed copy is being replaced, when it is. */
  let replacing: string | null = null;
  if (existsSync(verified)) {
    const cached = findFile(browserDir, binaryName);
    if (cached) {
      replacing = meta.inner ? await innerMismatch(cached, binaryName, meta.inner) : null;
      if (!replacing) return cached;
      // Never launched: the copy on disk is not what the release key signed. A fresh download replaces it,
      // and is checked the same way before it is used.
      console.warn(`[clearcote] the installed build ${tag} does not match its signed release manifest (${replacing}); downloading it again.`);
      try {
        rmSync(verified, { force: true });
      } catch {
        /* the files are checked again on the next launch either way */
      }
    }
  }
  mkdirSync(destBase, { recursive: true });

  // Stream the download to a temp `.part`, then verify + rename into place. We write via a single
  // `pipeline` (NEVER a manual `.on("data")` alongside `.pipe()` — that mixing defeats backpressure
  // and can interleave writes on large files, yielding a full-size-but-corrupt archive), and we hash
  // the BYTES ON DISK afterwards (not the in-flight stream) so any write-side corruption or a
  // concurrent clobber is caught by the SHA-256 gate before extraction ever runs.
  const archivePath = join(destBase, meta.asset);
  const partPath = archivePath + ".part";
  const dl = await fetch(meta.url);
  if (!dl.ok || !dl.body) throw new Error(`PRO archive download failed (HTTP ${dl.status}).`);
  const total = Number(dl.headers.get("content-length") || meta.size || 0);
  let seen = 0;
  let lastPct = -1;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (onProgress && total) {
        const pct = Math.floor((seen * 100) / total);
        if (pct !== lastPct && pct % 5 === 0) {
          lastPct = pct;
          onProgress(pct, Math.floor(seen / 1e6), Math.floor(total / 1e6));
        }
      }
      cb(null, chunk);
    },
  });
  try {
    rmSync(partPath, { force: true });
  } catch {
    /* ignore */
  }
  const nodeStream = Readable.fromWeb(dl.body as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(nodeStream, counter, createWriteStream(partPath));

  // Guard against a truncated/over-long transfer, then verify the on-disk hash.
  if (total && statSync(partPath).size !== total) {
    const actual = statSync(partPath).size;
    try {
      rmSync(partPath, { force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`PRO archive size mismatch — expected ${total} bytes, got ${actual}. Please retry.`);
  }
  const got = await sha256File(partPath);
  if (got.toLowerCase() !== meta.sha256.toLowerCase()) {
    try {
      rmSync(partPath, { force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`PRO archive SHA-256 mismatch — refusing to use it.\n  expected ${meta.sha256}\n  got      ${got}`);
  }
  require("node:fs").renameSync(partPath, archivePath);

  // extract into a temp dir, then swap into place so `browser/` only appears fully-written
  const incoming = join(destBase, ".incoming");
  try {
    rmSync(incoming, { recursive: true, force: true });
    rmSync(browserDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  await extractArchive(archivePath, incoming);
  if (replacing && existsSync(browserDir)) {
    // The old copy could not be removed (a browser is running on it). It is not what was signed, so it is not used.
    try {
      rmSync(incoming, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw new ProManifestError(
      "binary",
      `in the installed build ${tag}, ${replacing}, and it could not be replaced while a browser is running on it. Close the browsers on this build and launch again`,
    );
  }
  require("node:fs").renameSync(incoming, browserDir);

  const exe = findFile(browserDir, binaryName);
  if (!exe) throw new Error(`PRO archive verified but ${binaryName} was not found inside it.`);

  // The binaries inside must be the ones the manifest names, not just the archive around them.
  const wrong = meta.inner ? await innerMismatch(exe, binaryName, meta.inner) : null;
  if (wrong) {
    try {
      rmSync(browserDir, { recursive: true, force: true });
      rmSync(archivePath, { force: true });
    } catch {
      /* without .verified the folder is never used */
    }
    throw new ProManifestError("binary", `in the downloaded build ${tag}, ${wrong}`);
  }

  if (process.platform !== "win32") {
    try {
      require("node:fs").chmodSync(exe, 0o755);
      const sandbox = join(exe.substring(0, exe.lastIndexOf("/") + 1), "chrome-sandbox");
      if (existsSync(sandbox)) require("node:fs").chmodSync(sandbox, 0o4755);
    } catch {
      /* best-effort */
    }
  }

  if (process.platform === "win32") {
    // Pre-scan the freshly-extracted tree so real-time AV finishes with the unsigned binaries
    // before the first launch — closes the chrome_elf.dll SxS race that surfaces as "spawn UNKNOWN".
    warmFiles(browserDir);
  }

  writeFileSync(verified, meta.sha256 + "\n");
  try {
    if (statSync(archivePath).isFile()) rmSync(archivePath, { force: true });
  } catch {
    /* keep the extracted tree; reclaiming the archive is best-effort */
  }
  return exe;
}

/**
 * Ensure the PRO (license-gated) browser is present + verified; return the chrome(.exe) path.
 * `version` ("150" / "150.0.7871.114") pins a specific PRO build via /download/pro?version=;
 * omit it for the latest PRO pin. Cached per tag. Throws on any failure — a licensed launch must
 * get the PRO build, never a silent free fall-back.
 *
 * The answer is used only when its release manifest verifies under a release key pinned in this app
 * (proManifest.ts): for this platform, for the version or revision that was pinned, and with exactly the
 * hashes in the answer. That holds for a build that is already installed too: its binaries are hashed
 * against the manifest before its path is returned.
 */
export async function proEnsureBinary(
  licenseKey?: string,
  licenseApiBase?: string,
  version?: string,
  onProgress?: ProProgress,
): Promise<string> {
  const key = resolveLicenseKey(licenseKey);
  if (!key) throw new Error("No license key — cannot fetch the PRO build.");
  const plat = buildPlatformFor(); // throws on an Intel Mac: the macOS build is Apple Silicon only
  const base = apiBase(licenseApiBase);

  const q = version ? `&version=${encodeURIComponent(version)}` : "";
  // Named with the app version (clearcote-profile-manager/<v>): since 156-r51 a build can need a
  // minimum client (the persona token), and the route holds back a client that names no version.
  const res = await fetch(`${base}/api/v1/download/pro?platform=${plat}${q}`, {
    headers: { authorization: `Bearer ${key}`, "user-agent": licenseUserAgent() },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // A free licence always runs the latest build. The route only refuses an explicit pin, so this
    // means the profile itself names a version: say which setting to change, not just the HTTP code.
    if (res.status === 403 && /"FREE_LATEST_ONLY"/.test(body)) {
      throw new Error(
        `This profile is pinned to Clearcote ${version}, but the free plan always runs the latest build. ` +
          `Edit the profile and set Browser version to "Latest" (pinning a version is a Pro feature).`,
      );
    }
    throw new Error(`PRO download not authorized (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const meta = (await res.json()) as ProMeta;
  if (!meta.url || !meta.sha256 || !meta.asset) {
    throw new Error(`No PRO build is currently published for ${plat}.`);
  }
  // Before anything is downloaded or launched. Throws ProManifestError with the check that failed.
  const pin = proPins(version);
  const signed = verifyProManifest(meta, plat, pin.revision, pin.version);
  const binary = meta.binary || defaultBinaryName(plat);
  return ensureFromMeta(
    {
      tag: meta.tag || `pro-${meta.version || "unknown"}`,
      asset: meta.asset,
      binary,
      url: meta.url,
      sha256: meta.sha256,
      size: meta.size,
      inner: proBinaryHashes(signed, binary),
    },
    onProgress,
  );
}

/**
 * Ensure a FREE browser build (resolved from the public catalog) is present + verified; return
 * the chrome(.exe) path. FREE builds carry a public GitHub url + sha256 — no license needed.
 */
export async function freeEnsureBinary(resolved: ResolvedBuild, onProgress?: ProProgress): Promise<string> {
  const pf = resolved.platform;
  if (!pf.url || !pf.sha256 || !pf.asset) {
    throw new Error(`No downloadable free build for ${resolved.version} on this OS.`);
  }
  return ensureFromMeta(
    { tag: resolved.tag, asset: pf.asset, binary: pf.binary, url: pf.url, sha256: pf.sha256, size: pf.size },
    onProgress,
  );
}
