// The single source of truth for mapping a saved profile to Clearcote Chromium switches.
//
// This module is a direct port of the clearcote Node SDK's `fingerprintArgs`
// (sdk/node/src/fingerprint.ts). The profile manager does NOT depend on the SDK — it spawns
// chrome.exe itself — so this file is where SDK parity is maintained by hand. When the SDK gains
// a switch, it is added here and nowhere else.
//
// Two callers consume it:
//   - electron/launcher.ts  — the real launch (encodes the captured profile, keeps secrets)
//   - src/types/profile.ts  — the renderer's read-only command-line PREVIEW (redacts secrets)
// They used to be two hand-maintained copies that silently drifted; the preview was the only one
// under test while the launcher was the one that actually launched. Keeping one builder with an
// options seam is what makes the launch path testable.
//
// Deliberately PURE: no `node:` imports, no fs, no process. That is what lets the Electron main
// process (CommonJS, rootDir electron/) and the Next renderer bundle both import it. Anything
// needing the filesystem (reading + gzipping a captured profile) is injected via `encodeProfile`.

// ---------------------------------------------------------------------------
// sha256 (FIPS 180-4), pure TS.
//
// Needed for the lightStealth seed->row mapping, which must produce the SAME row as the Node and
// Python SDKs for a given seed (they use a full sha256 digest as a big integer mod N). node:crypto
// is unavailable in the renderer, and SubtleCrypto is async, so a small synchronous implementation
// is the only way both callers can agree. tests/fpargs.test.ts pins it against node:crypto.
// ---------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** sha256 of a string's UTF-8 bytes, as lowercase hex. */
export function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  // Pad to a multiple of 64 bytes: 0x80, zeros, then the bit-length as a 64-bit big-endian int.
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  // Lengths here are far below 2^32 bits, so the high word is always 0.
  view.setUint32(padded.length - 4, bitLen >>> 0, false);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, "0");
  return out;
}

// ---------------------------------------------------------------------------
// lightStealth
// ---------------------------------------------------------------------------

// Coherent Windows-plausible desktop/laptop metadata bundles, indexed by a hash of the seed:
// [screen_w, screen_h, avail_w, avail_h, dpr, color_depth, device_memory_gb, hw_concurrency].
// lightStealth uses ONLY dpr/color_depth/device_memory/hw_concurrency from each row (screen stays
// real — a faked screen is a reliable block trigger). The screen columns are retained so an
// explicit opt-in screen spoof can reuse a coherent row. Mirrors the SDK table exactly.
const LIGHT_STEALTH_PROFILES: readonly (readonly [number, number, number, number, number, number, number, number])[] = [
  [1920, 1080, 1920, 1040, 1.0, 24, 8, 8],
  [1920, 1080, 1920, 1040, 1.0, 24, 16, 12],
  [1920, 1080, 1920, 1040, 1.0, 24, 16, 16],
  [2560, 1440, 2560, 1400, 1.0, 24, 16, 16],
  [2560, 1440, 2560, 1400, 1.5, 24, 16, 12],
  [1536, 864, 1536, 824, 1.25, 24, 8, 8],
  [1536, 864, 1536, 824, 1.25, 24, 16, 12],
  [1366, 768, 1366, 728, 1.0, 24, 8, 4],
  [1366, 768, 1366, 728, 1.0, 24, 4, 4],
  [1440, 900, 1440, 860, 1.0, 24, 8, 8],
  [1600, 900, 1600, 860, 1.0, 24, 8, 8],
  [1680, 1050, 1680, 1010, 1.0, 24, 8, 8],
  [1920, 1200, 1920, 1160, 1.0, 24, 16, 12],
  [3840, 2160, 3840, 2120, 1.0, 24, 32, 16],
];

export interface LightStealthValues {
  devicePixelRatio: number;
  colorDepth: number;
  deviceMemory: number;
  hardwareConcurrency: number;
  maxTouchPoints: number;
  brand: string;
}

/**
 * Deterministic, coherent metadata bundle for lightStealth, applied via the NATIVE override
 * switches only (never `--fingerprint`). Spoofs ONLY the axes that survive strict anti-bot checks.
 * Deliberately does NOT spoof screen/avail dimensions. The seed->row mapping matches both SDKs
 * (full sha256 digest as a big integer mod N).
 */
export function lightStealthValues(seed?: string | number): LightStealthValues {
  const key = seed === undefined || seed === null || String(seed) === "" ? "clearcote-light-stealth" : String(seed);
  const idx = Number(BigInt("0x" + sha256Hex(key)) % BigInt(LIGHT_STEALTH_PROFILES.length));
  const row = LIGHT_STEALTH_PROFILES[idx];
  return {
    devicePixelRatio: row[4],
    colorDepth: row[5],
    deviceMemory: row[6],
    hardwareConcurrency: row[7],
    maxTouchPoints: 0,
    brand: "chrome",
  };
}

