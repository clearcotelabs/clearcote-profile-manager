// End-to-end for the Device profiles page, in a real browser against `next dev` and the renderer's in-browser mock
// (src/lib/ipc.ts): localStorage ["clearcote.mock.gpu"] plays this computer's GPU and ["clearcote.mock.library"]
// the clearcote-profiles index, so no network is needed.
//
// What only a browser shows: the best matches for an NVIDIA computer come first with their reasons, another maker's
// devices are hidden until asked for, "Create N" makes N profiles on N different devices, and "Assign devices…" on
// selected profiles gives each its own while one that already has a device keeps it. The optional full library:
// added, it lists its devices after the samples a page at a time, and its device goes on a profile; removed, gone.
//
//   npm run next:dev -- -p 3100
//   CLEARCOTE_UI_E2E=1 CLEARCOTE_UI_BROWSER=<chrome.exe> npx vitest run tests/devices.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";
const T = 40000;
const NVIDIA_HOST = { vendor: "nvidia", name: "NVIDIA GeForce RTX 3070", deviceId: 0x2484 };
const RAW = "https://raw.githubusercontent.com/clearcotelabs/clearcote-profiles/main/samples";
const dev = (id: string, renderer: string, screen = "1920x1080", cores = 8) => ({
  name: `${id}.json`,
  downloadUrl: `${RAW}/${id}.json`,
  gpuVendor: /NVIDIA/.test(renderer) ? "NVIDIA" : /AMD/.test(renderer) ? "AMD" : "Intel",
  renderer,
  screen,
  cores,
  memory: 8,
});
const LIBRARY = [
  dev("d-3060", "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)"),
  dev("d-3080", "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 (0x00002206) Direct3D11 vs_5_0 ps_5_0, D3D11)", "2560x1440"),
  dev("d-4070", "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)"),
  dev("d-1650", "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F82) Direct3D11 vs_5_0 ps_5_0, D3D11)"),
  dev("d-uhd", "ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)"),
  dev("d-apu", "ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)"),
];
const prof = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  fingerprint: `seed${id}`,
  platform: "windows",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

interface Seed {
  profiles?: Record<string, unknown>[];
  /** This computer's GPU, as host:gpu reports it (default: an RTX 3070). */
  gpu?: Record<string, unknown>;
}

