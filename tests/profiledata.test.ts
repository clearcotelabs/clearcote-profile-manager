// electron/profiles.ts additions — the exit place kept on the profile, group rename, export with or
// without secrets, and clearing a profile's cache without signing it out. Real files, temp dir.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-profdata-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

let m: typeof import("../electron/profiles");
const PROFILES = path.join(ROOT, "profiles");
beforeAll(async () => {
  m = await import("../electron/profiles");
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
beforeEach(() => {
  fs.rmSync(PROFILES, { recursive: true, force: true });
  fs.mkdirSync(PROFILES, { recursive: true });
});

const base = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, name: id, fingerprint: `seed-${id}`, createdAt: "", updatedAt: "", ...over }) as never;

describe("recordGeo", () => {
  it("keeps the exit place and the proxy it was measured through (no credentials), and nothing else changes", () => {
    const saved = m.saveProfile(base("p", { proxy: "http://alice:s3cret@de1.example.net:8080" }));
    const out = m.recordGeo(
      "p",
      { ok: true, ip: "198.51.100.4", country: "Germany", countryCode: "DE", city: "Berlin" },
      "http://alice:s3cret@de1.example.net:8080",
      "2026-09-22T10:00:00.000Z",
    );
    expect(out?.lastGeo).toEqual({
      ip: "198.51.100.4",
      country: "Germany",
      countryCode: "DE",
      city: "Berlin",
      at: "2026-09-22T10:00:00.000Z",
      proxy: "http de1.example.net:8080",
    });
    const disk = m.getProfile("p")!;
    expect(disk.updatedAt).toBe(saved.updatedAt);
    expect(JSON.stringify(disk.lastGeo)).not.toMatch(/alice|s3cret/);
  });
  it("a failed lookup, an unknown profile or an unsafe id change nothing", () => {
    m.saveProfile(base("p"));
    expect(m.recordGeo("p", { ok: false }, "h:1")).toBeNull();
    expect(m.getProfile("p")?.lastGeo).toBeUndefined();
    expect(m.recordGeo("ghost", { ok: true, countryCode: "DE" }, "h:1")).toBeNull();
    expect(m.recordGeo("../x", { ok: true, countryCode: "DE" }, "h:1")).toBeNull();
  });
  it("proxyKey matches what the card compares against (profileList.proxySummary)", async () => {
    const { proxySummary } = await import("../src/lib/profileList");
    for (const px of ["http://u:p@h.example:8080", "socks5://h:1080", "h.example:3128"]) expect(m.proxyKey(px)).toBe(proxySummary(px));
    expect(m.proxyKey(undefined)).toBe("");
  });
});

describe("renameGroup", () => {
  it("renames every profile in the group, matched the way the list groups them, and leaves updatedAt", () => {
    const a = m.saveProfile(base("a", { group: "Work" }));
    m.saveProfile(base("b", { group: " work " }));
    m.saveProfile(base("c", { group: "Home" }));
    m.saveProfile(base("d"));
    expect(m.renameGroup("WORK", "Clients")).toBe(2);
    expect(["a", "b", "c", "d"].map((id) => m.getProfile(id)?.group)).toEqual(["Clients", "Clients", "Home", undefined]);
    expect(m.getProfile("a")?.updatedAt).toBe(a.updatedAt);
  });
  it("renaming to nothing takes them out of any group", () => {
    m.saveProfile(base("a", { group: "Work" }));
    expect(m.renameGroup("work", "   ")).toBe(1);
    expect("group" in (m.getProfile("a") as object)).toBe(false);
  });
  it("an empty source matches nothing (not the ungrouped profiles)", () => {
    m.saveProfile(base("a"));
    expect(m.renameGroup("", "X")).toBe(0);
    expect(m.getProfile("a")?.group).toBeUndefined();
  });
});

