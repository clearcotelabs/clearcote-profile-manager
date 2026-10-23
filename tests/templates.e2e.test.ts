// End-to-end for profile templates in a real browser: save one from a card, start a profile from
// it (menu and Ctrl+Shift+N), make several from a proxy list with it, and manage the list.
//
// Opt-in, like editor.e2e.test.ts — needs a dev server (or a static build) and a Chromium:
//
//   npm run next:dev -- -p 3100                     # in another shell
//   CLEARCOTE_UI_E2E=1 \
//   CLEARCOTE_UI_BROWSER="/path/to/chrome" \
//   npx vitest run tests/templates.e2e.test.ts
//
// CLEARCOTE_UI_URL overrides the origin (default http://localhost:3100).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";

interface Stored {
  id: string;
  name: string;
  fingerprint: string;
  group?: string;
  proxy?: string;
  screenWidth?: number;
  hardwareConcurrency?: number;
  gpuRenderer?: string;
}

describe.skipIf(!READY)("profile templates — in a real browser", () => {
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  const rail = (name: string) => page.locator("nav button", { hasText: name }).first();
  const field = (key: string) => page.locator(`[data-field="${key}"] input`).first();
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("clearcote.profiles.mock") || "[]")) as Promise<Stored[]>;
  const storedTemplates = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem("clearcote.settings.mock") || "{}").templates || []) as Promise<
      { name: string; gpu: string; proxy: string; usedCount?: number }[]
    >;
  const openNewMenu = () => page.getByRole("button", { name: "New from a template" }).click();

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

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined,
      args: ["--no-sandbox"],
    });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(() => {
      // One clean start (no example profiles), then keep what the test makes across reloads.
      if (!sessionStorage.getItem("tpl-e2e")) {
        localStorage.clear();
        localStorage.setItem("clearcote.profiles.mock", "[]");
        sessionStorage.setItem("tpl-e2e", "1");
      }
      localStorage.setItem("clearcote.mock.launch", "ok");
    });
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });

    // The profile the template is saved from.
    await page.getByRole("button", { name: "+ New profile" }).first().click();
    await field("name").fill("Shop NL 4");
    await field("group").fill("Shop NL");
    await rail("Hardware").click();
    await page.locator('[data-field="screenWidth"] input').fill("1920");
    await page.locator('[data-field="hardwareConcurrency"] select').selectOption("8").catch(() => {});
    await rail("Network").click();
    await field("proxy").fill("http://u:p@gw.example.io:7777");
    await page.getByRole("button", { name: "Save profile" }).click();
    await page.waitForSelector('[data-field="name"]', { state: "detached" });
  }, 120000);

  afterAll(async () => {
    await browser?.close();
  }, 20000);

  it("the menu says how to make a template while there is none", async () => {
    await openNewMenu();
    const empty = page.getByRole("menuitem", { name: "No templates yet" });
    await empty.waitFor();
    expect(await empty.isDisabled()).toBe(true);
    await page.keyboard.press("Escape");
  }, 20000);

  it("saves a template from a card's ⋯ menu", async () => {
    await page.getByRole("button", { name: "More actions for Shop NL 4" }).click();
    await page.getByRole("menuitem", { name: "Save as template…" }).click();
    const dlg = page.locator('[data-save-template="1"]');
    await dlg.waitFor();
    expect(await page.getByLabel("Template name").inputValue()).toBe("Shop NL");
    await page.getByLabel("New random GPU").check();
    await page.locator('[data-save-template-confirm="1"]').click();
    await dlg.waitFor({ state: "detached" });
    const list = await until(storedTemplates, (l) => l.length === 1, "stored templates");
    expect(list[0]).toMatchObject({ name: "Shop NL", gpu: "fresh", proxy: "ask" });
  }, 20000);

  it("starts a new profile from it: numbered name, banner, on the proxy, settings copied", async () => {
    await openNewMenu();
    await page.getByRole("menuitem", { name: "Shop NL" }).click();
    await page.locator('[data-from-template="Shop NL"]').waitFor();
    expect(await page.locator("h3").first().textContent()).toContain("Network");
    expect(await field("proxy").inputValue()).toBe("");
    await field("proxy").fill("http://u:p@nl2.example.io:8000");
    await rail("Identity").click();
    expect(await field("name").inputValue()).toBe("Shop NL 5");
    await rail("Hardware").click();
    expect(await page.locator('[data-field="screenWidth"] input').inputValue()).toBe("1920");
    await page.locator('[data-save-launch="1"]').click();
    await page.waitForSelector('[data-field="name"]', { state: "detached" });
    await page.getByText(/Launched “Shop NL 5”/).first().waitFor({ timeout: 10000 });

    const all = await stored();
    const src = all.find((p) => p.name === "Shop NL 4")!;
    const made = all.find((p) => p.name === "Shop NL 5")!;
    expect(made.fingerprint).not.toBe(src.fingerprint);
    expect(made.id).not.toBe(src.id);
    expect(made.group).toBe("Shop NL");
    expect(made.screenWidth).toBe(1920);
    expect(made.proxy).toContain("nl2.example.io");
    expect((await storedTemplates())[0].usedCount).toBe(1);
  }, 30000);

  it("Ctrl+Shift+N starts from the last-used template; cancelling saves nothing", async () => {
    await page.locator("main").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Control+Shift+N");
    await page.locator('[data-from-template="Shop NL"]').waitFor();
    await rail("Identity").click();
    expect(await field("name").inputValue()).toBe("Shop NL 6");
    await page.getByRole("button", { name: "Cancel" }).click();
    const discard = page.getByRole("button", { name: "Discard" });
    if (await discard.count()) await discard.click();
    await page.waitForSelector('[data-field="name"]', { state: "detached" });
    expect((await stored()).length).toBe(2);
    expect((await storedTemplates())[0].usedCount).toBe(1);
  }, 30000);

  it("makes one profile per proxy from a list with the template", async () => {
    await openNewMenu();
    await page.getByRole("menuitem", { name: "From proxy list…" }).click();
    await page.locator('[data-bulk-template="1"]').selectOption({ label: "Shop NL · asks proxy · new GPU" });
    await page.getByLabel("Proxies — one per line").fill("1.2.3.4:8080:a:b\n5.6.7.8:8080:c:d");
    await page.getByRole("button", { name: "Create 2 profiles" }).click();
    await page.getByText(/Created 2 profiles from “Shop NL”/).first().waitFor({ timeout: 10000 });
    const all = await stored();
    const six = all.find((p) => p.name === "Shop NL 6")!;
    const seven = all.find((p) => p.name === "Shop NL 7")!;
    expect(six.proxy).toContain("1.2.3.4:8080");
    expect(seven.proxy).toContain("5.6.7.8:8080");
    expect(six.screenWidth).toBe(1920);
    expect(six.group).toBe("Shop NL");
    expect(new Set(all.map((p) => p.fingerprint)).size).toBe(all.length);
    expect((await storedTemplates())[0].usedCount).toBe(3);
  }, 30000);

  it("renames and deletes templates in Manage templates", async () => {
    await openNewMenu();
    await page.getByRole("menuitem", { name: "Manage templates…" }).click();
    const row = page.locator('[data-template-row="Shop NL"]');
    await row.waitFor({ timeout: 8000 });
    await row.getByLabel("Template name").fill("Shop");
    await page.locator('[data-manage-done="1"]').click();
    await until(storedTemplates, (l) => l[0]?.name === "Shop", "renamed template");
    await openNewMenu();
    // Its name runs into the shortcut chip ("ShopCtrl+Shift+N"), and "Shop NL" is gone.
    await page.getByRole("menuitem", { name: /^Shop/ }).waitFor({ timeout: 8000 });
    await page.getByRole("menuitem", { name: "Manage templates…" }).click();
    await page.locator('[data-template-row="Shop"]').getByRole("button", { name: "Delete" }).click({ timeout: 8000 });
    await page.locator('[data-manage-done="1"]').click();
    await until(storedTemplates, (l) => l.length === 0, "deleted template");
    expect(errors).toEqual([]);
  }, 30000);
});
