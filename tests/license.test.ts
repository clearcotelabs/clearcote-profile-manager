// PRO licensing client (electron/license.ts) + pro-binary fetch (electron/proBinary.ts).
// Hermetic — the only network is a mocked `fetch`. Mirrors the clearcote SDK's tests.

import "./helpers/linux-on-mac"; // pins the Windows/Linux behaviour; a Mac runner runs this suite as Linux
import { describe, it, expect, vi, afterEach, beforeEach, afterAll } from "vitest";
import {
  resolveLicenseKey,
  acquireLease,
  checkLicense,
  withRunToken,
  planFromToken,
  apiBase,
  leaseDefaults,
  resetLeaseBreaker,
  LicenseError,
  LicenseRevokedError,
  ConcurrencyLimitError,
  type LeaseSession,
} from "../electron/license";
import { proEnsureBinary } from "../electron/proBinary";
import type { IncomingMessage, Server } from "node:http";

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

// ── lease host: lease.clearcotelabs.com first, www.clearcotelabs.com when it cannot be reached ──────────
// By default the lease calls (checkout, heartbeat, check-in, the Settings key check) go to the licence lease
// server, and once more to clearcotelabs.com when it cannot be reached: a network error or timeout, a
// gateway error, or an answer that is not JSON (a CDN challenge page). The lease server is then skipped for
// a while. A JSON answer from it is final. A base that is set (the licenseApiBase setting,
// CLEARCOTE_LICENSE_API, CLEARCOTE_LEASE_API) is the only one used. Real local HTTP servers stand in for both
// hosts: fetch is wrapped to send the two real origins to them and to refuse every other host but this
// machine, so no test can reach a real licence server.
describe("lease calls — lease.clearcotelabs.com first, www.clearcotelabs.com as the fallback", () => {
  const LEASE = "https://lease.clearcotelabs.com";
  const WWW = "https://www.clearcotelabs.com";
  const CO = "/api/v1/lease/checkout";
  const HB = "/api/v1/lease/heartbeat";
  const CI = "/api/v1/lease/checkin";
  const realFetch = globalThis.fetch;
  const savedDefaults = { ...leaseDefaults };
  const ENV = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CLEARCOTE_LICENSE_KEY", "CLEARCOTE_LICENSE_API", "CLEARCOTE_LEASE_API"];
  const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const servers: Server[] = [];
  const leases: LeaseSession[] = [];
  let seq = 0;

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "pm-leasehost-"));
    HOMES.push(home);
    for (const k of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) process.env[k] = home;
    for (const k of ["CLEARCOTE_LICENSE_KEY", "CLEARCOTE_LICENSE_API", "CLEARCOTE_LEASE_API"]) delete process.env[k];
    resetLeaseBreaker(); // the offline-grace tests above left the real lease host skipped
  });

  afterEach(async () => {
    for (const l of leases.splice(0)) await l.stop();
    vi.useRealTimers();
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
    globalThis.fetch = realFetch;
    Object.assign(leaseDefaults, savedDefaults);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const key = () => `cc_lic_pm_leasehost_${Date.now()}_${++seq}`;
  const tok = (by: string, n: number) => Buffer.from(JSON.stringify({ v: 1, plan: "pro", by, n })).toString("base64url") + ".sig";
  const keep = (s: LeaseSession | null) => {
    leases.push(s!);
    return s!;
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
  async function until(cond: () => boolean, what: string) {
    const end = Date.now() + 4_000;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(10);
    }
  }

  type Answer = [status: number, body: string, contentType?: string] | "reset" | "hang";
  interface Fake {
    base: string;
    hits: { path: string; body: Record<string, unknown>; uas: string[] }[];
  }

  /**
   * A licence backend on 127.0.0.1: leases "<name>-L1", "<name>-L2"... whose tokens name the server, beats
   * that hand back "<name>-beat" tokens. `answer` overrides a call (undefined = answer as healthy).
   */
  async function fakeServer(name: string, answer?: (path: string) => Answer | undefined): Promise<Fake> {
    const { createServer } = await import("node:http");
    const fake: Fake = { base: "", hits: [] };
    let made = 0;
    let beats = 0;
    const server = createServer((req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const path = req.url ?? "";
        const uas: string[] = [];
        for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === "user-agent") uas.push(req.rawHeaders[i + 1]);
        fake.hits.push({ path, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}, uas });
        const exp = Math.floor(Date.now() / 1000) + 900;
        let a = answer?.(path);
        if (!a) {
          if (path === CO) {
            made++;
            a = [200, JSON.stringify({ lease_id: `${name}-L${made}`, token: tok(name, made), exp, lease_ttl_sec: 360, heartbeat_interval_sec: 30, concurrency: { used: 1, limit: 5 } })];
          } else if (path === HB) a = [200, JSON.stringify({ token: tok(`${name}-beat`, ++beats), exp })];
          else a = [200, JSON.stringify({ ok: true })];
        }
        if (a === "hang") return; // never answers; afterEach closes the connection
        if (a === "reset") return void req.socket.destroy();
        res.writeHead(a[0], { "content-type": a[2] ?? "application/json", connection: "close" }).end(a[1]);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    servers.push(server);
    fake.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return fake;
  }

  /** A port on this machine that nothing listens on (connection refused). */
  async function closedBase(): Promise<string> {
    const { createServer } = await import("node:http");
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const port = (s.address() as { port: number }).port;
    await new Promise((r) => s.close(r));
    return `http://127.0.0.1:${port}`;
  }

  /**
   * Wrap fetch: the real lease and www origins go to `routes` (changeable mid-test), 127.0.0.1 goes through,
   * any other host is refused. Records every URL and body as the app sent them.
   */
  function rewire(routes: Record<string, string>) {
    const urls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const u = String(input);
      urls.push(u);
      bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : {});
      const { origin, hostname } = new URL(u);
      const to = routes[origin] ?? (hostname === "127.0.0.1" ? origin : undefined);
      if (!to) throw new TypeError(`refused in tests: ${u}`);
      return realFetch(to + u.slice(origin.length), init);
    }) as typeof fetch;
    return { urls, bodies, routes };
  }

  it("by default checkout, check-in and the Settings check go to lease.clearcotelabs.com; downloads and the catalog keep www", async () => {
    const primary = await fakeServer("P");
    const fallback = await fakeServer("F");
    const wire = rewire({ [LEASE]: primary.base, [WWW]: fallback.base });
    const k = key();
    const s = keep(await acquireLease({ licenseKey: k, quiet: true }));
    expect(s.leaseId).toBe("P-L1");
    await s.stop();
    expect(await checkLicense(k)).toMatchObject({ ok: true, plan: "pro" });
    expect(wire.urls).toEqual([LEASE + CO, LEASE + CI, LEASE + CO, LEASE + CI]);
    expect(fallback.hits).toEqual([]);
    expect(leaseDefaults).toMatchObject({ primary: LEASE, fallback: WWW, breakerMs: 60_000 });
    expect(apiBase()).toBe(WWW); // what the PRO download (proBinary.ts) and the catalog (catalog.ts) use
  });

  it("the lease host refusing the connection: the same checkout (same body, same User-Agent) lands on www, and the check-in goes straight there", async () => {
    const fallback = await fakeServer("F");
    const wire = rewire({ [LEASE]: await closedBase(), [WWW]: fallback.base });
    const s = keep(await acquireLease({ licenseKey: key(), quiet: true }));
    expect(s.leaseId).toBe("F-L1");
    expect(s.token).toBe(tok("F", 1));
    expect(wire.urls).toEqual([LEASE + CO, WWW + CO]);
    expect(Object.keys(wire.bodies[0]).sort()).toEqual(["instance_id", "launch_id", "os"]); // no new fields
    expect(wire.bodies[1]).toEqual(wire.bodies[0]); // the same instance_id and launch_id
    expect(fallback.hits[0].uas).toEqual([expect.stringMatching(/^clearcote-profile-manager\//)]);
    await s.stop();
    expect(wire.urls).toEqual([LEASE + CO, WWW + CO, WWW + CI]);
    expect(fallback.hits.map((h) => h.path)).toEqual([CO, CI]);
    expect(fallback.hits[1].body).toEqual({ lease_id: "F-L1" });
  });

  it("a reset connection, a TLS error and a lease host that never answers go to www too", async () => {
    leaseDefaults.primaryTimeoutMs = 300; // stands in for the 30 s
    const fallback = await fakeServer("F");
    const plain = await fakeServer("plain"); // plain HTTP: https:// to it fails the TLS handshake
    const reset = await fakeServer("R", () => "reset");
    const hang = await fakeServer("H", () => "hang");
    const k = key();
    for (const [what, primaryBase] of [
      ["reset", reset.base],
      ["TLS error", plain.base.replace("http://", "https://")],
      ["no answer", hang.base],
    ] as const) {
      resetLeaseBreaker();
      const wire = rewire({ [LEASE]: primaryBase, [WWW]: fallback.base });
      const t0 = Date.now();
      expect(await checkLicense(k), what).toMatchObject({ ok: true, plan: "pro" });
      expect(wire.urls, what).toEqual([LEASE + CO, WWW + CO, WWW + CI]);
      expect(Date.now() - t0, what).toBeLessThan(4_000);
    }
    expect(reset.hits).toHaveLength(1);
    expect(hang.hits).toHaveLength(1);
    expect(fallback.hits.filter((h) => h.path === CO)).toHaveLength(3);
  });

  it("gateway errors (502, 503, 504, 520-527, 530) and an answer that is not JSON (a challenge page) go to www", async () => {
    const cases: Answer[] = [
      // a gateway status goes to www even with a JSON body: it is the gateway's answer, not the lease server's
      ...[502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530].map((st): Answer => [st, JSON.stringify({ error: "upstream" })]),
      [403, "<!DOCTYPE html><title>Vercel Security Checkpoint</title>", "text/html"],
      [429, "<html>Too many requests</html>", "text/html"],
      [200, "<html>Just a moment...</html>", "text/html"],
    ];
    let next: Answer | undefined;
    const primary = await fakeServer("P", () => next);
    const fallback = await fakeServer("F");
    const k = key();
    for (const c of cases) {
      const what = JSON.stringify(c).slice(0, 40);
      resetLeaseBreaker();
      next = c;
      const wire = rewire({ [LEASE]: primary.base, [WWW]: fallback.base });
      expect(await checkLicense(k), what).toMatchObject({ ok: true, plan: "pro" });
      expect(wire.urls, what).toEqual([LEASE + CO, WWW + CO, WWW + CI]);
    }
    expect(primary.hits).toHaveLength(cases.length);
    expect(fallback.hits.filter((h) => h.path === CO)).toHaveLength(cases.length);
  });

  it("a JSON answer from the lease host is final: 401, 403, 426 and 429 never reach www, and the lease host stays in use", async () => {
    let next: Answer | undefined;
    const primary = await fakeServer("P", () => next);
    const fallback = await fakeServer("F");
    const wire = rewire({ [LEASE]: primary.base, [WWW]: fallback.base });
    const k = key();
    const err = (status: number, error: string, code: string): Answer => [status, JSON.stringify({ error, code })];
    next = err(429, "All 5 browsers are in use.", "CONCURRENCY_LIMIT_EXCEEDED");
    await expect(acquireLease({ licenseKey: k, quiet: true })).rejects.toBeInstanceOf(ConcurrencyLimitError);
    next = err(403, "This licence was revoked.", "LICENSE_REVOKED");
    await expect(acquireLease({ licenseKey: k, quiet: true })).rejects.toBeInstanceOf(LicenseRevokedError);
    next = err(401, "Invalid license key.", "INVALID_LICENSE");
    await expect(acquireLease({ licenseKey: k, quiet: true })).rejects.toMatchObject({ name: "LicenseError", code: "INVALID_LICENSE", message: "Invalid license key." });
    next = err(426, "Update the app.", "UPGRADE_REQUIRED");
    await expect(acquireLease({ licenseKey: k, quiet: true })).rejects.toBeInstanceOf(LicenseError);
    // the Settings check: busy and invalid are verdicts on the key, from the lease host
    next = err(429, "All 5 browsers are in use.", "CONCURRENCY_LIMIT_EXCEEDED");
    expect(await checkLicense(k)).toMatchObject({ ok: true, busy: true });
    next = err(401, "Invalid license key.", "INVALID_LICENSE");
    expect(await checkLicense(k)).toEqual({ ok: false, error: "Invalid license key.", code: "INVALID_LICENSE" });
    expect(wire.urls).toEqual(Array(6).fill(LEASE + CO));
    expect(fallback.hits).toEqual([]);
  });

  it("a heartbeat answered 409 by the lease host is final: the re-checkout goes to the lease host too, never www", async () => {
    const primary = await fakeServer("P", (path) => (path === HB ? [409, JSON.stringify({ error: "Lease expired.", code: "LEASE_EXPIRED" })] : undefined));
    const fallback = await fakeServer("F");
    const wire = rewire({ [LEASE]: primary.base, [WWW]: fallback.base });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); // the heartbeat timer; the HTTP stays real
    const s = keep(await acquireLease({ licenseKey: key(), quiet: true }));
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => s.token === tok("P", 2), "the re-checkout");
    expect(wire.urls).toEqual([LEASE + CO, LEASE + HB, LEASE + CO]);
    expect(primary.hits[1].body.lease_id).toBe("P-L1");
    expect(primary.hits[2].body.launch_id).toBe(primary.hits[0].body.launch_id);
    await s.stop();
    expect(wire.urls.at(-1)).toBe(LEASE + CI);
    expect(primary.hits.at(-1)!.body).toEqual({ lease_id: "P-L2" });
    expect(fallback.hits).toEqual([]);
  });

  it("a heartbeat the lease host cannot take goes to www, and the token www hands back reaches the lease", async () => {
    const primary = await fakeServer("P");
    const fallback = await fakeServer("F");
    const closed = await closedBase();
    const wire = rewire({ [LEASE]: primary.base, [WWW]: fallback.base });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const s = keep(await acquireLease({ licenseKey: key(), quiet: true }));
    expect(s.token).toBe(tok("P", 1));
    wire.routes[LEASE] = closed; // the lease host goes away
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => s.token === tok("F-beat", 1), "the heartbeat on www");
    expect(wire.urls).toEqual([LEASE + CO, LEASE + HB, WWW + HB]);
    expect(wire.bodies[2]).toEqual(wire.bodies[1]); // the same lease_id and nonce
    expect(fallback.hits[0].body.lease_id).toBe("P-L1");
    await s.stop();
    expect(wire.urls.at(-1)).toBe(WWW + CI); // inside the breaker window: straight to www
    expect(fallback.hits.at(-1)!.body).toEqual({ lease_id: "P-L1" });
  });

  it("after a failure the lease host is skipped for the breaker window (60 s; 1 s here), then tried again", async () => {
    leaseDefaults.breakerMs = 1_000;
    const primary = await fakeServer("P");
    const fallback = await fakeServer("F");
    const wire = rewire({ [LEASE]: await closedBase(), [WWW]: fallback.base });
    const k = key();
    const call = async () => {
      const from = wire.urls.length;
      expect(await checkLicense(k)).toMatchObject({ ok: true, plan: "pro" });
      return wire.urls.slice(from);
    };
    let failedAt = Date.now();
    expect(await call()).toEqual([LEASE + CO, WWW + CO, WWW + CI]); // refused: once to www, and the window opens
    expect(await call()).toEqual([WWW + CO, WWW + CI]); // inside the window the lease host is not tried
    await sleep(failedAt + 1_150 - Date.now());
    failedAt = Date.now();
    expect(await call()).toEqual([LEASE + CO, WWW + CO, WWW + CI]); // tried again: still down, a new window
    wire.routes[LEASE] = primary.base; // the lease host is back...
    expect(await call()).toEqual([WWW + CO, WWW + CI]); // ...but not tried inside the window
    await sleep(failedAt + 1_150 - Date.now());
    expect(await call()).toEqual([LEASE + CO, LEASE + CI]); // after it, the lease host again
    expect(primary.hits.map((h) => h.path)).toEqual([CO, CI]);
  });

  it("CLEARCOTE_LEASE_API is the only base used: no fallback to www", async () => {
    const primary = await fakeServer("P");
    const fallback = await fakeServer("F");
    const set = await fakeServer("E");
    const closed = await closedBase();
    const wire = rewire({ [LEASE]: primary.base, [WWW]: fallback.base });
    const k = key();
    process.env.CLEARCOTE_LEASE_API = closed;
    await expect(acquireLease({ licenseKey: k, quiet: true })).rejects.toThrow(/Could not reach the license server/);
    expect(await checkLicense(k)).toMatchObject({ ok: false });
    expect(wire.urls).toEqual([closed + CO, closed + CO]);
    process.env.CLEARCOTE_LEASE_API = `${set.base}/`; // a working one (the trailing slash is dropped)
    const s = keep(await acquireLease({ licenseKey: k, quiet: true }));
    expect(s.leaseId).toBe("E-L1");
    await s.stop();
    expect(wire.urls.slice(2)).toEqual([set.base + CO, set.base + CI]);
    expect(primary.hits).toEqual([]);
    expect(fallback.hits).toEqual([]);
  });

  it("the licenseApiBase setting and CLEARCOTE_LICENSE_API keep their meaning: that base only, no fallback", async () => {
    const primary = await fakeServer("P");
    const fallback = await fakeServer("F");
    const closed = await closedBase();
    const wire = rewire({ [LEASE]: primary.base, [WWW]: fallback.base });
    const k = key();
    await expect(acquireLease({ licenseKey: k, licenseApiBase: closed, quiet: true })).rejects.toThrow(/Could not reach the license server/);
    expect(await checkLicense(k, closed)).toMatchObject({ ok: false });
    process.env.CLEARCOTE_LICENSE_API = closed;
    await expect(acquireLease({ licenseKey: k, quiet: true })).rejects.toThrow(/Could not reach the license server/);
    expect(await checkLicense(k)).toMatchObject({ ok: false });
    expect(wire.urls).toEqual(Array(4).fill(closed + CO));
    expect(primary.hits).toEqual([]);
    expect(fallback.hits).toEqual([]);
  });

  it("precedence: the licenseApiBase setting, then CLEARCOTE_LICENSE_API, then CLEARCOTE_LEASE_API", async () => {
    const a = await fakeServer("A");
    const b = await fakeServer("B");
    const c = await fakeServer("C");
    const primary = await fakeServer("P");
    const fallback = await fakeServer("F");
    rewire({ [LEASE]: primary.base, [WWW]: fallback.base });
    const k = key();
    const leaseFrom = async (setting?: string) => {
      const s = keep(await acquireLease({ licenseKey: k, licenseApiBase: setting, quiet: true }));
      await s.stop();
      return s.leaseId;
    };
    process.env.CLEARCOTE_LICENSE_API = b.base;
    process.env.CLEARCOTE_LEASE_API = c.base;
    expect(await leaseFrom(a.base)).toBe("A-L1");
    expect(await leaseFrom()).toBe("B-L1");
    delete process.env.CLEARCOTE_LICENSE_API;
    expect(await leaseFrom()).toBe("C-L1");
    expect([a, b, c].map((f) => f.hits.map((h) => h.path))).toEqual([[CO, CI], [CO, CI], [CO, CI]]);
    expect(primary.hits).toEqual([]);
    expect(fallback.hits).toEqual([]);
  });
});
