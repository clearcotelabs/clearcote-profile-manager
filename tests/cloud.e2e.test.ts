// End-to-end for cloud sessions in the UI, in a real browser against `next dev` and the renderer's
// mock (src/lib/ipc.ts), whose opt-in hooks play the desktop's side: a start that succeeds or fails
// with the hosted API's real codes, usage arriving, the service ending a session, a stop that takes a
// moment. The viewer page (/cloud?id=) connects to a local WebSocket server that plays the worker's
// live view (tests/helpers/fakews.ts): JPEG frames out, the input events it accepts in.
//
//   npm run next:dev -- -p 3100
//   CLEARCOTE_UI_E2E=1 CLEARCOTE_UI_BROWSER=<chrome.exe> npx vitest run tests/cloud.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { startFakeWs, type FakeConn, type FakeWsServer } from "./helpers/fakews";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";
const T = 45000;
const KEY = "cc_live_e2e_not_a_real_key";
const prof = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  fingerprint: `seed-${id}`,
  createdAt: new Date(Date.now() - 86400_000).toISOString(),
  updatedAt: new Date(Date.now() - 3600_000).toISOString(),
  ...over,
});
const session = (id: string, over: Record<string, unknown> = {}) => ({
  profileId: id,
  name: id[0].toUpperCase() + id.slice(1),
  sid: `bs_e2e${id.padEnd(16, "0")}`,
  startedAt: new Date().toISOString(),
  status: "running",
  exit: "US · included IP",
  bytes: 0,
  seconds: 0,
  costEur: 0,
  ...over,
});

interface Seed {
  profiles?: Record<string, unknown>[];
  settings?: Record<string, unknown>;
  cloud?: "ok" | { error: string; code?: string; status?: number };
  sessions?: Record<string, unknown>[];
  view?: string;
  account?: Record<string, unknown>;
  stopMs?: number;
}