describe("exportList", () => {
  const list = [base("a", { proxy: "http://alice:s3cret@h.example:8080", encryptionKey: "k3y" }), base("b")] as never[];
  it("leaves out proxy passwords and encryption keys by default", () => {
    const out = m.exportList(list);
    expect(JSON.stringify(out)).not.toMatch(/s3cret|k3y/);
    expect(out[0].proxy).toMatch(/h\.example:8080/);
    expect(out[0]).not.toHaveProperty("encryptionKey");
  });
  it("keeps them only when asked — and never mutates the saved profiles", () => {
    expect(JSON.stringify(m.exportList(list, { includeSecrets: true }))).toMatch(/alice:s3cret.*k3y/);
    m.exportList(list);
    expect((list[0] as { encryptionKey?: string }).encryptionKey).toBe("k3y");
  });
});

describe("clearBrowsingCache — signed in afterwards", () => {
  /** A user-data dir laid out like Chromium's: two Chromium profiles plus shared caches. */
  function chromiumDir(): string {
    const udd = fs.mkdtempSync(path.join(ROOT, "udd-"));
    const put = (rel: string, bytes = 100) => {
      fs.mkdirSync(path.dirname(path.join(udd, rel)), { recursive: true });
      fs.writeFileSync(path.join(udd, rel), Buffer.alloc(bytes));
    };
    for (const prof of ["Default", "Profile 1"]) {
      put(`${prof}/Preferences`, 10);
      put(`${prof}/Cookies`, 10);
      put(`${prof}/Login Data`, 10);
      put(`${prof}/Local Storage/leveldb/000003.log`, 10);
      put(`${prof}/IndexedDB/https_x.indexeddb.leveldb/LOG`, 10);
      put(`${prof}/History`, 10);
      put(`${prof}/Cache/Cache_Data/data_0`, 1000);
      put(`${prof}/Code Cache/js/index`, 500);
      put(`${prof}/GPUCache/data_1`, 200);
      put(`${prof}/Service Worker/CacheStorage/abc/index`, 300);
      put(`${prof}/Service Worker/Database/LOG`, 10); // registrations — kept
    }
    put("GrShaderCache/data_0", 400);
    put("ShaderCache/data_0", 50);
    put("Local State", 10);
    put("NotAProfile/Cache/data", 999); // no Preferences here: left alone
    return udd;
  }

  it("removes the caches, keeps cookies, logins, site storage and history, and reports what it freed", async () => {
    const udd = chromiumDir();
    const freed = await m.clearBrowsingCache(udd);
    expect(freed).toBe(2 * (1000 + 500 + 200 + 300) + 400 + 50);
    for (const prof of ["Default", "Profile 1"]) {
      for (const kept of ["Preferences", "Cookies", "Login Data", "Local Storage", "IndexedDB", "History", "Service Worker/Database"]) {
        expect(fs.existsSync(path.join(udd, prof, kept)), `${prof}/${kept}`).toBe(true);
      }
      for (const gone of ["Cache", "Code Cache", "GPUCache", "Service Worker/CacheStorage"]) {
        expect(fs.existsSync(path.join(udd, prof, gone)), `${prof}/${gone}`).toBe(false);
      }
    }
    expect(fs.existsSync(path.join(udd, "Local State"))).toBe(true);
    expect(fs.existsSync(path.join(udd, "GrShaderCache"))).toBe(false);
    expect(fs.existsSync(path.join(udd, "NotAProfile", "Cache"))).toBe(true);
    expect(await m.clearBrowsingCache(udd)).toBe(0); // nothing left to clear
  });

  it("a missing folder frees nothing and does not throw", async () => {
    expect(await m.clearBrowsingCache(path.join(ROOT, "nope"))).toBe(0);
  });

  it("dirSizeAsync adds up a tree", async () => {
    const udd = chromiumDir();
    const total = await m.dirSizeAsync(udd);
    expect(total).toBe(2 * (10 * 5 + 10 + 1000 + 500 + 200 + 300 + 10) + 400 + 50 + 10 + 999);
  });

  it("userDataDirOf: the profile's own setting wins", () => {
    expect(m.userDataDirOf({ id: "a", userDataDir: "D:\\x" })).toBe("D:\\x");
    expect(m.userDataDirOf({ id: "a" })).toBe(path.join(PROFILES, "a", "userdata"));
  });
});
