// Cloud sessions in the REAL desktop app (Electron main + preload + built renderer), against a hosted
// API and worker on 127.0.0.1 (tests/helpers/fakecloud.ts) that follow the service's rules. It covers
// what the browser-mock suite cannot: the key going only to the API, the session body the main
// process builds, the CDP attach that starts the browser, the viewer window and its live view, the
// polls, Stop, the service ending a session, a restart that picks a session back up, and quitting.
//
// Opt-in, against a throwaway --user-data-dir. Build first (the app loads out/):
//
//   npm run build
//   CLEARCOTE_APP_E2E=1 npx vitest run tests/cloud.app.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ElectronApplication, Page } from "playwright-core";
import { startFakeCloud, type FakeCloud, type FakeSession } from "./helpers/fakecloud";

const READY = process.env.CLEARCOTE_APP_E2E === "1";
const APP_DIR = path.resolve(__dirname, "..");
const T = 120000;
const KEY = "cc_live_fake_e2e_key_0123456789";
const VERSION = JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version as string;

describe.skipIf(!READY)("cloud sessions in the desktop app, end to end", () => {
  let UDD = "";
  let cloud: FakeCloud;
  let app: ElectronApplication | null = null;
  let win: Page;

  async function start() {
    const { _electron } = await import("playwright-core");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronPath = require("electron") as unknown as string;
    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_DEV;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CLEARCOTE_API_KEY; // the key comes from Settings here, never from the developer's shell
    delete env.CLEARCOTE_LICENSE_KEY;
    env.CLEARCOTE_API_URL = cloud.base;
    env.CLEARCOTE_CLOUD_POLL_MS = "400";
    app = await _electron.launch({ executablePath: electronPath, args: [APP_DIR, `--user-data-dir=${UDD}`], env });
    win = await app.firstWindow();
    await win.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
  }
  async function until<V>(read: () => Promise<V> | V, ok: (v: V) => boolean, what: string, ms = 20000): Promise<V> {
    const end = Date.now() + ms;
    let last = await read();
    while (!ok(last)) {
      if (Date.now() > end) throw new Error(`${what}: last saw ${JSON.stringify(last)?.slice(0, 400)}`);
      await new Promise((r) => setTimeout(r, 120));
      last = await read();
    }
    return last;
  }
  const card = (id: string) => win.locator(`[data-card="${id}"]`);
  const text = async (p: Page, sel: string) => ((await p.locator(sel).first().textContent()) ?? "").replace(/\s+/g, " ").trim();
  const sessionOf = (profile: string): FakeSession | undefined =>
    [...cloud.sessions.values()].reverse().find((s) => s.body.note === `Profile Manager: ${profile}`);
  const viewer = async (profile: string) =>
    until(
      () => app!.windows().find((w) => /\/out\/cloud\.html\?id=/.test(w.url()) && w.url().endsWith(`id=${profile}`)),
      (w) => !!w,
      `viewer window for ${profile}`,
    ) as Promise<Page>;
  const windowTitles = () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()));
  async function startInCloud(profile: string) {
    await card(profile).getByRole("button", { name: `Run ${profile} in the cloud` }).click();
    // The badge reads "starting" while the browser comes up, "cloud" once it is running.
    await until(() => text(win, `[data-card="${profile}"] [data-cloud-badge]`).catch(() => ""), (t) => t === "cloud", `${profile} running`, 30000);
    return sessionOf(profile)!;
  }

  beforeAll(async () => {
    UDD = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-cloud-e2e-"));
    const PROFILES = path.join(UDD, "profiles");
    fs.mkdirSync(PROFILES, { recursive: true });
    const now = new Date().toISOString();
    const seed = (id: string, over: Record<string, unknown> = {}) =>
      fs.writeFileSync(path.join(PROFILES, `${id}.json`), JSON.stringify({ id, name: id, fingerprint: `seed-${id}`, platform: "windows", createdAt: now, updatedAt: now, ...over }));
    seed("shop", { proxy: "http://user:pw@127.0.0.1:9", timezone: "Europe/Berlin" });
    seed("mail", { cloud: { exit: "managed", country: "de", keepCookies: false } });
    fs.writeFileSync(path.join(UDD, "settings.json"), JSON.stringify({ theme: "dark", autoPruneBuilds: false }));
    cloud = await startFakeCloud({ key: KEY });
    await start();
    // A real JPEG for the live view, drawn by the app's own renderer.
    const b64 = await win.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 1280;
      c.height = 720;
      const g = c.getContext("2d")!;
      g.fillStyle = "#14532d";
      g.fillRect(0, 0, 1280, 720);
      return c.toDataURL("image/jpeg", 0.8).split(",")[1];
    });
    cloud.frame = Buffer.from(b64, "base64");
  }, T);

  afterAll(async () => {
    await app?.close().catch(() => {});
    await cloud?.close();
    if (UDD) fs.rmSync(UDD, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }, T);

  it("without a key, Cloud points to Settings → Cloud, where a saved key is checked against the API", async () => {
    await card("shop").getByRole("button", { name: "Run shop in the cloud" }).click();
    const notice = card("shop").getByRole("status").filter({ hasText: "Add your API key" });
    await notice.waitFor();
    expect(cloud.requests).toEqual([]); // nothing was sent without a key
    await notice.getByRole("button", { name: "Cloud settings" }).click();
    await win.locator("#cloud-key").fill(KEY);
    await win.getByRole("button", { name: "Save", exact: true }).click();
    await win.getByText("✓ Accepted · balance €4.90").waitFor();
    const saved = JSON.parse(fs.readFileSync(path.join(UDD, "settings.json"), "utf8"));
    expect(saved.cloudApiKey).toBe(KEY);
    const check = cloud.requests.at(-1)!;
    expect(check.method + " " + check.path).toBe("GET /api/v1/browsers?limit=1");
    expect(check.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(check.headers["user-agent"]).toBe(`clearcote-profile-manager/${VERSION}`);
    await win.keyboard.press("Escape");
    await win.locator("#cloud-key").waitFor({ state: "detached" });
  }, T);

  it("Cloud starts it: the profile's plan is sent, the browser attached once and let go, and its window opens", async () => {
    const s = await startInCloud("shop");
    expect(s.body).toEqual({
      identity: "seed-shop",
      platform: "windows",
      timezone: "Europe/Berlin",
      lightStealth: false,
      proxy: { server: "http://127.0.0.1:9", username: "user", password: "pw" },
      profile: { name: "pm-shop", persist: true },
      keepAlive: true,
      idleTimeoutSec: 1800,
      note: "Profile Manager: shop",
    });
    // Attached exactly once: asked Browser.getVersion, then closed its connection. keepAlive keeps
    // the browser up after that, so it is running, not ended.
    expect(cloud.cdp).toHaveLength(1);
    expect(cloud.cdp[0].texts).toEqual([JSON.stringify({ id: 1, method: "Browser.getVersion" })]);
    expect(await cloud.cdp[0].clientClosed).toBe(1000);
    expect(s.status).toBe("active");
    expect(await text(win, '[data-card="shop"] [data-cloud-usage]')).toBe("● http://127.0.0.1:9 · 0 B · €0.00");

    const v = await viewer("shop");
    await until(windowTitles, (t) => t.includes("shop — Cloud"), "viewer window title");
    const img = v.getByRole("img", { name: "Cloud browser showing Example Domain" });
    await img.waitFor({ timeout: 30000 });
    await until(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), (w) => w === 1280, "frame decoded");
    // The viewer got a short-lived control view URL from the API, never the key.
    expect(cloud.requests.some((r) => r.method === "GET" && r.path === `/api/v1/browsers/${s.id}/live?control=1`)).toBe(true);
    const live = cloud.views.at(-1)!;
    expect(live.path).toMatch(new RegExp(`^/v/${s.id}\\?t=[0-9a-f]+$`));
    expect(await v.content()).not.toContain(KEY);

    const box = (await img.boundingBox())!;
    await v.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await v.keyboard.type("ok");
    const sent = await until(
      () => live.texts.map((t) => JSON.parse(t) as Record<string, unknown>),
      (l) => l.filter((m) => m.t === "key" && m.e === "down").length >= 2,
      "input reached the worker",
    );
    expect(sent.filter((m) => m.t === "mouse" && m.e !== "move").map((m) => m.e)).toEqual(["down", "up"]);
    expect(sent.filter((m) => m.t === "key" && m.e === "down").map((m) => m.text)).toEqual(["o", "k"]);
  }, T);

  it("the polls bring its traffic and cost to the card and the viewer", async () => {
    const s = sessionOf("shop")!;
    cloud.use(s.id, 1_400_000, 185);
    await until(() => text(win, '[data-card="shop"] [data-cloud-usage]'), (t) => t === "● http://127.0.0.1:9 · 1.4 MB · €0.0014 · 3 min", "card usage");
    const v = await viewer("shop");
    await until(() => text(v, "[data-cloud-viewer-usage]"), (t) => t === "http://127.0.0.1:9 · 1.4 MB · €0.0014 · 3 min", "viewer usage");
  }, T);

  it("a profile in the cloud cannot also run here, start twice, or be deleted", async () => {
    const r = await win.evaluate(async () => {
      const api = (window as unknown as { clearcote: any }).clearcote;
      const p = await api.profiles.get("shop");
      return { launch: await api.launch(p), again: await api.cloud.start(p), remove: await api.profiles.remove("shop") };
    });
    expect(r.launch).toMatchObject({ ok: false, code: "RUNNING_IN_CLOUD" });
    expect(r.again).toMatchObject({ ok: false, code: "ALREADY_RUNNING" });
    expect(r.remove).toMatchObject({ ok: false, error: "Stop this profile's cloud browser before deleting it." });
    expect(fs.existsSync(path.join(UDD, "profiles", "shop.json"))).toBe(true);
    expect([...cloud.sessions.values()].filter((s) => s.status === "active")).toHaveLength(1);
  }, T);

  it("Stop on the card: DELETE, “Stopping…” until the worker closed it, and the viewer says it stopped", async () => {
    const s = sessionOf("shop")!;
    cloud.reportMs = 2500;
    await card("shop").getByRole("button", { name: "Stop", exact: true }).click();
    await card("shop").getByRole("button", { name: "Stopping…" }).waitFor();
    expect(cloud.requests.some((r) => r.method === "DELETE" && r.path === `/api/v1/browsers/${s.id}`)).toBe(true);
    expect(s.stopRequested).toBe(true);
    // Back once the service reports it ended, with no notice for the person's own stop.
    await card("shop").getByRole("button", { name: "Launch" }).waitFor({ timeout: 20000 });
    expect(s.status).toBe("ended");
    expect(await card("shop").getByRole("status").filter({ hasText: "ended" }).count()).toBe(0);
    const v = await viewer("shop");
    const ended = v.getByRole("status").filter({ hasText: "The cloud browser ended" });
    await ended.waitFor();
    expect(await ended.textContent()).toContain("Stopped.");
    expect(await ended.textContent()).toContain("It used 1.4 MB and cost €0.0014.");
    await v.getByRole("button", { name: "Close window" }).click();
    await until(windowTitles, (t) => !t.includes("shop — Cloud"), "viewer closed");
    cloud.reportMs = 800;
  }, T);

  it("the included IP, a country and no saved cookies; and the service ending it on its own", async () => {
    const s = await startInCloud("mail");
    expect(s.body).toMatchObject({ identity: "seed-mail", proxy: "managed", country: "de", keepAlive: true });
    expect(s.body).not.toHaveProperty("profile");
    expect(await text(win, '[data-card="mail"] [data-cloud-usage]')).toBe("● DE · included IP · 0 B · €0.00");
    cloud.use(s.id, 5_000_000, 1800);
    cloud.end(s.id, "idle_timeout");
    const notice = card("mail").getByRole("status").filter({ hasText: "The cloud browser ended" });
    await notice.waitFor();
    expect(await notice.textContent()).toContain("Nobody watched or typed for 30 minutes, so it closed.");
    expect(await notice.textContent()).toContain("It used 5.0 MB and cost €0.0050.");
    const v = await viewer("mail");
    await v.getByText("Nobody watched or typed for 30 minutes, so it closed.").waitFor();
    await v.close();
  }, T);

  it("no free browser is retried; a low balance offers a top-up", async () => {
    cloud.refuseCreate = [{ status: 503, code: "NO_CAPACITY", error: "No hosted browser capacity right now. Retry in a few seconds." }];
    const before = cloud.requests.filter((r) => r.method === "POST").length;
    const s = await startInCloud("mail");
    expect(cloud.requests.filter((r) => r.method === "POST").length - before).toBe(2);
    await (await viewer("mail")).close();
    await card("mail").getByRole("button", { name: "Stop", exact: true }).click();
    await card("mail").getByRole("button", { name: "Launch" }).waitFor({ timeout: 20000 });
    expect(s.status).toBe("ended");

    cloud.refuseCreate = [{ status: 402, code: "INSUFFICIENT_BALANCE", error: "Your hosted-browser balance is EUR 0.12; at least EUR 0.50 is needed to start a browser." }];
    await card("mail").getByRole("button", { name: "Run mail in the cloud" }).click();
    const notice = card("mail").getByRole("alert").filter({ hasText: "Your cloud balance is too low" });
    await notice.waitFor();
    expect(await notice.textContent()).toContain("EUR 0.12");
    expect(await notice.getByRole("button", { name: "Top up ↗" }).count()).toBe(1);
  }, T);

  it("a cloud browser outlives a crash of the app: the restarted app picks it back up", async () => {
    const s = await startInCloud("shop");
    const file = path.join(UDD, "cloud-sessions.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([expect.objectContaining({ profileId: "shop", sid: s.id })]);
    expect(fs.readFileSync(file, "utf8")).not.toContain("pw"); // the proxy password stays out of it

    // A crash takes the whole app down at once: its renderers and helpers with it.
    const proc = app!.process();
    execFileSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    await until(() => proc.exitCode !== null || proc.signalCode !== null, (v) => v, "app gone");
    app = null;
    expect(s.status).toBe("active"); // nothing stopped it

    await start();
    await card("shop").locator("[data-cloud-badge]").waitFor({ timeout: 30000 });
    expect(cloud.requests.some((r) => r.method === "GET" && r.path === `/api/v1/browsers/${s.id}`)).toBe(true);
    // Open window works on the picked-up session.
    await card("shop").getByRole("button", { name: "Open window" }).click();
    const v = await viewer("shop");
    await v.getByRole("img", { name: /Cloud browser/ }).waitFor({ timeout: 30000 });
  }, T);

  it("quitting the app stops its cloud browsers", async () => {
    const s = sessionOf("shop")!;
    expect(s.status).toBe("active");
    await app!.close();
    app = null;
    expect(s.stopRequested).toBe(true);
    expect(cloud.requests.filter((r) => r.method === "DELETE" && r.path === `/api/v1/browsers/${s.id}`)).toHaveLength(1);
  }, T);
});