describe.skipIf(!READY)("Device profiles page — in a real browser", () => {
  let browser: Browser;
  const open: BrowserContext[] = [];

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true, executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined, args: ["--no-sandbox"] });
  }, 120000);
  afterAll(async () => {
    for (const c of open) await c.close().catch(() => {});
    await browser?.close();
  }, 30000);

  async function fresh(seed: Seed = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    open.push(ctx);
    await ctx.addInitScript(
      (s: { seed: Seed; gpu: unknown; library: unknown }) => {
        if (sessionStorage.getItem("__seeded")) return;
        sessionStorage.setItem("__seeded", "1");
        localStorage.clear();
        if (s.seed.profiles) localStorage.setItem("clearcote.profiles.mock", JSON.stringify(s.seed.profiles));
        localStorage.setItem("clearcote.mock.gpu", JSON.stringify(s.gpu));
        localStorage.setItem("clearcote.mock.library", JSON.stringify(s.library));
        // A machine with 16 threads, whatever runs the test.
        Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 16 });
      },
      { seed, gpu: seed.gpu ?? NVIDIA_HOST, library: LIBRARY },
    );
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
    return { page, errors };
  }

  async function until<V>(read: () => Promise<V>, ok: (v: V) => boolean, what: string, ms = 8000): Promise<V> {
    const end = Date.now() + ms;
    let last: V = await read();
    while (!ok(last)) {
      if (Date.now() > end) throw new Error(`${what}: last saw ${JSON.stringify(last)}`);
      await new Promise((r) => setTimeout(r, 60));
      last = await read();
    }
    return last;
  }

  const stored = (page: Page) =>
    page.evaluate(() =>
      (JSON.parse(localStorage.getItem("clearcote.profiles.mock") || "[]") as Array<Record<string, string>>).map((p) => ({
        id: p.id,
        name: p.name,
        group: p.group,
        device: p.fingerprintProfile,
      })),
    );

  async function openDevices(page: Page) {
    await page.click('[data-nav-devices="1"]');
    await page.waitForSelector('[data-devices-best="1"] [data-device]');
  }

  it("ranks for this computer: the same generation first, other makers hidden until asked for", async () => {
    const { page, errors } = await fresh({ profiles: [prof("alpha", { fingerprintProfile: "d-3060.json" })] });
    await openDevices(page);
    expect(await page.textContent('[data-devices-host="1"]')).toContain("NVIDIA GeForce RTX 3070 · 16 threads");
    const best = await page.$$eval('[data-devices-best="1"] [data-device]', (els) => els.map((e) => e.getAttribute("data-device")));
    // RTX 3080 (same generation, unused) beats the RTX 3060 alpha already uses; Intel and AMD are not there.
    expect(best[0]).toBe("d-3080.json");
    expect(best).not.toContain("d-uhd.json");
    expect(best).not.toContain("d-apu.json");
    expect(await page.getAttribute('[data-device="d-3060.json"] [data-device-used]', "data-device-used")).toBe("1");
    const all = () => page.$$eval('[data-devices-all="1"] [data-device]', (els) => els.length);
    expect(await all()).toBe(4);
    await page.click('[data-devices-only-fit="1"]');
    expect(await until(all, (n) => n === 6, "all devices once others are shown")).toBe(6);
    // The detail panel says why a device does not fit.
    await page.click('[data-devices-all="1"] [data-device="d-uhd.json"] button');
    const detail = await page.textContent('[data-devices-all="1"] [data-device="d-uhd.json"] [data-device-detail]');
    expect(detail).toContain("Different GPU maker (Intel) than this computer (NVIDIA)");
    expect(errors).toEqual([]);
  }, T);

  it("Create N makes N profiles, each on its own unused device, named and grouped", async () => {
    const { page, errors } = await fresh({ profiles: [prof("alpha", { fingerprintProfile: "d-3060.json" })] });
    await openDevices(page);
    await page.fill("#devices-count", "5");
    await page.fill('[data-devices-create="1"] input[placeholder^="Name"]', "Shop");
    await page.fill('[data-devices-create="1"] input[placeholder^="Group"]', "Stores");
    // Only 3 unused NVIDIA devices are left (alpha has the 3060): it says so and makes 3.
    expect(await page.textContent('[data-devices-short="1"]')).toContain("Only 3 unused devices");
    await page.click('[data-devices-create-run="1"]');
    const made = await until(() => stored(page), (ps) => ps.length === 4, "three new profiles");
    const fresh3 = made.filter((p) => p.id !== "alpha");
    expect(fresh3.map((p) => p.name).sort()).toEqual(["Shop 01", "Shop 02", "Shop 03"]);
    expect(fresh3.every((p) => p.group === "Stores")).toBe(true);
    expect(new Set(fresh3.map((p) => p.device)).size).toBe(3);
    expect(fresh3.map((p) => p.device)).not.toContain("d-3060.json");
    expect(errors).toEqual([]);
  }, T);

  it("Assign devices… gives each selected profile its own device and leaves one that has a device alone", async () => {
    const { page, errors } = await fresh({
      profiles: [prof("alpha", { fingerprintProfile: "d-3060.json" }), prof("bravo"), prof("charlie"), prof("delta", { platform: "linux" })],
    });
    for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) await page.click(`[aria-label="Select ${name}"]`);
    await page.click('[data-bulk-devices="1"]');
    await page.waitForSelector('[data-devices-assign="1"]');
    expect(await page.textContent('[data-devices-assign="1"]')).toContain("4 profiles selected");
    await page.click('[data-devices-assign-run="1"]');
    const after = await until(() => stored(page), (ps) => ps.filter((p) => p.device).length === 3, "bravo and charlie assigned");
    const by = Object.fromEntries(after.map((p) => [p.id, p.device]));
    expect(by.alpha).toBe("d-3060.json"); // kept
    expect(by.delta).toBeUndefined(); // a Linux persona cannot take a Windows capture
    expect(new Set([by.alpha, by.bravo, by.charlie]).size).toBe(3);
    expect(await page.textContent("body")).toContain("1 is not a Windows profile, so it was left alone.");
    expect(errors).toEqual([]);
  }, T);

  it("the full library: off until added, then its devices list a page at a time and can be used; Remove takes them away", async () => {
    const { page, errors } = await fresh({ profiles: [prof("alpha")] });
    await openDevices(page);
    await page.waitForSelector('[data-devices-full="off"]');
    expect(await page.textContent('[data-devices-full="off"]')).toContain("downloads once from the original repo");
    const all = () => page.$$eval('[data-devices-all="1"] [data-device]', (els) => els.length);
    expect(await all()).toBe(4);

    await page.click('[data-devices-full-add="1"]');
    await page.waitForSelector('[data-devices-full="on"]', { timeout: 10000 });
    expect(await page.textContent('[data-devices-full="on"]')).toMatch(/Full library on: 250 more devices.*Nothing is downloaded again/);
    expect(await page.textContent('[data-devices-full="on"]')).toContain("35 of them marked higher risk");
    // With every maker shown: 6 samples + 215 ordinary devices; the 35 higher-risk ones (no graphics card, VMware)
    // don't fit an NVIDIA computer, so they wait behind their own checkbox. A page of 100, then "Show 100 more".
    await page.click('[data-devices-only-fit="1"]');
    expect(await until(all, (n) => n === 100, "the first page")).toBe(100);
    expect(await page.textContent('[data-devices-more="1"]')).toBe("Show 100 more");
    await page.click('[data-devices-more="1"]');
    expect(await until(all, (n) => n === 200, "the second page")).toBe(200);
    await page.click('[data-devices-more="1"]');
    expect(await until(all, (n) => n === 221, "every ordinary device")).toBe(221);
    expect(await page.$('[data-devices-more="1"]')).toBeNull();
    expect(await page.$('[data-devices-all="1"] [data-device-risk]')).toBeNull();
    await page.click('[data-devices-show-risky="1"]');
    await page.click('[data-devices-more="1"]');
    await page.click('[data-devices-more="1"]');
    expect(await until(all, (n) => n === 256, "every device, the higher-risk ones last")).toBe(256);
    const risky = await page.$$eval('[data-devices-all="1"] [data-device-risk]', (els) => els.map((e) => e.textContent));
    expect(risky).toHaveLength(35);
    expect(risky).toContain("Higher risk · No graphics card");
    expect(risky).toContain("Higher risk · Virtual machine");
    // The best-for-this-computer strip never offers one here.
    expect(await page.$('[data-devices-best="1"] [data-device-risk]')).toBeNull();

    // A full-library device links to its source and goes on a profile like a sample.
    const id = "vinyzu-20000.json";
    await page.click(`[data-devices-all="1"] [data-device="${id}"] button`);
    expect(await page.textContent(`[data-devices-all="1"] [data-device="${id}"] [data-device-detail]`)).toContain("View the source");
    await page.click(`[data-devices-all="1"] [data-device="${id}"] [data-device-create-one="1"]`);
    await until(() => stored(page), (ps) => ps.some((p) => p.device === id), "a profile on the full-library device");

    await page.click('[data-devices-full-remove="1"]');
    await page.waitForSelector('[data-devices-full="off"]');
    expect(await until(all, (n) => n === 6, "samples only again")).toBe(6);
    expect(errors).toEqual([]);
  }, T);

  it("on a Windows computer without a graphics card, the WARP captures are the ones offered, marked higher risk", async () => {
    const { page, errors } = await fresh({ profiles: [prof("alpha")], gpu: { vendor: "unknown", name: "", deviceId: null, kind: "software" } });
    await page.click('[data-nav-devices="1"]');
    await page.waitForSelector('[data-devices-full="off"]');
    expect(await page.textContent('[data-devices-host="1"]')).toContain("No graphics card (draws in software)");
    await page.click('[data-devices-full-add="1"]');
    await page.waitForSelector('[data-devices-best="1"] [data-device-risk="no-gpu"]', { timeout: 10000 });
    const best = await page.$$eval('[data-devices-best="1"] [data-device]', (els) => els.map((e) => e.querySelector("[data-device-risk]")?.getAttribute("data-device-risk")));
    expect(best.every((r) => r === "no-gpu")).toBe(true);
    // Create picks them too. Chrome on Windows without a GPU draws with WARP, so only the WARP captures (every 20th)
    // fit: the SwiftShader ones and the real-GPU devices would be disproved by what this computer draws.
    await page.fill("#devices-count", "3");
    await page.click('[data-devices-create-run="1"]');
    const made = await until(() => stored(page), (ps) => ps.length === 4, "three new profiles");
    const ids = made.filter((p) => p.id !== "alpha").map((p) => Number(p.device.slice(7, 12)) - 20000);
    expect(ids.every((i) => i % 20 === 19)).toBe(true);
    expect(errors).toEqual([]);
  }, T);
});
