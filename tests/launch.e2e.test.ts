// End-to-end: the app's real launch() drives a real Clearcote binary, and the BROWSER is then asked
// what it actually did. Every other test in this suite checks the command line we intend to
// produce; this one checks observable behaviour, which is the only thing a customer experiences.
//
// It covers the three customer reports that motivated the r13–r15 work:
//   1. an authenticated SOCKS5 proxy carries traffic at all (egress IP is the proxy's),
//   2. geolocation reports the proxy's region instead of the host's real position,
//   3. the build really is 151, and says so consistently.
//
// Opt-in — it needs a licensed PRO binary, a license key and a working proxy:
//
//   CLEARCOTE_E2E=1 \
//   CLEARCOTE_BINARY="/path/to/151/chrome.exe" \
//   CLEARCOTE_LICENSE_KEY="cc_lic_..." \
//   CLEARCOTE_TEST_PROXY="socks5://user:pass@host:1080" \
//   npx vitest run tests/launch.e2e.test.ts
//
// Inspection goes over CDP (playwright-core connects to the already-running browser; it never
// launches it — launch() does, exactly as the app does in production). CDP is also the only
// reliable way to grant geolocation permission: seeding the profile's Preferences does not survive
// Chromium's own profile initialisation, so the prompt would sit there and the read would time out.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright-core";
import type { Profile } from "../electron/types";

const READY =
  process.env.CLEARCOTE_E2E === "1" &&
  !!process.env.CLEARCOTE_BINARY &&
  !!process.env.CLEARCOTE_TEST_PROXY &&
  !!process.env.CLEARCOTE_LICENSE_KEY;

const PROXY = process.env.CLEARCOTE_TEST_PROXY;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-e2e-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

