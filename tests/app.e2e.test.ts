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
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
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

  async function start(extraEnv: Record<string, string> = {}) {
    const { _electron } = await import("playwright-core");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronPath = require("electron") as unknown as string;
    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_DEV; // load the built renderer
    delete env.ELECTRON_RUN_AS_NODE;
    if (!KEY) delete env.CLEARCOTE_LICENSE_KEY;
    Object.assign(env, extraEnv);
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
    seed("alpha", { group: "Team" });
    seed("beta", { group: "team " });
    seed("pinned", { browserVersion: "151.0.7922.108-r18" });
    // autoPruneBuilds off: these tests launch from your REAL build cache, which must never be pruned
    // by a test. The pruning test further down runs against a throwaway cache instead.
    fs.writeFileSync(SETTINGS, JSON.stringify({ theme: "dark", autoPruneBuilds: false }));
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

  it("an app update downloaded through the window lands byte-for-byte, with progress per percent", async () => {
    // What the banner's Download button does, against a local "release". Every download through
    // the app used to fail "Checksum mismatch": the progress sent to the window let the next chunk
    // overtake the current one on its way to the file. Plain-Node runs never showed it — only this
    // path, the real main process sending to a real window, does. Random bytes, so any reordering
    // changes the hash.
    const payload = randomBytes(48 * 1024 * 1024);
    const sha = createHash("sha256").update(payload).digest("hex");
    const name = "Clearcote-Profile-Manager-9.9.9-setup.exe";
    const server = http.createServer((req, res) => {
      if (req.url?.endsWith("/SHA256SUMS.txt")) return void res.end(`${sha}  ${name}\n`);
      res.writeHead(200, { "content-length": payload.length });
      res.end(payload);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const info = {
      available: true,
      latest: "9.9.9",
      current: "0.0.1",
      releaseUrl: base,
      asset: { name, url: `${base}/${name}`, size: payload.length },
      sumsUrl: `${base}/SHA256SUMS.txt`,
    };
    type Out = { res: { ok: boolean; verified?: boolean; path?: string; error?: string }; pcts: number[] };
    let out: Out | null = null;
    try {
      out = (await win.evaluate(async (i) => {
        type Bridge = {
          update: { download: (x: unknown) => Promise<Out["res"]> };
          onUpdateProgress: (cb: (p: { pct: number }) => void) => () => void;
        };
        const api = (window as unknown as { clearcote: Bridge }).clearcote;
        const pcts: number[] = [];
        const off = api.onUpdateProgress((p) => pcts.push(p.pct));
        const res = await api.update.download(i);
        await new Promise((r) => setTimeout(r, 300)); // let the last progress messages arrive
        off();
        return { res, pcts };
      }, info)) as Out;
      expect(out.res.error).toBeUndefined();
      expect(out.res).toMatchObject({ ok: true, verified: true });
      expect(createHash("sha256").update(fs.readFileSync(out.res.path!)).digest("hex")).toBe(sha);
      expect(out.pcts.at(-1)).toBe(100);
      expect(out.pcts.length).toBeLessThanOrEqual(101);
    } finally {
      server.close();
      // The download's own folder under %TEMP%\clearcote-update — never leave an "installer" behind.
      if (out?.res.path) fs.rmSync(path.dirname(out.res.path), { recursive: true, force: true });
    }
  }, T);

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

  // ── Quality-of-life round: what only the real app can show ─────────────────

  /** The main browser process of a profile, found by its --user-data-dir (never anything else). */
  function browserPid(id: string): number | null {
    if (process.platform !== "win32") return null;
    const udd = path.join(PROFILES, id, "userdata");
    const ps =
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -like '*--user-data-dir=" +
      udd +
      "*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1 -ExpandProperty ProcessId";
    const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).trim();
    return out ? Number(out) : null;
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** What Chromium recorded about its last shutdown: "Normal", or "Crashed" after a hard kill. */
  const exitType = (id: string) => {
    try {
      return (readJson(path.join(PROFILES, id, "userdata", "Default", "Preferences")) as { profile?: { exit_type?: string } }).profile?.exit_type;
    } catch {
      return undefined;
    }
  };
  async function launchAndWait(id: string) {
    const card = win.locator(`[data-card="${id}"]`);
    await card.getByRole("button", { name: "Launch" }).click();
    await card.getByRole("button", { name: "Stop" }).waitFor({ timeout: 120000 });
    return card;
  }
  const winVisible = () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false);

  it.runIf(!!KEY && process.platform === "win32")("Stop closes the browser gracefully — Chromium records a NORMAL exit, not a crash", async () => {
    const card = await launchAndWait("alpha");
    // Chromium writes Preferences in batches; wait until it has recorded its "running" state, so
    // this proves the SHUTDOWN, not just an untouched file.
    await until(() => exitType("alpha"), (v) => v === "Crashed", "the running state was written", 60000);
    await card.getByRole("button", { name: "Stop" }).click();
    await card.getByRole("button", { name: "Launch" }).waitFor({ timeout: 30000 });
    await until(() => exitType("alpha"), (v) => v === "Normal", "a normal shutdown recorded");
  }, 240000);

  it.runIf(!!KEY && process.platform === "win32")("a browser ended from outside the app says so on its card", async () => {
    const card = await launchAndWait("alpha");
    const pid = await until(() => browserPid("alpha"), (p) => !!p, "found the browser process");
    execFileSync("taskkill", ["/F", "/PID", String(pid)]); // what Task Manager's End task does
    await card.getByText("Closed from outside the app").waitFor({ timeout: 30000 });
    expect(await card.textContent()).toContain("exit code 1");
    await card.getByRole("button", { name: "Dismiss" }).click();
  }, 240000);

  it.runIf(!!KEY && process.platform === "win32")("close to the tray: the window hides and the browser keeps running", async () => {
    fs.writeFileSync(SETTINGS, JSON.stringify({ ...settings(), closeBehavior: "tray" }));
    await launchAndWait("alpha");
    const pid = await until(() => browserPid("alpha"), (p) => !!p, "browser pid");
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await until(winVisible, (v) => v === false, "hidden to the tray");
    await new Promise((r) => setTimeout(r, 1500));
    expect(alive(pid!)).toBe(true);
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await until(winVisible, (v) => v === true, "shown again");
  }, 240000);

  it.runIf(!!KEY && process.platform === "win32")("'ask' remembers the choice when told to", async () => {
    const cur = settings();
    delete cur.closeBehavior;
    fs.writeFileSync(SETTINGS, JSON.stringify(cur));
    // Stand in for the person clicking "Keep running in the tray" with "Remember my choice" ticked.
    await app!.evaluate(({ dialog }) => {
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({ response: 0, checkboxChecked: true });
    });
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await until(winVisible, (v) => v === false, "hidden to the tray");
    await until(() => settings().closeBehavior, (v) => v === "tray", "choice remembered");
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  }, 120000);

  it.runIf(!!KEY && process.platform === "win32")("close and quit: every browser is closed properly before the app exits", async () => {
    fs.writeFileSync(SETTINGS, JSON.stringify({ ...settings(), closeBehavior: "quit" }));
    const pid = await until(() => browserPid("alpha"), (p) => !!p, "alpha still running from before");
    const exited = new Promise<void>((r) => app!.process().once("exit", () => r()));
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await exited;
    app = null;
    await until(() => alive(pid!), (v) => v === false, "browser closed with the app");
    expect(exitType("alpha")).toBe("Normal");
    fs.writeFileSync(SETTINGS, JSON.stringify({ ...settings(), closeBehavior: "ask" }));
    await start();
  }, 240000);

  it("the window reopens where it was", async () => {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 120, y: 90, width: 1000, height: 700 }));
    await until(() => settings().window as { x: number } | undefined, (w) => !!w && w.x === 120, "saved");
    await stopApp();
    await start();
    const b = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    expect(Math.abs(b.x - 120)).toBeLessThanOrEqual(2);
    expect(Math.abs(b.y - 90)).toBeLessThanOrEqual(2);
    expect(Math.abs(b.width - 1000)).toBeLessThanOrEqual(2);
    expect(Math.abs(b.height - 700)).toBeLessThanOrEqual(2);
  }, T);

  it("renaming a group renames it on every profile file", async () => {
    await win.getByRole("button", { name: "Group Team" }).click();
    await win.getByRole("menuitem", { name: "Rename group…" }).click();
    await win.getByRole("dialog").getByLabel("New name").fill("Crew");
    await win.getByRole("dialog").getByRole("button", { name: "Rename" }).click();
    await until(() => [profileOnDisk("alpha").group, profileOnDisk("beta").group].join(), (v) => v === "Crew,Crew", "both renamed on disk");
  }, T);

  it("Storage: removes only unused builds, cleans temp copies, clears a cache but keeps the logins", async () => {
    // A throwaway cache and temp folder — never the real ones.
    const fakeCache = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-app-cache-"));
    const fakeTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-app-tmp-"));
    try {
      const build = (dir: string, marker = true) => {
        fs.mkdirSync(path.join(dir, "browser"), { recursive: true });
        fs.writeFileSync(path.join(dir, "browser", "chrome.exe"), Buffer.alloc(1_500_000));
        if (marker) fs.writeFileSync(path.join(dir, ".verified"), "x");
      };
      build(path.join(fakeCache, "pro-153.0.8010.36-r27")); // what Latest runs (licensed)
      build(path.join(fakeCache, "pro-152.0.7977.82-r22")); // nothing uses it
      build(path.join(fakeCache, "pro-151.0.7922.108-r18")); // "pinned" pins it
      build(path.join(fakeTmp, "clearcote-recover-abc"), false);
      build(path.join(fakeTmp, "clearcote-live", "0123456789abcdef"), false);
      // A cache next to real logins, in the profile that has been launched.
      const def = path.join(PROFILES, "alpha", "userdata", "Default");
      fs.mkdirSync(path.join(def, "Cache", "Cache_Data"), { recursive: true });
      fs.writeFileSync(path.join(def, "Cache", "Cache_Data", "data_1"), Buffer.alloc(300_000));
      if (!fs.existsSync(path.join(def, "Preferences"))) fs.writeFileSync(path.join(def, "Preferences"), "{}");

      await stopApp();
      await start({ CLEARCOTE_CACHE: fakeCache, TEMP: fakeTmp, TMP: fakeTmp });
      await win.keyboard.press("Control+Comma");
      const dlg = win.getByRole("dialog", { name: "Settings" });
      await dlg.getByRole("button", { name: "Storage" }).click();
      if (KEY) {
        await dlg.getByRole("button", { name: /^Remove unused · frees 2 MB$/ }).click({ timeout: 30000 });
        await dlg.getByText(/^Removed 1 build/).waitFor();
        expect(fs.readdirSync(fakeCache).sort()).toEqual(["pro-151.0.7922.108-r18", "pro-153.0.8010.36-r27"]);
      }
      await dlg.getByRole("button", { name: "Clean up" }).click();
      await dlg.getByText(/^Cleaned up/).waitFor();
      expect(fs.existsSync(path.join(fakeTmp, "clearcote-recover-abc"))).toBe(false);
      expect(fs.existsSync(path.join(fakeTmp, "clearcote-live", "0123456789abcdef"))).toBe(false);

      await dlg.getByRole("button", { name: "Clear cache of alpha" }).click();
      await win.getByRole("dialog", { name: "Clear the cache of “alpha”?" }).getByRole("button", { name: "Clear cache" }).click();
      await dlg.getByText(/^Cleared .* from “alpha”\./).waitFor();
      expect(fs.existsSync(path.join(def, "Cache"))).toBe(false);
      expect(fs.existsSync(path.join(def, "Preferences"))).toBe(true);
      await win.keyboard.press("Escape");
    } finally {
      await stopApp();
      fs.rmSync(fakeCache, { recursive: true, force: true });
      fs.rmSync(fakeTmp, { recursive: true, force: true });
    }
  }, 240000);
});
