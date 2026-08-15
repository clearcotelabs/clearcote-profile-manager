// Does the ENGINE actually honour what the editor emits?
//
// Every other test here proves the app produces the right command line. That is a different claim
// from "the browser then does it", and the two have come apart before: tests/README.md records
// gpuVendor/gpuRenderer and location as declared-but-unread until v0.1.0-pre.10. That table was
// confirmed against the Chromium 149 build, and six options have been added since (portable
// profile, cookie key, shader dialect, Widevine, and the two narrow rendering switches), so it is
// re-checked here against the current engine.
//
// This launches through the app's own launcher — not a hand-built argv — so what is measured is
// what a user gets.
//
// Opt-in:
//   CLEARCOTE_E2E=1 CLEARCOTE_BINARY=<chrome.exe> CLEARCOTE_LICENSE_KEY=cc_lic_... \
//   npx vitest run tests/applied.e2e.test.ts
//
// A value that does NOT apply is a finding to report, not a test to soften.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright-core";
import type { Profile } from "../electron/types";

const READY =
  process.env.CLEARCOTE_E2E === "1" && !!process.env.CLEARCOTE_BINARY && !!process.env.CLEARCOTE_LICENSE_KEY;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-applied-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function waitForCdp(port: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`DevTools never came up on ${port}`);
}

// Gathered in SMALL, separate evaluates rather than one block. Two WebGL contexts created inside a
// single evaluate crashed the renderer outright ("Target crashed"), which reads as a launch failure
// and tells you nothing about which setting broke. One context, one concern per call.
const STEPS: Record<string, string> = {
  nav: `({
    platform: navigator.platform,
    ua: navigator.userAgent,
    brands: (navigator.userAgentData && navigator.userAgentData.brands || []).map(b => b.brand),
    cores: navigator.hardwareConcurrency,
    memory: navigator.deviceMemory,
    screen: [screen.width, screen.height],
    avail: [screen.availWidth, screen.availHeight],
    colorDepth: screen.colorDepth,
    dpr: window.devicePixelRatio,
    touch: navigator.maxTouchPoints,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    languages: [...navigator.languages],
    outer: [outerWidth, outerHeight]
  })`,
  uaData: `navigator.userAgentData.getHighEntropyValues(["platform","platformVersion","uaFullVersion"])`,
  quota: `navigator.storage.estimate().then(q => q.quota)`,
  glStrings: `(() => {
    const g = document.createElement("canvas").getContext("webgl");
    const d = g && g.getExtension("WEBGL_debug_renderer_info");
    return d ? { vendor: g.getParameter(d.UNMASKED_VENDOR_WEBGL), renderer: g.getParameter(d.UNMASKED_RENDERER_WEBGL) } : null;
  })()`,
  // A fixed drawing, so the only thing that can move its hash is farbling.
  canvas2d: `(() => {
    const h = (s) => { let n = 0; for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) | 0; return String(n); };
    const c = document.createElement("canvas"); c.width = 220; c.height = 60;
    const x = c.getContext("2d");
    x.textBaseline = "top"; x.font = "16px system-ui";
    x.fillStyle = "#f60"; x.fillRect(10, 5, 90, 30);
    x.fillStyle = "#0af"; x.fillText("clearcote-probe", 12, 20);
    return h(c.toDataURL());
  })()`,
  webglPixels: `(() => {
    const h = (s) => { let n = 0; for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) | 0; return String(n); };
    const g = document.createElement("canvas").getContext("webgl");
    g.clearColor(0.2, 0.4, 0.6, 1); g.clear(g.COLOR_BUFFER_BIT);
    const px = new Uint8Array(4 * 64);
    g.readPixels(0, 0, 8, 8, g.RGBA, g.UNSIGNED_BYTE, px);
    return h(Array.from(px).join(","));
  })()`,
  geo: `new Promise((res) => navigator.geolocation.getCurrentPosition(
    (p) => res({ lat: p.coords.latitude, lon: p.coords.longitude }),
    (e) => res({ error: e.code + " " + e.message }), { timeout: 8000 }))`,
};

