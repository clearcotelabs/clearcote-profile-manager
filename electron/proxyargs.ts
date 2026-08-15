// Parsing a profile's proxy string and turning it into switches.
//
// Deliberately PURE — no `node:` imports, no fs, no net — for the same reason electron/fpargs.ts
// is: both the Electron main process (which launches) and the Next renderer (which shows the
// command-line preview) import it, and a `node:net` import anywhere in that graph breaks the
// renderer bundle. The socket machinery (the local auth-injecting relay) lives in ./proxy, which
// re-exports everything here so existing importers keep working.
//
// A profile's `proxy` is a single string:
//   http://user:pass@host:port  ·  socks5://user:pass@host:1080  ·  host:8080
//
// Chromium's --proxy-server IGNORES inline credentials (it would just prompt), so credentials
// travel by one of two routes depending on scheme — see proxyArgs() below.

export interface ParsedProxy {
  scheme: string; // http | https | socks5 | socks4 | socks
  host: string;
  port: number;
  username?: string;
  password?: string;
  raw: string; // the original/normalized string
}

/** Parse a proxy string ("scheme://user:pass@host:port", "user:pass@host:port", "host:port") —
 *  or the legacy { server, username, password } object — into its parts. Returns null if unusable. */
export function parseProxy(input: unknown): ParsedProxy | null {
  if (!input) return null;
  let raw: string;
  if (typeof input === "object") {
    const o = input as { server?: string; username?: string; password?: string };
    if (!o.server) return null;
    try {
      const u = new URL(/:\/\//.test(o.server) ? o.server : `http://${o.server}`);
      if (o.username) u.username = o.username;
      if (o.password) u.password = o.password;
      raw = u.toString();
    } catch {
      return null;
    }
  } else {
    raw = String(input).trim();
  }
  if (!raw) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    const scheme = (u.protocol || "http:").replace(":", "") || "http";
    const port = Number(u.port) || (scheme === "https" ? 443 : scheme.startsWith("socks") ? 1080 : 80);
    return {
      scheme,
      host: u.hostname,
      port,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      raw,
    };
  } catch {
    return null;
  }
}

/** The --proxy-server value WITHOUT credentials (Chromium parses no userinfo out of it). */
export function proxyServerArg(p: ParsedProxy): string {
  return `${p.scheme}://${p.host}:${p.port}`;
}

