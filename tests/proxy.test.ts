import { describe, it, expect } from "vitest";
import {
  parseProxy,
  redactProxyString,
  needsRelay,
  proxyServerArg,
  isAuthenticatedSocks,
  socks5CredentialsArg,
  proxyArgs,
  socks5AuthSupportWarning,
  socks5UdpSupportWarning,
  SOCKS5_UDP_MIN_MAJOR,
} from "../electron/proxy";

describe("parseProxy", () => {
  it("full string with credentials", () => {
    expect(parseProxy("http://user:pass@host:8080")).toMatchObject({
      scheme: "http", host: "host", port: 8080, username: "user", password: "pass",
    });
  });
  it("bare host:port defaults to http", () =>
    expect(parseProxy("host:3128")).toMatchObject({ scheme: "http", host: "host", port: 3128 }));
  it("socks5 with default port", () =>
    expect(parseProxy("socks5://h")).toMatchObject({ scheme: "socks5", host: "h", port: 1080 }));
  it("legacy {server,username,password} object", () =>
    expect(parseProxy({ server: "http://h:8080", username: "u", password: "p" })).toMatchObject({
      host: "h", port: 8080, username: "u", password: "p",
    }));
  it("URL-encoded credentials are decoded", () =>
    expect(parseProxy("http://u%40x:p%3As@h:8080")).toMatchObject({ username: "u@x", password: "p:s" }));
  it("dataimpulse-style username (underscores + dots)", () => {
    const p = parseProxy("http://e5112c5f__cr.us:secret@gw.example.com:10000")!;
    expect(p.username).toBe("e5112c5f__cr.us");
    expect(p.password).toBe("secret");
    expect(p.host).toBe("gw.example.com");
    expect(p.port).toBe(10000);
  });
  it("empty / nullish → null", () => {
    expect(parseProxy("")).toBeNull();
    expect(parseProxy(undefined)).toBeNull();
    expect(parseProxy(null)).toBeNull();
  });
});

describe("needsRelay — only authenticated http/https need the local relay", () => {
  it("authenticated http → relay", () => expect(needsRelay(parseProxy("http://u:p@h:8080")!)).toBe(true));
  it("authenticated https → relay", () => expect(needsRelay(parseProxy("https://u:p@h:8443")!)).toBe(true));
  it("credential-less http → no relay", () => expect(needsRelay(parseProxy("http://h:8080")!)).toBe(false));
  // The relay speaks HTTP upstream, not SOCKS, so it could never carry a SOCKS proxy. Authenticated
  // SOCKS is the ENGINE's job (--socks5-credentials, 151 r14+) — which is a different statement from
  // the one this assertion used to carry ("native auth"), back when nothing emitted the switch and
  // the credentials were simply dropped.
  it("authenticated socks → no relay (the engine authenticates it instead)", () =>
    expect(needsRelay(parseProxy("socks5://u:p@h:1080")!)).toBe(false));
});

describe("proxyServerArg — credential-free value for --proxy-server", () => {
  it("strips credentials", () => expect(proxyServerArg(parseProxy("http://u:p@h:8080")!)).toBe("http://h:8080"));
  it("keeps scheme + port", () => expect(proxyServerArg(parseProxy("socks5://h:1080")!)).toBe("socks5://h:1080"));
});

describe("isAuthenticatedSocks", () => {
  it("socks5 with credentials", () => expect(isAuthenticatedSocks(parseProxy("socks5://u:p@h:1080")!)).toBe(true));
  it("socks5 with a username only (empty password is legal in RFC 1929)", () =>
    expect(isAuthenticatedSocks(parseProxy("socks5://u@h:1080")!)).toBe(true));
  it("socks4 with credentials still counts as socks", () =>
    expect(isAuthenticatedSocks(parseProxy("socks4://u:p@h:1080")!)).toBe(true));
  it("bare socks5 → false", () => expect(isAuthenticatedSocks(parseProxy("socks5://h:1080")!)).toBe(false));
  it("authenticated http → false (that is the relay's case)", () =>
    expect(isAuthenticatedSocks(parseProxy("http://u:p@h:8080")!)).toBe(false));
});

