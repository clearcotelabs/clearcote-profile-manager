// Retake the README screenshots from the real, built desktop app (not the browser preview).
//
//   npm run build
//   node scripts/screenshots.mjs [--binary <chrome.exe>] [--jet "<command>" --jet-env <file with TYPESAFE_API_KEY>]
//
// The app runs against a throwaway --user-data-dir seeded with example profiles (names, proxies and
// exits are made up), at 1340×900 and twice the pixels, so every shot is 2680×1800 like the old ones.
// With --binary two profiles are launched for real, so their cards show as running. With --jet a real
// task runs on three profiles against a local page, and the run board is captured while they wait
// for approval. Everything it starts is closed and the throwaway folder removed at the end.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(APP_DIR, "docs", "screenshots");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const BINARY = arg("--binary");
const JET = arg("--jet");
const JET_ENV = arg("--jet-env");

const now = Date.now();
const ago = (h) => new Date(now - h * 3600_000).toISOString();
const geo = (city, country, countryCode, ip, proxy) => ({ ip, city, country, countryCode, at: ago(1), proxy });
const P = (id, name, over = {}) => ({
  id,
  name,
  fingerprint: String(100000 + Math.floor(Math.random() * 899999)),
  platform: "windows",
  brand: "Chrome",
  geoip: true,
  widevine: true,
  createdAt: ago(24 * 9),
  updatedAt: ago(24 * 2),
  ...over,
});
const PROFILES = [
  P("shop-us-01", "Shop US 01", {
    group: "Storefronts", tags: ["us", "warm"], proxy: "http://user:secret@us1.proxy.example.net:8080",
    lastGeo: geo("Chicago", "United States", "US", "198.51.100.23", "http us1.proxy.example.net:8080"), lastLaunchedAt: ago(2),
    vars: [{ key: "email", value: "ana.ruiz@example.com" }, { key: "password", value: "example-pass-1", secret: true }],
  }),
  P("shop-us-02", "Shop US 02", {
    group: "Storefronts", tags: ["us"], proxy: "http://user:secret@us2.proxy.example.net:8080",
    lastGeo: geo("Dallas", "United States", "US", "198.51.100.71", "http us2.proxy.example.net:8080"), lastLaunchedAt: ago(5),
    vars: [{ key: "email", value: "tom.hale@example.com" }, { key: "password", value: "example-pass-2", secret: true }],
  }),
  P("shop-de-01", "Shop DE 01", {
    group: "Storefronts", tags: ["eu"], proxy: "socks5://user:secret@de1.proxy.example.net:1080",
    lastGeo: geo("Frankfurt", "Germany", "DE", "203.0.113.40", "socks5 de1.proxy.example.net:1080"), lastLaunchedAt: ago(26),
    vars: [{ key: "email", value: "lena.vogel@example.com" }, { key: "password", value: "example-pass-3", secret: true }],
  }),
  P("research-mac", "Research Mac", { group: "Research", tags: ["mac"], platform: "macos", lastLaunchedAt: ago(30) }),
  P("research-linux", "Research Linux", { group: "Research", platform: "linux", tags: ["linux"], lastLaunchedAt: ago(72) }),
  P("social-fr", "Social FR", {
    group: "Social", tags: ["eu", "social"], proxy: "http://user:secret@fr1.proxy.example.net:8080",
    lastGeo: geo("Paris", "France", "FR", "203.0.113.88", "http fr1.proxy.example.net:8080"), lastLaunchedAt: ago(4),
  }),
  P("social-mobile", "Social mobile", { group: "Social", tags: ["social"], platform: "android", lastLaunchedAt: ago(50) }),
  P("scratch", "Scratch", { notes: "Throwaway profile for quick checks." }),
  P("daily", "Daily browsing", { group: "Personal", tags: ["home"], geoip: false, timezone: "Europe/Amsterdam", acceptLanguage: "nl-NL,nl,en", lastLaunchedAt: ago(1) }),
  P("banking", "Banking", { group: "Personal", tags: ["home"], geoip: false, timezone: "Europe/Amsterdam", acceptLanguage: "nl-NL,nl,en", lastLaunchedAt: ago(8) }),
];

