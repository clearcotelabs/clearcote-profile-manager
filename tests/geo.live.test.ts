// Live geo resolution through a REAL proxy. Opt-in: set CLEARCOTE_TEST_PROXY to a proxy string and
// run the suite. Skipped otherwise, so CI never depends on someone's credentials or a third-party
// endpoint being up — and no credentials are committed here.
//
//   CLEARCOTE_TEST_PROXY="socks5://user:pass@host:1080" npm test
//
// Worth running by hand against an authenticated SOCKS5 proxy specifically: that is the shape that
// silently failed before (Electron's stock-Chromium stack cannot do RFC 1929 at all), leaving
// `location` unset so the browser reported the host's real position. A unit test with a local fake
// proves the protocol; only a real proxy proves the whole path.

import { describe, it, expect } from "vitest";
import { geoCheck } from "../electron/geo";
import { parseProxy } from "../electron/proxy";
import type { Profile } from "../electron/types";

const PROXY = process.env.CLEARCOTE_TEST_PROXY;
const profile = (proxy?: string): Profile =>
  ({ id: "live", name: "live", fingerprint: "seed", createdAt: "", updatedAt: "", proxy }) as Profile;

describe.skipIf(!PROXY)("geoCheck through a live proxy", () => {
  it("resolves the proxy's exit geo, not the host's", async () => {
    const direct = await geoCheck(profile(), 20000);
    const viaProxy = await geoCheck(profile(PROXY), 25000);

    expect(viaProxy.ok, viaProxy.error).toBe(true);
    expect(viaProxy.ip).toBeTruthy();
    expect(viaProxy.timezone).toBeTruthy();
    // The whole point: the answer must differ from the host's own egress. If these match, the
    // proxy was not used and every persona built on it leaks the real location.
    if (direct.ok) expect(viaProxy.ip).not.toBe(direct.ip);
  }, 60000);

  it("returns coordinates usable as --fingerprint-location", async () => {
    const r = await geoCheck(profile(PROXY), 25000);
    expect(r.ok, r.error).toBe(true);
    expect(typeof r.lat).toBe("number");
    expect(typeof r.lon).toBe("number");
    expect(`${r.lat},${r.lon}`).toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
  }, 60000);

  it("derives an Accept-Language coherent with the exit country", async () => {
    const r = await geoCheck(profile(PROXY), 25000);
    expect(r.ok, r.error).toBe(true);
    expect(r.acceptLanguage).toMatch(/^[a-z]{2}(-[A-Z]{2})?(,|$)/);
  }, 60000);

  it("reports bad credentials as an auth failure, not a generic timeout", async () => {
    const p = parseProxy(PROXY)!;
    if (!p.scheme.startsWith("socks") || !p.username) return; // only meaningful for authenticated SOCKS
    const broken = `${p.scheme}://${p.username}:definitely-not-the-password@${p.host}:${p.port}`;
    const r = await geoCheck(profile(broken), 25000);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/authentication failed/i);
  }, 60000);
});
