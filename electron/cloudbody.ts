// What a profile becomes in the cloud: the POST /api/v1/browsers body for a hosted Clearcote browser
// started from this app.
//
// Deliberately PURE (no `node:` imports), like fpargs.ts and proxyargs.ts: the main process sends the
// body, and the renderer's editor shows the same plan (what goes, what stays on this PC) before
// anything starts or is billed.
//
// The hosted API validates every field (clearcote-site lib/hosted/options.ts). The rules repeated here
// are that parser's, so a profile the server would refuse is refused here instead, with a sentence
// that names the setting to change and no session created.

import { parseProxy } from "./proxyargs";
import { sha256Hex } from "./fpargs";

/** Per-profile cloud settings. Everything else comes from the profile itself. */
export interface CloudOptions {
  /** Where the cloud browser's traffic leaves. "profile": this profile's own proxy (http or socks5).
   *  "managed": the residential IP included in the price. Default: the profile's proxy when it has
   *  one, the included IP otherwise. */
  exit?: "profile" | "managed";
  /** For the included residential IP: a 2-letter country code ("us"). Empty = any country. */
  country?: string;
  /** Keep cookies and site storage between cloud sessions, in a cloud profile named after this
   *  profile. On unless turned off. */
  keepCookies?: boolean;
  /** Refuse ad and tracker hosts at the exit, so their bytes are never billed. */
  adblock?: boolean;
  /** End the session once its traffic reaches this many GB: a cost cap. */
  maxGb?: number;
  /** Record the session as a video, replayable from the dashboard. */
  record?: boolean;
}

/** The profile fields the mapping reads. A structural type, so both Profile types satisfy it. */
export interface CloudInput {
  id: string;
  name?: string;
  fingerprint: string;
  browserVersion?: string;
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
  geoip?: boolean;
  disableGpuFingerprint?: boolean;
  fingerprintNoise?: boolean;
  gpuStringSpoof?: boolean;
  canvasNoise?: boolean;
  storageQuota?: number;
  canvasBridgeUrl?: string;
  fingerprintProfile?: string;
  portableProfile?: boolean;
  encryptionKey?: string;
  widevine?: boolean;
  shaderDialect?: string;
  socks5Udp?: boolean;
  proxy?: unknown;
  extraArgs?: string[];
  startUrl?: string;
  cloud?: CloudOptions;
}

/** How long a cloud browser waits with nobody connected, watching or typing: the API's maximum. */
export const CLOUD_IDLE_SEC = 1800;

// The hosted parser's rules (lib/hosted/options.ts), kept in step by tests/cloudbody.test.ts.
export const SEED_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const TZ_RE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*(?:,[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*){0,5}$/;
const VERSION_RE = /^(?:latest|newest|\d{2,4}(?:\.\d{1,5}){0,3}(?:-r\d{1,4})?|r\d{1,4})$/i;
export const PROFILE_RE = /^[A-Za-z0-9._-]{1,48}$/;
const COUNTRY_RE = /^[a-z]{2}$/;
const PLATFORMS = new Set(["windows", "linux", "macos", "android"]);
const BRANDS = new Set(["Chrome", "Edge", "Opera", "Vivaldi"]);
export const NOTE_MAX = 256;
export const MAX_GB_MIN = 0.001;
export const MAX_GB_MAX = 1000;

/**
 * The cloud identity of a profile: its fingerprint seed, which the service turns into one device and
 * one sticky exit IP for this account, the same in every later session. A seed the API would refuse
 * (spaces, other characters, too long) becomes a stable hash of itself, so it still maps to exactly
 * one cloud device.
 */
export function cloudIdentity(p: Pick<CloudInput, "id" | "fingerprint">): string {
  const seed = String(p.fingerprint ?? "").trim();
  if (SEED_RE.test(seed)) return seed;
  return `pm-${sha256Hex(seed || `profile:${p.id}`).slice(0, 24)}`;
}

/** The cloud profile that keeps this profile's cookies between cloud sessions: "pm-<id>", or a
 *  shortened, hashed form when the id has characters or a length the API refuses. One per id. */
export function cloudProfileName(id: string): string {
  const plain = `pm-${id}`;
  if (PROFILE_RE.test(plain)) return plain;
  const safe = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28);
  return `pm-${safe ? `${safe}-` : ""}${sha256Hex(id).slice(0, 12)}`;
}

