import { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { PROFILES_DIR, FINGERPRINTS_DIR, readSettings } from "./store";
import { parseProxy, startRelay, needsRelay, proxyServerArg, type Relay } from "./proxy";
import { resolveLicenseKey, acquireLease, withRunToken, type LeaseSession } from "./license";
import { proEnsureBinary } from "./proBinary";
import { spawnBrowser } from "./winlaunch";
import type { Profile, LaunchResult } from "./types";

const running = new Map<string, ChildProcess>();
const relays = new Map<string, Relay>();
const leases = new Map<string, LeaseSession>();

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

/** Resolve tlsProfile to the concrete --fingerprint-tls-profile value the engine honors, or null.
 *  Mirrors src/types/profile.ts resolveTlsProfile — the engine ignores "match-persona"/"auto", so
 *  the default follows brandVersion's major; "native"/"off" → no switch; "chrome-<major>" pins it. */
function resolveTls(tlsProfile?: string, brandVersion?: string): string | null {
  const v = (tlsProfile ?? "").trim().toLowerCase();
  if (v === "native" || v === "off") return null;
  if (v.startsWith("chrome-") && /^\d+$/.test(v.slice(7))) return v;
  if (/^\d+$/.test(v)) return `chrome-${v}`;
  const head = (brandVersion ?? "").trim().split(".")[0];
  return /^\d+$/.test(head) ? `chrome-${head}` : null;
}

function buildArgs(p: Profile, userDataDir: string): string[] {
  const a: string[] = [`--fingerprint=${p.fingerprint}`];
  if (p.platform) a.push(`--fingerprint-platform=${p.platform}`);
  if (p.platformVersion) a.push(`--fingerprint-platform-version=${p.platformVersion}`);
  if (p.brand) a.push(`--fingerprint-brand=${p.brand}`);
  if (p.brandVersion) a.push(`--fingerprint-brand-version=${p.brandVersion}`);
  // TLS network persona: resolve "match-persona" to a concrete chrome-<major> (the engine ignores
  // the "match-persona"/"auto" abstraction — it must be turned into chrome-<brandVersion major>).
  const tls = resolveTls(p.tlsProfile, p.brandVersion);
  if (tls) a.push(`--fingerprint-tls-profile=${tls}`);
  // Android = mobile persona: give it a phone viewport (a later extraArgs --window-size wins).
  if (p.platform === "android" && !p.extraArgs?.some((x) => x.startsWith("--window-size")))
    a.push("--window-size=412,915");
  if (p.gpuVendor) a.push(`--fingerprint-gpu-vendor=${p.gpuVendor}`);
  if (p.gpuRenderer) a.push(`--fingerprint-gpu-renderer=${p.gpuRenderer}`);
  if (p.hardwareConcurrency != null)
    a.push(`--fingerprint-hardware-concurrency=${p.hardwareConcurrency}`);
  if (p.timezone) a.push(`--timezone=${p.timezone}`);
  if (p.acceptLanguage) a.push(`--accept-lang=${p.acceptLanguage}`);
  if (p.location) a.push(`--fingerprint-location=${p.location}`);
  if (p.webrtcIp) a.push(`--webrtc-ip=${p.webrtcIp}`);
  if (p.storageQuota != null) a.push(`--fingerprint-storage-quota=${p.storageQuota}`);
  // "Use real GPU": report the host's actual backend (most coherent when the profile/persona GPU
  // can't match the host's real render). Overrides any gpuVendor/gpuRenderer spoof.
  if (p.disableGpuFingerprint) a.push("--disable-gpu-fingerprint");
  // Farbling noise is on by default; turn it off for surfaces that read as untampered to strict ML.
  if (p.fingerprintNoise === false) a.push("--disable-fingerprint-noise");
  // Canvas bridge: forward canvas/WebGL to a remote real-GPU host for coherent pixel readback.
  if (p.canvasBridgeUrl) a.push(`--canvas-bridge-url=${p.canvasBridgeUrl}`);
  if (p.canvasBridgeAuth) a.push(`--canvas-bridge-auth=${p.canvasBridgeAuth}`);
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
  // proxy is handled in launch() (it may need a local auth-injecting relay)
  a.push(`--user-data-dir=${userDataDir}`);
  if (p.extraArgs?.length) a.push(...p.extraArgs);
  return a;
}

export async function launch(p: Profile): Promise<LaunchResult> {
  if (running.has(p.id)) {
    return { ok: false, error: "This profile is already running." };
  }

  // PRO vs free: a configured license key selects the license-gated PRO browser
  // (auto-downloaded) + a floating-concurrency lease whose run-token is injected as
  // CLEARCOTE_RUN_TOKEN. An explicit binary (Settings / CLEARCOTE_BINARY) always
  // wins over the PRO auto-download, matching the SDK's precedence. No key = free.
  const s = readSettings();
  const licenseKey = resolveLicenseKey(s.licenseKey);
  const hasExplicitBinary = !!(s.binaryPath || process.env.CLEARCOTE_BINARY);

  let bin: string | null;
  try {
    if (licenseKey && !hasExplicitBinary) {
      bin = await proEnsureBinary(licenseKey, s.licenseApiBase);
    } else {
      bin = resolveBinary();
    }
  } catch (e) {
    return { ok: false, error: `Could not obtain the PRO browser: ${String(e)}` };
  }
  if (!bin) {
    return {
      ok: false,
      error: "Clearcote binary not found. Set it in Settings, or set CLEARCOTE_BINARY.",
    };
  }

  // Acquire the concurrency lease BEFORE launching, so an over-limit / revoked
  // license fails fast (and never spawns a browser the gate would just refuse).
  let lease: LeaseSession | null = null;
  try {
    lease = await acquireLease({ licenseKey, licenseApiBase: s.licenseApiBase });
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }

  const userDataDir = p.userDataDir || path.join(PROFILES_DIR, p.id, "userdata");
  let relay: Relay | null = null;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    const args = buildArgs(p, userDataDir);
    // Proxy: an authenticated http/https proxy is reached via a local relay that injects the
    // credentials (Chromium ignores inline user:pass@), so the browser only ever sees 127.0.0.1.
    // SOCKS and credential-less proxies are passed straight through.
    const proxy = parseProxy(p.proxy);
    if (proxy && needsRelay(proxy)) {
      relay = await startRelay(proxy);
      relays.set(p.id, relay);
      args.push(`--proxy-server=${relay.url}`);
    } else if (proxy) {
      args.push(`--proxy-server=${proxyServerArg(proxy)}`);
    }
    // Inject the leased run-token so the PRO engine gate admits the launch.
    const env = lease ? withRunToken(lease.token, process.env) : undefined;
    // spawnBrowser survives the Windows first-launch SxS/AV race ("spawn UNKNOWN") on a
    // freshly-extracted chrome.exe: warm + back off + retry, then recover from a fresh copy.
    const child = await spawnBrowser(bin, args, { detached: false, env });
    running.set(p.id, child);
    if (lease) leases.set(p.id, lease);
    const cleanup = () => {
      running.delete(p.id);
      relays.get(p.id)?.stop();
      relays.delete(p.id);
      void leases.get(p.id)?.stop(); // release the concurrency slot
      leases.delete(p.id);
    };
    child.on("exit", cleanup);
    child.on("error", cleanup);
    return { ok: true, pid: child.pid, pro: !!lease };
  } catch (e) {
    relay?.stop();
    relays.delete(p.id);
    void lease?.stop(); // don't hold a slot for a launch that failed
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
  relays.get(id)?.stop();
  relays.delete(id);
  void leases.get(id)?.stop(); // release the concurrency slot
  leases.delete(id);
}

export function listRunning(): string[] {
  return [...running.keys()];
}
