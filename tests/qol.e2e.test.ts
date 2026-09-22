// End-to-end for the quality-of-life round, in a real browser against `next dev` and the renderer's
// in-browser mock (src/lib/ipc.ts), whose opt-in hooks play the desktop's side: a launch that
// "runs", a one-browser plan, a browser stopping on its own, seeded storage and licence answers.
//
//   npm run next:dev -- -p 3100
//   CLEARCOTE_UI_E2E=1 CLEARCOTE_UI_BROWSER=<chrome.exe> npx vitest run tests/qol.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";
const T = 40000;
const HOUR = 3600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const prof = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  fingerprint: `seed${id}`,
  createdAt: iso(100 * HOUR),
  updatedAt: iso(50 * HOUR),
  ...over,
});

interface Seed {
  profiles?: Record<string, unknown>[];
  settings?: Record<string, unknown>;
  launch?: "ok" | { error: string; code?: string };
  limit?: "1";
  storage?: Record<string, unknown>;
  target?: Record<string, unknown>;
  license?: Record<string, unknown>;
  prefetch?: "ok";
}

describe.skipIf(!READY)("quality-of-life round — in a real browser", () => {
  let browser: Browser;
  const open: BrowserContext[] = [];

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ headless: true, executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined, args: ["--no-sandbox"] });
  }, 120000);
  afterAll(async () => {
    for (const c of open) await c.close().catch(() => {});
    await browser?.close();
  }, 30000);

  async function fresh(seed: Seed = {}, viewport = { width: 1280, height: 900 }) {
    const ctx = await browser.newContext({ viewport, acceptDownloads: true });
    open.push(ctx);
    await ctx.addInitScript((s: Seed) => {
      if (sessionStorage.getItem("__seeded")) return;
      sessionStorage.setItem("__seeded", "1");
      localStorage.clear();
      const put = (k: string, v: unknown) => v !== undefined && localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
      put("clearcote.profiles.mock", s.profiles);
      put("clearcote.settings.mock", s.settings);
      put("clearcote.mock.launch", s.launch);
      put("clearcote.mock.limit", s.limit);
      put("clearcote.mock.storage", s.storage);
      put("clearcote.mock.target", s.target);
      put("clearcote.mock.license", s.license);
      put("clearcote.mock.prefetch", s.prefetch);
    }, seed);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await ready(page);
    return { page, errors, ctx };
  }
  const ready = (page: Page) => page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });
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
  const cardIds = (page: Page) => page.locator("[data-card]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.card));
  const said = (page: Page) => page.locator(".sr-only[aria-live]").textContent().then((t) => t ?? "");
  const card = (page: Page, id: string) => page.locator(`[data-card="${id}"]`);

  const TEAM = [
    prof("shop", { name: "Shop", group: "Work", tags: ["eu", "cards"], updatedAt: iso(1 * HOUR) }),
    prof("bank", { name: "Bank", group: "Work", tags: ["us"], updatedAt: iso(2 * HOUR) }),
    prof("mail", { name: "Mail", group: "Home", updatedAt: iso(3 * HOUR) }),
    prof("temp", { name: "Temp", updatedAt: iso(4 * HOUR) }),
  ];

  // ── Filters ────────────────────────────────────────────────────────────────
  it("click a tag to filter; the filter shows as a pill that clears it", async () => {
    const { page, errors } = await fresh({ profiles: TEAM });
    await card(page, "shop").getByRole("button", { name: "#eu" }).click();
    await until(() => cardIds(page), (ids) => ids.join() === "shop", "only #eu");
    await page.getByRole("button", { name: "Remove the tag filter #eu" }).click();
    await until(() => cardIds(page), (ids) => ids.length === 4, "all back");
    expect(errors).toEqual([]);
  }, T);

  it("'Show only this group' from a group's menu, and Running only", async () => {
    const { page } = await fresh({ profiles: TEAM, launch: "ok" });
    await page.getByRole("button", { name: "Group Home" }).click();
    await page.getByRole("menuitem", { name: "Show only this group" }).click();
    await until(() => cardIds(page), (ids) => ids.join() === "mail", "Home only");
    await page.getByRole("button", { name: "Remove the group filter Home" }).click();

    await page.getByRole("button", { name: /^Running/ }).click();
    await page.getByText("Nothing is running").waitFor();
    await page.getByRole("button", { name: /^Running/ }).click();
    await card(page, "bank").getByRole("button", { name: "Launch" }).click();
    await card(page, "bank").getByText("running").waitFor();
    await page.getByRole("button", { name: /^Running · 1/ }).click();
    await until(() => cardIds(page), (ids) => ids.join() === "bank", "running only");
  }, T);

  // ── Groups ─────────────────────────────────────────────────────────────────
  it("fold a group away and move it — both remembered after a reload", async () => {
    const { page } = await fresh({ profiles: TEAM });
    const names = () => page.locator("main section [data-group-name]").allTextContents();
    expect(await names()).toEqual(["Work", "Home", "No group"]);
    // The chevron is aria-hidden, so the heading button is named by the group and its count.
    const workHeading = page.getByRole("button", { name: /^Work \d/ });
    await workHeading.click();
    await until(() => cardIds(page), (ids) => !ids.includes("shop") && !ids.includes("bank"), "Work folded");
    await page.getByRole("button", { name: "Group Home" }).click();
    await page.getByRole("menuitem", { name: "Move up" }).click();
    await until(names, (n) => n.join() === "Home,Work,No group", "Home first");
    await page.reload();
    await ready(page);
    await until(names, (n) => n.join() === "Home,Work,No group", "order kept");
    expect(await cardIds(page)).not.toContain("shop"); // still folded
    expect(await page.getByRole("button", { name: /^Work \d/ }).getAttribute("aria-expanded")).toBe("false");
  }, T);

  it("rename a group renames it on every profile; Ungroup dissolves it", async () => {
    const { page } = await fresh({ profiles: TEAM });
    await page.getByRole("button", { name: "Group Work" }).click();
    await page.getByRole("menuitem", { name: "Rename group…" }).click();
    const dlg = page.getByRole("dialog", { name: "Rename “Work”" });
    await dlg.getByLabel("New name").fill("Clients");
    await dlg.getByRole("button", { name: "Rename" }).click();
    await until(() => page.locator("main section [data-group-name]").allTextContents(), (n) => n.join() === "Clients,Home,No group", "renamed");
    await until(said.bind(null, page), (t) => t === "Renamed the group to “Clients” (2 profiles).", "announced");
    await page.getByRole("button", { name: "Group Home" }).click();
    await page.getByRole("menuitem", { name: "Ungroup these profiles" }).click();
    await until(() => page.locator("main section [data-group-name]").allTextContents(), (n) => n.join() === "Clients,No group", "Home dissolved");
  }, T);

  // ── Selection + bulk ───────────────────────────────────────────────────────
  it("select with the checkbox, Shift for a range, Ctrl+A for all, Space on a card, Esc to clear", async () => {
    const { page } = await fresh({ profiles: TEAM });
    const count = () => page.getByRole("region", { name: "Selected profiles" }).locator("span").first().textContent();
    await page.getByRole("checkbox", { name: "Select Shop" }).click();
    expect(await count()).toBe("1 selected");
    await page.getByRole("checkbox", { name: "Select Mail" }).click({ modifiers: ["Shift"] });
    expect(await count()).toBe("3 selected"); // Shop, Bank, Mail in list order
    await page.keyboard.press("Escape");
    expect(await page.getByRole("region", { name: "Selected profiles" }).count()).toBe(0);
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Control+a");
    expect(await count()).toBe("4 selected");
    await page.keyboard.press("Escape");
    await card(page, "temp").focus();
    await page.keyboard.press(" ");
    expect(await count()).toBe("1 selected");
    expect(await page.getByRole("checkbox", { name: "Select Temp" }).isChecked()).toBe(true);
  }, T);

  it("bulk: set group, add tag, delete — and one Undo restores them all", async () => {
    const { page } = await fresh({ profiles: TEAM });
    await page.getByRole("checkbox", { name: "Select Mail" }).click();
    await page.getByRole("checkbox", { name: "Select Temp" }).click();
    const bar = page.getByRole("region", { name: "Selected profiles" });

    await bar.getByRole("button", { name: "Set group…" }).click();
    await page.getByRole("dialog").getByLabel("Group").fill("Personal");
    await page.getByRole("dialog").getByRole("button", { name: "Set group" }).click();
    await until(() => page.locator("main section [data-group-name]").allTextContents(), (n) => n.includes("Personal") && !n.includes("Home"), "moved");

    await bar.getByRole("button", { name: "Add tag…" }).click();
    await page.getByRole("dialog").getByLabel("Tag").fill("#archive");
    await page.getByRole("dialog").getByRole("button", { name: "Add tag" }).click();
    await card(page, "temp").getByRole("button", { name: "#archive" }).waitFor();
    await card(page, "mail").getByRole("button", { name: "#archive" }).waitFor();

    await bar.getByRole("button", { name: "Delete…" }).click();
    const ask = page.getByRole("dialog", { name: "Delete 2 profiles?" });
    await ask.getByRole("button", { name: "Delete" }).click();
    await until(() => cardIds(page), (ids) => ids.sort().join() === "bank,shop", "deleted");
    await page.getByRole("button", { name: "Undo" }).click();
    await until(() => cardIds(page), (ids) => ids.length === 4, "all restored");
    await until(said.bind(null, page), (t) => t === "Restored 2 profiles.", "announced");
  }, T);

  it("bulk launch stops at a one-browser plan's limit, and the refused card offers the swap", async () => {
    const { page } = await fresh({ profiles: TEAM, launch: "ok", limit: "1" });
    await page.getByRole("checkbox", { name: "Select Shop" }).click();
    await page.getByRole("checkbox", { name: "Select Bank" }).click();
    await page.getByRole("region", { name: "Selected profiles" }).getByRole("button", { name: "Launch" }).click();
    await until(said.bind(null, page), (t) => t === "Launched 1, then reached your plan's browser limit.", "stopped at the limit");
    const refused = card(page, "bank");
    await refused.getByText("Your plan's browser limit is reached").waitFor();
    await refused.getByRole("button", { name: "Stop “Shop” and launch" }).click();
    await refused.getByText("running").waitFor();
    await until(async () => (await card(page, "shop").textContent()) || "", (t) => !t.includes("running"), "Shop stopped");
  }, T);

  // ── A browser that stops on its own ────────────────────────────────────────
  it("a crash and a licence stop each explain themselves on the card", async () => {
    const { page } = await fresh({ profiles: TEAM, launch: "ok" });
    await card(page, "shop").getByRole("button", { name: "Launch" }).click();
    await card(page, "shop").getByText("running").waitFor();
    await page.evaluate(() =>
      (window as unknown as { __clearcoteMock: { exit: (e: unknown) => void } }).__clearcoteMock.exit({ id: "shop", code: 3221225477, signal: null }),
    );
    await card(page, "shop").getByText("The browser crashed").waitFor();
    expect(await card(page, "shop").textContent()).toContain("Access violation — 0xC0000005");
    await card(page, "shop").getByRole("button", { name: "Try again" }).click();
    await card(page, "shop").getByText("running").waitFor();
    await page.evaluate(() =>
      (window as unknown as { __clearcoteMock: { exit: (e: unknown) => void } }).__clearcoteMock.exit({
        id: "shop",
        code: 0,
        signal: null,
        stderrTail: "[clearcote] licence: the run-token stopped refreshing (revoked, checked in, or over the concurrency limit); stopping.",
        leaseRefusal: { status: 429, code: "CONCURRENCY_LIMIT_EXCEEDED" },
      }),
    );
    await card(page, "shop").getByText("Closed by the licence check").waitFor();
    expect(await card(page, "shop").textContent()).toContain("Another browser took this licence's only slot.");
  }, T);

  it("a browser closed from its own window says nothing", async () => {
    const { page } = await fresh({ profiles: TEAM, launch: "ok" });
    await card(page, "shop").getByRole("button", { name: "Launch" }).click();
    await card(page, "shop").getByText("running").waitFor();
    await page.evaluate(() =>
      (window as unknown as { __clearcoteMock: { exit: (e: unknown) => void } }).__clearcoteMock.exit({ id: "shop", code: 0, signal: null }),
    );
    await card(page, "shop").getByRole("button", { name: "Launch" }).waitFor();
    expect(await card(page, "shop").locator('[role="alert"],[role="status"]').count()).toBe(0);
  }, T);

  // ── Export ─────────────────────────────────────────────────────────────────
  it("export leaves secrets out unless asked, and warns when they go in", async () => {
    const { page } = await fresh({ profiles: [prof("px", { name: "Proxied", proxy: "http://alice:s3cret@h.example:8080", encryptionKey: "k3y" })] });
    const exportOnce = async (withSecrets: boolean) => {
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const dlg = page.getByRole("dialog", { name: "Export 1 profile" });
      if (withSecrets) {
        await dlg.getByLabel(/Include proxy passwords/).check();
        await dlg.getByRole("alert").waitFor();
      }
      const [dl] = await Promise.all([page.waitForEvent("download"), dlg.getByRole("button", { name: "Export…" }).click()]);
      return fs.readFileSync((await dl.path())!, "utf8");
    };
    const plain = await exportOnce(false);
    expect(plain).toContain("h.example:8080");
    expect(plain).not.toMatch(/s3cret|k3y/);
    const full = await exportOnce(true);
    expect(full).toMatch(/alice:s3cret/);
    expect(full).toContain("k3y");
  }, T);

  // ── From a proxy list ──────────────────────────────────────────────────────
  it("create profiles from a pasted proxy list, with a live preview", async () => {
    const { page } = await fresh({ profiles: [] });
    await page.getByRole("button", { name: "From proxy list…" }).first().click();
    const dlg = page.getByRole("dialog", { name: "Create profiles from a proxy list" });
    await dlg.getByLabel("Proxies — one per line").fill(
      ["http://u:p@de1.example.net:8080", "203.0.113.7:3128:alice:s3cret", "not a proxy", "http://u:p@de1.example.net:8080", "socks5://10.0.0.1:1080"].join("\n"),
    );
    await dlg.getByLabel("Names").fill("EU {n}");
    await dlg.getByLabel("Group").fill("Pool");
    await dlg.getByText("3 profiles will be created · 1 duplicate skipped · 1 line not understood").waitFor();
    // The preview list hides credentials (the textarea itself of course holds what was typed).
    expect(await dlg.locator('[aria-live="polite"] ul').textContent()).not.toContain("s3cret");
    await dlg.getByRole("button", { name: "Create 3 profiles" }).click();
    await until(() => cardIds(page), (ids) => ids.length === 3, "created");
    const text = (await page.locator("main").textContent()) || "";
    for (const n of ["EU 1", "EU 2", "EU 3", "Pool"]) expect(text).toContain(n);
  }, T);

  // ── Settings ───────────────────────────────────────────────────────────────
  it("General: the close behaviour is chosen and remembered", async () => {
    const { page } = await fresh({ profiles: TEAM });
    await page.keyboard.press("Control+Comma");
    const dlg = page.getByRole("dialog", { name: "Settings" });
    expect(await dlg.getByRole("radio", { name: "Ask me each time" }).isChecked()).toBe(true);
    await dlg.getByRole("radio", { name: "Keep running in the tray" }).check();
    await page.keyboard.press("Escape");
    await page.reload();
    await ready(page);
    await page.keyboard.press("Control+Comma");
    expect(await page.getByRole("dialog", { name: "Settings" }).getByRole("radio", { name: "Keep running in the tray" }).isChecked()).toBe(true);
  }, T);

  it("Storage: totals, remove unused builds, clean copies, clear a profile's cache, download ahead", async () => {
    const GB = 1e9;
    const { page } = await fresh({
      profiles: TEAM,
      launch: "ok",
      prefetch: "ok",
      target: { mode: "managed", licensed: true, plan: "free", version: "153.0.8010.36", major: 153, downloaded: false },
      storage: {
        plan: {
          keep: [{ tag: "pro-153.0.8010.36-r27", version: "153.0.8010.36-r27", tier: "pro", sizeBytes: 0.6 * GB, reasons: ["Latest"] }],
          remove: [
            { tag: "pro-152.0.7977.82-r22", version: "152.0.7977.82-r22", tier: "pro", sizeBytes: 0.6 * GB },
            { tag: "pro-151.0.7922.108-r16", version: "151.0.7922.108-r16", tier: "pro", sizeBytes: 0.7 * GB },
          ],
          freeBytes: 1.3 * GB,
          offline: false,
        },
        temp: [{ path: "C:/t/clearcote-live/abc", kind: "launch-copy", sizeBytes: 0.5 * GB }],
        sizes: { shop: 98e6, bank: 48e6, mail: 0, temp: 0 },
      },
    });
    await card(page, "bank").getByRole("button", { name: "Launch" }).click();
    await card(page, "bank").getByText("running").waitFor();
    await page.keyboard.press("Control+Comma");
    const dlg = page.getByRole("dialog", { name: "Settings" });
    await dlg.getByRole("button", { name: "Storage" }).click();
    await dlg.getByText("1.9 GB browser builds · 500 MB copies · 146 MB profile data").waitFor();
    expect(await dlg.textContent()).toContain("Latest");

    await dlg.getByRole("button", { name: "Remove unused · frees 1.3 GB" }).click();
    await dlg.getByText("Removed 2 builds — 1.3 GB freed.").waitFor();
    await dlg.getByRole("button", { name: "Nothing to remove" }).waitFor();

    await dlg.getByRole("button", { name: "Clean up" }).click();
    await dlg.getByText("Cleaned up 500 MB.").waitFor();

    // A running profile's cache cannot be cleared (the browser has it open).
    expect(await dlg.getByRole("button", { name: "Clear cache of Bank" }).isDisabled()).toBe(true);
    await dlg.getByRole("button", { name: "Clear cache of Shop" }).click();
    await page.getByRole("dialog", { name: "Clear the cache of “Shop”?" }).getByRole("button", { name: "Clear cache" }).click();
    await dlg.getByText("Cleared 98 MB from “Shop”.").waitFor();

    await dlg.getByRole("button", { name: "Download now" }).click();
    await dlg.getByText("Build 153.0.8010.36 is ready — the next launch starts straight away.").waitFor();
  }, 60000);

  it("Licence: a free-key link, a check straight after saving, and 'valid but busy' reads as valid", async () => {
    const { page, ctx } = await fresh({ license: { ok: true, busy: true, code: "CONCURRENCY_LIMIT_EXCEEDED" } });
    await page.keyboard.press("Control+Comma");
    const dlg = page.getByRole("dialog", { name: "Settings" });
    await dlg.getByRole("button", { name: "Licence" }).click();
    const [popup] = await Promise.all([ctx.waitForEvent("page"), dlg.getByRole("button", { name: /Get a free key/ }).click()]);
    await popup.waitForLoadState("commit").catch(() => {});
    expect(popup.url()).toMatch(/^https:\/\/www\.clearcotelabs\.com\/(dashboard\/licenses|login)/);
    await popup.close();
    await dlg.getByPlaceholder("cc_lic_…").fill("cc_lic_example");
    await dlg.getByRole("button", { name: "Save" }).click();
    await dlg.getByText("✓ Valid — every browser slot is in use right now, so the check could not take one.").waitFor();
  }, T);

  // ── Editor ─────────────────────────────────────────────────────────────────
  it("the editor warns about a duplicate name, and the start page lands last on the command line", async () => {
    const { page } = await fresh({ profiles: TEAM });
    await page.keyboard.press("Control+n");
    const name = page.locator('[data-field="name"] input');
    await name.fill("shop ");
    await page.getByText("Another profile is already called “shop”.", { exact: false }).waitFor();
    await name.fill("Brand new");
    expect(await page.getByText("Another profile is already called", { exact: false }).count()).toBe(0);
    await page.getByPlaceholder("Find a setting…").fill("start page");
    await page.locator('[data-field="startUrl"] input').fill("example.com");
    await page.getByRole("button", { name: /Launch command/ }).click();
    const cmd = (await page.locator("pre").textContent()) || "";
    expect(cmd.trim().endsWith("https://example.com/")).toBe(true);
    await page.locator('[data-field="startUrl"] input').fill("--disable-web-security");
    expect((await page.locator("pre").textContent()) || "").not.toContain("--disable-web-security");
  }, T);

  // ── The card's new menu items ──────────────────────────────────────────────
  it("the card menu: Check proxy location only with a proxy, Clear cache disabled while running", async () => {
    const { page } = await fresh({ profiles: [...TEAM, prof("px", { name: "Proxied", proxy: "http://u:p@h.example:8080" })], launch: "ok" });
    await page.getByRole("button", { name: "More actions for Proxied" }).click();
    expect(await page.getByRole("menuitem", { name: "Check proxy location" }).count()).toBe(1);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "More actions for Shop" }).click();
    expect(await page.getByRole("menuitem", { name: "Check proxy location" }).count()).toBe(0);
    await page.keyboard.press("Escape");
    await card(page, "shop").getByRole("button", { name: "Launch" }).click();
    await card(page, "shop").getByText("running").waitFor();
    await page.getByRole("button", { name: "More actions for Shop" }).click();
    expect(await page.getByRole("menuitem", { name: /Clear cache/ }).isDisabled()).toBe(true);
  }, T);
});
