// electron/profiles.ts — recoverable delete (trash + undo + purge), launch bookkeeping that never
// clobbers an edit, safe ids, and an import that never overwrites. Real files in a temp dir.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-profiles-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

type Mod = typeof import("../electron/profiles");
let m: Mod;
const PROFILES = path.join(ROOT, "profiles");
const TRASH = path.join(PROFILES, ".trash");

beforeAll(async () => {
  m = await import("../electron/profiles");
});
afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});
beforeEach(() => {
  fs.rmSync(PROFILES, { recursive: true, force: true });
  fs.mkdirSync(PROFILES, { recursive: true });
});

const base = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, name: id, fingerprint: `seed-${id}`, createdAt: "", updatedAt: "", ...over }) as never;
/** A profile with some browser data on disk, like one that has been launched. */
function seed(id: string) {
  const p = m.saveProfile(base(id));
  const data = path.join(PROFILES, id, "userdata");
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, "Cookies"), "cookie-jar");
  return p;
}

describe("isSafeId — an id is one path segment", () => {
  it("accepts the ids the app generates", () => {
    for (const id of ["test-4dgg", "profile-byvr", "E2E_rail", "a.b", "shop 1"]) expect(m.isSafeId(id), id).toBe(true);
  });
  it("rejects traversal, separators, reserved characters and dot-names", () => {
    for (const id of ["", "..", ".", ".trash", "../x", "..\\..\\x", "a/b", "a\\b", "c:x", "a*b", 'a"b', "a" + String.fromCharCode(0) + "b", "x".repeat(121)]) {
      expect(m.isSafeId(id), JSON.stringify(id)).toBe(false);
    }
    expect(m.isSafeId(undefined)).toBe(false);
    expect(m.isSafeId(42)).toBe(false);
  });
  it("saveProfile refuses an unsafe id instead of writing outside the folder", () => {
    expect(() => m.saveProfile(base("../../escaped"))).toThrow(/Invalid profile id/);
    expect(fs.existsSync(path.join(ROOT, "..", "escaped.json"))).toBe(false);
  });
});

describe("trashProfile / restoreProfile — delete with undo", () => {
  it("moves the profile AND its browser data out of the list, and restores both", () => {
    seed("shop");
    const r = m.trashProfile("shop", 1_000);
    expect(r).toEqual({ ok: true, trashId: "shop__1000" });
    expect(m.listProfiles().map((p) => p.id)).toEqual([]); // gone from the list
    expect(fs.existsSync(path.join(PROFILES, "shop"))).toBe(false); // data moved, not deleted
    expect(fs.readFileSync(path.join(TRASH, "shop__1000", "data", "userdata", "Cookies"), "utf8")).toBe("cookie-jar");

    const back = m.restoreProfile("shop__1000");
    expect(back.ok).toBe(true);
    expect(m.listProfiles().map((p) => p.id)).toEqual(["shop"]);
    expect(fs.readFileSync(path.join(PROFILES, "shop", "userdata", "Cookies"), "utf8")).toBe("cookie-jar");
    expect(fs.existsSync(path.join(TRASH, "shop__1000"))).toBe(false);
  });

  it("works for a profile that was never launched (no data folder)", () => {
    m.saveProfile(base("fresh"));
    const r = m.trashProfile("fresh", 5);
    expect(r.ok).toBe(true);
    expect(m.restoreProfile("fresh__5").ok).toBe(true);
    expect(m.getProfile("fresh")?.fingerprint).toBe("seed-fresh");
  });

  it("the trash folder never shows up as a profile", () => {
    seed("a");
    m.trashProfile("a", 1);
    m.saveProfile(base("b"));
    expect(m.listProfiles().map((p) => p.id)).toEqual(["b"]);
  });

  it("refuses to restore over a profile that took the same id in the meantime", () => {
    seed("dup");
    m.trashProfile("dup", 7);
    m.saveProfile(base("dup", { name: "the new one" }));
    const r = m.restoreProfile("dup__7");
    expect(r.ok).toBe(false);
    expect(m.getProfile("dup")?.name).toBe("the new one"); // untouched
    expect(fs.existsSync(path.join(TRASH, "dup__7", "profile.json"))).toBe(true); // still recoverable
  });

  it("missing, unsafe and unknown ids are refused cleanly", () => {
    expect(m.trashProfile("nope")).toEqual({ ok: false, error: "That profile no longer exists." });
    expect(m.trashProfile("../x").ok).toBe(false);
    expect(m.restoreProfile("../../x__1").ok).toBe(false);
    expect(m.restoreProfile("never__1").ok).toBe(false);
    expect(m.restoreProfile("no-timestamp").ok).toBe(false);
  });

  // Windows will not rename a directory while a file inside it is open — exactly the situation
  // when a browser still has the profile's data. The delete must then change NOTHING.
  it.runIf(process.platform === "win32")("a data folder in use: nothing is lost, the profile stays put", () => {
    seed("busy");
    const fd = fs.openSync(path.join(PROFILES, "busy", "userdata", "Cookies"), "r+");
    try {
      const r = m.trashProfile("busy", 9);
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(/in use/);
      expect(m.getProfile("busy")?.id).toBe("busy");
      expect(fs.existsSync(path.join(PROFILES, "busy", "userdata", "Cookies"))).toBe(true);
      expect(fs.existsSync(path.join(TRASH, "busy__9"))).toBe(false);
    } finally {
      fs.closeSync(fd);
    }
  });
});

