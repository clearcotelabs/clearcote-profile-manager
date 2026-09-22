// End-to-end for the usability pass, driven in a real browser against `next dev` (the renderer falls
// back to its in-browser mock of the Electron bridge — see src/lib/ipc.ts). Everything here is
// behaviour a unit test cannot see: focus, keyboard, dialogs stacking, layout at small sizes.
//
// Opt-in — needs a dev server and a Chromium for playwright-core (which bundles none):
//
//   npm run next:dev -- -p 3100                     # in another shell
//   CLEARCOTE_UI_E2E=1 \
//   CLEARCOTE_UI_BROWSER="/path/to/chrome" \
//   npx vitest run tests/ui.e2e.test.ts
//
// CLEARCOTE_UI_URL overrides the origin (default http://localhost:3100).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";
const T = 30000;

interface Seed {
  profiles?: Record<string, unknown>[];
  settings?: Record<string, unknown>;
  update?: Record<string, unknown>;
  theme?: "light" | "dark";
}

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
const RELEASE = {
  available: true,
  latest: "9.9.9",
  current: "0.12.4",
  releaseUrl: "https://example.test/releases/v9.9.9",
  asset: { name: "Clearcote-Profile-Manager-9.9.9-setup.exe", url: "https://example.test/x.exe", size: 10 },
};

