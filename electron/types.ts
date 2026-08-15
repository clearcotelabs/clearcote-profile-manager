// Electron-side types. Kept self-contained (decoupled from the renderer's
// src/types/profile.ts) so the electron build has no cross-rootDir imports.
// The two shapes are intentionally identical — see PLAN.md.

export interface Profile {
  id: string;
  name: string;
  notes?: string;
  tags?: string[];
  group?: string;
  fingerprint: string;
  /** Browser build to launch: "latest" (default — newest of your tier: Pro→150, free→149),
   *  a major ("150" / "149"), an exact version ("150.0.7871.114"), or a REVISION-pinned PRO build
   *  ("150.0.7871.114-r10", or just "r10"). PRO builds need a license key; resolved against the
   *  public /api/v1/versions catalog. Explicit binaries in Settings win.
   *
   *  Pin a revision for reproducible runs: "latest" and a bare major both follow the current PRO
   *  pin, which moves under you when a rebuild ships. */
  browserVersion?: string;
  platform?: string;
  platformVersion?: string;
  brand?: string;
  brandVersion?: string;
  /** --fingerprint-tls-profile: "match-persona" (default, follows brandVersion) | "native" |
   *  "chrome-<major>". Resolved to a concrete chrome-<major> in the launcher (the engine ignores
   *  the "match-persona" abstraction). */
  tlsProfile?: string;
  gpuVendor?: string;
  gpuRenderer?: string;
  hardwareConcurrency?: number;

  // ---- native metadata overrides (flag > persona > real; safe to spoof individually) ----
  /** --fingerprint-device-memory: navigator.deviceMemory in GB (spec-clamps to 8). */
  deviceMemory?: number;
  /** --fingerprint-screen-width. NOTE: spoofing screen dimensions is a reliable block trigger on
   *  strict anti-bots (a faked screen can't be reconciled with the real render surface), so it is
   *  opt-in and NOT part of lightStealth. Best when the host's real display matches. */
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
  /** --fingerprint-max-touch-points (0 on a mouse-only desktop; 0 is a real value, not "unset"). */
  maxTouchPoints?: number;
  /** Light-stealth preset: spoof a coherent, seed-derived bundle of the metadata axes that survive
   *  strict anti-bot checks (hardwareConcurrency, deviceMemory, colorDepth, devicePixelRatio,
   *  maxTouchPoints) via the NATIVE override switches only — and deliberately emit NO --fingerprint,
   *  so the persona machinery / farbling never engages. Rendering, TLS and the real Chrome version
   *  are untouched. An explicit field wins over the preset. */
  lightStealth?: boolean;

  timezone?: string;
  acceptLanguage?: string;
  location?: string;
  webrtcIp?: string;
  /** WebRTC host-candidate mDNS concealment. Real Chrome hides local host candidates behind an
   *  `<uuid>.local` name; that is the default here too, so only "off" emits anything (Chromium's
   *  own kWebRtcHideLocalIpsWithMdns feature flag). "off" re-exposes the LAN IP to every page. */
  webrtcMdns?: "on" | "off";
  geoip?: boolean;
  /** --disable-gpu-fingerprint: report the host's real GPU instead of a spoofed one. */
  disableGpuFingerprint?: boolean;
  /** Per-eTLD+1 farbling noise; default on. false → --disable-fingerprint-noise. */
  fingerprintNoise?: boolean;
  /** false → --disable-gpu-string-spoof: report the REAL WebGL vendor/renderer and change nothing
   *  else. The GPU-string half of disableGpuFingerprint, for a host that rasterises in software.
   *  Note navigator.gpu still follows the wide flag. Inert before 150 r12. */
  gpuStringSpoof?: boolean;
  /** false → --disable-canvas-noise: unfarble 2D canvas readback (getImageData, toDataURL) only,
   *  leaving WebGL readPixels and every other surface noised. Inert before 150 r12. */
  canvasNoise?: boolean;
  /** --fingerprint-storage-quota in MB (navigator.storage.estimate().quota). */
  storageQuota?: number;
  /** --canvas-bridge-url: forward canvas/WebGL to a remote real-GPU host (ws://host:port/path). */
  canvasBridgeUrl?: string;
  /** --canvas-bridge-auth: bridge HTTP Basic credentials, "user:secret". */
  canvasBridgeAuth?: string;
  /** --canvas-bridge-mode: per-origin policy. Restrict bridging to the origins where canvas
   *  coherence is actually scored — every bridged readback is a network round-trip on the
   *  renderer thread, which is itself a timing signal. */
  canvasBridgeMode?: "off" | "all" | "allow" | "deny";
  /** --canvas-bridge-allow: eTLD+1 list bridged when mode="allow". */
  canvasBridgeAllow?: string[];
  /** --canvas-bridge-deny: eTLD+1 list NOT bridged when mode="deny". */
  canvasBridgeDeny?: string[];
  /** --canvas-bridge-fallback: cold cache-miss behaviour. "block" (default) stalls for the
   *  bridge; "local" never stalls and renders locally instead. */
  canvasBridgeFallback?: "block" | "local";
  /** Filename (in the fingerprints dir) or absolute path of a captured clearcote-profile to load
   *  via --fingerprint-profile. When set, its fields override the seed-derived persona. */
  fingerprintProfile?: string;
  /** Cached summary of the captured profile, for display. */
  fingerprintProfileMeta?: FingerprintMeta;
  /** Keep the cookie encryption key WITH the profile so the folder is portable between machines
   *  (--portable-profile). Cookies are otherwise sealed with an OS-held, machine-bound key, so a
   *  copied profile loses every session. The cookie DB is then effectively unencrypted at rest.
   *  Needs engine 151 r14+. Ignored when `encryptionKey` is set. */
  portableProfile?: boolean;
  /** --profile-encryption-key: supply the cookie encryption key yourself, so no key material is
   *  written to disk at all. The stronger form of `portableProfile`; wins when both are set. */
  encryptionKey?: string;
  /** Fetch Google's Widevine CDM and seed it into this profile, so EME/DRM works and the browser
   *  stops contradicting its own "Google Chrome" brand (Google's build ships the CDM; this
   *  open-source one cannot bundle it). Downloaded once from Google's component server, SHA-256
   *  verified, then shared by every profile that opts in. */
  widevine?: boolean;
  /** CLEARCOTE_SHADER_DIALECT: re-translate shaders to HLSL for getTranslatedShaderSource() so a
   *  Windows persona on a LINUX host does not answer with the Vulkan backend's SPIR-V while
   *  claiming a Direct3D11 renderer. Off unless asked for; needs engine 151 r15+. */
  shaderDialect?: "hlsl";
  /** Proxy as a single string: "scheme://user:pass@host:port" (auth optional), e.g.
   *  "http://user:pass@host:8080" or "socks5://user:pass@host:1080". Authenticated http/https
   *  proxies are served to the browser via a local auth-injecting relay; authenticated SOCKS5 goes
   *  to the engine's own --socks5-credentials (151 r14+). See electron/proxy.ts. */
  proxy?: string;
  extraArgs?: string[];
  createdAt: string;
  updatedAt: string;
  lastLaunchedAt?: string;
  userDataDir?: string;
}

