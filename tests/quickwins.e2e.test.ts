// End-to-end for the quick-create shortcuts in a real browser: Use this display, the clipboard
// proxy, the protected switches said in words, and Create & launch.
//
// Opt-in, like editor.e2e.test.ts — needs a dev server (or a static build) and a Chromium:
//
//   npm run next:dev -- -p 3100                     # in another shell
//   CLEARCOTE_UI_E2E=1 \
//   CLEARCOTE_UI_BROWSER="/path/to/chrome" \
//   npx vitest run tests/quickwins.e2e.test.ts
//
// CLEARCOTE_UI_URL overrides the origin (default http://localhost:3100).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";

describe.skipIf(!READY)("quick create — the shortcuts in a real browser", () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  const errors: string[] = [];

  const rail = (name: string) => page.locator("nav button", { hasText: name }).first();
  const value = (key: string) => page.locator(`[data-field="${key}"] input`).first().inputValue();

  async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 8000): Promise<T> {
    const deadline = Date.now() + ms;
    let last: T = await read();
    while (Date.now() < deadline) {
      last = await read();
      if (ok(last)) return last;
      await page.waitForTimeout(80);
    }
    throw new Error(`${what}: last saw ${JSON.stringify(last)}`);
  }

  async function openNew() {
    await page.getByRole("button", { name: "+ New profile" }).click();
    await page.waitForSelector('[data-field="name"]');
  }

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined,
      args: ["--no-sandbox"],
    });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, screen: { width: 1920, height: 1080 } });
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
    // The browser preview's mock launches only when told to (src/lib/ipc.ts).
    await ctx.addInitScript(() => localStorage.setItem("clearcote.mock.launch", "ok"));
    page = await ctx.newPage();
    // These cases use the category rail; Simple (the default since 0.23) has its own suite.
    await page.addInitScript(() => localStorage.setItem("clearcote.editor.mode", "all"));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
  }, 120000);

  afterAll(async () => {
    await browser?.close();
  }, 20000);

  it("offers a proxy found on the clipboard, and Use it fills the proxy", async () => {
    await page.evaluate(() => navigator.clipboard.writeText("gw.example.io:7777:user-x:secret"));
    await openNew();
    const offer = page.locator('[data-clip-proxy="1"]');
    await offer.waitFor({ timeout: 8000 });
    // The login never shows in the offer.
    expect(await offer.textContent()).toContain("gw.example.io:7777");
    expect(await offer.textContent()).not.toContain("secret");
    await offer.getByRole("button", { name: "Use it" }).click();
    await rail("Network").click();
    await until(() => value("proxy"), (v) => v === "http://user-x:secret@gw.example.io:7777", "proxy field");
    expect(await page.locator('[data-clip-proxy="1"]').count()).toBe(0);
  }, 30000);

  it("says in words what the protected switches do, on Network and in the launch command", async () => {
    const box = page.locator('[data-protected="1"]');
    await box.waitFor();
    const t = (await box.textContent()) || "";
    expect(t).toContain("No HTTP/3 (QUIC)");
    expect(t).toContain("WebRTC only through the proxy");
    expect(t).toContain("--disable-quic");
    await page.getByRole("button", { name: /Launch command/ }).click();
    const drawer = page.locator('[data-protected-launch="1"]');
    await drawer.waitFor();
    expect(await drawer.textContent()).toContain("real IP");
  }, 20000);

  it("Use this display fills all four screen fields from the display, Clear empties them", async () => {
    await rail("Hardware").click();
    const want = await page.evaluate(() => [screen.width, screen.height, screen.availWidth, screen.availHeight].map(String));
    await page.locator('[data-use-display="1"]').click();
    const got = await until(
      () => Promise.all(["screenWidth", "screenHeight", "availWidth", "availHeight"].map(value)),
      (v) => v.join() === want.join(),
      "screen fields",
    );
    expect(got).toEqual(want);
    expect(await page.locator('[data-screen-source="host"]').textContent()).toContain("This display");
    await page.locator('[data-screen-source="host"]').getByRole("button", { name: "Clear" }).click();
    await until(() => value("screenWidth"), (v) => v === "", "screen width cleared");
    expect(await page.locator('[data-use-display="1"]').count()).toBe(1);
  }, 20000);

  it("Create & launch saves the profile, closes the editor and launches it", async () => {
    await rail("Identity").click();
    await page.locator('[data-field="name"] input').fill("Quick 1");
    await page.locator('[data-save-launch="1"]').click();
    await page.waitForSelector('[data-field="name"]', { state: "detached", timeout: 10000 });
    await page.getByText("Quick 1").first().waitFor();
    // The toast and its screen-reader copy both say it.
    await page.getByText(/Launched “Quick 1”/).first().waitFor({ timeout: 10000 });
  }, 30000);

  it("the Paste button reads the clipboard; a non-proxy says so instead of filling", async () => {
    await page.evaluate(() => navigator.clipboard.writeText("just some words"));
    await openNew();
    expect(await page.locator('[data-clip-proxy="1"]').count()).toBe(0);
    await rail("Network").click();
    await page.locator('[data-proxy-paste="1"]').click();
    await page.getByText("doesn't hold a proxy address").waitFor();
    await page.evaluate(() => navigator.clipboard.writeText("socks5://u:p@10.1.2.3:1080"));
    await page.locator('[data-proxy-paste="1"]').click();
    await until(() => value("proxy"), (v) => v === "socks5://u:p@10.1.2.3:1080", "pasted proxy");
    expect(errors).toEqual([]);
  }, 30000);
});
