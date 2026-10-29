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
    group: "Storefronts", tags: ["eu"], proxy: "socks5://user:secret@de1.proxy.example.net:1080", socks5Udp: true,
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
  const settings = { theme: "dark", updateCheck: false, crlset: false, closeBehavior: "quit" };
  if (BINARY) settings.binaryPath = BINARY;
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
    _electron.launch({ executablePath: require("electron"), args: [APP_DIR, `--user-data-dir=${UDD}`, "--force-device-scale-factor=2"], env });

  let app = await launch();
  let server;
  try {
    const sized = async () => {
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.unmaximize();
        w.setContentSize(1340, 900);
        w.center();
      });
      const win = await app.firstWindow();
      await win.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
      await win.waitForTimeout(800);
      return win;
    };
    const shot = async (win, name) => {
      await win.mouse.move(1330, 890); // no hover states in the picture
      await win.waitForTimeout(400);
      await win.screenshot({ path: path.join(OUT, `${name}.png`) });
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
      for (const name of ["Shop US 01", "Social FR"]) {
        const card = win.locator("[data-card]", { hasText: name }).first();
        await card.getByRole("button", { name: "Launch", exact: true }).click();
        await win.waitForTimeout(6000);
      }
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
      await win.waitForTimeout(1500);
    }
    await shot(win, "profile-manager");

    // 3. Light theme.
    await win.getByRole("button", { name: /☀|☾/ }).first().click().catch(async () => {
      await win.evaluate(() => localStorage.setItem("clearcote.theme", "light"));
      await win.reload();
    });
    await win.waitForTimeout(800);
    await shot(win, "light-theme");
    await win.getByRole("button", { name: /☀|☾/ }).first().click().catch(() => {});
    await win.waitForTimeout(500);

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
    await win.locator("[data-card]", { hasText: "Shop DE 01" }).first().getByRole("button", { name: "Edit" }).first().click();
    await win.waitForTimeout(1000);
    await shot(win, "editor");
    await win.keyboard.press("Escape");
    await win.waitForTimeout(600);

    // 6. Run a task: the dialog, then the run board while every profile waits before "Place order".
    if (JET && BINARY) {
      server = shop();
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${server.address().port}/`;
      for (const name of ["Shop US 01", "Shop US 02", "Shop DE 01"]) {
        await win.locator("[data-card]", { hasText: name }).first().click({ modifiers: ["Control"], position: { x: 12, y: 12 } });
      }
      await win.locator("[data-bulk-run-task]").click();
      await win.locator("[data-run-goal]").fill("Sign in with the email {{email}} and the password {{password}}, then place the order.");
      await win.getByLabel("Start page").fill(url);
      await win.waitForTimeout(500);
      await shot(win, "run-task");
      await win.locator("[data-run-start]").click();
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        const waiting = await win.locator('[data-task-row][data-status="waiting_approval"]').count();
        const ended = await win.locator('[data-task-row][data-status="failed"], [data-task-row][data-status="blocked"]').count();
        if (waiting >= 2 || ended) break;
        await win.waitForTimeout(1000);
      }
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
      await win.keyboard.press("Escape");
      await win.waitForTimeout(1500);
      await shot(win, "task-board");
      await win.locator("[data-task-stop]").click().catch(() => {});
      await win.waitForTimeout(2000);
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
