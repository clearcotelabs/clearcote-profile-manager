// Live: the app's real launch() with Chrome's revocation list on, against hosts whose eMudhra intermediates
// Chrome revoked on 2026-10-17. Without the list every Clearcote engine loads them; with it the START PAGE
// itself must already be refused (the first tab is held until the list is live), and so must later tabs.
//
// Opt-in, headless (it never opens a window):
//
//   CLEARCOTE_E2E=1 CLEARCOTE_BINARY="/path/to/chrome.exe" npx vitest run tests/crlset.live.test.ts
//
// A PRO binary takes a lease with the licence key this PC has, as the app does. Inspection goes over a
// separate --remote-debugging-port that only this test adds.

import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Profile } from "../electron/types";

const READY = process.env.CLEARCOTE_E2E === "1" && !!process.env.CLEARCOTE_BINARY;
const ROOT = READY ? fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-crlset-live-")) : path.join(os.tmpdir(), "ccpm-crlset-live-unused");
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

const REVOKED = ["dv-g3b", "ov-g3c", "ev-g3b"].map((h) => `https://${h}-emudhra.we-have-a-problem.com/`);

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

async function connect(port: number) {
  const { chromium } = await import("playwright-core");
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/** What a tab ended up showing: the error code of Chrome's error page, or "loaded". */
async function outcome(page: import("playwright-core").Page): Promise<string> {
  await page.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
  if (!page.url().startsWith("chrome-error://")) return "loaded";
  const text = await page.evaluate(() => document.body?.innerText ?? "");
  return /NET::ERR_CERT_REVOKED|ERR_CERT_REVOKED/.test(text) ? "ERR_CERT_REVOKED" : `error: ${text.slice(0, 80)}`;
}

describe.skipIf(!READY)("live — the start page is refused when its certificate is revoked", () => {
  let launcher: typeof import("../electron/launcher");
  let store: typeof import("../electron/store");
  let profiles: typeof import("../electron/profiles");

  afterAll(async () => {
    await launcher?.stopAll({ timeoutMs: 8000 });
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function run(id: string, crlset: boolean) {
    launcher ??= await import("../electron/launcher");
    store ??= await import("../electron/store");
    profiles ??= await import("../electron/profiles");
    store.writeSettings({ ...store.readSettings(), binaryPath: process.env.CLEARCOTE_BINARY, crlset });
    const port = await freePort();
    const p = profiles.saveProfile({
      id,
      name: id,
      fingerprint: `seed-${id}`,
      createdAt: "",
      updatedAt: "",
      startUrl: REVOKED[0],
      extraArgs: ["--headless=new", `--remote-debugging-port=${port}`],
    } as Profile);
    const t0 = Date.now();
    const r = await launcher.launch(p);
    const launchMs = Date.now() - t0;
    expect(r.ok, r.error).toBe(true);
    const browser = await connect(port);
    const ctx = browser.contexts()[0];
    const pages = ctx.pages().filter((pg) => !pg.url().startsWith("devtools://"));
    const start = pages.find((pg) => pg.url() !== "about:blank") ?? pages[0];
    const first = await outcome(start);
    const later: string[] = [];
    for (const url of [...REVOKED.slice(1), "https://example.com/"]) {
      const pg = await ctx.newPage();
      // A refused navigation throws and can leave the tab on about:blank, so the error is what counts.
      const go = () => pg.goto(url, { timeout: 20_000 }).then(() => "", (e: Error) => e.message);
      let err = await go();
      if (/Timeout/.test(err)) err = await go(); // the test hosts are slow at times (ov-g3c); once more
      if (/ERR_CERT_REVOKED/.test(err)) later.push("ERR_CERT_REVOKED");
      else if (err) later.push(`error: ${err.split("\n")[0].slice(0, 80)}`);
      else later.push(await outcome(pg));
      await pg.close();
    }
    await browser.close().catch(() => {}); // disconnects; the app's own stop closes the browser
    await launcher.stop(id, { timeoutMs: 8000 });
    fs.appendFileSync(path.join(os.tmpdir(), "ccpm-crlset-live.jsonl"), JSON.stringify({ id, crlset, launchMs, warnings: r.warnings, tabs: pages.length, first, later }) + "\n");
    return { first, later, launchMs, warnings: r.warnings ?? [], tabs: pages.length };
  }

  it("on: the start page and later tabs are ERR_CERT_REVOKED, example.com loads", async () => {
    const r = await run("crl-on", true);
    expect(r.warnings.join(" ")).not.toMatch(/revocation/);
    expect(r.first).toBe("ERR_CERT_REVOKED");
    expect(r.later).toEqual(["ERR_CERT_REVOKED", "ERR_CERT_REVOKED", "loaded"]);
    expect(r.tabs).toBe(1); // the held tab became the start page; no extra tab
  }, 120_000);

  it("on, no start page: the held tab becomes the new-tab page", async () => {
    launcher ??= await import("../electron/launcher");
    store ??= await import("../electron/store");
    profiles ??= await import("../electron/profiles");
    store.writeSettings({ ...store.readSettings(), binaryPath: process.env.CLEARCOTE_BINARY, crlset: true });
    const port = await freePort();
    const p = profiles.saveProfile({
      id: "crl-ntp",
      name: "crl-ntp",
      fingerprint: "seed-ntp",
      createdAt: "",
      updatedAt: "",
      extraArgs: ["--headless=new", `--remote-debugging-port=${port}`],
    } as Profile);
    expect((await launcher.launch(p)).ok).toBe(true);
    const browser = await connect(port);
    const urls = browser.contexts()[0].pages().map((pg) => pg.url());
    await browser.close().catch(() => {});
    await launcher.stop("crl-ntp", { timeoutMs: 8000 });
    fs.appendFileSync(path.join(os.tmpdir(), "ccpm-crlset-live.jsonl"), JSON.stringify({ id: "crl-ntp", urls }) + "\n");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^chrome:\/\/(newtab|new-tab-page)/);
  }, 120_000);

    it("off (control): the same engine loads them", async () => {
    const r = await run("crl-off", false);
    expect(r.first).toBe("loaded");
    expect(r.later).not.toContain("ERR_CERT_REVOKED"); // a slow test host may time out; it is never refused
  }, 120_000);
});
