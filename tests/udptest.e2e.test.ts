// CR-LYJSFW, 0.26, in the real editor: Check leaves UDP alone while "Relay UDP through the proxy" is
// off and says why; "Test UDP…" warns first that a test can move a sticky session, and only "Test
// anyway" runs it. With Relay UDP on, Check tests UDP straight away (a launch will anyway).
//
// Opt-in like editor.e2e.test.ts — needs a dev server and a Chromium for playwright-core:
//
//   npm run next:dev -- -p 3100                     # in another shell
//   CLEARCOTE_UI_E2E=1 CLEARCOTE_UI_BROWSER="/path/to/chrome" npx vitest run tests/udptest.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";

const CHECK = {
  ok: true,
  ms: 600,
  geo: { ok: true, ip: "62.198.28.61", country: "Denmark", city: "Højby" },
  udp: "works",
  moved: { from: "87.50.91.122", to: "62.198.28.61" },
};

describe.skipIf(!READY)("Check and Test UDP — in a real browser", () => {
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const edit = async (name: string) => {
    await page.getByRole("button", { name: "Edit" }).nth(name === "Relay off" ? 0 : 1).click();
    await page.waitForSelector('[data-field="name"]');
    expect(await page.locator('[data-field="name"] input').inputValue()).toBe(name);
  };
  const close = async () => {
    await page.getByRole("button", { name: "Cancel" }).click();
    const discard = page.getByRole("button", { name: "Discard" });
    if (await discard.count()) await discard.click();
    await page.waitForSelector('[data-field="name"]', { state: "detached" });
  };
  const boxText = async () => {
    const box = page.locator("[data-proxy-check]");
    await box.waitFor();
    return (await box.textContent()) || "";
  };

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true, executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined, args: ["--no-sandbox"] });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const now = new Date().toISOString();
    await ctx.addInitScript(
      ({ check, now }) => {
        if (!sessionStorage.getItem("udptest-e2e")) {
          sessionStorage.setItem("udptest-e2e", "1");
          localStorage.clear();
          const base = { fingerprint: "seed123", platform: "windows", proxy: "socks5://u:p@dk.example.io:1080", geoip: true, createdAt: now, updatedAt: now };
          localStorage.setItem(
            "clearcote.profiles.mock",
            JSON.stringify([
              { id: "a", name: "Relay off", ...base, updatedAt: "2026-10-24T10:00:02.000Z", lastLaunchedAt: "2026-10-24T10:00:02.000Z" },
              { id: "b", name: "Relay on", ...base, socks5Udp: true, updatedAt: "2026-10-24T10:00:01.000Z", lastLaunchedAt: "2026-10-24T10:00:01.000Z" },
            ]),
          );
        }
        localStorage.setItem("clearcote.mock.proxycheck", JSON.stringify(check));
        localStorage.setItem("clearcote.mock.launch", "ok");
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

  it("Relay UDP off: Check reports the exit and says UDP was not tested, with Test UDP… on offer", async () => {
    await edit("Relay off");
    await page.locator('[data-proxy-check-btn="1"]').click();
    const t = await boxText();
    expect(t).toContain("Works · exits in Højby, Denmark (62.198.28.61)");
    expect(t).toContain("UDP not tested");
    expect(t).not.toContain("UDP passes");
    expect(t).not.toContain("moved this session");
    expect(await page.locator('[data-udp-test="offer"]').count()).toBe(1);
  }, 20000);

  it("Test UDP… warns first; Cancel runs nothing", async () => {
    await page.locator('[data-udp-test-btn="1"]').click();
    const t = await boxText();
    expect(t).toContain("move a sticky session to another exit the first time UDP goes through it");
    await page.getByRole("button", { name: "Cancel" }).first().click();
    expect(await page.locator('[data-udp-test="offer"]').count()).toBe(1);
  }, 20000);

  it("Test anyway runs the UDP test and names the move", async () => {
    await page.locator('[data-udp-test-btn="1"]').click();
    await page.locator('[data-udp-test-go="1"]').click();
    await page.getByText("UDP passes through this proxy").waitFor();
    const t = await boxText();
    expect(t).toContain("The UDP test moved this session from 87.50.91.122 to 62.198.28.61");
    expect(t).not.toContain("UDP not tested");
    expect(await page.locator("[data-udp-test]").count()).toBe(0);
    await close();
  }, 20000);

  it("Relay UDP on: Check tests UDP straight away, no Test UDP… needed", async () => {
    await edit("Relay on");
    await page.locator('[data-proxy-check-btn="1"]').click();
    const t = await boxText();
    expect(t).toContain("UDP passes through this proxy");
    expect(await page.locator("[data-udp-test]").count()).toBe(0);
    await close();
  }, 20000);

  it("a launch with Relay UDP on reports UDP from the launch itself", async () => {
    await page.getByRole("button", { name: "Launch" }).nth(1).click();
    await page.getByText(/Launched “Relay on”.*UDP passes through this proxy/).first().waitFor({ timeout: 10000 });
    expect(errors).toEqual([]);
  }, 30000);
});
