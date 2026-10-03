// The built desktop app against the REAL hosted service (www.clearcotelabs.com): a profile started in
// the cloud, its live view with real frames, a page driven from the viewer, usage from the polls, and
// a stop the service confirms. It costs a few hundredths of a cent of the key's balance.
//
// Opt-in, and only with a key in the environment (never written anywhere by this test):
//
//   npm run build
//   CLEARCOTE_APP_E2E=1 CLEARCOTE_LIVE_API_KEY=cc_live_... npx vitest run tests/cloud.live.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ElectronApplication, Page } from "playwright-core";
import { CloudApi, DEFAULT_CLOUD_BASE } from "../electron/cloudapi";

const KEY = process.env.CLEARCOTE_LIVE_API_KEY || "";
const READY = process.env.CLEARCOTE_APP_E2E === "1" && KEY.startsWith("cc_live_");
const APP_DIR = path.resolve(__dirname, "..");
const T = 240000;

describe.skipIf(!READY)("cloud sessions against the real service", () => {
  let UDD = "";
  let app: ElectronApplication | null = null;
  let win: Page;
  let sid = "";
  const api = new CloudApi({ apiKey: KEY, base: process.env.CLEARCOTE_API_URL || DEFAULT_CLOUD_BASE });

  async function until<V>(read: () => Promise<V> | V, ok: (v: V) => boolean, what: string, ms = 60000): Promise<V> {
    const end = Date.now() + ms;
    let last = await read();
    while (!ok(last)) {
      if (Date.now() > end) throw new Error(`${what}: last saw ${JSON.stringify(last)?.slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, 300));
      last = await read();
    }
    return last;
  }
  const text = async (p: Page, sel: string) => ((await p.locator(sel).first().textContent()) ?? "").replace(/\s+/g, " ").trim();

  beforeAll(async () => {
    UDD = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-cloud-live-"));
    fs.mkdirSync(path.join(UDD, "profiles"), { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(UDD, "profiles", "live.json"),
      JSON.stringify({ id: "live", name: "Live check", fingerprint: `pm-live-check-${Date.now()}`, platform: "windows", startUrl: "https://example.com/", cloud: { exit: "managed", keepCookies: false }, createdAt: now, updatedAt: now }),
    );
    // The key goes in through Settings, as a person would put it there.
    fs.writeFileSync(path.join(UDD, "settings.json"), JSON.stringify({ theme: "dark", autoPruneBuilds: false, cloudApiKey: KEY }));
    const { _electron } = await import("playwright-core");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronPath = require("electron") as unknown as string;
    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_DEV;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CLEARCOTE_API_KEY;
    delete env.CLEARCOTE_LIVE_API_KEY;
    env.CLEARCOTE_CLOUD_POLL_MS = "3000";
    app = await _electron.launch({ executablePath: electronPath, args: [APP_DIR, `--user-data-dir=${UDD}`], env });
    win = await app.firstWindow();
    await win.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
  }, T);

  afterAll(async () => {
    // Whatever happened above, nothing is left running on the key's balance.
    if (sid) await api.stop(sid).catch(() => undefined);
    await app?.close().catch(() => {});
    if (UDD) fs.rmSync(UDD, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }, T);

  it("starts in the cloud, shows the real page live, takes input, and stops", async () => {
    const card = win.locator('[data-card="live"]');
    await card.getByRole("button", { name: "Run Live check in the cloud" }).click();
    // The badge reads "starting" while the browser comes up, "cloud" once it is running.
    await until(() => text(win, '[data-card="live"] [data-cloud-badge]').catch(() => ""), (t) => t === "cloud", "running in the cloud", 120000);
    const sessions = await win.evaluate(() => (window as unknown as { clearcote: any }).clearcote.cloud.list());
    sid = sessions[0].sid;
    expect(sid).toMatch(/^bs_/);

    // The service says it is running, as this app's session.
    const viewed = await api.get(sid);
    expect(viewed.ok && viewed.data.status).toBe("active");
    const raw = (viewed.ok ? viewed.data : {}) as { note?: string; proxy?: string };
    expect(raw.note).toBe("Profile Manager: Live check");
    expect(raw.proxy).toBe("managed");

    // The viewer window: real frames from the worker, the page it opened.
    const viewer = (await until(() => app!.windows().find((w) => w.url().includes("cloud.html")), (w) => !!w, "viewer window")) as Page;
    const img = viewer.getByRole("img", { name: "Cloud browser showing Example Domain" });
    await img.waitFor({ timeout: 90000 });
    await until(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), (w) => w > 300, "a real frame decoded");
    expect(await viewer.getByRole("textbox", { name: "Address" }).inputValue()).toBe("https://example.com/");

    // Drive it: open another page from the address bar; the page meta follows.
    const address = viewer.getByRole("textbox", { name: "Address" });
    await until(() => address.isEnabled(), (v) => v, "control granted");
    await address.fill("https://example.org/");
    await address.press("Enter");
    await until(() => address.inputValue(), (v) => v.startsWith("https://example.org"), "navigated", 60000);

    // Usage arrives from the polls on the card.
    await until(() => text(win, '[data-card="live"] [data-cloud-usage]'), (t) => !/ 0 B /.test(t), "usage on the card", 90000);

    // Stop from the card; the service ends it as the person's stop.
    await card.getByRole("button", { name: "Stop", exact: true }).click();
    await card.getByRole("button", { name: "Launch" }).waitFor({ timeout: 90000 });
    const final = await until(() => api.get(sid), (r) => r.ok && r.data.status === "ended", "ended at the service");
    expect(final.ok && final.data.endReason).toBe("stopped:user");
    const used = final.ok ? final.data : null;
    console.log(`live check: ${sid} used ${(used!.usage!.bytesUp + used!.usage!.bytesDown) / 1e6} MB in ${used!.usage!.seconds} s, cost EUR ${used!.costEur}`);
    await viewer.getByText("Stopped.").waitFor({ timeout: 30000 });
    sid = "";
  }, T);
});
