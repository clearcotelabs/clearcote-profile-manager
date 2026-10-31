// End-to-end for 2FA codes in a real browser against `next dev` and the renderer's in-browser mock: a profile with a 2FA
// secret shows its live code on the card and in its details (checked against a code worked out here with Node's own
// crypto, not the app's), Copy and the ⋯ menu put that code on the clipboard, and the editor refuses a secret it can't
// read, shows the code for one it can, and saves it.
//
//   npm run next:dev -- -p 3100
//   CLEARCOTE_UI_E2E=1 CLEARCOTE_UI_BROWSER=<chrome.exe> npx vitest run tests/totp.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";
const T = 40000;
const KEY = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

/** RFC 6238 with Node's crypto: the codes valid around now (the previous, current and next window). */
function codesNow(secret = KEY): string[] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Math.floor(Date.now() / 1000 / 30);
  return [-1, 0, 1].map((d) => {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter + d));
    const mac = crypto.createHmac("sha1", key).update(msg).digest();
    const o = mac[mac.length - 1] & 0x0f;
    return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
  });
}

const prof = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  fingerprint: `seed${id}`,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  widevine: true,
  ...over,
});

describe.skipIf(!READY)("2FA codes — in a real browser", () => {
  let browser: Browser;
  let ctx: BrowserContext;
  let page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true, executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined, args: ["--no-sandbox"] });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
    await ctx.addInitScript((list: unknown) => {
      if (sessionStorage.getItem("__seeded")) return;
      sessionStorage.setItem("__seeded", "1");
      localStorage.clear();
      localStorage.setItem("clearcote.profiles.mock", JSON.stringify(list));
      localStorage.setItem("clearcote.editor.mode", "all");
    }, [prof("shop", { totp: KEY.toLowerCase().replace(/(.{4})/g, "$1 ").trim() }), prof("mail")]);
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
  }, 120000);
  afterAll(async () => {
    await browser?.close();
  }, 20000);

  const shownCode = (scope: string) => page.locator(`${scope} [data-totp-code]`).first().getAttribute("data-totp-code");
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

  it("the card shows the live code a site would accept, only on the profile that has a secret", async () => {
    const card = '[data-card="shop"]';
    await page.locator(`${card} [data-card-totp]`).waitFor();
    let code = "";
    for (let i = 0; i < 20 && !code; i++) code = (await shownCode(card)) ?? "";
    expect(codesNow()).toContain(code);
    expect(await page.locator(`${card} [data-totp-code]`).first().innerText()).toBe(`${code.slice(0, 3)} ${code.slice(3)}`);
    expect(await page.locator('[data-card="mail"] [data-card-totp]').count()).toBe(0);
  }, T);

  it("Copy puts the code on the clipboard, and so does the ⋯ menu", async () => {
    await page.locator('[data-card="shop"] [data-totp-copy]').click();
    await page.locator('[data-card="shop"] [data-totp-copy]', { hasText: "Copied" }).waitFor();
    expect(codesNow()).toContain(await clipboard());
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.locator('[data-card="shop"]').getByRole("button", { name: /More actions/ }).click();
    await page.getByRole("menuitem", { name: "Copy 2FA code" }).click();
    await page.getByText(/Copied the 2FA code for “Shop”/).first().waitFor();
    expect(codesNow()).toContain(await clipboard());
    // Only a profile with a secret offers it.
    await page.keyboard.press("Escape");
    await page.locator('[data-card="mail"]').getByRole("button", { name: /More actions/ }).click();
    expect(await page.getByRole("menuitem", { name: "Copy 2FA code" }).count()).toBe(0);
    await page.keyboard.press("Escape");
  }, T);

  it("the editor refuses a secret it can't read, shows the code for one it can, and saves it", async () => {
    await page.locator('[data-card="mail"]').getByRole("button", { name: "Edit" }).click();
    const ed = page.getByRole("dialog", { name: "Edit profile" });
    await ed.waitFor();
    const field = ed.getByRole("textbox", { name: "2FA secret" });
    if (!(await field.count())) await ed.locator("nav button", { hasText: "Identity" }).click();
    expect(await field.getAttribute("type")).toBe("password");
    await field.fill("not a key!");
    await ed.getByText("A 2FA secret is base32: letters A–Z and digits 2–7.").waitFor();
    await field.fill(`otpauth://totp/Mail:ana%40example.com?secret=${KEY}&issuer=Mail`);
    await ed.locator("[data-totp-field] [data-totp-code]").waitFor();
    await ed.getByText("Mail · ana@example.com").waitFor();
    let code = "";
    for (let i = 0; i < 20 && !code; i++) code = (await ed.locator("[data-totp-field] [data-totp-code]").getAttribute("data-totp-code")) ?? "";
    expect(codesNow()).toContain(code);
    await ed.getByRole("button", { name: "Show" }).click();
    expect(await field.getAttribute("type")).toBe("text");
    await ed.getByRole("button", { name: /^Save/ }).first().click();
    await ed.waitFor({ state: "detached" });
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("clearcote.profiles.mock") || "[]").find((p: { id: string }) => p.id === "mail")?.totp);
    expect(saved).toBe(`otpauth://totp/Mail:ana%40example.com?secret=${KEY}&issuer=Mail`);
    await page.locator('[data-card="mail"] [data-card-totp]').waitFor();
  }, T);

  it("the details panel shows it too", async () => {
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await page.locator('[data-row="shop"] td').nth(2).click();
    const panel = page.getByRole("complementary", { name: "Details of Shop" });
    await panel.locator("[data-totp-code]").waitFor();
    let code = "";
    for (let i = 0; i < 20 && !code; i++) code = (await panel.locator("[data-totp-code]").getAttribute("data-totp-code")) ?? "";
    expect(codesNow()).toContain(code);
    expect(errors).toEqual([]);
  }, T);
});
