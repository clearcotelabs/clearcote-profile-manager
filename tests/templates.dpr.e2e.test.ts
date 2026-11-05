// End-to-end: a template keeps the pixel ratio (CR-LYJSFW 11-05). A profile with Pixel ratio 1, or
// with "Use this display", saved as a template, must give new profiles the same ratio.
//
// Opt-in, like templates.e2e.test.ts:
//
//   npm run next:dev -- -p 3100                     # in another shell
//   CLEARCOTE_UI_E2E=1 CLEARCOTE_UI_BROWSER="/path/to/chrome" npx vitest run tests/templates.dpr.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";

interface Stored {
  id: string;
  name: string;
  devicePixelRatio?: number;
  screenWidth?: number;
}

describe.skipIf(!READY)("profile templates keep the pixel ratio — in a real browser", () => {
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  const rail = (name: string) => page.locator("nav button", { hasText: name }).first();
  const field = (key: string) => page.locator(`[data-field="${key}"] input`).first();
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("clearcote.profiles.mock") || "[]")) as Promise<Stored[]>;
  const storedTemplates = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem("clearcote.settings.mock") || "{}").templates || []) as Promise<
      { name: string; base: Record<string, unknown> }[]
    >;

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

  async function saveTemplateFrom(profileName: string, templateName: string) {
    await page.getByRole("button", { name: `More actions for ${profileName}` }).click();
    await page.getByRole("menuitem", { name: "Save as template…" }).click();
    await page.locator('[data-save-template="1"]').waitFor();
    await page.getByLabel("Template name").fill(templateName);
    await page.locator('[data-save-template-confirm="1"]').click();
    await page.locator('[data-save-template="1"]').waitFor({ state: "detached" });
  }

  async function newFromTemplate(templateName: string) {
    await page.getByRole("button", { name: "New from a template" }).click();
    await page.getByRole("menuitem", { name: templateName }).click();
    await page.locator(`[data-from-template="${templateName}"]`).waitFor();
  }

  async function closeEditor() {
    await page.getByRole("button", { name: "Cancel" }).click();
    const discard = page.getByRole("button", { name: "Discard" });
    if (await discard.count()) await discard.click();
    await page.waitForSelector('[data-field="name"]', { state: "detached" });
  }

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined,
      args: ["--no-sandbox"],
    });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(() => {
      if (!sessionStorage.getItem("dpr-e2e")) {
        localStorage.clear();
        localStorage.setItem("clearcote.profiles.mock", "[]");
        sessionStorage.setItem("dpr-e2e", "1");
      }
    });
    page = await ctx.newPage();
    await page.addInitScript(() => localStorage.setItem("clearcote.editor.mode", "all"));
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
  }, 120000);

  afterAll(async () => {
    await browser?.close();
  }, 20000);

  it("Pixel ratio 1 typed by hand reaches a profile made from the template", async () => {
    await page.getByRole("button", { name: "+ New profile" }).first().click();
    await field("name").fill("Dpr typed 1");
    await rail("Hardware").click();
    await field("devicePixelRatio").fill("1");
    await page.getByRole("button", { name: "Save profile" }).click();
    await page.waitForSelector('[data-field="name"]', { state: "detached" });
    const src = (await stored()).find((p) => p.name === "Dpr typed 1")!;
    expect(src.devicePixelRatio).toBe(1);

    await saveTemplateFrom("Dpr typed 1", "Dpr typed");
    const tpl = await until(storedTemplates, (l) => l.some((t) => t.name === "Dpr typed"), "template saved");
    expect(tpl.find((t) => t.name === "Dpr typed")!.base.devicePixelRatio).toBe(1);

    await newFromTemplate("Dpr typed");
    await rail("Hardware").click();
    expect(await field("devicePixelRatio").inputValue()).toBe("1");
    await closeEditor();
  }, 60000);

  it("“Use this display” reaches a profile made from the template, ratio included", async () => {
    await page.getByRole("button", { name: "+ New profile" }).first().click();
    await field("name").fill("Dpr display 1");
    await rail("Hardware").click();
    await page.getByRole("button", { name: /Use this display/ }).click();
    expect(await field("devicePixelRatio").inputValue()).toBe("1");
    await page.getByRole("button", { name: "Save profile" }).click();
    await page.waitForSelector('[data-field="name"]', { state: "detached" });
    const src = (await stored()).find((p) => p.name === "Dpr display 1")!;
    expect(src.devicePixelRatio).toBe(1);
    expect(src.screenWidth).toBeGreaterThan(0);

    await saveTemplateFrom("Dpr display 1", "Dpr display");
    await newFromTemplate("Dpr display");
    await rail("Hardware").click();
    expect(await field("screenWidth").inputValue()).toBe(String(src.screenWidth));
    expect(await field("devicePixelRatio").inputValue()).toBe("1");
    await closeEditor();
  }, 60000);

  it("in the Simple view (the default) too, both when making the profile and when opening the new one", async () => {
    await page.evaluate(() => localStorage.setItem("clearcote.editor.mode", "simple"));
    await page.getByRole("button", { name: "+ New profile" }).first().click();
    await field("name").fill("Dpr simple 1");
    await page.getByRole("button", { name: /Use this display/ }).click();
    await page.getByRole("button", { name: "Save profile" }).click();
    await page.waitForSelector('[data-field="name"]', { state: "detached" });
    expect((await stored()).find((p) => p.name === "Dpr simple 1")!.devicePixelRatio).toBe(1);

    await saveTemplateFrom("Dpr simple 1", "Dpr simple");
    await newFromTemplate("Dpr simple");
    await page.getByRole("button", { name: "All settings", exact: true }).click();
    await rail("Hardware").click();
    expect(await field("devicePixelRatio").inputValue()).toBe("1");
    await page.getByRole("button", { name: "Simple", exact: true }).click();
    await page.getByRole("button", { name: "Save profile" }).click();
    await page.waitForSelector('[data-field="name"]', { state: "detached" });
    const made = (await stored()).find((p) => p.name === "Dpr simple 2")!;
    expect(made.devicePixelRatio).toBe(1);
    expect(errors).toEqual([]);
  }, 60000);
});
