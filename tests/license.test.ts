// PRO licensing client (electron/license.ts) + pro-binary fetch (electron/proBinary.ts).
// Hermetic — the only network is a mocked `fetch`. Mirrors the clearcote SDK's tests.

import { describe, it, expect, vi, afterEach, beforeEach, afterAll } from "vitest";
import {
  resolveLicenseKey,
  acquireLease,
  checkLicense,
  withRunToken,
  planFromToken,
} from "../electron/license";
import { proEnsureBinary } from "../electron/proBinary";

/** Every isolated HOME the tests below make — removed when the file finishes, rather than being left
 *  in %TEMP% on every run as they used to be. */
const HOMES: string[] = [];
afterAll(async () => {
  const { rmSync } = await import("node:fs");
  for (const h of HOMES) rmSync(h, { recursive: true, force: true });
});

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
  const OLD = { key: process.env.CLEARCOTE_LICENSE_KEY, home: process.env.HOME, prof: process.env.USERPROFILE };
  // "No key" means no env key AND no ~/.clearcote/license.key. A developer machine has that file, so
  // point HOME at an empty dir — otherwise these tests silently assert the opposite of their name.
  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "pm-nokey-"));
    HOMES.push(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries({ CLEARCOTE_LICENSE_KEY: OLD.key, HOME: OLD.home, USERPROFILE: OLD.prof })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
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

  it("an empty selector (\"latest\") sends no version parameter at all", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await expect(proEnsureBinary("cc_lic_probe", "https://example.test", "")).rejects.toThrow();
    expect(String(spy.mock.calls[0][0])).not.toContain("version=");
  });

  it("a free licence hitting a pinned profile gets an actionable message, not raw JSON", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "The free tier always uses the latest build.", code: "FREE_LATEST_ONLY" }), { status: 403 }),
    ) as unknown as typeof fetch;
    await expect(proEnsureBinary("cc_lic_free", "https://example.test", "151.0.7922.108-r18")).rejects.toThrow(
      /pinned to Clearcote 151\.0\.7922\.108-r18.*set Browser version to "Latest"/,
    );
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

