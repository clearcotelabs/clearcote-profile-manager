// The Clearcote Profile data model — the source of truth for a saved identity.
// One profile is persisted as profiles/<id>.json; its browser storage lives in
// profiles/<id>/userdata/. See PLAN.md and profiles/example.profile.json.

import { fingerprintArgs, resolveTls, type FpInput } from "../../electron/fpargs";

export {
  screenGuardWarning,
  screenWarningFromLabel,
  MIN_PROFILE_SCREEN_WIDTH,
  MIN_PROFILE_SCREEN_HEIGHT,
} from "../../electron/fpargs";

export type Platform = "windows" | "linux" | "macos" | "android";
export type Brand = "Chrome" | "Edge" | "Opera" | "Vivaldi";
/** TLS network persona — how the ClientHello follows the persona's claimed Chrome version.
 *  "match-persona" (default) follows brandVersion; "native"/"off" keeps the build's native TLS;
 *  "chrome-<major>" pins it. */
export type TlsProfile = "match-persona" | "native" | "off" | (string & {});

/** A saved Clearcote browser identity. */
export interface Profile {
  /** Stable id / slug; also names the on-disk folder profiles/<id>/. */
  id: string;
  /** Human label shown in the UI. */
  name: string;
  notes?: string;
  tags?: string[];
  /** Optional grouping/folder label. */
  group?: string;

  // ---- Clearcote identity (maps to engine switches) ----
  /** --fingerprint seed (int or string). Drives the coherent persona. Same seed ⇒ same identity. */
  fingerprint: string;
  /** Browser build to launch: "latest" (default — newest of your tier: Pro→150, free→149), a
   *  major ("150" / "149"), an exact version, or a REVISION-pinned PRO rebuild
   *  ("150.0.7871.114-r10", or just "r10" for the newest PRO build at that revision).
   *  PRO builds need a license key. Resolved against the public /api/v1/versions catalog; an
   *  explicit binary in Settings always wins.
   *
   *  Pin a revision when you need reproducible runs: "latest" and a bare major both track the
   *  current PRO pin, which moves when a rebuild ships. */
  browserVersion?: string;
  /** --fingerprint-platform. "android" is a best-effort MOBILE persona (mobile UA/UA-CH, touch,
   *  mobile viewport, portrait, no PDF plugin, Mali/Adreno GPU); the launcher also sets a phone
   *  window size for it. */
  platform?: Platform;
  /** --fingerprint-platform-version (UA-CH high-entropy OS version). */
  platformVersion?: string;
  /** --fingerprint-brand */
  brand?: Brand;
  /** --fingerprint-brand-version */
  brandVersion?: string;
  /** --fingerprint-tls-profile: keep the TLS ClientHello coherent with the persona's claimed
   *  Chrome version. Unset = "match-persona" (follows brandVersion). "native"/"off" = build's
   *  native TLS; "chrome-<major>" pins it. Chromium-core (Chrome/Edge/Brave/Opera share the TLS). */
  tlsProfile?: TlsProfile;
  /** --fingerprint-gpu-vendor (advanced; the persona already picks a coherent GPU). */
  gpuVendor?: string;
  /** --fingerprint-gpu-renderer */
  gpuRenderer?: string;
  /** --fingerprint-hardware-concurrency */
  hardwareConcurrency?: number;

  // ---- native metadata overrides (flag > persona > real; read directly by the getters, with no
  // --fingerprint persona machinery, so they are safe to spoof individually) ----
  /** --fingerprint-device-memory: navigator.deviceMemory in GB (spec-clamps to 8). */
  deviceMemory?: number;
  /** --fingerprint-screen-width. Spoofing screen dimensions is a reliable block trigger on strict
   *  anti-bots (a faked screen can't be reconciled with the real render surface) — opt-in only,
   *  and deliberately NOT part of lightStealth. */
  screenWidth?: number;
  /** --fingerprint-screen-height (see the caveat on screenWidth). */
  screenHeight?: number;
  /** --fingerprint-avail-width (see the caveat on screenWidth). */
  availWidth?: number;
  /** --fingerprint-avail-height (see the caveat on screenWidth). */
  availHeight?: number;
  /** --fingerprint-color-depth (e.g. 24). */
  colorDepth?: number;
  /** --fingerprint-device-pixel-ratio (e.g. 1, 1.25, 1.5). */
  devicePixelRatio?: number;
  /** --fingerprint-max-touch-points (0 on a mouse-only desktop — 0 is a real value, not "unset"). */
  maxTouchPoints?: number;
  /** Light-stealth preset: a coherent, seed-derived bundle of the metadata axes that SURVIVE strict
   *  anti-bot checks, applied via the native override switches only — and emitting NO --fingerprint,
   *  so the persona machinery / farbling never engages. Rendering, TLS and the real Chrome version
   *  stay untouched. Screen dimensions are deliberately not spoofed. An explicit field wins. */
  lightStealth?: boolean;

