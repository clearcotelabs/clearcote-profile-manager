// Resolve the egress IP + geo a profile presents through its proxy — the values that make a
// persona's timezone / language / geolocation agree with where its traffic actually comes out.
//
// This used to go through Electron's `session`/`net` stack, which is stock Chromium and therefore
// CANNOT authenticate to a SOCKS5 proxy (no `login` event fires for SOCKS; credentials in
// proxyRules are ignored). Every lookup through an authenticated SOCKS5 proxy — the common
// residential shape — failed, so `location` was never filled and the browser reported the host's
// real position. The request is small and made once, so it is done here over a plain socket
// instead: direct, through an http/https proxy, or through SOCKS5 with RFC 1929 auth.

import net from "node:net";
import tls from "node:tls";
import { parseProxy, proxyProblem, type ParsedProxy } from "./proxy";
import { socks5Connect } from "./socks";
import { ensureMmdb, geoFromRecord, ipBits, lookupFile, mmdbDownloading, type DbGeo } from "./geodb";
import type { Profile } from "./types";

export interface GeoResult {
  ok: boolean;
  ip?: string;
  country?: string;
  countryCode?: string;
  city?: string;
  timezone?: string;
  lat?: number;
  lon?: number;
  acceptLanguage?: string;
  error?: string;
}

// Minimal country → Accept-Language map (the common exit countries). Mirrors the
// SDK's geoip idea; extend as needed. Falls back to en-US,en.
const LANG_BY_CC: Record<string, string> = {
  US: "en-US,en", GB: "en-GB,en", IE: "en-IE,en", CA: "en-CA,en,fr-CA",
  AU: "en-AU,en", NZ: "en-NZ,en", DE: "de-DE,de", AT: "de-AT,de",
  CH: "de-CH,de,fr-CH", FR: "fr-FR,fr", BE: "nl-BE,fr-BE,nl", NL: "nl-NL,nl,en",
  ES: "es-ES,es", MX: "es-MX,es", AR: "es-AR,es", IT: "it-IT,it",
  PT: "pt-PT,pt", BR: "pt-BR,pt", RU: "ru-RU,ru", UA: "uk-UA,uk,ru",
  PL: "pl-PL,pl", SE: "sv-SE,sv,en", NO: "nb-NO,no,en", DK: "da-DK,da,en",
  FI: "fi-FI,fi,en", JP: "ja-JP,ja", KR: "ko-KR,ko", CN: "zh-CN,zh",
  TW: "zh-TW,zh", HK: "zh-HK,zh,en", IN: "en-IN,en,hi", SG: "en-SG,en",
  TR: "tr-TR,tr", ID: "id-ID,id", TH: "th-TH,th", VN: "vi-VN,vi",
};

/** Accept-Language for a country code, defaulting to en-US,en. Exported for the launch path. */
export function languageForCountry(cc?: string): string {
  return (cc && LANG_BY_CC[cc.toUpperCase()]) || "en-US,en";
}

// Where the exit IP and its region come from — the SDK's sources since 0.47:
//   1. the exit IP from a plain IP echo THROUGH the proxy: api.ipify.org, then icanhazip.com, or your
//      own endpoint(s) in CLEARCOTE_GEOIP_ECHO_URL (comma-separated) so no third party learns the
//      proxy exists. Plain text, or JSON with an `ip` / `query` field.
//   2. the region from the offline geoip-all-in-one database (./geodb), shared with the SDKs' cache.
//   3. ip-api.com only with CLEARCOTE_GEOIP_IPAPI=1, when the database has no answer (for example
//      while it is still downloading on first use). Off by default: its free endpoint is for
//      non-commercial use only and bans an IP that asks more than 45 times a minute.
// This used to ask ip-api.com for everything, on every check and every geoip launch.
// https: some proxies answer every plain-http request with a 301 to https,
// which made Resolve and Check fail on a proxy that browses fine.
export const IPECHO_URLS = ["https://api.ipify.org", "https://icanhazip.com"];
export const ECHO_URL_ENV = "CLEARCOTE_GEOIP_ECHO_URL";
export const IPAPI_ENV = "CLEARCOTE_GEOIP_IPAPI";
const IPAPI_URL = "http://ip-api.com/json/?fields=status,message,query,country,countryCode,city,timezone,lat,lon";