describe("socks5CredentialsArg", () => {
  it("joins user:pass", () =>
    expect(socks5CredentialsArg(parseProxy("socks5://u:p@h:1080")!)).toBe("u:p"));
  it("keeps a password containing a colon intact (only the FIRST colon separates)", () => {
    // The engine splits on the first colon, so a colon in the password must survive verbatim —
    // re-encoding or truncating it here would silently authenticate with the wrong secret.
    expect(socks5CredentialsArg(parseProxy("socks5://u:p%3Aa%3Ass@h:1080")!)).toBe("u:p:a:ss");
  });
  it("username-only proxy yields a trailing empty password", () =>
    expect(socks5CredentialsArg(parseProxy("socks5://u@h:1080")!)).toBe("u:"));
  it("null when the switch does not apply", () => {
    expect(socks5CredentialsArg(parseProxy("socks5://h:1080")!)).toBeNull();
    expect(socks5CredentialsArg(parseProxy("http://u:p@h:8080")!)).toBeNull();
  });
});

// The regression this suite exists for: an authenticated SOCKS5 proxy used to produce a lone bare
// --proxy-server with the credentials dropped on the floor, so the proxy refused every connection
// and the user saw "only http works".
describe("proxyArgs — the scheme/credential matrix", () => {
  const args = (s: string | null, opts?: { relayUrl?: string; redactSecrets?: boolean }) =>
    proxyArgs(s === null ? null : parseProxy(s), opts);

  it("no proxy → no switches", () => expect(args(null)).toEqual([]));

  it("authenticated socks5 → bare --proxy-server PLUS --socks5-credentials", () => {
    expect(args("socks5://u:p@h:1080")).toEqual([
      "--proxy-server=socks5://h:1080",
      "--socks5-credentials=u:p",
    ]);
  });

  it("the --proxy-server value never carries the userinfo (Chromium ignores it)", () => {
    const out = args("socks5://u:p@h:1080");
    expect(out[0]).not.toContain("u:p@");
    expect(out[0]).not.toContain("@");
  });

  it("credential-less socks5 → --proxy-server only, no empty credentials switch", () => {
    expect(args("socks5://h:1080")).toEqual(["--proxy-server=socks5://h:1080"]);
  });

  it("credential-less http → --proxy-server only", () =>
    expect(args("http://h:8080")).toEqual(["--proxy-server=http://h:8080"]));

  it("authenticated http with a relay → the relay url only, credentials never on the command line", () => {
    const out = args("http://u:secret@h:8080", { relayUrl: "http://127.0.0.1:5599" });
    expect(out).toEqual(["--proxy-server=http://127.0.0.1:5599"]);
    expect(out.join(" ")).not.toContain("secret");
  });

  it("redactSecrets masks the socks password but keeps the username visible", () => {
    const out = args("socks5://u:secret@h:1080", { redactSecrets: true });
    expect(out).toContain("--socks5-credentials=u:********");
    expect(out.join(" ")).not.toContain("secret");
  });

  it("the real dataimpulse shape round-trips unmangled", () => {
    expect(args("socks5://e5112c5f515764418d14__cr.us:38db09f77925c928@gw.dataimpulse.com:10000")).toEqual([
      "--proxy-server=socks5://gw.dataimpulse.com:10000",
      "--socks5-credentials=e5112c5f515764418d14__cr.us:38db09f77925c928",
    ]);
  });
});

describe("socks5AuthSupportWarning — the switch is 151 r14+", () => {
  const w = (s: string, major?: number) => socks5AuthSupportWarning(parseProxy(s), major);

  it("authenticated socks5 on 151 → no warning", () => expect(w("socks5://u:p@h:1080", 151)).toBeNull());
  it("authenticated socks5 on 150 → warns", () => {
    const msg = w("socks5://u:p@h:1080", 150);
    expect(msg).toContain("151");
    expect(msg).toContain("150");
  });
  it("authenticated socks5 on 149 → warns", () => expect(w("socks5://u:p@h:1080", 149)).toContain("151"));
  it("credential-less socks5 on 149 → no warning (nothing to authenticate)", () =>
    expect(w("socks5://h:1080", 149)).toBeNull());
  it("authenticated http on 149 → no warning (the relay handles it)", () =>
    expect(w("http://u:p@h:8080", 149)).toBeNull());
  it("an explicit binary (unknown major) stays quiet rather than guessing", () =>
    expect(w("socks5://u:p@h:1080", undefined)).toBeNull());
  it("no proxy → no warning", () => expect(socks5AuthSupportWarning(null, 149)).toBeNull());
});

