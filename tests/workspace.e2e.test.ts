// End-to-end for the workspace layout (0.30): the sidebar's views, groups and tags, the table, the
// details panel, the Proxies page and the Ctrl+K command bar — in a real browser against `next dev`
// and the renderer's in-browser mock (src/lib/ipc.ts).
//
//   npm run next:dev -- -p 3100
//   CLEARCOTE_UI_E2E=1 CLEARCOTE_UI_BROWSER=<chrome.exe> npx vitest run tests/workspace.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";
const T = 40000;
const HOUR = 3600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const prof = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  fingerprint: `seed${id}`,
  createdAt: iso(100 * HOUR),
  updatedAt: iso(50 * HOUR),
  widevine: true,
  ...over,
});

const TEAM = [
  prof("shop", {
    name: "Shop",
    group: "Work",
    tags: ["eu"],
    proxy: "socks5://alice:pw@10.1.1.1:1080",
    lastLaunchedAt: iso(2 * HOUR),
    lastGeo: { proxy: "socks5 10.1.1.1:1080", city: "Berlin", countryCode: "DE", ip: "91.64.1.2", at: iso(2 * HOUR) },
  }),
  prof("bank", { name: "Bank", group: "Work", proxy: "socks5://bob:pw@10.1.1.1:1080", lastLaunchedAt: iso(200 * HOUR) }),
  // Claims Chrome without Widevine: a coherence error, so it needs attention.
  prof("mail", { name: "Mail", group: "Home", widevine: false, tags: ["eu", "mail"] }),
  prof("temp", { name: "Temp", proxy: "http://10.2.2.2:8080" }),
];

