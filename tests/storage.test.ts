// Disk housekeeping: which builds can go (cacheplan.ts), the plan with real catalog rules
// (storage.ts), temp copies and the rename-first delete (cache.ts), and window placement
// (windowstate.ts). Real files in temp dirs; the catalog is a fixture.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planPrune, isInside, type CachedLike } from "../electron/cacheplan";
import { restoreBounds } from "../electron/windowstate";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-storage-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const B = (tag: string, sizeBytes = 100, tier: "free" | "pro" = tag.startsWith("pro-") ? "pro" : "free"): CachedLike => ({
  tag,
  version: tier === "pro" ? tag.slice(4) : tag,
  tier,
  sizeBytes,
  path: `C:\\Users\\x\\AppData\\Local\\clearcote\\Cache\\${tag}`,
});

describe("planPrune — what can go", () => {
  // The shape found on the machine this was built on: 13 builds, one in use.
  const cached = [
    B("pro-153.0.8010.36-r27", 600),
    B("pro-153.0.8010.36-r26", 600),
    B("pro-152.0.7977.82-r24", 575),
    B("pro-152.0.7977.82-r22", 575),
    B("pro-151.0.7922.108-r18", 555),
    B("pro-151.0.7922.108-r16", 713),
    B("v0.1.0-pre.22", 500),
    B("v0.1.0-pre.21", 500),
  ];

  it("keeps the newest revision of what Latest resolves to, removes the rest", () => {
    const p = planPrune(cached, [{ tag: "pro-153.0.8010.36", reason: "Latest" }]);
    expect(p.keep.map((k) => k.build.tag)).toEqual(["pro-153.0.8010.36-r27"]);
    expect(p.keep[0].reasons).toEqual(["Latest"]);
    expect(p.remove).toHaveLength(7);
    expect(p.freeBytes).toBe(600 + 575 + 575 + 555 + 713 + 500 + 500);
  });

  it("a revision pin keeps exactly that revision; a version pin keeps its newest revision", () => {
    const p = planPrune(cached, [
      { tag: "pro-151.0.7922.108-r18", reason: "Pinned by Bank" },
      { tag: "pro-152.0.7977.82", reason: "Pinned by Shop" },
    ]);
    const kept = Object.fromEntries(p.keep.map((k) => [k.build.tag, k.reasons]));
    expect(kept).toEqual({
      "pro-151.0.7922.108-r18": ["Pinned by Bank"],
      "pro-152.0.7977.82-r24": ["Pinned by Shop"],
    });
    expect(p.remove.map((b) => b.tag)).toContain("pro-151.0.7922.108-r16");
  });

  it("free release tags match exactly", () => {
    const p = planPrune(cached, [{ tag: "v0.1.0-pre.22", reason: "Pinned by Old" }]);
    expect(p.keep.map((k) => k.build.tag)).toEqual(["v0.1.0-pre.22"]);
  });

  it("a build a browser runs from, or the custom binary, always stays — whatever the rules say", () => {
    const p = planPrune(
      cached,
      [],
      [
        { path: "c:/users/x/appdata/local/clearcote/cache/pro-152.0.7977.82-r22/browser/chrome.exe", reason: "Running" },
        { path: "C:\\Users\\x\\AppData\\Local\\clearcote\\Cache\\v0.1.0-pre.21\\browser\\chrome.exe", reason: "Custom binary" },
      ],
    );
    expect(p.keep.map((k) => [k.build.tag, k.reasons])).toEqual([
      ["pro-152.0.7977.82-r22", ["Running"]],
      ["v0.1.0-pre.21", ["Custom binary"]],
    ]);
  });

  it("several reasons on one build are all shown, once each", () => {
    const p = planPrune(
      cached,
      [
        { tag: "pro-153.0.8010.36", reason: "Latest" },
        { tag: "pro-153.0.8010.36", reason: "Latest" },
        { tag: "pro-153.0.8010.36-r27", reason: "Pinned by Bank" },
      ],
      [{ path: cached[0].path + "\\browser\\chrome.exe", reason: "Running" }],
    );
    expect(p.keep[0].reasons).toEqual(["Latest", "Pinned by Bank", "Running"]);
  });

  it("isInside is case- and separator-insensitive, and not fooled by a shared prefix", () => {
    expect(isInside("C:\\A\\b\\c.exe", "c:/a/b")).toBe(true);
    expect(isInside("C:\\A\\bc\\c.exe", "C:\\A\\b")).toBe(false);
  });
});

