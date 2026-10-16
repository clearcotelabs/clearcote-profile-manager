// geoCheck's sources (electron/geo.ts): the exit IP from an IP echo, the region from the offline
// database, ip-api.com only on opt-in. A local echo server stands in for api.ipify.org.

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { echoUrls, geoCheck, ipapiEnabled, ipFromEcho } from "../electron/geo";
import { mmdbPath } from "../electron/geodb";
import type { Profile } from "../electron/types";

describe("echo parsing and settings", () => {
  it("reads plain text and JSON answers", () => {
    expect(ipFromEcho("85.214.132.117\n")).toBe("85.214.132.117");
    expect(ipFromEcho('{"ip":"1.2.3.4"}')).toBe("1.2.3.4");
    expect(ipFromEcho('{"query":"2a01:4f8::1"}')).toBe("2a01:4f8::1");
    expect(ipFromEcho("{not json")).toBe("");
  });
  it("uses ipify then icanhazip unless CLEARCOTE_GEOIP_ECHO_URL replaces them", () => {
    expect(echoUrls({})).toEqual(["http://api.ipify.org", "http://icanhazip.com"]);
    expect(echoUrls({ CLEARCOTE_GEOIP_ECHO_URL: " http://a/ip , http://b " })).toEqual(["http://a/ip", "http://b"]);
  });
  it("asks ip-api.com only on opt-in", () => {
    expect(ipapiEnabled({})).toBe(false);
    expect(ipapiEnabled({ CLEARCOTE_GEOIP_IPAPI: "1" })).toBe(true);
    expect(ipapiEnabled({ CLEARCOTE_GEOIP_IPAPI: "no" })).toBe(false);
  });
});

describe.skipIf(!fs.existsSync(mmdbPath()))("geoCheck with a local echo and the cached database", () => {
  let server: http.Server;
  let answer = "";
  const hits: string[] = [];
  const saved = process.env.CLEARCOTE_GEOIP_ECHO_URL;
  const profile = { id: "t", name: "t" } as Profile;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      res.end(answer);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    process.env.CLEARCOTE_GEOIP_ECHO_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ip`;
  });
  afterEach(() => {
    hits.length = 0;
  });
  afterAll(() => {
    server.close();
    if (saved === undefined) delete process.env.CLEARCOTE_GEOIP_ECHO_URL;
    else process.env.CLEARCOTE_GEOIP_ECHO_URL = saved;
  });

  it("resolves the echoed IP in the database, with no ip-api call", async () => {
    answer = "85.214.132.117\n";
    const r = await geoCheck(profile, 10000);
    expect(r).toMatchObject({ ok: true, ip: "85.214.132.117", countryCode: "DE", timezone: "Europe/Berlin" });
    expect(r.acceptLanguage?.startsWith("de-DE")).toBe(true);
    expect(r.lat).toBeTypeOf("number");
    expect(hits).toEqual(["/ip"]);
  });

  it("says so when the echo does not answer with an address", async () => {
    answer = "<html>blocked</html>";
    const r = await geoCheck(profile, 10000);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not answer with an IP address/);
  });

  it("reports an address the database has no region for", async () => {
    answer = "10.1.2.3";
    const r = await geoCheck(profile, 10000);
    expect(r).toMatchObject({ ok: false, ip: "10.1.2.3" });
    expect(r.error).toMatch(/no region data/);
  });
});
