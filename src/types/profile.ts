// The Clearcote Profile data model — the source of truth for a saved identity.
// One profile is persisted as profiles/<id>.json; its browser storage lives in
// profiles/<id>/userdata/. See PLAN.md and profiles/example.profile.json.

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
  /** --timezone (IANA, e.g. "America/New_York"). */
  timezone?: string;
  /** --accept-lang (e.g. "en-US,en"): navigator.languages + Accept-Language header. */
  acceptLanguage?: string;
  /** --fingerprint-location ("lat,lng"). */
  location?: string;
  /** --webrtc-ip: WebRTC reports this IP (fabricated srflx; no STUN leak). */
  webrtcIp?: string;
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
 *  or null (emit no switch → native TLS). Mirrors the SDK's resolve_tls_profile: the engine only
 *  understands `chrome-<major>` (and treats "match-persona"/"auto"/"native"/"off" as NO override),
 *  so "match-persona" (the default) must be turned into `chrome-<brandVersion-major>` here — else
 *  the switch is a silent no-op. Pure.
 *   - "native" / "off"            → null (build's native TLS)
 *   - "chrome-<major>" / a number → pinned to that major
 *   - "match-persona"/"auto"/unset→ follow brandVersion's major, or null if no brandVersion */
export function resolveTlsProfile(p: Profile): string | null {
  const v = (p.tlsProfile ?? "").trim().toLowerCase();
  if (v === "native" || v === "off") return null;
  if (v.startsWith("chrome-") && /^\d+$/.test(v.slice(7))) return v;
  if (/^\d+$/.test(v)) return `chrome-${v}`;
  // "" | "match-persona" | "auto" → follow the persona's claimed Chrome major (from brandVersion)
  const head = (p.brandVersion ?? "").trim().split(".")[0];
  return /^\d+$/.test(head) ? `chrome-${head}` : null;
}

/** Build the chrome.exe argument list for a profile. (Reference for the launcher; the
 *  main process resolves geoip + the user-data-dir before calling this. The captured
 *  fingerprint profile is shown as a placeholder here — the launcher gzip+base64-encodes
 *  the actual file contents.) */
export function profileToArgs(p: Profile): string[] {
  const args: string[] = [`--fingerprint=${p.fingerprint}`];
  if (p.platform) args.push(`--fingerprint-platform=${p.platform}`);
  if (p.platformVersion) args.push(`--fingerprint-platform-version=${p.platformVersion}`);
  if (p.brand) args.push(`--fingerprint-brand=${p.brand}`);
  if (p.brandVersion) args.push(`--fingerprint-brand-version=${p.brandVersion}`);
  const tls = resolveTlsProfile(p); // "match-persona" -> chrome-<brandVersion major> (engine needs a concrete value)
  if (tls) args.push(`--fingerprint-tls-profile=${tls}`);
  if (p.platform === "android") args.push("--window-size=412,915"); // mobile viewport (a later extraArgs --window-size overrides)
  if (p.gpuVendor) args.push(`--fingerprint-gpu-vendor=${p.gpuVendor}`);
  if (p.gpuRenderer) args.push(`--fingerprint-gpu-renderer=${p.gpuRenderer}`);
  if (p.hardwareConcurrency != null)
    args.push(`--fingerprint-hardware-concurrency=${p.hardwareConcurrency}`);
  if (p.timezone) args.push(`--timezone=${p.timezone}`);
  if (p.acceptLanguage) args.push(`--accept-lang=${p.acceptLanguage}`);
  if (p.location) args.push(`--fingerprint-location=${p.location}`);
  if (p.webrtcIp) args.push(`--webrtc-ip=${p.webrtcIp}`);
  if (p.storageQuota != null) args.push(`--fingerprint-storage-quota=${p.storageQuota}`);
  if (p.disableGpuFingerprint) args.push("--disable-gpu-fingerprint");
  if (p.fingerprintNoise === false) args.push("--disable-fingerprint-noise");
  if (p.canvasBridgeUrl) args.push(`--canvas-bridge-url=${p.canvasBridgeUrl}`);
  if (p.canvasBridgeAuth) args.push("--canvas-bridge-auth=********"); // secret redacted in preview
  if (p.fingerprintProfile)
    args.push(`--fingerprint-profile=<gzip+base64 of ${p.fingerprintProfileMeta?.label || p.fingerprintProfile}>`);
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
