// Browser-version catalog + resolution (electron/catalog.ts). Hermetic — the only network is a
// mocked `fetch`. Mirrors the clearcote SDK's version-selection matrix: latest / "150" / "149"
// across licensed (Pro) and unlicensed (free) callers.

import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchCatalog, fetchProRevisions, listVersions, resolveVersion, type Catalog } from "../electron/catalog";

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

// The public /versions catalog carries ONE entry per major with no revision, while the PRO
// download route publishes several rebuilds behind the same version (verified live: r10, r9, r3).
// So a revision pin has to be split off, matched against the plain version, and carried through to
// /download/pro?version= as a SELECTOR — otherwise "150.0.7871.114-r9" either fails to resolve or
// silently downgrades to whatever the current pin happens to be.
describe("resolveVersion — PRO revision pinning", () => {
  it("version-qualified pin resolves and carries the revision in the selector", () => {
    const r = resolveVersion(CAT, "150.0.7871.114-r9", true);
    expect(r.version).toBe("150.0.7871.114");
    expect(r.revision).toBe("r9");
    expect(r.selector).toBe("150.0.7871.114-r9");
  });
  it("a bare revision pins the newest PRO build at that rebuild", () => {
    const r = resolveVersion(CAT, "r3", true);
    expect(r.tier).toBe("pro");
    expect(r.selector).toBe("150.0.7871.114-r3");
  });
  it("the cache tag is revision-distinct, so two revisions never share an extracted tree", () => {
    expect(resolveVersion(CAT, "150.0.7871.114-r9", true).tag).toBe("pro-150.0.7871.114-r9");
    expect(resolveVersion(CAT, "150.0.7871.114-r3", true).tag).toBe("pro-150.0.7871.114-r3");
    expect(resolveVersion(CAT, "150", true).tag).toBe("pro-150.0.7871.114");
  });
  it("a major + revision works too", () =>
    expect(resolveVersion(CAT, "150-r10", true).selector).toBe("150.0.7871.114-r10"));
  it("an unlicensed caller is still blocked (revisions are PRO-only)", () =>
    expect(() => resolveVersion(CAT, "150.0.7871.114-r9", false)).toThrow(/PRO build/i));
  it("pinning a revision on a FREE build is refused, not silently ignored", () =>
    expect(() => resolveVersion(CAT, "149.0.7827.114-r3", true)).toThrow(/only for PRO rebuilds/i));
  it("selector falls back to the plain version when nothing is pinned", () => {
    const r = resolveVersion(CAT, "150", true);
    expect(r.selector).toBe("150.0.7871.114");
    expect(r.revision).toBeUndefined();
  });
  it("a plain version is unaffected by the revision parsing", () => {
    expect(resolveVersion(CAT, "150.0.7871.114", true).selector).toBe("150.0.7871.114");
    expect(resolveVersion(CAT, "latest", true).revision).toBeUndefined();
  });
});

describe("fetchProRevisions", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  it("reads the selector list off the route's 404 body (its only enumeration channel)", async () => {
    const available = ["150.0.7871.114-r10", "150.0.7871.114-r9", "150.0.7871.114-r3"];
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "no", code: "PRO_VERSION_NOT_FOUND", available }), { status: 404 }),
    ) as unknown as typeof fetch;
    expect(await fetchProRevisions("cc_lic_x", "https://example.test")).toEqual(available);
  });
  it("no license key → no request at all (revisions are PRO-only)", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    expect(await fetchProRevisions(undefined, "https://example.test")).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
  it("is best-effort — a network failure or junk body degrades to []", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchProRevisions("cc_lic_x")).toEqual([]);
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchProRevisions("cc_lic_x")).toEqual([]);
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