describe("redactProxyString", () => {
  it("removes the password, keeps user + host", () => {
    const r = redactProxyString("http://user:secret@host:8080");
    expect(r).not.toContain("secret");
    expect(r).toContain("user");
    expect(r).toContain("host:8080");
  });
  it("no-credential proxy is unchanged in substance", () =>
    expect(redactProxyString("http://host:8080")).toContain("host:8080"));
});

// ---------------------------------------------------------------------------
// UDP relaying (--socks5-udp). Opt-in, socks5-only, and worth warning about: most residential
// proxies refuse the UDP command, in which case the browser falls back with no visible sign.
// ---------------------------------------------------------------------------
describe("proxyArgs — UDP relaying", () => {
  const args = (s: string | null, opts?: Parameters<typeof proxyArgs>[1]) =>
    proxyArgs(s === null ? null : parseProxy(s), opts);

  it("is absent unless asked for", () =>
    expect(args("socks5://u:p@h:1080")).not.toContain("--socks5-udp"));

  it("is emitted for a socks5 proxy when requested", () =>
    expect(args("socks5://u:p@h:1080", { socks5Udp: true })).toContain("--socks5-udp"));

  it("is emitted for a credential-less socks5 proxy too", () =>
    expect(args("socks5://h:1080", { socks5Udp: true })).toContain("--socks5-udp"));

  it("is NOT emitted for an http proxy — it would be a switch that does nothing", () =>
    expect(args("http://u:p@h:8080", { socks5Udp: true })).not.toContain("--socks5-udp"));

  it("is NOT emitted when the relay carries the proxy", () =>
    expect(args("http://u:p@h:8080", { socks5Udp: true, relayUrl: "http://127.0.0.1:1" })).not.toContain(
      "--socks5-udp",
    ));

  it("does not disturb the credentials switch", () => {
    const out = args("socks5://u:p@h:1080", { socks5Udp: true });
    expect(out).toContain("--proxy-server=socks5://h:1080");
    expect(out).toContain("--socks5-credentials=u:p");
  });
});

describe("socks5UdpSupportWarning", () => {
  const w = (s: string | null, requested?: boolean, major?: number) =>
    socks5UdpSupportWarning(s === null ? null : parseProxy(s), requested, major);

  it("silent when not requested", () => {
    expect(w("socks5://u:p@h:1080", false, 151)).toBeNull();
    expect(w("socks5://u:p@h:1080", undefined, 151)).toBeNull();
  });
  it("silent on a build that supports it", () =>
    expect(w("socks5://u:p@h:1080", true, SOCKS5_UDP_MIN_MAJOR)).toBeNull());
  it("warns that an http proxy cannot relay UDP", () =>
    expect(w("http://u:p@h:8080", true, SOCKS5_UDP_MIN_MAJOR)).toMatch(/only applies to a SOCKS5/i));
  it("warns with no proxy at all", () =>
    expect(w(null, true, SOCKS5_UDP_MIN_MAJOR)).toMatch(/only applies to a SOCKS5/i));
  it("warns that an older MAJOR ignores it", () =>
    expect(w("socks5://u:p@h:1080", true, SOCKS5_UDP_MIN_MAJOR - 1)).toMatch(/needs Clearcote/i));
  // SOCKS4 predates the UDP ASSOCIATE command entirely, so the switch would be accepted and do
  // nothing — the same silent no-op as an http proxy, and worth the same warning.
  it("warns that a SOCKS4 proxy cannot relay UDP", () =>
    expect(w("socks4://h:1080", true, SOCKS5_UDP_MIN_MAJOR)).toMatch(/only applies to a SOCKS5/i));
  it("stays quiet when the major is unknown rather than guessing", () =>
    expect(w("socks5://u:p@h:1080", true, undefined)).toBeNull());
});
