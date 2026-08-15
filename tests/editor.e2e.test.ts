// End-to-end for the category-rail editor, driven in a real browser.
//
// The renderer falls back to an in-memory mock of the Electron bridge when window.clearcote is
// absent (src/lib/ipc.ts), so the whole editor runs against `next dev` with no desktop app. That
// makes the UI itself testable — which matters here because everything worth checking is
// behavioural: does the rail navigate, does the badge count what you set, does a coherence issue
// deep-link to the field that caused it. None of that is provable from a unit test of the schema.
//
// Opt-in — needs a dev server and a Chromium for playwright-core (which bundles none):
//
//   npm run next:dev -- -p 3100                     # in another shell
//   CLEARCOTE_UI_E2E=1 \
//   CLEARCOTE_UI_BROWSER="/path/to/chrome" \
//   npx vitest run tests/editor.e2e.test.ts
//
// CLEARCOTE_UI_URL overrides the origin (default http://localhost:3100).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Browser, Page } from "playwright-core";

const READY = process.env.CLEARCOTE_UI_E2E === "1";
const ORIGIN = process.env.CLEARCOTE_UI_URL || "http://localhost:3100";

describe.skipIf(!READY)("editor UI — the category rail in a real browser", () => {
  let browser: Browser;
  let page: Page;

  const rail = (name: string) => page.locator("nav button", { hasText: name }).first();
  const chip = () => page.locator("button").filter({ hasText: /coherent|issue/ }).first();

  // vitest's `expect` is Chai-based and has none of Playwright's auto-retrying matchers, so the
  // waiting here is explicit. Every assertion below is about state React has yet to re-render, so
  // they poll rather than judging a single snapshot.
  const settle = () => page.waitForTimeout(140);
  const textOf = async (sel: string) => ((await page.locator(sel).first().textContent()) || "").trim();
  const count = (sel: string) => page.locator(sel).count();
  const isVisible = async (sel: string) =>
    (await count(sel)) > 0 && (await page.locator(sel).first().isVisible());

  /** Poll until `read()` matches, so a re-render in flight is never read as a failure. */
  async function until(read: () => Promise<string>, re: RegExp, what: string, ms = 8000) {
    const deadline = Date.now() + ms;
    let last = "";
    while (Date.now() < deadline) {
      last = await read();
      if (re.test(last)) return last;
      await page.waitForTimeout(80);
    }
    throw new Error(`${what}: expected /${re.source}/, last saw ${JSON.stringify(last.slice(0, 160))}`);
  }
  const untilRail = (name: string, re: RegExp) =>
    until(async () => ((await rail(name).textContent()) || "").trim(), re, `rail "${name}"`);
  const untilChip = (re: RegExp) =>
    until(async () => ((await chip().textContent()) || "").trim(), re, "coherence chip");
  const untilHeading = (re: RegExp) => until(() => textOf("h3"), re, "panel heading");

  beforeAll(async () => {
    const { chromium } = await import("playwright-core");
    // playwright-core ships no browser of its own. Point CLEARCOTE_UI_BROWSER at any Chromium.
    const executablePath = process.env.CLEARCOTE_UI_BROWSER || undefined;
    browser = await chromium.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // A renderer exception means the editor is broken even when the DOM still looks right.
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "+ New profile" }).click();
    await page.waitForSelector('[data-field="name"]');
    if (errors.length) throw new Error(`renderer threw: ${errors.join(" | ")}`);
  }, 120000);

  afterAll(async () => {
    await browser?.close();
  }, 20000);

  it("opens on Identity with all six categories in the rail", async () => {
    const labels = await page.locator("nav button").allTextContents();
    expect(labels.map((l) => l.replace(/[0-9▲]/g, "").trim())).toEqual([
      "Identity",
      "Browser",
      "Hardware",
      "Network",
      "Rendering",
      "Session",
    ]);
    expect(await textOf("h3")).toBe("Identity");
  }, 20000);

  it("shows one panel at a time — a Hardware field is not in the DOM while Identity is open", async () => {
    // The whole point of the rail: the other 40 fields are not there to be scrolled past.
    expect(await isVisible('[data-field="name"]')).toBe(true);
    expect(await count('[data-field="gpuVendor"]')).toBe(0);
  }, 20000);

  it("navigates to another category", async () => {
    await rail("Hardware").click();
    await untilHeading(/^Hardware$/);
    expect(await isVisible('[data-field="gpuVendor"]')).toBe(true);
    expect(await count('[data-field="name"]')).toBe(0);
    await rail("Identity").click();
    await untilHeading(/^Identity$/);
  }, 20000);

  it("groups the risky screen row into its own sub-panel", async () => {
    await rail("Hardware").click();
    await untilHeading(/^Hardware$/);
    expect(await page.getByText("Screen dimensions", { exact: false }).count()).toBeGreaterThan(0);
    await rail("Identity").click();
    await untilHeading(/^Identity$/);
  }, 20000);

  it("badges count what you set, and a defaulted value does not count", async () => {
    // A fresh profile has a seed (Identity), a platform (Browser) and geoip (Network) — geoip is
    // ON by default, and a default the user did not choose still counts here because it is written
    // onto the profile rather than inferred at launch. Brand, which IS inferred, does not count:
    // Browser reads 1, not 2. Hardware has nothing set at all.
    await untilRail("Identity", /Identity\s*1$/);
    await untilRail("Browser", /Browser\s*1$/);
    await untilRail("Network", /Network\s*1$/);
    await untilRail("Hardware", /^Hardware$/);
  }, 20000);

  it("the badge increments when a field is filled in, and clears when emptied", async () => {
    await rail("Network").click();
    await untilHeading(/Network/);
    // Starts at 1 because geoip is on by default, so the increment is 1 -> 2 -> 1.
    await untilRail("Network", /Network\s*1$/);
    await page.locator('[data-field="timezone"] input').fill("Asia/Tokyo");
    await untilRail("Network", /Network\s*2$/);
    await page.locator('[data-field="timezone"] input').fill("");
    await untilRail("Network", /Network\s*1$/);
    await rail("Identity").click();
    await untilHeading(/^Identity$/);
  }, 20000);

  it("search finds a setting in another category by its engine switch name", async () => {
    // Pinned to Identity first: clearing the search returns to the CURRENT category, so inheriting
    // one from an earlier test would make this pass or fail on test order.
    await rail("Identity").click();
    await untilHeading(/^Identity$/);
    await page.getByPlaceholder("Find a setting…").fill("socks5");
    await untilHeading(/match/);
    expect(await isVisible('[data-field="proxy"]')).toBe(true);
    await page.getByPlaceholder("Find a setting…").fill("");
    await untilHeading(/^Identity$/);
  }, 20000);

  it("search reaches a field by a word only its explanation uses", async () => {
    await rail("Identity").click();
    await untilHeading(/^Identity$/);
    await page.getByPlaceholder("Find a setting…").fill("cdm");
    await untilHeading(/match/);
    expect(await isVisible('[data-field="widevine"]')).toBe(true);
    await page.getByPlaceholder("Find a setting…").fill("");
    await untilHeading(/^Identity$/);
  }, 20000);

  it("reports the Widevine contradiction on a brand-new profile", async () => {
    // The audit row a real customer hit: brand unset means Chrome, and there is no CDM.
    await untilChip(/1 issue/);
    await chip().click();
    await settle();
    expect(await page.getByText(/reports the "Google Chrome" brand/).count()).toBeGreaterThan(0);
  }, 20000);

  it("an issue deep-links to the field that caused it", async () => {
    await page.getByRole("button", { name: /Fix/ }).first().click();
    await untilHeading(/^Session & data$/);
    expect(await isVisible('[data-field="widevine"] input[type=checkbox]')).toBe(true);
    const focused = await page.evaluate(() => {
      const el = document.querySelector('[data-field="widevine"]');
      return !!el && el.contains(document.activeElement);
    });
    expect(focused, "the blamed field should be focused").toBe(true);
  }, 20000);

  it("fixing it clears the issue and updates the badge", async () => {
    await page.locator('[data-field="widevine"] input[type=checkbox]').check();
    await untilChip(/coherent/);
    await untilRail("Session", /Session\s*1$/);
  }, 20000);

  it("a new contradiction appears as soon as it is created, and goes when undone", async () => {
    // The canvas bridge alongside the real-GPU switch is a real disagreement: pixels come from the
    // remote host while the GPU strings come from this one.
    await rail("Rendering").click();
    await untilHeading(/^Rendering$/);
    await page.locator('[data-field="canvasBridgeUrl"] input').fill("ws://bridge:8443/render");
    await page.locator('[data-field="disableGpuFingerprint"] input[type=checkbox]').check();
    await untilChip(/issue/);
    await page.locator('[data-field="disableGpuFingerprint"] input[type=checkbox]').uncheck();
    await untilChip(/coherent/);
  }, 20000);

  it("the canvas-bridge sub-options only appear once there is a bridge to configure", async () => {
    await rail("Rendering").click();
    await untilHeading(/^Rendering$/);
    expect(await isVisible('[data-field="canvasBridgeMode"]')).toBe(true);
    await page.locator('[data-field="canvasBridgeUrl"] input').fill("");
    await settle();
    expect(await count('[data-field="canvasBridgeMode"]')).toBe(0);
  }, 20000);

  it("the launch preview follows you across categories and redacts secrets", async () => {
    await rail("Session").click();
    await untilHeading(/^Session & data$/);
    await page.locator('[data-field="encryptionKey"] input').fill("super-secret-key");
    await page.getByRole("button", { name: /Launch command/ }).click();
    await until(() => textOf("pre"), /profile-encryption-key/, "preview");
    const shown = await textOf("pre");
    expect(shown).toContain("--profile-encryption-key=********");
    expect(shown).not.toContain("super-secret-key");
    // Still there from another category — the preview is feedback, not a setting.
    await rail("Identity").click();
    await until(() => textOf("pre"), /chrome\.exe/, "preview after switching category");
  }, 20000);

  it("the shader dialect shows as an env var, not a switch", async () => {
    await rail("Rendering").click();
    await untilHeading(/^Rendering$/);
    await page.locator('[data-field="shaderDialect"] input[type=checkbox]').check();
    await until(() => textOf("pre"), /CLEARCOTE_SHADER_DIALECT=hlsl/, "env in preview");
    await page.locator('[data-field="shaderDialect"] input[type=checkbox]').uncheck();
  }, 20000);

  it("Save is reachable without scrolling, and gated on the seed", async () => {
    const save = page.getByRole("button", { name: "Save profile" });
    expect(await save.isVisible()).toBe(true);
    expect(await save.isEnabled()).toBe(true);
    await rail("Identity").click();
    await untilHeading(/^Identity$/);
    await page.locator('[data-field="fingerprint"] input').fill("");
    await settle();
    expect(await save.isEnabled(), "save must be disabled without a seed").toBe(false);
    await page.locator('[data-field="fingerprint"] input').fill("seed-restored");
    await settle();
    expect(await save.isEnabled()).toBe(true);
  }, 20000);

  it("saves, and the profile appears in the list", async () => {
    await rail("Identity").click();
    await untilHeading(/^Identity$/);
    await page.locator('[data-field="name"] input').fill("E2E rail profile");
    await page.getByRole("button", { name: "Save profile" }).click();
    await until(
      async () => (await page.locator("body").textContent()) || "",
      /E2E rail profile/,
      "saved profile in the list",
    );
  }, 20000);
});