  /** --timezone (IANA, e.g. "America/New_York"). Unset derives one coherent with the locale rather
   *  than leaking the host's (often UTC). */
  timezone?: string;
  /** --accept-lang (e.g. "en-US,en"): navigator.languages + Accept-Language header. */
  acceptLanguage?: string;
  /** --fingerprint-location ("lat,lng"). */
  location?: string;
  /** --webrtc-ip: WebRTC reports this IP (fabricated srflx; no STUN leak). */
  webrtcIp?: string;
  /** WebRTC host-candidate mDNS concealment. Real Chrome hides local host candidates behind an
   *  `<uuid>.local` name, and so does Clearcote by default — so only "off" emits anything
   *  (Chromium's own kWebRtcHideLocalIpsWithMdns flag). "off" re-exposes the LAN IP to every page;
   *  set it only when you need routable raw host candidates. */
  webrtcMdns?: "on" | "off";
  /** When true (and a proxy is set), resolve the proxy exit IP and auto-fill any unset
   *  timezone / acceptLanguage / location / webrtcIp via the SDK's resolveGeo(). */
  geoip?: boolean;

  // ---- advanced stealth ----
  /** --disable-gpu-fingerprint: report the host's REAL GPU/WebGL instead of a spoofed one. The
   *  most coherent option when the persona/profile GPU can't match the host's actual render. */
  disableGpuFingerprint?: boolean;
  /** Per-eTLD+1 farbling noise (canvas/WebGL/audio/client-rects). Default ON. Set false to emit
   *  --disable-fingerprint-noise — natural, unperturbed surfaces that read as untampered to strict
   *  ML detectors (pair with a captured profile). Identity spoofs (UA/screen/GPU/persona) stay on. */
  fingerprintNoise?: boolean;
  /** --fingerprint-storage-quota in MEGABYTES (navigator.storage.estimate().quota). A tiny value
   *  reads as incognito / a test machine; set a realistic on-disk value (e.g. 250000 ≈ 244 GB). */
  storageQuota?: number;

  // ---- canvas bridge (advanced; needs a real-GPU bridge host) ----
  /** --canvas-bridge-url: forward canvas/WebGL rendering to a remote real-GPU host
   *  ("ws://host:port/path") so the pixel readback matches the claimed GPU. Unset = render locally. */
  canvasBridgeUrl?: string;
  /** --canvas-bridge-auth: bridge HTTP Basic credentials, "user:secret". */
  canvasBridgeAuth?: string;
  /** --canvas-bridge-mode: per-origin policy. Every bridged readback is a network round-trip on
   *  the renderer thread (itself a timing signal), so restrict bridging to the origins that
   *  actually score canvas coherence. */
  canvasBridgeMode?: "off" | "all" | "allow" | "deny";
  /** --canvas-bridge-allow: eTLD+1 list bridged when mode="allow". */
  canvasBridgeAllow?: string[];
  /** --canvas-bridge-deny: eTLD+1 list NOT bridged when mode="deny". */
  canvasBridgeDeny?: string[];
  /** --canvas-bridge-fallback: cold cache-miss behaviour — "block" (default) stalls for the
   *  bridge, "local" never stalls and renders locally. */
  canvasBridgeFallback?: "block" | "local";