/** "en-US,en;q=0.9, de" -> "en-US,en,de": the API takes language tags without quality values. */
export function cloudLocale(acceptLanguage: string | undefined): string | undefined {
  if (!acceptLanguage?.trim()) return undefined;
  const tags = acceptLanguage
    .split(",")
    .map((t) => t.split(";")[0].trim())
    .filter(Boolean)
    .slice(0, 6);
  const out = tags.join(",");
  return LANG_RE.test(out) ? out : undefined;
}

/** Which exit a profile uses in the cloud: its own proxy, or the included residential IP. */
export function cloudExit(p: Pick<CloudInput, "proxy" | "cloud">): "profile" | "managed" {
  if (p.cloud?.exit === "managed") return "managed";
  if (p.cloud?.exit === "profile") return "profile";
  return parseProxy(p.proxy) ? "profile" : "managed";
}

/** Settings that shape a browser on this PC and have no cloud equivalent, as people name them. */
export function localOnlySettings(p: CloudInput): string[] {
  const out: string[] = [];
  const add = (on: unknown, label: string) => on && out.push(label);
  add(p.fingerprintProfile, "Captured fingerprint");
  add(p.gpuVendor || p.gpuRenderer, "GPU vendor and renderer");
  add(p.hardwareConcurrency != null, "CPU cores");
  add(p.deviceMemory != null, "Device memory");
  add(p.screenWidth || p.screenHeight || p.availWidth || p.availHeight, "Screen size");
  add(p.colorDepth != null, "Colour depth");
  add(p.devicePixelRatio != null, "Pixel ratio");
  add(p.maxTouchPoints != null, "Touch points");
  add(p.platformVersion, "Platform version");
  add(p.brandVersion, "Brand version");
  add(p.tlsProfile, "TLS profile");
  add(p.location, "Geolocation");
  add(p.webrtcIp, "WebRTC IP");
  add(p.webrtcMdns === "off", "WebRTC mDNS off");
  add(p.disableGpuFingerprint, "Use real GPU");
  add(p.fingerprintNoise === false, "Noise off");
  add(p.gpuStringSpoof === false, "Real GPU strings");
  add(p.canvasNoise === false, "Canvas noise off");
  add(p.storageQuota != null, "Storage quota");
  add(p.canvasBridgeUrl, "Canvas bridge");
  add(p.portableProfile || p.encryptionKey, "Portable profile");
  add(p.widevine, "Widevine");
  add(p.shaderDialect, "Shader dialect");
  add(p.socks5Udp, "SOCKS5 UDP");
  add(p.extraArgs?.length, "Extra switches");
  // With nothing set, the service follows the exit IP's timezone and language (options.ts); "off"
  // here would mean the server's own, so it is not carried over.
  add(p.geoip === false && !p.timezone?.trim() && !p.acceptLanguage?.trim(), "GeoIP off");
  return out;
}

export type CloudPlan =
  | {
      ok: true;
      /** The POST /api/v1/browsers body. Holds the proxy password when the profile's proxy is used. */
      body: Record<string, unknown>;
      /** Where the traffic leaves, for display (no credentials). */
      exit: { kind: "profile"; proxy: string } | { kind: "managed"; country?: string };
      /** The cloud profile holding this profile's cookies, or null when they are not kept. */
      cookies: string | null;
      /** Settings of this profile that do not apply in the cloud. */
      localOnly: string[];
    }
  | { ok: false; error: string; field?: string };

/** One line of label text: no control characters, at most NOTE_MAX characters. */
function noteFor(name: string): string {
  const clean = `Profile Manager: ${name}`.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean.length > NOTE_MAX ? clean.slice(0, NOTE_MAX - 1) + "…" : clean;
}

/**
 * The plan for running this profile in the cloud: the request body, or why it cannot run there.
 *
 * - Device and exit IP: the profile's seed as `identity` (same device, same IP, every session).
 * - Persona: platform, brand, timezone, languages, light stealth and geoip as the profile sets them.
 * - Cookies: a persistent cloud profile per local profile, unless turned off.
 * - Session: kept alive with nobody connected (you drive it from the viewer window, not over CDP), and
 *   closed by the service after CLOUD_IDLE_SEC with nobody watching or typing.
 */
