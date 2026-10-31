// End-to-end for editing a saved task's steps (src/components/StepEditor.tsx) in a real browser against `next dev`
// and the renderer's in-browser mock: turn a learned step into an if block with a step inside, add a repeat-while,
// move and delete steps, a step that cannot run blocks Save, the saved steps read back as sentences, and Reset.
//
//   npm run next:dev -- -p 3100
//   CLEARCOTE_UI_E2E=1 CLEARCOTE_UI_BROWSER=<chrome.exe> npx vitest run tests/stepeditor.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";
const T = 40000;
const now = Date.parse("2026-10-30T10:00:00Z");
const TASK = {
  id: "t1",
  name: "Search the shop",
  goal: "Search the shop for {{query}}",
  url: "https://shop.example/",
  params: [{ name: "query", source: "run", default: "kettle" }],
  confirm: true,
  createdAt: now,
  updatedAt: now,
  history: [],
  stepsFrom: "Shop 01",
  steps: [
    { kind: "click", action: "Accept cookies", replayed: false },
    { kind: "type", action: "Search", text: "kettle", template: "{{query}}", replayed: false },
    { kind: "click", action: "Blue kettle", replayed: false },
  ],
};

describe.skipIf(!READY)("editing a task's steps — in a real browser", () => {
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true, executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined, args: ["--no-sandbox"] });
    page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript((task: unknown) => {
      if (sessionStorage.getItem("__seeded")) return;
      sessionStorage.setItem("__seeded", "1");
      localStorage.clear();
      localStorage.setItem("clearcote.mock.tasks", JSON.stringify([task]));
    }, TASK);
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
    await page.locator("[data-nav-tasks]").click();
  }, 120000);
  afterAll(async () => {
    await browser?.close();
  }, 20000);

  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("clearcote.mock.taskSteps") || "{}").t1);
  const step = (n: string) => page.locator(`[data-edit-step="${n}"]`);

  it("shows how many steps Jet learned and opens them for editing", async () => {
    await page.getByText("Jet learned 3 steps.").waitFor();
    await page.locator("[data-steps-edit]").click();
    await page.locator("[data-step-editor]").waitFor();
    expect(await page.locator("[data-edit-step]").count()).toBe(3);
    expect(await step("2").getByRole("textbox", { name: "Text for step 2" }).inputValue()).toBe("{{query}}");
  }, T);

  it("a step that cannot run blocks Save and says which", async () => {
    await page.getByRole("button", { name: "+ Add a step" }).last().click();
    await step("4").getByRole("combobox", { name: "What step 4 does" }).selectOption("goto");
    await step("4").getByRole("textbox", { name: "Address for step 4" }).fill("shop.example");
    await page.getByText(/Step 4: Use an address that starts with https/).first().waitFor();
    expect(await page.locator("[data-steps-save]").isDisabled()).toBe(true);
    await step("4").getByRole("button", { name: "Delete step 4" }).click();
    expect(await page.locator("[data-steps-save]").isDisabled()).toBe(false);
  }, T);

  it("turns a step into an if block with a step inside, adds a repeat-while, moves one, and saves", async () => {
    await step("1").getByRole("combobox", { name: "What step 1 does" }).selectOption("if");
    await page.getByRole("textbox", { name: "Value step 1 checks" }).fill("We use cookies");
    await page.locator('[data-steps-add="1."]').click();
    await step("1.1").getByRole("textbox", { name: "Label for step 1.1" }).fill("Accept cookies");

    await page.locator('[data-steps-add="top"]').click();
    await step("4").getByRole("combobox", { name: "What step 4 does" }).selectOption("while");
    await page.getByRole("combobox", { name: "What step 4 checks" }).selectOption("control");
    await page.getByRole("textbox", { name: "Value step 4 checks" }).fill("Load more");
    await page.locator('[data-steps-add="4."]').click();
    await step("4.1").getByRole("textbox", { name: "Label for step 4.1" }).fill("Load more");
    // The loop before the result click: move it up once.
    await step("4").getByRole("button", { name: "Move step 4 up" }).click();
    await step("3").getByRole("combobox", { name: "What step 3 does" }).waitFor();
    expect(await step("3").getByRole("combobox", { name: "What step 3 does" }).inputValue()).toBe("while");

    await page.locator("[data-steps-save]").click();
    await page.locator("[data-steps-edited]").waitFor();
    const s = await saved();
    expect(s.edited).toBe(true);
    expect(s.steps.map((x: { kind: string }) => x.kind)).toEqual(["if", "fill", "while", "click"]);
    expect(s.steps[0]).toMatchObject({ condition: { type: "text", value: "We use cookies" }, then: [{ kind: "click", label: "Accept cookies" }] });
    expect(s.steps[2]).toMatchObject({ condition: { type: "control", value: "Load more" }, then: [{ kind: "click", label: "Load more" }], max: 10 });
    const lines = await page.locator("[data-readonly-step]").evaluateAll((els) => els.map((e) => (e.firstElementChild as HTMLElement).innerText.replace(/\s+/g, " ").trim()));
    expect(lines).toEqual([
      "1 If the page shows “We use cookies”",
      "1.1 Click “Accept cookies”",
      "2 Type {{query}} into “Search”",
      "3 Repeat while there is a button or field “Load more” (at most 10 times)",
      "3.1 Click “Load more”",
      "4 Click “Blue kettle”",
    ]);
  }, T);

  it("unless, and Reset goes back to what Jet learns", async () => {
    await page.locator("[data-steps-edit]").click();
    await page.getByRole("combobox", { name: "Whether step 1 checks for or against it" }).selectOption("not");
    await page.locator("[data-steps-save]").click();
    await page.getByText("Unless the page shows “We use cookies”").waitFor();
    expect((await saved()).steps[0].condition).toEqual({ type: "text", value: "We use cookies", not: true });

    await page.locator("[data-steps-reset]").click();
    await page.getByRole("dialog").getByRole("button", { name: "Reset" }).click();
    await page.getByText("Jet learned 3 steps.").waitFor();
    expect(await saved()).toBeUndefined();
    expect(errors).toEqual([]);
  }, T);
});
