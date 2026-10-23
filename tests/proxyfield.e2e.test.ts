// End-to-end for the proxy field in a real browser: every vendor form becomes the one URL form on
// paste or when the field is left, the launch command carries it, and an address that cannot be
// read says so in red (the 10-23 report: an unreadable address quietly meant "no proxy").
//
// Opt-in, like quickwins.e2e.test.ts — needs a dev server (or a static build) and a Chromium:
//
//   npm run next:dev -- -p 3100                     # in another shell
//   CLEARCOTE_UI_E2E=1 \
//   CLEARCOTE_UI_BROWSER="/path/to/chrome" \
//   npx vitest run tests/proxyfield.e2e.test.ts
//
// CLEARCOTE_UI_URL overrides the origin (default http://localhost:3100).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";

describe.skipIf(!READY)("the proxy field reads every vendor form", () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  const errors: string[] = [];

  const rail = (name: string) => page.locator("nav button", { hasText: name }).first();
  const field = () => page.locator('[data-proxy-input="1"]');
  const problem = () => page.locator('[data-proxy-problem="1"]');

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

  async function openNetwork() {
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "+ New profile" }).click();
    await page.waitForSelector('[data-field="name"]');
    await rail("Network").click();
    await field().waitFor();
  }

  async function paste(text: string) {
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
    await field().focus();
    await page.keyboard.press("Control+V");
  }

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined,
      args: ["--no-sandbox"],
    });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
    page = await ctx.newPage();
    await page.addInitScript(() => localStorage.setItem("clearcote.editor.mode", "all"));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
  }, 120000);

  afterAll(async () => {
    await browser?.close();
  }, 20000);

  it("pasting socks5://host:port:user:pass keeps socks5 and writes the URL form", async () => {
    await openNetwork();
    await paste("socks5://relay-eu.example.com:1080:plan-a-country-dk:pw");
    await until(() => field().inputValue(), (v) => v === "socks5://plan-a-country-dk:pw@relay-eu.example.com:1080", "pasted proxy");
    expect(await problem().count()).toBe(0);
    // The launch command carries the proxy, the login (masked) and the UDP-safe switches.
    await page.getByRole("button", { name: /Launch command/ }).click();
    const cmd = (await page.locator("pre").filter({ hasText: "--proxy-server" }).first().textContent()) || "";
    expect(cmd).toContain("--proxy-server=socks5://relay-eu.example.com:1080");
    expect(cmd).toContain("--socks5-credentials=plan-a-country-dk:********");
    expect(cmd).not.toContain(":pw");
  }, 30000);

  it("pasting over a selected address replaces it, in any layout", async () => {
    await field().focus();
    await page.keyboard.press("Control+A");
    await paste("user:pw:1.2.3.4:8080");
    await until(() => field().inputValue(), (v) => v === "http://user:pw@1.2.3.4:8080", "replaced proxy");
  }, 20000);

  it("a typed address is written in the URL form once the field is left", async () => {
    await field().fill("");
    await field().pressSequentially("gate.example.net:7000@user:p@ss");
    await rail("Identity").click();
    await rail("Network").click();
    await until(() => field().inputValue(), (v) => v === "http://user:p%40ss@gate.example.net:7000", "typed proxy after blur");
    expect(await problem().count()).toBe(0);
  }, 20000);

  it("an address that cannot be read says so in red and stays as typed", async () => {
    await field().fill("relay.example.com:10x0:user:pw");
    await problem().waitFor();
    expect(await problem().textContent()).toMatch(/cannot be read/);
    await rail("Identity").click();
    await rail("Network").click();
    expect(await field().inputValue()).toBe("relay.example.com:10x0:user:pw");
    // Emptying the field is "no proxy", which is fine.
    await field().fill("");
    await until(() => problem().count(), (n) => n === 0, "problem line gone");
    expect(errors).toEqual([]);
  }, 20000);
});