describe.skipIf(!READY)("usability pass — in a real browser", () => {
  let browser: Browser;
  const open: BrowserContext[] = [];

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CLEARCOTE_UI_BROWSER || undefined,
      args: ["--no-sandbox"],
    });
  }, 120000);
  afterAll(async () => {
    for (const c of open) await c.close().catch(() => {});
    await browser?.close();
  }, 30000);

  /** A fresh browser context seeded before the app loads (and only once — a reload keeps state). */
  async function fresh(seed: Seed = {}, viewport = { width: 1280, height: 860 }) {
    const ctx = await browser.newContext({ viewport });
    open.push(ctx);
    await ctx.addInitScript((s: Seed) => {
      if (sessionStorage.getItem("__seeded")) return;
      sessionStorage.setItem("__seeded", "1");
      localStorage.clear();
      if (s.profiles) localStorage.setItem("clearcote.profiles.mock", JSON.stringify(s.profiles));
      if (s.settings) localStorage.setItem("clearcote.settings.mock", JSON.stringify(s.settings));
      if (s.update) localStorage.setItem("clearcote.mock.update", JSON.stringify(s.update));
      if (s.theme) localStorage.setItem("clearcote.theme", s.theme);
    }, seed);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await ready(page);
    return { page, errors };
  }
  const ready = (page: Page) => page.waitForSelector('main[data-ready="1"]', { timeout: 60000 });

  /** Poll until `read()` matches — nothing here is judged on a single mid-render snapshot. */
  async function until<V>(read: () => Promise<V>, ok: (v: V) => boolean, what: string, ms = 8000): Promise<V> {
    const end = Date.now() + ms;
    let last: V = await read();
    while (!ok(last)) {
      if (Date.now() > end) throw new Error(`${what}: last saw ${JSON.stringify(last)}`);
      await new Promise((r) => setTimeout(r, 60));
      last = await read();
    }
    return last;
  }
  const dialogs = (page: Page) => page.locator('[role="dialog"]').count();
  const activeInsideDialog = (page: Page) =>
    page.evaluate(() => {
      const ds = document.querySelectorAll('[role="dialog"]');
      const top = ds[ds.length - 1];
      return !!top && top.contains(document.activeElement);
    });
  const cardIds = (page: Page) => page.locator("[data-card]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.card));

  // ── Header ─────────────────────────────────────────────────────────────────
  it("the header says what launches — 'Browser not set' is gone", async () => {
    const { page, errors } = await fresh();
    const pill = page.getByRole("button", { name: "Browser preview" });
    expect(await pill.isVisible()).toBe(true);
    expect(await page.getByText("Browser not set").count()).toBe(0);
    expect(errors).toEqual([]);
  }, T);

  // ── The shared dialog ──────────────────────────────────────────────────────
  it("Settings fits a short window, its panel scrolls, and Done stays reachable (the original bug)", async () => {
    const { page } = await fresh({}, { width: 900, height: 560 });
    await page.keyboard.press("Control+Comma");
    const dlg = page.getByRole("dialog", { name: "Settings" });
    await dlg.waitFor();
    await dlg.getByRole("button", { name: "Licence" }).click();
    const geo = await dlg.evaluate((d) => {
      const r = d.getBoundingClientRect();
      const panel = Array.from(d.querySelectorAll("div")).find((e) => getComputedStyle(e).overflowY === "auto")!;
      panel.scrollTop = 1000;
      return { top: r.top, bottom: r.bottom, vh: innerHeight, scrolled: panel.scrollTop > 0 };
    });
    expect(geo.top).toBeGreaterThanOrEqual(0);
    expect(geo.bottom).toBeLessThanOrEqual(geo.vh);
    expect(geo.scrolled).toBe(true);
    const done = dlg.getByRole("button", { name: "Done" });
    const box = (await done.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(560);
  }, T);

  it("at phone width Settings still fits, and nothing scrolls sideways", async () => {
    const { page } = await fresh({}, { width: 375, height: 600 });
    await page.getByRole("button", { name: "Settings" }).click();
    const r = await page.getByRole("dialog", { name: "Settings" }).evaluate((d) => {
      const b = d.getBoundingClientRect();
      return { l: b.left, r: b.right, t: b.top, b: b.bottom, vw: innerWidth, vh: innerHeight, sw: document.documentElement.scrollWidth };
    });
    expect(r.l).toBeGreaterThanOrEqual(0);
    expect(r.r).toBeLessThanOrEqual(r.vw);
    expect(r.t).toBeGreaterThanOrEqual(0);
    expect(r.b).toBeLessThanOrEqual(r.vh);
    expect(r.sw).toBeLessThanOrEqual(r.vw);
  }, T);

  it("the library keeps a usable list on a very short window (it shrank to 25px)", async () => {
    const { page } = await fresh({}, { width: 375, height: 420 });
    await page.keyboard.press("Control+n");
    await page.getByRole("button", { name: "Browse library…" }).click();
    const lib = page.getByRole("dialog", { name: "clearcote-profiles library" });
    await lib.waitFor();
    const h = await until(
      () => lib.evaluate((d) => Array.from(d.querySelectorAll("div")).filter((e) => getComputedStyle(e).overflowY === "auto").pop()!.clientHeight),
      (v) => v > 0,
      "library list height",
    );
    expect(h).toBeGreaterThanOrEqual(150);
  }, 60000);

  it("Esc closes only the top dialog — the library, then the editor", async () => {
    const { page } = await fresh();
    await page.keyboard.press("Control+n");
    await page.getByRole("button", { name: "Browse library…" }).click();
    await page.getByRole("dialog", { name: "clearcote-profiles library" }).waitFor();
    expect(await dialogs(page)).toBe(2);
    await page.keyboard.press("Escape");
    await until(() => dialogs(page), (n) => n === 1, "library closed");
    expect(await page.getByRole("dialog", { name: "New profile" }).isVisible()).toBe(true);
    await page.keyboard.press("Escape"); // untouched new profile → no question asked
    await until(() => dialogs(page), (n) => n === 0, "editor closed");
  }, 60000);

  it("Tab stays inside a dialog, and focus returns to what opened it", async () => {
    const { page } = await fresh();
    const opener = page.getByRole("button", { name: "Settings" });
    await opener.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Settings" }).waitFor();
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press(i % 7 === 6 ? "Shift+Tab" : "Tab");
      expect(await activeInsideDialog(page), `after ${i + 1} tabs`).toBe(true);
    }
    await page.keyboard.press("Escape");
    await until(() => dialogs(page), (n) => n === 0, "settings closed");
    expect(await opener.evaluate((el) => el === document.activeElement)).toBe(true);
  }, T);

  it("the page behind does not scroll while a dialog is open", async () => {
    const { page } = await fresh();
    await page.keyboard.press("Control+Comma");
    await page.getByRole("dialog", { name: "Settings" }).waitFor();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await page.keyboard.press("Escape");
    await until(() => page.evaluate(() => document.body.style.overflow), (v) => v !== "hidden", "scroll unlocked");
  }, T);

  it("a backdrop click closes; a text selection dragged out of the dialog does not", async () => {
    const { page } = await fresh();
    await page.keyboard.press("Control+Comma");
    const dlg = page.getByRole("dialog", { name: "Settings" });
    await dlg.waitFor();
    const b = (await dlg.boundingBox())!;
    await page.mouse.move(b.x + 40, b.y + 80);
    await page.mouse.down();
    await page.mouse.move(5, 5);
    await page.mouse.up();
    expect(await dialogs(page)).toBe(1);
    await page.mouse.click(5, 5);
    await until(() => dialogs(page), (n) => n === 0, "closed by backdrop");
  }, T);

  // ── Unsaved changes ────────────────────────────────────────────────────────
  it("closing with unsaved edits asks — the safe answer is focused, and Discard really discards", async () => {
    const { page } = await fresh();
    await page.keyboard.press("Control+n");
    await page.locator('[data-field="name"] input').fill("Half-finished");
    expect(await page.getByText("Unsaved changes").isVisible()).toBe(true);

    await page.keyboard.press("Escape");
    const ask = page.getByRole("dialog", { name: "Discard your changes?" });
    await ask.waitFor();
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Keep editing");
    await page.keyboard.press("Enter"); // a reflex Enter keeps the work
    await until(() => dialogs(page), (n) => n === 1, "back to the editor");
    expect(await page.locator('[data-field="name"] input').inputValue()).toBe("Half-finished");

    await page.getByRole("dialog", { name: "New profile" }).getByRole("button", { name: "Close" }).click();
    await ask.waitFor();
    await ask.getByRole("button", { name: "Discard" }).click();
    await until(() => dialogs(page), (n) => n === 0, "editor discarded");
    expect(await page.locator("[data-card]").count()).toBe(0); // nothing was saved
  }, T);

  it("closing an untouched editor asks nothing, and beforeunload is armed only while dirty", async () => {
    const { page } = await fresh({ profiles: [prof("a", { name: "Shop" })] });
    const armed = () =>
      page.evaluate(() => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      });
    await page.locator('[data-card="a"]').getByRole("button", { name: "Edit" }).click();
    await page.getByRole("dialog", { name: "Edit profile" }).waitFor();
    expect(await armed()).toBe(false);
    await page.locator('[data-field="notes"] textarea').fill("x");
    expect(await armed()).toBe(true);
    await page.locator('[data-field="notes"] textarea').fill(""); // back to how it was
    await until(armed, (v) => v === false, "disarmed when the edit is undone");
    await page.keyboard.press("Escape");
    await until(() => dialogs(page), (n) => n === 0, "closed without asking");
  }, T);

  it("Ctrl+S saves the profile", async () => {
    const { page } = await fresh();
    await page.keyboard.press("Control+n");
    await page.locator('[data-field="name"] input').fill("Saved by keyboard");
    await page.keyboard.press("Control+s");
    await until(() => dialogs(page), (n) => n === 0, "editor closed on save");
    await until(() => page.locator("[data-card]").allTextContents(), (t) => t.some((x) => x.includes("Saved by keyboard")), "card");
  }, T);

  it("Esc in 'Find a setting' clears the search instead of closing the editor", async () => {
    const { page } = await fresh();
    await page.keyboard.press("Control+n");
    const find = page.getByPlaceholder("Find a setting…");
    await find.fill("timezone");
    await page.keyboard.press("Escape");
    expect(await find.inputValue()).toBe("");
    expect(await dialogs(page)).toBe(1);
  }, T);

  // ── Cards ──────────────────────────────────────────────────────────────────
  const SEEDED = [
    prof("a", {
      name: "Shop",
      group: "Work",
      browserVersion: "151.0.7922.108-r18",
      proxy: "http://alice:s3cret@proxy.example:8080",
      notes: "Uses the EU card\nsecond line",
      lastLaunchedAt: iso(2 * HOUR),
      createdAt: iso(10 * HOUR),
      tags: ["eu"],
    }),
    prof("b", { name: "Bank", group: "work ", updatedAt: iso(1 * HOUR) }),
    prof("c", { name: "Alpha", createdAt: iso(1 * HOUR) }),
  ];

  it("a card shows group, version, proxy without credentials, note and last launch", async () => {
    const { page } = await fresh({ profiles: SEEDED });
    const shop = page.locator('[data-card="a"]');
    await shop.waitFor();
    const text = (await shop.textContent()) || "";
    expect(text).toContain("pinned 151.0.7922.108-r18");
    expect(text).toContain("http proxy.example:8080");
    expect(text).not.toMatch(/alice|s3cret/);
    expect(text).toContain("Uses the EU card");
    expect(text).not.toContain("second line");
    expect(text).toContain("Launched 2 hours ago");
    expect(await page.locator('[data-card="c"]').textContent()).toContain("Never launched");
    expect(await page.locator('[data-card="c"]').textContent()).toContain("latest build");
    // "Work" and "work " are one group; ungrouped profiles get their own heading.
    const heads = await page.locator("main section h2").allTextContents();
    // The heading is spelled the way its first profile (in the current order) wrote it.
    expect(heads.map((h) => h.replace(/\d+$/, "").trim().toLowerCase())).toEqual(["work", "no group"]);
  }, T);

  it("sorting: recently used first by default, Name on request — and the choice is remembered", async () => {
    const { page } = await fresh({ profiles: SEEDED });
    await page.locator("[data-card]").first().waitFor();
    expect(await cardIds(page)).toEqual(["b", "a", "c"]); // Work(b newer than a), then No group
    await page.getByLabel("Sort").selectOption("name");
    await until(() => cardIds(page), (ids) => ids.join() === "b,a,c", "name order within groups");
    await page.getByLabel("Sort").selectOption("created");
    await until(() => cardIds(page), (ids) => ids.join() === "a,b,c", "newest first within groups");
    await page.getByLabel("Sort").selectOption("name");
    await page.reload();
    await ready(page);
    expect(await page.getByLabel("Sort").inputValue()).toBe("name");
  }, T);

  it("a launch problem stays on its card until dismissed", async () => {
    const { page } = await fresh({ profiles: [prof("a", { name: "Shop" })] });
    const card = page.locator('[data-card="a"]');
    await card.getByRole("button", { name: "Launch" }).click();
    await card.getByText("Launching only works in the desktop app.").waitFor();
    await page.waitForTimeout(4500); // longer than the old toast lived
    expect(await card.getByText("Launching only works in the desktop app.").isVisible()).toBe(true);
    await card.getByRole("button", { name: "Dismiss" }).click();
    expect(await card.getByText("Launching only works in the desktop app.").count()).toBe(0);
  }, T);

  // ── Delete + undo ──────────────────────────────────────────────────────────
  it("delete is behind the ⋯ menu, asks in-app, and Undo brings the profile back", async () => {
    const { page } = await fresh({ profiles: [prof("a", { name: "Shop" }), prof("b", { name: "Bank" })] });
    await page.getByRole("button", { name: "More actions for Shop" }).click();
    await page.getByRole("menuitem", { name: /Delete/ }).click();
    const ask = page.getByRole("dialog", { name: "Delete “Shop”?" });
    await ask.waitFor();
    expect(await ask.textContent()).toMatch(/cookies, logins/);
    await ask.getByRole("button", { name: "Delete" }).click();
    await until(() => cardIds(page), (ids) => ids.join() === "b", "deleted");
    // Said twice on purpose: the visible toast, and the always-mounted live region screen readers hear.
    const announced = () => page.locator(".sr-only[aria-live]").textContent();
    await until(announced, (t) => t === "Deleted “Shop”.", "announced");
    expect(await page.getByText("Deleted “Shop”.").count()).toBe(2);
    await page.getByRole("button", { name: "Undo" }).click();
    await until(() => cardIds(page), (ids) => ids.includes("a"), "restored");
    await until(announced, (t) => t === "Restored “Shop”.", "restore announced");
  }, T);

  it("the Delete key asks too, and Enter on that question cancels", async () => {
    const { page } = await fresh({ profiles: [prof("a", { name: "Shop" })] });
    await page.locator('[data-card="a"]').focus();
    await page.keyboard.press("Delete");
    await page.getByRole("dialog", { name: "Delete “Shop”?" }).waitFor();
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Cancel");
    await page.keyboard.press("Enter");
    await until(() => dialogs(page), (n) => n === 0, "cancelled");
    expect(await cardIds(page)).toEqual(["a"]);
  }, T);

  it("the ⋯ menu works from the keyboard, and Esc hands focus back", async () => {
    const { page } = await fresh({ profiles: [prof("a", { name: "Shop" })] });
    const btn = page.getByRole("button", { name: "More actions for Shop" });
    await btn.focus();
    await page.keyboard.press("ArrowDown");
    await page.getByRole("menu").waitFor();
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Duplicate");
    await page.keyboard.press("ArrowDown");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Export…");
    await page.keyboard.press("Escape");
    expect(await page.getByRole("menu").count()).toBe(0);
    expect(await btn.evaluate((el) => el === document.activeElement)).toBe(true);
  }, T);

  // Found in the screenshot review: the NEXT card (positioned, later in the DOM) painted over the
  // lower items of an open menu, so "Open data folder" and "Delete…" looked disabled and could not
  // be clicked where they were drawn.
  it("an open ⋯ menu is on top of the cards below it", async () => {
    const { page } = await fresh({
      profiles: [prof("a", { name: "Top", updatedAt: iso(1 * HOUR) }), prof("b", { name: "Below", updatedAt: iso(2 * HOUR) })],
    }, { width: 420, height: 900 }); // one column: "Below" sits right under "Top"
    await page.getByRole("button", { name: "More actions for Top" }).click();
    await page.getByRole("menu").waitFor();
    for (const name of ["Open data folder", "Delete…"]) {
      const hit = await page.getByRole("menuitem", { name }).evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && el.contains(top);
      });
      expect(hit, `${name} is what is under the pointer`).toBe(true);
    }
  }, T);

  it("the destructive button stays readable in both themes (≥ 4.5:1)", async () => {
    const { page } = await fresh({ profiles: [prof("a", { name: "Shop" })] });
    const ratio = () =>
      page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).evaluate((el) => {
        const rgb = (c: string) => (c.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
        const lum = (c: number[]) => {
          const [r, g, b] = c.map((v) => {
            const s = v / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const cs = getComputedStyle(el);
        const [a, b] = [lum(rgb(cs.color)), lum(rgb(cs.backgroundColor))].sort((x, y) => y - x);
        return (a + 0.05) / (b + 0.05);
      });
    const ask = async () => {
      await page.getByRole("button", { name: "More actions for Shop" }).click();
      await page.getByRole("menuitem", { name: /Delete/ }).click();
      await page.getByRole("dialog").waitFor();
    };
    await ask();
    expect(await ratio(), "dark").toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Toggle light or dark theme" }).click();
    await ask();
    expect(await ratio(), "light").toBeGreaterThanOrEqual(4.5);
  }, T);

  // ── Keyboard ───────────────────────────────────────────────────────────────
  it("list shortcuts: / to search, Esc to clear, ? for the list, Ctrl+, for Settings", async () => {
    const { page } = await fresh({ profiles: SEEDED });
    await page.locator("[data-card]").first().waitFor();
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("/");
    await page.keyboard.type("bank");
    await until(() => cardIds(page), (ids) => ids.join() === "b", "filtered");
    await page.keyboard.press("Escape");
    await until(() => cardIds(page), (ids) => ids.length === 3, "search cleared");
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("?");
    await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Comma");
    await page.getByRole("dialog", { name: "Settings" }).waitFor();
  }, T);

  it("single-key shortcuts never fire while typing, and none fire behind a dialog", async () => {
    const { page } = await fresh();
    await page.getByLabel("Search profiles").click();
    await page.keyboard.type("what?");
    expect(await page.getByLabel("Search profiles").inputValue()).toBe("what?");
    expect(await dialogs(page)).toBe(0);
    await page.keyboard.press("Control+Comma");
    await page.getByRole("dialog", { name: "Settings" }).waitFor();
    await page.keyboard.press("Control+n");
    expect(await page.getByRole("dialog", { name: "New profile" }).count()).toBe(0);
  }, T);

  it("arrow keys move between cards; E edits the focused one", async () => {
    const { page } = await fresh({ profiles: [prof("a", { name: "One", updatedAt: iso(3 * HOUR) }), prof("b", { name: "Two", updatedAt: iso(2 * HOUR) }), prof("c", { name: "Three", updatedAt: iso(1 * HOUR) })] });
    await page.locator('[data-card="c"]').focus();
    await page.keyboard.press("ArrowRight");
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.card)).toBe("b");
    await page.keyboard.press("ArrowLeft");
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.card)).toBe("c");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("e");
    const ed = page.getByRole("dialog", { name: "Edit profile" });
    await ed.waitFor();
    expect(await page.locator('[data-field="name"] input').inputValue()).toBe("Two");
  }, T);

  // ── Update suggestion ──────────────────────────────────────────────────────
  it("a newer release is suggested on every start; Later hides it until the next start", async () => {
    const { page } = await fresh({ update: RELEASE });
    const banner = page.getByText("Version 9.9.9 is available");
    await banner.waitFor();
    await page.getByRole("button", { name: "Later" }).click();
    expect(await banner.count()).toBe(0);
    await page.reload();
    await ready(page);
    await banner.waitFor(); // a new start asks again
  }, T);

  it("the Settings switch turns the check off, is remembered, and Check now still works", async () => {
    const { page } = await fresh({ update: RELEASE });
    await page.getByText("Version 9.9.9 is available").waitFor();
    await page.keyboard.press("Control+Comma");
    const dlg = page.getByRole("dialog", { name: "Settings" });
    await dlg.getByRole("button", { name: "Updates" }).click();
    const sw = dlg.getByRole("switch", { name: "Check for updates when the app starts" });
    expect(await sw.getAttribute("aria-checked")).toBe("true");
    await sw.click();
    await until(() => sw.getAttribute("aria-checked"), (v) => v === "false", "switched off");
    await page.keyboard.press("Escape");

    await page.reload();
    await ready(page);
    await page.waitForTimeout(800);
    expect(await page.getByText("Version 9.9.9 is available").count()).toBe(0);
    await page.keyboard.press("Control+Comma");
    await dlg.getByRole("button", { name: "Updates" }).click();
    expect(await dlg.getByRole("switch", { name: "Check for updates when the app starts" }).getAttribute("aria-checked")).toBe("false");
    await dlg.getByRole("button", { name: "Check now" }).click();
    await dlg.getByText("Version 9.9.9 is available — see the banner.").waitFor();
  }, T);

  // ── Theme ──────────────────────────────────────────────────────────────────
  it("status colours follow the theme (light shades are dark enough to read on paper)", async () => {
    const { page } = await fresh({ profiles: [prof("a", { name: "Shop" })] });
    const card = page.locator('[data-card="a"]');
    await card.getByRole("button", { name: "Launch" }).click();
    const title = card.getByText("Launching only works in the desktop app.");
    await title.waitFor();
    const dark = await title.evaluate((el) => getComputedStyle(el).color);
    await page.getByRole("button", { name: "Toggle light or dark theme" }).click();
    await until(() => page.evaluate(() => document.documentElement.classList.contains("light")), (v) => v, "light on");
    const light = await until(() => title.evaluate((el) => getComputedStyle(el).color), (c) => c !== dark, "colour changed");
    expect(dark).toBe("rgb(251, 191, 36)"); // amber-400 on ink
    expect(light).toBe("rgb(180, 83, 9)"); // amber-700 on paper
  }, T);
});
