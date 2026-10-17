// macOS: where the browser lives inside its bundle, how its archive is unpacked, and which Macs
// have a build at all. Mirrors the clearcote SDK (0.51.1+, sdk/node/src/download.ts + release.ts).
//
// The macOS build is PRO-only and Apple Silicon only: a `Chromium.app` bundle in a zip. Three things
// differ from the other platforms:
//   - The executable is `Chromium.app/Contents/MacOS/Chromium`. The same tree holds `Chromium
//     Framework` and the `Chromium Helper*` apps, so a plain name search could land on the wrong file.
//   - The bundle needs its symlinks (`Versions/Current`, ...) and exec bits, so it is unpacked with
//     `ditto` (`unzip` if that is missing), and the quarantine attribute is cleared: the build is
//     unsigned, and Gatekeeper refuses a quarantined bundle.
//   - A browser picked by hand arrives as the `.app` folder, which cannot be spawned: it is resolved
//     to the executable inside.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The /api/v1/download/pro and catalog platform key. */
export type BuildPlatform = "windows" | "linux" | "macos";

/** CPUs the native macOS build runs on. arm64 only: an Intel Mac (or an app running under Rosetta,
 *  which reports x64) has no build to download. */
export const MACOS_ARCHES: readonly string[] = ["arm64"];

/** The platform key for this OS, or null when there is no build for it at all. Unlike
 *  buildPlatformFor this never throws on an Intel Mac: the catalog and the version list are the
 *  same there, and only a download needs the CPU to match. */
export function catalogPlatformFor(platform: NodeJS.Platform | string = process.platform): BuildPlatform | null {
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "macos";
  return null;
}

/**
 * The platform key a download asks for. Throws when this machine has no build: an unsupported OS,
 * or a Mac that is not Apple Silicon (the build exists, just not for this CPU, so the message says
 * that rather than "unsupported OS").
 */
export function buildPlatformFor(
  platform: NodeJS.Platform | string = process.platform,
  arch: string = process.arch,
): BuildPlatform {
  const key = catalogPlatformFor(platform);
  if (!key) throw new Error("Clearcote ships Windows x64, Linux x64 and macOS (Apple Silicon) only.");
  if (key === "macos" && !MACOS_ARCHES.includes(arch)) {
    throw new Error(
      `The macOS Clearcote browser is for Apple Silicon (M1 or later) only; this Mac reports ${arch || "an unknown CPU"}. ` +
        "Choose a browser binary in Settings → Browser, or run the profile in the cloud.",
    );
  }
  return key;
}

/** The browser's file name inside a build, by platform. */
export function defaultBinaryName(plat: BuildPlatform): string {
  return plat === "windows" ? "chrome.exe" : plat === "macos" ? "Chromium" : "chrome";
}

/**
 * `<X>.app/Contents/MacOS/<name>` at the top of `dir` or one folder down, else null. Looking for
 * the bundle's own executable first means a name search can never land on the framework or a
 * helper app.
 */
export function appBinary(dir: string, name: string): string | null {
  let tops: string[];
  try {
    tops = fs.readdirSync(dir).sort();
  } catch {
    return null;
  }
  const parents = [dir, ...tops.filter((t) => !t.endsWith(".app")).map((t) => path.join(dir, t))];
  for (const parent of parents) {
    let entries: string[];
    try {
      entries = parent === dir ? tops : fs.readdirSync(parent).sort();
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.endsWith(".app")) continue;
      const exe = path.join(parent, e, "Contents", "MacOS", name);
      try {
        if (fs.statSync(exe).isFile()) return exe;
      } catch {
        /* not this bundle */
      }
    }
  }
  return null;
}

/** CFBundleExecutable from an XML Info.plist, or null (a binary plist, or no such key). */
export function plistExecutable(xml: string): string | null {
  const m = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
  return m ? m[1].trim() : null;
}

/**
 * The file to spawn for a browser path. A `.app` bundle (what the macOS file picker hands back, and
 * what someone pastes into CLEARCOTE_BINARY) resolves to the executable inside it: CFBundleExecutable
 * from its Info.plist, else the file named after the bundle, else the only file in Contents/MacOS.
 * Anything else, and a bundle with no executable, comes back unchanged.
 */
export function bundleExecutable(p: string): string {
  if (!/\.app\/?$/i.test(p)) return p;
  let isDir = false;
  try {
    isDir = fs.statSync(p).isDirectory();
  } catch {
    return p;
  }
  if (!isDir) return p;
  const macos = path.join(p, "Contents", "MacOS");
  const isFile = (f: string) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  };
  const candidates: string[] = [];
  try {
    const name = plistExecutable(fs.readFileSync(path.join(p, "Contents", "Info.plist"), "utf8"));
    if (name) candidates.push(name);
  } catch {
    /* no Info.plist, or unreadable */
  }
  candidates.push(path.basename(p.replace(/\/$/, ""), path.extname(p.replace(/\/$/, ""))));
  for (const c of candidates) {
    const exe = path.join(macos, c);
    if (isFile(exe)) return exe;
  }
  try {
    const files = fs.readdirSync(macos).filter((f) => isFile(path.join(macos, f)));
    if (files.length === 1) return path.join(macos, files[0]);
  } catch {
    /* no Contents/MacOS */
  }
  return p;
}

/** Test seam: the child-process runner the macOS extraction uses. */
export const macExtractHooks = {
  run: (file: string, args: string[]): Promise<unknown> =>
    new Promise((resolve, reject) =>
      execFile(file, args, (err, stdout) => (err ? reject(err) : resolve(stdout))),
    ),
};

/**
 * Unpack the macOS zip (a `Chromium.app` bundle) into `dest` with ditto, unzip as the fallback,
 * then clear the quarantine attribute from every bundle in it (best-effort).
 */
export async function extractMacBundle(asset: string, zipPath: string, dest: string): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  const tools: Array<[string, string[]]> = [
    ["/usr/bin/ditto", ["-x", "-k", zipPath, dest]],
    ["/usr/bin/unzip", ["-q", "-o", zipPath, "-d", dest]],
  ];
  for (const [file, args] of tools) {
    try {
      await macExtractHooks.run(file, args);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // that tool is not on this Mac
      throw new Error(`Could not unpack ${asset} with ${file}: ${String((e as Error).message).slice(0, 300)}`);
    }
    let apps: string[] = [];
    try {
      apps = fs.readdirSync(dest).filter((n) => n.endsWith(".app")).map((n) => path.join(dest, n));
    } catch {
      /* nothing to un-quarantine */
    }
    for (const app of apps.length ? apps : [dest]) {
      await macExtractHooks.run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app]).catch(() => undefined);
    }
    return;
  }
  throw new Error("Unpacking the macOS browser needs /usr/bin/ditto or /usr/bin/unzip.");
}
