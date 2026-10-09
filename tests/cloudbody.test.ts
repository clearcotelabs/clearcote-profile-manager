// electron/cloudbody.ts: what a profile becomes in the cloud. The body must be what the hosted API
// accepts (its parser's rules are repeated in cloudbody.ts and pinned here), and anything it would
// refuse must be refused here first, naming the setting, before a session is created and billed.

import { describe, it, expect } from "vitest";
import {
  cloudExit,
  cloudIdentity,
  cloudLocale,
  cloudProfileName,
  cloudSessionPlan,
  localOnlySettings,
  CLOUD_IDLE_SEC,
  PROFILE_RE,
  SEED_RE,
  type CloudInput,
} from "../electron/cloudbody";

const base = (over: Partial<CloudInput> = {}): CloudInput => ({ id: "acct-1", name: "Account 1", fingerprint: "user-7423", ...over });
const plan = (over: Partial<CloudInput> = {}) => {
  const r = cloudSessionPlan(base(over));
  if (!r.ok) throw new Error(`expected a plan, got: ${r.error}`);
  return r;
};
const refusal = (over: Partial<CloudInput>) => {
  const r = cloudSessionPlan(base(over));
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.body)}`);
  return r;
};

describe("a plain profile", () => {
  it("runs as itself: its seed as the identity, kept alive, cookies kept, on the included IP", () => {
    const r = plan();
    expect(r.body).toEqual({
      identity: "user-7423",
      lightStealth: false,
      proxy: "managed",
      profile: { name: "pm-acct-1", persist: true },
      keepAlive: true,
      idleTimeoutSec: CLOUD_IDLE_SEC,
      note: "Profile Manager: Account 1",
    });
    expect(r.exit).toEqual({ kind: "managed" });
    expect(r.cookies).toBe("pm-acct-1");
    expect(r.localOnly).toEqual([]);
  });

  it("idles out after the API's maximum, 30 minutes", () => {
    expect(CLOUD_IDLE_SEC).toBe(1800);
  });

  it("carries the persona the profile sets", () => {
    const r = plan({ platform: "macos", brand: "Edge", timezone: "Europe/Berlin", acceptLanguage: "de-DE,de;q=0.9,en;q=0.5", geoip: true, lightStealth: true });
    expect(r.body).toMatchObject({ platform: "macos", brand: "Edge", timezone: "Europe/Berlin", locale: "de-DE,de,en", geoip: true, lightStealth: true });
  });

  it("leaves geoip to the service unless the profile turned it on", () => {
    expect(plan().body).not.toHaveProperty("geoip");
    expect(plan({ geoip: false }).body).not.toHaveProperty("geoip");
  });

  it("pins a version only when the profile does", () => {
    expect(plan({ browserVersion: "latest" }).body).not.toHaveProperty("version");
    expect(plan({ browserVersion: "LATEST" }).body).not.toHaveProperty("version");
    expect(plan({ browserVersion: "153" }).body.version).toBe("153");
    expect(plan({ browserVersion: "152.0.7977.82-r21" }).body.version).toBe("152.0.7977.82-r21");
    expect(plan({ browserVersion: "r21" }).body.version).toBe("r21");
  });

  it("opens its start page, normalised", () => {
    expect(plan({ startUrl: "https://example.com" }).body.url).toBe("https://example.com/");
    expect(plan({ startUrl: "  http://example.com/a?b=1  " }).body.url).toBe("http://example.com/a?b=1");
  });

  it("labels the session with the profile's name, cut and cleaned", () => {
    expect(plan({ name: "  Shop\tEU\n" }).body.note).toBe("Profile Manager: Shop EU");
    const long = plan({ name: "x".repeat(400) }).body.note as string;
    expect(long.length).toBe(256);
    expect(long.endsWith("…")).toBe(true);
    expect(plan({ name: "" }).body.note).toBe("Profile Manager: acct-1");
  });
});

describe("identity", () => {
  it("is the seed when the API accepts it", () => {
    for (const seed of ["user-7423", "a", "Acct.1:EU_2", "x".repeat(64)]) expect(cloudIdentity({ id: "p", fingerprint: seed })).toBe(seed);
  });

  it("is a stable hash of the seed when the API would refuse it", () => {
    const odd = cloudIdentity({ id: "p", fingerprint: "my seed with spaces/and slashes" });
    expect(odd).toMatch(/^pm-[0-9a-f]{24}$/);
    expect(SEED_RE.test(odd)).toBe(true);
    expect(cloudIdentity({ id: "p", fingerprint: "my seed with spaces/and slashes" })).toBe(odd);
    expect(cloudIdentity({ id: "p", fingerprint: "another seed!" })).not.toBe(odd);
    expect(cloudIdentity({ id: "p", fingerprint: "x".repeat(65) })).toMatch(/^pm-[0-9a-f]{24}$/);
  });

  it("falls back to the profile id for an empty seed, so two empty seeds are two devices", () => {
    const a = cloudIdentity({ id: "a", fingerprint: "  " });
    const b = cloudIdentity({ id: "b", fingerprint: "" });
    expect(a).not.toBe(b);
    expect(SEED_RE.test(a) && SEED_RE.test(b)).toBe(true);
  });
});

describe("the cloud profile that keeps cookies", () => {
  it("is pm-<id> when that is a valid name", () => {
    expect(cloudProfileName("acct-1")).toBe("pm-acct-1");
    expect(cloudProfileName("a.b_c-d")).toBe("pm-a.b_c-d");
  });

  it("is a shortened, hashed name for ids the API refuses, and never collides", () => {
    const names = ["Bank (EU)", "Bank [EU]", "Bänk EU", "x".repeat(120), "a b"].map(cloudProfileName);
    for (const n of names) expect(PROFILE_RE.test(n), n).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(cloudProfileName("Bank (EU)")).toBe(cloudProfileName("Bank (EU)"));
  });

  it("is left out when the profile does not keep cookies in the cloud", () => {
    const r = plan({ cloud: { keepCookies: false } });
    expect(r.body).not.toHaveProperty("profile");
    expect(r.cookies).toBeNull();
  });
});

describe("where the traffic leaves", () => {
  it("uses the profile's http proxy, with the credentials as separate fields", () => {
    const r = plan({ proxy: "http://us%40er:p%3Ass@proxy.example.com:8080" });
    expect(r.body.proxy).toEqual({ server: "http://proxy.example.com:8080", username: "us@er", password: "p:ss" });
    expect(r.exit).toEqual({ kind: "profile", proxy: "http://proxy.example.com:8080" });
    expect(r.body).not.toHaveProperty("country");
  });

  it("uses socks5 and socks5h proxies, and the legacy object form", () => {
    expect(plan({ proxy: "socks5://u:p@10.0.0.2:1080" }).body.proxy).toEqual({ server: "socks5://10.0.0.2:1080", username: "u", password: "p" });
    expect(plan({ proxy: "socks5h://gate.example:7000" }).body.proxy).toEqual({ server: "socks5h://gate.example:7000" });
    expect(plan({ proxy: { server: "proxy.example:3128", username: "u", password: "p" } }).body.proxy).toEqual({
      server: "http://proxy.example:3128",
      username: "u",
      password: "p",
    });
  });

  it("always sends an explicit port (the API needs one)", () => {
    expect((plan({ proxy: "socks5://proxy.example" }).body.proxy as { server: string }).server).toBe("socks5://proxy.example:1080");
    // A port-less http proxy means port 80, which the service cannot take yet (see below).
    expect(refusal({ proxy: "http://proxy.example" })).toMatchObject({ field: "proxy", error: expect.stringMatching(/port 80/) });
  });

  it("keeps an IPv6 proxy host in brackets, exactly once", () => {
    expect((plan({ proxy: "http://[2001:db8::1]:8080" }).body.proxy as { server: string }).server).toBe("http://[2001:db8::1]:8080");
  });

  it("refuses proxies the cloud cannot use, and says what to do instead", () => {
    for (const proxy of ["https://proxy.example:443", "socks4://proxy.example:1080", "socks://proxy.example:1080"]) {
      const r = refusal({ proxy });
      expect(r.field).toBe("proxy");
      expect(r.error).toMatch(/http:\/\/ or socks5:\/\//);
      expect(r.error).toMatch(/included residential IP/);
    }
    expect(refusal({ proxy: `http://${"u".repeat(256)}:p@proxy.example:8080` }).error).toMatch(/username is longer than 255 bytes/);
  });

  it("refuses an http proxy on port 80, which the service cannot take yet", () => {
    // The service parses the server with WHATWG URL, which drops http's default port and then
    // refuses it as missing ("proxy.server needs an explicit port").
    const r = refusal({ proxy: "http://u:p@proxy.example:80" });
    expect(r.field).toBe("proxy");
    expect(r.error).toMatch(/port 80/);
    // socks5 on 80 is fine (not a scheme with a default port), and so is http on any other port.
    expect((plan({ proxy: "socks5://proxy.example:80" }).body.proxy as { server: string }).server).toBe("socks5://proxy.example:80");
    expect((plan({ proxy: "http://proxy.example:8080" }).body.proxy as { server: string }).server).toBe("http://proxy.example:8080");
  });

  it("can use the included IP instead of the profile's proxy, and then lists the proxy as not used", () => {
    const r = plan({ proxy: "http://u:p@proxy.example:8080", cloud: { exit: "managed", country: "DE" } });
    expect(r.body.proxy).toBe("managed");
    expect(r.body.country).toBe("de");
    expect(r.exit).toEqual({ kind: "managed", country: "de" });
    expect(r.localOnly).toContain("This profile's proxy");
    expect(JSON.stringify(r.body)).not.toContain("proxy.example");
  });

  it("defaults to the profile's proxy when it has one, the included IP otherwise", () => {
    expect(cloudExit({ proxy: "http://p.example:1" })).toBe("profile");
    expect(cloudExit({})).toBe("managed");
    expect(cloudExit({ proxy: "not a proxy at all :::" })).toBe("managed");
    expect(cloudExit({ proxy: "http://p.example:1", cloud: { exit: "managed" } })).toBe("managed");
  });

  it("asks for the included IP when 'profile' is chosen but there is no proxy", () => {
    const r = refusal({ cloud: { exit: "profile" } });
    expect(r.field).toBe("cloud");
    expect(r.error).toMatch(/no proxy/);
  });

  it("checks the country code", () => {
    expect(plan({ cloud: { country: " us " } }).body.country).toBe("us");
    expect(plan({ cloud: { country: "" } }).body).not.toHaveProperty("country");
    for (const country of ["usa", "u", "1a", "gb-eng"]) expect(refusal({ cloud: { country } }).error).toMatch(/2-letter country code/);
  });
});

