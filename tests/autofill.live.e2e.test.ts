// Live end-to-end: with autofill seeded on (electron/autofillpref.ts), a form submitted in a profile the
// app's real launch() opens is remembered in Default/Web Data, as Chrome does (r54's own defaults save 0 rows).
//
// Opt-in — it needs a Clearcote binary (and, for a PRO one, the licence key in CLEARCOTE_LICENSE_KEY or
// ~/.clearcote/license.key):
//
//   CLEARCOTE_E2E=1 CLEARCOTE_BINARY="/path/to/chrome.exe" npx vitest run tests/autofill.live.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Browser } from "playwright-core";
import type { Profile } from "../electron/types";

const READY = process.env.CLEARCOTE_E2E === "1" && !!process.env.CLEARCOTE_BINARY;
const ROOT = READY ? fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-autofill-e2e-")) : path.join(os.tmpdir(), "ccpm-autofill-e2e-unused");
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

const FORM = `<!doctype html><form method="post" action="/done">
<input name="name" autocomplete="name"><input name="email" type="email" autocomplete="email">
<input name="city" autocomplete="address-level2"><button>Send</button></form>`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

/** Rows in the autofill table, read with Node's built-in SQLite in a child (it needs a flag on Node 22). */
function autofillRows(webData: string): number {
  const out = execFileSync(
    process.execPath,
    ["--experimental-sqlite", "--no-warnings", "-e", `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1],{readOnly:true});console.log(db.prepare("select count(*) n from autofill").get().n)`, webData],
    { encoding: "utf8" },
  );
  return Number(out.trim());
}

describe.skipIf(!READY)("autofill is on in a launched profile", () => {
  const id = "autofill-e2e";
  let browser: Browser | undefined;
  let server: http.Server;
  let launcher: typeof import("../electron/launcher");

  beforeAll(() => {
    if (!process.env.CLEARCOTE_LICENSE_KEY) {
      const f = path.join(os.homedir(), ".clearcote", "license.key");
      if (fs.existsSync(f)) process.env.CLEARCOTE_LICENSE_KEY = fs.readFileSync(f, "utf8").trim();
    }
  });
  afterAll(async () => {
    await browser?.close().catch(() => {});
    await launcher?.stop(id).catch(() => {});
    server?.close();
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it("remembers what was typed into a submitted form", async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(req.url === "/done" ? "<p>ok</p>" : FORM);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const site = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/`;

    const store = await import("../electron/store");
    store.writeSettings({ ...store.readSettings(), binaryPath: process.env.CLEARCOTE_BINARY });
    const profiles = await import("../electron/profiles");
    launcher = await import("../electron/launcher");
    const port = await freePort();
    profiles.saveProfile({
      id,
      name: "autofill e2e",
      fingerprint: "autofill-e2e-seed",
      platform: "windows",
      extraArgs: [`--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check"],
      createdAt: "",
      updatedAt: "",
    } as Profile);
    const res = await launcher.launch(profiles.getProfile(id)!);
    expect(res.ok, res.error).toBe(true);

    const { chromium } = await import("playwright-core");
    const deadline = Date.now() + 60000;
    for (;;) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        break;
      } catch (e) {
        if (Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    const page = await browser.contexts()[0].newPage();
    await page.goto(site);
    await page.fill('[name="name"]', "Ada Lovelace");
    await page.fill('[name="email"]', "ada@example.com");
    await page.fill('[name="city"]', "London");
    await Promise.all([page.waitForURL(/\/done$/), page.click("button")]);
    await page.waitForTimeout(1500);
    await browser.close().catch(() => {});
    browser = undefined;
    await launcher.stop(id); // graceful: Chrome writes Web Data on the way out

    const dir = path.join(store.PROFILES_DIR, id, "userdata", "Default");
    const prefs = JSON.parse(fs.readFileSync(path.join(dir, "Preferences"), "utf8"));
    expect(prefs.autofill).toMatchObject({ profile_enabled: true, credit_card_enabled: true });
    const rows = autofillRows(path.join(dir, "Web Data"));
    console.log(`autofill rows: ${rows}`);
    expect(rows).toBeGreaterThan(0);
  }, 240000);
});
