// End-to-end for 0.23's editor and proxy feedback in a real browser: the Simple view (the default),
// "Check" on the proxy field, and the message after a launch.
//
// Opt-in, like editor.e2e.test.ts — needs a dev server (or a static build) and a Chromium:
//
//   npm run next:dev -- -p 3100                     # in another shell
//   CLEARCOTE_UI_E2E=1 \
//   CLEARCOTE_UI_BROWSER="/path/to/chrome" \
//   npx vitest run tests/simple.e2e.test.ts
//
// CLEARCOTE_UI_URL overrides the origin (default http://localhost:3100).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";

const CHECK = {
  ok: true,
  ms: 840,
  geo: { ok: true, ip: "81.2.3.4", country: "Netherlands", city: "Amsterdam" },
  udp: "refused",
  udpDetail: "The proxy said: UDP is not supported by this proxy.",
};

describe.skipIf(!READY)("Simple editor, Check proxy and the launch message — in a real browser", () => {
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const mode = () => page.locator("[data-editor-mode]").getAttribute("data-editor-mode");
  const modeBtn = (name: string) => page.locator("[data-editor-mode]").getByRole("button", { name, exact: true });
  const openNew = async () => {
    await page.getByRole("button", { name: "+ New profile" }).first().click();
    await page.waitForSelector('[data-field="name"]');
  };
  const close = async () => {
    await page.getByRole("button", { name: "Cancel" }).click();
    const discard = page.getByRole("button", { name: "Discard" });
    if (await discard.count()) await discard.click();
    await page.waitForSelector('[data-field="name"]', { state: "detached" });
  };

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true, executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined, args: ["--no-sandbox"] });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const now = new Date().toISOString();
    await ctx.addInitScript(
      ({ check, now }) => {
        if (!sessionStorage.getItem("simple-e2e")) {
          sessionStorage.setItem("simple-e2e", "1");
          localStorage.clear();
          localStorage.setItem(
            "clearcote.profiles.mock",
            JSON.stringify([
              {
                id: "nl-1",
                name: "NL 1",
                fingerprint: "seed123",
                platform: "windows",
                proxy: "socks5://u:p@nl.example.io:1080",
                geoip: true,
                socks5Udp: true,
                widevine: true,
                lastGeo: { ip: "81.2.3.4", country: "Netherlands", city: "Amsterdam", at: now, proxy: "socks5 nl.example.io:1080" },
                createdAt: now,
                updatedAt: now,
              },
            ]),
          );
        }
        localStorage.setItem("clearcote.mock.launch", "ok");
        localStorage.setItem("clearcote.mock.proxycheck", JSON.stringify(check));
      },
      { check: CHECK, now },
    );
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
  }, 120000);

  afterAll(async () => {
    await browser?.close();
  }, 20000);

  it("a new profile opens in Simple: the essentials on one page, no category rail", async () => {
    await openNew();
    expect(await mode()).toBe("simple");
    expect(await page.locator("h3").first().textContent()).toBe("Essentials");
    expect(await page.locator("nav").count()).toBe(0);
    for (const k of ["name", "proxy", "platform", "group", "notes", "startUrl", "screenWidth", "availHeight"]) {
      expect(await page.locator(`[data-field="${k}"]`).count(), k).toBe(1);
    }
    expect(await page.locator('[data-field="gpuModel"]').count()).toBe(0);
    // Use this display lives with the screen fields here too.
    expect(await page.locator('[data-use-display="1"]').count()).toBe(1);
  }, 20000);

  it("All settings brings the rail back, and the choice is remembered", async () => {
    await modeBtn("All settings").click();
    expect(await mode()).toBe("all");
    await page.locator("nav button", { hasText: "Hardware" }).first().click();
    await page.locator('[data-field="deviceMemory"] select').selectOption({ index: 2 });
    await close();
    await openNew();
    expect(await mode()).toBe("all");
    await modeBtn("Simple").click();
    expect(await mode()).toBe("simple");
    await close();
  }, 20000);

  it("Simple says when you set something it does not show", async () => {
    await openNew();
    await modeBtn("All settings").click();
    await page.locator("nav button", { hasText: "Hardware" }).first().click();
    await page.locator('[data-field="deviceMemory"] select').selectOption({ index: 2 });
    await modeBtn("Simple").click();
    const note = page.locator("[data-hidden-set]");
    expect(await note.textContent()).toContain("1 more setting you set is in All settings");
    await note.click();
    expect(await mode()).toBe("all");
    await modeBtn("Simple").click();
    await close();
  }, 20000);

  it("Check reports the exit, the speed and UDP in plain words, and changes nothing", async () => {
    await page.getByRole("button", { name: "Edit" }).first().click();
    await page.waitForSelector('[data-field="name"]');
    await page.locator('[data-proxy-check-btn="1"]').click();
    const box = page.locator('[data-proxy-check="ok"]');
    await box.waitFor();
    const t = (await box.textContent()) || "";
    expect(t).toContain("Works · exits in Amsterdam, Netherlands (81.2.3.4) · answered in 0.8 s");
    expect(t).toContain("refuses it");
    expect(await page.getByText("Unsaved changes").count()).toBe(0);
    await close();
  }, 20000);

  it("after a launch: where it exits, then whether UDP gets through", async () => {
    await page.getByRole("button", { name: "Launch" }).first().click();
    await page.getByText(/Launched “NL 1” · exits in Amsterdam, Netherlands \(81\.2\.3\.4\) · time zone and language follow the proxy\./).first().waitFor({ timeout: 10000 });
    await page.getByText(/UDP: this proxy refuses it/).first().waitFor({ timeout: 10000 });
    expect(errors).toEqual([]);
  }, 30000);
});