/** A two-page shop for the task shot: sign in, then an order button that can't be taken back. */
function shop() {
  const page = (b) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example shop</title></head><body>${b}</body></html>`;
  return http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://x");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (u.pathname === "/") {
      res.end(page(`<h1>Example shop</h1><form action="/basket"><label>Email <input name="email" type="email" required></label>
        <label>Password <input name="password" type="password" required></label><button>Sign in</button></form>`));
    } else if (u.pathname === "/basket") {
      res.end(page(`<h1>Your basket</h1><p>1 × Blue mug</p><form action="/done"><button>Place order</button></form>`));
    } else res.end(page("<h1>Order placed</h1>"));
  });
}

async function main() {
  const { _electron } = await import("playwright-core");
  const UDD = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-shots-"));
  fs.mkdirSync(path.join(UDD, "profiles"), { recursive: true });
  const settings = { theme: "dark", updateCheck: false, crlset: false, closeBehavior: "quit", syncConcurrency: 2, syncStaggerSec: [2, 8] };
  if (BINARY && BINARY !== "latest") settings.binaryPath = BINARY;
  if (JET) {
    settings.jetCommand = JET;
    if (JET_ENV) {
      const m = fs.readFileSync(JET_ENV, "utf8").match(/^\s*TYPESAFE_API_KEY\s*=\s*["']?([^"'\r\n]+)/m);
      if (m) settings.jetApiKey = m[1].trim();
    }
  }
  fs.writeFileSync(path.join(UDD, "settings.json"), JSON.stringify(settings, null, 2));

  const env = { ...process.env, CLEARCOTE_JET_SKILLS: path.join(UDD, "skills"), CLEARCOTE_JET_ALLOW_PRIVATE_EGRESS: "1" };
  delete env.ELECTRON_DEV;
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () =>
    _electron.launch({ executablePath: require("electron"), args: [APP_DIR, `--user-data-dir=${UDD}`] , env });

  let app = await launch();
  let server;
  try {
    const sized = async () => {
      const win = await app.firstWindow();
      await win.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
      // The page itself at 1340×900 and twice the pixels (2680×1800), whatever
      // size the window opened at.
      const cdp = await win.context().newCDPSession(win);
      win._cdp = cdp;
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1340, height: 900, deviceScaleFactor: 2, mobile: false });
      await win.waitForTimeout(800);
      return win;
    };
    const shot = async (win, name) => {
      await win.mouse.move(1330, 890); // no hover states in the picture
      await win.waitForTimeout(400);
      // Through DevTools: Playwright's own screenshot of an Electron page drops the 2× scale.
      const { data } = await win._cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, "base64"));
      console.log(`saved docs/screenshots/${name}.png`);
    };

    // 1. Empty state (no profiles yet).
    let win = await sized();
    await shot(win, "empty-state");
    await app.close();

    // 2. The workspace with profiles; two running when a browser binary was given.
    for (const p of PROFILES) fs.writeFileSync(path.join(UDD, "profiles", `${p.id}.json`), JSON.stringify(p, null, 2));
    app = await launch();
    win = await sized();
    if (BINARY) {
      for (const name of ["Daily browsing", "Banking"]) {
        const card = win.locator("[data-card]", { hasText: name }).first();
        await card.getByRole("button", { name: "Launch", exact: true }).click();
        await win.waitForTimeout(6000);
      }
      await win.bringToFront().catch(() => {});
      await win.waitForTimeout(5000); // let the launch toast fade;
    }
    await shot(win, "profile-manager");

    // 3. Light theme.
    const theme = async (t) => {
      await win.evaluate((v) => localStorage.setItem("clearcote.theme", v), t);
      await win.reload();
      await win.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
      await win.waitForTimeout(1000);
    };
    await theme("light");
    await shot(win, "light-theme");
    await theme("dark");

    // 4. Table view.
    const table = win.getByRole("button", { name: "Table", exact: true }).first();
    if (await table.count()) {
      await table.click();
      await win.waitForTimeout(800);
      await shot(win, "table-view");
      await win.getByRole("button", { name: "Cards", exact: true }).first().click();
      await win.waitForTimeout(500);
    }

    // 5. The editor, on a profile with task values.
    await win.evaluate(() => localStorage.setItem("clearcote.editor.mode", "all"));
    await win.locator("[data-card]", { hasText: "Shop US 01" }).first().getByRole("button", { name: "Edit" }).first().click();
    await win.waitForTimeout(800);
    await win.locator("nav button", { hasText: "Identity" }).first().click().catch(() => {});
    await win.locator("[data-task-values]").scrollIntoViewIfNeeded().catch(() => {});
    await win.waitForTimeout(800);
    await shot(win, "editor");
    await win.keyboard.press("Escape");
    await win.waitForTimeout(600);

    // 6. Run a task: the dialog, then the run board while every profile waits before "Place order", then the
    //    saved task on the Tasks page (recipe, values, the steps Jet took, the run).
    if (JET && BINARY) {
      server = shop();
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${server.address().port}/`;
      for (const name of ["Shop US 01", "Shop US 02", "Shop DE 01"]) {
        const card = win.locator("[data-card]", { hasText: name }).first();
        await card.hover();
        await card.locator('input[type="checkbox"]').first().check();
      }
      await win.locator("[data-bulk-run-task]").click();
      await win.locator("[data-run-goal]").fill("Sign in with the email {{email}} and the password {{password}}, then place the order.");
      await win.getByLabel("Start page").fill(url);
      await win.locator('[data-jet-setup="ready"]').waitFor({ timeout: 60_000 });
      // All three at once (the board shows finished and waiting rows), saved as a task for the Tasks page.
      await win.locator("[data-run-trial]").uncheck();
      await win.locator("[data-run-save-toggle]").check();
      await win.locator("[data-run-save-name]").fill("Place the weekly order");
      await win.waitForTimeout(500);
      await shot(win, "run-task");
      await win.locator("[data-run-start]").click();
      // Approve each profile as it reaches "Place order" except the last two, so the board shows both
      // finished and waiting rows. A row that fails stops the script: this run doubles as an app test.
      const deadline = Date.now() + 300_000;
      let approved = 0;
      for (;;) {
        if (Date.now() > deadline) throw new Error("the task run did not reach the approval step in time");
        const bad = await win.locator('[data-task-row][data-status="failed"], [data-task-row][data-status="blocked"], [data-task-row][data-status="needs_input"]').count();
        if (bad) throw new Error(`a profile's task ended badly: ${await win.locator("[data-task-board]").innerText()}`);
        const waiting = win.locator('[data-task-row][data-status="waiting_approval"]');
        const done = await win.locator('[data-task-row][data-status="done"]').count();
        if (approved < 1 && (await waiting.count())) {
          await waiting.first().locator("[data-task-approve]").click();
          approved++;
        } else if (done >= 1 && (await waiting.count()) >= 2) break;
        await win.waitForTimeout(1000);
      }
      await win.bringToFront().catch(() => {});
      await win.keyboard.press("Escape");
      await win.waitForTimeout(1500);
      await shot(win, "task-board");
      await win.locator("[data-task-stop]").click().catch(() => {});
      await win.waitForTimeout(2000);
      await win.locator("[data-task-clear]").click().catch(() => {});
      await win.locator("[data-nav-tasks]").click();
      await win.locator("[data-step-timeline]").waitFor();
      // From the top: the page may still be scrolled from the profiles view.
      await win.evaluate(() => {
        for (let el = document.querySelector("[data-tasks-view]"); el; el = el.parentElement) el.scrollTop = 0;
        window.scrollTo(0, 0);
      });
      await win.waitForTimeout(800);
      await shot(win, "tasks-page");
      await win.locator("[data-step-timeline]").scrollIntoViewIfNeeded();
      await win.waitForTimeout(500);
      await shot(win, "task-steps");
    }
  } finally {
    await app.close().catch(() => {});
    server?.close();
    // The app closes its browsers on quit (closeBehavior "quit"); give them a moment before the folder goes.
    await new Promise((r) => setTimeout(r, 3000));
    fs.rmSync(UDD, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