describe.skipIf(!READY)("cloud sessions — in a real browser", () => {
  let browser: Browser;
  let jpeg: Buffer;
  const open: BrowserContext[] = [];
  const servers: FakeWsServer[] = [];

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true, executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined, args: ["--no-sandbox"] });
    // A real 1280x720 JPEG, as the worker's screencast sends, drawn by the browser itself.
    const p = await browser.newPage();
    const b64 = await p.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 1280;
      c.height = 720;
      const g = c.getContext("2d")!;
      g.fillStyle = "#1e3a8a";
      g.fillRect(0, 0, 1280, 720);
      g.fillStyle = "#fff";
      g.font = "64px sans-serif";
      g.fillText("cloud frame", 400, 380);
      return c.toDataURL("image/jpeg", 0.8).split(",")[1];
    });
    jpeg = Buffer.from(b64, "base64");
    await p.close();
  }, 120000);
  afterAll(async () => {
    for (const c of open) await c.close().catch(() => {});
    while (servers.length) await servers.pop()!.close();
    await browser?.close();
  }, 30000);

  async function fresh(seed: Seed = {}, path = "/") {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    open.push(ctx);
    await ctx.addInitScript((s: Seed) => {
      if (sessionStorage.getItem("__seeded")) return;
      sessionStorage.setItem("__seeded", "1");
      // The viewer window shares the main window's storage: seed once per context.
      if (localStorage.getItem("__ctx_seeded")) return;
      localStorage.clear();
      localStorage.setItem("__ctx_seeded", "1");
      const put = (k: string, v: unknown) => v !== undefined && localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
      put("clearcote.profiles.mock", s.profiles);
      put("clearcote.settings.mock", s.settings);
      put("clearcote.mock.cloud", s.cloud);
      put("clearcote.mock.cloud.sessions", s.sessions);
      put("clearcote.mock.cloud.view", s.view);
      put("clearcote.mock.cloud.account", s.account);
      put("clearcote.mock.cloud.stopMs", s.stopMs === undefined ? undefined : String(s.stopMs));
    }, seed);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN + path, { waitUntil: "domcontentloaded" });
    if (path === "/") await page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
    return { page, errors, ctx };
  }
  async function until<V>(read: () => Promise<V>, ok: (v: V) => boolean, what: string, ms = 8000): Promise<V> {
    const end = Date.now() + ms;
    let last = await read();
    while (!ok(last)) {
      if (Date.now() > end) throw new Error(`${what}: last saw ${JSON.stringify(last)}`);
      await new Promise((r) => setTimeout(r, 60));
      last = await read();
    }
    return last;
  }
  const card = (page: Page, id: string) => page.locator(`[data-card="${id}"]`);
  const text = async (page: Page, sel: string) => ((await page.locator(sel).first().textContent()) ?? "").replace(/\s+/g, " ").trim();
  const stored = (page: Page, key: string) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), key);
  const withKey = { settings: { cloudApiKey: KEY } };

  // ── Starting from the card ─────────────────────────────────────────────────
  it("without an API key: the Cloud button explains, and its action opens Settings → Cloud", async () => {
    const { page, errors } = await fresh({ profiles: [prof("shop")], cloud: "ok" });
    await card(page, "shop").getByRole("button", { name: "Run Shop in the cloud" }).click();
    const notice = card(page, "shop").getByRole("status").filter({ hasText: "Add your API key" });
    await notice.waitFor();
    expect(await notice.textContent()).toMatch(/cc_live_.*not the licence key/);
    await notice.getByRole("button", { name: "Cloud settings" }).click();
    await page.locator("#cloud-key").waitFor();
    expect(await page.locator("#cloud-key").getAttribute("type")).toBe("password");
    expect(errors).toEqual([]);
  }, T);

  it("Settings → Cloud: saves the key, checks it, and warns about a licence key pasted by mistake", async () => {
    const { page, errors } = await fresh({ profiles: [prof("shop")], account: { ok: true, balanceEur: 4.9 } });
    await page.getByRole("button", { name: /settings/i }).first().click();
    await page.getByRole("button", { name: "Cloud", exact: true }).click();
    const input = page.locator("#cloud-key");
    await input.fill("cc_lic_ABC");
    await page.getByText("A licence key (cc_lic_…) belongs under Licence.").waitFor();
    await input.fill(KEY);
    await page.getByText("Not saved yet — press Save or Enter.").waitFor();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("✓ Accepted · balance €4.90").waitFor();
    expect((await stored(page, "clearcote.settings.mock")).cloudApiKey).toBe(KEY);
    await page.getByRole("button", { name: "Show API key" }).click();
    expect(await input.getAttribute("type")).toBe("text");
    expect(errors).toEqual([]);
  }, T);

  it("with a key: Cloud starts it; the card shows where it runs, its usage, and Stop", async () => {
    const { page, errors } = await fresh({ profiles: [prof("shop", { cloud: { country: "us" } }), prof("mail")], cloud: "ok", ...withKey });
    const shop = card(page, "shop");
    await shop.getByRole("button", { name: "Run Shop in the cloud" }).click();
    await shop.locator("[data-cloud-badge]").waitFor();
    expect(await text(page, '[data-card="shop"] [data-cloud-badge]')).toBe("cloud");
    expect(await text(page, '[data-card="shop"] [data-cloud-usage]')).toBe("● US · included IP · 0 B · €0.00");
    // A profile in the cloud has no local Launch and no Edit button, and counts as running.
    expect(await shop.getByRole("button", { name: "Launch" }).count()).toBe(0);
    expect(await shop.getByRole("button", { name: "Open window" }).isEnabled()).toBe(true);
    await page.getByRole("button", { name: /^Running · 1/ }).waitFor();
    expect(await shop.getAttribute("aria-label")).toMatch(/\(running in the cloud\)/);

    // Usage arrives from the service's polls.
    await page.evaluate(() => (window as any).__clearcoteMock.cloudUsage("shop", { bytes: 1_400_000, seconds: 185, costEur: 0.0014 }));
    await until(() => text(page, '[data-card="shop"] [data-cloud-usage]'), (t) => t === "● US · included IP · 1.4 MB · €0.0014 · 3 min", "usage");

    // Open window asks the desktop to show the viewer.
    await shop.getByRole("button", { name: "Open window" }).click();
    await until(() => page.evaluate(() => localStorage.getItem("clearcote.mock.cloud.opened")), (v) => v === "shop", "viewer opened");

    // Delete waits until the cloud browser stops: the menu item is off.
    await shop.getByRole("button", { name: "More actions for Shop" }).click();
    expect(await page.getByRole("menuitem", { name: /Delete/ }).isDisabled()).toBe(true);
    expect(await page.getByRole("menuitem", { name: "Stop in the cloud" }).count()).toBe(1);
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  }, T);

  it("Stop: “Stopping…” until the service closed it, then back to Launch and Cloud, with no notice", async () => {
    const { page } = await fresh({ profiles: [prof("shop")], cloud: "ok", ...withKey, sessions: [session("shop")], stopMs: 1200 });
    const shop = card(page, "shop");
    await shop.getByRole("button", { name: "Stop", exact: true }).click();
    await shop.getByRole("button", { name: "Stopping…" }).waitFor();
    expect(await shop.getByRole("button", { name: "Stopping…" }).isDisabled()).toBe(true);
    expect(await text(page, '[data-card="shop"] [data-cloud-badge]')).toBe("stopping");
    // The person may not start it again while it is still closing.
    expect(await shop.getByRole("button", { name: "Run Shop in the cloud" }).count()).toBe(0);
    await shop.getByRole("button", { name: "Launch" }).waitFor({ timeout: 8000 });
    await shop.getByRole("button", { name: "Run Shop in the cloud" }).waitFor();
    expect(await shop.locator("[data-cloud-badge]").count()).toBe(0);
    expect(await shop.getByRole("alert").count()).toBe(0);
    expect(await shop.getByRole("status").filter({ hasText: "ended" }).count()).toBe(0);
  }, T);

  it("the service ending it says why on the card, with what it used and a way to start again", async () => {
    const { page } = await fresh({ profiles: [prof("shop")], cloud: "ok", ...withKey, sessions: [session("shop", { bytes: 5_000_000, costEur: 0.005 })] });
    await card(page, "shop").locator("[data-cloud-badge]").waitFor();
    await page.evaluate(() => (window as any).__clearcoteMock.cloudEnd("shop", "idle_timeout"));
    const notice = card(page, "shop").getByRole("status").filter({ hasText: "The cloud browser ended" });
    await notice.waitFor();
    expect(await notice.textContent()).toContain("Nobody watched or typed for 30 minutes, so it closed.");
    expect(await notice.textContent()).toContain("It used 5.0 MB and cost €0.0050.");
    await notice.getByRole("button", { name: "Start in the cloud again" }).click();
    await card(page, "shop").locator("[data-cloud-badge]").waitFor();
  }, T);

  it("a balance that ran out offers a top-up instead", async () => {
    const { page } = await fresh({ profiles: [prof("shop")], cloud: "ok", ...withKey, sessions: [session("shop")] });
    await card(page, "shop").locator("[data-cloud-badge]").waitFor();
    await page.evaluate(() => (window as any).__clearcoteMock.cloudEnd("shop", "stopped:balance"));
    const notice = card(page, "shop").getByRole("status").filter({ hasText: "balance ran out" });
    await notice.waitFor();
    expect(await notice.getByRole("button", { name: "Top up ↗" }).count()).toBe(1);
  }, T);

  // ── The service's refusals, as the card shows them ─────────────────────────
  const refusals: [string, Seed["cloud"], RegExp, string | null][] = [
    ["a low balance", { error: "Your hosted-browser balance is EUR 0.12; at least EUR 0.50 is needed to start a browser.", code: "INSUFFICIENT_BALANCE", status: 402 }, /Your cloud balance is too low.*EUR 0\.12/, "Top up ↗"],
    ["a refused key", { error: "The API key was not accepted. Check it in Settings → Cloud.", code: "UNAUTHORIZED", status: 401 }, /Your API key wasn't accepted/, "Cloud settings"],
    ["no free browser", { error: "No hosted browser capacity right now. Retry in a few seconds.", code: "NO_CAPACITY", status: 503 }, /No cloud browser is free right now/, "Start in the cloud again"],
    ["too many at once", { error: "You already have 3 browsers running or starting (limit 3). Close one first.", code: "CONCURRENCY_LIMIT", status: 429 }, /Too many cloud browsers at once/, "Start in the cloud again"],
    ["a profile still saving", { error: 'Session bs_x is already saving to profile "pm-shop".', code: "PROFILE_IN_USE", status: 409 }, /still saving in the cloud/, "Start in the cloud again"],
    ["a version the cloud lacks", { error: "No hosted build for version '149'. Available: 153.0.8010.53-r29.", code: "UNKNOWN_VERSION", status: 400 }, /doesn't have this browser version.*153\.0\.8010\.53-r29/, "Change version"],
    ["no connection", { error: "Could not reach www.clearcotelabs.com. Check the connection and try again.", code: "NETWORK", status: 0 }, /Couldn't reach Clearcote's servers/, "Start in the cloud again"],
  ];
  for (const [what, refusal, re, action] of refusals) {
    it(`a refused start (${what}) gets its own notice and the action that fixes it`, async () => {
      const { page, errors } = await fresh({ profiles: [prof("shop")], cloud: refusal, ...withKey });
      await card(page, "shop").getByRole("button", { name: "Run Shop in the cloud" }).click();
      const notice = card(page, "shop").locator('[role="alert"], [role="status"]').filter({ hasText: re });
      await notice.first().waitFor();
      if (action) expect(await notice.first().getByRole("button", { name: action }).count(), action).toBe(1);
      // Nothing started.
      expect(await card(page, "shop").locator("[data-cloud-badge]").count()).toBe(0);
      expect(errors).toEqual([]);
    }, T);
  }

  it("“Start in the cloud again” after the service had no free browser", async () => {
    const { page } = await fresh({ profiles: [prof("shop")], cloud: { error: "No hosted browser capacity right now.", code: "NO_CAPACITY", status: 503 }, ...withKey });
    await card(page, "shop").getByRole("button", { name: "Run Shop in the cloud" }).click();
    const retry = card(page, "shop").getByRole("button", { name: "Start in the cloud again" });
    await retry.waitFor();
    await page.evaluate(() => localStorage.setItem("clearcote.mock.cloud", "ok"));
    await retry.click();
    await card(page, "shop").locator("[data-cloud-badge]").waitFor();
    expect(await card(page, "shop").getByRole("alert").count()).toBe(0);
  }, T);

  // ── The editor's Cloud section ─────────────────────────────────────────────
  it("the editor's Cloud section: exit, country, cookies, cap, and what the cloud will run", async () => {
    const { page, errors } = await fresh({ profiles: [prof("shop", { proxy: "http://user:pw@proxy.example:8080", timezone: "Europe/Berlin", hardwareConcurrency: 8, extraArgs: ["--foo"] })] });
    await card(page, "shop").getByRole("button", { name: "Edit" }).click();
    await page.locator("nav button", { hasText: "Cloud" }).first().click();
    await page.locator("[data-cloud-fields]").waitFor();
    const plan = () => text(page, "[data-cloud-plan]");
    // The profile's own proxy is the default exit, shown without its password.
    await until(plan, (t) => t.includes("Leaves through: http://proxy.example:8080."), "proxy exit");
    expect(await plan()).not.toContain("pw");
    expect(await plan()).toContain("Device: the same one every session, from the seed seed-shop.");
    expect(await plan()).toContain("Cookies: kept in the cloud profile pm-shop.");
    expect(await text(page, "[data-cloud-local-only]")).toBe("Not used in the cloud: CPU cores, Extra switches.");

    await page.getByRole("radio", { name: /The included residential IP/ }).check();
    await page.getByRole("combobox", { name: "Cloud exit country" }).fill("DE");
    await until(plan, (t) => t.includes("the included residential IP in DE, the same one for up to a day."), "managed exit");
    await page.getByRole("checkbox", { name: /Keep its cookies/ }).uncheck();
    await until(plan, (t) => t.includes("not kept; every session starts empty."), "no cookies");
    await page.getByRole("spinbutton", { name: "Cloud traffic cap in GB" }).fill("2.5");
    await page.getByRole("button", { name: "Save profile" }).click();
    await page.locator("[data-cloud-fields]").waitFor({ state: "detached" });
    const saved = (await stored(page, "clearcote.profiles.mock")) as Record<string, any>[];
    expect(saved.find((p) => p.id === "shop")!.cloud).toEqual({ exit: "managed", country: "de", keepCookies: false, maxGb: 2.5 });
    expect(errors).toEqual([]);
  }, T);

  it("the editor says plainly when the cloud cannot run the profile as set", async () => {
    const { page } = await fresh({ profiles: [prof("shop", { proxy: "https://proxy.example:443" })] });
    await card(page, "shop").getByRole("button", { name: "Edit" }).click();
    await page.locator("nav button", { hasText: "Cloud" }).first().click();
    const alert = page.locator("[data-cloud-plan] [role=alert]");
    await alert.waitFor();
    expect(await alert.textContent()).toMatch(/https/);
    // Switching to the included IP makes it runnable.
    await page.getByRole("radio", { name: /The included residential IP/ }).check();
    await page.locator("[data-cloud-plan] [role=alert]").waitFor({ state: "detached" });
  }, T);

  // ── The viewer window ──────────────────────────────────────────────────────
  async function liveServer() {
    const s = await startFakeWs({
      onConnection: (c) => {
        c.sendText(JSON.stringify({ hello: true, control: true }));
        c.sendText(JSON.stringify({ url: "https://example.com/", title: "Example Domain", tabs: 2 }));
        c.sendBinary(jpeg);
      },
    });
    servers.push(s);
    return s;
  }
  const inputs = (c: FakeConn) => c.texts.map((t) => JSON.parse(t) as Record<string, unknown>);

  it("the viewer shows the frames and the page, and sends clicks, keys, wheel, paste and navigation", async () => {
    const s = await liveServer();
    const { page, errors } = await fresh({ ...withKey, sessions: [session("shop", { bytes: 2_100_000, costEur: 0.0021 })], view: s.url("/v/bs_x?token=t") }, "/cloud?id=shop");
    const img = page.getByRole("img", { name: "Cloud browser showing Example Domain" });
    await img.waitFor();
    await until(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), (w) => w === 1280, "frame decoded");
    await until(() => page.title(), (t) => t === "Shop — Cloud", "tab title");
    expect(await page.getByRole("textbox", { name: "Address" }).inputValue()).toBe("https://example.com/");
    expect(await page.getByText("2 tabs").count()).toBe(1);
    expect(await text(page, "[data-cloud-viewer-usage]")).toBe("US · included IP · 2.1 MB · €0.0021");
    const conn = s.conns[0];
    expect(conn.path).toBe("/v/bs_x?token=t");

    // A click in the middle of the picture lands in the middle of the page.
    const box = (await img.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const clicks = await until(() => Promise.resolve(inputs(conn).filter((m) => m.t === "mouse" && m.e !== "move")), (l) => l.length >= 2, "click sent");
    expect(clicks.map((m) => [m.e, m.b, m.n])).toEqual([["down", "left", 1], ["up", "left", 1]]);
    expect(Math.abs((clicks[0].x as number) - 0.5)).toBeLessThan(0.01);
    expect(Math.abs((clicks[0].y as number) - 0.5)).toBeLessThan(0.01);

    // Typing (the click focused the stage), a shortcut, and this window's own reload kept local.
    await page.keyboard.type("hi");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("F5");
    const keys = await until(() => Promise.resolve(inputs(conn).filter((m) => m.t === "key" && m.e === "down")), (l) => l.length >= 4, "keys sent");
    expect(keys.map((k) => [k.key, k.text ?? null, k.m])).toEqual([["h", "h", 0], ["i", "i", 0], ["Control", null, 2], ["a", null, 2]]);

    await page.mouse.move(box.x + box.width / 4, box.y + box.height / 4);
    await page.mouse.wheel(0, 300);
    const wheel = await until(() => Promise.resolve(inputs(conn).find((m) => m.t === "wheel")), (w) => !!w, "wheel sent");
    expect(wheel).toMatchObject({ dx: 0, dy: 300 });

    await page.locator("[data-cloud-stage]").evaluate((el) => {
      const dt = new DataTransfer();
      dt.setData("text", "pasted text");
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await until(() => Promise.resolve(inputs(conn).find((m) => m.t === "text")), (m) => m?.text === "pasted text", "paste sent");

    await page.getByRole("textbox", { name: "Address" }).fill("example.org/path");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "Reload" }).click();
    const navs = await until(() => Promise.resolve(inputs(conn).filter((m) => m.t === "nav")), (l) => l.length >= 3, "nav sent");
    expect(navs).toEqual([{ t: "nav", a: "go", url: "example.org/path" }, { t: "nav", a: "back" }, { t: "nav", a: "reload" }]);
    // Every message is one the worker accepts: no CDP, nothing else.
    expect(inputs(conn).every((m) => ["mouse", "wheel", "key", "text", "nav"].includes(m.t as string))).toBe(true);
    expect(errors).toEqual([]);
  }, T);

  it("the viewer reconnects with a fresh URL when the live view drops", async () => {
    const s = await liveServer();
    const { page } = await fresh({ ...withKey, sessions: [session("shop")], view: s.url("/v/again") }, "/cloud?id=shop");
    await page.getByRole("img", { name: /Cloud browser/ }).waitFor();
    s.conns[0].close(1011, { drop: true });
    await page.getByText(/Reconnecting/).first().waitFor();
    await until(() => Promise.resolve(s.conns.length), (n) => n === 2, "reconnected", 10000);
    await page.getByText(/Reconnecting/).first().waitFor({ state: "detached", timeout: 8000 });
  }, T);

  it("Stop in the viewer asks first, shows it stopping, then why it ended", async () => {
    const s = await liveServer();
    const { page } = await fresh({ ...withKey, sessions: [session("shop", { bytes: 20_360, costEur: 0.000021 })], view: s.url("/v/stop"), stopMs: 1000 }, "/cloud?id=shop");
    await page.getByRole("img", { name: /Cloud browser/ }).waitFor();
    await page.getByRole("banner").getByRole("button", { name: "Stop" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Stop this cloud browser?").waitFor();
    await dialog.getByRole("button", { name: "Stop" }).click();
    await page.getByText("Stopping. Its server closes it within a few seconds.").waitFor();
    expect(await page.getByRole("button", { name: "Stopping…" }).isDisabled()).toBe(true);
    const ended = page.getByRole("status").filter({ hasText: "The cloud browser ended" });
    await ended.waitFor({ timeout: 8000 });
    expect(await ended.textContent()).toContain("Stopped.");
    expect(await ended.textContent()).toContain("It used 20 KB and cost < €0.0001.");
    // Its socket was closed: the viewer stops showing a browser that is gone.
    await s.conns[0].clientClosed;
    expect(s.conns[0].frames.some((f) => f.opcode === 0x8 && f.masked)).toBe(true);
  }, T);

  it("the viewer of a session the service ended says why", async () => {
    const s = await liveServer();
    const { page } = await fresh({ ...withKey, sessions: [session("shop")], view: s.url("/v/end") }, "/cloud?id=shop");
    await page.getByRole("img", { name: /Cloud browser/ }).waitFor();
    await page.evaluate(() => (window as any).__clearcoteMock.cloudEnd("shop", "max_bytes"));
    await page.getByText("It reached this profile's traffic cap.").waitFor();
    expect(await page.getByRole("textbox", { name: "Address" }).isDisabled()).toBe(true);
  }, T);

  it("a viewer opened for a profile not in the cloud says so", async () => {
    const { page, errors } = await fresh({ ...withKey }, "/cloud?id=nothing");
    await page.getByText("This profile is not running in the cloud.").waitFor();
    expect(errors).toEqual([]);
  }, T);

  it("a session that ends in the viewer's window is gone from the main window too", async () => {
    const s = await liveServer();
    const { page, ctx } = await fresh({ profiles: [prof("shop")], cloud: "ok", ...withKey, sessions: [session("shop")], view: s.url("/v/both") });
    await card(page, "shop").locator("[data-cloud-badge]").waitFor();
    const viewer = await ctx.newPage();
    await viewer.goto(`${ORIGIN}/cloud?id=shop`);
    await viewer.getByRole("img", { name: /Cloud browser/ }).waitFor();
    await viewer.evaluate(() => (window as any).__clearcoteMock.cloudEnd("shop", "idle_timeout"));
    await card(page, "shop").getByRole("status").filter({ hasText: "The cloud browser ended" }).waitFor();
    expect(await card(page, "shop").locator("[data-cloud-badge]").count()).toBe(0);
  }, T);
});