describe("per-browser leases (the GitHub free tier)", () => {
  const OLD = { key: process.env.CLEARCOTE_LICENSE_KEY, home: process.env.HOME, prof: process.env.USERPROFILE };
  afterEach(() => {
    for (const [k, v] of Object.entries({ CLEARCOTE_LICENSE_KEY: OLD.key, HOME: OLD.home, USERPROFILE: OLD.prof })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  const tok = (plan: string) => Buffer.from(JSON.stringify({ v: 1, plan })).toString("base64url") + ".sig";

  async function isolatedHome() {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "pm-perbrowser-"));
    HOMES.push(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    return home;
  }

  function fakeBackend(plan: string) {
    const bodies: Record<string, unknown>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown, init?: RequestInit) => {
      const ep = String(url).split("/").pop();
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (ep === "checkout") {
        bodies.push(body);
        return new Response(JSON.stringify({ lease_id: `L${bodies.length}`, token: tok(plan), exp: Math.floor(Date.now() / 1000) + 900, lease_ttl_sec: 360, heartbeat_interval_sec: 3600, concurrency: { used: 1, limit: 1 }, lease_scope: plan === "free" ? "browser" : undefined }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    return bodies;
  }

  it("every launch sends its own launch_id (and the Settings key check sends one too)", async () => {
    await isolatedHome();
    process.env.CLEARCOTE_LICENSE_KEY = "cc_lic_pm_free_1";
    const bodies = fakeBackend("free");
    const a = await acquireLease({});
    const b = await acquireLease({});
    await checkLicense();
    expect(bodies).toHaveLength(3);
    for (const x of bodies) expect(String(x.launch_id)).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(new Set(bodies.map((x) => x.launch_id)).size).toBe(3);
    await a?.stop();
    await b?.stop();
  });

  it("a free token is never written to the offline cache, and never used for offline grace", async () => {
    const home = await isolatedHome();
    const { existsSync, readdirSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const key = "cc_lic_pm_free_2";
    process.env.CLEARCOTE_LICENSE_KEY = key;
    fakeBackend("free");
    const a = await acquireLease({});
    await a?.stop();
    const dir = join(home, ".clearcote");
    expect(existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("lease-")) : []).toEqual([]);

    // an older build's cached free token must not start a browser while the backend is unreachable
    mkdirSync(dir, { recursive: true });
    const id = createHash("sha256").update(key).digest("hex").slice(0, 16);
    writeFileSync(join(dir, `lease-${id}.json`), JSON.stringify({ token: tok("free"), exp: Math.floor(Date.now() / 1000) + 800 }));
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(acquireLease({ quiet: true })).rejects.toThrow(/Could not reach the license server/);
  });

  it("a paid token still gets written to the cache and keeps its offline grace", async () => {
    await isolatedHome();
    process.env.CLEARCOTE_LICENSE_KEY = "cc_lic_pm_paid_1";
    fakeBackend("pro");
    const a = await acquireLease({});
    await a?.stop();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const offline = await acquireLease({ quiet: true });
    expect(offline?.token).toBe(tok("pro"));
  });
});

// The engine (152 r23+) refuses a FREE launch that carries no CLEARCOTE_RUN_TOKEN_FILE, and stops a
// running free browser once the file stops advancing. These cover the manager's half of that
// contract: bind a file per launch, follow every rotation into it, and remove it when the browser
// closes — so a stale file can never keep a browser alive after the slot is gone.
describe("per-launch run-token files (engine online enforcement)", () => {
  const OLD = { key: process.env.CLEARCOTE_LICENSE_KEY, home: process.env.HOME, prof: process.env.USERPROFILE };
  afterEach(() => {
    for (const [k, v] of Object.entries({ CLEARCOTE_LICENSE_KEY: OLD.key, HOME: OLD.home, USERPROFILE: OLD.prof })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  const tok = (plan: string, n = 0) =>
    Buffer.from(JSON.stringify({ v: 1, plan, iat: 1000 + n })).toString("base64url") + ".sig";

  async function isolatedHome() {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "pm-tokenfile-"));
    HOMES.push(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  }

  /** A backend whose heartbeat hands back a strictly newer token each time. */
  function rotatingBackend(plan: string) {
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const ep = String(url).split("/").pop();
      const exp = Math.floor(Date.now() / 1000) + 900;
      if (ep === "checkout")
        return new Response(JSON.stringify({ lease_id: "L1", token: tok(plan, 0), exp, lease_ttl_sec: 360, heartbeat_interval_sec: 3600, concurrency: { used: 1, limit: 1 } }), { status: 200 });
      if (ep === "heartbeat")
        return new Response(JSON.stringify({ token: tok(plan, ++n), exp }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
  }

  it("binds a file seeded with the current token, and withRunToken points the engine at it", async () => {
    await isolatedHome();
    process.env.CLEARCOTE_LICENSE_KEY = "cc_lic_pm_tf_1";
    rotatingBackend("free");
    const { readFileSync, existsSync } = await import("node:fs");
    const lease = await acquireLease({});
    const bound = lease!.bindLaunch();
    expect(readFileSync(bound.path, "utf8")).toBe(tok("free", 0));

    const env = withRunToken(lease!.token, { FOO: "bar" }, bound.path);
    expect(env.CLEARCOTE_RUN_TOKEN_FILE).toBe(bound.path);
    expect(env.CLEARCOTE_RUN_TOKEN).toBe(tok("free", 0));
    expect(env.FOO).toBe("bar");

    bound.release();
    expect(existsSync(bound.path)).toBe(false);
    await lease!.stop();
  });

  it("omits the file variable when no file is bound (an unsupported caller stays as it was)", () => {
    expect(withRunToken("tok123", {}).CLEARCOTE_RUN_TOKEN_FILE).toBeUndefined();
  });

  it("every bound file gets the rotated token, and each launch gets its own path", async () => {
    await isolatedHome();
    process.env.CLEARCOTE_LICENSE_KEY = "cc_lic_pm_tf_2";
    // A 5s heartbeat (the floor) so one real tick lands inside the test instead of an hour later.
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
      const ep = String(url).split("/").pop();
      const exp = Math.floor(Date.now() / 1000) + 900;
      if (ep === "checkout")
        return new Response(JSON.stringify({ lease_id: "L1", token: tok("free", 0), exp, lease_ttl_sec: 360, heartbeat_interval_sec: 1, concurrency: { used: 1, limit: 1 } }), { status: 200 });
      if (ep === "heartbeat")
        return new Response(JSON.stringify({ token: tok("free", ++n), exp }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const { readFileSync } = await import("node:fs");
    const lease = await acquireLease({});
    const a = lease!.bindLaunch();
    const b = lease!.bindLaunch();
    expect(a.path).not.toBe(b.path);
    expect(readFileSync(a.path, "utf8")).toBe(tok("free", 0));

    // Wait for one real heartbeat, then assert BOTH files carry the rotated token — the engine's
    // liveness check is exactly "did this file's token advance", so a file left behind is a bug.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && readFileSync(a.path, "utf8") === tok("free", 0)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const advanced = readFileSync(a.path, "utf8");
    expect(advanced).not.toBe(tok("free", 0));
    expect(readFileSync(b.path, "utf8")).toBe(advanced);
    expect(lease!.token).toBe(advanced);

    a.release();
    b.release();
    await lease!.stop();
  }, 20_000);

  it("stop() removes every file this lease bound (no stale token survives the lease)", async () => {
    await isolatedHome();
    process.env.CLEARCOTE_LICENSE_KEY = "cc_lic_pm_tf_3";
    rotatingBackend("free");
    const { existsSync } = await import("node:fs");
    const lease = await acquireLease({});
    const a = lease!.bindLaunch();
    const b = lease!.bindLaunch();
    expect(existsSync(a.path) && existsSync(b.path)).toBe(true);
    await lease!.stop();
    expect(existsSync(a.path) || existsSync(b.path)).toBe(false);
  });
});

// ── heartbeat 409: reclaimed/expired -> re-checkout ─────────────────────────────────────────────────
// The backend answers a heartbeat for a lease it no longer holds with 409 (LEASE_NOT_FOUND / LEASE_EXPIRED);
// the app must re-checkout, as the SAME launch, to keep the browser's slot. Mirrors the SDKs' tests.
describe("lease heartbeat 409 recovery", () => {
  const OLD = { home: process.env.HOME, prof: process.env.USERPROFILE };
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries({ HOME: OLD.home, USERPROFILE: OLD.prof })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function isolatedHome() {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "pm-hb409-"));
    HOMES.push(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  }

  type Step = [endpoint: string, status: number, answer: unknown];
  /** The first checkout gets L1 (30 s beats); after that, heartbeat/checkout answers come from `script` in order. */
  function scripted(script: Step[]) {
    const calls: { ep: string; body: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown, init?: RequestInit) => {
      const ep = String(url).split("/").pop()!;
      calls.push({ ep, body: init?.body ? JSON.parse(String(init.body)) : {} });
      const now = Math.floor(Date.now() / 1000);
      if (ep === "checkout" && calls.filter((c) => c.ep === "checkout").length === 1)
        return new Response(JSON.stringify({ lease_id: "L1", token: "TOK-1", exp: now + 800, lease_ttl_sec: 360, heartbeat_interval_sec: 30, concurrency: { used: 1, limit: 5 } }), { status: 200 });
      if (script.length && script[0][0] === ep) {
        const [, status, answer] = script.shift()!;
        if (answer instanceof Error) throw answer;
        return new Response(JSON.stringify(answer), { status });
      }
      return new Response("{}", { status: 200 });
    });
    return calls;
  }
  const beat = () => vi.advanceTimersByTimeAsync(30_000);

  it("re-checks out as the same launch, heartbeats the new lease, and checks THAT lease in", async () => {
    await isolatedHome();
    vi.useFakeTimers();
    const now = Math.floor(Date.now() / 1000);
    const calls = scripted([
      ["heartbeat", 409, { code: "LEASE_EXPIRED" }],
      ["checkout", 200, { lease_id: "L2", token: "TOK-2", exp: now + 900 }],
      ["heartbeat", 200, { token: "TOK-3", exp: now + 1000 }],
    ]);
    const s = await acquireLease({ licenseKey: "cc_lic_pm_hb409_ok", licenseApiBase: "http://test.local", quiet: true });
    await beat();
    await beat();
    expect(calls.map((c) => c.ep)).toEqual(["checkout", "heartbeat", "checkout", "heartbeat"]);
    expect(calls[2].body.launch_id).toBe(calls[0].body.launch_id); // the same browser takes its slot back
    expect(calls[1].body.lease_id).toBe("L1");
    expect(calls[3].body.lease_id).toBe("L2");
    expect(s!.token).toBe("TOK-3");
    await s!.stop();
    expect(calls.at(-1)).toMatchObject({ ep: "checkin", body: { lease_id: "L2" } });
  });

  it("a refused re-checkout is reported as the refusal and retried on the next beat", async () => {
    await isolatedHome();
    vi.useFakeTimers();
    const now = Math.floor(Date.now() / 1000);
    const calls = scripted([
      ["heartbeat", 409, { code: "LEASE_EXPIRED" }],
      ["checkout", 429, { code: "CONCURRENCY_LIMIT_EXCEEDED", error: "Another browser holds the slot." }],
      ["heartbeat", 409, { code: "LEASE_EXPIRED" }],
      ["checkout", 200, { lease_id: "L9", token: "TOK-9", exp: now + 900 }],
    ]);
    const s = await acquireLease({ licenseKey: "cc_lic_pm_hb409_retry", licenseApiBase: "http://test.local", quiet: true });
    await beat();
    expect(s!.refusal).toMatchObject({ status: 429, code: "CONCURRENCY_LIMIT_EXCEEDED" });
    expect(s!.token).toBe("TOK-1");
    await beat();
    expect(calls.map((c) => c.ep)).toEqual(["checkout", "heartbeat", "checkout", "heartbeat", "checkout"]);
    expect(s!.token).toBe("TOK-9");
    expect(s!.refusal).toBeUndefined();
    await s!.stop();
  });

  it("a network error on the re-checkout is retried on the next beat", async () => {
    await isolatedHome();
    vi.useFakeTimers();
    const now = Math.floor(Date.now() / 1000);
    const calls = scripted([
      ["heartbeat", 409, { code: "LEASE_NOT_FOUND" }],
      ["checkout", 0, new Error("ECONNRESET")],
      ["heartbeat", 409, { code: "LEASE_NOT_FOUND" }],
      ["checkout", 200, { lease_id: "L5", token: "TOK-5", exp: now + 900 }],
    ]);
    const s = await acquireLease({ licenseKey: "cc_lic_pm_hb409_net", licenseApiBase: "http://test.local", quiet: true });
    await beat();
    await beat();
    expect(calls.map((c) => c.ep)).toEqual(["checkout", "heartbeat", "checkout", "heartbeat", "checkout"]);
    expect(s!.token).toBe("TOK-5");
    await s!.stop();
  });
});

// ── User-Agent: every licence call names the app and its version ────────────────────────────────────
// Electron's fetch would say just "node", like the Node SDK. Checked on the wire with a real local server,
// so fetch's own default or a duplicate header would show.
describe("licence calls — User-Agent on the wire", () => {
  const OLD = { home: process.env.HOME, prof: process.env.USERPROFILE };
  afterEach(() => {
    for (const [k, v] of Object.entries({ HOME: OLD.home, USERPROFILE: OLD.prof })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("checkout and check-in each carry exactly one User-Agent naming the app version", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createServer } = await import("node:http");
    const home = mkdtempSync(join(tmpdir(), "pm-ua-"));
    HOMES.push(home);
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const want = `clearcote-profile-manager/${JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version}`;

    const seen: { path: string; uas: string[] }[] = [];
    const server = createServer((req, res) => {
      const uas: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === "user-agent") uas.push(req.rawHeaders[i + 1]);
      seen.push({ path: req.url ?? "", uas });
      req.resume();
      req.on("end", () => {
        const now = Math.floor(Date.now() / 1000);
        const body = req.url!.endsWith("/checkout")
          ? { lease_id: "L1", token: "TOK", exp: now + 800, lease_ttl_sec: 360, heartbeat_interval_sec: 3600, concurrency: { used: 1, limit: 5 } }
          : {};
        res.writeHead(200, { "content-type": "application/json", connection: "close" }).end(JSON.stringify(body));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (server.address() as { port: number }).port;
      const s = await acquireLease({ licenseKey: "cc_lic_pm_ua", licenseApiBase: `http://127.0.0.1:${port}`, quiet: true });
      await s!.stop();
      expect(seen).toEqual([
        { path: "/api/v1/lease/checkout", uas: [want] },
        { path: "/api/v1/lease/checkin", uas: [want] },
      ]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