describe("cost and recording", () => {
  it("passes a traffic cap within the API's range", () => {
    expect(plan({ cloud: { maxGb: 0.5 } }).body.maxGb).toBe(0.5);
    expect(plan({ cloud: { maxGb: 0.001 } }).body.maxGb).toBe(0.001);
    expect(plan({ cloud: { maxGb: 1000 } }).body.maxGb).toBe(1000);
    for (const maxGb of [0, -1, 0.0001, 1001, Number.NaN, Infinity]) expect(refusal({ cloud: { maxGb } }).error).toMatch(/traffic cap/);
  });

  it("passes adblock and recording only when on", () => {
    expect(plan({ cloud: { adblock: true, record: true } }).body).toMatchObject({ adblock: true, record: true });
    const off = plan({ cloud: { adblock: false, record: false } }).body;
    expect(off).not.toHaveProperty("adblock");
    expect(off).not.toHaveProperty("record");
  });
});

describe("refusals the API would make, made here first", () => {
  it.each([
    [{ platform: "solaris" }, "platform"],
    [{ brand: "Firefox" }, "brand"],
    [{ timezone: "Mars/Olympus Mons" }, "timezone"],
    [{ timezone: "EST5EDT; drop table" }, "timezone"],
    [{ acceptLanguage: "english please" }, "acceptLanguage"],
    [{ browserVersion: "../../etc" }, "browserVersion"],
    [{ startUrl: "file:///C:/secret.txt" }, "startUrl"],
    [{ startUrl: "javascript:alert(1)" }, "startUrl"],
    [{ startUrl: `https://example.com/${"a".repeat(2100)}` }, "startUrl"],
  ] as [Partial<CloudInput>, string][])("%j is refused with field %s", (over, field) => {
    const r = refusal(over);
    expect(r.field).toBe(field);
    expect(r.error.length).toBeGreaterThan(10);
  });

  it("accepts every valid timezone shape and up to six language tags", () => {
    for (const timezone of ["UTC", "Europe/Amsterdam", "America/Argentina/Buenos_Aires", "Etc/GMT+5"]) expect(plan({ timezone }).body.timezone).toBe(timezone);
    expect(cloudLocale("a1,en")).toBeUndefined();
    expect(cloudLocale("en-US,en,de,fr,es,it,pt")).toBe("en-US,en,de,fr,es,it");
    expect(cloudLocale("")).toBeUndefined();
  });
});

