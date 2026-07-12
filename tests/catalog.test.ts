// Browser-version catalog + resolution (electron/catalog.ts). Hermetic — the only network is a
// mocked `fetch`. Mirrors the clearcote SDK's version-selection matrix: latest / "150" / "149"
// across licensed (Pro) and unlicensed (free) callers.

import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchCatalog, listVersions, resolveVersion, type Catalog } from "../electron/catalog";

// A catalog with both platforms present so the test passes on Windows or Linux runners.
const CAT: Catalog = {
  schema: 1,
  builds: [
    {
      major: 149,
      version: "149.0.7827.114",
      tier: "free",
      tag: "v0.1.0-pre.21",
      platforms: {
        windows: { asset: "clearcote-149.0.7827.114-windows-x64.zip", url: "https://gh/149.zip", sha256: "a".repeat(64), archive: "zip", binary: "chrome.exe" },
        linux: { asset: "clearcote-149.0.7827.114-linux-x64.tar.xz", url: "https://gh/149.tar.xz", sha256: "b".repeat(64), archive: "tar.xz", binary: "chrome" },
      },
    },
    {
      major: 150,
      version: "150.0.7871.114",
      tier: "pro",
      tag: "pro-150.0.7871.114",
      platforms: {
        windows: { asset: "clearcote-pro-150.0.7871.114-windows-x64.zip", archive: "zip", binary: "chrome.exe" },
        linux: { asset: "clearcote-pro-150.0.7871.114-linux-x64.tar.xz", archive: "tar.xz", binary: "chrome" },
      },
    },
  ],
};

describe("resolveVersion — Pro (licensed) caller", () => {
  it("latest → newest overall (150 Pro)", () => {
    const r = resolveVersion(CAT, "latest", true);
    expect(r.tier).toBe("pro");
    expect(r.version).toBe("150.0.7871.114");
  });
  it("undefined defaults to latest → 150 Pro", () => {
    expect(resolveVersion(CAT, undefined, true).version).toBe("150.0.7871.114");
  });
  it('version="150" → 150 Pro', () => {
    const r = resolveVersion(CAT, "150", true);
    expect(r.tier).toBe("pro");
    expect(r.version).toBe("150.0.7871.114");
  });
  it('version="149" → 149 free', () => {
    const r = resolveVersion(CAT, "149", true);
    expect(r.tier).toBe("free");
    expect(r.version).toBe("149.0.7827.114");
  });
  it("exact version 150.0.7871.114 → 150 Pro", () => {
    expect(resolveVersion(CAT, "150.0.7871.114", true).version).toBe("150.0.7871.114");
  });
});

describe("resolveVersion — free (no license) caller", () => {
  it("latest → newest FREE (149), not the Pro-only 150", () => {
    const r = resolveVersion(CAT, "latest", false);
    expect(r.tier).toBe("free");
    expect(r.version).toBe("149.0.7827.114");
  });
  it('version="150" → BLOCKED with a "needs license" error (no broken download)', () => {
    expect(() => resolveVersion(CAT, "150", false)).toThrow(/PRO build/i);
  });
  it('version="149" → 149 free', () => {
    expect(resolveVersion(CAT, "149", false).version).toBe("149.0.7827.114");
  });
});

describe("resolveVersion — errors + platform routing", () => {
  it("unknown major → clear error listing what's available", () => {
    expect(() => resolveVersion(CAT, "148", true)).toThrow(/No build matches "148".*150 \(pro\).*149 \(free\)/s);
  });
  it("resolves the entry for the current OS (binary name matches the platform)", () => {
    const r = resolveVersion(CAT, "149", false);
    expect(["chrome", "chrome.exe"]).toContain(r.platform.binary);
    expect(r.platform.url).toBeTruthy();
  });
});

describe("listVersions", () => {
  it("returns this-OS builds newest-major first", () => {
    const v = listVersions(CAT);
    expect(v.map((x) => x.major)).toEqual([150, 149]);
    expect(v[0]).toMatchObject({ tier: "pro", version: "150.0.7871.114" });
  });
});

describe("fetchCatalog", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  it("GETs /api/v1/versions and returns the parsed catalog", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify(CAT), { status: 200 }));
    globalThis.fetch = spy as unknown as typeof fetch;
    const cat = await fetchCatalog("https://example.test");
    expect(cat.builds).toHaveLength(2);
    expect(String(spy.mock.calls[0][0])).toBe("https://example.test/api/v1/versions");
  });
  it("throws on a non-OK response", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchCatalog("https://example.test")).rejects.toThrow(/catalog fetch failed/i);
  });
});
