// The header pill: electron/launchTarget.ts works out what a profile on "Latest" launches, and
// src/lib/launchTarget.ts words it. Plus the settings merge that keeps the learned plan, and the
// update-check switch. Hermetic: fetch is mocked, the cache is a temp dir.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeTarget, planName } from "../src/lib/launchTarget";
import { mergeRendererSettings } from "../electron/settingsmerge";
import { startupCheckEnabled } from "../electron/appupdate";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-target-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

const CATALOG = {
  schema: 1,
  builds: [
    {
      major: 149,
      version: "149.0.7827.114",
      tier: "free",
      tag: "v0.1.0-pre.22",
      platforms: {
        windows: { asset: "a.zip", url: "https://gh/a.zip", sha256: "a".repeat(64), archive: "zip", binary: "chrome.exe" },
        linux: { asset: "a.tar.xz", url: "https://gh/a.tar.xz", sha256: "b".repeat(64), archive: "tar.xz", binary: "chrome" },
      },
    },
    {
      major: 153,
      version: "153.0.8010.36",
      tier: "pro",
      tag: "pro-153.0.8010.36",
      platforms: {
        windows: { asset: "p.zip", archive: "zip", binary: "chrome.exe" },
        linux: { asset: "p.tar.xz", archive: "tar.xz", binary: "chrome" },
      },
    },
  ],
};

type T = typeof import("../electron/launchTarget");
let t: T;
const CACHE = path.join(ROOT, "cache");
const realFetch = globalThis.fetch;
const OLD = { cache: process.env.CLEARCOTE_CACHE, bin: process.env.CLEARCOTE_BINARY, key: process.env.CLEARCOTE_LICENSE_KEY, home: process.env.HOME, up: process.env.USERPROFILE };

