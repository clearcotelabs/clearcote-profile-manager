// End-to-end for the Extensions page and the editor's picker, in a real browser against `next dev` and the
// renderer's in-browser mock (src/lib/extensionsMock.ts): add from a store link, turn it on for a group,
// see it in the editor, turn it off there, remove it.
//
//   npm run next:dev -- -p 3100
//   CLEARCOTE_UI_E2E=1 CLEARCOTE_UI_BROWSER=<chrome.exe> npx vitest run tests/extensions.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";
const T = 40000;
const ID = "nkbihfbeogaeaoehlefnkodbefgpgknn";
const prof = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  fingerprint: `seed${id}`,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  widevine: true,
  ...over,
});
const TEAM = [prof("shop", { group: "Work" }), prof("bank", { group: "Work" }), prof("mail", { group: "Home" })];

describe.skipIf(!READY)("extensions — in a real browser", () => {
  let browser: Browser;
  const open: BrowserContext[] = [];

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true, executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined, args: ["--no-sandbox"] });
  }, 120000);
  afterAll(async () => {
    for (const c of open) await c.close().catch(() => {});
    await browser?.close();
  }, 30000);

  async function fresh() {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    open.push(ctx);
    await ctx.addInitScript((list: unknown) => {
      if (sessionStorage.getItem("__seeded")) return;
      sessionStorage.setItem("__seeded", "1");
      localStorage.clear();
      localStorage.setItem("clearcote.profiles.mock", JSON.stringify(list));
      localStorage.setItem("clearcote.editor.mode", "all");
    }, TEAM);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
    return { page, errors };
  }
  async function until<V>(read: () => Promise<V>, ok: (v: V) => boolean, what: string, ms = 8000): Promise<V> {
    const end = Date.now() + ms;
    let last = await read();
    while (!ok(last)) {
      if (Date.now() > end) throw new Error(`${what}: last saw ${JSON.stringify(last)}`);
      await new Promise((r) => setTimeout(r, 60));
      last = await read();
    }
    return last;
  }
  const side = (page: Page) => page.getByRole("complementary", { name: "Workspace" });
  const extsOf = (page: Page) =>
    page.evaluate(() =>
      Object.fromEntries(
        (JSON.parse(localStorage.getItem("clearcote.profiles.mock") || "[]") as { id: string; extensions?: string[] }[]).map((p) => [p.id, p.extensions ?? []]),
      ),
    );

  it("add from a store link, turn it on for a group, see it in the editor, remove it everywhere", async () => {
    const { page, errors } = await fresh();
    await side(page).getByRole("button", { name: /^Extensions/ }).click();
    await page.locator("[data-extensions-page]").waitFor();
    await page.getByText("No extensions yet").waitFor();

    // A link that is not a store link is said, not added.
    const linkBox = page.getByRole("textbox", { name: "Chrome Web Store link or extension ID" });
    await linkBox.fill("https://example.com/x");
    await page.getByRole("button", { name: "Add from store" }).click();
    await page.getByText(/Paste a Chrome Web Store link/).first().waitFor();

    await linkBox.fill(`https://chromewebstore.google.com/detail/metamask/${ID}?hl=en`);
    await page.getByRole("button", { name: "Add from store" }).click();
    const row = page.locator(`[data-extension-row="${ID}"]`);
    await row.waitFor();
    expect(await row.textContent()).toContain("Chrome Web Store");
    expect(await linkBox.inputValue()).toBe("");
    // The sidebar counts it.
    await until(() => side(page).getByRole("button", { name: /^Extensions/ }).textContent(), (s) => /1$/.test(s ?? ""), "sidebar count");

    // Turn it on for the whole Work group.
    await row.getByRole("button", { name: /Choose the profiles that use/ }).click();
    const dlg = page.getByRole("dialog", { name: /Profiles that use/ });
    await dlg.waitFor();
    await dlg.getByRole("button", { name: "Turn on for all 2" }).click();
    await dlg.getByRole("button", { name: "Save" }).click();
    await dlg.waitFor({ state: "detached" });
    await until(() => extsOf(page), (m) => m.shop?.[0] === ID && m.bank?.[0] === ID && !m.mail?.length, "assigned to Work");
    await until(() => row.textContent(), (s) => /On 2 profiles/.test(s ?? ""), "row count");

    // Auto-update is a per-extension switch.
    const auto = row.getByRole("checkbox", { name: "Auto-update" });
    await auto.check();
    await until(
      () => page.evaluate(() => JSON.parse(localStorage.getItem("clearcote.extensions.mock") || "[]")[0]?.autoUpdate),
      (v) => v === true,
      "auto-update saved",
    );

    // The editor shows it on Shop; turning it off there and saving takes it off Shop only.
    await side(page).getByRole("button", { name: /^All profiles/ }).click();
    await page.locator('[data-card="shop"]').getByRole("button", { name: "Edit" }).click();
    const editor = page.getByRole("dialog", { name: "Edit profile" });
    await editor.waitFor();
    await editor.locator("nav button", { hasText: "Browser" }).click();
    const picker = editor.locator("[data-editor-extensions]");
    await picker.waitFor();
    const box = picker.getByRole("checkbox");
    expect(await box.isChecked()).toBe(true);
    await box.uncheck();
    await editor.getByRole("button", { name: /^Save/ }).first().click();
    await editor.waitFor({ state: "detached" });
    await until(() => extsOf(page), (m) => !m.shop?.length && m.bank?.[0] === ID, "off for Shop");

    // Remove: confirmed, and taken off Bank too.
    await side(page).getByRole("button", { name: /^Extensions/ }).click();
    await page.locator(`[data-extension-row="${ID}"]`).getByRole("button", { name: /^Remove/ }).click();
    const confirm = page.getByRole("dialog", { name: /Remove/ });
    await confirm.getByText(/1 profile that uses it/).waitFor();
    await confirm.getByRole("button", { name: "Remove" }).click();
    await page.getByText("No extensions yet").waitFor();
    await until(() => extsOf(page), (m) => Object.values(m).every((l) => !l.length), "removed from every profile");
    expect(errors).toEqual([]);
  }, T);

  it("the command bar opens the Extensions page", async () => {
    const { page } = await fresh();
    await page.keyboard.press("Control+K");
    await page.keyboard.type("Extensions");
    await page.keyboard.press("Enter");
    await page.locator("[data-extensions-page]").waitFor();
  }, T);
});
