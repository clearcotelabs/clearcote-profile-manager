import { type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { PROFILES_DIR, FINGERPRINTS_DIR, ROOT, readSettings, writeSettings } from "./store";
import { markLaunched, recordGeo } from "./profiles";
import { webrtcIpFollowsProxy } from "./proxyargs";
import { Tail, type ExitFacts } from "./exitreason";
import { stopGracefully, type StopOutcome } from "./procstop";
import { parseProxy, proxyProblem, startRelay, needsRelay, proxyArgs, socks5AuthSupportWarning, socks5UdpSupportWarning, type Relay } from "./proxy";
import { geoCheck } from "./geo";
import { pinUdpSession, relayProxyByIp, type UdpVerdict } from "./proxycheck";
import { resolveLicenseKey, acquireLease, withRunToken, planFromToken, type LeaseSession } from "./license";
import { engineSupportsSwitch, preparePersonaLaunch } from "./persona";  // r51+: server-side personas (the signed persona token)
import { proEnsureBinary, freeEnsureBinary } from "./proBinary";
import { fetchCatalog, resolveVersion } from "./catalog";
import { fingerprintArgs, macosKeychainArgs, mergeFeatureFlags, proxyEgressArgs, QUIC_RELAY_SWITCH, startUrlArg, type FpInput } from "./fpargs";
import { clearPending, injectCookies, readPending } from "./cookiejar";
import { withShaderDialect, shaderDialectWarning } from "./shaderdialect";
import { seedWidevine, widevineArgs, claimsChromeBrand } from "./widevine";
import { extensionsForLaunch, withExtensionArgs } from "./extensions";
import { seedAutofillPrefs } from "./autofillpref";
import {
  crlsetArgsWarning,
  crlsetEnabled,
  holdUntilLive,
  releaseHeldTab,
  resolveCrlset,
  seedCrlset,
  HOLD_URL,
  PIPE_SWITCH,
  PipeCdp,
  ProbeServer,
  WAIT_TIMEOUT_MS,
} from "./crlset";
import { spawnBrowser } from "./winlaunch";
import { clearActivePort, debugPortArgs, endpointFor, waitForActivePort } from "./devtools";
import { linuxFontEnv, linuxLocaleEnv } from "./linuxfonts";
import { bundleExecutable } from "./macos";
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
  const explicit = explicitBinary(s);
  // An explicit binary's version is unknowable from the path, so `major` stays undefined and the
  // version-gated warnings below stay quiet rather than guessing.
  if (explicit) return { path: explicit, tier: "explicit" };

  try {
    return await ensureBuild(p.browserVersion, s, onProgress);
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

/**
 * The binary named in Settings or CLEARCOTE_BINARY, when it exists — a macOS `.app` bundle resolved
 * to the executable inside it, since a bundle folder cannot be spawned.
 */
export function explicitBinary(s: Pick<Settings, "binaryPath">, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const found = [s.binaryPath, env.CLEARCOTE_BINARY].find((c): c is string => !!c && fs.existsSync(c));
  return found ? bundleExecutable(found) : undefined;
}

/**
 * Make sure the build a version selection resolves to is downloaded and verified; return its path.
 * Used by every launch, and by Settings → Storage "Download now" so the first launch is not a
 * 250 MB wait. Downloads of the same build share one transfer (see proBinary.ts).
 */
export async function ensureBuild(
  browserVersion: string | undefined,
  s: Settings,
  onProgress?: (pct: number, seenMB: number, totalMB: number, version: string) => void,
): Promise<{ path: string; tier: "free" | "pro"; major: number; version: string }> {
  const licenseKey = resolveLicenseKey(s.licenseKey);
  {
    const cat = await fetchCatalog(s.licenseApiBase);
    const r = resolveVersion(cat, browserVersion, !!licenseKey);
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
    return { path, tier: r.tier, major: r.major, version: r.version };
  }
}

/** Keep the plan the lease reported, so the header can name it without asking the server. */
function rememberPlan(lease: LeaseSession | null): void {
  // An offline-grace lease carries a cached token, which says nothing new about the plan.
  const plan = lease && lease.leaseId !== "cached" ? planFromToken(lease.token) : undefined;
  if (!plan) return;
  try {
    const cur = readSettings();
    if (cur.lastPlan !== plan) writeSettings({ ...cur, lastPlan: plan });
  } catch {
    /* bookkeeping only — never fail a launch over it */
  }
}

const running = new Map<string, ChildProcess>();
const relays = new Map<string, Relay>();
const leases = new Map<string, LeaseSession>();
/** The binary each running browser was launched from — a build in use is never pruned. */
const runningBins = new Map<string, string>();
/** The local DevTools endpoint of each browser launched with automation (electron/devtools.ts). */
const endpoints = new Map<string, string>();
/** Profiles whose browser THIS app is stopping, so their exit is not reported as unexpected. */
const stopping = new Set<string>();
let quitting = false;

/**
 * Events for the main window. "exited" fires when a browser stops without the app asking —
 * closed from its own window, crashed, ended from Task Manager, or stopped by the licence
 * watchdog — with the facts electron/exitreason.ts classifies.
 */
export const browserEvents = new EventEmitter();
export interface ExitEvent extends ExitFacts {
  id: string;
}

/** Set while the app quits: browsers it closes on the way out are not "unexpected". */
export function setQuitting(v: boolean): void {
  quitting = v;
}

export function runningBinaries(): string[] {
  return [...runningBins.values()];
}

/** The sibling dev-build layout for a host: `win-x64/chrome.exe`, `linux-x64/chrome`, or the macOS
 *  bundle `macos-arm64/Chromium.app/Contents/MacOS/Chromium`. */
export function devBuildLayout(platform: NodeJS.Platform | string = process.platform): [string, string] {
  if (platform === "win32") return ["win-x64", "chrome.exe"];
  if (platform === "darwin") return ["macos-arm64", path.join("Chromium.app", "Contents", "MacOS", "Chromium")];
  return ["linux-x64", "chrome"];
}

/**
 * Resolve the Clearcote browser path (Phase 1: explicit/env/sibling-dev-build).
 * Order: Settings.binaryPath → CLEARCOTE_BINARY → a sibling dev build for THIS host
 * (`../win-x64/chrome.exe` on Windows, `../linux-x64/chrome` on Linux, `../macos-arm64/Chromium.app`
 * on macOS). A macOS `.app` resolves to the executable inside it.
 * TODO Phase 3: fall back to the clearcote SDK's executablePath() (auto-download + SHA-256 verify).
 */
export function resolveBinary(): string | null {
  const s = readSettings();
  // Only the host's own layout is probed: a Windows chrome.exe sitting next to a Linux checkout is
  // not runnable here, and silently "finding" it would fail later as a confusing spawn error.
  const [dir, exe] = devBuildLayout();
  const candidates = [
    s.binaryPath,
    process.env.CLEARCOTE_BINARY,
    path.resolve(process.cwd(), "..", dir, exe), // clearcoat/<plat>-x64 dev build
    path.resolve(process.cwd(), dir, exe),
  ].filter((c): c is string => !!c);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return bundleExecutable(c);
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

/** The captured profile's own thread count and memory, for a launch without a seed (see FpArgsOptions). */
function profileHardware(ref: string): { hardwareConcurrency?: number; deviceMemory?: number } {
  try {
    const obj = JSON.parse(fs.readFileSync(fingerprintPath(ref), "utf8")) as Record<string, unknown>;
    const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    const hc = pos(obj?.hardware_concurrency);
    return { hardwareConcurrency: hc !== undefined && Number.isInteger(hc) ? hc : undefined, deviceMemory: pos(obj?.device_memory) };
  } catch {
    return {};
  }
}

/**
 * Fill any UNSET timezone / acceptLanguage / location / webrtcIp from the proxy's exit-IP geo, and
 * refresh a WebRTC IP that came from an earlier lookup.
 *
 * This is what the `geoip` toggle promises, and until now nothing performed it: the flag was saved
 * on the profile and shown as a chip, but no code path ever read it, so a profile with geoip on and
 * no explicit `location` launched with no --fingerprint-location at all and the Geolocation API
 * returned the host's real position. Explicit values always win — geoip fills gaps, it never
 * overrides a choice the user made.
 *
 * A WebRTC IP the app itself resolved is not such a choice. "Resolve from proxy" writes the exit it
 * found into `webrtcIp`, and the engine reports exactly that address as the WebRTC public IP
 * (--webrtc-ip wins over any real STUN answer, "Relay UDP" on or off). Residential sticky sessions
 * move to another exit every few minutes, so by launch time that snapshot was stale: HTTP left from
 * the proxy's new address while WebRTC still named the old one — CR-LYJSFW, measured 2026-10-24 with
 * the customer's own proxies. So while `webrtcIp` still equals the last exit the app looked up
 * ({@link webrtcIpFollowsProxy}), every launch looks the exit up again and replaces it, whatever
 * the geoip toggle says; the new value is saved so the next launch recognises it again. An address
 * the user typed (anything else) is left alone.
 *
 * Best-effort: a proxy that cannot be reached returns the profile unchanged plus a warning, because
 * failing to enrich is not a reason to refuse a launch the user asked for.
 */
export async function applyGeoip(p: Profile): Promise<{ profile: Profile; warning?: string; refreshedWebrtcIp?: string }> {
  if (!p.proxy) return { profile: p };
  const unset = (v: unknown) => v === undefined || v === null || v === "";
  const follows = webrtcIpFollowsProxy(p);
  const gaps = !!p.geoip && (unset(p.timezone) || unset(p.acceptLanguage) || unset(p.location) || unset(p.webrtcIp));
  // Nothing to fill and nothing to refresh — skip the network round-trip entirely.
  if (!gaps && !follows) return { profile: p };
  const geo = await geoCheck(p);
  if (!geo.ok) {
    return {
      profile: p,
      warning: gaps
        ? `geoip is on but the proxy's exit region could not be resolved (${geo.error}). Launching with the profile's own timezone / language / location.`
        : `The proxy's exit could not be looked up (${geo.error}), so WebRTC reports ${p.webrtcIp} from the last lookup, which may no longer be where the proxy exits.`,
    };
  }
  const enriched: Profile = { ...p };
  if (gaps) {
    if (unset(enriched.timezone) && geo.timezone) enriched.timezone = geo.timezone;
    if (unset(enriched.acceptLanguage) && geo.acceptLanguage) enriched.acceptLanguage = geo.acceptLanguage;
    if (unset(enriched.location) && geo.lat != null && geo.lon != null) enriched.location = `${geo.lat},${geo.lon}`;
    // Coherent WebRTC: report the proxy's egress IP rather than letting WebRTC contradict HTTP.
    if (unset(enriched.webrtcIp) && geo.ip) enriched.webrtcIp = geo.ip;
  }
  let refreshedWebrtcIp: string | undefined;
  if (follows && geo.ip && geo.ip !== p.webrtcIp) {
    enriched.webrtcIp = geo.ip;
    refreshedWebrtcIp = geo.ip;
  }
  // Keep what we learned, so the card can show where this profile's traffic exits — and the
  // refreshed WebRTC IP with it, so it still matches the lookup next time.
  recordGeo(p.id, geo, p.proxy, undefined, follows && geo.ip ? { webrtcIp: geo.ip } : undefined);
  return { profile: enriched, ...(refreshedWebrtcIp ? { refreshedWebrtcIp } : {}) };
}

/**
 * Everything a launch does to the proxy session before the browser starts, in this order:
 *   1. Relay UDP on → the session's first UDP association (pinUdpSession). Residential vendors move a
 *      sticky session to one of their UDP-capable exits at the first association and leave it there
 *      (CR-LYJSFW, measured), so this has to happen before step 2 or the address resolved is not the
 *      one the browser ends up on. Its verdict is the launch message's UDP line — the app used to
 *      run a whole Check after the launch for that, which moved the session under the running browser.
 *   2. applyGeoip on the session as it now is.
 */
export async function prepareProxySession(
  p: Profile,
): Promise<{ profile: Profile; warnings: string[]; udp?: { udp: UdpVerdict; detail?: string } }> {
  const warnings: string[] = [];
  const pinned = proxyProblem(p.proxy) ? null : await pinUdpSession(p);
  const geo = await applyGeoip(p);
  if (geo.warning) warnings.push(geo.warning);
  return { profile: geo.profile, warnings, ...(pinned ? { udp: pinned } : {}) };
}

/**
 * Relay UDP on, and the session's first association (pinUdpSession) was REFUSED by the proxy: launch this
 * time with Relay UDP off, and say so. A relay through a proxy that refuses UDP closes every UDP socket at
 * once (WebRTC reports an error and no public address, HTTP/3 never starts); with it off the browser behaves
 * exactly as it does with the toggle off. Anything short of a clear refusal keeps the relay on. The saved
 * profile is not changed.
 */
export function relayUdpAfterPin(
  p: Profile,
  udp: { udp: UdpVerdict; detail?: string } | undefined,
): { profile: Profile; warning?: string } {
  if (!p.socks5Udp || udp?.udp !== "refused") return { profile: p };
  return {
    profile: { ...p, socks5Udp: false },
    warning: `Relay UDP is off for this launch: the proxy refused UDP${udp.detail ? ` (${udp.detail.replace(/\.$/, "")})` : ""}. ` +
      "WebRTC and HTTP/3 work as with Relay UDP off. Use a proxy plan that carries UDP to relay it.",
  };
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
    profileHardware: p.fingerprintProfile ? profileHardware(p.fingerprintProfile) : undefined,
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
  // macOS: no "Chromium Safe Storage" keychain prompt on every launch of the unsigned build.
  a.push(...macosKeychainArgs(process.platform, p.extraArgs));
  if (p.extraArgs?.length) a.push(...p.extraArgs);
  // The start page goes LAST: Chromium opens every non-switch argument as a URL. startUrlArg only
  // ever returns an http(s) URL, so a value can never smuggle in a switch.
  const url = startUrlArg(p.startUrl);
  if (url) a.push(url);
  return a;
}

export interface LaunchOptions {
  /** Open a local DevTools endpoint (electron/devtools.ts), as the Jet synchronizer needs. The
   *  "Allow automation" setting turns it on for every launch. */
  automation?: boolean;
  /** How long to wait for the browser to report its DevTools port (tests shorten it). */
  portWaitMs?: number;
}

export async function launch(
  p: Profile,
  onDownload?: (ev: DownloadProgress) => void,
  opts: LaunchOptions = {},
): Promise<LaunchResult> {
  if (running.has(p.id)) {
    return { ok: false, error: "This profile is already running." };
  }
  // A proxy that is filled in but unreadable must never mean "launch without one": that would
  // open the browser on this PC's own IP while the profile says it uses a proxy.
  const unreadable = proxyProblem(p.proxy);
  if (unreadable) return { ok: false, error: unreadable };

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
  const udpWarning = socks5UdpSupportWarning(proxy, p.socks5Udp, major);
  if (udpWarning) warnings.push(udpWarning);
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

  // A profile claiming the Google Chrome brand with no CDM contradicts itself: Google's branded
  // build ships Widevine on both desktop platforms, so a browser asserting that brand, implementing
  // EME, and then rejecting com.widevine.alpha describes a browser Google does not ship. Say it
  // once here rather than leaving it to be discovered from a site that scores it.
  if (!p.widevine && claimsChromeBrand(p.brand)) {
    warnings.push(
      'This profile reports the "Google Chrome" brand but has no Widevine CDM, which Google\'s build always ships — a mismatch a page can read directly. Enable Widevine (DRM) on the profile, or set its brand to something other than Chrome.',
    );
  }

  // With Relay UDP on, the session's first UDP association, then geoip (unset timezone / language /
  // location / WebRTC IP from the proxy's exit region, and a resolved WebRTC IP refreshed). Done
  // BEFORE buildArgs so the enriched values reach the switches.
  const session = await prepareProxySession(p);
  warnings.push(...session.warnings);
  const udpRelay = relayUdpAfterPin(session.profile, session.udp);
  if (udpRelay.warning) warnings.push(udpRelay.warning);
  p = udpRelay.profile;

  // Acquire the concurrency lease BEFORE launching (so an over-limit / revoked license fails
  // fast and never spawns a browser the gate would just refuse) — but ONLY for a gated launch:
  // a resolved PRO build, or an explicit user-supplied binary paired with a license key.
  const wantLease = !!licenseKey && (tier === "pro" || tier === "explicit");
  let lease: LeaseSession | null = null;
  if (wantLease) {
    try {
      lease = await acquireLease({ licenseKey, licenseApiBase: s.licenseApiBase });
    } catch (e) {
      // The code (CONCURRENCY_LIMIT_EXCEEDED, LICENSE_REVOKED…) is what lets the UI say what to do
      // about it, rather than showing the sentence and leaving the reader to guess.
      return { ok: false, error: String((e as Error)?.message || e), code: (e as { code?: string })?.code };
    }
    rememberPlan(lease);
  }

  const userDataDir = p.userDataDir || path.join(PROFILES_DIR, p.id, "userdata");
  let relay: Relay | null = null;
  let probe: ProbeServer | undefined;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    // Autofill on where the profile has no setting yet, as Chrome has it (electron/autofillpref.ts).
    seedAutofillPrefs(userDataDir);
    // Chrome's revocation list (electron/crlset.ts): seeded into the profile, then the first tab is held on
    // about:blank until it is live, so the start page is never fetched while revoked certificates still pass.
    // Best-effort, like Widevine: a launch without it is told why, never refused.
    if (crlsetEnabled(s)) {
      const blocked = crlsetArgsWarning(p.extraArgs);
      if (blocked) warnings.push(blocked);
      else {
        try {
          seedCrlset(userDataDir, await resolveCrlset());
          probe = await ProbeServer.start();
        } catch (e) {
          warnings.push(
            `Could not install Chrome's certificate revocation list (${String((e as Error)?.message || e)}). Launching without it — certificates Chrome has revoked are still accepted.`,
          );
        }
      }
    }
    // Imported cookies (electron/cookiejar.ts) go in over the same DevTools pipe, before the first page loads,
    // so a launch that has some holds its first tab too.
    const cookies = readPending(p.id);
    const hold = !!probe || cookies.length > 0;
    const startUrl = startUrlArg(p.startUrl);
    const args = hold ? [...buildArgs({ ...p, startUrl: undefined }, userDataDir), PIPE_SWITCH, HOLD_URL] : buildArgs(p, userDataDir);
    const automation = !!(opts.automation || s.automation);
    if (automation) {
      clearActivePort(userDataDir);
      args.push(...debugPortArgs(p.extraArgs));
    }
    // Widevine: seed the CDM into this profile before the browser reads it. Downloaded once into a
    // shared cache and copied in, so only the first opt-in launch pays for it. A failure here is
    // non-fatal — DRM and the brand row stay as they were, and the user is told why.
    if (p.widevine) {
      try {
        await seedWidevine(userDataDir);
        args.push(...widevineArgs(args));
      } catch (e) {
        warnings.push(
          `Widevine is enabled but the CDM could not be installed (${String((e as Error)?.message || e)}). Launching without it — DRM playback will fail.`,
        );
      }
    }
    // Proxy: an authenticated http/https proxy is reached via a local relay that injects the
    // credentials (Chromium ignores inline user:pass@), so the browser only ever sees 127.0.0.1.
    // An authenticated SOCKS5 proxy goes straight to the engine, which does RFC 1929 itself via
    // --socks5-credentials. Credential-less proxies need neither.
    if (proxy && needsRelay(proxy)) {
      relay = await startRelay(proxy);
      relays.set(p.id, relay);
      args.push(...proxyArgs(proxy, { relayUrl: relay.url, transparentProxy: p.transparentProxy }));
    } else {
      // Relay UDP: a proxy given by host name goes to the browser as the IP address the engine relays through.
      const relayed = await relayProxyByIp(proxy, p.socks5Udp);
      if (relayed.warning) warnings.push(relayed.warning);
      args.push(...proxyArgs(relayed.proxy, { socks5Udp: p.socks5Udp, transparentProxy: p.transparentProxy }));
    }
    // PRO r54+: with Relay UDP on a socks5 proxy, HTTP/3 goes through the relay too, so QUIC stays on.
    const quicRelay = !!proxy && !!p.socks5Udp && proxy.scheme.startsWith("socks5") && engineSupportsSwitch(bin, QUIC_RELAY_SWITCH);
    args.push(...proxyEgressArgs(!!proxy, p.extraArgs, quicRelay));
    // One --enable-features and one --disable-features: Chromium keeps only the last of each.
    let argv = mergeFeatureFlags(args);
    // Extensions (electron/extensions.ts): the profile's, from the copies kept on this computer, in one
    // --load-extension. One that is missing or cannot be updated is said, never a refused launch.
    if (p.extensions?.length) {
      const ext = await extensionsForLaunch(ROOT, p.extensions);
      warnings.push(...ext.warnings);
      argv = withExtensionArgs(argv, ext.dirs);
    }
    // Linux: the browser's own font bundle (FONTCONFIG_FILE) and the UI locale from --lang (LANGUAGE),
    // as the SDK sets them. Without the first, a Linux launch rendered with the host's fonts.
    const linuxEnv = { ...linuxFontEnv(bin, (m) => warnings.push(m)), ...linuxLocaleEnv(argv) };
    if (Object.keys(linuxEnv).length) env = { ...(env ?? process.env), ...linuxEnv };
    // Inject the leased run-token so the PRO engine gate admits the launch, preserving any
    // shader-dialect variable already folded in above. The token is also mirrored into a file this
    // launch owns: a supporting engine re-reads it and stops a running FREE browser once the token
    // stops advancing (revoked / checked in / over the limit), and refuses a free launch without it.
    let releaseTokenFile: (() => void) | undefined;
    if (lease) {
      const bound = lease.bindLaunch();
      releaseTokenFile = bound.release;
      env = withRunToken(lease.token, env ?? process.env, bound.path);
      // r51+ engines need the signed persona token (persona.ts); older engines come back unchanged. The host-facts
      // probe gets this launch's env, token FILE included: the engine refuses a FREE token without the file, so a
      // probe given only CLEARCOTE_RUN_TOKEN died and every free launch failed before its persona was fetched (0.27.0).
      const personaLaunch = await preparePersonaLaunch(bin, argv, lease, { env });
      argv = personaLaunch.args;
      env = personaLaunch.env(env);
    }
    // spawnBrowser survives the Windows first-launch SxS/AV race ("spawn UNKNOWN") on a
    // freshly-extracted chrome.exe: warm + back off + retry, then recover from a fresh copy.
    //
    // stdio: nothing read from stdout, and stderr drained into a small tail. Both used to be
    // unread pipes (Node's default): a browser that logged enough filled the pipe and FROZE on its
    // next write. The tail is also how an exit is explained — the licence watchdog exits with
    // code 0, like a normal close, and only its stderr line tells them apart.
    //
    // fds 3 and 4 are the DevTools pipe of a launch that holds its first tab (revocation list, imported cookies).
    const child = await spawnBrowser(bin, argv, {
      detached: false,
      env,
      stdio: hold ? ["ignore", "ignore", "pipe", "pipe", "pipe"] : ["ignore", "ignore", "pipe"],
    });
    const tail = new Tail();
    child.stderr?.on("data", (d: Buffer) => tail.push(d));
    const startedAt = Date.now();
    running.set(p.id, child);
    runningBins.set(p.id, bin);
    markLaunched(p.id); // lastLaunchedAt only, on the profile as saved now — see profiles.ts
    if (lease) leases.set(p.id, lease);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      running.delete(p.id);
      runningBins.delete(p.id);
      endpoints.delete(p.id);
      relays.get(p.id)?.stop();
      relays.delete(p.id);
      releaseTokenFile?.(); // remove this launch's run-token file
      void leases.get(p.id)?.stop(); // release the concurrency slot
      leases.delete(p.id);
    };
    child.on("exit", (code, signal) => {
      // Read before cleanup() drops the lease.
      const refusal = leases.get(p.id)?.refusal;
      const asked = stopping.has(p.id) || quitting;
      cleanup();
      if (!asked) {
        const ev: ExitEvent = {
          id: p.id,
          code,
          signal,
          stderrTail: tail.text(),
          leaseRefusal: refusal,
          ranForMs: Date.now() - startedAt,
        };
        browserEvents.emit("exited", ev);
      }
    });
    child.on("error", cleanup);
    const cdp = hold ? new PipeCdp(child.stdio[3] as Writable, child.stdio[4] as Readable) : null;
    if (cdp && cookies.length) {
      try {
        const { set, refused } = await injectCookies(cdp, cookies);
        clearPending(p.id);
        if (refused) {
          warnings.push(
            `${set} imported cookie${set === 1 ? "" : "s"} added; the browser refused ${refused} (malformed or not allowed for its site).`,
          );
        }
      } catch (e) {
        // Kept for the next launch: the browser closed before they were all in.
        warnings.push(`The imported cookies could not be added (${String((e as Error)?.message || e)}). They will be tried again at the next launch.`);
      }
    }
    if (cdp && !probe) {
      await releaseHeldTab(cdp, startUrl ? { url: startUrl } : { newTab: true }).catch(() => {});
    }
    if (cdp && probe) {
      try {
        // "left": the user navigated or closed the held tab during the wait — their choice, not a failure.
        const outcome = await holdUntilLive(cdp, probe, startUrl ? { url: startUrl } : { newTab: true });
        if (outcome === "timeout") {
          warnings.push(
            `Chrome's certificate revocation list was not confirmed active within ${WAIT_TIMEOUT_MS / 1000} s, so the start page opened without waiting for it. It still applies once the browser has finished starting.`,
          );
        }
      } catch (e) {
        // The browser closed during the wait, or it never opened the tab to hold.
        if (running.has(p.id)) {
          warnings.push(`The wait for Chrome's certificate revocation list failed (${String((e as Error)?.message || e)}).`);
        }
      } finally {
        probe.close();
      }
    }
    let endpoint: string | undefined;
    if (automation) {
      const port = await waitForActivePort(userDataDir, { alive: () => running.get(p.id) === child, timeoutMs: opts.portWaitMs });
      if (port) {
        endpoint = endpointFor(port);
        if (running.get(p.id) === child) endpoints.set(p.id, endpoint);
      } else if (running.get(p.id) === child) {
        warnings.push("The browser did not open its local automation port, so tasks cannot run in this window. Close it and launch it again.");
      }
    }
    return {
      ok: true,
      pid: child.pid,
      ...(endpoint ? { cdp: endpoint } : {}),
      pro: !!lease,
      warnings: warnings.length ? warnings : undefined,
      ...(session.udp ? { udp: session.udp.udp, udpDetail: session.udp.detail } : {}),
    };
  } catch (e) {
    probe?.close();
    relay?.stop();
    relays.delete(p.id);
    void lease?.stop(); // don't hold a slot for a launch that failed
    return { ok: false, error: String(e) };
  }
}

/**
 * Close a profile's browser the way its own window would, force it only if it will not go, and
 * resolve once the process has exited AND its licence slot has been checked back in — so a caller
 * can launch another profile straight after on a one-browser plan.
 */
export async function stop(id: string, opts: { timeoutMs?: number } = {}): Promise<StopOutcome> {
  const c = running.get(id);
  const lease = leases.get(id);
  if (!c) {
    await lease?.stop();
    return "gone";
  }
  stopping.add(id);
  try {
    const outcome = await stopGracefully(c, { timeoutMs: opts.timeoutMs });
    await lease?.stop(); // the exit handler started the check-in; this waits for it
    return outcome;
  } finally {
    stopping.delete(id);
  }
}

/** Stop every running browser (quitting the app). */
export async function stopAll(opts: { timeoutMs?: number } = {}): Promise<void> {
  await Promise.all(listRunning().map((id) => stop(id, opts)));
}

/** The local DevTools endpoint of a running profile, when it was launched with automation. */
export function cdpEndpoint(id: string): string | undefined {
  return running.has(id) ? endpoints.get(id) : undefined;
}

export function listRunning(): string[] {
  return [...running.keys()];
}