describe("storagePlan — rules from the catalog, pins from the profiles", () => {
  const CAT = {
    schema: 1,
    builds: [
      { major: 149, version: "149.0.7827.114", tier: "free", tag: "v0.1.0-pre.22", platforms: { windows: { archive: "zip", binary: "chrome.exe" }, linux: { archive: "tar.xz", binary: "chrome" } } },
      { major: 152, version: "152.0.7977.82", tier: "pro", tag: "pro-152.0.7977.82", platforms: { windows: { archive: "zip", binary: "chrome.exe" }, linux: { archive: "tar.xz", binary: "chrome" } } },
      { major: 153, version: "153.0.8010.36", tier: "pro", tag: "pro-153.0.8010.36", platforms: { windows: { archive: "zip", binary: "chrome.exe" }, linux: { archive: "tar.xz", binary: "chrome" } } },
    ],
  };
  const cached = [B("pro-153.0.8010.36-r27"), B("pro-152.0.7977.82-r24"), B("pro-152.0.7977.82-r22"), B("v0.1.0-pre.22")];
  const P = (id: string, browserVersion?: string) => ({ id, name: id, fingerprint: "s", createdAt: "", updatedAt: "", browserVersion });

  it("licensed: keeps Latest (153) and a profile's major pin (newest 152), removes the rest", async () => {
    const { storagePlan } = await import("../electron/storage");
    const plan = await storagePlan(
      { licenseKey: "cc_lic_x" },
      { catalog: async () => CAT as never, profiles: () => [P("a"), P("bank", "152")] as never, running: () => [], cached: () => cached },
    );
    expect(plan.offline).toBe(false);
    expect(plan.keep.map((k) => [k.build.tag, k.reasons])).toEqual([
      ["pro-153.0.8010.36-r27", ["Latest"]],
      ["pro-152.0.7977.82-r24", ["Pinned by bank"]],
    ]);
    expect(plan.remove.map((b) => b.tag).sort()).toEqual(["pro-152.0.7977.82-r22", "v0.1.0-pre.22"]);
  });

  it("an unknown pin keeps nothing extra, and never throws", async () => {
    const { storagePlan } = await import("../electron/storage");
    const plan = await storagePlan(
      { licenseKey: "k" },
      { catalog: async () => CAT as never, profiles: () => [P("x", "148")] as never, running: () => [], cached: () => cached },
    );
    expect(plan.keep.map((k) => k.build.tag)).toEqual(["pro-153.0.8010.36-r27"]);
  });

  it("offline: nothing is removable — a pin cannot be matched without the catalog", async () => {
    const { storagePlan } = await import("../electron/storage");
    const plan = await storagePlan(
      { licenseKey: "k" },
      {
        catalog: async () => {
          throw new TypeError("fetch failed");
        },
        profiles: () => [],
        running: () => [],
        cached: () => cached,
      },
    );
    expect(plan).toMatchObject({ offline: true, remove: [], freeBytes: 0 });
    expect(plan.keep).toHaveLength(cached.length);
  });

  it("the custom binary and running browsers are kept even with no rules at all", async () => {
    const { storagePlan } = await import("../electron/storage");
    const plan = await storagePlan(
      { binaryPath: cached[3].path + "\\browser\\chrome.exe" },
      { catalog: async () => ({ schema: 1, builds: [] }) as never, profiles: () => [], running: () => [cached[2].path + "\\browser\\chrome.exe"], cached: () => cached },
    );
    expect(plan.keep.map((k) => [k.build.tag, k.reasons])).toEqual([
      ["pro-152.0.7977.82-r22", ["Running"]],
      ["v0.1.0-pre.22", ["Custom binary"]],
    ]);
  });
});

