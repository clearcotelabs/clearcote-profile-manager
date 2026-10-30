// End-to-end for setting up Jet and for saved tasks, in a real browser against the preview mocks
// (src/lib/syncMock.ts: buildJetSetupMock, buildSyncMock, buildTasksMock):
// the setup checklist (Install Jet, a refused and an accepted key), Run a task from an example with values
// typed in the grid and "Save as a task", the trial on one profile and "Run on the other N", the Tasks page
// (recipe, values, step timeline, runs), a value that is the same for every profile, delete with undo, and the
// examples (More examples… in the dialog, Browse examples on the Tasks page).
//
// Opt-in, like the other UI suites — needs a dev server (or a static build) and a Chromium:
//
//   npm run next:dev -- -p 3100                     # in another shell
//   CLEARCOTE_UI_E2E=1 \
//   CLEARCOTE_UI_BROWSER="/path/to/chrome" \
//   npx vitest run tests/savedtasks.e2e.test.ts
//
// CLEARCOTE_UI_URL overrides the origin (default http://localhost:3100).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";

const now = new Date().toISOString();
const seed = [
  { id: "shop-01", name: "Shop 01", group: "Storefronts", fingerprint: "1", createdAt: now, updatedAt: now, vars: [{ key: "email", value: "ana@example.com" }, { key: "password", value: "hunter2!", secret: true }] },
  { id: "shop-02", name: "Shop 02", group: "Storefronts", fingerprint: "2", createdAt: now, updatedAt: now, vars: [{ key: "email", value: "tom@example.com" }] },
  { id: "shop-03", name: "Shop 03", group: "Storefronts", fingerprint: "3", createdAt: now, updatedAt: now },
];

interface StoredTask {
  id: string;
  name: string;
  params: { name: string; source: string; default?: string; secret?: boolean }[];
  steps?: unknown[];
  history: { done: number; total: number; params?: Record<string, string> }[];
}