/** The IP-echo endpoints, in order: CLEARCOTE_GEOIP_ECHO_URL when set, else the public defaults. */
export function echoUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const custom = (env[ECHO_URL_ENV] ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  return custom.length ? custom : [...IPECHO_URLS];
}

/** Whether CLEARCOTE_GEOIP_IPAPI opts in to the ip-api.com fallback (1/true/yes/on). */
export function ipapiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["1", "true", "yes", "on"].includes((env[IPAPI_ENV] ?? "").trim().toLowerCase());
}

/** The IP an echo answered: plain text (first word), or JSON with an `ip` or `query` field. */
export function ipFromEcho(text: string): string {
  let t = (text ?? "").trim();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as { ip?: unknown; query?: unknown };
      t = String(j?.ip ?? j?.query ?? "");
    } catch {
      return "";
    }
  }
  return t ? t.split(/\s+/)[0] : "";
}

/** Plain http:// only: the echoes and ip-api are asked over HTTP, as the SDKs do. */
function parseHttpUrl(url: string): { secure: boolean; host: string; port: number; path: string } {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`only http(s):// endpoints are supported (${url})`);
  const secure = u.protocol === "https:";
  return { secure, host: u.hostname, port: Number(u.port || (secure ? 443 : 80)), path: `${u.pathname}${u.search}` };
}

/** A raw byte tunnel to `host:port` for TLS: direct, SOCKS, or an http(s) proxy's CONNECT. */
async function tunnelThrough(proxy: ParsedProxy | null, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  const { sock, absoluteForm } = await connectThrough(proxy, host, port, timeoutMs);
  if (!absoluteForm) return sock;
  const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
  if (proxy?.username) {
    lines.push(`Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64")}`);
  }
  sock.write(lines.join("\r\n") + "\r\n\r\n");
  const head = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const done = (err?: Error) => {
      clearTimeout(timer);
      sock.removeListener("data", onData);
      sock.removeListener("error", onError);
      sock.removeListener("end", onEnd);
      sock.pause();
      if (err) {
        sock.destroy();
        reject(err);
      } else resolve(buf);
    };
    const timer = setTimeout(() => done(new Error(`timed out waiting for the proxy to open a tunnel to ${host}`)), timeoutMs);
    const onData = (c: Buffer) => {
      buf += c.toString("latin1");
      if (buf.includes("\r\n\r\n")) done();
      else if (buf.length > 16384) done(new Error("proxy sent an oversized CONNECT reply"));
    };
    const onError = (e: Error) => done(e);
    const onEnd = () => done(new Error(`the proxy closed the connection instead of opening a tunnel to ${host}`));
    sock.on("data", onData);
    sock.once("error", onError);
    sock.once("end", onEnd);
  });
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
  if (status !== 200) {
    sock.destroy();
    throw new Error(status === 407 ? "the proxy refused the login (HTTP 407)" : `the proxy refused a tunnel to ${host} (HTTP ${status || "?"})`);
  }
  return sock;
}

/** TLS over an open tunnel, verifying the echo service's certificate. */
function startTls(sock: net.Socket, host: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket: sock, servername: host });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new Error(`timed out during the TLS handshake with ${host}`));
    }, timeoutMs);
    secure.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(secure);
    });
    secure.once("error", (e) => {
      clearTimeout(timer);
      secure.destroy();
      reject(e);
    });
  });
}

/** Open a byte pipe to `host:port` — directly, or through the profile's proxy. Returns the socket
 *  plus whether the request line must be absolute-form (an http proxy wants the full URL). */
async function connectThrough(
  proxy: ParsedProxy | null,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ sock: net.Socket; absoluteForm: boolean }> {
  if (!proxy) {
    const sock = await connectTcp(host, port, timeoutMs);
    return { sock, absoluteForm: false };
  }
  if (proxy.scheme.startsWith("socks")) {
    // The proxy resolves the destination name, so no DNS for it leaves the real host.
    return { sock: await socks5Connect(proxy, host, port, timeoutMs), absoluteForm: false };
  }
  // http/https forward proxy: talk to the proxy and ask for the absolute URL. `https` here means
  // the hop TO THE PROXY is TLS (rare, but some providers offer it).
  const raw = await connectTcp(proxy.host, proxy.port, timeoutMs);
  if (proxy.scheme !== "https") return { sock: raw, absoluteForm: true };
  const secure = tls.connect({ socket: raw, servername: proxy.host });
  await new Promise<void>((resolve, reject) => {
    secure.once("secureConnect", resolve);
    secure.once("error", reject);
  });
  return { sock: secure, absoluteForm: true };
}

