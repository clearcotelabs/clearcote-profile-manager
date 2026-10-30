// End-to-end for the web version (app.clearcotelabs.com) against a real Clearcote Helper: the static export
// (`npm run web:build` → out/) served on localhost, the helper bundle (`node helper/build.mjs --bundle-only`)
// started the way `clearcote connect CODE` starts it, on its own data folder. It checks that the web version
// does what the desktop app does: the preview, pairing with the code the page shows, profiles (create, edit,
// group, delete with undo), a real browser launched and stopped, Settings (keys masked, locked fields),
// Storage, the Proxies page, export and import, and Run a task with real Jet, saved as a task, on the Tasks page.
//
// Opt-in — needs a browser build, a licence key and Jet with a model key:
//
//   npm run web:build && node helper/build.mjs --bundle-only
//   CLEARCOTE_WEB_E2E=1 \
//   CLEARCOTE_BINARY="C:\...\pro-156.0.8078.47-r54\browser\chrome.exe" \
//   CLEARCOTE_SETTINGS_FROM="%APPDATA%\Clearcote Profile Manager\settings.json"   # the licence key is read from it
//   CLEARCOTE_JET_ENV_FILE="...\clearcote-agent\.env"                               # TYPESAFE_API_KEY=…
//   npx vitest run tests/web.helper.e2e.test.ts
//
// Keys are read here and written only to the test's own data folder; they are never printed.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Browser, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_WEB_E2E === "1" && !!process.env.CLEARCOTE_BINARY;
const OUT = path.resolve(__dirname, "../out");
const HELPER = path.resolve(__dirname, "../helper-dist/lib/clearcote-helper.js");
const PORT = Number(process.env.CLEARCOTE_WEB_PORT || 3190);
const ORIGIN = `http://localhost:${PORT}`;
const DATA = READY ? fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-web-e2e-")) : "";
const JET = !!process.env.CLEARCOTE_JET_ENV_FILE;

function jetKey(): string {
  const m = fs.readFileSync(process.env.CLEARCOTE_JET_ENV_FILE!, "utf8").match(/^\s*TYPESAFE_API_KEY\s*=\s*["']?([^"'\r\n]+)/m);
  if (!m) throw new Error("no TYPESAFE_API_KEY in CLEARCOTE_JET_ENV_FILE");
  return m[1].trim();
}

/** out/ as GitHub Pages serves it: /x → x.html, / → index.html. */
function staticSite() {
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ico": "image/x-icon", ".txt": "text/plain" };
  return http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url || "/", "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    let f = path.join(OUT, p);
    if (!f.startsWith(OUT)) return void res.writeHead(403).end();
    if (!fs.existsSync(f) && fs.existsSync(f + ".html")) f += ".html";
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) return void res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream", "Referrer-Policy": "same-origin" });
    fs.createReadStream(f).pipe(res);
  });
}

/** A page for Jet: a newsletter form that records what arrived. */
function newsletter() {
  const got: string[] = [];
  const page = (b: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Newsletter</title></head><body>${b}</body></html>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://x");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (u.pathname === "/") {
      res.end(page(`<h1>Weekly news</h1><form action="/thanks" method="get"><label>Email <input name="email" type="email" required></label><button type="submit">Subscribe</button></form>`));
    } else if (u.pathname === "/thanks") {
      got.push(u.searchParams.get("email") || "");
      res.end(page(`<h1>Thanks for subscribing</h1>`));
    } else res.writeHead(404).end();
  });
  return { server, got };
}

