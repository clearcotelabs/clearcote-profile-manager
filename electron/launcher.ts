import { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { PROFILES_DIR, FINGERPRINTS_DIR, readSettings } from "./store";
import { parseProxy, startRelay, needsRelay, proxyArgs, socks5AuthSupportWarning, type Relay } from "./proxy";
import { geoCheck } from "./geo";
import { resolveLicenseKey, acquireLease, withRunToken, type LeaseSession } from "./license";
import { proEnsureBinary, freeEnsureBinary } from "./proBinary";
import { fetchCatalog, resolveVersion } from "./catalog";
import { fingerprintArgs, type FpInput } from "./fpargs";
import { withShaderDialect, shaderDialectWarning } from "./shaderdialect";
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
): Promise<{ path: string; tier: "free" | "pro" | "explicit"; major?: number }> {
  const explicit = [s.binaryPath, process.env.CLEARCOTE_BINARY].find(
    (c): c is string => !!c && fs.existsSync(c),
  );
  // An explicit binary's version is unknowable from the path, so `major` stays undefined and the
  // version-gated warnings below stay quiet rather than guessing.
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
    return { path, tier: r.tier, major: r.major };
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
 * Fill any UNSET timezone / acceptLanguage / location / webrtcIp from the proxy's exit-IP geo.
 *
 * This is what the `geoip` toggle promises, and until now nothing performed it: the flag was saved
 * on the profile and shown as a chip, but no code path ever read it, so a profile with geoip on and
 * no explicit `location` launched with no --fingerprint-location at all and the Geolocation API
 * returned the host's real position. Explicit values always win — geoip fills gaps, it never
 * overrides a choice the user made.
 *
 * Best-effort: a proxy that cannot be reached returns the profile unchanged plus a warning, because
 * failing to enrich is not a reason to refuse a launch the user asked for.
 */
export async function applyGeoip(p: Profile): Promise<{ profile: Profile; warning?: string }> {
  if (!p.geoip || !p.proxy) return { profile: p };
  const unset = (v: unknown) => v === undefined || v === null || v === "";
  // Nothing to fill — skip the network round-trip entirely.
  if (!unset(p.timezone) && !unset(p.acceptLanguage) && !unset(p.location) && !unset(p.webrtcIp)) {
    return { profile: p };
  }
  const geo = await geoCheck(p);
  if (!geo.ok) {
    return {
      profile: p,
      warning: `geoip is on but the proxy's exit region could not be resolved (${geo.error}). Launching with the profile's own timezone / language / location.`,
    };
  }
  const enriched: Profile = { ...p };
  if (unset(enriched.timezone) && geo.timezone) enriched.timezone = geo.timezone;
  if (unset(enriched.acceptLanguage) && geo.acceptLanguage) enriched.acceptLanguage = geo.acceptLanguage;
  if (unset(enriched.location) && geo.lat != null && geo.lon != null) enriched.location = `${geo.lat},${geo.lon}`;
  // Coherent WebRTC: report the proxy's egress IP rather than letting WebRTC contradict HTTP.
  if (unset(enriched.webrtcIp) && geo.ip) enriched.webrtcIp = geo.ip;
  return { profile: enriched };
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
  let major: number | undefined;
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
    major = resolved.major;
  } catch (e) {
    return { ok: false, error: `Could not obtain the browser: ${String((e as Error)?.message || e)}` };
  }

  // Non-fatal problems worth telling the user about, surfaced on the result rather than thrown:
  // each describes an option that will silently do nothing, which is the worst way to find out.
  const warnings: string[] = [];
  const proxy = parseProxy(p.proxy);
  const socksWarning = socks5AuthSupportWarning(proxy, major);
  if (socksWarning) warnings.push(socksWarning);
  let env: NodeJS.ProcessEnv | undefined;
  try {
    env = withShaderDialect(p.shaderDialect, undefined);
  } catch (e) {
    // An invalid dialect is a typo in saved config; refuse rather than launch a browser that
    // quietly reports the honest dialect while the profile claims otherwise.
    return { ok: false, error: String((e as Error)?.message || e) };
  }
  const dialectWarning = shaderDialectWarning(p.shaderDialect, major);
  if (dialectWarning) warnings.push(dialectWarning);

  // geoip fills unset timezone / language / location / WebRTC IP from the proxy's exit region.
  // Done BEFORE buildArgs so the enriched values reach the switches.
  const geo = await applyGeoip(p);
  if (geo.warning) warnings.push(geo.warning);
  p = geo.profile;

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
    // An authenticated SOCKS5 proxy goes straight to the engine, which does RFC 1929 itself via
    // --socks5-credentials. Credential-less proxies need neither.
    if (proxy && needsRelay(proxy)) {
      relay = await startRelay(proxy);
      relays.set(p.id, relay);
      args.push(...proxyArgs(proxy, { relayUrl: relay.url }));
    } else {
      args.push(...proxyArgs(proxy));
    }
    // Inject the leased run-token so the PRO engine gate admits the launch, preserving any
    // shader-dialect variable already folded in above.
    if (lease) env = withRunToken(lease.token, env ?? process.env);
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
    return { ok: true, pid: child.pid, pro: !!lease, warnings: warnings.length ? warnings : undefined };
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
