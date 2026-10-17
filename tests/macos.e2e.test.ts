// The UI as a Mac sees it, end to end in a real browser: the renderer is the same on every OS and
// reads the OS from Electron's navigator, so a page whose user agent and navigator.platform are a
// Mac's renders exactly what the app on a Mac renders. Each scenario runs twice — as a Mac and as
// Windows — so the Windows UI is pinned unchanged by the same steps.
//
// Opt-in, like the other UI suites — needs the built renderer on :3100 and a Chromium:
//
//   npx next build && <serve out/ on :3100>
//   CLEARCOTE_UI_E2E=1 CLEARCOTE_UI_BROWSER="/path/to/chrome" npx vitest run tests/macos.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";
const T = 30000;

// Electron 33's real navigator values on each OS.
const HOSTS = {
  mac: {
    platform: "MacIntel",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) clearcote-profile-manager/0.18.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36",
  },
  win: {
    platform: "Win32",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) clearcote-profile-manager/0.18.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36",
  },
} as const;

describe.skipIf(!READY)("the UI on a Mac (and the same steps on Windows)", () => {
  let browser: Browser;

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true, executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined, args: ["--no-sandbox"] });
  }, 120000);
  afterAll(async () => {
    await browser?.close();
  }, 20000);

  async function open(host: keyof typeof HOSTS): Promise<Page> {
    const ctx = await browser.newContext({ userAgent: HOSTS[host].ua, viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript((p: string) => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => p, configurable: true });
      try {
        localStorage.clear();
      } catch {
        /* first load */
      }
    }, HOSTS[host].platform);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
    if (errors.length) throw new Error(`renderer threw: ${errors.join(" | ")}`);
    return page;
  }

  async function until(read: () => Promise<string>, re: RegExp, what: string, page: Page, ms = 8000) {
    const deadline = Date.now() + ms;
    let last = "";
    while (Date.now() < deadline) {
      last = await read();
      if (re.test(last)) return last;
      await page.waitForTimeout(80);
    }
    throw new Error(`${what}: expected /${re.source}/, last saw ${JSON.stringify(last.slice(0, 200))}`);
  }

  async function newProfile(page: Page) {
    await page.getByRole("button", { name: "+ New profile" }).click();
    await page.waitForSelector('[data-field="name"]');
  }
  const rail = (page: Page, name: string) => page.locator("nav button", { hasText: name }).first();
  const chip = (page: Page) => page.locator("button").filter({ hasText: /coherent|issue/ }).first();
  const chipText = (page: Page) => async () => ((await chip(page).textContent()) || "").trim();
  async function issues(page: Page): Promise<string> {
    await chip(page).click();
    const text = (await page.locator("div.border-b.bg-ink\\/40").first().textContent()) || "";
    await chip(page).click();
    return text;
  }

  it("a new profile on a Mac is a macOS persona, coherent; on Windows it is Windows", async () => {
    for (const [host, want] of [["mac", "macos"], ["win", "windows"]] as const) {
      const page = await open(host);
      await newProfile(page);
      await rail(page, "Browser").click();
      expect(await page.locator('[data-field="platform"] select').inputValue(), host).toBe(want);
      await until(chipText(page), /coherent/, `${host} chip`, page);
      await page.context().close();
    }
  }, T);

  it("the launch preview names the program as the OS has it: Chromium on a Mac, chrome.exe on Windows", async () => {
    for (const [host, re] of [["mac", /(^|\n)Chromium --/], ["win", /(^|\n)chrome\.exe --/]] as const) {
      const page = await open(host);
      await newProfile(page);
      await page.getByRole("button", { name: /Launch command/ }).click();
      const pre = await until(async () => ((await page.locator("pre").first().textContent()) || "").trim(), re, `${host} preview`, page);
      expect(pre).toContain(host === "mac" ? "--fingerprint-platform=macos" : "--fingerprint-platform=windows");
      if (host === "mac") expect(pre).not.toContain("chrome.exe");
      await page.context().close();
    }
  }, T);

  it("on a Mac, another OS's persona is flagged and the issue says why; on Windows it is not", async () => {
    for (const host of ["mac", "win"] as const) {
      const page = await open(host);
      await newProfile(page);
      await rail(page, "Browser").click();
      await page.locator('[data-field="platform"] select').selectOption(host === "mac" ? "windows" : "linux");
      if (host === "mac") {
        await until(chipText(page), /1 issue/, "mac chip", page);
        expect(await issues(page)).toMatch(/macOS's own, but the persona claims windows/);
        await page.locator('[data-field="platform"] select').selectOption("macos");
        await until(chipText(page), /coherent/, "mac chip after fix", page);
      } else {
        await page.waitForTimeout(300);
        expect(await issues(page)).not.toMatch(/persona claims/);
      }
      await page.context().close();
    }
  }, T);

  it("the GPU picker tells a macOS persona its list is Windows/Linux only, and a picked Direct3D model is flagged", async () => {
    const page = await open("mac");
    await newProfile(page);
    await rail(page, "Hardware").click();
    await page.waitForSelector('[data-field="gpuModel"]');
    expect(await page.locator("[data-gpu-macos]").textContent()).toMatch(/Windows and Linux strings only/);
    const gpu = page.locator('[data-field="gpuModel"] select');
    const firstModel = await gpu.locator("optgroup option").first().getAttribute("value");
    await gpu.selectOption(firstModel!);
    await until(chipText(page), /issue/, "chip after a Direct3D pick", page);
    expect(await issues(page)).toMatch(/macOS draws through Metal, never Direct3D/);
    await gpu.selectOption("");
    await until(chipText(page), /coherent/, "chip back on Persona default", page);
    await page.context().close();

    const win = await open("win");
    await newProfile(win);
    await rail(win, "Hardware").click();
    await win.waitForSelector('[data-field="gpuModel"]');
    expect(await win.locator("[data-gpu-macos]").count()).toBe(0);
    await win.context().close();
  }, T);

  it("shortcut labels read ⌘ on a Mac and Ctrl on Windows — header, Save and the shortcuts list", async () => {
    for (const [host, mod] of [["mac", "⌘"], ["win", "Ctrl+"]] as const) {
      const page = await open(host);
      const newBtn = page.getByRole("button", { name: "+ New profile" });
      await until(async () => (await newBtn.getAttribute("title")) || "", new RegExp(`\\(${mod.replace("+", "\\+")}N\\)`), `${host} New title`, page);
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("?");
      const list = page.getByRole("dialog", { name: "Keyboard shortcuts" });
      await list.waitFor();
      const chips = await list.locator("kbd").allTextContents();
      expect(chips).toContain(host === "mac" ? "⌘ N" : "Ctrl N");
      expect(chips).toContain(host === "mac" ? "⌘ S" : "Ctrl S");
      await page.keyboard.press("Escape");
      await newProfile(page);
      expect(await page.getByRole("button", { name: "Save profile" }).getAttribute("title")).toBe(`Save (${mod}S)`);
      await page.context().close();
    }
  }, T);

  it("Settings → Browser asks for Chromium.app on a Mac and chrome.exe on Windows", async () => {
    for (const [host, label] of [["mac", "Choose Chromium.app…"], ["win", "Choose chrome.exe…"]] as const) {
      const page = await open(host);
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("Control+Comma");
      const dlg = page.getByRole("dialog", { name: "Settings" });
      await dlg.waitFor();
      await dlg.getByRole("button", { name: "Browser" }).first().click();
      expect(await dlg.getByRole("button", { name: label }).count(), host).toBe(1);
      await page.context().close();
    }
  }, T);
});