  // ---- captured fingerprint (clearcote-profiles) ----
  /** Filename (in the app's fingerprints dir) or absolute path of a captured real-machine
   *  profile to load via --fingerprint-profile. Its fields override the seed-derived persona;
   *  absent fields fall back to the --fingerprint seed. Import one or pick from the library. */
  fingerprintProfile?: string;
  /** Cached summary of the captured profile, for display in the UI. */
  fingerprintProfileMeta?: FingerprintMeta;

  // ---- network ----
  /** Proxy as a single string: "scheme://user:pass@host:port" (auth optional), e.g.
   *  "http://user:pass@host:8080" or "socks5://host:1080". */
  proxy?: string;

  // ---- launch ----
  /** Extra raw chrome flags appended verbatim. */
  extraArgs?: string[];

  // ---- bookkeeping ----
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  lastLaunchedAt?: string; // ISO 8601
  /** Resolved persistent user-data-dir (default: profiles/<id>/userdata). */
  userDataDir?: string;
}

/** Summary of a captured fingerprint profile, cached on the Profile for display. */
export interface FingerprintMeta {
  label?: string;
  renderer?: string;
  cores?: number;
  memory?: number;
  screen?: string;
  screenWidth?: number;
  screenHeight?: number;
  /** Set when the captured display is too small to contain a real browser window — the window
   *  would be larger than the screen it claims to sit on, which no real machine can produce.
   *  Computed by screenGuardWarning() (re-exported above). */
  screenWarning?: string;
  source?: "file" | "library";
}

/** Normalize a profile's proxy to a single string (accepts the legacy {server,username,password}
 *  object so old saved profiles still display/edit). Pure — usable in the renderer. */
export function proxyString(p: unknown): string {
  if (!p) return "";
  if (typeof p === "string") return p;
  const o = p as { server?: string; username?: string; password?: string };
  if (!o.server) return "";
  try {
    const u = new URL(/:\/\//.test(o.server) ? o.server : `http://${o.server}`);
    if (o.username) u.username = o.username;
    if (o.password) u.password = o.password;
    return u.toString();
  } catch {
    return o.server || "";
  }
}

/** A proxy string with the password removed (for export / display). Pure. */
export function redactProxyString(p: unknown): string {
  const s = proxyString(p);
  if (!s) return "";
  try {
    const u = new URL(/:\/\//.test(s) ? s : `http://${s}`);
    u.password = "";
    return u.toString();
  } catch {
    return s;
  }
}

/** Resolve `tlsProfile` to the concrete `--fingerprint-tls-profile` value the ENGINE accepts,
 *  or null (emit no switch → native TLS). Thin wrapper over the shared resolver so callers can
 *  keep passing a whole Profile. */
export function resolveTlsProfile(p: Profile): string | null {
  return resolveTls(p.tlsProfile, p.brandVersion);
}

/**
 * The chrome.exe command line a profile WOULD produce, for display in the UI.
 *
 * The fingerprint switches come from the same shared builder the real launcher uses
 * (electron/fpargs.ts), so what the user sees here is what actually gets spawned. Only the
 * deliberately-different bits are local: secrets are redacted, and the captured fingerprint
 * profile shows a human-readable placeholder instead of ~50 KB of gzip+base64.
 *
 * Two things the preview cannot know and the launcher can: the real host OS (used to default
 * `--fingerprint-platform`) and the donor languages inside a captured profile. Both are cosmetic
 * here; the launcher supplies the real values.
 */
export function profileToArgs(p: Profile): string[] {
  const args = fingerprintArgs(p as FpInput, {
    redactSecrets: true,
    encodeProfile: (ref) => `<gzip+base64 of ${p.fingerprintProfileMeta?.label || ref}>`,
  });
  const proxy = proxyString(p.proxy);
  if (proxy) {
    try {
      const u = new URL(/:\/\//.test(proxy) ? proxy : `http://${proxy}`);
      // creds stripped in the preview; the launcher injects them via a local relay if present
      args.push(`--proxy-server=${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}`);
    } catch {
      /* ignore */
    }
  }
  if (p.userDataDir) args.push(`--user-data-dir=${p.userDataDir}`);
  if (p.extraArgs?.length) args.push(...p.extraArgs);
  return args;
}
