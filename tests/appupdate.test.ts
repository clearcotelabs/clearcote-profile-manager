// The update check. Three things here are load-bearing and easy to get subtly wrong: comparing
// versions, picking the asset that matches how the app was installed, and reading the checksums.

import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, pickAsset, parseSums, downloadUpdate, type UpdateAsset, type UpdateInfo } from "../electron/appupdate";

// One test below damages the file on its way to disk, to check what the error then says. Only the
// write stream the updater opens is wrapped, and only while `damage.next` is set.
const damage = vi.hoisted(() => ({ next: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const createWriteStream = ((...args: Parameters<typeof fs.createWriteStream>) => {
    const ws = fs.createWriteStream(...args);
    if (!damage.next) return ws;
    damage.next = false;
    let done = false;
    const flip = (b: Buffer) => {
      if (done) return b;
      done = true;
      const c = Buffer.from(b);
      c[0] ^= 0xff;
      return c;
    };
    type W = { _write: (c: Buffer, e: BufferEncoding, cb: (err?: Error | null) => void) => void; _writev?: (cs: { chunk: Buffer; encoding: BufferEncoding }[], cb: (err?: Error | null) => void) => void };
    const w = ws as unknown as W;
    const write = w._write.bind(ws);
    w._write = (c, e, cb) => write(flip(c), e, cb);
    const writev = w._writev?.bind(ws);
    if (writev) w._writev = (cs, cb) => writev(cs.map((x, i) => (i === 0 ? { ...x, chunk: flip(x.chunk) } : x)), cb);
    return ws;
  }) as typeof fs.createWriteStream;
  return { ...fs, default: { ...fs, createWriteStream }, createWriteStream };
});

/** Point TEMP/TMP (os.tmpdir() reads them on every call, so updateDir() follows) at a private
 *  folder for the enclosing describe, and remove it after — so no test "installer" is ever left in
 *  the real %TEMP%\clearcote-update. */
function useTempSandbox(): void {
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  let sandbox = "";
  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), "ccpm-update-test-"));
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = sandbox;
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(sandbox, { recursive: true, force: true });
  });
}

