// The update check. Three things here are load-bearing and easy to get subtly wrong: comparing
// versions, picking the asset that matches how the app was installed, and reading the checksums.

import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareVersions, pickAsset, parseSums, downloadUpdate, type UpdateAsset, type UpdateInfo } from "../electron/appupdate";

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

  // updateDir() lives under os.tmpdir(), which reads TEMP/TMP on every call — so point those at a
  // private folder for this suite and remove it after. Otherwise every run left megabytes of test
  // "installers" in the real %TEMP%\clearcote-update.
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