beforeAll(async () => {
  process.env.CLEARCOTE_CACHE = CACHE;
  delete process.env.CLEARCOTE_BINARY;
  delete process.env.CLEARCOTE_LICENSE_KEY;
  // "No key" also means no ~/.clearcote/license.key — point HOME at an empty dir.
  process.env.HOME = ROOT;
  process.env.USERPROFILE = ROOT;
  t = await import("../electron/launchTarget");
});
afterAll(() => {
  for (const [k, v] of Object.entries({ CLEARCOTE_CACHE: OLD.cache, CLEARCOTE_BINARY: OLD.bin, CLEARCOTE_LICENSE_KEY: OLD.key, HOME: OLD.home, USERPROFILE: OLD.up })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  t.resetLaunchTargetCache();
  fs.rmSync(CACHE, { recursive: true, force: true });
});

function serveCatalog() {
  const spy = vi.fn(async () => new Response(JSON.stringify(CATALOG), { status: 200 }));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}
/** A finished download in the cache: browser/ + .verified, as proBinary.ts leaves it. */
function cached(tag: string) {
  fs.mkdirSync(path.join(CACHE, tag, "browser"), { recursive: true });
  fs.writeFileSync(path.join(CACHE, tag, ".verified"), "x");
}

describe("launchTarget (main process)", () => {
  it("a custom binary wins for every profile, and needs no network", async () => {
    const bin = path.join(ROOT, "chrome.exe");
    fs.writeFileSync(bin, "");
    const spy = serveCatalog();
    expect(await t.launchTarget({ binaryPath: bin })).toEqual({ mode: "custom", path: bin });
    expect(spy).not.toHaveBeenCalled();
  });

  it("a binary path that no longer exists is ignored (falls back to managed)", async () => {
    serveCatalog();
    const r = await t.launchTarget({ binaryPath: path.join(ROOT, "gone.exe") });
    expect(r.mode).toBe("managed");
  });

  it("with a key: the newest build overall, with the plan last seen", async () => {
    serveCatalog();
    const r = await t.launchTarget({ licenseKey: "cc_lic_x", lastPlan: "free" });
    expect(r).toEqual({ mode: "managed", licensed: true, plan: "free", version: "153.0.8010.36", major: 153, downloaded: false });
  });

  it("without a key: the newest free build, and no plan even if one was stored", async () => {
    serveCatalog();
    const r = await t.launchTarget({ lastPlan: "pro" });
    expect(r).toMatchObject({ mode: "managed", licensed: false, plan: undefined, major: 149 });
  });

  it("'downloaded' matches the revision-suffixed cache dir of the resolved build", async () => {
    serveCatalog();
    cached("pro-152.0.7977.82-r24"); // a different build — does not count
    expect((await t.launchTarget({ licenseKey: "k" })).downloaded).toBe(false);
    cached("pro-153.0.8010.36-r27");
    t.resetLaunchTargetCache();
    expect((await t.launchTarget({ licenseKey: "k" })).downloaded).toBe(true);
    cached("v0.1.0-pre.22");
    expect((await t.launchTarget({})).downloaded).toBe(true);
  });

  it("the catalog is cached for a few minutes, and reset() forgets it", async () => {
    const spy = serveCatalog();
    await t.launchTarget({ licenseKey: "k" });
    await t.launchTarget({ licenseKey: "k" });
    expect(spy).toHaveBeenCalledTimes(1);
    t.resetLaunchTargetCache();
    await t.launchTarget({ licenseKey: "k" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("an unreachable or hanging catalog is 'offline', not an error — and quickly", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await t.launchTarget({ licenseKey: "k", lastPlan: "free" })).toEqual({ mode: "offline", licensed: true, plan: "free" });

    globalThis.fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const started = Date.now();
    expect((await t.launchTarget({}, { timeoutMs: 150 })).mode).toBe("offline");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("describeTarget (the pill's words)", () => {
  it("while checking, and in the browser preview", () => {
    expect(describeTarget(null)).toMatchObject({ text: "Checking…", tone: "muted" });
    expect(describeTarget({ mode: "preview" })).toMatchObject({ text: "Browser preview", tone: "muted" });
  });

  it("a custom binary is a warning that names the file and where to undo it", () => {
    const v = describeTarget({ mode: "custom", path: "C:\\b\\chrome.exe" });
    expect(v).toMatchObject({ text: "Custom binary", tone: "warn", section: "browser" });
    expect(v.title).toContain("C:\\b\\chrome.exe");
  });

  it("managed builds read as plan · major — never 'Browser not set'", () => {
    expect(describeTarget({ mode: "managed", licensed: true, plan: "free", version: "153.0.8010.36", major: 153, downloaded: true })).toMatchObject({
      text: "Free plan · 153",
      tone: "ok",
      section: "license",
    });
    expect(describeTarget({ mode: "managed", licensed: true, plan: "pro", version: "153.0.8010.36", major: 153 }).text).toBe("Pro · 153");
    expect(describeTarget({ mode: "managed", licensed: true, version: "153.0.8010.36", major: 153 }).text).toBe("Licensed · 153");
    expect(describeTarget({ mode: "managed", licensed: false, version: "149.0.7827.114", major: 149 }).text).toBe("Open build · 149");
  });

  it("says when the next launch will download", () => {
    const later = describeTarget({ mode: "managed", licensed: true, version: "153.0.8010.36", major: 153, downloaded: false });
    expect(later.title).toMatch(/downloads on the first launch/);
    const now = describeTarget({ mode: "managed", licensed: true, version: "153.0.8010.36", major: 153, downloaded: true });
    expect(now.title).not.toMatch(/downloads/);
  });

  it("offline is a warning, and keeps the plan", () => {
    expect(describeTarget({ mode: "offline", licensed: true, plan: "free" })).toMatchObject({ text: "Free plan · offline", tone: "warn" });
    expect(describeTarget({ mode: "offline", licensed: false }).text).toBe("Open build · offline");
  });

  it("planName", () => {
    expect(planName(undefined)).toBe("Licensed");
    expect(planName("free")).toBe("Free plan");
    expect(planName("pro")).toBe("Pro");
    expect(planName("team")).toBe("Team");
  });
});

describe("mergeRendererSettings — the learned plan is the main process's", () => {
  it("a stale renderer copy cannot erase or forge the plan", () => {
    const cur = { licenseKey: "k", lastPlan: "free" };
    expect(mergeRendererSettings(cur, { licenseKey: "k", updateCheck: false }).next).toEqual({ licenseKey: "k", updateCheck: false, lastPlan: "free" });
    expect(mergeRendererSettings(cur, { licenseKey: "k", lastPlan: "pro" }).next.lastPlan).toBe("free");
  });

  it("a new key starts with no known plan, and asks for a fresh pill", () => {
    const r = mergeRendererSettings({ licenseKey: "old", lastPlan: "free" }, { licenseKey: "new" });
    expect(r.next.lastPlan).toBeUndefined();
    expect(r.licenceChanged).toBe(true);
    expect(mergeRendererSettings({ licenseKey: "k" }, { licenseKey: undefined }).licenceChanged).toBe(true);
    expect(mergeRendererSettings({ licenseApiBase: "a" }, { licenseApiBase: "b" }).licenceChanged).toBe(true);
    expect(mergeRendererSettings({ licenseKey: "k" }, { licenseKey: "k", theme: "light" }).licenceChanged).toBe(false);
  });
});

describe("startupCheckEnabled — the one remembered opt-out", () => {
  it("is on unless explicitly turned off", () => {
    expect(startupCheckEnabled({})).toBe(true);
    expect(startupCheckEnabled({ updateCheck: true })).toBe(true);
    expect(startupCheckEnabled({ updateCheck: false })).toBe(false);
  });
});
