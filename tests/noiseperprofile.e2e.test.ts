// "Noise per profile" on a real engine, through the app's own launcher.
//
// The unit tests prove the switch is built and gated. This proves the two things only a browser can:
// on an engine that has the switch (r60 or newer) a 2D canvas reads back the same on two sites with
// the setting on and differently with it off, and on an older engine the switch never reaches the
// command line, the launch says so, and the noise stays per site.
//
// Headless, so no window opens; the page is reached over the launcher's own automation port.
// Opt-in:
//   CLEARCOTE_E2E=1 CLEARCOTE_BINARY=<r60+ chrome.exe> [CLEARCOTE_BINARY_OLD=<older chrome.exe>] \
//   npx vitest run tests/noiseperprofile.e2e.test.ts
// The licence key comes from CLEARCOTE_LICENSE_KEY or ~/.clearcote/license.key, as in the app.
// CLEARCOTE_NPP_SEED picks the seed (default 4242); E2E_OUTCOMES=<file> writes the measured rows there.

import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright-core";
import type { Profile } from "../electron/types";
import { NOISE_PER_PROFILE_SWITCH, NOISE_PER_PROFILE_WARNING } from "../electron/fpargs";

function hasKey(): boolean {
  if (process.env.CLEARCOTE_LICENSE_KEY?.trim()) return true;
  try {
    return fs.readFileSync(path.join(os.homedir(), ".clearcote", "license.key"), "utf8").trim() !== "";
  } catch {
    return false;
  }
}
const NEW = process.env.CLEARCOTE_BINARY ?? "";
const OLD = process.env.CLEARCOTE_BINARY_OLD ?? "";
const READY = process.env.CLEARCOTE_E2E === "1" && !!NEW && fs.existsSync(NEW) && hasKey();
const SEED = process.env.CLEARCOTE_NPP_SEED || "4242";

// Created only when the suite runs: this file is imported (and skipped) on every `npm test`.
const ROOT = READY ? fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-npp-")) : path.join(os.tmpdir(), "ccpm-npp-unused");
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

// A fixed drawing with text, a solid block and a gradient: the function the SDK's release check
// uses, so the numbers can be compared with an SDK launch of the same seed.
const HASH = `(() => { const cv = document.createElement("canvas"); cv.width = 220; cv.height = 50; const x = cv.getContext("2d"); x.font = "18px Arial";
  x.fillStyle = "#f60"; x.fillRect(5, 5, 90, 20); x.fillStyle = "#069"; x.fillText("Cwm fjord 123", 4, 22);
  const g = x.createLinearGradient(0, 0, 220, 0); g.addColorStop(0, "#f0f"); g.addColorStop(1, "#0ff"); x.fillStyle = g; x.fillRect(100, 10, 110, 30);
  const u = cv.toDataURL(); let h = 0; for (let i = 0; i < u.length; i++) h = (h * 31 + u.charCodeAt(i)) | 0; return h; })()`;

interface Row {
  engine: string;
  noisePerProfile: boolean;
  /** Whether the browser's own command line carries the switch (read from chrome://version). */
  switchSent: boolean;
  warned: boolean;
  /** The canvas hash on example.com and on example.org. */
  com: number;
  org: number;
}
const rows: Row[] = [];

/** Launch through the app's own launcher, headless; hash the canvas on two sites; shut down. */
async function measure(bin: string, engine: string, noisePerProfile: boolean): Promise<Row> {
  process.env.CLEARCOTE_BINARY = bin; // the launcher's explicit-binary path
  const { launch, stop } = await import("../electron/launcher");
  const { chromium } = await import("playwright-core");
  const id = `npp-${engine}-${noisePerProfile ? "on" : "off"}`;
  const userDataDir = path.join(ROOT, id);
  const profile = {
    id,
    name: id,
    fingerprint: SEED,
    userDataDir,
    ...(noisePerProfile ? { noisePerProfile: true } : {}),
    extraArgs: ["--headless=new"],
    createdAt: "",
    updatedAt: "",
  } as Profile;

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
    const com = Number(await page.evaluate(HASH));
    await page.goto("https://example.org/", { waitUntil: "load", timeout: 60000 });
    const org = Number(await page.evaluate(HASH));
    const row: Row = {
      engine,
      noisePerProfile,
      switchSent: commandLine.split(/\s+/).includes(`--${NOISE_PER_PROFILE_SWITCH}`),
      warned: (r.warnings ?? []).includes(NOISE_PER_PROFILE_WARNING),
      com,
      org,
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

describe.skipIf(!READY)("noise per profile on a real engine", () => {
  afterAll(() => {
    if (process.env.E2E_OUTCOMES) fs.writeFileSync(process.env.E2E_OUTCOMES, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });

  it("off (the default): the switch is not sent and two sites read different canvases", async () => {
    const r = await measure(NEW, "new", false);
    expect(r.switchSent).toBe(false);
    expect(r.warned).toBe(false);
    expect(r.com).not.toBe(r.org);
  }, 180000);

  it("on: the switch is sent and two sites read the same canvas", async () => {
    const r = await measure(NEW, "new", true);
    expect(r.switchSent).toBe(true);
    expect(r.warned).toBe(false);
    expect(r.com).toBe(r.org);
  }, 180000);

  it.skipIf(!OLD || !fs.existsSync(OLD))("on, an engine before r60: the switch is not sent, the launch says so, the noise stays per site", async () => {
    const r = await measure(OLD, "old", true);
    expect(r.switchSent).toBe(false);
    expect(r.warned).toBe(true);
    expect(r.com).not.toBe(r.org);
  }, 180000);
});
