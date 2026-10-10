// End-to-end for the GPU model picker, driven in a real browser against `next dev` with the
// renderer's in-browser mock of the Electron bridge (src/lib/ipc.ts). localStorage
// ["clearcote.mock.gpu"] plays the main process's answer about this machine's GPU.
//
// What only a browser shows: that choosing a model writes BOTH stored strings, that Custom… reveals
// the raw fields prefilled, that a profile saved before the picker existed opens as Custom with its
// strings intact, that the platform select rewrites a chosen model's form, that an Android persona
// hides the picker, that the cross-vendor warning appears and goes, and that "Use real GPU" disables
// the control.
//
// Opt-in — needs a dev server and a Chromium for playwright-core (which bundles none):
//
//   npm run next:dev -- -p 3100                     # in another shell
//   CLEARCOTE_UI_E2E=1 CLEARCOTE_UI_BROWSER="/path/to/chrome" npx vitest run tests/gpu.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";
const T = 30000;

const NVIDIA_HOST = { vendor: "nvidia", name: "NVIDIA GeForce RTX 3070", deviceId: 0x2484 };
const WIN_4070 = {
  gpuVendor: "Google Inc. (NVIDIA)",
  gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)",
};
const LINUX_4070 = {
  gpuVendor: "Google Inc. (NVIDIA Corporation)",
  gpuRenderer: "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4070/PCIe/SSE2, OpenGL 4.5.0)",
};
const LEGACY = {
  gpuVendor: "Google Inc. (Intel)",
  gpuRenderer: "ANGLE (Intel, Intel(R) HD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
};

interface Seed {
  profiles?: Record<string, unknown>[];
  gpu?: Record<string, unknown> | null;
}

