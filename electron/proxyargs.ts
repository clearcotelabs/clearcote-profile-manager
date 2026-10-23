// Parsing a profile's proxy string and turning it into switches.
//
// Deliberately PURE — no `node:` imports, no fs, no net — for the same reason electron/fpargs.ts
// is: both the Electron main process (which launches) and the Next renderer (which shows the
// command-line preview) import it, and a `node:net` import anywhere in that graph breaks the
// renderer bundle. The socket machinery (the local auth-injecting relay) lives in ./proxy, which
// re-exports everything here so existing importers keep working.
//
// A profile's `proxy` is a single string, in any of the forms proxy vendors hand out (see
// parseProxy). Whatever was typed, `raw` on the parsed result is the one URL form the rest of the
// app stores and shows: scheme://user:pass@host:port.
//
// Chromium's --proxy-server IGNORES inline credentials (it would just prompt), so credentials
// travel by one of two routes depending on scheme — see proxyArgs() below.

export interface ParsedProxy {
  scheme: string; // http | https | socks5 | socks4
  host: string;
  port: number;
  username?: string;
  password?: string;
  raw: string; // the canonical URL form: scheme://user:pass@host:port
  /** Whether the input named the scheme / the port itself (rather than getting the default). */
  schemeGiven: boolean;
  portGiven: boolean;
}

/** Scheme spellings people paste → the one Chromium's --proxy-server understands. Chromium reads
 *  bare `socks://` as SOCKS4, which cannot authenticate, so it means SOCKS5 here as it does for
 *  every vendor that writes it. socks5h/socks4a (curl's "resolve on the proxy") are what Chromium
 *  does for SOCKS anyway. */
const SCHEMES: Record<string, string> = {
  http: "http",
  https: "https",
  socks5: "socks5",
  socks5h: "socks5",
  socks: "socks5",
  socks4: "socks4",
  socks4a: "socks4",
};

const isPort = (s: string | undefined) => !!s && /^\d{1,5}$/.test(s) && +s >= 1 && +s <= 65535;
const HOST_RE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?)$/i;
/** A host that cannot be mistaken for a username: an IP, a dotted name, or localhost. */
const looksLikeHost = (s: string) => HOST_RE.test(s) && (/[.:]/.test(s) || s.toLowerCase() === "localhost");

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** "host:port" or "[v6]:port" or a lone host, or null. */
function hostPort(s: string): { host: string; port?: string } | null {
  const v6 = /^(\[[0-9a-f:.]+\])(?::(\d+))?$/i.exec(s);
  if (v6) return isPort(v6[2]) || v6[2] === undefined ? { host: v6[1], port: v6[2] } : null;
  const parts = s.split(":");
  if (parts.length > 2 || !HOST_RE.test(parts[0])) return null;
  if (parts.length === 2 && !isPort(parts[1])) return null;
  return { host: parts[0], port: parts[1] };
}

/** "user:pass" (the password may hold colons) → its parts. */
function creds(s: string): { username?: string; password?: string } {
  const i = s.indexOf(":");
  const user = i === -1 ? s : s.slice(0, i);
  const pass = i === -1 ? undefined : s.slice(i + 1);
  return { username: user ? decode(user) : undefined, password: pass ? decode(pass) : undefined };
}

type Parts = { host: string; port?: string; username?: string; password?: string };

/** The address part after any scheme, in every layout vendors use. */
function readAddress(rest: string): Parts | null {
  // user:pass@host:port — the LAST @ separates, so a password may contain one.
  // host:port@user:pass — some vendors put the credentials after the address instead.
  // An address without a port after the @ ("user:pass@host") is only taken when the colon layouts
  // below cannot read the string either — "host:port:user:p@ss" has an @ in the password.
  let portless: Parts | null = null;
  if (rest.includes("@")) {
    const last = rest.lastIndexOf("@");
    const hp = hostPort(rest.slice(last + 1));
    if (hp?.port) return { ...hp, ...creds(rest.slice(0, last)) };
    const first = rest.indexOf("@");
    const hp2 = hostPort(rest.slice(0, first));
    if (hp2?.port) return { ...hp2, ...creds(rest.slice(first + 1)) };
    if (hp) portless = { ...hp, ...creds(rest.slice(0, last)) };
  }
  return colonForm(rest) ?? portless;
}

/** The colon-separated layouts, without any @ handling. */
function colonForm(rest: string): Parts | null {
  // [v6]:port:user:pass
  const v6 = /^(\[[0-9a-f:.]+\]):(\d+)(?::([^:]*)(?::(.*))?)?$/i.exec(rest);
  if (v6) {
    if (!isPort(v6[2])) return null;
    return { host: v6[1], port: v6[2], username: v6[3] ? decode(v6[3]) : undefined, password: v6[4] ? decode(v6[4]) : undefined };
  }
  const parts = rest.split(":");
  if (parts.length <= 2) return rest.includes("@") ? null : hostPort(rest);
  // Colon-separated with credentials: host:port:user:pass (most vendors) or user:pass:host:port.
  // When both readings have a port in the right place, the one whose host looks like a host wins.
  const hostFirst = HOST_RE.test(parts[0]) && isPort(parts[1]);
  const n = parts.length;
  const userFirst = n >= 4 && HOST_RE.test(parts[n - 2]) && isPort(parts[n - 1]);
  const pick =
    hostFirst && userFirst ? (looksLikeHost(parts[0]) || !looksLikeHost(parts[n - 2]) ? "host" : "user")
    : hostFirst ? "host" : userFirst ? "user" : null;
  if (pick === "host") {
    const pass = parts.slice(3).join(":");
    return { host: parts[0], port: parts[1], username: parts[2] ? decode(parts[2]) : undefined, password: pass ? decode(pass) : undefined };
  }
  if (pick === "user") {
    const pass = parts.slice(1, n - 2).join(":");
    return { host: parts[n - 2], port: parts[n - 1], username: parts[0] ? decode(parts[0]) : undefined, password: pass ? decode(pass) : undefined };
  }
  return null;
}

