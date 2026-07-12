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
   *  a major ("150" / "149"), or an exact version ("150.0.7871.114"). PRO builds need a license
   *  key; resolved against the public /api/v1/versions catalog. Explicit binaries in Settings win. */
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
  timezone?: string;
  acceptLanguage?: string;
  location?: string;
  webrtcIp?: string;
  geoip?: boolean;
  /** --disable-gpu-fingerprint: report the host's real GPU instead of a spoofed one. */
  disableGpuFingerprint?: boolean;
  /** Per-eTLD+1 farbling noise; default on. false → --disable-fingerprint-noise. */
  fingerprintNoise?: boolean;
  /** --fingerprint-storage-quota in MB (navigator.storage.estimate().quota). */
  storageQuota?: number;
  /** --canvas-bridge-url: forward canvas/WebGL to a remote real-GPU host (ws://host:port/path). */
  canvasBridgeUrl?: string;
  /** --canvas-bridge-auth: bridge HTTP Basic credentials, "user:secret". */
  canvasBridgeAuth?: string;
  /** Filename (in the fingerprints dir) or absolute path of a captured clearcote-profile to load
   *  via --fingerprint-profile. When set, its fields override the seed-derived persona. */
  fingerprintProfile?: string;
  /** Cached summary of the captured profile, for display. */
  fingerprintProfileMeta?: FingerprintMeta;
  /** Proxy as a single string: "scheme://user:pass@host:port" (auth optional), e.g.
   *  "http://user:pass@host:8080" or "socks5://host:1080". Authenticated http/https proxies are
   *  served to the browser via a local auth-injecting relay (see electron/proxy.ts). */
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
