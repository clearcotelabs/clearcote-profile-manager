import { net, session } from "electron";
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

/**
 * Resolve the egress IP + geo a profile would present (through its proxy if set).
 * Doubles as a proxy health check. Uses Electron's net stack on an isolated session
 * so proxy auth is handled via the request 'login' event. Best-effort, no extra deps.
 */
export function geoCheck(profile: Profile): Promise<GeoResult> {
  return new Promise((resolve) => {
    const ses = session.fromPartition(`geo:${profile.id || "tmp"}:${Date.now()}`);
    const finish = (r: GeoResult) => resolve(r);

    const apply = profile.proxy?.server
      ? ses.setProxy({ proxyRules: profile.proxy.server })
      : ses.setProxy({ mode: "direct" });

    apply
      .then(() => {
        const req = net.request({
          method: "GET",
          url: "http://ip-api.com/json/?fields=status,message,query,country,countryCode,timezone,lat,lon",
          session: ses,
          useSessionCookies: false,
        });
        // proxy / server auth
        req.on("login", (_authInfo, cb) => {
          if (profile.proxy?.username) cb(profile.proxy.username, profile.proxy.password || "");
          else cb();
        });
        let body = "";
        const timer = setTimeout(() => {
          try { req.abort(); } catch { /* ignore */ }
          finish({ ok: false, error: "Timed out reaching the geo service (check the proxy)." });
        }, 12000);
        req.on("response", (res) => {
          res.on("data", (c) => (body += c.toString()));
          res.on("end", () => {
            clearTimeout(timer);
            try {
              const j = JSON.parse(body);
              if (j.status !== "success") return finish({ ok: false, error: j.message || "Geo lookup failed." });
              finish({
                ok: true,
                ip: j.query,
                country: j.country,
                countryCode: j.countryCode,
                timezone: j.timezone,
                lat: j.lat,
                lon: j.lon,
                acceptLanguage: LANG_BY_CC[j.countryCode] || "en-US,en",
              });
            } catch (e) {
              finish({ ok: false, error: "Bad response from geo service: " + String(e) });
            }
          });
        });
        req.on("error", (e) => {
          clearTimeout(timer);
          finish({ ok: false, error: String(e) });
        });
        req.end();
      })
      .catch((e) => finish({ ok: false, error: "Proxy config rejected: " + String(e) }));
  });
}
