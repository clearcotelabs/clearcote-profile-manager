// End-to-end for the Simple editor's layout (0.43) in a real browser: a name and a proxy first, the
// identity line with the library as the one optional step, the rest folded under "More options" (open
// by itself when one of them is set, and when a coherence issue points into it), and help links into the
// Profile Manager guide.
//
// Opt-in, like simple.e2e.test.ts — needs a dev server (or a static build) and a Chromium:
//
//   npm run next:dev -- -p 3100                     # in another shell
//   CLEARCOTE_UI_E2E=1 \
//   CLEARCOTE_UI_BROWSER="/path/to/chrome" \
//   npx vitest run tests/simplelayout.e2e.test.ts
//
// CLEARCOTE_UI_URL overrides the origin (default http://localhost:3100).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";
const GUIDE = "https://www.clearcotelabs.com/docs/profile-manager";
const RENDERER = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)";
const MORE = ["platform", "group", "tags", "notes", "startUrl", "screenWidth", "screenHeight", "availWidth", "availHeight"];

describe.skipIf(!READY)("Simple editor layout — in a real browser", () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  const errors: string[] = [];
  /** Tabs opened from the app's page (help links). */
  let popups = 0;
  const count = (sel: string) => page.locator(sel).count();
  const more = () => page.locator("[data-more-options]").getAttribute("data-more-options");
  const moreButton = () => page.locator("[data-more-options] > button");
  const openNew = async () => {
    await page.getByRole("button", { name: "+ New profile" }).first().click();
    await page.waitForSelector('[data-field="name"]');
  };
  const edit = async (id: string) => {
    await page.locator(`[data-card="${id}"]`).getByRole("button", { name: "Edit" }).click();
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
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // A help link opens the guide in a new tab: answered here, so the test never reaches the real site.
    await ctx.route("https://www.clearcotelabs.com/**", (r) =>
      r.fulfill({ status: 200, contentType: "text/html", body: "<title>guide</title>" }),
    );
    const old = "2026-10-01T00:00:00.000Z";
    await ctx.addInitScript(
      ({ old, renderer }) => {
        if (sessionStorage.getItem("simplelayout-e2e")) return;
        sessionStorage.setItem("simplelayout-e2e", "1");
        localStorage.clear();
        localStorage.setItem(
          "clearcote.profiles.mock",
          JSON.stringify([
            { id: "plain-1", name: "Plain 1", fingerprint: "seedplain", platform: "windows", geoip: true, createdAt: old, updatedAt: old },
            {
              id: "shop-2",
              name: "Shop 2",
              fingerprint: "seedshop",
              platform: "windows",
              geoip: true,
              group: "Shops",
              startUrl: "https://example.com",
              createdAt: old,
              updatedAt: old,
            },
          ]),
        );
        localStorage.setItem(
          "clearcote.mock.library",
          JSON.stringify([
            {
              name: "d-3060.json",
              downloadUrl: "https://example.invalid/d-3060.json",
              gpuVendor: "NVIDIA",
              renderer,
              screen: "1920x1080",
              cores: 8,
              memory: 8,
            },
          ]),
        );
      },
      { old, renderer: RENDERER },
    );
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("popup", () => popups++);
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
  }, 120000);

  afterAll(async () => {
    await browser?.close();
  }, 20000);

  it("a new profile asks for a name and a proxy; the rest waits under More options", async () => {
    await openNew();
    expect(await page.locator("[data-editor-mode]").getAttribute("data-editor-mode")).toBe("simple");
    expect(await count('[data-field="name"]')).toBe(1);
    expect(await count('[data-field="proxy"]')).toBe(1);
    expect(await page.locator("[data-simple-identity]").getAttribute("data-simple-identity")).toBe("generated");
    expect(await page.locator("[data-simple-identity]").textContent()).toContain("Nothing to choose");
    expect(await more()).toBe("closed");
    for (const k of MORE) expect(await count(`[data-field="${k}"]`), k).toBe(0);
    expect(await moreButton().textContent()).toContain("Platform, screen, start page, group, tags and notes");

    await moreButton().click();
    expect(await more()).toBe("open");
    for (const k of MORE) expect(await count(`[data-field="${k}"]`), k).toBe(1);
    expect(await count('[data-use-display="1"]')).toBe(1);
    // Nothing else of All settings came along.
    expect(await count('[data-field="gpuModel"]')).toBe(0);
    await close();
  }, 30000);

  it("a profile with a start page and a group opens with More options unfolded", async () => {
    await edit("shop-2");
    expect(await more()).toBe("open");
    expect(await page.locator('[data-field="startUrl"] input').inputValue()).toBe("https://example.com");
    expect(await moreButton().textContent()).toContain("2 set");
    await close();
    await edit("plain-1");
    expect(await more()).toBe("closed");
    await close();
  }, 30000);

  it("a coherence issue in the fold opens it and lands on the field", async () => {
    await openNew();
    await moreButton().click();
    await page.locator('[data-field="screenWidth"] input').fill("1000");
    await moreButton().click();
    expect(await more()).toBe("closed");
    await page.getByRole("button", { name: /issue/ }).click();
    await page.getByRole("button", { name: /spoofed by hand|typed screen size/ }).first().click();
    expect(await more()).toBe("open");
    await page.waitForSelector('[data-field="screenWidth"]');
    expect(await page.locator("[data-editor-mode]").getAttribute("data-editor-mode")).toBe("simple");
    await close();
  }, 30000);

  it("a real computer from the library is one click, and one click back", async () => {
    await openNew();
    await page.locator('[data-simple-library="1"]').click();
    await page.getByText("GeForce RTX 3060", { exact: false }).first().click();
    await page.waitForSelector('[data-simple-identity="real"]');
    expect(await page.locator("[data-simple-identity]").textContent()).toContain("RTX 3060");
    // Simple shows it, so it is not one of the "set in All settings".
    expect(await count("[data-hidden-set]")).toBe(0);
    await page.locator('[data-simple-generated="1"]').click();
    expect(await page.locator("[data-simple-identity]").getAttribute("data-simple-identity")).toBe("generated");
    await close();
  }, 30000);

  it("help links open the guide's section for Simple and for each category", async () => {
    await openNew();
    expect(await page.locator('[data-help-link="simple"]').getAttribute("href")).toBe(`${GUIDE}#create`);
    const popup = ctx.waitForEvent("page");
    await page.locator('[data-help-link="simple"]').click();
    const tab = await popup;
    await tab.waitForLoadState("domcontentloaded");
    expect(tab.url()).toBe(`${GUIDE}#create`);
    await tab.close();

    await page.locator("[data-editor-mode]").getByRole("button", { name: "All settings", exact: true }).click();
    for (const [cat, id] of [
      ["Identity", "settings-identity"],
      ["Network", "settings-network"],
      ["Rendering", "settings-rendering"],
    ]) {
      await page.locator("nav button", { hasText: cat }).first().click();
      const link = page.locator("[data-help-link]");
      expect(await link.count()).toBe(1);
      expect(await link.getAttribute("href"), cat).toBe(`${GUIDE}#${id}`);
    }
    await page.locator("[data-editor-mode]").getByRole("button", { name: "Simple", exact: true }).click();
    await close();
    // Only the one link that was clicked opened anything.
    expect(popups).toBe(1);
    expect(errors).toEqual([]);
  }, 30000);
});