describe.skipIf(!READY)("Jet setup and saved tasks — in a real browser", () => {
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 10000): Promise<T> {
    const deadline = Date.now() + ms;
    let last: T = await read();
    while (Date.now() < deadline) {
      last = await read();
      if (ok(last)) return last;
      await page.waitForTimeout(80);
    }
    throw new Error(`${what}: last saw ${JSON.stringify(last)}`);
  }
  const tasks = () => page.evaluate(() => JSON.parse(localStorage.getItem("clearcote.mock.tasks") || "[]")) as Promise<StoredTask[]>;
  const summary = () => page.locator("[data-task-summary]").innerText().catch(() => "");
  async function approveUntilFinished() {
    await until(
      async () => {
        const b = page.locator("[data-task-approve-all]");
        if (await b.count()) await b.click().catch(() => {});
        return summary();
      },
      (s) => /finished/.test(s),
      "run finished",
      20000,
    );
  }

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true, executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined, args: ["--no-sandbox"] });
    const ctx = await browser.newContext({ viewport: { width: 1340, height: 900 } });
    await ctx.addInitScript((profiles) => {
      if (!sessionStorage.getItem("savedtasks-e2e")) {
        localStorage.clear();
        localStorage.setItem("clearcote.profiles.mock", JSON.stringify(profiles));
        localStorage.setItem("clearcote.mock.sync", "setup");
        sessionStorage.setItem("savedtasks-e2e", "1");
      }
    }, seed);
    page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
  }, 90000);

  afterAll(async () => {
    await browser?.close();
  });

  it("the setup checklist installs Jet and checks the key before a task can run", async () => {
    await page.keyboard.press("Control+a");
    await page.locator("[data-bulk-run-task]").click();
    await page.locator('[data-jet-setup="todo"]').waitFor();
    expect(await page.locator('[data-jet-row="python"]').getAttribute("data-jet-mark")).toBe("ok");
    expect(await page.locator('[data-jet-row="jet"]').getAttribute("data-jet-mark")).toBe("todo");
    expect(await page.locator("[data-run-start]").isDisabled()).toBe(true);

    await page.locator("[data-jet-install]").click();
    await until(() => page.locator('[data-jet-row="jet"]').getAttribute("data-jet-mark"), (m) => m === "ok", "Jet installed");

    await page.locator("[data-jet-key]").fill("bad");
    await page.locator("[data-jet-key-save]").click();
    await page.locator("[data-jet-key-error]").waitFor();
    await page.locator("[data-jet-key]").fill("ts_test_key");
    await page.locator("[data-jet-key-save]").click();
    await page.locator('[data-jet-setup="ready"]').waitFor();
  }, 40000);

  it("More examples… browses the catalog by category and search; a pick fills the goal and its run values", async () => {
    expect(await page.locator("[data-run-examples] [data-example]").count()).toBeGreaterThanOrEqual(3);
    await page.locator("[data-run-more-examples]").click();
    const picker = page.locator("[data-run-example-picker]");
    expect(await picker.locator("[data-example]").count()).toBeGreaterThanOrEqual(30);
    await picker.locator('[data-example-tab="admin"]').click();
    expect(await picker.locator('[data-example="row-menu"]').count()).toBe(1);
    expect(await picker.locator('[data-example="wikipedia"]').count()).toBe(0);
    await picker.getByRole("tab", { name: "All" }).click();
    await picker.getByRole("textbox").fill("wikipedia");
    expect(await picker.locator("[data-example]").count()).toBe(1);
    await picker.locator('[data-example="wikipedia"]').click();
    expect(await picker.count()).toBe(0);
    expect(await page.locator("[data-run-goal]").inputValue()).toContain("{{topic}}");
    expect(await page.locator("[data-run-url]").inputValue()).toBe("https://en.wikipedia.org");
    // {{topic}} is the same for every profile: asked once for the run.
    expect(await page.locator('[data-run-source-run="topic"]').getAttribute("aria-pressed")).toBe("true");
    await page.locator("[data-run-goal]").fill("");
    await page.locator("[data-run-url]").fill("");
  });

  it("an example, values typed in the grid and Save as a task; the trial runs one profile, then the rest", async () => {
    await page.locator("[data-run-examples] button", { hasText: "Log in" }).click();
    expect(await page.locator("[data-run-goal]").inputValue()).toContain("{{password}}");
    await page.locator("[data-run-url]").fill("https://shop.example/login");
    // shop-02 lacks a password, shop-03 both values: the grid asks for exactly those.
    const cells = await page.locator("[data-run-fill-cell]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.runFillCell));
    expect(cells).toEqual(["shop-02:password", "shop-03:email", "shop-03:password"]);
    expect(await page.locator('[data-run-fill-cell="shop-02:password"]').getAttribute("type")).toBe("password");
    await page.locator('[data-run-fill-cell="shop-02:password"]').fill("pw-two");
    await page.locator('[data-run-fill-cell="shop-03:email"]').fill("kim@example.com");
    await page.locator('[data-run-fill-cell="shop-03:password"]').fill("pw-three");
    expect(await page.locator("[data-run-missing]").count()).toBe(0);

    await page.locator("[data-run-save-toggle]").check();
    await page.locator("[data-run-save-name]").fill("Log in to the shop");
    expect(await page.locator("[data-run-trial]").isChecked()).toBe(true);
    expect(await page.locator("[data-run-trial]").locator("xpath=..").innerText()).toContain("Try it on Shop 01 first");
    await page.locator("[data-run-start]").click();

    await approveUntilFinished();
    expect(await summary()).toMatch(/1 of 1 done/);
    await page.locator('[data-task-trial="ok"]').waitFor();
    // Values typed in the grid went to the profiles; the secret one stays secret.
    const profiles = await page.evaluate(() => JSON.parse(localStorage.getItem("clearcote.profiles.mock") || "[]"));
    const shop3 = profiles.find((p: { id: string }) => p.id === "shop-03");
    expect(shop3.vars).toEqual([{ key: "email", value: "kim@example.com" }, { key: "password", value: "pw-three", secret: true }]);

    await page.locator("[data-task-continue]").click();
    await until(summary, (s) => /of 2/.test(s), "the rest started");
    await approveUntilFinished();
    expect(await summary()).toMatch(/2 of 2 done/);
    // The board never shows a secret value.
    expect(await page.locator("[data-task-board]").innerText()).not.toMatch(/hunter2!|pw-two|pw-three/);

    const [task] = await tasks();
    expect(task.name).toBe("Log in to the shop");
    expect(task.params).toEqual([
      { name: "email", source: "profile" },
      { name: "password", source: "profile", secret: true },
    ]);
    expect(task.history.map((h) => [h.done, h.total])).toEqual([
      [2, 2],
      [1, 1],
    ]);
    expect(task.steps?.length).toBeGreaterThan(0);
    await page.locator("[data-task-clear]").click();
  }, 40000);

  it("the Tasks page shows the recipe, its values, the steps Jet took and the runs", async () => {
    await page.locator("[data-nav-tasks]").click();
    await page.locator("[data-tasks-view]").waitFor();
    expect(await page.locator("[data-task-item]").count()).toBe(1);
    expect(Number(await page.locator("[data-step-timeline]").getAttribute("data-step-timeline"))).toBeGreaterThan(0);
    expect(await page.locator("[data-task-history]").getAttribute("data-task-history")).toBe("2");
    expect(await page.locator('[data-task-param="password"]').innerText()).toContain("Secret");
  });

  it("a value set to the same for every profile is asked when it runs, recorded, and not written to the profiles", async () => {
    const param = page.locator('[data-task-param="email"]');
    await param.locator('[data-param-source="run"]').click();
    await param.locator("[data-param-default]").fill("team@example.com");
    await until(async () => (await tasks())[0].params[0], (p) => p.source === "run" && p.default === "team@example.com", "param saved");

    await page.locator("[data-task-run]").click();
    await page.locator("[data-run-task]").waitFor();
    await page.locator('[data-jet-setup="ready"]').waitFor();
    expect(await page.locator('[data-run-value="email"]').inputValue()).toBe("team@example.com");
    // Learned already: the trial on one profile starts off.
    expect(await page.locator("[data-run-trial]").isChecked()).toBe(false);
    await page.locator("[data-run-start]").click();
    await approveUntilFinished();
    expect(await summary()).toMatch(/3 of 3 done/);

    const [task] = await tasks();
    expect(task.history[0]).toMatchObject({ done: 3, total: 3, params: { email: "team@example.com" } });
    // Updating the saved task on Run kept the earlier runs and the steps.
    expect(task.history).toHaveLength(3);
    expect(task.steps?.length).toBeGreaterThan(0);
    const profiles = await page.evaluate(() => JSON.parse(localStorage.getItem("clearcote.profiles.mock") || "[]"));
    expect(profiles.find((p: { id: string }) => p.id === "shop-01").vars[0]).toEqual({ key: "email", value: "ana@example.com" });
    await page.locator("[data-task-clear]").click();
  }, 40000);

  it("duplicate, then delete with undo", async () => {
    await page.locator("[data-task-duplicate]").click();
    await until(async () => (await tasks()).length, (n) => n === 2, "copy saved");
    expect((await tasks()).map((t) => t.name).sort()).toEqual(["Log in to the shop", "Log in to the shop (copy)"]);
    await page.locator("[data-task-delete]").click();
    await until(async () => (await tasks()).length, (n) => n === 1, "deleted");
    await page.getByRole("button", { name: "Undo" }).click();
    await until(async () => (await tasks()).length, (n) => n === 2, "restored");
  });

  it("Browse examples on the Tasks page opens Run a task with the example", async () => {
    await page.locator("[data-task-examples]").click();
    const gallery = page.locator("[data-example-gallery]");
    expect(Number(await gallery.getAttribute("data-example-gallery"))).toBeGreaterThanOrEqual(30);
    expect(await gallery.locator("[data-example-group]").count()).toBe(7);
    await gallery.locator('[data-example="price-check"]').click();
    await page.locator("[data-run-task]").waitFor();
    expect(await page.locator("[data-run-goal]").inputValue()).toContain("{{product}}");
    expect(await page.locator('[data-run-source-run="product"]').getAttribute("aria-pressed")).toBe("true");
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.locator("[data-run-task]").waitFor({ state: "detached" });
  });

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