interface Probe {
  platform: string; ua: string; brands: string[]; cores: number; memory: number;
  screen: [number, number]; avail: [number, number]; colorDepth: number; dpr: number; touch: number;
  timezone: string; languages: string[]; outer: [number, number];
  uaPlatform?: string; uaPlatformVersion?: string; uaFullVersion?: string;
  quota: number | null;
  glVendor: string | null; glRenderer: string | null;
  canvas2d: string; webglPixels: string;
  geo: { lat?: number; lon?: number; error?: string } | null;
}

/** Launch through the app's own launcher, read the probe, shut down. */
async function measure(over: Partial<Profile>, id: string): Promise<Probe> {
  const { launch, stop } = await import("../electron/launcher");
  const { chromium } = await import("playwright-core");
  const port = await freePort();
  const userDataDir = path.join(ROOT, id);

  const profile = {
    id,
    name: id,
    fingerprint: "applied-seed-1",
    userDataDir,
    extraArgs: [`--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", "about:blank"],
    createdAt: "",
    updatedAt: "",
    ...over,
  } as Profile;

  const r = await launch(profile);
  expect(r.ok, `${id}: ${r.error}`).toBe(true);
  await waitForCdp(port, 60000);

  let browser: Browser | undefined;
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const ctx = browser.contexts()[0];
    await ctx.grantPermissions(["geolocation"], { origin: "https://example.com" });
    const page = await ctx.newPage();
    await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 60000 });

    const out: Record<string, unknown> = {};
    for (const [name, src] of Object.entries(STEPS)) {
      try {
        out[name] = await page.evaluate(src);
      } catch (e) {
        // Record the failure rather than aborting: one unreadable surface must not hide the
        // fifteen settings that ARE measurable.
        out[name] = { error: String((e as Error).message).split("\n")[0] };
      }
    }
    const nav = out.nav as Record<string, unknown>;
    const uaData = (out.uaData ?? {}) as Record<string, string>;
    const gl = (out.glStrings ?? null) as { vendor: string; renderer: string } | null;
    return {
      ...(nav as unknown as Probe),
      uaPlatform: uaData.platform,
      uaPlatformVersion: uaData.platformVersion,
      uaFullVersion: uaData.uaFullVersion,
      quota: typeof out.quota === "number" ? out.quota : null,
      glVendor: gl?.vendor ?? null,
      glRenderer: gl?.renderer ?? null,
      canvas2d: String(out.canvas2d),
      webglPixels: String(out.webglPixels),
      geo: out.geo as Probe["geo"],
    };
  } finally {
    try { await browser?.close(); } catch { /* already gone */ }
    try { stop(id); } catch { /* already gone */ }
    await new Promise((res) => setTimeout(res, 800));
  }
}

describe.skipIf(!READY)("does the engine honour what the editor emits?", () => {
  // One persona with a distinctive value for every page-observable setting, so a value that did not
  // apply cannot be mistaken for a coincidence.
  const SET: Partial<Profile> = {
    platform: "windows",
    platformVersion: "15.0.0",
    brand: "Chrome",
    hardwareConcurrency: 12,
    deviceMemory: 16,
    screenWidth: 2560,
    screenHeight: 1440,
    availWidth: 2560,
    availHeight: 1400,
    colorDepth: 24,
    devicePixelRatio: 1,
    maxTouchPoints: 0,
    timezone: "Asia/Tokyo",
    acceptLanguage: "ja-JP,ja",
    location: "35.6762,139.6503",
    storageQuota: 250000,
    gpuVendor: "Google Inc. (NVIDIA)",
    gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  } as Partial<Profile>;

  let full: Probe;
  let realStrings: Probe;
  let canvasOff: Probe;
  let noiseOff: Probe;

  beforeAll(async () => {
    full = await measure(SET, "full");
    // Same persona, but asking for the REAL WebGL strings only.
    realStrings = await measure({ ...SET, gpuStringSpoof: false } as Partial<Profile>, "realstrings");
    // Same persona, 2D canvas farble off — WebGL readback must stay noised.
    canvasOff = await measure({ ...SET, canvasNoise: false } as Partial<Profile>, "canvasoff");
    // Same persona, farbling off process-wide.
    noiseOff = await measure({ ...SET, fingerprintNoise: false } as Partial<Profile>, "noiseoff");
  }, 400000);

  afterAll(() => {
    for (let i = 0; i < 10; i++) {
      try { fs.rmSync(ROOT, { recursive: true, force: true }); break; }
      catch { /* Chromium can hold a handle briefly on Windows */ }
    }
  });

  it("platform + platform version", () => {
    expect(full.platform).toBe("Win32");
    expect(full.uaPlatform).toBe("Windows");
    expect(full.ua).toContain("Windows NT");
    expect(full.uaPlatformVersion).toBe("15.0.0");
  });

  it("brand", () => expect(full.brands.join(",")).toContain("Google Chrome"));

  it("hardware concurrency and device memory", () => {
    expect(full.cores).toBe(12);
    // 16 is an ordinary desktop value: Chromium clamps deviceMemory to 2-32 on desktop (1-8 on
    // Android). The 8 GB ceiling in the original W3C text was raised in crbug.com/454354290.
    expect(full.memory).toBe(16);
  });

  it("the engine sanitizes deviceMemory to what Chromium can report", async () => {
    // The editor cannot produce an incoherent value here even if asked: the engine quantizes to a
    // power of two and clamps to the desktop range. Pinned because it is why the app needs no rule
    // of its own — if a future build stopped clamping, this fails and one would be warranted.
    const over = await measure({ ...SET, deviceMemory: 64 } as Partial<Profile>, "over");
    expect(over.memory, "64 should clamp to the desktop maximum").toBe(32);
  }, 120000);

  it("screen and avail dimensions", () => {
    expect(full.screen).toEqual([2560, 1440]);
    expect(full.avail).toEqual([2560, 1400]);
  });

  it("colour depth, pixel ratio and touch points", () => {
    expect(full.colorDepth).toBe(24);
    expect(full.dpr).toBe(1);
    expect(full.touch).toBe(0);
  });

  it("timezone", () => expect(full.timezone).toBe("Asia/Tokyo"));

  it("accept-language reaches navigator.languages", () => expect(full.languages[0]).toBe("ja-JP"));

  it("storage quota", () => {
    // Reported in bytes; the setting is in MB.
    expect(full.quota).toBeGreaterThan(200_000 * 1024 * 1024);
  });

  it("geolocation", () => {
    expect(full.geo?.error, "geolocation was not answered").toBeUndefined();
    expect(full.geo?.lat).toBeCloseTo(35.6762, 2);
    expect(full.geo?.lon).toBeCloseTo(139.6503, 2);
  });

  it("GPU vendor and renderer strings", () => {
    expect(full.glVendor).toBe("Google Inc. (NVIDIA)");
    expect(full.glRenderer).toContain("RTX 3060");
  });

  it("the window frame is coherent with the claimed screen (r16 + the frame fix)", () => {
    // outerHeight must not exceed the work area the persona claims to sit in.
    expect(full.outer[1]).toBeLessThanOrEqual(full.avail[1]);
    expect(full.outer[0]).toBeLessThanOrEqual(full.avail[0]);
  });

  it("gpuStringSpoof:false reports the REAL GPU strings, and changes nothing else", () => {
    expect(realStrings.glRenderer).not.toBe(full.glRenderer);
    expect(realStrings.glRenderer).not.toContain("RTX 3060");
    // The rest of the persona is untouched — that is the whole point of the narrow switch.
    expect(realStrings.cores).toBe(12);
    expect(realStrings.screen).toEqual([2560, 1440]);
    expect(realStrings.timezone).toBe("Asia/Tokyo");
  });

  it("canvasNoise:false changes the 2D canvas, and leaves WebGL readback noised", () => {
    expect(canvasOff.canvas2d).not.toBe(full.canvas2d);
    expect(canvasOff.webglPixels).toBe(full.webglPixels);
  });

  it("fingerprintNoise:false turns farbling off process-wide", () => {
    expect(noiseOff.canvas2d).not.toBe(full.canvas2d);
    // With farbling off entirely, the 2D canvas agrees with the canvas-only switch.
    expect(noiseOff.canvas2d).toBe(canvasOff.canvas2d);
  });
});