export function cloudSessionPlan(p: CloudInput): CloudPlan {
  const fail = (error: string, field?: string): CloudPlan => ({ ok: false, error, field });
  const c = p.cloud ?? {};
  const body: Record<string, unknown> = { identity: cloudIdentity(p) };

  if (p.platform) {
    if (!PLATFORMS.has(p.platform)) return fail(`The cloud runs windows, linux, macos or android, not “${p.platform}”.`, "platform");
    body.platform = p.platform;
  }
  if (p.brand) {
    if (!BRANDS.has(p.brand)) return fail(`The cloud runs Chrome, Edge, Opera or Vivaldi, not “${p.brand}”.`, "brand");
    body.brand = p.brand;
  }
  if (p.timezone?.trim()) {
    if (!TZ_RE.test(p.timezone.trim())) return fail(`“${p.timezone}” is not a timezone name like Europe/Amsterdam.`, "timezone");
    body.timezone = p.timezone.trim();
  }
  if (p.acceptLanguage?.trim()) {
    const locale = cloudLocale(p.acceptLanguage);
    if (!locale) return fail(`“${p.acceptLanguage}” is not a language list like en-US,en.`, "acceptLanguage");
    body.locale = locale;
  }
  if (p.geoip) body.geoip = true;
  body.lightStealth = p.lightStealth === true;

  const version = p.browserVersion?.trim();
  if (version && version.toLowerCase() !== "latest") {
    if (!VERSION_RE.test(version)) return fail(`“${version}” is not a version the cloud knows. Use Latest, a major like 153, or a revision.`, "browserVersion");
    body.version = version;
  }

  // ── where the traffic leaves ────────────────────────────────────────────────────────────────
  let exit: Extract<CloudPlan, { ok: true }>["exit"];
  if (cloudExit(p) === "profile") {
    const px = parseProxy(p.proxy);
    if (!px) return fail("This profile has no proxy to use in the cloud. Pick the included residential IP instead.", "cloud");
    const scheme = px.scheme.toLowerCase();
    if (scheme !== "http" && scheme !== "socks5" && scheme !== "socks5h") {
      return fail(
        `The cloud can use an http:// or socks5:// proxy, not ${scheme}://. Change the proxy, or use the included residential IP.`,
        "proxy",
      );
    }
    // The service reads the server with WHATWG URL, which drops http's default port and then finds
    // none: an http proxy on port 80 is refused there with "needs an explicit port". Say so here.
    if (scheme === "http" && Number(px.port) === 80) {
      return fail("The cloud can't use an http proxy on port 80 yet. Use the proxy's other port if it has one, or the included residential IP.", "proxy");
    }
    for (const [k, v] of [["username", px.username], ["password", px.password]] as const) {
      if (v && new TextEncoder().encode(v).length > 255) return fail(`The proxy ${k} is longer than 255 bytes.`, "proxy");
    }
    // URL.hostname keeps an IPv6 literal's brackets already; a bare one (the legacy object form) gets them.
    const host = px.host.includes(":") && !px.host.startsWith("[") ? `[${px.host}]` : px.host;
    body.proxy = {
      server: `${scheme}://${host}:${px.port}`,
      ...(px.username ? { username: px.username } : {}),
      ...(px.password ? { password: px.password } : {}),
    };
    exit = { kind: "profile", proxy: `${scheme}://${host}:${px.port}` };
  } else {
    const country = c.country?.trim().toLowerCase();
    if (country && !COUNTRY_RE.test(country)) return fail(`“${c.country}” is not a 2-letter country code like us.`, "cloud");
    body.proxy = "managed";
    if (country) body.country = country;
    exit = { kind: "managed", ...(country ? { country } : {}) };
  }

  // ── cookies, start page, costs ──────────────────────────────────────────────────────────────
  const cookies = c.keepCookies === false ? null : cloudProfileName(p.id);
  if (cookies) body.profile = { name: cookies, persist: true };
  if (p.startUrl?.trim()) {
    let u: URL | null = null;
    try {
      u = new URL(p.startUrl.trim());
    } catch {
      u = null;
    }
    if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || u.href.length > 2048) {
      return fail("The start page must be an http(s) address of at most 2048 characters.", "startUrl");
    }
    body.url = u.href;
  }
  if (c.adblock) body.adblock = true;
  if (c.maxGb != null) {
    if (!(Number.isFinite(c.maxGb) && c.maxGb >= MAX_GB_MIN && c.maxGb <= MAX_GB_MAX)) {
      return fail(`The traffic cap must be between ${MAX_GB_MIN} and ${MAX_GB_MAX} GB.`, "cloud");
    }
    body.maxGb = c.maxGb;
  }
  if (c.record) body.record = true;
  body.keepAlive = true;
  body.idleTimeoutSec = CLOUD_IDLE_SEC;
  body.note = noteFor(p.name?.trim() || p.id);

  const localOnly = localOnlySettings(p);
  if (exit.kind === "managed" && parseProxy(p.proxy)) localOnly.push("This profile's proxy");
  return { ok: true, body, exit, cookies, localOnly };
}