describe("settings that stay on this PC", () => {
  it("names every local-only setting the profile uses", () => {
    const all = localOnlySettings({
      ...base(),
      fingerprintProfile: "x.json",
      gpuVendor: "NVIDIA",
      hardwareConcurrency: 8,
      deviceMemory: 8,
      screenWidth: 1920,
      colorDepth: 24,
      devicePixelRatio: 1.25,
      maxTouchPoints: 0,
      platformVersion: "15.0.0",
      brandVersion: "153.0.0.0",
      tlsProfile: "native",
      location: "1,2",
      webrtcIp: "1.2.3.4",
      webrtcMdns: "off",
      disableGpuFingerprint: true,
      fingerprintNoise: false,
      gpuStringSpoof: false,
      canvasNoise: false,
      storageQuota: 250000,
      canvasBridgeUrl: "ws://bridge",
      portableProfile: true,
      widevine: true,
      shaderDialect: "hlsl",
      socks5Udp: true,
      transparentProxy: true,
      blockThirdPartyCookies: true,
      extraArgs: ["--foo"],
    });
    expect(all).toEqual([
      "Captured fingerprint",
      "GPU vendor and renderer",
      "CPU cores",
      "Device memory",
      "Screen size",
      "Colour depth",
      "Pixel ratio",
      "Touch points",
      "Platform version",
      "Brand version",
      "TLS profile",
      "Geolocation",
      "WebRTC IP",
      "WebRTC mDNS off",
      "Use real GPU",
      "Noise off",
      "Real GPU strings",
      "Canvas noise off",
      "Storage quota",
      "Canvas bridge",
      "Portable profile",
      "Shader dialect",
      "SOCKS5 UDP",
      "Transparent proxy",
      "Third-party cookies blocked",
      "Extra switches",
    ]);
  });

  it("does not list Widevine: new profiles have it on and the cloud loads the CDM itself", () => {
    expect(localOnlySettings(base({ widevine: true }))).toEqual([]);
  });

  it("lists GeoIP off only when the cloud would follow the exit IP anyway", () => {
    // The service turns geoip on for a session with no timezone and no language of its own.
    expect(localOnlySettings(base({ geoip: false }))).toEqual(["GeoIP off"]);
    expect(plan({ geoip: false }).body).not.toHaveProperty("geoip");
    // With either set, nothing is followed automatically, as on this PC.
    expect(localOnlySettings(base({ geoip: false, timezone: "Europe/Berlin" }))).toEqual([]);
    expect(localOnlySettings(base({ geoip: false, acceptLanguage: "de-DE" }))).toEqual([]);
    expect(localOnlySettings(base({ geoip: true }))).toEqual([]);
  });

  it("does not count defaults: noise on, mDNS on, touch points unset", () => {
    expect(localOnlySettings(base({ fingerprintNoise: true, webrtcMdns: "on", gpuStringSpoof: true, canvasNoise: true, extraArgs: [] }))).toEqual([]);
  });

  it("never puts a local-only value into the body", () => {
    const body = JSON.stringify(plan({ fingerprintProfile: "secret-machine.json", canvasBridgeUrl: "ws://bridge", encryptionKey: "k3y", extraArgs: ["--x"] }).body);
    expect(body).not.toMatch(/secret-machine|bridge|k3y|--x/);
  });
});
