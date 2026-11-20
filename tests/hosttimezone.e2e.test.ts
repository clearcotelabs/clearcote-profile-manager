// The timezone a page reads, on a real engine, through the app's own launcher.
//
// The unit tests prove which --timezone switch is built. This proves what a page sees: a profile
// without a proxy and without a timezone reads this computer's timezone (it used to read
// America/New_York from its en-US language wherever it ran, CR-LYJSFW 2026-11-19), a typed timezone
// still wins, and behind a proxy an unset timezone is still the one that fits the language.
//
// Headless, so no window opens; the page is reached over the launcher's own automation port. The
// proxy is a CONNECT proxy this file starts on 127.0.0.1.
// Opt-in:
//   CLEARCOTE_E2E=1 CLEARCOTE_BINARY=<chrome.exe> npx vitest run tests/hosttimezone.e2e.test.ts
// The licence key comes from CLEARCOTE_LICENSE_KEY or ~/.clearcote/license.key, as in the app.
// E2E_OUTCOMES=<file> writes the measured rows there.

import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright-core";
import type { Profile } from "../electron/types";

function hasKey(): boolean {
  if (process.env.CLEARCOTE_LICENSE_KEY?.trim()) return true;
  try {
    return fs.readFileSync(path.join(os.homedir(), ".clearcote", "license.key"), "utf8").trim() !== "";
  } catch {
    return false;
  }
}
const BIN = process.env.CLEARCOTE_BINARY ?? "";
const READY = process.env.CLEARCOTE_E2E === "1" && !!BIN && fs.existsSync(BIN) && hasKey();
const HOST_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Created only when the suite runs: this file is imported (and skipped) on every `npm test`.
const ROOT = READY ? fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-tz-")) : path.join(os.tmpdir(), "ccpm-tz-unused");
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

interface Row {
  case: string;
  /** The --timezone on the browser's own command line (chrome://version). */
  sent: string;
  /** Intl.DateTimeFormat().resolvedOptions().timeZone on example.com. */
  page: string;
  language: string;
}
const rows: Row[] = [];

let proxy: http.Server | undefined;
let proxyPort = 0;

async function measure(name: string, extra: Partial<Profile>): Promise<Row> {
  process.env.CLEARCOTE_BINARY = BIN; // the launcher's explicit-binary path
  const { launch, stop } = await import("../electron/launcher");
  const { chromium } = await import("playwright-core");
  const id = `tz-${name}`;
  const userDataDir = path.join(ROOT, id);
  const profile = { id, name: id, fingerprint: "4242", userDataDir, extraArgs: ["--headless=new"], createdAt: "", updatedAt: "", ...extra } as Profile;
  const r = await launch(profile, undefined, { automation: true });
  let browser: Browser | undefined;
  try {
    expect(r.ok, `${id}: ${r.error}`).toBe(true);
    expect(r.cdp, `${id}: no automation port (${(r.warnings ?? []).join(" | ")})`).toBeTruthy();
    browser = await chromium.connectOverCDP(r.cdp!);
    const page = await browser.contexts()[0].newPage();
    await page.goto("chrome://version/", { waitUntil: "load", timeout: 60000 });
    const commandLine = String(await page.evaluate(`document.getElementById("command_line").textContent`));
    await page.goto("https://example.com/", { waitUntil: "load", timeout: 60000 });
    const row: Row = {
      case: name,
      sent: commandLine.split(/\s+/).filter((s) => s.startsWith("--timezone=")).join(" "),
      page: String(await page.evaluate(`Intl.DateTimeFormat().resolvedOptions().timeZone`)),
      language: String(await page.evaluate(`navigator.language`)),
    };
    rows.push(row);
    return row;
  } finally {
    try { await browser?.close(); } catch { /* already gone */ }
    try { await stop(id); } catch { /* already gone */ }
    await new Promise((res) => setTimeout(res, 800));
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

describe.skipIf(!READY)("the timezone a page reads on a real engine", () => {
  beforeAll(async () => {
    proxy = http.createServer((_q, s) => { s.writeHead(405); s.end(); });
    proxy.on("connect", (req, client, head) => {
      const [host, port] = String(req.url).split(":");
      const up = net.connect(Number(port) || 443, host, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) up.write(head);
        up.pipe(client); client.pipe(up);
      });
      up.on("error", () => client.destroy());
      client.on("error", () => up.destroy());
    });
    await new Promise<void>((res) => proxy!.listen(0, "127.0.0.1", res));
    proxyPort = (proxy.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    if (process.env.E2E_OUTCOMES) fs.writeFileSync(process.env.E2E_OUTCOMES, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await new Promise((res) => (proxy ? proxy.close(() => res(null)) : res(null)));
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });

  it("no proxy, no timezone: the page reads this computer's timezone", async () => {
    const r = await measure("noproxy", {});
    expect(r.sent).toBe(`--timezone=${HOST_TZ}`);
    expect(r.page).toBe(HOST_TZ);
    expect(r.language).toBe("en-US");
  }, 180000);

  it("no proxy, a typed timezone: the typed one wins", async () => {
    const r = await measure("typed", { timezone: "Asia/Tokyo" });
    expect(r.sent).toBe("--timezone=Asia/Tokyo");
    expect(r.page).toBe("Asia/Tokyo");
  }, 180000);

  it("behind a proxy, no timezone, GeoIP off: still the one that fits the language", async () => {
    const r = await measure("proxy", { proxy: `http://127.0.0.1:${proxyPort}`, geoip: false });
    expect(r.sent).toBe("--timezone=America/New_York");
    expect(r.page).toBe("America/New_York");
  }, 180000);
});
