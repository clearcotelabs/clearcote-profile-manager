// Download + verify the PRO (license-gated) browser for the profile manager.
//
// The PRO build is not on a public releases page: we ask the site for it via the
// authenticated GET /api/v1/download/pro route (Bearer license key), which returns
// a short-lived signed blob URL + the archive's SHA-256. We stream it, verify the
// hash (the trust anchor, exactly like the free pin), extract it, and cache per
// PRO tag so later launches are instant. Dependency-free: extraction shells out to
// the system `tar` (bsdtar on Win10+/Linux auto-detects both .zip and .tar.xz).

import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { apiBase, resolveLicenseKey } from "./license";
import { warmFiles } from "./winlaunch";
import type { ResolvedBuild } from "./catalog";

function cacheRoot(): string {
  const env = process.env.CLEARCOTE_CACHE;
  if (env) return env;
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "clearcote", "Cache");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "clearcote");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "clearcote");
}

function platformTag(): "windows" | "linux" {
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  throw new Error("Clearcote PRO ships Windows x64 and Linux x64 only.");
}

function findFile(dir: string, name: string): string | null {
  const want = name.toLowerCase();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
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
  mkdirSync(dest, { recursive: true });
  return new Promise((resolve, reject) => {
    const p = spawn(tarBinary(), ["-xf", archive, "-C", dest], { stdio: "ignore" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code} extracting ${archive}`))));
  });
}

export interface ProProgress {
  (pct: number, seenMB: number, totalMB: number): void;
}

interface ProMeta {
  version?: string;
  tag?: string;
  asset?: string;
  binary?: string;
  url?: string;
  sha256?: string;
  size?: number;
}

/** Download + verify + extract a build from its resolved metadata; return the chrome(.exe) path.
 *  Cached per tag (works for both FREE and PRO — only the URL source differs). SHA-256 is the
 *  trust anchor. Throws on any mismatch or failure. */
async function ensureFromMeta(
  meta: { tag: string; asset: string; binary: string; url: string; sha256: string; size?: number },
  onProgress?: ProProgress,
): Promise<string> {
  const tag = meta.tag;
  const binaryName = meta.binary;
  const destBase = join(cacheRoot(), tag);
  const browserDir = join(destBase, "browser");
  const verified = join(destBase, ".verified");
  if (existsSync(verified)) {
    const cached = findFile(browserDir, binaryName);
    if (cached) return cached;
  }
  mkdirSync(destBase, { recursive: true });

  // stream download -> file, hashing as we go
  const archivePath = join(destBase, meta.asset);
  const dl = await fetch(meta.url);
  if (!dl.ok || !dl.body) throw new Error(`PRO archive download failed (HTTP ${dl.status}).`);
  const total = Number(dl.headers.get("content-length") || meta.size || 0);
  const h = createHash("sha256");
  let seen = 0;
  let lastPct = -1;
  const out = createWriteStream(archivePath);
  const nodeStream = Readable.fromWeb(dl.body as Parameters<typeof Readable.fromWeb>[0]);
  await new Promise<void>((resolve, reject) => {
    nodeStream.on("data", (chunk: Buffer) => {
      h.update(chunk);
      seen += chunk.length;
      if (onProgress && total) {
        const pct = Math.floor((seen * 100) / total);
        if (pct !== lastPct && pct % 5 === 0) {
          lastPct = pct;
          onProgress(pct, Math.floor(seen / 1e6), Math.floor(total / 1e6));
        }
      }
    });
    nodeStream.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    nodeStream.pipe(out);
  });

  const got = h.digest("hex");
  if (got.toLowerCase() !== meta.sha256.toLowerCase()) {
    try {
      rmSync(archivePath, { force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`PRO archive SHA-256 mismatch — refusing to use it.\n  expected ${meta.sha256}\n  got      ${got}`);
  }

  // extract into a temp dir, then swap into place so `browser/` only appears fully-written
  const incoming = join(destBase, ".incoming");
  try {
    rmSync(incoming, { recursive: true, force: true });
    rmSync(browserDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  await extractArchive(archivePath, incoming);
  require("node:fs").renameSync(incoming, browserDir);

  const exe = findFile(browserDir, binaryName);
  if (!exe) throw new Error(`PRO archive verified but ${binaryName} was not found inside it.`);

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
 */
export async function proEnsureBinary(
  licenseKey?: string,
  licenseApiBase?: string,
  version?: string,
  onProgress?: ProProgress,
): Promise<string> {
  const key = resolveLicenseKey(licenseKey);
  if (!key) throw new Error("No license key — cannot fetch the PRO build.");
  const plat = platformTag();
  const base = apiBase(licenseApiBase);

  const q = version ? `&version=${encodeURIComponent(version)}` : "";
  const res = await fetch(`${base}/api/v1/download/pro?platform=${plat}${q}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`PRO download not authorized (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const meta = (await res.json()) as ProMeta;
  if (!meta.url || !meta.sha256 || !meta.asset) {
    throw new Error(`No PRO build is currently published for ${plat}.`);
  }
  return ensureFromMeta(
    {
      tag: meta.tag || `pro-${meta.version || "unknown"}`,
      asset: meta.asset,
      binary: meta.binary || (plat === "windows" ? "chrome.exe" : "chrome"),
      url: meta.url,
      sha256: meta.sha256,
      size: meta.size,
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
