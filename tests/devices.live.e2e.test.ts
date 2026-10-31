// Does a device from the Device profiles page actually become the browser's device? The page's best match for THIS
// computer (its real GPU from electron/hostgpu.ts, its real thread count), downloaded from the live clearcote-profiles
// library, launched through the app's own launcher on the licensed engine, then read back from the page: threads,
// memory, screen and the WebGL renderer must be the device's, not this machine's.
//
// Opt-in (the licence key is read from CLEARCOTE_LICENSE_KEY or ~/.clearcote/license.key, never printed):
//   CLEARCOTE_DEVICES_E2E=1 CLEARCOTE_BINARY=<r54 chrome.exe> npx vitest run tests/devices.live.e2e.test.ts

import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright-core";
import type { Profile } from "../electron/types";
import { rankDevices, type HostOsName } from "../src/lib/deviceMatch";
import type { LibraryProfile } from "../src/lib/ipc";

const READY = process.env.CLEARCOTE_DEVICES_E2E === "1" && !!process.env.CLEARCOTE_BINARY;
const RAW = "https://raw.githubusercontent.com/clearcotelabs/clearcote-profiles/main/samples";
const ROOT = READY ? fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-devices-")) : "";
// The launcher keeps its data under app.getPath("userData"): here, this run's own folder.
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

function licenceKey(): string {
  if (process.env.CLEARCOTE_LICENSE_KEY) return process.env.CLEARCOTE_LICENSE_KEY;
  return fs.readFileSync(path.join(os.homedir(), ".clearcote", "license.key"), "utf8").trim();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitForCdp(port: number, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`CDP on ${port} did not come up`);
}

describe.skipIf(!READY)("Device profiles — the best match becomes the browser's device (live)", () => {
  afterAll(() => {
    if (ROOT) fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it("launches on the top match and reports its threads, memory, screen and GPU", async () => {
    if (!process.env.CLEARCOTE_LICENSE_KEY) process.env.CLEARCOTE_LICENSE_KEY = licenceKey();
    const { hostGpuCached } = await import("../electron/hostgpu");
    const gpu = await hostGpuCached();
    const hostOs: HostOsName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";

    // The library as the desktop app reads it (electron/handlers.ts "fp:library").
    const idx = (await (await fetch(`${RAW}/index.json`)).json()) as { profiles: Array<Record<string, unknown>> };
    const library: LibraryProfile[] = idx.profiles.map((e) => ({
      name: `${e.id}.json`,
      downloadUrl: `${RAW}/${e.id}.json`,
      gpuVendor: e.gpu_vendor as string,
      gpuFamily: e.gpu_family as string,
      renderer: e.renderer as string,
      screen: e.screen as string,
      cores: e.hardware_concurrency as number,
      memory: e.device_memory as number,
    }));
    const ranked = rankDevices(library, { vendor: gpu.vendor, gpuName: gpu.name, threads: os.cpus().length, os: hostOs }, []);
    const best = ranked[0];
    expect(best.fits, `best match should fit this computer (${gpu.name})`).toBe(true);

    const file = path.join(ROOT, best.lib.name);
    const json = await (await fetch(best.lib.downloadUrl)).text();
    fs.writeFileSync(file, json, "utf8");
    const want = JSON.parse(json) as { hardware_concurrency: number; device_memory: number; screen: { width: number; height: number } };

    const { launch, stop } = await import("../electron/launcher");
    const { chromium } = await import("playwright-core");
    const port = await freePort();
    const id = "devices-live";
    const profile = {
      id,
      name: id,
      fingerprint: "devices-live-seed",
      platform: "windows",
      userDataDir: path.join(ROOT, id),
      fingerprintProfile: file,
      extraArgs: [`--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", "about:blank"],
      createdAt: "",
      updatedAt: "",
    } as Profile;
    const r = await launch(profile);
    expect(r.ok, String(r.error)).toBe(true);
    let browser: Browser | undefined;
    try {
      await waitForCdp(port, 60000);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const page = await browser.contexts()[0].newPage();
      // A secure page: navigator.deviceMemory exists only on https.
      await page.goto("https://docs.python.org/3/", { waitUntil: "domcontentloaded", timeout: 60000 });
      const got = await page.evaluate(() => {
        const gl = document.createElement("canvas").getContext("webgl");
        const ext = gl?.getExtension("WEBGL_debug_renderer_info");
        return {
          threads: navigator.hardwareConcurrency,
          memory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
          screen: [screen.width, screen.height],
          renderer: gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null,
        };
      });
      expect(got.threads).toBe(want.hardware_concurrency);
      expect(got.memory).toBe(want.device_memory);
      expect(got.screen).toEqual([want.screen.width, want.screen.height]);
      expect(got.renderer).toBe(best.lib.renderer);
      console.log(`[devices.live] ${gpu.name} -> ${best.lib.name} (score ${best.score}): ${JSON.stringify(got)}`);
    } finally {
      try { await browser?.close(); } catch { /* already gone */ }
      try { stop(id); } catch { /* already gone */ }
      await new Promise((res) => setTimeout(res, 1000));
    }
  }, 180000);
});