describe("compareVersions", () => {
  it("orders by numeric component, not lexically", () => {
    // The one that actually bites: "0.9.0" sorts ABOVE "0.10.0" as a string, so a lexical compare
    // would go quiet at exactly the release that rolled the minor over.
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  });

  it("treats equal versions as equal, with or without a leading v", () => {
    expect(compareVersions("0.10.0", "0.10.0")).toBe(0);
    expect(compareVersions("v0.10.0", "0.10.0")).toBe(0);
  });

  it("handles missing components as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBeGreaterThan(0);
  });

  it("ranks a release above its own pre-releases", () => {
    expect(compareVersions("0.10.0", "0.10.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("0.10.0-rc.1", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("0.10.0-rc.2", "0.10.0-rc.1")).toBeGreaterThan(0);
  });

  it("does not offer an update to the version already running", () => {
    // The property the banner depends on: available === compare(latest, current) > 0.
    expect(compareVersions("0.10.0", "0.10.0") > 0).toBe(false);
    expect(compareVersions("0.9.0", "0.10.0") > 0).toBe(false);
  });
});

describe("pickAsset — match the host OS, then how the app was installed", () => {
  // A release carries every platform at once, which is exactly why the OS cut has to come first.
  const assets: UpdateAsset[] = [
    { name: "Clearcote-Profile-Manager-0.10.0-setup.exe", url: "u1", size: 1 },
    { name: "Clearcote-Profile-Manager-0.10.0-x64.zip", url: "u2", size: 2 },
    { name: "Clearcote-Profile-Manager-0.10.0-x64.AppImage", url: "u4", size: 4 },
    { name: "Clearcote-Profile-Manager-0.10.0-x64.tar.gz", url: "u5", size: 5 },
    { name: "SHA256SUMS.txt", url: "u3", size: 3 },
  ];
  // The tests pin the platform rather than inheriting it, so the suite asserts the same thing on a
  // Windows laptop and on the Linux CI runner.
  const win = { platform: "win32" as const, execPath: "C:/Apps/Clearcote/app.exe" };
  const linux = { platform: "linux" as const, execPath: "/opt/clearcote/clearcote-profile-manager" };

  it("an NSIS install gets the installer — it sits beside its uninstaller", () => {
    const got = pickAsset(assets, { ...win, existsSync: (p) => p.includes("Uninstall") });
    expect(got?.name).toMatch(/setup\.exe$/);
  });

  it("a portable copy gets the zip, never the installer", () => {
    // Handing a zip user an installer would silently create a SECOND, separate installation while
    // they carry on running the old folder.
    const got = pickAsset(assets, { ...win, execPath: "D:/portable/cc/app.exe", existsSync: () => false });
    expect(got?.name).toMatch(/\.zip$/);
  });

  it("never offers a Windows download to a Linux host", () => {
    for (const appImage of ["/home/me/Apps/cc.AppImage", undefined]) {
      const got = pickAsset(assets, { ...linux, appImage, existsSync: () => false });
      expect(got?.name).not.toMatch(/\.(exe|zip)$/i);
    }
  });

  it("an AppImage updates itself, a tarball install gets the tarball", () => {
    // The AppImage launcher exports APPIMAGE; without it this copy was unpacked from the tarball,
    // and swapping in an AppImage would leave the old directory sitting there being run.
    expect(pickAsset(assets, { ...linux, appImage: "/home/me/Apps/cc.AppImage" })?.name).toMatch(/\.AppImage$/);
    expect(pickAsset(assets, { ...linux, appImage: "" })?.name).toMatch(/\.tar\.gz$/);
  });

  it("never offers the checksums file as the download", () => {
    for (const exists of [() => true, () => false]) {
      expect(pickAsset(assets, { ...win, existsSync: exists })?.name).not.toMatch(/SHA256SUMS/);
      expect(pickAsset(assets, { ...linux, existsSync: exists })?.name).not.toMatch(/SHA256SUMS/);
    }
  });

  it("returns nothing when the release has no usable asset", () => {
    const sums = [{ name: "SHA256SUMS.txt", url: "u", size: 1 }];
    expect(pickAsset(sums, { ...win, existsSync: () => false })).toBeUndefined();
    expect(pickAsset(sums, { ...linux })).toBeUndefined();
    expect(pickAsset([], { ...win, existsSync: () => false })).toBeUndefined();
    expect(pickAsset([], { ...linux })).toBeUndefined();
  });

  it("falls back to the one shape that was published, on either OS", () => {
    expect(pickAsset([assets[0]], { ...win, existsSync: () => false })?.name).toMatch(/setup\.exe$/);
    // A Linux release that shipped only an AppImage still updates a tarball install — an unusable
    // asset is worse than one that asks for a slightly different unpack.
    expect(pickAsset([assets[2]], { ...linux, appImage: "" })?.name).toMatch(/\.AppImage$/);
    expect(pickAsset([assets[3]], { ...linux, appImage: "/x/cc.AppImage" })?.name).toMatch(/\.tar\.gz$/);
  });

  it("survives a filesystem that throws", () => {
    expect(() =>
      pickAsset(assets, {
        ...win,
        existsSync: () => {
          throw new Error("EPERM");
        },
      }),
    ).not.toThrow();
  });
});

describe("parseSums", () => {
  const SUMS = [
    "5b8f9c2a1d3e4f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8  Clearcote-Profile-Manager-0.10.0-setup.exe",
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90  Clearcote-Profile-Manager-0.10.0-x64.zip",
  ].join("\n");

  it("maps filename to hash", () => {
    const out = parseSums(SUMS);
    expect(out["Clearcote-Profile-Manager-0.10.0-setup.exe"]).toBe(
      "5b8f9c2a1d3e4f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8",
    );
    expect(Object.keys(out)).toHaveLength(2);
  });

  it("accepts CRLF and the binary-mode asterisk", () => {
    const out = parseSums("a".repeat(64) + " *file.zip\r\n" + "b".repeat(64) + "  other.exe\r\n");
    expect(out["file.zip"]).toBe("a".repeat(64));
    expect(out["other.exe"]).toBe("b".repeat(64));
  });

  it("lowercases hashes so the comparison is case-insensitive", () => {
    expect(parseSums("A".repeat(64) + "  x.exe")["x.exe"]).toBe("a".repeat(64));
  });

  it("ignores blank lines and anything that is not a checksum row", () => {
    const out = parseSums(`# a comment\n\n${"c".repeat(64)}  real.exe\nnot a hash  fake.exe\n`);
    expect(Object.keys(out)).toEqual(["real.exe"]);
  });

  it("returns nothing for an empty file, so a missing entry reads as unverifiable", () => {
    expect(parseSums("")).toEqual({});
  });
});

// Regression: two overlapping downloads (two app windows, or a repeated click) shared one directory
// and one filename. The second wiped the directory and truncated the file mid-write, so the first
// failed "Checksum mismatch … has been deleted" and the second found an empty file.
describe("downloadUpdate — overlapping downloads never clobber each other", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  useTempSandbox();

  const payload = Buffer.alloc(3 * 1024 * 1024, 0).map((_, i) => (i * 31) & 0xff);
  const sha = createHash("sha256").update(payload).digest("hex");
  const name = "Clearcote-Profile-Manager-9.9.9-setup.exe";

  /** A body that trickles out in chunks, so two downloads really do overlap in time. */
  const slowBody = () =>
    new ReadableStream<Uint8Array>({
      async start(c) {
        for (let o = 0; o < payload.length; o += 256 * 1024) {
          c.enqueue(new Uint8Array(payload.subarray(o, o + 256 * 1024)));
          await new Promise((r) => setTimeout(r, 5));
        }
        c.close();
      },
    });

  function mockGitHub(sums = `${sha}  ${name}\n`) {
    const fetchSpy = vi.fn(async (url: string) =>
      String(url).includes("SHA256SUMS")
        ? new Response(sums)
        : new Response(slowBody(), { headers: { "content-length": String(payload.length) } }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    return fetchSpy;
  }

  const info = (url: string): UpdateInfo => ({
    available: true,
    latest: "9.9.9",
    current: "0.0.1",
    releaseUrl: "https://example.test/r",
    asset: { name, url, size: payload.length },
    sumsUrl: "https://example.test/SHA256SUMS.txt",
  });

  it("a repeated request for the same asset joins the one in flight (one download, both verified)", async () => {
    const spy = mockGitHub();
    const u = info(`https://example.test/a-${Math.random()}`);
    const [a, b] = await Promise.all([downloadUpdate(u), downloadUpdate(u)]);
    expect(a).toMatchObject({ ok: true, verified: true });
    expect(b).toEqual(a);
    expect(spy.mock.calls.filter((c) => !String(c[0]).includes("SHA256SUMS"))).toHaveLength(1);
  });

  it("two independent downloads (e.g. two app copies) each land intact in their own directory", async () => {
    mockGitHub();
    const A = downloadUpdate(info(`https://example.test/b1-${Math.random()}`));
    await new Promise((r) => setTimeout(r, 20)); // B starts while A is mid-transfer
    const B = downloadUpdate(info(`https://example.test/b2-${Math.random()}`));
    const [a, b] = await Promise.all([A, B]);
    expect(a).toMatchObject({ ok: true, verified: true });
    expect(b).toMatchObject({ ok: true, verified: true });
    expect(a.path).not.toBe(b.path);
    for (const p of [a.path!, b.path!]) {
      expect(existsSync(p)).toBe(true);
      expect(createHash("sha256").update(readFileSync(p)).digest("hex")).toBe(sha);
    }
  });

  it("a genuine mismatch still fails and leaves nothing runnable behind", async () => {
    mockGitHub(`${"0".repeat(64)}  ${name}\n`);
    const r = await downloadUpdate(info(`https://example.test/c-${Math.random()}`));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Checksum mismatch/);
    expect(r.path).toBeUndefined();
  });

  it("a truncated transfer is reported as incomplete, not as tampering", async () => {
    mockGitHub();
    const u = info(`https://example.test/d-${Math.random()}`);
    u.asset!.size = payload.length + 10;
    const r = await downloadUpdate(u);
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/incomplete/);
  });
});

