// Coherence rules — the contradictions a page can read off a profile.
//
// WHY THIS EXISTS. The app already knew about several of these and mentioned each one beside its
// own field, where you saw it only if you happened to scroll there. That left the question this
// product exists to answer — is this identity self-consistent? — with no single place that answers
// it. Collecting them here turns scattered footnotes into a checkable list, and lets the editor
// deep-link from an issue to the field that caused it.
//
// A rule earns its place by being TRUE, decidable from the profile alone, and actionable. Anything
// needing a network round-trip (does the timezone match the proxy's real exit?) belongs to the geo
// resolve button, not here — a rule that cannot decide would cry wolf on every profile.
//
// PURE: no React, no `node:` imports. The editor renders these live; tests exercise them directly.

import { isAuthenticatedSocks, parseProxy } from "../../electron/proxyargs";

export type Severity = "error" | "warn";

export interface Issue {
  /** Stable id, so a rule can be suppressed or tested by name. */
  id: string;
  severity: Severity;
  /** The field key to navigate to. Must exist in src/lib/fields.ts. */
  field: string;
  /** One sentence, in the user's terms, naming the contradiction. */
  message: string;
  /** What to do about it. */
  fix: string;
}

export interface CoherenceContext {
  /** Resolved browser major for the profile's selected version, when known. Undefined for an
   *  explicit binary or an unresolved catalog — version-gated rules then stay quiet rather than
   *  guessing, exactly as the launcher does. */
  major?: number;
  /** The OS actually running the binary. */
  hostPlatform?: "windows" | "linux" | "macos";
  /** Warning text from the captured profile's screen guard, when the import flagged one. */
  capturedScreenWarning?: string;
}

/** Engine major that implements --socks5-credentials and --portable-profile (r14) and the shader
 *  dialect (r15). Kept here so the rules read declaratively; mirrors electron/proxyargs.ts. */
export const MIN_MAJOR_151 = 151;

/** MEASURED on 151 r16, so no rule guards it: the engine enforces Chromium's own deviceMemory
 *  rules itself. Asked for 1 it reports 2, for 6 it reports 4, and for 64 or 128 it reports 32 --
 *  power-of-two quantization plus the desktop [2, 32] clamp (Android [1, 8]). A value outside the
 *  range is corrected rather than leaked, so flagging one here would tell the user a profile is
 *  broken when the browser handles it. The editor still offers a closed list, to save anyone the
 *  confusion of typing 64 and reading 32. */

const isSet = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0);

/** True when this profile claims the Google Chrome brand — including by leaving it unset, since
 *  the launcher defaults the brand to Chrome. */
function claimsChrome(brand: unknown): boolean {
  const b = String(brand ?? "Chrome").trim().toLowerCase();
  return b === "chrome" || b === "google chrome";
}

/**
 * Every contradiction on this profile, worst first.
 *
 * `profile` is loose on purpose: the editor passes its in-progress draft, which may hold partial
 * values mid-edit, and tests pass fragments.
 */
