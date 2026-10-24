// CR-LYJSFW in the real editor: "Resolve from proxy" records that the WebRTC IP came from the lookup,
// and "Check" tells the two cases apart when the proxy's exit no longer matches the stored WebRTC IP —
// a resolved one is refreshed at launch (still green), a typed one is the user's and will disagree
// with HTTP (amber, with the way out).
//
// Opt-in like editor.e2e.test.ts — needs a dev server and a Chromium for playwright-core:
//
//   npm run next:dev -- -p 3100                     # in another shell
//   CLEARCOTE_UI_E2E=1 CLEARCOTE_UI_BROWSER="/path/to/chrome" npx vitest run tests/webrtcfollow.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";

/** The proxy exits here now. */
const CHECK = { ok: true, ms: 500, geo: { ok: true, ip: "62.198.28.61", country: "Denmark", city: "Højby" }, udp: "works" };
/** What Resolve finds (same exit). */
const GEO = { ok: true, ip: "62.198.28.61", country: "Denmark", countryCode: "DK", city: "Højby", timezone: "Europe/Copenhagen", lat: 55.5, lon: 11.6, acceptLanguage: "da-DK,da,en" };

describe.skipIf(!READY)("WebRTC IP follows the proxy — Resolve and Check in a real browser", () => {
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];
  const edit = async (name: string) => {
    await page.getByRole("button", { name: "Edit" }).nth(name === "Resolved" ? 0 : 1).click();
    await page.waitForSelector('[data-field="name"]');
    expect(await page.locator('[data-field="name"] input').inputValue()).toBe(name);
  };
  const close = async () => {
    await page.getByRole("button", { name: "Cancel" }).click();
    const discard = page.getByRole("button", { name: "Discard" });
    if (await discard.count()) await discard.click();
    await page.waitForSelector('[data-field="name"]', { state: "detached" });
  };
  /** The WebRTC IP field lives in "All settings"; the editor opens in Simple. */
  const allMode = async () => {
    const rail = page.locator("[data-editor-mode]");
    if ((await rail.getAttribute("data-editor-mode")) !== "all") await rail.getByRole("button", { name: "All settings" }).click();
    await page.locator("nav").getByRole("button", { name: /^Network/ }).click();
    await page.waitForSelector('[data-field="webrtcIp"]');
  };
  const checkBox = async () => {
    await page.locator('[data-proxy-check-btn="1"]').click();
    const box = page.locator("[data-proxy-check]");
    await box.waitFor();
    return { tone: await box.getAttribute("data-proxy-check"), text: (await box.textContent()) || "" };
  };

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true, executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined, args: ["--no-sandbox"] });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const now = new Date().toISOString();
    await ctx.addInitScript(
      ({ check, geo, now }) => {
        if (!sessionStorage.getItem("webrtcfollow-e2e")) {
          sessionStorage.setItem("webrtcfollow-e2e", "1");
          localStorage.clear();
          const base = { fingerprint: "seed123", platform: "windows", proxy: "socks5://u:p@dk.example.io:1080", geoip: true, createdAt: now, updatedAt: now };
          localStorage.setItem(
            "clearcote.profiles.mock",
            JSON.stringify([
              // Resolved earlier at 87.50.91.122; the proxy has since moved to 62.198.28.61.
              { id: "r", name: "Resolved", ...base, webrtcIp: "87.50.91.122", lastGeo: { ip: "87.50.91.122", country: "Denmark", at: now, proxy: "socks5 dk.example.io:1080" } },
              // Typed by hand.
              { id: "t", name: "Typed", ...base, webrtcIp: "203.0.113.9" },
            ]),
          );
        }
        localStorage.setItem("clearcote.mock.proxycheck", JSON.stringify(check));
        localStorage.setItem("clearcote.mock.geocheck", JSON.stringify(geo));
      },
      { check: CHECK, geo: GEO, now },
    );
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
  }, 120000);

  afterAll(async () => {
    await browser?.close();
  }, 20000);

  it("a resolved WebRTC IP the exit moved away from: Check stays green and says a launch refreshes it", async () => {
    await edit("Resolved");
    const { tone, text } = await checkBox();
    expect(tone).toBe("ok");
    expect(text).toContain("Works · exits in Højby, Denmark (62.198.28.61)");
    expect(text).toContain("The exit has moved since “Resolve from proxy” stored 87.50.91.122 as the WebRTC IP");
    expect(text).toContain("will report 62.198.28.61");
    await close();
  }, 20000);

  it("a typed WebRTC IP that is not the exit: Check turns amber and names both addresses", async () => {
    await edit("Typed");
    const { tone, text } = await checkBox();
    expect(tone).toBe("warn");
    expect(text).toContain("WebRTC IP is set to 203.0.113.9, which is not this exit");
    expect(text).toContain("HTTP from 62.198.28.61 and WebRTC from 203.0.113.9");
    await close();
  }, 20000);

  it("Resolve from proxy fills the WebRTC IP and records the lookup, so Check agrees again and the saved profile follows the proxy", async () => {
    await edit("Typed");
    await page.getByRole("button", { name: "Resolve from proxy →" }).click();
    await page.getByText(/egress 62\.198\.28\.61/).waitFor();
    await allMode();
    expect(await page.locator('[data-field="webrtcIp"] input').inputValue()).toBe("62.198.28.61");
    const { tone, text } = await checkBox();
    expect(tone).toBe("ok");
    expect(text).not.toContain("WebRTC");
    await page.getByRole("button", { name: "Save profile" }).click();
    await page.waitForSelector('[data-field="name"]', { state: "detached" });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("clearcote.profiles.mock") || "[]").find((p: { id: string }) => p.id === "t"));
    expect(saved.webrtcIp).toBe("62.198.28.61");
    expect(saved.lastGeo?.ip).toBe("62.198.28.61");
    expect(saved.lastGeo?.proxy).toBe("socks5 dk.example.io:1080");
    expect(saved.timezone).toBe("Europe/Copenhagen");
    expect(errors).toEqual([]);
  }, 30000);
});
