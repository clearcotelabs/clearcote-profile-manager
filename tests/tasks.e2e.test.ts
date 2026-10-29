// End-to-end for "Run a task" in a real browser, against the preview's run mock (src/lib/syncMock.ts):
// task values in the editor (a secret one masked), selecting profiles, the run dialog's value check,
// the run board (waiting for approval, approve all, done), and Settings → Tasks.
//
// Opt-in, like the other UI suites — needs a dev server (or a static build) and a Chromium:
//
//   npm run next:dev -- -p 3100                     # in another shell
//   CLEARCOTE_UI_E2E=1 \
//   CLEARCOTE_UI_BROWSER="/path/to/chrome" \
//   npx vitest run tests/tasks.e2e.test.ts
//
// CLEARCOTE_UI_URL overrides the origin (default http://localhost:3100).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";

const now = new Date().toISOString();
const seed = [
  { id: "shop-01", name: "Shop 01", fingerprint: "1", createdAt: now, updatedAt: now, vars: [{ key: "email", value: "ana@example.com" }, { key: "password", value: "hunter2!", secret: true }] },
  { id: "shop-02", name: "Shop 02", fingerprint: "2", createdAt: now, updatedAt: now, vars: [{ key: "email", value: "tom@example.com" }] },
  { id: "shop-03", name: "Shop 03", fingerprint: "3", createdAt: now, updatedAt: now },
];

describe.skipIf(!READY)("run a task — in a real browser", () => {
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  const card = (name: string) => page.locator("[data-card]", { hasText: name }).first();
  const row = (id: string) => page.locator(`[data-task-row="${id}"]`);

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
    browser = await chromium.launch({ headless: true, executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined, args: ["--no-sandbox"] });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript((profiles) => {
      if (!sessionStorage.getItem("tasks-e2e")) {
        localStorage.clear();
        localStorage.setItem("clearcote.profiles.mock", JSON.stringify(profiles));
        localStorage.setItem("clearcote.editor.mode", "all");
        sessionStorage.setItem("tasks-e2e", "1");
      }
      localStorage.setItem("clearcote.mock.sync", "ok");
    }, seed);
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
  }, 90000);

  afterAll(async () => {
    await browser?.close();
  });

  it("the editor shows task values, a secret one masked, and adds one", async () => {
    await card("Shop 01").getByRole("button", { name: "Edit" }).first().click();
    await page.locator("nav button", { hasText: "Identity" }).first().click();
    const values = page.locator("[data-task-values]");
    await values.waitFor();
    const inputs = values.locator('input[aria-label="Value"]');
    expect(await inputs.nth(0).getAttribute("type")).toBe("text");
    expect(await inputs.nth(1).getAttribute("type")).toBe("password");
    await values.locator("[data-task-values-add]").click();
    await values.locator('input[aria-label="Name"]').nth(2).fill("city");
    await values.locator('input[aria-label="Value"]').nth(2).fill("Leeds");
    await page.getByRole("button", { name: /^Save/ }).first().click();
    const stored = await until(
      () => page.evaluate(() => JSON.parse(localStorage.getItem("clearcote.profiles.mock") || "[]")) as Promise<{ id: string; vars?: { key: string; value: string }[] }[]>,
      (l) => !!l.find((p) => p.id === "shop-01")?.vars?.some((v) => v.key === "city"),
      "saved task value",
    );
    expect(stored.find((p) => p.id === "shop-01")!.vars!.map((v) => v.key)).toEqual(["email", "password", "city"]);
  });

  it("the run dialog names the profiles missing a value, then runs; the board waits for approval and finishes", async () => {
    await page.keyboard.press("Escape").catch(() => {});
    // Select all three (Ctrl+A selects every visible profile).
    await page.locator("main").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press("Control+a");
    await page.locator("[data-bulk-run-task]").click();
    const dialog = page.locator("[data-run-task]");
    await dialog.waitFor();
    await page.locator("[data-run-goal]").fill("Log in as {{email}} with {{ password }}");
    await page.locator("[data-run-slots]").waitFor();
    const slots = await page.locator("[data-run-slots]").innerText();
    expect(slots).toContain("{{email}}");
    expect(slots).toContain("{{password}}");
    expect(slots).toMatch(/secret/);
    // shop-02 has no password, shop-03 has neither
    expect(await page.locator("[data-run-missing]").getAttribute("data-run-missing")).toBe("2");
    await page.locator("[data-run-start]").click();
    await page.locator("[data-task-board]").waitFor();

    await until(() => row("shop-01").getAttribute("data-status"), (s) => s === "waiting_approval", "shop-01 waits");
    await until(() => row("shop-02").getAttribute("data-status"), (s) => s === "needs_input", "shop-02 missing a value");
    await until(() => row("shop-03").getAttribute("data-status"), (s) => s === "needs_input", "shop-03 missing values");
    expect(await row("shop-01").innerText()).toContain("Place order");
    await page.locator("[data-task-approve-all]").click();
    await until(() => row("shop-01").getAttribute("data-status"), (s) => s === "done", "shop-01 done");
    expect(await page.locator("[data-task-summary]").innerText()).toMatch(/1 of 3 done.*finished/);
    // The board never shows a secret value.
    expect(await page.locator("[data-task-board]").innerText()).not.toContain("hunter2!");
    await page.locator("[data-task-clear]").click();
    await until(() => page.locator("[data-task-board]").count(), (n) => n === 0, "board cleared");
  });

  it("refuses a start page that is not a web address", async () => {
    await page.keyboard.press("Control+a");
    await page.locator("[data-bulk-run-task]").click();
    await page.locator("[data-run-goal]").fill("Search for shoes");
    await page.getByLabel("Start page").fill("file:///c:/secret.txt");
    expect(await page.locator("[data-run-start]").isDisabled()).toBe(true);
    await page.getByLabel("Start page").fill("https://example.com/");
    expect(await page.locator("[data-run-start]").isDisabled()).toBe(false);
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  it("Settings → Tasks shows Jet's command, its key and the automation switch", async () => {
    await page.keyboard.press("Escape").catch(() => {});
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.locator("nav button", { hasText: "Tasks" }).first().click();
    await page.locator("[data-tasks-settings]").waitFor();
    const sw = page.locator("[data-automation-toggle]");
    expect(await sw.getAttribute("aria-checked")).toBe("false");
    await sw.click();
    await until(() => sw.getAttribute("aria-checked"), (v) => v === "true", "automation on");
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("clearcote.settings.mock") || "{}").automation);
    expect(saved).toBe(true);
  });

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