/** The canonical string for parsed parts — credentials percent-encoded, so it round-trips. */
function canonical(scheme: string, a: { host: string; port: number; username?: string; password?: string }): string {
  const enc = (s: string) => encodeURIComponent(s);
  const auth = a.username || a.password ? `${enc(a.username ?? "")}${a.password ? `:${enc(a.password)}` : ""}@` : "";
  return `${scheme}://${auth}${a.host}:${a.port}`;
}

/**
 * Parse a proxy in any of the forms vendors hand out — or the legacy { server, username, password }
 * object — into its parts. Returns null if it cannot be read. With or without a scheme in front:
 *
 *   scheme://user:pass@host:port   user:pass@host:port   host:port   host
 *   host:port:user:pass            user:pass:host:port   host:port@user:pass
 *   "host port user pass" (space/tab separated, as copied from a spreadsheet)   [v6]:port…
 *
 * The scheme is kept (default http); passwords may contain ':' or '@'.
 */
export function parseProxy(input: unknown): ParsedProxy | null {
  if (!input) return null;
  let text: string;
  if (typeof input === "object") {
    const o = input as { server?: string; username?: string; password?: string };
    if (!o.server) return null;
    const p = parseProxy(o.server);
    if (!p) return null;
    const out = { ...p, username: o.username || p.username, password: o.password || p.password };
    return { ...out, raw: canonical(out.scheme, out) };
  }
  text = String(input).trim();
  if (!text) return null;
  // Spreadsheet columns / space-separated lists: 2 or 4 fields → the colon form.
  const fields = text.split(/\s+/);
  if (fields.length > 1) {
    if (fields.length !== 2 && fields.length !== 4) return null;
    text = fields.join(":");
  }
  let scheme = "http";
  let schemeGiven = false;
  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(text);
  if (m) {
    const s = SCHEMES[m[1].toLowerCase()];
    if (!s) return null;
    scheme = s;
    schemeGiven = true;
    text = m[2];
  }
  text = text.replace(/\/+$/, "");
  if (!text || /[/?#\s]/.test(text.slice(text.lastIndexOf("@") + 1))) return null;
  const a = readAddress(text);
  if (!a || !a.host) return null;
  // IPv6 keeps its brackets, as URL.hostname does — --proxy-server needs them.
  const host = a.host.toLowerCase();
  const port = a.port ? Number(a.port) : scheme === "https" ? 443 : scheme.startsWith("socks") ? 1080 : 80;
  const parts = { host, port, username: a.username, password: a.password };
  return {
    scheme,
    host,
    port,
    username: a.username,
    password: a.password,
    raw: canonical(scheme, parts),
    schemeGiven,
    portGiven: !!a.port,
  };
}

/** The canonical URL form of a proxy, or null when it cannot be read. */
export function normalizeProxy(input: unknown): string | null {
  return parseProxy(input)?.raw ?? null;
}

/** A sentence for a proxy that is filled in but cannot be read, or null (empty or readable).
 *  Everything that would use the proxy refuses on this instead of quietly going direct. */
export function proxyProblem(input: unknown): string | null {
  if (!input || (typeof input === "string" && !input.trim())) return null;
  if (parseProxy(input)) return null;
  return (
    "This proxy address cannot be read, so nothing will use it. Use a form like " +
    "socks5://user:pass@host:1080, host:port:user:pass or user:pass@host:port."
  );
}

/** The --proxy-server value WITHOUT credentials (Chromium parses no userinfo out of it). */
export function proxyServerArg(p: ParsedProxy): string {
  return `${p.scheme}://${p.host}:${p.port}`;
}

/** A proxy string with the password removed (for export / display). */
export function redactProxyString(input: unknown): string {
  const p = parseProxy(input);
  // An address that cannot be read has no known place for its password, so none of it goes out.
  if (!p) return "";
  return canonical(p.scheme, { ...p, password: undefined });
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
  opts: { relayUrl?: string; redactSecrets?: boolean; socks5Udp?: boolean; transparentProxy?: boolean } = {},
): string[] {
  if (!p) return [];
  // --transparent-proxy (engine 152 r22+) sends `Connection` instead of `Proxy-Connection` on
  // plain-HTTP requests and reports proxied connection timing like a reused connection. It only
  // describes how the browser talks to a proxy, so it rides along with one and never appears alone.
  const transparent = opts.transparentProxy ? ["--transparent-proxy"] : [];
  if (opts.relayUrl) return [`--proxy-server=${opts.relayUrl}`, ...transparent];
  const args = [`--proxy-server=${proxyServerArg(p)}`, ...transparent];
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