describe("removeDirIfUnused / temp copies — real folders", () => {
  let tmp: string;
  let cache: typeof import("../electron/cache");
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(ROOT, "tmp-"));
    cache = await import("../electron/cache");
  });
  const tree = (dir: string, bytes = 1000) => {
    fs.mkdirSync(path.join(dir, "browser"), { recursive: true });
    fs.writeFileSync(path.join(dir, "browser", "chrome.exe"), Buffer.alloc(bytes));
  };

  it("removes an unused folder, and reports a missing one", async () => {
    const d = path.join(tmp, "unused");
    tree(d);
    expect(await cache.removeDirIfUnused(d)).toBe("removed");
    expect(fs.existsSync(d)).toBe(false);
    expect(await cache.removeDirIfUnused(d)).toBe("missing");
  });

  // What a running browser does to its build folder. The old recursive delete half-deleted it.
  it.runIf(process.platform === "win32")("a folder with an open file is refused whole — nothing inside is deleted", async () => {
    const d = path.join(tmp, "busy");
    tree(d);
    fs.writeFileSync(path.join(d, "browser", "resources.pak"), "x");
    const fd = fs.openSync(path.join(d, "browser", "chrome.exe"), "r");
    try {
      expect(await cache.removeDirIfUnused(d)).toBe("in-use");
      expect(fs.existsSync(path.join(d, "browser", "resources.pak"))).toBe(true);
      expect(fs.existsSync(path.join(d, "browser", "chrome.exe"))).toBe(true);
    } finally {
      fs.closeSync(fd);
    }
    expect(await cache.removeDirIfUnused(d)).toBe("removed");
  });

  it("lists launch copies and SDK leftovers with their sizes, and cleans them all", async () => {
    const t = fs.mkdtempSync(path.join(ROOT, "tempdir-"));
    tree(path.join(t, "clearcote-live", "abc123"), 2000);
    tree(path.join(t, "clearcote-recover-x1"), 3000);
    tree(path.join(t, "clearcote-recover-x2"), 4000);
    fs.mkdirSync(path.join(t, "unrelated-folder"));
    const list = await cache.listTempCopies(t);
    expect(list.map((c) => [path.basename(c.path), c.kind, c.sizeBytes]).sort()).toEqual([
      ["abc123", "launch-copy", 2000],
      ["clearcote-recover-x1", "leftover", 3000],
      ["clearcote-recover-x2", "leftover", 4000],
    ]);
    expect(await cache.cleanTempCopies(t)).toEqual({ removed: 3, inUse: 0, freedBytes: 9000 });
    expect(await cache.listTempCopies(t)).toEqual([]);
    expect(fs.existsSync(path.join(t, "unrelated-folder"))).toBe(true); // never touched
  });

  it("purgeDeleting clears what an interrupted removal left behind", async () => {
    const r = fs.mkdtempSync(path.join(ROOT, "cacheroot-"));
    tree(path.join(r, "pro-1.0.0.0-r1.deleting-123"));
    tree(path.join(r, "pro-1.0.0.0-r2"));
    await cache.purgeDeleting(r);
    expect(fs.readdirSync(r)).toEqual(["pro-1.0.0.0-r2"]);
  });
});

describe("restoreBounds — reopen where it was, but only on a screen that exists", () => {
  const screens = [{ x: 0, y: 0, width: 1920, height: 1040 }];
  const limits = { minWidth: 900, minHeight: 600 };

  it("nothing saved → default size, centred", () => {
    expect(restoreBounds(undefined, screens, limits)).toEqual({ maximized: false });
  });
  it("a saved place on a present screen is reused", () => {
    expect(restoreBounds({ x: 100, y: 80, width: 1200, height: 800 }, screens, limits)).toEqual({
      bounds: { x: 100, y: 80, width: 1200, height: 800 },
      maximized: false,
    });
  });
  it("a window last used on an unplugged monitor opens centred instead of invisible", () => {
    expect(restoreBounds({ x: 2400, y: 100, width: 1200, height: 800 }, screens, limits)).toEqual({ maximized: false });
    expect(restoreBounds({ x: 100, y: -900, width: 1200, height: 800 }, screens, limits)).toEqual({ maximized: false });
  });
  it("mostly off the edge: pulled back fully onto the screen, and never bigger than it", () => {
    expect(restoreBounds({ x: 1500, y: 500, width: 1200, height: 800 }, screens, limits).bounds).toEqual({
      x: 720,
      y: 240,
      width: 1200,
      height: 800,
    });
    expect(restoreBounds({ x: 0, y: 0, width: 4000, height: 3000 }, screens, limits).bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
  });
  it("finds the right screen among several, and keeps maximised", () => {
    const two = [...screens, { x: 1920, y: 0, width: 2560, height: 1400 }];
    expect(restoreBounds({ x: 2000, y: 50, width: 1400, height: 900, maximized: true }, two, limits)).toEqual({
      bounds: { x: 2000, y: 50, width: 1400, height: 900 },
      maximized: true,
    });
  });
  it("never smaller than the app's minimum, and garbage is ignored", () => {
    expect(restoreBounds({ x: 10, y: 10, width: 200, height: 100 }, screens, limits).bounds).toMatchObject({ width: 900, height: 600 });
    expect(restoreBounds({ x: NaN, y: 0, width: 1, height: 1 } as never, screens, limits)).toEqual({ maximized: false });
  });
});