function connectTcp(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => {
      sock.setTimeout(0);
      resolve(sock);
    });
    sock.once("timeout", () => {
      sock.destroy();
      reject(new Error(`timed out connecting to ${host}:${port}`));
    });
    sock.once("error", (e) => {
      sock.destroy();
      reject(e);
    });
  });
}

/** GET an http:// or https:// URL through `proxy` and return the decoded body. */
async function fetchText(url: string, proxy: ParsedProxy | null, timeoutMs: number): Promise<string> {
  const { secure, host, port, path } = parseHttpUrl(url);
  const { sock, absoluteForm } = secure
    ? { sock: await startTls(await tunnelThrough(proxy, host, port, timeoutMs), host, timeoutMs), absoluteForm: false }
    : await connectThrough(proxy, host, port, timeoutMs);
  try {
    const defaultPort = secure ? 443 : 80;
    const target = absoluteForm ? `http://${host}${port === 80 ? "" : `:${port}`}${path}` : path;
    const headers = [
      `GET ${target} HTTP/1.1`,
      `Host: ${port === defaultPort ? host : `${host}:${port}`}`,
      "User-Agent: clearcote-profile-manager",
      "Accept: */*",
      "Connection: close",
    ];
    // An authenticated http/https proxy still needs its header on this hop; SOCKS auth already
    // happened during the handshake.
    if (absoluteForm && proxy?.username) {
      const basic = Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64");
      headers.push(`Proxy-Authorization: Basic ${basic}`);
    }
    sock.write(headers.join("\r\n") + "\r\n\r\n");

    const raw = await readResponse(sock, timeoutMs);
    const split = raw.indexOf("\r\n\r\n");
    if (split === -1) throw new Error(`malformed HTTP response from ${host}`);
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(raw.slice(0, split))?.[1] ?? 0);
    if (status !== 200) throw new Error(`${host} returned HTTP ${status || "?"}`);
    return decodeBody(raw.slice(0, split), raw.slice(split + 4));
  } finally {
    sock.destroy();
  }
}

/** Read until the server closes (we send `Connection: close`), bounded by a timeout. */
function readResponse(sock: net.Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("timed out waiting for the geo service"));
    }, timeoutMs);
    sock.setEncoding("latin1");
    // socks5Connect hands back a PAUSED socket (see its contract) that may already hold the first
    // response bytes; a plain 'data' listener would not restart it. Harmless on a direct socket.
    sock.resume();
    sock.on("data", (c: string) => {
      buf += c;
      if (buf.length > 1 << 20) {
        clearTimeout(timer);
        sock.destroy();
        reject(new Error("geo response too large"));
      }
    });
    sock.once("end", () => {
      clearTimeout(timer);
      resolve(buf);
    });
    sock.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** Undo `Transfer-Encoding: chunked` and re-decode as UTF-8. The socket is read as latin1 so byte
 *  offsets stay exact while parsing the framing; the body is converted back at the end. */
function decodeBody(head: string, body: string): string {
  let out = body;
  if (/transfer-encoding:\s*chunked/i.test(head)) {
    let rest = body;
    out = "";
    for (;;) {
      const nl = rest.indexOf("\r\n");
      if (nl === -1) break;
      const size = parseInt(rest.slice(0, nl).split(";")[0].trim(), 16);
      if (!Number.isFinite(size) || size <= 0) break;
      out += rest.slice(nl + 2, nl + 2 + size);
      rest = rest.slice(nl + 2 + size + 2);
    }
  }
  return Buffer.from(out, "latin1").toString("utf8");
}

/**
 * Resolve the egress IP + geo a profile would present (through its proxy if set).
 * Doubles as a proxy health check: a failure here means the proxy itself is unusable.
 */