/** A proxy string with the password removed (for export / display). */
export function redactProxyString(input: unknown): string {
  const p = parseProxy(input);
  if (!p) return typeof input === "string" ? input : "";
  if (!p.password) return p.raw;
  try {
    const u = new URL(/:\/\//.test(p.raw) ? p.raw : `http://${p.raw}`);
    u.password = "";
    return u.toString();
  } catch {
    return p.raw;
  }
}

/** True for a SOCKS proxy carrying credentials — the case the ENGINE authenticates itself via
 *  --socks5-credentials rather than through the local relay. */
export function isAuthenticatedSocks(p: ParsedProxy): boolean {
  return p.scheme.startsWith("socks") && !!(p.username || p.password);
}

/** Only authenticated http/https proxies need the local relay. Authenticated SOCKS is handled by
 *  the engine's own switch, and credential-less proxies of any scheme need nothing at all. */
export function needsRelay(p: ParsedProxy): boolean {
  return !!p.username && (p.scheme === "http" || p.scheme === "https");
}

/** The `user:pass` value for --socks5-credentials, or null when the switch does not apply. */
export function socks5CredentialsArg(p: ParsedProxy): string | null {
  if (!isAuthenticatedSocks(p)) return null;
  return `${p.username ?? ""}:${p.password ?? ""}`;
}

/**
 * The proxy switches for a launch — the single place the scheme/credential matrix is decided, so
 * the real launcher and the UI preview cannot disagree about it.
 *
 *   http/https + credentials → the launcher starts a local relay and passes `relayUrl`; the browser
 *     only ever sees 127.0.0.1 and never has to prompt.
 *   socks5 + credentials     → --proxy-server stays bare and the credentials go in their own
 *     --socks5-credentials switch, which the engine implements as RFC 1929 (151 r14+). Stock
 *     Chromium cannot authenticate to a SOCKS5 proxy at all; before r14 this app simply dropped
 *     the credentials, so every such proxy refused the connection — "only http works".
 *   anything else            → a bare --proxy-server.
 *
 * `redactSecrets` masks the SOCKS5 password for display.
 */
export function proxyArgs(
  p: ParsedProxy | null,
  opts: { relayUrl?: string; redactSecrets?: boolean; socks5Udp?: boolean } = {},
): string[] {
  if (!p) return [];
  if (opts.relayUrl) return [`--proxy-server=${opts.relayUrl}`];
  const args = [`--proxy-server=${proxyServerArg(p)}`];
  const creds = socks5CredentialsArg(p);
  if (creds) args.push(`--socks5-credentials=${opts.redactSecrets ? `${p.username ?? ""}:********` : creds}`);
  // UDP relaying is opt-in and only means anything for a SOCKS5 proxy. UDP ASSOCIATE is a SOCKS5
  // command — SOCKS4 has no equivalent and http/https carry only TCP — so for anything else this
  // would be a switch that is accepted and silently does nothing.
  if (opts.socks5Udp && p.scheme.startsWith("socks5")) args.push("--socks5-udp");
  return args;
}

/** Engine major that relays UDP through a SOCKS5 proxy. Shipped in 151 r17 — the switch is ignored
 *  by 151 builds older than that, which the revision cannot express, so this gate catches only the
 *  wrong-major case and the launch warning covers the rest. */
export const SOCKS5_UDP_MIN_MAJOR = 151;

/**
 * A warning when UDP relaying is requested but cannot work, or null when the pairing is fine.
 *
 * Two ways it silently does nothing, and both are worth saying out loud: an engine that predates
 * the feature ignores the switch, and — far more common — most residential proxies refuse the UDP
 * command outright, so the browser falls back to its normal behaviour with no visible sign.
 */
export function socks5UdpSupportWarning(
  p: ParsedProxy | null,
  requested: boolean | undefined,
  major?: number,
): string | null {
  if (!requested) return null;
  if (!p || !p.scheme.startsWith("socks5")) {
    return "UDP relaying only applies to a SOCKS5 proxy; it does nothing for an http/https or SOCKS4 one.";
  }
  if (major !== undefined && major < SOCKS5_UDP_MIN_MAJOR) {
    return (
      `UDP relaying needs Clearcote ${SOCKS5_UDP_MIN_MAJOR} r17 or newer; the running build is ` +
      `${major}, which ignores it and sends UDP as before.`
    );
  }
  return null;
}

/** Engine major that implements --socks5-credentials. Older binaries ignore an unknown switch
 *  silently, so an authenticated SOCKS5 proxy on 149/150 fails exactly as it did before — worth
 *  saying out loud at launch rather than letting it look like a bad proxy. */
export const SOCKS5_AUTH_MIN_MAJOR = 151;

/** A warning when this profile's proxy needs --socks5-credentials but the resolved build predates
 *  it, or null when the pairing is fine. `major` is the resolved browser major (undefined for an
 *  explicit user-supplied binary, whose version we cannot know — no warning then). */
export function socks5AuthSupportWarning(p: ParsedProxy | null, major?: number): string | null {
  if (!p || !isAuthenticatedSocks(p) || major === undefined) return null;
  if (major >= SOCKS5_AUTH_MIN_MAJOR) return null;
  return (
    `This profile uses an authenticated SOCKS5 proxy, which needs Clearcote ${SOCKS5_AUTH_MIN_MAJOR} ` +
    `(r14+) — the running build is ${major}, which cannot authenticate to a SOCKS5 proxy and will ` +
    `fail to load pages. Set the profile's browser version to ${SOCKS5_AUTH_MIN_MAJOR} (PRO), or use ` +
    `an http/https proxy.`
  );
}
