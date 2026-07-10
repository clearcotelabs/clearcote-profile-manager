// PRO licensing client (electron/license.ts) + pro-binary fetch (electron/proBinary.ts).
// Hermetic — the only network is a mocked `fetch`. Mirrors the clearcote SDK's tests.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveLicenseKey,
  acquireLease,
  checkLicense,
  withRunToken,
  planFromToken,
} from "../electron/license";
import { proEnsureBinary } from "../electron/proBinary";

describe("resolveLicenseKey (explicit > env > file)", () => {
  const OLD = process.env.CLEARCOTE_LICENSE_KEY;
  afterEach(() => {
    if (OLD === undefined) delete process.env.CLEARCOTE_LICENSE_KEY;
    else process.env.CLEARCOTE_LICENSE_KEY = OLD;
  });

  it("prefers an explicit key and trims it", () => {
    process.env.CLEARCOTE_LICENSE_KEY = "cc_lic_from_env";
    expect(resolveLicenseKey("  cc_lic_explicit  ")).toBe("cc_lic_explicit");
  });

  it("falls back to CLEARCOTE_LICENSE_KEY when no (or blank) explicit key", () => {
    process.env.CLEARCOTE_LICENSE_KEY = "cc_lic_from_env";
    expect(resolveLicenseKey()).toBe("cc_lic_from_env");
    expect(resolveLicenseKey("   ")).toBe("cc_lic_from_env");
  });
});

describe("free mode is inert (no key => no backend contact)", () => {
  const OLD = process.env.CLEARCOTE_LICENSE_KEY;
  afterEach(() => {
    if (OLD === undefined) delete process.env.CLEARCOTE_LICENSE_KEY;
    else process.env.CLEARCOTE_LICENSE_KEY = OLD;
    vi.restoreAllMocks();
  });

  it("acquireLease returns null and never calls fetch without a key", async () => {
    delete process.env.CLEARCOTE_LICENSE_KEY;
    const spy = vi.spyOn(globalThis, "fetch");
    const lease = await acquireLease({});
    expect(lease).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("checkLicense reports no key without hitting the network", async () => {
    delete process.env.CLEARCOTE_LICENSE_KEY;
    const spy = vi.spyOn(globalThis, "fetch");
    const st = await checkLicense();
    expect(st.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("withRunToken + planFromToken", () => {
  it("injects CLEARCOTE_RUN_TOKEN over a base env", () => {
    const env = withRunToken("tok123", { FOO: "bar" });
    expect(env.CLEARCOTE_RUN_TOKEN).toBe("tok123");
    expect(env.FOO).toBe("bar");
  });

  it("decodes the plan claim from a base64url payload", () => {
    const payload = Buffer.from(JSON.stringify({ plan: "pro", lic: "x" })).toString("base64url");
    expect(planFromToken(`${payload}.sig`)).toBe("pro");
    expect(planFromToken("not-a-token")).toBeUndefined();
  });
});

describe("acquireLease with a key surfaces a definitive backend verdict", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("throws ConcurrencyLimitError on 429 (never silently downgrades)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "limit", code: "CONCURRENCY_LIMIT_EXCEEDED" }), { status: 429 }),
    ) as unknown as typeof fetch;
    await expect(acquireLease({ licenseKey: "cc_lic_x", quiet: true })).rejects.toMatchObject({
      code: "CONCURRENCY_LIMIT_EXCEEDED",
    });
  });
});

describe("proEnsureBinary (license-gated download)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("surfaces an auth failure instead of falling back to the free binary", async () => {
    globalThis.fetch = vi.fn(async () => new Response("Invalid license key.", { status: 401 })) as unknown as typeof fetch;
    await expect(proEnsureBinary("cc_lic_bad", "https://example.test")).rejects.toThrow(/not authorized \(HTTP 401\)/);
  });

  it("throws when the server returns no download URL", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ version: "149.0.0.0" }), { status: 200 })) as unknown as typeof fetch;
    await expect(proEnsureBinary("cc_lic_ok", "https://example.test")).rejects.toThrow(/No PRO build/);
  });

  it("requests the authenticated /api/v1/download/pro route with a Bearer token", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await expect(proEnsureBinary("cc_lic_probe", "https://example.test")).rejects.toThrow();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/^https:\/\/example\.test\/api\/v1\/download\/pro\?platform=(windows|linux)$/);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer cc_lic_probe");
  });
});
