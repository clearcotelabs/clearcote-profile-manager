import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { PROFILES_DIR, FINGERPRINTS_DIR, readSettings } from "./store";
import type { Profile, LaunchResult } from "./types";

const running = new Map<string, ChildProcess>();

/**
 * Resolve the Clearcote chrome.exe path (Phase 1: explicit/env/sibling-dev-build).
 * Order: Settings.binaryPath → CLEARCOTE_BINARY → sibling `../win-x64/chrome.exe`.
 * TODO Phase 3: fall back to the clearcote SDK's executablePath() (auto-download + SHA-256 verify).
 */
export function resolveBinary(): string | null {
  const s = readSettings();
  const candidates = [
    s.binaryPath,
    process.env.CLEARCOTE_BINARY,
    path.resolve(process.cwd(), "..", "win-x64", "chrome.exe"), // clearcoat/win-x64 dev build
    path.resolve(process.cwd(), "win-x64", "chrome.exe"),
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function buildArgs(p: Profile, userDataDir: string): string[] {
  const a: string[] = [`--fingerprint=${p.fingerprint}`];
  if (p.platform) a.push(`--fingerprint-platform=${p.platform}`);
  if (p.brand) a.push(`--fingerprint-brand=${p.brand}`);
  if (p.gpuVendor) a.push(`--fingerprint-gpu-vendor=${p.gpuVendor}`);
  if (p.gpuRenderer) a.push(`--fingerprint-gpu-renderer=${p.gpuRenderer}`);
  if (p.hardwareConcurrency != null)
    a.push(`--fingerprint-hardware-concurrency=${p.hardwareConcurrency}`);
  if (p.timezone) a.push(`--timezone=${p.timezone}`);
  if (p.acceptLanguage) a.push(`--accept-lang=${p.acceptLanguage}`);
  if (p.location) a.push(`--fingerprint-location=${p.location}`);
  if (p.webrtcIp) a.push(`--webrtc-ip=${p.webrtcIp}`);
  // Captured fingerprint profile (clearcote-profiles): gzip+base64-encode the JSON exactly as the
  // SDK does, so its fields override the seed-derived persona. Missing/unreadable -> fall back to seed.
  if (p.fingerprintProfile) {
    const fpPath = path.isAbsolute(p.fingerprintProfile)
      ? p.fingerprintProfile
      : path.join(FINGERPRINTS_DIR, p.fingerprintProfile);
    try {
      const raw = fs.readFileSync(fpPath);
      a.push(`--fingerprint-profile=${zlib.gzipSync(raw, { level: 9 }).toString("base64")}`);
    } catch {
      /* missing profile file — launch with just the seed */
    }
  }
  if (p.proxy?.server) a.push(`--proxy-server=${p.proxy.server}`);
  a.push(`--user-data-dir=${userDataDir}`);
  if (p.extraArgs?.length) a.push(...p.extraArgs);
  return a;
}

export function launch(p: Profile): LaunchResult {
  const bin = resolveBinary();
  if (!bin) {
    return {
      ok: false,
      error: "Clearcote binary not found. Set it in Settings, or set CLEARCOTE_BINARY.",
    };
  }
  if (running.has(p.id)) {
    return { ok: false, error: "This profile is already running." };
  }
  const userDataDir = p.userDataDir || path.join(PROFILES_DIR, p.id, "userdata");
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    const child = spawn(bin, buildArgs(p, userDataDir), { detached: false });
    running.set(p.id, child);
    child.on("exit", () => running.delete(p.id));
    child.on("error", () => running.delete(p.id));
    return { ok: true, pid: child.pid };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function stop(id: string): void {
  const c = running.get(id);
  if (c) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  running.delete(id);
}

export function listRunning(): string[] {
  return [...running.keys()];
}
