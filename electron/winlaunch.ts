// Windows first-launch antivirus-scan race work-around (vendored from the clearcote SDK).
//
// A just-extracted, unsigned chrome.exe can fail with "spawn UNKNOWN" / "side-by-side
// configuration is incorrect" while real-time AV scans chrome_elf.dll (the SxS assembly member the
// exe's manifest depends on), and Windows caches that negative activation context against the PATH
// — so retrying the same path keeps failing. `warmFiles` pre-scans the tree to close the race;
// `spawnBrowser` additionally (1) re-scans + backs off + retries, then (2) relaunches from a
// pristine copy on a fresh temp path, which always gets a clean SxS evaluation. No-op off Windows.

import { readdirSync, openSync, readSync, closeSync, mkdtempSync, mkdirSync, existsSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/** Sequentially read every file under `dir` so on-access AV finishes scanning the freshly-extracted
 *  binaries BEFORE the browser launches. Best-effort, safe to call anywhere. */
export function warmFiles(dir: string): void {
  const buf = Buffer.allocUnsafe(1 << 20);
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      try {
        const fd = openSync(p, "r");
        try {
          while (readSync(fd, buf, 0, buf.length, null) > 0) {
            /* discard — the read forces the AV scan */
          }
        } finally {
          closeSync(fd);
        }
      } catch {
        /* ignore unreadable/locked files */
      }
    }
  };
  walk(dir);
}

export function isWinLaunchRace(err: unknown): boolean {
  const m = String((err as Error)?.message ?? err).toLowerCase();
  return m.includes("spawn unknown") || m.includes("side-by-side") || m.includes("side by side");
}

/** Spawn once and resolve when the child actually starts (the "spawn" event), rejecting on an
 *  early spawn failure (sync throw or async "error"). */
function spawnOnce(bin: string, args: string[], opts: SpawnOptions): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(bin, args, opts);
    } catch (e) {
      reject(e);
      return;
    }
    child.once("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    child.once("spawn", () => {
      if (!settled) {
        settled = true;
        resolve(child);
      }
    });
  });
}

/** Stable per-binary "live" copy path under temp. Some install locations get their SxS
 *  activation-context permanently poisoned (Windows caches the failure against the path, and it
 *  never clears in place — a fresh COPY to a different location is the only reliable fix). We keep
 *  ONE warmed copy per binary dir and reuse it across launches, so we pay the copy at most once. */
function liveCopyDir(binDir: string): string {
  // Normalize (resolve separators/casing) so forward- and back-slash forms of the same dir map to
  // the SAME live copy — the launcher passes backslash paths, but callers may pass either.
  const id = createHash("sha256").update(resolve(binDir).toLowerCase()).digest("hex").slice(0, 16);
  return join(tmpdir(), "clearcote-live", id, "browser");
}

/** Build (or rebuild) the warmed live copy of `binDir` and return the exe path inside it. */
function buildLiveCopy(binDir: string, exeName: string): string {
  const live = liveCopyDir(binDir);
  try {
    rmSync(live, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  mkdirSync(dirname(live), { recursive: true });
  cpSync(binDir, live, { recursive: true });
  warmFiles(live);
  return join(live, exeName);
}

/**
 * Spawn the browser, surviving the Windows SxS/AV launch failure ("spawn UNKNOWN" /
 * "side-by-side configuration is incorrect"). Strategy, in order:
 *   1. If a healthy live copy already exists for this binary, launch from it (fast, no copy).
 *   2. Otherwise try the canonical path — a freshly-extracted+warmed install works here.
 *   3. On an SxS failure, build ONE persistent warmed copy under temp and launch from it; that
 *      copy is reused on later launches (step 1), so the ~1-2s copy is paid at most once.
 *   4. Last resort: a pristine one-off temp copy.
 * Off Windows this is a single plain spawn. Resolves once the process has actually started.
 */
export async function spawnBrowser(bin: string, args: string[], opts: SpawnOptions): Promise<ChildProcess> {
  if (process.platform !== "win32") return spawnOnce(bin, args, opts);

  const binDir = dirname(bin);
  const exeName = basename(bin);

  // 1. Reuse an already-built healthy live copy if we have one.
  const liveExe = join(liveCopyDir(binDir), exeName);
  if (existsSync(liveExe)) {
    try {
      return await spawnOnce(liveExe, args, opts);
    } catch (err) {
      if (!isWinLaunchRace(err)) throw err;
      // live copy went bad — fall through to rebuild
    }
  }

  // 2. Try the canonical (cache) path — healthy for a freshly warmed extraction.
  try {
    return await spawnOnce(bin, args, opts);
  } catch (err) {
    if (!isWinLaunchRace(err)) throw err;
  }

  // 3. Poisoned path — build a persistent warmed copy under temp and launch from it.
  try {
    return await spawnOnce(buildLiveCopy(binDir, exeName), args, opts);
  } catch (err) {
    if (!isWinLaunchRace(err)) throw err;
  }

  // 4. Last resort: a fresh one-off pristine copy.
  const recover = join(mkdtempSync(join(tmpdir(), "clearcote-recover-")), "browser");
  cpSync(binDir, recover, { recursive: true });
  warmFiles(recover);
  return spawnOnce(join(recover, exeName), args, opts);
}