describe.skipIf(!READY)("workspace layout — in a real browser", () => {
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

  async function fresh(profiles = TEAM, viewport = { width: 1280, height: 900 }) {
    const ctx = await browser.newContext({ viewport });
    open.push(ctx);
    await ctx.addInitScript((list: unknown) => {
      if (sessionStorage.getItem("__seeded")) return;
      sessionStorage.setItem("__seeded", "1");
      localStorage.clear();
      localStorage.setItem("clearcote.profiles.mock", JSON.stringify(list));
    }, profiles);
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
  const cardIds = (page: Page) => page.locator("[data-card]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.card).sort());
  const rowIds = (page: Page) => page.locator("[data-row]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.row));
  const side = (page: Page) => page.getByRole("complementary", { name: "Workspace" });

  it("sidebar views: needs attention, used this week, a group and a tag — each a second click undoes", async () => {
    const { page, errors } = await fresh();
    await side(page).getByRole("button", { name: /^Needs attention/ }).click();
    await until(() => cardIds(page), (ids) => ids.join() === "mail", "attention");
    await side(page).getByRole("button", { name: /^Used this week/ }).click();
    await until(() => cardIds(page), (ids) => ids.join() === "shop", "this week");
    await side(page).getByRole("button", { name: /^Used this week/ }).click();
    await until(() => cardIds(page), (ids) => ids.length === 4, "all again");

    await side(page).getByRole("button", { name: "Work (group)" }).click();
    await until(() => cardIds(page), (ids) => ids.join() === "bank,shop", "group Work");
    await side(page).getByRole("button", { name: "Work (group)" }).click();
    await side(page).getByRole("button", { name: "Show only profiles tagged #eu" }).click();
    await until(() => cardIds(page), (ids) => ids.join() === "mail,shop", "tag eu");
    expect(errors).toEqual([]);
  }, T);

  it("table view: one row per profile, remembered after a reload; a row opens its details", async () => {
    const { page, errors } = await fresh();
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await until(() => rowIds(page), (ids) => ids.length === 4, "rows");
    expect(await page.locator("[data-card]").count()).toBe(0);
    // The exit measured through its current proxy shows in the row.
    expect(await page.locator('[data-row="shop"]').textContent()).toContain("Berlin, DE");

    await page.reload();
    await page.waitForSelector('main[data-ready="1"]');
    await until(() => rowIds(page), (ids) => ids.length === 4, "still a table");

    await page.locator('[data-row="mail"] td').nth(2).click();
    const panel = page.getByRole("complementary", { name: "Details of Mail" });
    await panel.waitFor();
    // The coherence error is listed with a Fix → that opens the editor on that field.
    await panel.locator("[data-inspector-issues]").waitFor();
    await panel.getByRole("button", { name: "Fix →" }).click();
    await page.getByRole("dialog", { name: "Edit profile" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Edit profile" }).waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    expect(errors).toEqual([]);
  }, T);

  it("table selection uses the same bulk bar", async () => {
    const { page } = await fresh();
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await page.getByRole("checkbox", { name: "Select Shop" }).click();
    await page.getByRole("checkbox", { name: "Select Temp" }).click({ modifiers: ["Shift"] });
    const bar = page.getByRole("region", { name: "Selected profiles" });
    await bar.getByText(/selected/).waitFor();
    expect(await bar.textContent()).toMatch(/[2-4] selected/);
  }, T);

  it("Proxies page: one row per server whatever the login; Replace moves every profile and keeps its login", async () => {
    const { page, errors } = await fresh();
    await side(page).getByRole("button", { name: "Proxies" }).click();
    await page.locator("[data-proxies-page]").waitFor();
    const keys = await page.locator("[data-proxy-row]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.proxyRow));
    expect(keys).toEqual(["socks5 10.1.1.1:1080", "http 10.2.2.2:8080"]);
    const shared = page.locator('[data-proxy-row="socks5 10.1.1.1:1080"]');
    expect(await shared.textContent()).toContain("2 profiles");

    await shared.getByRole("button", { name: /^Replace/ }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("textbox").fill("socks5://10.9.9.9:2000");
    await dlg.getByRole("button", { name: "Move 2 profiles" }).click();
    await page.locator('[data-proxy-row="socks5 10.9.9.9:2000"]').waitFor();
    const stored = await page.evaluate(() =>
      (JSON.parse(localStorage.getItem("clearcote.profiles.mock") || "[]") as { id: string; proxy?: string; lastGeo?: unknown }[])
        .filter((p) => p.id === "shop" || p.id === "bank")
        .map((p) => [p.id, p.proxy, !!p.lastGeo])
        .sort(),
    );
    expect(stored).toEqual([
      ["bank", "socks5://bob:pw@10.9.9.9:2000", false],
      ["shop", "socks5://alice:pw@10.9.9.9:2000", false],
    ]);

    // "N profiles" goes back to the list, searched for that server.
    await page.locator('[data-proxy-row="socks5 10.9.9.9:2000"]').getByRole("button", { name: "2 profiles" }).click();
    await until(() => cardIds(page), (ids) => ids.join() === "bank,shop", "searched by proxy");
    expect(errors).toEqual([]);
  }, T);

  it("Ctrl+K finds a profile and opens its details; app commands without a query", async () => {
    const { page, errors } = await fresh();
    await page.locator("body").click({ position: { x: 700, y: 600 } });
    await page.keyboard.press("Control+K");
    const box = page.getByRole("combobox", { name: "Find a profile or a command" });
    await box.waitFor();
    expect(await page.getByRole("option", { name: /^New profile(?!s)/ }).count()).toBe(1);
    await box.fill("details temp");
    await page.getByRole("option", { name: "Details of Temp" }).waitFor();
    await page.keyboard.press("Enter");
    await page.getByRole("complementary", { name: "Details of Temp" }).waitFor();
    await page.keyboard.press("Escape");

    await page.keyboard.press("Control+K");
    await box.fill("table");
    await page.keyboard.press("Enter");
    await until(() => rowIds(page), (ids) => ids.length === 4, "table from the command bar");
    expect(errors).toEqual([]);
  }, T);

  it("narrow window: the sidebar is a drawer behind ☰ and nothing scrolls sideways", async () => {
    const { page } = await fresh(TEAM, { width: 420, height: 800 });
    expect(await side(page).isVisible()).toBe(false);
    await page.getByRole("button", { name: "Open the side panel" }).click();
    await side(page).getByRole("button", { name: /^Needs attention/ }).click();
    await until(() => cardIds(page), (ids) => ids.join() === "mail", "attention from the drawer");
    expect(await side(page).isVisible()).toBe(false);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sw).toBeLessThanOrEqual(0);
  }, T);
});
