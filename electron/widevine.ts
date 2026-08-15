// Opt-in Widevine CDM fetch + per-profile seeding. Port of the clearcote SDK's sdk/node/src/
// widevine.ts, using this app's own bsdtar extraction rather than the SDK's `extract-zip`, so no
// dependency is added.
//
// WHY THIS EXISTS. Clearcote is a 100%-open-source build: it compiles the EME/Widevine *plumbing*
// (enable_widevine=true) but cannot bundle Google's proprietary CDM blob. Meanwhile every profile
// this app launches claims the "Google Chrome" UA-CH brand (--fingerprint-brand defaults to
// "chrome"). Google's branded Chrome ships the CDM on both desktop platforms, so a browser that
// claims the brand, implements EME, and then rejects com.widevine.alpha is describing a browser
// Google does not ship — one property lookup, no reference data needed. The public audit flags
// exactly that pairing ("a build branded Google Chrome carries Google's Widevine CDM").
//
// Opting in fetches the CDM from Google's own component server at runtime — which is how a real
// Chrome receives it too — verifies its SHA-256, and seeds it into the profile's user-data-dir.
// Measured on 151.0.7922.108-r15: without it com.widevine.alpha is NotSupportedError; with it,
// requestMediaKeySystemAccess AND createMediaKeys both succeed.
//
// The alternative, for anyone who would rather not run a proprietary blob, is to set the profile's
// brand to something other than Chrome — a build reporting "Chromium" is honestly a de-Googled
// browser and the audit does not ask it this question at all.

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

/** Chrome's component-updater app id for the Widevine CDM + Google's Omaha JSON endpoint. */
export const WIDEVINE_APP_ID = "oimompecagnajdejgnnjijobebaeigek";
export const OMAHA_URL = "https://update.googleapis.com/service/update2/json";
/** Linux registers the seeded CDM through this hint file; Windows uses a component-updater scan. */
export const HINT_FILE = "latest-component-updated-widevine-cdm";

/** Per-OS CDM coordinates. */
export function cdmPlatform(): {
  atOs: string;
  osPlatform: string;
  osVersion: string;
  subdir: string;
  filename: string;
} {
  if (process.platform === "linux") {
    return { atOs: "Linux", osPlatform: "Linux", osVersion: "6.1.0", subdir: "linux_x64", filename: "libwidevinecdm.so" };
  }
  return { atOs: "win", osPlatform: "Windows", osVersion: "10.0.19045.0", subdir: "win_x64", filename: "widevinecdm.dll" };
}

// update.googleapis.com sits behind Google's edge and 403s a bare fetch UA — send a browser-ish
// one, matching the OS we are asking the CDM for so the request is coherent.
const UA =
  process.platform === "linux"
    ? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

/** Shared CDM cache, so one download serves every profile. */
export function widevineCacheRoot(): string {
  return process.env.CLEARCOTE_WIDEVINE_DIR || path.join(homedir(), ".clearcote", "WidevineCdm");
}

/** Minimal Omaha v3.1 update check for the current-OS x64 CDM (version 0.0.0.0 -> latest). */
export function omahaRequestBody(): unknown {
  const { atOs, osPlatform, osVersion } = cdmPlatform();
  return {
    request: {
      "@os": atOs,
      "@updater": "clearcote",
      acceptformat: "crx3",
      protocol: "3.1",
      arch: "x64",
      nacl_arch: "x86-64",
      prodversion: "151.0.0.0",
      updaterversion: "151.0.0.0",
      dedup: "cr",
      os: { arch: "x86_64", platform: osPlatform, version: osVersion },
      app: [{ appid: WIDEVINE_APP_ID, version: "0.0.0.0", updatecheck: {}, ping: { r: -2 } }],
    },
  };
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify(body),
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Widevine update check HTTP ${res.status}`);
  let raw = await res.text();
  // Strip the XSSI guard Google prefixes onto JSON responses.
  if (raw.startsWith(")]}'")) raw = raw.includes("\n") ? raw.slice(raw.indexOf("\n") + 1) : raw.slice(4);
  return JSON.parse(raw) as unknown;
}

/** Pull [downloadUrl, sha256, version] from an Omaha response (pipelines or classic shape). */
export function parseUpdate(resp: any): [string, string, string] {
  const app = resp?.response?.app?.[0];
  const uc = app?.updatecheck;
  if (!uc || uc.status !== "ok") throw new Error(`Widevine update check status: ${uc?.status}`);
  for (const pl of uc.pipelines || []) {
    for (const op of pl.operations || []) {
      const urls = op.urls || [];
      const out = op.out || {};
      if (urls.length && out.sha256) return [urls[0].url, out.sha256, app.nextversion || uc.nextversion || ""];
    }
  }
  const base = uc.urls?.url?.[0]?.codebase;
  const pkg = uc.manifest?.packages?.package?.[0];
  if (base && pkg?.name) {
    return [base.replace(/\/+$/, "") + "/" + pkg.name, pkg.hash_sha256 || "", uc.manifest?.version || ""];
  }
  throw new Error("could not find a CDM download URL in the update response");
}

/** A CRX3 file is 'Cr24' + u32 version + u32 headerLen + header + zip. Return the zip bytes. */
export function crx3ToZip(buf: Buffer): Buffer {
  if (buf.subarray(0, 4).toString("latin1") !== "Cr24") return buf; // already a plain zip
  if (buf.length < 12) throw new Error("malformed CRX3 (truncated header)");
  const headerLen = buf.readUInt32LE(8);
  if (12 + headerLen > buf.length) throw new Error("malformed CRX3 (header overruns buffer)");
  return buf.subarray(12 + headerLen);
}

/** Extract with the same System32 bsdtar the browser download uses (a bare `tar` on PATH can be an
 *  MSYS GNU tar that mangles C:\ paths and cannot read .zip). */
function extractZip(archive: string, dest: string): Promise<void> {
  const bin =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "tar.exe")
      : "tar";
  mkdirSync(dest, { recursive: true });
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ["-xf", archive, "-C", dest], { stdio: "ignore" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code} extracting the CDM`))));
  });
}