export function coherenceIssues(
  profile: Record<string, unknown>,
  ctx: CoherenceContext = {},
): Issue[] {
  const out: Issue[] = [];
  const proxy = parseProxy(profile.proxy);

  // ── The Google Chrome brand commits you to Google's CDM ────────────────────
  // Google's branded build ships Widevine on both desktop platforms, so a browser asserting that
  // brand, implementing EME, and then rejecting com.widevine.alpha describes a browser Google does
  // not make. One property lookup, no reference data needed.
  if (claimsChrome(profile.brand) && !profile.widevine) {
    out.push({
      id: "chrome-brand-without-widevine",
      severity: "error",
      field: "widevine",
      message:
        'This profile reports the "Google Chrome" brand but seeds no Widevine CDM, which Google\'s build always ships.',
      fix: "Enable Widevine (DRM) in Session, or set the brand to Chromium — which is what this build honestly is.",
    });
  }

  // ── An authenticated SOCKS5 proxy needs the engine that can authenticate ───
  // Stock Chromium cannot do RFC 1929 at all; the engine gained it in 151 r14. On an older build
  // the credentials cannot be carried and every connection is refused, which looks like a bad proxy.
  if (proxy && isAuthenticatedSocks(proxy) && ctx.major !== undefined && ctx.major < MIN_MAJOR_151) {
    out.push({
      id: "socks5-auth-needs-151",
      severity: "error",
      field: "browserVersion",
      message: `An authenticated SOCKS5 proxy needs Clearcote ${MIN_MAJOR_151} (r14+); build ${ctx.major} cannot authenticate to one and will fail to load pages.`,
      fix: `Set the browser version to ${MIN_MAJOR_151}, or use an http/https proxy instead.`,
    });
  }

  // ── A proxy moves the IP, not the position ────────────────────────────────
  if (proxy && !profile.geoip && !isSet(profile.location)) {
    out.push({
      id: "proxy-without-geolocation",
      severity: "warn",
      field: "geoip",
      message:
        "A proxy is set but no geolocation is — the Geolocation API will report this machine's real position, not the proxy's region.",
      fix: "Turn on geoip to fill it from the proxy's exit region at launch, or set a geolocation by hand.",
    });
  }

  // ── A hand-spoofed screen cannot be reconciled with the real window ───────
  const screenSpoofed = isSet(profile.screenWidth) || isSet(profile.screenHeight);
  if (screenSpoofed && !isSet(profile.fingerprintProfile)) {
    out.push({
      id: "screen-spoofed-by-hand",
      severity: "warn",
      field: "screenWidth",
      message:
        "Screen dimensions are spoofed by hand. A faked screen cannot be reconciled with the real window and render surface, which strict anti-bots check.",
      fix: "Set it only when it matches this host's real display, or adopt a captured fingerprint and let it carry the screen.",
    });
  }

  // ── A capture taken on a display too small to hold a browser window ───────
  if (ctx.capturedScreenWarning) {
    out.push({
      id: "captured-screen-too-small",
      severity: "warn",
      field: "fingerprintProfile",
      message:
        "This capture was taken on a display too small to contain a normal browser window, so the window would be larger than the screen it claims to sit on.",
      fix: "Pick a capture from a larger display, or set an explicit smaller window size.",
    });
  }

  // ── The bridge renders elsewhere; the real-GPU switch reports here ────────
  if (isSet(profile.canvasBridgeUrl) && profile.disableGpuFingerprint) {
    out.push({
      id: "bridge-vs-real-gpu",
      severity: "warn",
      field: "disableGpuFingerprint",
      message:
        "The canvas bridge and the real-GPU switch are both on: pixels come from the remote host while the GPU strings come from this one, so they describe different machines.",
      fix: "Turn off the real GPU when bridging, so the reported GPU and the rendered pixels agree.",
    });
  }

  // ── A narrow switch under a broad one that already covers it ──────────────
  // Not wrong, just pointless: the wide switch already reports the real GPU, so asking for the
  // string half as well says nothing extra and reads as a setting that did not take.
  if (profile.disableGpuFingerprint && profile.gpuStringSpoof === false) {
    out.push({
      id: "gpu-strings-under-real-gpu",
      severity: "warn",
      field: "gpuStringSpoof",
      message:
        "“Real GPU strings only” is redundant here — “use real GPU” already reports the real vendor and renderer, along with everything else.",
      fix: "Turn off the wide switch if you only wanted the strings, or leave this one on.",
    });
  }
  if (profile.fingerprintNoise === false && profile.canvasNoise === false) {
    out.push({
      id: "canvas-noise-under-noise-off",
      severity: "warn",
      field: "canvasNoise",
      message: "Farbling is already off process-wide, so switching canvas 2D noise off as well changes nothing.",
      fix: "Turn farbling back on if you only wanted the 2D canvas unfarbled.",
    });
  }

  // ── Options that will silently do nothing ─────────────────────────────────
  if (profile.shaderDialect && ctx.hostPlatform === "windows") {
    out.push({
      id: "shader-dialect-on-windows",
      severity: "warn",
      field: "shaderDialect",
      message:
        "The HLSL shader dialect has no effect on a Windows host — ANGLE's D3D11 backend already reports HLSL.",
      fix: "Leave it off here. It is for running a Windows persona on a Linux host.",
    });
  } else if (profile.shaderDialect && ctx.major !== undefined && ctx.major < MIN_MAJOR_151) {
    out.push({
      id: "shader-dialect-needs-151",
      severity: "warn",
      field: "shaderDialect",
      message: `The HLSL shader dialect needs Clearcote ${MIN_MAJOR_151} (r15+); build ${ctx.major} ignores it.`,
      fix: `Set the browser version to ${MIN_MAJOR_151}.`,
    });
  }

  if (profile.portableProfile && ctx.major !== undefined && ctx.major < MIN_MAJOR_151) {
    out.push({
      id: "portable-profile-needs-151",
      severity: "warn",
      field: "portableProfile",
      message: `A portable profile needs Clearcote ${MIN_MAJOR_151} (r14+); build ${ctx.major} ignores it, so cookies stay machine-bound.`,
      fix: `Set the browser version to ${MIN_MAJOR_151}.`,
    });
  }

  // ── Light stealth deliberately emits no persona ───────────────────────────
  // A captured profile is loaded through --fingerprint-profile, which still applies, but the seed
  // persona it is meant to refine is gone. Two identity sources, one switched off.
  if (profile.lightStealth && isSet(profile.fingerprintProfile)) {
    out.push({
      id: "light-stealth-with-capture",
      severity: "warn",
      field: "lightStealth",
      message:
        "Light stealth emits no persona, but a captured fingerprint is also set — the capture's values apply while the persona they were meant to refine does not.",
      fix: "Use one or the other: light stealth for a narrow metadata-only surface, or a captured profile for a full identity.",
    });
  }

  // ── A mobile persona with a desktop screen ────────────────────────────────
  if (String(profile.platform) === "android" && isSet(profile.maxTouchPoints) && Number(profile.maxTouchPoints) === 0) {
    out.push({
      id: "android-without-touch",
      severity: "warn",
      field: "maxTouchPoints",
      message: "The platform is Android but touch points are set to 0 — a phone with no touchscreen.",
      fix: "Leave touch points unset so the mobile persona supplies them, or set a realistic value such as 5.",
    });
  }

  // Errors first, then warnings; stable within each band so the list does not reshuffle as you type.
  return [...out.filter((i) => i.severity === "error"), ...out.filter((i) => i.severity === "warn")];
}

/** Convenience for the header chip. */
export function coherenceSummary(issues: Issue[]): { errors: number; warnings: number; ok: boolean } {
  const errors = issues.filter((i) => i.severity === "error").length;
  return { errors, warnings: issues.length - errors, ok: issues.length === 0 };
}