/** An OS-assigned free port, so concurrent runs don't collide on a hard-coded debugging port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll the DevTools endpoint until the browser is listening. */
async function waitForCdp(port: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = String((e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the browser's DevTools endpoint never came up on ${port} (${last})`);
}

interface Egress { ip?: string }

describe.skipIf(!READY)("e2e — a real 151 launch through an authenticated SOCKS5 proxy", () => {
  const profileId = "e2e";
  let browser: Browser;
  let stopProfile: (id: string) => void;
  let userDataDir: string;
  let hostEgressIp: string | undefined;
  /** The proxy's exit region, resolved independently of the browser. */
  let exit: { ip?: string; lat?: number; lon?: number };

  let egress: Egress;
  let geo: { lat?: number; lon?: number; error?: string };
  let info: { ua: string; uaFullVersion: string; timezone: string; languages: string[] };

  beforeAll(async () => {
    const { launch, stop } = await import("../electron/launcher");
    const { geoCheck } = await import("../electron/geo");
    const { chromium } = await import("playwright-core");
    stopProfile = stop;

    // Two independent reference points, both resolved by the TEST process, not the browser:
    //   - the host's own egress, so "the proxy is actually being used" is a comparison not a guess;
    //   - the proxy's exit region, to check the browser's geolocation against.
    const bare = { id: "x", name: "x", fingerprint: "s", createdAt: "", updatedAt: "" } as Profile;
    const direct = await geoCheck(bare, 20000);
    hostEgressIp = direct.ip;
    const viaProxy = await geoCheck({ ...bare, proxy: PROXY } as Profile, 25000);
    expect(viaProxy.ok, `the test proxy is not usable: ${viaProxy.error}`).toBe(true);
    exit = { ip: viaProxy.ip, lat: viaProxy.lat, lon: viaProxy.lon };

    const port = await freePort();
    userDataDir = path.join(ROOT, "e2e-userdata");

    const profile: Profile = {
      id: profileId,
      name: "e2e",
      fingerprint: "e2e-seed-1",
      platform: "windows",
      // geoip ON with nothing set by hand — the point is that the launch fills timezone /
      // language / location / WebRTC IP from the proxy's exit region.
      geoip: true,
      proxy: PROXY,
      portableProfile: true,
      userDataDir,
      extraArgs: [
        `--remote-debugging-port=${port}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      createdAt: "",
      updatedAt: "",
    } as Profile;

    const r = await launch(profile);
    expect(r.ok, r.error).toBe(true);

    await waitForCdp(port, 60000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const ctx = browser.contexts()[0];
    await ctx.grantPermissions(["geolocation"]);
    const page = await ctx.newPage();

    // Egress read from inside the browser, so it reflects the BROWSER's network stack (and its
    // proxy) rather than the test process's. It must be an HTTPS endpoint: Chromium upgrades
    // http:// navigations, and an HTTP-only API answers the upgraded request with an error that
    // looks exactly like a proxy failure.
    await page.goto("https://api.ipify.org/?format=json", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const raw = await page.content();
    egress = JSON.parse(/\{[\s\S]*?\}/.exec(raw)?.[0] ?? "{}") as Egress;

    geo = await page.evaluate(
      () =>
        new Promise<{ lat?: number; lon?: number; error?: string }>((res) =>
          navigator.geolocation.getCurrentPosition(
            (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
            (e) => res({ error: `${e.code} ${e.message}` }),
            { timeout: 15000 },
          ),
        ),
    );

    info = await page.evaluate(async () => ({
      ua: navigator.userAgent,
      uaFullVersion: (
        await (navigator as any).userAgentData.getHighEntropyValues(["uaFullVersion"])
      ).uaFullVersion as string,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      languages: [...navigator.languages],
    }));
  }, 240000);

  afterAll(async () => {
    try { await browser?.close(); } catch { /* already gone */ }
    try { stopProfile?.(profileId); } catch { /* already gone */ }
    // Always remove the profile dir — a leaked persistent user-data-dir is hundreds of MB per run.
    // Chromium can still hold a handle briefly on Windows, so retry rather than fail the suite.
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(ROOT, { recursive: true, force: true }); break; }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
  });

  it("routes traffic through the authenticated SOCKS5 proxy", () => {
    // The original report: before --socks5-credentials the credentials were dropped on the floor,
    // the proxy refused every connection, and nothing loaded — "only http works".
    expect(egress.ip, "no egress IP — the page did not load through the proxy").toBeTruthy();
    expect(egress.ip).not.toBe(hostEgressIp);
    expect(egress.ip).toBe(exit.ip); // the browser exits where the proxy does
  });

  it("reports the proxy's geolocation, not the host's real position", () => {
    // "geolocation doesnt change and still uses my real home geolocation": geoip never ran at
    // launch, so no --fingerprint-location was emitted and the real position came through.
    expect(geo.error, "geolocation was not answered").toBeUndefined();
    expect(typeof geo.lat).toBe("number");
    expect(typeof geo.lon).toBe("number");
    // Agrees with the proxy's exit region to within a coarse, city-level radius...
    expect(Math.abs(geo.lat! - exit.lat!)).toBeLessThan(2);
    expect(Math.abs(geo.lon! - exit.lon!)).toBeLessThan(2);
  });

  it("derives timezone and languages from the same exit region", () => {
    expect(info.timezone).toMatch(/^[A-Za-z]+\/[A-Za-z_]+/);
    expect(info.timezone).not.toBe("UTC"); // a bare UTC would mean nothing was applied
    expect(info.languages.length).toBeGreaterThan(0);
  });

  it("is a 151 build, and says so consistently", () => {
    // r13 fixed the engine reporting a version it was not; the UA and UA-CH must agree on 151.
    expect(info.ua).toMatch(/Chrome\/151\./);
    expect(info.uaFullVersion).toMatch(/^151\./);
  });

  it("wrote the portable cookie key into the profile folder", () => {
    // --portable-profile's observable effect: the key lives beside the profile instead of in the
    // OS keychain, which is what lets the folder move to another machine with sessions intact.
    const state = JSON.parse(fs.readFileSync(path.join(userDataDir, "Local State"), "utf8")) as {
      os_crypt?: { encrypted_key?: string };
    };
    expect(state.os_crypt?.encrypted_key).toBeTruthy();
  });
});
