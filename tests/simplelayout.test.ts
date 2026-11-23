// The Simple editor's layout (0.43): a name and a proxy first, the identity line, and the rest of the
// essentials under "More options" — folded until one of them differs from a new profile, so nothing
// you set is ever out of sight. Plus the help links into the Profile Manager guide.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect, vi } from "vitest";
import {
  CATEGORIES,
  ESSENTIAL_KEYS,
  IDENTITY_KEY,
  PRIMARY_KEYS,
  essentialFields,
  fieldByKey,
  isPrimary,
  moreOptionFields,
  moreOptionsSet,
  setOutsideEssentials,
} from "../src/lib/fields";
import { newProfile } from "../src/lib/newProfile";
import { GUIDE_SECTIONS, PM_GUIDE_URL, guideUrl } from "../src/lib/docsLinks";

// electron/handlers.ts (the URL allowlist) reads the app's data folder when it loads: a throwaway one.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-simplelayout-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const fresh = (platform: "windows" | "macos" = "windows") =>
  newProfile("seed", "2026-11-23T00:00:00Z", platform) as unknown as Record<string, unknown>;

describe("Simple: what comes first", () => {
  it("asks for a name and a proxy, then the identity line", () => {
    expect([...PRIMARY_KEYS]).toEqual(["name", "proxy"]);
    expect(ESSENTIAL_KEYS.slice(0, 3)).toEqual(["name", "proxy", "fingerprintProfile"]);
    expect(IDENTITY_KEY).toBe("fingerprintProfile");
    expect(isPrimary("name")).toBe(true);
    expect(isPrimary("proxy")).toBe(true);
    expect(isPrimary("fingerprintProfile")).toBe(false);
    expect(isPrimary("platform")).toBe(false);
    // Every essential key is a real field (a typo would silently drop it from Simple).
    for (const k of ESSENTIAL_KEYS) expect(fieldByKey(k), k).toBeTruthy();
  });

  it("folds every other essential under More options, in order", () => {
    expect(moreOptionFields().map((f) => f.key)).toEqual([
      "platform",
      "group",
      "tags",
      "notes",
      "startUrl",
      "screenWidth",
      "screenHeight",
      "availWidth",
      "availHeight",
    ]);
    // Primary + identity + More options is exactly the essentials, nothing lost or shown twice.
    const parts = [...PRIMARY_KEYS, IDENTITY_KEY, ...moreOptionFields().map((f) => f.key)];
    expect([...parts].sort()).toEqual(essentialFields().map((f) => f.key).sort());
  });
});

describe("Simple: when More options opens by itself", () => {
  it("stays closed for a new profile on Windows and on a Mac", () => {
    expect(moreOptionsSet(fresh("windows"), "windows")).toBe(0);
    expect(moreOptionsSet(fresh("macos"), "macos")).toBe(0);
  });

  it("does not count what Simple shows outside the fold", () => {
    const p = { ...fresh(), name: "Shop 1", proxy: "http://u:p@h.example:8080", fingerprintProfile: "lib/x.json" };
    expect(moreOptionsSet(p, "windows")).toBe(0);
  });

  it("counts a platform other than this computer's", () => {
    expect(moreOptionsSet(fresh("windows"), "macos")).toBe(1);
    expect(moreOptionsSet({ ...fresh(), platform: "android" }, "windows")).toBe(1);
  });

  it("counts each value you typed", () => {
    expect(moreOptionsSet({ ...fresh(), startUrl: "https://example.com" }, "windows")).toBe(1);
    expect(moreOptionsSet({ ...fresh(), group: "Shops", notes: "x" }, "windows")).toBe(2);
    expect(moreOptionsSet({ ...fresh(), tags: ["us"] }, "windows")).toBe(1);
    expect(moreOptionsSet({ ...fresh(), screenWidth: 1920, screenHeight: 1080 }, "windows")).toBe(2);
  });

  it("does not count empty values", () => {
    expect(moreOptionsSet({ ...fresh(), tags: [], group: "", notes: undefined, startUrl: "" }, "windows")).toBe(0);
  });

  it("an old profile without a platform is not a choice", () => {
    const { platform: _p, ...old } = fresh();
    expect(moreOptionsSet(old, "windows")).toBe(0);
  });
});

describe("Simple: the 'set in All settings' note", () => {
  it("no longer counts a real computer from the library, which Simple now shows", () => {
    expect(setOutsideEssentials({ ...fresh(), fingerprintProfile: "lib/x.json" })).toBe(0);
    // Still counts what Simple does not show.
    expect(setOutsideEssentials({ ...fresh(), deviceMemory: 8 })).toBe(1);
  });
});

describe("help links into the Profile Manager guide", () => {
  it("has a section for Simple and for every category of All settings", () => {
    for (const c of CATEGORIES) expect(GUIDE_SECTIONS[c.id as keyof typeof GUIDE_SECTIONS], c.id).toBeTruthy();
    expect(GUIDE_SECTIONS.simple).toBe("create");
    const ids = Object.values(GUIDE_SECTIONS);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("points at the docs page, which the desktop app and the web version may open", async () => {
    const { ALLOWED_EXTERNAL } = await import("../electron/handlers");
    expect(PM_GUIDE_URL).toBe("https://www.clearcotelabs.com/docs/profile-manager");
    for (const part of Object.keys(GUIDE_SECTIONS) as (keyof typeof GUIDE_SECTIONS)[]) {
      const url = guideUrl(part);
      expect(url).toBe(`${PM_GUIDE_URL}#${GUIDE_SECTIONS[part]}`);
      expect(ALLOWED_EXTERNAL.some((re) => re.test(url)), url).toBe(true);
    }
  });
});