export interface FingerprintMeta {
  label?: string;
  renderer?: string;
  cores?: number;
  memory?: number;
  screen?: string;
  screenWidth?: number;
  screenHeight?: number;
  /** Set when the captured display is too small to contain a real browser window — the window
   *  would be larger than the screen it claims to sit on, an impossible geometry. See
   *  screenGuardWarning() in electron/fpargs.ts. */
  screenWarning?: string;
  source?: "file" | "library";
}

export interface FpImportResult {
  ok: boolean;
  file?: string;
  meta?: FingerprintMeta;
  error?: string;
}

export interface LibraryProfile {
  name: string;
  downloadUrl: string;
  /** Set when the indexed screen size is below the guard floor — lets the picker warn (or filter)
   *  BEFORE downloading a capture that would produce impossible window geometry. */
  screenWarning?: string;
  /** From the curated clearcote-profiles index.json (when available) — pick one whose GPU vendor
   *  matches your host so the imported GPU stays coherent with the host's real render. */
  gpuVendor?: string;
  gpuFamily?: string;
  renderer?: string;
  screen?: string;
}

export interface FpListResult {
  ok: boolean;
  profiles?: LibraryProfile[];
  error?: string;
}

export interface Settings {
  binaryPath?: string;
  theme?: "dark" | "light";
  /** PRO license key (`cc_lic_...`). When set, launches use the license-gated PRO
   *  browser (auto-downloaded) + check out a floating-concurrency slot. Empty =
   *  free mode (no backend contact, free binary). */
  licenseKey?: string;
  /** Override the license backend base URL (default clearcotelabs.com). */
  licenseApiBase?: string;
}

export interface LaunchResult {
  ok: boolean;
  pid?: number;
  error?: string;
  /** True when this launch used the PRO (license-gated) binary + a leased run-token. */
  pro?: boolean;
  /** Non-fatal problems with an otherwise successful launch — an option that will silently do
   *  nothing (a switch the resolved build predates), or geoip failing to resolve. */
  warnings?: string[];
}

/** Streamed to the renderer while a launch downloads the browser build (first use of a version).
 *  `id` is the profile being launched; `pct` 0–100; sizes in MB. Not emitted for a cached build. */
export interface DownloadProgress {
  id: string;
  version: string;
  pct: number;
  seenMB: number;
  totalMB: number;
}

export interface LicenseStatus {
  ok: boolean;
  plan?: string;
  used?: number;
  limit?: number;
  error?: string;
  code?: string;
}

export interface GeoResult {
  ok: boolean;
  ip?: string;
  country?: string;
  countryCode?: string;
  timezone?: string;
  lat?: number;
  lon?: number;
  acceptLanguage?: string;
  error?: string;
}

export interface ExportResult {
  ok: boolean;
  path?: string;
  count?: number;
}

export interface ImportResult {
  ok: boolean;
  count?: number;
  error?: string;
}
