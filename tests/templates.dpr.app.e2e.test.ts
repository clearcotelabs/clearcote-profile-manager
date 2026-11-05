// The REAL desktop app: a template keeps the pixel ratio (CR-LYJSFW 11-05), through the main
// process's settings and profile files rather than the browser mock. Throwaway --user-data-dir.
//
//   npm run build
//   CLEARCOTE_APP_E2E=1 npx vitest run tests/templates.dpr.app.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_APP_E2E === "1";
const APP_DIR = path.resolve(__dirname, "..");

describe.skipIf(!READY)("the desktop app keeps the pixel ratio in templates", () => {
  let UDD = "";
  let app: ElectronApplication | null = null;
  let win: Page;

  const field = (key: string) => win.locator(`[data-field="${key}"] input`).first();
  const rail = (name: string) => win.locator("nav button", { hasText: name }).first();
  const profilesOnDisk = () => {
    const dir = path.join(UDD, "profiles");
    if (!fs.existsSync(dir)) return [] as Record<string, unknown>[];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  };
  const templatesOnDisk = () => {
    try {
      return (JSON.parse(fs.readFileSync(path.join(UDD, "settings.json"), "utf8")).templates ?? []) as { name: string; base: Record<string, unknown> }[];
    } catch {
      return [];
    }
  };

  beforeAll(async () => {
    UDD = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-dpr-e2e-"));
    const { _electron } = await import("playwright-core");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronPath = require("electron") as unknown as string;
    const env = { ...process.env, CLEARCOTE_PM_DATA_DIR: UDD } as Record<string, string>;
    delete env.ELECTRON_DEV;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CLEARCOTE_LICENSE_KEY;
    app = await _electron.launch({ executablePath: electronPath, args: [APP_DIR, `--user-data-dir=${UDD}`], env });
    win = await app.firstWindow();
    await win.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
    await win.evaluate(() => localStorage.setItem("clearcote.editor.mode", "all"));
  }, 120000);

  afterAll(async () => {
    await app?.close().catch(() => {});
    if (UDD) fs.rmSync(UDD, { recursive: true, force: true });
  }, 30000);

  it("Pixel ratio 1 → template → new profile shows 1", async () => {
    await win.getByRole("button", { name: "+ New profile" }).first().click();
    await field("name").fill("Dpr app 1");
    await rail("Hardware").click();
    await field("devicePixelRatio").fill("1");
    await win.getByRole("button", { name: "Save profile" }).click();
    await win.waitForSelector('[data-field="name"]', { state: "detached" });
    const src = profilesOnDisk().find((p) => p.name === "Dpr app 1")!;
    expect(src.devicePixelRatio).toBe(1);

    await win.getByRole("button", { name: "More actions for Dpr app 1" }).click();
    await win.getByRole("menuitem", { name: "Save as template…" }).click();
    await win.locator('[data-save-template="1"]').waitFor();
    await win.getByLabel("Template name").fill("Dpr app");
    await win.locator('[data-save-template-confirm="1"]').click();
    await win.locator('[data-save-template="1"]').waitFor({ state: "detached" });
    const tpl = templatesOnDisk().find((t) => t.name === "Dpr app");
    expect(tpl?.base.devicePixelRatio).toBe(1);

    await win.getByRole("button", { name: "New from a template" }).click();
    await win.getByRole("menuitem", { name: "Dpr app" }).click();
    await win.locator('[data-from-template="Dpr app"]').waitFor();
    await rail("Hardware").click();
    expect(await field("devicePixelRatio").inputValue()).toBe("1");
  }, 90000);
});