// ---------------------------------------------------------------------------
// Accept-Language / locale / TLS helpers
// ---------------------------------------------------------------------------

/** Normalize an Accept-Language value for Chromium's `--accept-lang`: a plain comma-separated tag
 *  list with NO `;q=` weights or spaces. A `;` in the switch value trips a DCHECK and CRASHES the
 *  renderer, so this is a correctness guard, not cosmetics. */
export function cleanAcceptLanguage(v: string): string {
  return String(v)
    .split(",")
    .map((t) => t.split(";")[0].trim())
    .filter(Boolean)
    .join(",");
}

const LOCALE_TZ: Record<string, string> = {
  "en-US": "America/New_York", "en-CA": "America/Toronto", "en-GB": "Europe/London",
  "en-AU": "Australia/Sydney", "en-NZ": "Pacific/Auckland", "en-IE": "Europe/Dublin",
  "de-DE": "Europe/Berlin", "de-AT": "Europe/Vienna", "fr-FR": "Europe/Paris",
  "es-ES": "Europe/Madrid", "es-MX": "America/Mexico_City", "it-IT": "Europe/Rome",
  "nl-NL": "Europe/Amsterdam", "pt-BR": "America/Sao_Paulo", "pt-PT": "Europe/Lisbon",
  "pl-PL": "Europe/Warsaw", "sv-SE": "Europe/Stockholm", "ja-JP": "Asia/Tokyo",
  "ko-KR": "Asia/Seoul", "zh-CN": "Asia/Shanghai", "zh-TW": "Asia/Taipei",
  "ru-RU": "Europe/Moscow", "tr-TR": "Europe/Istanbul", "ar-SA": "Asia/Riyadh",
  "hi-IN": "Asia/Kolkata", "id-ID": "Asia/Jakarta",
};

/** A plausible IANA timezone for a primary Accept-Language tag, so the persona's timezone is
 *  coherent with its locale rather than leaking the host's (often UTC on servers/VMs). */
export function defaultTimezone(primaryLang: string): string | undefined {
  if (!primaryLang) return undefined;
  const tag = primaryLang.trim();
  if (LOCALE_TZ[tag]) return LOCALE_TZ[tag];
  const lang = tag.split("-")[0].toLowerCase();
  for (const [key, tz] of Object.entries(LOCALE_TZ)) {
    if (key.toLowerCase().startsWith(lang + "-")) return tz;
  }
  return "America/New_York";
}

/** Resolve `tlsProfile` to the concrete `--fingerprint-tls-profile` value the ENGINE accepts, or
 *  null (no switch → native TLS). The engine ignores the "match-persona"/"auto" abstraction, so it
 *  must be turned into `chrome-<brandVersion major>` here — else the switch is a silent no-op. */
export function resolveTls(tlsProfile?: string | number, brandVersion?: string): string | null {
  const v = String(tlsProfile ?? "").trim().toLowerCase();
  if (v === "native" || v === "off") return null;
  if (/^chrome-\d+$/.test(v)) return v;
  if (/^\d+$/.test(v)) return `chrome-${v}`;
  // "" | "match-persona" | "auto" → follow the persona's claimed Chrome major
  const head = (brandVersion ?? "").trim().split(".")[0];
  return /^\d+$/.test(head) ? `chrome-${head}` : null;
}

// ---------------------------------------------------------------------------
// Captured-profile screen guard
// ---------------------------------------------------------------------------

/** Minimum captured-profile screen that can plausibly contain a real browser window.
 *  A window needs its viewport plus chrome (~110px of tab strip + toolbar) to fit inside
 *  `screen`, and `availHeight` is smaller still. Profiles captured on smaller displays produce
 *  geometry no real machine can (window taller than the screen it sits on), which is exactly the
 *  kind of internal contradiction coherence checks look for. */
export const MIN_PROFILE_SCREEN_WIDTH = 1280;
export const MIN_PROFILE_SCREEN_HEIGHT = 890;

/** Returns a human-readable warning when a captured profile's screen is too small to hold a real
 *  window, or null when it is fine. Pure so both the import path and the UI can call it. */
export function screenGuardWarning(width?: number, height?: number): string | null {
  if (!width || !height) return null;
  if (width >= MIN_PROFILE_SCREEN_WIDTH && height >= MIN_PROFILE_SCREEN_HEIGHT) return null;
  return (
    `This profile was captured on a ${width}x${height} display, below the ${MIN_PROFILE_SCREEN_WIDTH}x${MIN_PROFILE_SCREEN_HEIGHT} ` +
    `needed to contain a normal browser window. The window would be larger than the screen it claims ` +
    `to be on — an impossible geometry that coherence checks flag. Prefer a larger capture, or set an ` +
    `explicit smaller window size.`
  );
}

