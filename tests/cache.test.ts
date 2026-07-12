// Downloaded-browser cache management (electron/cache.ts). Hermetic — uses a temp CLEARCOTE_CACHE.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCached, removeCached } from "../electron/cache";

describe("downloaded-browser cache", () => {
  let dir: string;
  const OLD = process.env.CLEARCOTE_CACHE;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-cache-"));
    process.env.CLEARCOTE_CACHE = dir; // cacheRoot() honors this first
    for (const [tag, bytes] of [["pro-150.0.7871.114", 1500] as const, ["v0.1.0-pre.21", 800] as const]) {
      const b = join(dir, tag, "browser");
      mkdirSync(b, { recursive: true });
      writeFileSync(join(b, "chrome"), Buffer.alloc(bytes));
      writeFileSync(join(dir, tag, ".verified"), "hash\n");
    }
    // a partial dir (no .verified) that must NOT be listed as a usable build
    mkdirSync(join(dir, "pro-partial", "browser"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (OLD === undefined) delete process.env.CLEARCOTE_CACHE;
    else process.env.CLEARCOTE_CACHE = OLD;
  });

  it("lists verified builds with tier + version + size (pro first), skipping partials", () => {
    const list = listCached();
    expect(list.map((b) => b.tag)).toEqual(["pro-150.0.7871.114", "v0.1.0-pre.21"]);
    expect(list[0]).toMatchObject({ tier: "pro", version: "150.0.7871.114" });
    expect(list[1]).toMatchObject({ tier: "free", version: "v0.1.0-pre.21" });
    expect(list[0].sizeBytes).toBeGreaterThanOrEqual(1500);
    expect(list.some((b) => b.tag === "pro-partial")).toBe(false);
  });

  it("removeCached deletes the build so the next launch re-downloads it", () => {
    expect(removeCached("pro-150.0.7871.114")).toBe(true);
    expect(existsSync(join(dir, "pro-150.0.7871.114"))).toBe(false);
    expect(listCached().map((b) => b.tag)).toEqual(["v0.1.0-pre.21"]);
  });

  it("removeCached returns false for a missing tag and rejects path traversal", () => {
    expect(removeCached("nope-tag")).toBe(false);
    expect(() => removeCached("../evil")).toThrow(/invalid/i);
    expect(() => removeCached("a/b")).toThrow(/invalid/i);
    expect(() => removeCached("a\\b")).toThrow(/invalid/i);
  });

  it("returns [] when the cache root does not exist", () => {
    process.env.CLEARCOTE_CACHE = join(dir, "does-not-exist");
    expect(listCached()).toEqual([]);
  });
});
