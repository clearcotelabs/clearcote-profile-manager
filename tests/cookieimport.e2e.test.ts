// End-to-end: cookies imported into a profile are in the browser when the app's real launch() opens it,
// before the start page loads, and the pending file is gone afterwards.
//
// Opt-in — it needs a Clearcote binary (and, for a PRO one, the licence key in CLEARCOTE_LICENSE_KEY or
// ~/.clearcote/license.key):
//
//   CLEARCOTE_E2E=1 CLEARCOTE_BINARY="/path/to/chrome.exe" npx vitest run tests/cookieimport.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright-core";
import type { Profile } from "../electron/types";

const READY = process.env.CLEARCOTE_E2E === "1" && !!process.env.CLEARCOTE_BINARY;
const ROOT = READY ? fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-cookie-e2e-")) : path.join(os.tmpdir(), "ccpm-cookie-e2e-unused");
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

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

async function waitForCdp(port: number, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("DevTools never came up");
}

describe.skipIf(!READY)("imported cookies reach the browser at launch", () => {
  const id = "cookie-e2e";
  let browser: Browser | undefined;
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
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it("sets host-only and domain cookies before the start page, then clears the pending file", async () => {
    const store = await import("../electron/store");
    store.writeSettings({ ...store.readSettings(), binaryPath: process.env.CLEARCOTE_BINARY });
    const profiles = await import("../electron/profiles");
    const handlers = await import("../electron/handlers");
    const jar = await import("../electron/cookiejar");
    launcher = await import("../electron/launcher");

    const port = await freePort();
    const p = profiles.saveProfile({
      id,
      name: "cookie e2e",
      fingerprint: "cookie-e2e-seed",
      platform: "windows",
      startUrl: "https://example.com/",
      extraArgs: [`--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check"],
      createdAt: "",
      updatedAt: "",
    } as Profile);
    const future = Math.floor(Date.now() / 1000) + 86400;
    const r = handlers.importCookies(
      p.id,
      [
        `.example.com\tTRUE\t/\tTRUE\t${future}\tcc_domain\tone`,
        `example.com\tFALSE\t/\tFALSE\t0\tcc_host\ttwo`,
        `#HttpOnly_.example.com\tTRUE\t/\tTRUE\t${future}\tcc_http\tthree`,
      ].join("\n"),
    );
    expect(r).toMatchObject({ ok: true, count: 3 });

    const res = await launcher.launch(profiles.getProfile(id)!);
    expect(res.ok, res.error).toBe(true);
    expect(res.warnings?.join(" ") ?? "").not.toMatch(/cookie/i);
    expect(jar.readPending(id)).toEqual([]);

    await waitForCdp(port, 60000);
    const { chromium } = await import("playwright-core");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const ctx = browser.contexts()[0];
    const got = await ctx.cookies("https://example.com/");
    const byName = Object.fromEntries(got.map((c) => [c.name, c]));
    expect(byName.cc_domain).toMatchObject({ value: "one", domain: ".example.com", secure: true });
    expect(byName.cc_host).toMatchObject({ value: "two", domain: "example.com" });
    expect(byName.cc_http).toMatchObject({ value: "three", httpOnly: true });

    // The held tab was released to the start page, and the page sees its cookies.
    const deadline = Date.now() + 30000;
    let page = ctx.pages().find((pg) => pg.url().startsWith("https://example.com"));
    while (!page && Date.now() < deadline) {
      await new Promise((r2) => setTimeout(r2, 250));
      page = ctx.pages().find((pg) => pg.url().startsWith("https://example.com"));
    }
    expect(page, `pages: ${ctx.pages().map((pg) => pg.url()).join(", ")}`).toBeTruthy();
    await page!.waitForLoadState("domcontentloaded");
    const doc = await page!.evaluate(() => document.cookie);
    expect(doc).toContain("cc_domain=one");
    expect(doc).toContain("cc_host=two");
    expect(doc).not.toContain("cc_http");
  }, 180000);
});