describe("purgeTrash", () => {
  it("removes entries past the undo window and keeps recent ones", () => {
    seed("old");
    seed("new");
    const now = 10 * 60 * 1000 + 50_000;
    m.trashProfile("old", 1_000); // older than TRASH_TTL_MS at `now`
    m.trashProfile("new", now - 5_000);
    expect(m.purgeTrash(m.TRASH_TTL_MS, now)).toEqual(["old__1000"]);
    expect(fs.readdirSync(TRASH)).toEqual([`new__${now - 5_000}`]);
  });
  it("no trash folder is not an error", () => {
    expect(m.purgeTrash()).toEqual([]);
  });
});

describe("markLaunched — launch bookkeeping", () => {
  it("sets lastLaunchedAt and leaves updatedAt alone", () => {
    const saved = m.saveProfile(base("p"));
    const out = m.markLaunched("p", "2026-09-22T10:00:00.000Z");
    expect(out?.lastLaunchedAt).toBe("2026-09-22T10:00:00.000Z");
    expect(m.getProfile("p")?.updatedAt).toBe(saved.updatedAt);
  });

  it("works on the profile AS SAVED NOW, so an edit made during a long first download survives", () => {
    m.saveProfile(base("p", { name: "before" }));
    // …the user edits and saves while the browser is downloading…
    m.saveProfile({ ...(m.getProfile("p") as object), name: "edited meanwhile" } as never);
    m.markLaunched("p");
    expect(m.getProfile("p")?.name).toBe("edited meanwhile");
  });

  it("a profile that does not exist (or an unsafe id) is a quiet null, never a throw", () => {
    expect(m.markLaunched("ghost")).toBeNull();
    expect(m.markLaunched("../x")).toBeNull();
  });
});

describe("importProfiles — never overwrites", () => {
  it("imports new ids as they are", () => {
    expect(m.importProfiles([base("i1"), base("i2")])).toEqual({ count: 2, renamed: 0 });
    expect(m.listProfiles().map((p) => p.id).sort()).toEqual(["i1", "i2"]);
  });

  it("a taken id gets a fresh one and the existing profile is untouched", () => {
    m.saveProfile(base("mine", { name: "keep me" }));
    const r = m.importProfiles([base("mine", { name: "Imported" })]);
    expect(r).toEqual({ count: 1, renamed: 1 });
    expect(m.getProfile("mine")?.name).toBe("keep me");
    const other = m.listProfiles().find((p) => p.id !== "mine");
    expect(other?.name).toBe("Imported");
    expect(other?.id).toMatch(/^imported-[a-z0-9]{1,4}$/);
  });

  it("an unsafe id cannot write outside the folder — it gets a fresh id", () => {
    const r = m.importProfiles([base("..\\..\\evil", { name: "Evil" })]);
    expect(r).toEqual({ count: 1, renamed: 1 });
    expect(fs.existsSync(path.join(ROOT, "evil.json"))).toBe(false);
    expect(m.listProfiles()[0].id).toMatch(/^evil-/);
  });

  it("skips entries that are not profiles, and a missing id is fresh without counting as renamed", () => {
    const r = m.importProfiles([null, 7, { name: "no seed" }, { name: "No id", fingerprint: "s" }]);
    expect(r).toEqual({ count: 1, renamed: 0 });
    expect(m.listProfiles()[0].id).toMatch(/^no-id-/);
  });
});