/** The same guard applied to a curated-index screen label ("1920x1080"), so the library picker can
 *  warn before downloading a capture. Tolerant of a missing/odd label — unknown means no warning. */
export function screenWarningFromLabel(label?: string): string | null {
  const [w, h] = String(label ?? "").split("x").map((n) => Number(n) || 0);
  return screenGuardWarning(w, h);
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/** The fingerprint-relevant subset of a saved Profile. Structural, so both the electron-side
 *  `Profile` and the renderer-side `Profile` satisfy it without either importing the other. */
export interface FpInput {
  fingerprint: string;
  platform?: string;
  platformVersion?: string;
  brand?: string;
  brandVersion?: string;
  tlsProfile?: string;
  gpuVendor?: string;
  gpuRenderer?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  screenWidth?: number;
  screenHeight?: number;
  availWidth?: number;
  availHeight?: number;
  colorDepth?: number;
  devicePixelRatio?: number;
  maxTouchPoints?: number;
  lightStealth?: boolean;
  timezone?: string;
  acceptLanguage?: string;
  location?: string;
  webrtcIp?: string;
  webrtcMdns?: "on" | "off";
  disableGpuFingerprint?: boolean;
  fingerprintNoise?: boolean;
  storageQuota?: number;
  canvasBridgeUrl?: string;
  canvasBridgeAuth?: string;
  canvasBridgeMode?: "off" | "all" | "allow" | "deny";
  canvasBridgeAllow?: string[];
  canvasBridgeDeny?: string[];
  canvasBridgeFallback?: "block" | "local";
  fingerprintProfile?: string;
  extraArgs?: string[];
}

export interface FpArgsOptions {
  /** Host OS, used to default `--fingerprint-platform` so the persona is coherent with the binary
   *  actually running. The launcher passes the real one; callers that cannot know it get "windows". */
  hostPlatform?: "windows" | "linux" | "macos";
  /** Turn `fingerprintProfile` (a filename or path) into the `--fingerprint-profile` VALUE.
   *  Return null to omit the switch. The launcher reads + gzip+base64-encodes the file; the
   *  renderer preview returns a short placeholder. Omitted entirely => no switch. */
  encodeProfile?: (ref: string) => string | null;
  /** Redact secrets (canvas-bridge credentials) for display. */
  redactSecrets?: boolean;
  /** Best-effort Accept-Language recovered from the captured profile's navigator.languages, used
   *  when the profile itself sets none — so an imported identity keeps the donor's language order. */
  profileAcceptLanguage?: string;
}

/**
 * Build the Clearcote fingerprint switches for a profile, mirroring the SDK's `fingerprintArgs`.
 * Does NOT emit --proxy-server, --user-data-dir, or extraArgs — those differ between the real
 * launch (relay, resolved dir) and the preview, so the callers append them.
 */
export function fingerprintArgs(input: FpInput, opts: FpArgsOptions = {}): string[] {
  const args: string[] = [];
  const p: FpInput = { ...input }; // never mutate the caller's profile

  if (p.lightStealth) {
    // Fill in the coherent metadata bundle via native override switches. An explicit field on the
    // profile wins over the preset. CRITICAL: never emit --fingerprint, so the persona machinery /
    // farbling never engages; each value then takes the C++ flag > real path.
    const preset = lightStealthValues(p.fingerprint) as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(preset)) {
      const cur = (p as unknown as Record<string, unknown>)[k];
      if (cur === undefined || cur === null || cur === "") (p as unknown as Record<string, unknown>)[k] = v;
    }
    p.fingerprint = "";
  }

  const set = (flag: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== "") args.push(`--${flag}=${value}`);
  };

  set("fingerprint", p.fingerprint);
  // Default the persona platform to the HOST OS so it stays coherent with the binary running it.
  set("fingerprint-platform", p.platform ?? opts.hostPlatform ?? "windows");
  set("fingerprint-platform-version", p.platformVersion);
  // Clearcote presents as Google Chrome (its UA says "Chrome/<v>"); default the UA-CH brand to
  // "chrome" so navigator.userAgentData advertises "Google Chrome", not bare "Chromium" — a
  // UA/UA-CH mismatch some detectors flag.
  set("fingerprint-brand", p.brand ?? "chrome");
  set("fingerprint-brand-version", p.brandVersion);
  set("fingerprint-gpu-vendor", p.gpuVendor);
  set("fingerprint-gpu-renderer", p.gpuRenderer);
  set("fingerprint-hardware-concurrency", p.hardwareConcurrency);

  // Native metadata overrides (flag > persona > real). Read directly by the getters — no
  // --fingerprint persona machinery — so they are safe to spoof individually or via lightStealth.
  // Each is emitted EXACTLY ONCE: a command line carrying the same switch twice is a shape no real
  // browser produces, and the engine exposes its command line over CDP, so a duplicate is a free
  // tell. `set` compares strictly against undefined/null/"", so a numeric 0 is emitted rather than
  // dropped — that matters for maxTouchPoints, where 0 is a real value (a non-touch desktop).
  set("fingerprint-device-memory", p.deviceMemory);
  set("fingerprint-screen-width", p.screenWidth);
  set("fingerprint-screen-height", p.screenHeight);
  set("fingerprint-avail-width", p.availWidth);
  set("fingerprint-avail-height", p.availHeight);
  set("fingerprint-color-depth", p.colorDepth);
  set("fingerprint-device-pixel-ratio", p.devicePixelRatio);
  set("fingerprint-max-touch-points", p.maxTouchPoints);

  set("fingerprint-location", p.location);
  set("fingerprint-storage-quota", p.storageQuota);
  set("timezone", p.timezone);

  // Always send a coherent Accept-Language. Without --accept-lang Chromium falls back to the
  // build/OS locale, which can leak a language mismatching the proxy's country/timezone.
  const acceptLanguage = p.acceptLanguage || opts.profileAcceptLanguage || "en-US,en";
  const cleanLang = cleanAcceptLanguage(String(acceptLanguage));
  args.push(`--accept-lang=${cleanLang}`);
  // Pin the UI/ICU locale to the PRIMARY tag too, so Intl.DateTimeFormat / NumberFormat / Collator
  // (main thread AND workers) resolve to the same locale as navigator.language. Without --lang,
  // Chromium falls back to the build/OS locale — a locale-incoherence tell auditors flag.
  const primaryLang = cleanLang.split(",")[0];
  if (primaryLang) args.push(`--lang=${primaryLang}`);
  // Default the timezone to one coherent with the persona locale when none is set, so a run on a
  // UTC host doesn't leak that while navigator.language says e.g. en-US.
  if (!p.timezone) {
    const tz = defaultTimezone(primaryLang);
    if (tz) args.push(`--timezone=${tz}`);
  }

  set("webrtc-ip", p.webrtcIp);
  // Only "off" is meaningful — mDNS concealment ON is both the Chromium default and real Chrome's
  // behaviour, so there is nothing to emit for "on". This uses Chromium's OWN feature flag: the
  // responder is created behind kWebRtcHideLocalIpsWithMdns, so disabling the feature means no
  // responder is built and host candidates are signalled as raw IPs.
  if (p.webrtcMdns === "off") args.push("--disable-features=WebRtcHideLocalIpsWithMdns");

  if (p.disableGpuFingerprint) args.push("--disable-gpu-fingerprint");
  if (p.fingerprintNoise === false) args.push("--disable-fingerprint-noise");

  if (p.fingerprintProfile && opts.encodeProfile) {
    const encoded = opts.encodeProfile(p.fingerprintProfile);
    if (encoded) args.push(`--fingerprint-profile=${encoded}`);
  }

  // Canvas bridge: forward canvas/WebGL readbacks to a remote real-GPU host. Enabling it requires
  // --no-sandbox — the bridge opens its socket from the renderer process, which the sandbox blocks.
  if (p.canvasBridgeUrl) {
    args.push(`--canvas-bridge-url=${p.canvasBridgeUrl}`);
    if (p.canvasBridgeAuth)
      args.push(`--canvas-bridge-auth=${opts.redactSecrets ? "********" : p.canvasBridgeAuth}`);
    if (p.canvasBridgeMode) args.push(`--canvas-bridge-mode=${p.canvasBridgeMode}`);
    if (p.canvasBridgeAllow?.length) args.push(`--canvas-bridge-allow=${p.canvasBridgeAllow.join(",")}`);
    if (p.canvasBridgeDeny?.length) args.push(`--canvas-bridge-deny=${p.canvasBridgeDeny.join(",")}`);
    if (p.canvasBridgeFallback) args.push(`--canvas-bridge-fallback=${p.canvasBridgeFallback}`);
    if (!args.includes("--no-sandbox")) args.push("--no-sandbox");
  }

  const tls = resolveTls(p.tlsProfile, p.brandVersion);
  if (tls) args.push(`--fingerprint-tls-profile=${tls}`);

  // Android = mobile persona: give it a phone viewport. A later extraArgs --window-size wins
  // (Chromium takes the last occurrence).
  if (p.platform === "android" && !p.extraArgs?.some((x) => x.startsWith("--window-size")))
    args.push("--window-size=412,915");

  return args;
}