describe.skipIf(!READY)("GPU model picker — in a real browser", () => {
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

  /** A fresh context seeded before the app loads. `gpu: null` leaves the host unknown. */
  async function fresh(seed: Seed = { gpu: NVIDIA_HOST }) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    open.push(ctx);
    await ctx.addInitScript((s: Seed) => {
      if (sessionStorage.getItem("__seeded")) return;
      sessionStorage.setItem("__seeded", "1");
      localStorage.clear();
      if (s.profiles) localStorage.setItem("clearcote.profiles.mock", JSON.stringify(s.profiles));
      if (s.gpu) localStorage.setItem("clearcote.mock.gpu", JSON.stringify(s.gpu));
    }, seed);
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
  const rail = (page: Page, name: string) => page.locator("nav button", { hasText: name }).first();
  const heading = (page: Page) => page.locator("h3").first().textContent().then((t) => (t || "").trim());
  const goHardware = async (page: Page) => {
    await rail(page, "Hardware").click();
    await until(() => heading(page), (h) => h === "Hardware", "Hardware panel");
    // The host answer arrives over a (mock) IPC after mount — wait for the picker to have it.
    await until(() => page.locator("[data-gpu-host]").count(), (n) => n > 0, "host GPU line");
  };
  const picker = (page: Page) => page.locator('[data-field="gpuModel"] select');
  const randomBtn = (page: Page) => page.getByRole("button", { name: "Pick one at random" });
  const vendorInput = (page: Page) => page.locator('[data-field="gpuVendor"] input');
  const rendererInput = (page: Page) => page.locator('[data-field="gpuRenderer"] input');
  const chip = (page: Page) => page.locator("button").filter({ hasText: /coherent|issue/ }).first();
  const chipText = (page: Page) => chip(page).textContent().then((t) => (t || "").trim());

  async function newProfile(page: Page, name: string) {
    await page.getByRole("button", { name: "+ New profile" }).click();
    await page.waitForSelector('[data-field="name"]');
    await page.locator('[data-field="name"] input').fill(name);
  }
  async function editProfile(page: Page, id: string) {
    await page.locator(`[data-card="${id}"]`).getByRole("button", { name: "Edit" }).click();
    await page.getByRole("dialog", { name: "Edit profile" }).waitFor();
  }
  async function saveAndRead(page: Page, name: string): Promise<Record<string, unknown>> {
    await page.getByRole("button", { name: "Save profile" }).click();
    return until(
      () =>
        page.evaluate((n) => {
          const list = JSON.parse(localStorage.getItem("clearcote.profiles.mock") || "[]") as Record<string, unknown>[];
          return list.find((p) => p.name === n) ?? null;
        }, name),
      (p): p is Record<string, unknown> => !!p,
      `saved profile ${name}`,
    ) as Promise<Record<string, unknown>>;
  }
  const optionGroups = (page: Page) => picker(page).locator("optgroup").evaluateAll((els) => els.map((e) => (e as HTMLOptGroupElement).label));

  it("lists this machine's maker first, and choosing a model writes BOTH strings in the Windows form", async () => {
    const { page, errors } = await fresh();
    await newProfile(page, "pick-4070");
    await goHardware(page);
    expect(await page.locator("[data-gpu-host]").textContent()).toContain("NVIDIA GeForce RTX 3070");
    expect(await optionGroups(page)).toEqual(["NVIDIA — this machine's GPU maker", "Intel", "AMD"]);
    expect(await picker(page).inputValue()).toBe(""); // persona default
    expect(await vendorInput(page).count()).toBe(0); // no raw fields on the default

    await picker(page).selectOption({ label: "GeForce RTX 4070" });
    await until(() => picker(page).inputValue(), (v) => v === "nvidia:0x2786", "selected model");
    // Hardware badge: the two stored strings, counted once each.
    await until(() => rail(page, "Hardware").textContent(), (t) => /Hardware\s*2$/.test((t || "").trim()), "badge 2");

    const saved = await saveAndRead(page, "pick-4070");
    expect(saved.gpuVendor).toBe(WIN_4070.gpuVendor);
    expect(saved.gpuRenderer).toBe(WIN_4070.gpuRenderer);
    expect(errors).toEqual([]);
  }, T);

  it("Pick one at random changes the model, stays with this machine's maker, and never repeats the current one", async () => {
    const { page } = await fresh();
    await newProfile(page, "random");
    await goHardware(page);
    await picker(page).selectOption({ label: "GeForce RTX 4070" });
    let prev = await until(() => picker(page).inputValue(), (v) => v === "nvidia:0x2786", "selected model");
    for (let k = 0; k < 6; k++) {
      await randomBtn(page).click();
      const next = await until(() => picker(page).inputValue(), (v) => v !== prev, `random pick ${k}`);
      expect(next).toMatch(/^nvidia:0x[0-9a-f]+$/);
      prev = next;
    }
    const saved = await saveAndRead(page, "random");
    expect(String(saved.gpuVendor)).toBe("Google Inc. (NVIDIA)");
    // the r37 table (persona schema 4) holds GTX, Ti, SUPER and Laptop GPU cards too: any NVIDIA GeForce row is a right pick
    expect(String(saved.gpuRenderer)).toMatch(/^ANGLE \(NVIDIA, NVIDIA GeForce (RTX|GTX) [0-9A-Za-z ]+ \(0x[0-9A-F]{8}\) Direct3D11 vs_5_0 ps_5_0, D3D11\)$/);
  }, T);

  it("Custom… reveals the raw fields prefilled with the chosen model's strings, and an edit is what gets saved", async () => {
    const { page } = await fresh();
    await newProfile(page, "custom");
    await goHardware(page);
    await picker(page).selectOption({ label: "GeForce RTX 3060" });
    await picker(page).selectOption({ value: "custom" });
    await until(() => vendorInput(page).count(), (n) => n === 1, "raw fields shown");
    expect(await picker(page).inputValue()).toBe("custom"); // holds, although the strings still match a model
    expect(await vendorInput(page).inputValue()).toBe("Google Inc. (NVIDIA)");
    expect(await rendererInput(page).inputValue()).toContain("GeForce RTX 3060");
    await rendererInput(page).fill("ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 (0x00001B80) Direct3D11 vs_5_0 ps_5_0, D3D11)");
    const saved = await saveAndRead(page, "custom");
    expect(saved.gpuVendor).toBe("Google Inc. (NVIDIA)");
    expect(saved.gpuRenderer).toBe("ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 (0x00001B80) Direct3D11 vs_5_0 ps_5_0, D3D11)");
  }, T);

  it("a profile saved before the picker existed opens as Custom with its strings intact", async () => {
    const now = new Date().toISOString();
    const { page } = await fresh({
      gpu: NVIDIA_HOST,
      profiles: [{ id: "old", name: "old", fingerprint: "seedold", platform: "windows", createdAt: now, updatedAt: now, ...LEGACY }],
    });
    await editProfile(page, "old");
    await goHardware(page);
    expect(await picker(page).inputValue()).toBe("custom");
    expect(await vendorInput(page).inputValue()).toBe(LEGACY.gpuVendor);
    expect(await rendererInput(page).inputValue()).toBe(LEGACY.gpuRenderer);
    // Saving untouched keeps them byte for byte — opening the editor never rewrites a profile.
    const saved = await saveAndRead(page, "old");
    expect(saved.gpuVendor).toBe(LEGACY.gpuVendor);
    expect(saved.gpuRenderer).toBe(LEGACY.gpuRenderer);
  }, T);

  it("switching the persona platform to Linux rewrites a chosen model in the Linux form, and back", async () => {
    const { page } = await fresh();
    await newProfile(page, "linux");
    await goHardware(page);
    await picker(page).selectOption({ label: "GeForce RTX 4070" });
    await rail(page, "Browser").click();
    await until(() => heading(page), (h) => h === "Browser", "Browser panel");
    await page.locator('[data-field="platform"] select').selectOption("linux");
    await goHardware(page);
    expect(await picker(page).inputValue()).toBe("nvidia:0x2786"); // still the same model
    const saved = await saveAndRead(page, "linux");
    expect(saved.platform).toBe("linux");
    expect(saved.gpuVendor).toBe(LINUX_4070.gpuVendor);
    expect(saved.gpuRenderer).toBe(LINUX_4070.gpuRenderer);
  }, T);

  it("an Android persona hides the picker and keeps whatever is stored", async () => {
    const { page } = await fresh();
    await newProfile(page, "android");
    await goHardware(page);
    await picker(page).selectOption({ label: "GeForce RTX 4070" });
    await rail(page, "Browser").click();
    await until(() => heading(page), (h) => h === "Browser", "Browser panel");
    await page.locator('[data-field="platform"] select').selectOption("android");
    await rail(page, "Hardware").click();
    await until(() => heading(page), (h) => h === "Hardware", "Hardware panel");
    await until(() => page.locator('[data-field="gpuModel"]').count(), (n) => n === 0, "picker hidden");
    expect(await page.locator('[data-field="gpuVendor"]').count()).toBe(0);
    const saved = await saveAndRead(page, "android");
    expect(saved.platform).toBe("android");
    expect(saved.gpuVendor).toBe(WIN_4070.gpuVendor);
    expect(saved.gpuRenderer).toBe(WIN_4070.gpuRenderer);
  }, T);

  it("a model from another maker raises the cross-vendor warning, which deep-links to the picker and clears on the default", async () => {
    const { page } = await fresh();
    await newProfile(page, "cross");
    await goHardware(page);
    // A fresh profile opens coherent (Widevine is on by default), so the chip goes ✓ -> 1 -> ✓.
    await until(() => chipText(page), (t) => /coherent/.test(t), "coherent to start");
    await picker(page).selectOption({ label: "Radeon RX 6700 XT" });
    await until(() => chipText(page), (t) => /1 issue/.test(t), "cross-vendor issue added");
    await chip(page).click();
    await until(() => page.getByText(/does not match this machine's GPU maker/).count(), (n) => n > 0, "warning text");
    expect(await page.getByText(/Pick a model from the NVIDIA group/).count()).toBeGreaterThan(0);
    // Fix → lands on (and focuses) the picker.
    await page.getByRole("button", { name: /Fix/ }).first().click();
    await until(
      () => page.evaluate(() => !!document.querySelector('[data-field="gpuModel"]')?.contains(document.activeElement)),
      (v) => v,
      "picker focused",
    );
    await picker(page).selectOption({ value: "" });
    await until(() => chipText(page), (t) => /coherent/.test(t), "cross-vendor issue gone");
    // ...and a model of this machine's own maker does not raise it.
    await picker(page).selectOption({ label: "GeForce RTX 3060" });
    await page.waitForTimeout(200);
    expect(await chipText(page)).toMatch(/coherent/);
  }, T);

  it("'Use real GPU' disables the picker and the random button", async () => {
    const { page } = await fresh();
    await newProfile(page, "realgpu");
    await rail(page, "Rendering").click();
    await until(() => heading(page), (h) => h === "Rendering", "Rendering panel");
    await page.locator('[data-field="disableGpuFingerprint"] input[type=checkbox]').check();
    await goHardware(page);
    expect(await picker(page).isDisabled()).toBe(true);
    expect(await randomBtn(page).isDisabled()).toBe(true);
    await rail(page, "Rendering").click();
    await until(() => heading(page), (h) => h === "Rendering", "Rendering panel");
    await page.locator('[data-field="disableGpuFingerprint"] input[type=checkbox]').uncheck();
    await goHardware(page);
    expect(await picker(page).isDisabled()).toBe(false);
    expect(await randomBtn(page).isDisabled()).toBe(false);
  }, T);

  it("with the host unknown every maker is listed, none marked as this machine's, and random draws from all", async () => {
    const { page } = await fresh({ gpu: null });
    await newProfile(page, "unknown-host");
    await goHardware(page);
    expect(await page.locator("[data-gpu-host]").textContent()).toContain("could not be detected");
    expect(await optionGroups(page)).toEqual(["NVIDIA", "Intel", "AMD"]);
    const seen = new Set<string>();
    for (let k = 0; k < 24 && seen.size < 3; k++) {
      await randomBtn(page).click();
      await page.waitForTimeout(40);
      seen.add((await picker(page).inputValue()).split(":")[0]);
    }
    expect([...seen].sort()).toEqual(["amd", "intel", "nvidia"]);
    // No host known, so a claim from any maker raises nothing.
    await picker(page).selectOption({ label: "Radeon RX 6700 XT" });
    await page.waitForTimeout(200);
    expect(await chipText(page)).toMatch(/coherent/);
  }, T);

  it("search finds the picker by either switch name", async () => {
    const { page } = await fresh();
    await newProfile(page, "search");
    await page.getByPlaceholder("Find a setting…").fill("--fingerprint-gpu-renderer");
    await until(() => heading(page), (h) => /match/.test(h), "search results");
    expect(await page.locator('[data-field="gpuModel"]').count()).toBe(1);
    // The hosted string field is not laid out on its own in the results.
    expect(await page.locator('[data-field="gpuRenderer"]').count()).toBe(0);
  }, T);
});