// Regression: in the app the progress callback sends to the window, and in Electron's main process
// that send lets Node run queued stream work before it returns. Progress used to be counted by a
// 'data' listener beside pipeline(), so the next chunk was handed out inside the current one and the
// file writer got the pair swapped — right size, wrong bytes, "Checksum mismatch" on every download
// through the app, and never in a plain-Node run, which is how it survived. process._tickCallback()
// is that same "run queued work now" in plain Node; on the old code it reproduces the swap.
describe("downloadUpdate — progress sent to the window never reorders the file", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    damage.next = false;
  });
  useTempSandbox();

  // Random, so every chunk differs. With a repeating pattern two swapped chunks are identical and
  // the hash still matches, so the very bug this guards would pass.
  const payload = randomBytes(8 * 1024 * 1024);
  const sha = createHash("sha256").update(payload).digest("hex");
  const name = "Clearcote-Profile-Manager-9.9.9-setup.exe";
  /** The whole body already queued, in network-sized chunks, as on a fast connection. */
  const eagerBody = () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let o = 0; o < payload.length; o += 16 * 1024) c.enqueue(new Uint8Array(payload.subarray(o, o + 16 * 1024)));
        c.close();
      },
    });
  const mock = () => {
    globalThis.fetch = (async (url: string) =>
      String(url).includes("SHA256SUMS")
        ? new Response(`${sha}  ${name}\n`)
        : new Response(eagerBody(), { headers: { "content-length": String(payload.length) } })) as unknown as typeof fetch;
  };
  const info = (): UpdateInfo => ({
    available: true,
    latest: "9.9.9",
    current: "0.0.1",
    releaseUrl: "https://example.test/r",
    asset: { name, url: `https://example.test/p-${Math.random()}`, size: payload.length },
    sumsUrl: "https://example.test/SHA256SUMS.txt",
  });
  const runQueuedWork = (process as unknown as { _tickCallback?: () => void })._tickCallback;
  const onDisk = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

  it("a progress callback that runs Node's queued work (what the window send does) still lands the published file", async () => {
    expect(typeof runQueuedWork).toBe("function"); // without it this test would prove nothing
    mock();
    let calls = 0;
    const r = await downloadUpdate(info(), () => {
      calls++;
      runQueuedWork!();
    });
    expect(calls).toBeGreaterThan(0);
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(onDisk(r.path!)).toBe(sha);
  });

  it("reports each whole percent once, in order, ending at 100 — not one message per network chunk", async () => {
    mock();
    const pcts: number[] = [];
    const seen: number[] = [];
    const totals = new Set<number>();
    const r = await downloadUpdate(info(), (pct, seenMB, totalMB) => {
      pcts.push(pct);
      seen.push(seenMB);
      totals.add(totalMB);
    });
    expect(r.ok).toBe(true);
    expect(pcts.at(-1)).toBe(100);
    expect(pcts.length).toBeLessThanOrEqual(101); // 512 network chunks in this download
    expect(pcts).toEqual([...new Set(pcts)].sort((a, b) => a - b));
    expect(seen.at(-1)).toBe(8);
    expect([...totals]).toEqual([8]);
  });

  it("a progress callback that throws (the window closed mid-download) does not fail the download", async () => {
    mock();
    const r = await downloadUpdate(info(), () => {
      throw new Error("Object has been destroyed");
    });
    expect(r).toMatchObject({ ok: true, verified: true });
    expect(onDisk(r.path!)).toBe(sha);
  });

  it("bytes that arrive intact but change on the way to disk are named as that, not as a bad download", async () => {
    mock();
    damage.next = true;
    const r = await downloadUpdate(info());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^The download matched the published SHA-256, but the file saved to disk does not/);
    expect(r.error).not.toMatch(/Checksum mismatch/);
    expect(r.path).toBeUndefined();
  });
});
