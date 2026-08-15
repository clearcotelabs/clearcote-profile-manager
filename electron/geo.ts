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
import { parseProxy, type ParsedProxy } from "./proxy";
import { socks5Connect } from "./socks";
import type { Profile } from "./types";

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

const GEO_HOST = "ip-api.com";
const GEO_PATH = "/json/?fields=status,message,query,country,countryCode,timezone,lat,lon";
const GEO_PORT = 80;

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

/** GET the geo endpoint through `proxy` and return the decoded JSON body. */
async function fetchGeoJson(proxy: ParsedProxy | null, timeoutMs: number): Promise<Record<string, unknown>> {
  const { sock, absoluteForm } = await connectThrough(proxy, GEO_HOST, GEO_PORT, timeoutMs);
  try {
    const target = absoluteForm ? `http://${GEO_HOST}${GEO_PATH}` : GEO_PATH;
    const headers = [
      `GET ${target} HTTP/1.1`,
      `Host: ${GEO_HOST}`,
      "User-Agent: clearcote-profile-manager",
      "Accept: application/json",
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
    if (split === -1) throw new Error("malformed HTTP response from the geo service");
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(raw.slice(0, split))?.[1] ?? 0);
    if (status !== 200) throw new Error(`geo service returned HTTP ${status || "?"}`);
    const body = decodeBody(raw.slice(0, split), raw.slice(split + 4));
    return JSON.parse(body) as Record<string, unknown>;
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
export async function geoCheck(profile: Profile, timeoutMs = 12000): Promise<GeoResult> {
  const px = parseProxy(profile.proxy);
  try {
    const j = await fetchGeoJson(px, timeoutMs);
    if (j.status !== "success") {
      return { ok: false, error: String(j.message || "Geo lookup failed.") };
    }
    const cc = j.countryCode as string | undefined;
    return {
      ok: true,
      ip: j.query as string,
      country: j.country as string,
      countryCode: cc,
      timezone: j.timezone as string,
      lat: j.lat as number,
      lon: j.lon as number,
      acceptLanguage: languageForCountry(cc),
    };
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    return { ok: false, error: px ? `${msg} (check the proxy)` : msg };
  }
}
