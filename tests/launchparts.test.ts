// Pieces of a launch: the start page argument (fpargs.ts → launcher + preview), the lease's refusal
// memory and shared check-in, the licence check's "valid but busy", and one download per build.

import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { startUrlArg } from "../electron/fpargs";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-parts-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe("startUrlArg — a URL, never a switch", () => {
  it("passes http(s) URLs through, and adds https:// to a bare host", () => {
    expect(startUrlArg("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
    expect(startUrlArg("http://example.com")).toBe("http://example.com/");
    expect(startUrlArg("  example.com  ")).toBe("https://example.com/");
  });
  it("refuses anything that could become a switch, a local file, or script", () => {
    for (const v of ["--disable-web-security", "-foo", "file:///C:/Windows/win.ini", "javascript:alert(1)", "chrome://settings", "data:text/html,x", "", "   ", "http://", undefined, 42]) {
      expect(startUrlArg(v), JSON.stringify(v)).toBeNull();
    }
  });
});

describe("the start page on the command line", () => {
  it("the launcher puts it LAST, after extraArgs; the preview shows the same", async () => {
    const { buildArgs } = await import("../electron/launcher");
    const { profileToArgs } = await import("../src/types/profile");
    const p = { id: "p", name: "p", fingerprint: "s", createdAt: "", updatedAt: "", extraArgs: ["--foo"], startUrl: "example.com" };
    const real = buildArgs(p as never, "C:/udd");
    expect(real.slice(-2)).toEqual(["--foo", "https://example.com/"]);
    expect(profileToArgs(p as never).slice(-2)).toEqual(["--foo", "https://example.com/"]);
  });
  it("an unsafe start page adds nothing at all", async () => {
    const { buildArgs } = await import("../electron/launcher");
    const a = buildArgs({ id: "p", name: "p", fingerprint: "s", createdAt: "", updatedAt: "", startUrl: "--disable-web-security" } as never, "C:/udd");
    expect(a).not.toContain("--disable-web-security");
    expect(a[a.length - 1]).toBe("--user-data-dir=C:/udd");
  });
});

describe("lease — why renewals stopped, and one shared check-in", () => {
  const tok = (n: number) => Buffer.from(JSON.stringify({ v: 1, plan: "pro", iat: n })).toString("base64url") + ".sig";

  it("remembers a refused heartbeat, and forgets it once renewals work again", async () => {
    vi.useFakeTimers();
    let hb = 0;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const ep = String(url).split("/").pop();
      if (ep === "checkout")
        return new Response(JSON.stringify({ lease_id: "L1", token: tok(0), exp: 9e9, lease_ttl_sec: 360, heartbeat_interval_sec: 5, concurrency: { used: 1, limit: 1 } }));
      if (ep === "heartbeat") {
        hb++;
        if (hb === 1) return new Response(JSON.stringify({ error: "This license was revoked.", code: "LICENSE_REVOKED" }), { status: 403 });
        return new Response(JSON.stringify({ token: tok(hb), exp: 9e9 }));
      }
      return new Response("{}");
    }) as unknown as typeof fetch;
    const { acquireLease } = await import("../electron/license");
    const lease = (await acquireLease({ licenseKey: "cc_lic_refusal", quiet: true }))!;
    expect(lease.refusal).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(lease.refusal).toEqual({ status: 403, code: "LICENSE_REVOKED", error: "This license was revoked." });
    await vi.advanceTimersByTimeAsync(5000);
    expect(lease.refusal).toBeUndefined();
    vi.useRealTimers();
    await lease.stop();
  });

  it("every caller of stop() waits for the SAME check-in, which is sent once", async () => {
    let checkins = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const ep = String(url).split("/").pop();
      if (ep === "checkout")
        return new Response(JSON.stringify({ lease_id: "L2", token: tok(0), exp: 9e9, lease_ttl_sec: 360, heartbeat_interval_sec: 3600, concurrency: { used: 1, limit: 1 } }));
      if (ep === "checkin") {
        checkins++;
        await gate;
      }
      return new Response("{}");
    }) as unknown as typeof fetch;
    const { acquireLease } = await import("../electron/license");
    const lease = (await acquireLease({ licenseKey: "cc_lic_shared", quiet: true }))!;
    let firstDone = false;
    let secondDone = false;
    const a = lease.stop().then(() => (firstDone = true));
    const b = lease.stop().then(() => (secondDone = true));
    await new Promise((r) => setTimeout(r, 30));
    expect([firstDone, secondDone]).toEqual([false, false]); // the second caller does NOT return early
    release();
    await Promise.all([a, b]);
    expect(checkins).toBe(1);
  });
});

