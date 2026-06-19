// The Clearcote Profile data model — the source of truth for a saved identity.
// One profile is persisted as profiles/<id>.json; its browser storage lives in
// profiles/<id>/userdata/. See PLAN.md and profiles/example.profile.json.

export type Platform = "windows" | "linux" | "macos";
export type Brand = "Chrome" | "Edge" | "Opera" | "Vivaldi";

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
  /** --fingerprint-platform */
  platform?: Platform;
  /** --fingerprint-brand */
  brand?: Brand;
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

/** Build the chrome.exe argument list for a profile. (Reference for the launcher; the
 *  main process resolves geoip + the user-data-dir before calling this. The captured
 *  fingerprint profile is shown as a placeholder here — the launcher gzip+base64-encodes
 *  the actual file contents.) */
export function profileToArgs(p: Profile): string[] {
  const args: string[] = [`--fingerprint=${p.fingerprint}`];
  if (p.platform) args.push(`--fingerprint-platform=${p.platform}`);
  if (p.brand) args.push(`--fingerprint-brand=${p.brand}`);
  if (p.gpuVendor) args.push(`--fingerprint-gpu-vendor=${p.gpuVendor}`);
  if (p.gpuRenderer) args.push(`--fingerprint-gpu-renderer=${p.gpuRenderer}`);
  if (p.hardwareConcurrency != null)
    args.push(`--fingerprint-hardware-concurrency=${p.hardwareConcurrency}`);
  if (p.timezone) args.push(`--timezone=${p.timezone}`);
  if (p.acceptLanguage) args.push(`--accept-lang=${p.acceptLanguage}`);
  if (p.location) args.push(`--fingerprint-location=${p.location}`);
  if (p.webrtcIp) args.push(`--webrtc-ip=${p.webrtcIp}`);
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