export async function geoCheck(profile: Profile, timeoutMs = 20000): Promise<GeoResult> {
  // Unreadable is not "no proxy": looking up this PC's own exit would fill the profile with it.
  const unreadable = proxyProblem(profile.proxy);
  if (unreadable) return { ok: false, error: unreadable };
  let px: ParsedProxy | null;
  try {
    px = parseProxy(profile.proxy);
  } catch (e) {
    return { ok: false, error: `invalid proxy (${(e as Error)?.message || e})` };
  }
  const deadline = Date.now() + timeoutMs;

  // 1. The exit IP. Every echo failing means the proxy itself is unusable — this doubles as the
  //    proxy health check, so the first echo's error is what the user sees.
  let ip = "";
  let echoError = "";
  for (const url of echoUrls()) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    try {
      const got = ipFromEcho(await fetchText(url, px, Math.min(left, 8000)));
      if (ipBits(got)) {
        ip = got;
        break;
      }
      echoError ||= `${new URL(url).hostname} did not answer with an IP address`;
    } catch (e) {
      echoError ||= (e as Error)?.message || String(e);
    }
  }
  if (!ip) {
    const msg = echoError || "could not determine the exit IP";
    if (!px) return { ok: false, error: msg };
    // An address typed without a scheme is read as http; a SOCKS-only port then just hangs up.
    const hint = !px.schemeGiven && px.scheme === "http" ? ". If this is a SOCKS5 proxy, start the address with socks5://" : "";
    return { ok: false, error: `${msg} (check the proxy)${hint}` };
  }

  // 2. Its region, from the offline database. The first-use download (~52 MB) may outlast the
  //    budget; it keeps going in the background and serves the next check.
  let db: DbGeo | null = null;
  let dbState: "downloading" | "unavailable" | "ok" = "ok";
  const left = deadline - Date.now();
  let timer: NodeJS.Timeout | undefined;
  const file = await Promise.race([
    ensureMmdb((m) => console.log(`[clearcote] ${m}`)),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, left));
    }),
  ]);
  clearTimeout(timer);
  if (!file) dbState = mmdbDownloading() ? "downloading" : "unavailable";
  else {
    try {
      db = geoFromRecord(lookupFile(file, ip));
    } catch (e) {
      console.warn(`[clearcote] geoip: database read failed (${(e as Error)?.message || e})`);
    }
  }
  if (db?.timezone) {
    return {
      ok: true,
      ip,
      country: db.country,
      countryCode: db.countryCode,
      city: db.city,
      timezone: db.timezone,
      lat: db.lat,
      lon: db.lon,
      acceptLanguage: languageForCountry(db.countryCode),
    };
  }

  // 3. Opt-in only: ip-api.com, through the same proxy.
  if (ipapiEnabled()) {
    const rest = deadline - Date.now();
    if (rest > 0) {
      try {
        const j = JSON.parse(await fetchText(IPAPI_URL, px, Math.min(rest, 8000))) as Record<string, unknown>;
        if (j.status === "success") {
          const cc = j.countryCode as string | undefined;
          return {
            ok: true,
            ip: (j.query as string) || ip,
            country: j.country as string,
            countryCode: cc,
            city: (j.city as string) || undefined,
            timezone: j.timezone as string,
            lat: j.lat as number,
            lon: j.lon as number,
            acceptLanguage: languageForCountry(cc),
          };
        }
      } catch {
        /* fall through to the database's reason */
      }
    }
  }

  const optIn = ipapiEnabled() ? "" : ` (or set ${IPAPI_ENV}=1 to ask ip-api.com, non-commercial use only)`;
  const error =
    dbState === "downloading"
      ? `exit IP ${ip}: the geoip database is still downloading (~52 MB, first use only) — check again in a moment${optIn}`
      : dbState === "unavailable"
        ? `exit IP ${ip}: the geoip database could not be downloaded${optIn}`
        : `no region data for exit IP ${ip}`;
  return { ok: false, ip, error };
}

/** Start the database download in the background, so the first geoip launch does not wait for it.
 *  Never rejects. */
export function prefetchGeoDb(): void {
  void ensureMmdb((m) => console.log(`[clearcote] ${m}`));
}