describe("checkLicense — at its browser limit is still a valid key", () => {
  it("a concurrency refusal reports valid-and-busy, not a failed check", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Concurrency limit reached.", code: "CONCURRENCY_LIMIT_EXCEEDED" }), { status: 429 }),
    ) as unknown as typeof fetch;
    const { checkLicense } = await import("../electron/license");
    expect(await checkLicense("cc_lic_busy", "https://example.test")).toMatchObject({ ok: true, busy: true, code: "CONCURRENCY_LIMIT_EXCEEDED" });
  });
  it("a rejected key is still a failure", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "Invalid license key.", code: "INVALID_LICENSE" }), { status: 401 })) as unknown as typeof fetch;
    const { checkLicense } = await import("../electron/license");
    expect(await checkLicense("cc_lic_bad", "https://example.test")).toEqual({ ok: false, error: "Invalid license key.", code: "INVALID_LICENSE" });
  });
});

describe("one download per build — a launch joining a 'Download now' in flight", () => {
  const OLD = process.env.CLEARCOTE_CACHE;
  let archive: Buffer;
  let sha: string;
  const bin = process.platform === "win32" ? "chrome.exe" : "chrome";
  beforeAll(() => {
    process.env.CLEARCOTE_CACHE = path.join(ROOT, "cache");
    const src = path.join(ROOT, "src-build");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, bin), "not really chrome");
    // Incompressible, so the archive is big enough that the second request really arrives while
    // the first is still downloading (a compressible file made it finish first — a cache hit that
    // would pass this test without any sharing at all).
    fs.writeFileSync(path.join(src, "resources.pak"), randomBytes(768 * 1024));
    const out = path.join(ROOT, "build.tar.gz");
    // The same tar the app extracts with (System32 bsdtar on Windows).
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
    execFileSync(tar, ["-czf", out, "-C", src, "."]);
    archive = fs.readFileSync(out);
    sha = createHash("sha256").update(archive).digest("hex");
  });
  afterAll(() => {
    if (OLD === undefined) delete process.env.CLEARCOTE_CACHE;
    else process.env.CLEARCOTE_CACHE = OLD;
  });

  it("two requests for the same build share one transfer, and both get the verified binary", async () => {
    let downloads = 0;
    globalThis.fetch = vi.fn(async () => {
      downloads++;
      // Trickle it out, so the second request arrives mid-transfer.
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          for (let o = 0; o < archive.length; o += 16 * 1024) {
            c.enqueue(new Uint8Array(archive.subarray(o, o + 16 * 1024)));
            await new Promise((r) => setTimeout(r, 3));
          }
          c.close();
        },
      });
      return new Response(body, { headers: { "content-length": String(archive.length) } });
    }) as unknown as typeof fetch;
    const { freeEnsureBinary } = await import("../electron/proBinary");
    const resolved = {
      tier: "free" as const,
      version: "1.0.0.0",
      major: 1,
      tag: "v-test-1",
      selector: "1.0.0.0",
      platform: { asset: "build.tar.gz", url: "https://example.test/build.tar.gz", sha256: sha, size: archive.length, archive: "tar.xz" as const, binary: bin },
    };
    const seenA: number[] = [];
    const seenB: number[] = [];
    const a = freeEnsureBinary(resolved, (pct) => seenA.push(pct));
    await new Promise((r) => setTimeout(r, 15));
    expect(seenA[seenA.length - 1] ?? 0, "the first transfer must still be running").toBeLessThan(100);
    const b = freeEnsureBinary(resolved, (pct) => seenB.push(pct));
    const [pa, pb] = await Promise.all([a, b]);
    expect(downloads).toBe(1);
    expect(pa).toBe(pb);
    expect(fs.readFileSync(pa, "utf8")).toBe("not really chrome");
    expect(seenB.length).toBeGreaterThan(0); // the joiner sees the shared progress too
    expect(seenA[seenA.length - 1]).toBe(100);
    // A third call later is a cache hit: no download at all.
    await freeEnsureBinary(resolved);
    expect(downloads).toBe(1);
  });
});
