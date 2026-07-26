import { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { PROFILES_DIR, FINGERPRINTS_DIR, readSettings } from "./store";
import { parseProxy, startRelay, needsRelay, proxyServerArg, type Relay } from "./proxy";
import { resolveLicenseKey, acquireLease, withRunToken, type LeaseSession } from "./license";
import { proEnsureBinary, freeEnsureBinary } from "./proBinary";
import { fetchCatalog, resolveVersion } from "./catalog";
import { fingerprintArgs, type FpInput } from "./fpargs";
import { spawnBrowser } from "./winlaunch";
import type { Settings, DownloadProgress } from "./types";
import type { Profile, LaunchResult } from "./types";

/**
 * Resolve the browser binary for a launch + report its tier.
 * Precedence (mirrors the SDK): explicit Settings/CLEARCOTE_BINARY path → the profile's
 * `browserVersion` via the public catalog (FREE → GitHub, PRO → /download/pro?version=) →
 * a sibling dev-build (offline fallback, only when no specific version was pinned).
 * The tier tells the caller whether to take a PRO concurrency lease (FREE builds have no gate).
 */
async function resolveBrowserBinary(
  p: Profile,
  s: Settings,
  onProgress?: (pct: number, seenMB: number, totalMB: number, version: string) => void,
): Promise<{ path: string; tier: "free" | "pro" | "explicit" }> {
  const explicit = [s.binaryPath, process.env.CLEARCOTE_BINARY].find(
    (c): c is string => !!c && fs.existsSync(c),
  );
  if (explicit) return { path: explicit, tier: "explicit" };

  const licenseKey = resolveLicenseKey(s.licenseKey);
  try {
    const cat = await fetchCatalog(s.licenseApiBase);
    const r = resolveVersion(cat, p.browserVersion, !!licenseKey);
    // Only fires when a download actually happens (cached builds resolve instantly, no progress).
    const prog = onProgress
      ? (pct: number, seenMB: number, totalMB: number) => onProgress(pct, seenMB, totalMB, r.version)
      : undefined;
    // Send the SELECTOR, not the bare version: a revision pin ("150.0.7871.114-r9") must survive
    // the round-trip or /download/pro silently serves the current pin instead of the build asked for.
    const path =
      r.tier === "pro"
        ? await proEnsureBinary(licenseKey, s.licenseApiBase, r.selector, prog)
        : await freeEnsureBinary(r, prog);
    return { path, tier: r.tier };
  } catch (e) {
    // Offline / catalog-unreachable: fall back to a sibling dev-build ONLY when no specific
    // version was requested — a pinned version must resolve against the catalog or fail loudly.
    const w = (p.browserVersion ?? "").trim().toLowerCase();
    const wantsSpecific = w !== "" && w !== "latest" && w !== "auto";
    if (!wantsSpecific) {
      const sibling = resolveBinary();
      if (sibling) return { path: sibling, tier: "explicit" };
    }
    throw e;
  }
}

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

/** Absolute path of a profile's captured-fingerprint file (a bare filename lives in the shared
 *  fingerprints dir). */
function fingerprintPath(ref: string): string {
  return path.isAbsolute(ref) ? ref : path.join(FINGERPRINTS_DIR, ref);
}

/** The host OS as the persona platform default, so an unset platform stays coherent with the
 *  binary actually running (a Windows build claiming linux is an immediate contradiction). */
function hostPlatform(): "windows" | "linux" | "macos" {
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "macos";
  return "windows";
}

/** Best-effort: recover the donor machine's navigator.languages from a captured profile, so an
 *  imported identity keeps its own language order instead of falling back to en-US,en. */
function profileAcceptLanguage(ref: string): string | undefined {
  try {
    const obj = JSON.parse(fs.readFileSync(fingerprintPath(ref), "utf8")) as Record<string, any>;
    const langs = obj?.navigator?.languages;
    if (Array.isArray(langs) && langs.length) return langs.map(String).join(",");
  } catch {
    /* unreadable / not a profile — fall through to the default */
  }
  return undefined;
}

/**
 * The real launch command line. The fingerprint switches come from the shared builder
 * (electron/fpargs.ts) so this path and the renderer's preview can never drift; only the bits that
 * genuinely differ live here — reading + gzipping the captured profile, the resolved user-data-dir,
 * and raw extraArgs. Proxy is added in launch() (it may need a local auth-injecting relay).
 */
export function buildArgs(p: Profile, userDataDir: string): string[] {
  const a = fingerprintArgs(p as FpInput, {
    hostPlatform: hostPlatform(),
    profileAcceptLanguage: p.fingerprintProfile ? profileAcceptLanguage(p.fingerprintProfile) : undefined,
    // gzip+base64 exactly as the SDK does — it keeps a ~40 KB capture inside Chromium's
    // command-line length limit, and the engine gunzips + parses it.
    encodeProfile: (ref) => {
      try {
        return zlib.gzipSync(fs.readFileSync(fingerprintPath(ref)), { level: 9 }).toString("base64");
      } catch {
        return null; // missing/unreadable profile — launch with just the seed
      }
    },
  });
  a.push(`--user-data-dir=${userDataDir}`);
  if (p.extraArgs?.length) a.push(...p.extraArgs);
  return a;
}

export async function launch(
  p: Profile,
  onDownload?: (ev: DownloadProgress) => void,
): Promise<LaunchResult> {
  if (running.has(p.id)) {
    return { ok: false, error: "This profile is already running." };
  }

  // Resolve the binary + its tier from the profile's browserVersion (explicit path wins).
  // A configured license key unlocks PRO builds; the gated PRO engine also needs a
  // floating-concurrency lease whose run-token is injected as CLEARCOTE_RUN_TOKEN. A FREE
  // build (e.g. version="149") has no gate — it needs no lease/slot, even for a licensed user.
  const s = readSettings();
  const licenseKey = resolveLicenseKey(s.licenseKey);

  let bin: string;
  let tier: "free" | "pro" | "explicit";
  try {
    const resolved = await resolveBrowserBinary(
      p,
      s,
      onDownload
        ? (pct, seenMB, totalMB, version) => onDownload({ id: p.id, version, pct, seenMB, totalMB })
        : undefined,
    );
    bin = resolved.path;
    tier = resolved.tier;
  } catch (e) {
    return { ok: false, error: `Could not obtain the browser: ${String((e as Error)?.message || e)}` };
  }

  // Acquire the concurrency lease BEFORE launching (so an over-limit / revoked license fails
  // fast and never spawns a browser the gate would just refuse) — but ONLY for a gated launch:
  // a resolved PRO build, or an explicit user-supplied binary paired with a license key.
  const wantLease = !!licenseKey && (tier === "pro" || tier === "explicit");
  let lease: LeaseSession | null = null;
  if (wantLease) {
    try {
      lease = await acquireLease({ licenseKey, licenseApiBase: s.licenseApiBase });
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message || e) };
    }
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
