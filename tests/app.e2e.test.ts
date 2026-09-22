// The REAL desktop app (Electron main + preload + built renderer), driven through Playwright's
// Electron support against a throwaway --user-data-dir, so no real profile is ever touched.
// It covers what the browser-mock suites cannot: the IPC behind trash/undo, the header's real
// launch target, lastLaunchedAt written by the main process, the lease teaching the plan, and the
// update check running on every start.
//
// Opt-in. Build first (the app loads out/index.html), and give it a licence key for the launch test:
//
//   npm run build
//   CLEARCOTE_APP_E2E=1 CLEARCOTE_LICENSE_KEY=cc_lic_... npx vitest run tests/app.e2e.test.ts
//
// Without a key the launch/plan tests are skipped; the rest still run.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_APP_E2E === "1";
const KEY = process.env.CLEARCOTE_LICENSE_KEY || "";
const APP_DIR = path.resolve(__dirname, "..");
const T = 120000;

describe.skipIf(!READY)("the desktop app, end to end", () => {
  // Made in beforeAll, not here: a skipped describe body still runs while tests are collected, and
  // a folder made at this level was left in %TEMP% by every ordinary `npm test`.
  let UDD = "";
  let PROFILES = "";
  let SETTINGS = "";
  let app: ElectronApplication | null = null;
  let win: Page;

  const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));
  // The app rewrites settings.json while running; a read that lands mid-write is retried by until().
  const settings = (): Record<string, unknown> => {
    try {
      return readJson(SETTINGS);
    } catch {
      return {};
    }
  };
  const profileOnDisk = (id: string) => readJson(path.join(PROFILES, `${id}.json`)) as Record<string, string>;

  async function start() {
    const { _electron } = await import("playwright-core");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronPath = require("electron") as unknown as string;
    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_DEV; // load the built renderer
    delete env.ELECTRON_RUN_AS_NODE;
    if (!KEY) delete env.CLEARCOTE_LICENSE_KEY;
    app = await _electron.launch({ executablePath: electronPath, args: [APP_DIR, `--user-data-dir=${UDD}`], env });
    win = await app.firstWindow();
    await win.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
  }
  async function stopApp() {
    await app?.close().catch(() => {});
    app = null;
  }
  async function until<V>(read: () => Promise<V> | V, ok: (v: V) => boolean, what: string, ms = 30000): Promise<V> {
    const end = Date.now() + ms;
    let last = await read();
    while (!ok(last)) {
      if (Date.now() > end) throw new Error(`${what}: last saw ${JSON.stringify(last)}`);
      await new Promise((r) => setTimeout(r, 150));
      last = await read();
    }
    return last;
  }
  /** Two tests accept either of two legitimate outcomes; E2E_OUTCOMES=<file> records which one ran. */
  const note = (what: string, outcome: string) => {
    if (process.env.E2E_OUTCOMES) fs.appendFileSync(process.env.E2E_OUTCOMES, `${what}: ${outcome.slice(0, 90)}\n`);
  };
  const pillText = () =>
    win.locator("header button").first().textContent().then((t) => (t || "").trim());

  beforeAll(async () => {
    UDD = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-app-e2e-"));
    PROFILES = path.join(UDD, "profiles");
    SETTINGS = path.join(UDD, "settings.json");
    fs.mkdirSync(PROFILES, { recursive: true });
    const now = new Date().toISOString();
    const seed = (id: string, over: Record<string, unknown> = {}) =>
      fs.writeFileSync(
        path.join(PROFILES, `${id}.json`),
        JSON.stringify({ id, name: id, fingerprint: `seed-${id}`, platform: "windows", createdAt: now, updatedAt: "2026-01-01T00:00:00.000Z", ...over }),
      );
    seed("alpha");
    seed("pinned", { browserVersion: "151.0.7922.108-r18" });
    fs.writeFileSync(SETTINGS, JSON.stringify({ theme: "dark" }));
    await start();
  }, T);

  afterAll(async () => {
    await stopApp();
    // A launched browser leaves its profile data in here — remove it all, every run.
    if (UDD) fs.rmSync(UDD, { recursive: true, force: true });
  }, T);

  it("uses the throwaway data dir — never the real one", async () => {
    const ud = await app!.evaluate(({ app: a }) => a.getPath("userData"));
    expect(path.resolve(ud)).toBe(path.resolve(UDD));
  }, T);

  it("the header names the real launch target", async () => {
    const t = await until(pillText, (v) => v !== "Checking…", "pill resolved");
    expect(t).not.toMatch(/Browser not set/);
    expect(t).toMatch(KEY ? /^(Licensed|Free plan|Pro) · \d+$/ : /^Open build · \d+$/);
  }, T);

  it("checks for updates on every start, and not at all once switched off", async () => {
    const first = await until(() => settings().lastUpdateCheck as string | undefined, (v) => !!v, "checked on start");
    await stopApp();
    await new Promise((r) => setTimeout(r, 1100));
    await start();
    const second = await until(() => settings().lastUpdateCheck as string, (v) => v !== first, "checked again on the next start");
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first!));

    // Off, and remembered across a restart.
    await stopApp();
    fs.writeFileSync(SETTINGS, JSON.stringify({ ...settings(), updateCheck: false }));
    await start();
    await new Promise((r) => setTimeout(r, 4000));
    expect(settings().lastUpdateCheck).toBe(second);
    expect(settings().updateCheck).toBe(false);
    await stopApp();
    fs.writeFileSync(SETTINGS, JSON.stringify({ ...settings(), updateCheck: true }));
    await start();
  }, T * 2);

  it("the window asks before closing with unsaved edits (the handler is attached)", async () => {
    const n = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.listenerCount("will-prevent-unload"));
    expect(n).toBe(1);
  }, T);

  it("delete moves the profile and its data to the trash, and Undo puts both back", async () => {
    fs.mkdirSync(path.join(PROFILES, "alpha", "userdata"), { recursive: true });
    fs.writeFileSync(path.join(PROFILES, "alpha", "userdata", "marker"), "keep");
    await win.getByRole("button", { name: "More actions for alpha" }).click();
    await win.getByRole("menuitem", { name: /Delete/ }).click();
    await win.getByRole("dialog", { name: "Delete “alpha”?" }).getByRole("button", { name: "Delete" }).click();
    await until(() => fs.existsSync(path.join(PROFILES, "alpha.json")), (v) => !v, "profile moved");
    const trash = fs.readdirSync(path.join(PROFILES, ".trash"));
    expect(trash.some((n) => n.startsWith("alpha__"))).toBe(true);
    expect(fs.existsSync(path.join(PROFILES, "alpha"))).toBe(false);

    await win.getByRole("button", { name: "Undo" }).click();
    await until(() => fs.existsSync(path.join(PROFILES, "alpha.json")), (v) => v, "profile restored");
    expect(fs.readFileSync(path.join(PROFILES, "alpha", "userdata", "marker"), "utf8")).toBe("keep");
    await win.locator('[data-card="alpha"]').waitFor();
  }, T);

  it.runIf(!!KEY)("a free key: a pinned profile explains itself and opens on the version picker", async () => {
    const card = win.locator('[data-card="pinned"]');
    await card.getByRole("button", { name: "Launch" }).click();
    const notice = await until(
      async () => ((await card.locator('[role="alert"]').count()) ? (await card.locator('[role="alert"]').textContent()) || "" : ""),
      (t) => t.length > 0,
      "notice on the card",
      90000,
    );
    // A free key gets the pin explanation; a paid key would simply launch 151 — both are fine.
    note("pinned", notice);
    if (/Pinned builds need Pro/.test(notice)) {
      await card.getByRole("button", { name: "Change version" }).click();
      await win.getByRole("dialog", { name: "Edit profile" }).waitFor();
      expect(await win.locator('[data-field="browserVersion"] select').isVisible()).toBe(true);
      await win.keyboard.press("Escape");
    }
  }, T);

  it.runIf(!!KEY)("a real launch: lastLaunchedAt from the main process, updatedAt untouched, plan learned", async () => {
    const before = profileOnDisk("alpha");
    const card = win.locator('[data-card="alpha"]');
    await card.getByRole("button", { name: "Launch" }).click();
    const outcome = await until(
      async () => {
        if ((await card.getByRole("button", { name: "Stop" }).count()) > 0) return "running";
        if ((await card.locator('[role="alert"]').count()) > 0) return (await card.locator('[role="alert"]').textContent()) || "alert";
        return "";
      },
      (v) => v !== "",
      "launched or refused",
      180000,
    );
    note("launch", outcome);
    if (outcome !== "running") {
      // The only acceptable refusal is the plan's one-browser limit (a browser already open elsewhere).
      expect(outcome).toMatch(/browser limit/);
      return;
    }
    const after = profileOnDisk("alpha");
    expect(after.lastLaunchedAt).toBeTruthy();
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(typeof settings().lastPlan).toBe("string");
    await until(pillText, (t) => !t.startsWith("Licensed"), "pill names the plan");
    // Delete is not offered while its browser has the data open.
    await win.getByRole("button", { name: "More actions for alpha" }).click();
    expect(await win.getByRole("menuitem", { name: /Delete/ }).isDisabled()).toBe(true);
    await win.keyboard.press("Escape");
    await card.getByRole("button", { name: "Stop" }).click();
    await until(async () => card.getByRole("button", { name: "Launch" }).count(), (n) => n > 0, "stopped");
  }, 240000);
});