/**
 * Download + verify the current-OS x64 CDM into the shared cache. Returns the versioned directory.
 * A CDM already present is reused, so this is cheap to call on every launch.
 */
export async function fetchWidevine(): Promise<string> {
  const [url, sha256, version] = parseUpdate(await postJson(OMAHA_URL, omahaRequestBody()));
  const verDir = path.join(widevineCacheRoot(), version || "current");
  const { subdir, filename } = cdmPlatform();
  const dll = path.join(verDir, "_platform_specific", subdir, filename);
  if (existsSync(dll) && existsSync(path.join(verDir, "manifest.json"))) return verDir;

  const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Widevine CDM download HTTP ${res.status}`);
  const blob = Buffer.from(await res.arrayBuffer());
  // The CDM is a NATIVE library loaded into the browser process. A missing or mismatched hash is a
  // hard failure, never a skip — this is the one place where "best effort" would be indefensible.
  if (!sha256) throw new Error("Widevine update response had no sha256 — refusing to install an unverified CDM");
  if (createHash("sha256").update(blob).digest("hex") !== sha256.toLowerCase()) {
    throw new Error("Widevine CDM sha256 mismatch — refusing to install");
  }

  mkdirSync(verDir, { recursive: true });
  const tmp = mkdtempSync(path.join(tmpdir(), "cc-wv-"));
  try {
    const zipPath = path.join(tmp, "cdm.zip");
    writeFileSync(zipPath, crx3ToZip(blob));
    await extractZip(zipPath, verDir);
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (!existsSync(dll)) throw new Error(`extracted the CDM but ${filename} is not at ${dll}`);
  return verDir;
}

/**
 * Make a profile load the CDM: copy it under <userDataDir>/WidevineCdm/<version>/ and write the
 * hint file the engine reads. Fetches first if the cache is cold. Returns the seeded directory.
 */
export async function seedWidevine(userDataDir: string): Promise<string> {
  const src = await fetchWidevine();
  const version = path.basename(src);
  const wvRoot = path.join(userDataDir, "WidevineCdm");
  const target = path.join(wvRoot, version);
  const { subdir, filename } = cdmPlatform();
  if (!existsSync(path.join(target, "_platform_specific", subdir, filename))) {
    mkdirSync(wvRoot, { recursive: true });
    cpSync(src, target, { recursive: true });
  }
  try {
    writeFileSync(path.join(wvRoot, HINT_FILE), JSON.stringify({ Path: target }));
  } catch {
    /* the hint file is how Linux registers the CDM; harmless if it cannot be written */
  }
  return target;
}

/**
 * The switch that makes the engine notice a seeded CDM.
 *
 * Windows registers pre-installed components through a startup scan, which `fast-update` forces.
 * On Linux the hint file IS the registration and is read at startup regardless, so nothing is
 * added there. Unlike the SDK there is no `--disable-component-update` to undo: that is a
 * Playwright default, and this app spawns the browser itself.
 */
export function widevineArgs(userArgs: string[]): string[] {
  if (process.platform === "linux") return [];
  if (userArgs.some((a) => a.includes("component-updater"))) return [];
  return ["--component-updater=fast-update"];
}

/** True when this profile claims the Google Chrome brand — the claim the CDM has to back up.
 *  The brand defaults to "chrome" when unset, which is why the default profile is included. */
export function claimsChromeBrand(brand?: string): boolean {
  const b = (brand ?? "chrome").trim().toLowerCase();
  return b === "chrome" || b === "google chrome";
}