describe.skipIf(!READY)("the web version against a real helper", () => {
  const site = staticSite();
  const news = newsletter();
  let newsUrl = "";
  let helperProc: ChildProcess | null = null;
  const helperLog: string[] = [];
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  const readProfiles = () =>
    fs.existsSync(path.join(DATA, "profiles"))
      ? fs
          .readdirSync(path.join(DATA, "profiles"))
          .filter((f) => f.endsWith(".json"))
          .flatMap((f) => {
            try {
              return [JSON.parse(fs.readFileSync(path.join(DATA, "profiles", f), "utf8"))];
            } catch {
              return []; // being written right now
            }
          })
      : [];
  const goProfiles = () => page.getByLabel("Workspace").getByRole("button").first().click();
  const readSettings = () => JSON.parse(fs.readFileSync(path.join(DATA, "settings.json"), "utf8"));

  async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, what: string, ms = 15000): Promise<T> {
    const deadline = Date.now() + ms;
    let last: T = await read();
    while (Date.now() < deadline) {
      last = await read();
      if (ok(last)) return last;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`${what}: last saw ${JSON.stringify(last)?.slice(0, 400)}`);
  }

  beforeAll(async () => {
    if (!fs.existsSync(path.join(OUT, "index.html"))) throw new Error("run `npm run web:build` first");
    if (!fs.existsSync(HELPER)) throw new Error("run `node helper/build.mjs --bundle-only` first");
    await new Promise<void>((r) => site.listen(PORT, "127.0.0.1", () => r()));
    await new Promise<void>((r) => news.server.listen(0, "127.0.0.1", () => r()));
    newsUrl = `http://127.0.0.1:${(news.server.address() as AddressInfo).port}/`;

    const from = process.env.CLEARCOTE_SETTINGS_FROM ? JSON.parse(fs.readFileSync(process.env.CLEARCOTE_SETTINGS_FROM, "utf8")) : {};
    fs.writeFileSync(
      path.join(DATA, "settings.json"),
      JSON.stringify({ binaryPath: process.env.CLEARCOTE_BINARY, licenseKey: from.licenseKey, jetApiKey: JET ? jetKey() : undefined, crlset: false }),
    );

    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true, executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined });
    const ctx = await browser.newContext({ viewport: { width: 1340, height: 900 }, acceptDownloads: true });
    page = await ctx.newPage();
    page.setDefaultTimeout(12000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
  }, 120000);

  afterAll(async () => {
    await browser?.close();
    if (helperProc?.pid) {
      // The helper and the browsers it started (this test's own process tree only).
      try {
        if (process.platform === "win32") execFileSync("taskkill", ["/T", "/F", "/PID", String(helperProc.pid)], { stdio: "ignore" });
        else helperProc.kill();
      } catch {
        /* already gone */
      }
    }
    site.close();
    news.server.close();
    await new Promise((r) => setTimeout(r, 1500));
    try {
      fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* a browser file still closing */
    }
  }, 60000);

  it("the preview shows the example profiles and the Tasks page, and Launch asks to connect", async () => {
    expect(await page.locator("[data-card], [data-row]").count()).toBeGreaterThanOrEqual(3);
    expect(await page.locator("[data-nav-tasks]").count()).toBe(1);
    await page.locator("[data-nav-tasks]").click();
    await page.locator("[data-tasks-view]").waitFor();
    await goProfiles();
    await page.getByRole("button", { name: "Launch" }).first().click();
    await page.getByRole("dialog").filter({ hasText: /clearcote connect/ }).waitFor({ timeout: 20000 });
  }, 40000);

  it("pairs with the code the page shows, as `clearcote connect CODE` does", async () => {
    const text = await page.getByRole("dialog").filter({ hasText: /clearcote connect/ }).innerText();
    const code = text.match(/clearcote connect\s+([2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3})\b/)?.[1];
    expect(code, text).toBeTruthy();
    helperProc = spawn(process.execPath, [HELPER, "--no-open", "--allow-origin", ORIGIN, "--pair-code", code!], {
      env: {
        ...process.env,
        CLEARCOTE_PM_DATA_DIR: DATA,
        CLEARCOTE_JET_ALLOW_PRIVATE_EGRESS: "1",
        CLEARCOTE_JET_SKILLS: path.join(DATA, "jet-skills"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    helperProc.stdout!.on("data", (d) => helperLog.push(String(d)));
    helperProc.stderr!.on("data", (d) => helperLog.push(String(d)));
    await until(() => page.evaluate(() => localStorage.getItem("clearcote.helper")), (v) => !!v, `paired with ${code} (helper said: ${helperLog.join("").slice(-1500)})`, 30000);
    await until(() => page.getByRole("dialog").filter({ hasText: /clearcote connect/ }).count(), (n) => n === 0, "connect dialog closed");
    // The examples stay in the preview: the computer has no profiles yet.
    await until(() => page.locator("[data-card], [data-row]").count(), (n) => n === 0, "the computer's (empty) list", 20000);
  }, 60000);

  it("creates a profile, edits it and puts it in a group — saved on the computer", async () => {
    await page.getByRole("button", { name: "New profile" }).first().click();
    const dlg = page.getByRole("dialog", { name: "New profile" });
    await dlg.waitFor();
    await dlg.locator('[data-field="name"] input').fill("Web E2E");
    await dlg.getByRole("button", { name: /^(Create|Save)/ }).first().click();
    const [p] = await until(readProfiles, (l) => l.length === 1 && l[0].name === "Web E2E", "profile file written");
    expect(p.fingerprint || p.fingerprintProfile).toBeTruthy();

    const card = page.locator(`[data-card="${p.id}"], [data-row="${p.id}"]`).first();
    await card.waitFor();
    await card.getByRole("button", { name: "Edit" }).first().click();
    const ed = page.getByRole("dialog", { name: "Edit profile" });
    await ed.waitFor();
    await ed.locator('[data-field="name"] input').fill("Web E2E shop");
    await ed.getByRole("button", { name: /^Save/ }).first().click();
    await until(readProfiles, (l) => l[0]?.name === "Web E2E shop", "edit saved");
    // A bulk action: Set group… on the selected profile.
    await page.getByRole("checkbox", { name: "Select Web E2E shop" }).click();
    await page.getByRole("region", { name: "Selected profiles" }).getByRole("button", { name: "Set group…" }).click();
    await page.getByRole("dialog").getByLabel("Group").fill("Web shops");
    await page.getByRole("dialog").getByRole("button", { name: "Set group" }).click();
    await until(readProfiles, (l) => l[0]?.group === "Web shops", "group saved");
    await page.getByRole("checkbox", { name: "Select Web E2E shop" }).click();
    await page.getByRole("button", { name: /Web shops/ }).first().waitFor();
  }, 40000);

  it("launches a real browser and stops it", async () => {
    const [p] = readProfiles();
    const card = page.locator(`[data-card="${p.id}"], [data-row="${p.id}"]`).first();
    await card.getByRole("button", { name: "Launch" }).click();
    await until(() => card.innerText(), (s) => /running/i.test(s), "running", 90000);
    expect(fs.existsSync(path.join(DATA, "profiles"))).toBe(true);
    await card.getByRole("button", { name: "Stop" }).click();
    await until(() => card.innerText(), (s) => !/running/i.test(s), "stopped", 30000);
  }, 150000);

  it("Settings: the licence key is masked, saving keeps it, and Jet's command and automation are locked", async () => {
    const before = readSettings();
    await page.getByRole("button", { name: "Settings" }).first().click();
    const dlg = page.getByRole("dialog", { name: "Settings" });
    await dlg.waitFor();
    const html = await dlg.innerHTML();
    if (before.licenseKey) expect(html).not.toContain(before.licenseKey);
    await dlg.getByRole("button", { name: "Tasks" }).first().click();
    await dlg.locator("[data-tasks-settings]").waitFor();
    expect(await dlg.locator("#jet-command").getAttribute("readonly")).not.toBeNull();
    expect(await dlg.locator("[data-automation-toggle]").isDisabled()).toBe(true);
    if (JET) await dlg.locator('[data-jet-setup="ready"]').waitFor({ timeout: 60000 });
    await page.keyboard.press("Escape");
    expect(readSettings().licenseKey).toBe(before.licenseKey);
  }, 90000);

  it("Storage lists the profile's browser data on the computer", async () => {
    await page.getByRole("button", { name: "Settings" }).first().click();
    const dlg = page.getByRole("dialog", { name: "Settings" });
    await dlg.getByRole("button", { name: "Storage" }).first().click();
    await until(() => dlg.innerText(), (s) => /Web E2E shop/.test(s), "profile in Storage", 30000);
    await page.keyboard.press("Escape");
  }, 40000);

  it("export downloads the profiles and import brings them back as new ones", async () => {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const [down] = await Promise.all([page.waitForEvent("download"), page.getByRole("dialog").getByRole("button", { name: "Export…" }).click()]);
    const file = path.join(DATA, "export.json");
    await down.saveAs(file);
    const exported = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(JSON.stringify(exported)).toContain("Web E2E shop");

    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await (await chooser).setFiles(file);
    await until(readProfiles, (l) => l.length === 2, "imported as a second profile");
  }, 40000);

  it("deletes the imported copy, with undo", async () => {
    const copy = readProfiles().find((p) => p.id !== readProfiles()[0].id) ?? readProfiles()[1];
    const card = page.locator(`[data-card="${copy.id}"], [data-row="${copy.id}"]`).first();
    await card.getByRole("button", { name: /More actions/ }).click();
    await page.getByRole("menuitem", { name: /Delete/ }).click();
    const confirm = page.getByRole("dialog", { name: /^Delete/ });
    if (await confirm.count()) await confirm.getByRole("button", { name: "Delete" }).click();
    await until(readProfiles, (l) => l.length === 1, "deleted");
    await page.getByRole("button", { name: "Undo" }).click();
    await until(readProfiles, (l) => l.length === 2, "restored");
    // Clean up the copy for the task run.
    await card.getByRole("button", { name: /More actions/ }).click();
    await page.getByRole("menuitem", { name: /Delete/ }).click();
    if (await confirm.count()) await confirm.getByRole("button", { name: "Delete" }).click();
    await until(readProfiles, (l) => l.length === 1, "deleted again");
  }, 40000);

  it("the Proxies page lists a proxy set on the profile", async () => {
    const [p] = readProfiles();
    const card = page.locator(`[data-card="${p.id}"], [data-row="${p.id}"]`).first();
    await card.getByRole("button", { name: "Edit" }).first().click();
    const ed = page.getByRole("dialog", { name: "Edit profile" });
    await ed.locator("[data-proxy-input]").fill("socks5://10.9.9.9:2000");
    await ed.getByRole("button", { name: /^Save/ }).first().click();
    await until(readProfiles, (l) => /10\.9\.9\.9/.test(JSON.stringify(l[0].proxy ?? "")), "proxy saved");
    await page.getByLabel("Workspace").getByRole("button", { name: /^Proxies/ }).click();
    await page.locator('[data-proxy-row="socks5 10.9.9.9:2000"]').waitFor();
    // Back to no proxy so the task run reaches the local page.
    await goProfiles();
    await card.getByRole("button", { name: "Edit" }).first().click();
    await ed.locator("[data-proxy-input]").fill("");
    await ed.getByRole("button", { name: /^Save/ }).first().click();
    await until(readProfiles, (l) => !l[0].proxy, "proxy cleared");
  }, 40000);

  it.skipIf(!JET)("Run a task with real Jet, save it as a task, and find it on the Tasks page", async () => {
    const [p] = readProfiles();
    await page.getByRole("checkbox", { name: "Select Web E2E shop" }).check();
    await page.locator("[data-bulk-run-task]").click();
    await page.locator("[data-run-task]").waitFor();
    await page.locator('[data-jet-setup="ready"]').waitFor({ timeout: 60000 });
    await page.locator("[data-run-goal]").fill("Subscribe to the newsletter with the email {{email}}.");
    await page.locator("[data-run-url]").fill(newsUrl);
    await page.locator(`[data-run-fill-cell="${p.id}:email"]`).fill("web-e2e@example.com");
    await page.locator("[data-run-save-toggle]").check();
    await page.locator("[data-run-save-name]").fill("Subscribe");
    await page.locator("[data-run-start]").click();
    const summary = () => page.locator("[data-task-summary]").innerText().catch(() => "");
    try {
      await until(
        async () => {
          const b = page.locator("[data-task-approve-all]");
          if (await b.count()) await b.click({ timeout: 3000 }).catch(() => {});
          return summary();
        },
        (s) => /finished/.test(s),
        "run finished",
        240000,
      );
    } catch (e) {
      await page.screenshot({ path: path.join(os.tmpdir(), "ccpm-web-e2e-run.png") }).catch(() => {});
      throw new Error(`${(e as Error).message}
helper said:
${helperLog.join("").slice(-4000)}`);
    }
    expect(await summary(), helperLog.join("").slice(-3000)).toMatch(/1 of 1 done/);
    expect(news.got).toContain("web-e2e@example.com");

    const tasks = JSON.parse(fs.readFileSync(path.join(DATA, "tasks.json"), "utf8"));
    const list = Array.isArray(tasks) ? tasks : tasks.tasks;
    expect(list.map((t: { name: string }) => t.name)).toContain("Subscribe");
    await page.locator("[data-task-clear]").click().catch(() => {});
    await page.locator("[data-nav-tasks]").click();
    await page.locator("[data-tasks-view]").waitFor();
    await until(() => page.locator("[data-task-item]").count(), (n) => n === 1, "task listed");
    await until(() => page.locator("[data-task-history]").getAttribute("data-task-history"), (v) => v === "1", "one run recorded");
  }, 300000);

  it("no page errors, and no call repeated in a loop", () => {
    expect(errors).toEqual([]);
    // Each Settings / Run a task opening asks for Jet's status once or twice, not several times a second.
    expect(helperLog.join("").split("jet:status").length - 1).toBeLessThan(20);
  });
});
