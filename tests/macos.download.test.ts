// macOS end to end through the real download and catalog code, with the host faked as a Mac
// (process.platform / process.arch redefined for the test) and the network mocked. What it pins:
//   - an Apple Silicon Mac asks /download/pro for platform=macos and gets the bundle's executable
//     back, unpacked through ditto (not tar), with the quarantine cleared
//   - an Intel Mac is refused before anything is fetched, with a reason it can act on
//   - the catalog resolves the macOS entry, and a Mac with no licence is told why there is nothing
//     to launch (the free builds have no macOS version), here and in the header pill
//   - Windows and Linux resolve exactly as before

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-macdl-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

import { macExtractHooks } from "../electron/macos";
import { MAC_NEEDS_LICENSE, listVersions, resolveVersion, platformTag, type Catalog } from "../electron/catalog";
import { describeTarget } from "../src/lib/launchTarget";

/** Run `fn` as if on `platform`/`arch`, restoring the real values afterwards. */
async function asHost<T>(platform: NodeJS.Platform, arch: string, fn: () => Promise<T> | T): Promise<T> {
  const p = Object.getOwnPropertyDescriptor(process, "platform")!;
  const a = Object.getOwnPropertyDescriptor(process, "arch")!;
  Object.defineProperty(process, "platform", { ...p, value: platform });
  Object.defineProperty(process, "arch", { ...a, value: arch });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", p);
    Object.defineProperty(process, "arch", a);
  }
}

// The live catalog's shape on 2026-10-17: 155 is the first build with a macOS entry.
const CAT: Catalog = {
  schema: 1,
  builds: [
    {
      major: 150,
      version: "150.0.7871.114",
      tier: "free",
      tag: "v0.1.0-pre.23",
      platforms: {
        windows: { asset: "clearcote-150.0.7871.114-windows-x64.zip", url: "https://gh/150.zip", sha256: "a".repeat(64), archive: "zip", binary: "chrome.exe" },
        linux: { asset: "clearcote-150.0.7871.114-linux-x64.tar.xz", url: "https://gh/150.tar.xz", sha256: "b".repeat(64), archive: "tar.xz", binary: "chrome" },
      },
    },
    {
      major: 154,
      version: "154.0.8037.57",
      tier: "pro",
      tag: "pro-154.0.8037.57",
      platforms: {
        windows: { asset: "clearcote-pro-154.0.8037.57-windows-x64.zip", archive: "zip", binary: "chrome.exe" },
        linux: { asset: "clearcote-pro-154.0.8037.57-linux-x64.tar.xz", archive: "tar.xz", binary: "chrome" },
      },
    },
    {
      major: 155,
      version: "155.0.8059.39",
      tier: "pro",
      tag: "pro-155.0.8059.39",
      platforms: {
        windows: { asset: "clearcote-pro-155.0.8059.39-windows-x64.zip", archive: "zip", binary: "chrome.exe" },
        linux: { asset: "clearcote-pro-155.0.8059.39-linux-x64.tar.xz", archive: "tar.xz", binary: "chrome" },
        macos: { asset: "clearcote-pro-155.0.8059.39-macos-arm64.zip", archive: "zip", binary: "Chromium" },
      },
    },
  ],
};

const realFetch = globalThis.fetch;
const realRun = macExtractHooks.run;
const OLD = {
  CLEARCOTE_CACHE: process.env.CLEARCOTE_CACHE,
  CLEARCOTE_LICENSE_KEY: process.env.CLEARCOTE_LICENSE_KEY,
  CLEARCOTE_BINARY: process.env.CLEARCOTE_BINARY,
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
};
beforeAll(() => {
  process.env.CLEARCOTE_CACHE = path.join(ROOT, "cache");
  delete process.env.CLEARCOTE_LICENSE_KEY;
  delete process.env.CLEARCOTE_BINARY;
  // "No key" also means no ~/.clearcote/license.key — point HOME at an empty dir.
  process.env.HOME = ROOT;
  process.env.USERPROFILE = ROOT;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  macExtractHooks.run = realRun;
});
afterAll(() => {
  for (const [k, v] of Object.entries(OLD)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("the PRO download on a Mac", () => {
  it("Apple Silicon: platform=macos, unpacked by ditto, quarantine cleared, the bundle's executable returned", async () => {
    const zip = Buffer.from("PK\u0003\u0004 not really a zip — ditto is mocked");
    const sha = createHash("sha256").update(zip).digest("hex");
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (u: string | URL) => {
      urls.push(String(u));
      if (String(u).includes("/api/v1/download/pro")) {
        // The route's real macOS answer (site route-macos.test.ts): a zip of Chromium.app.
        return new Response(
          JSON.stringify({
            version: "155.0.8059.39",
            tag: "pro-155.0.8059.39-r43",
            platform: "macos",
            asset: "clearcote-pro-155.0.8059.39-macos-arm64.zip",
            archive: "zip",
            binary: "Chromium",
            url: "https://example.test/file?t=1",
            sha256: sha,
            size: zip.length,
          }),
        );
      }
      return new Response(zip, { headers: { "content-length": String(zip.length) } });
    }) as unknown as typeof fetch;
    const tools: string[] = [];
    macExtractHooks.run = async (file, args) => {
      tools.push(file);
      if (file.endsWith("ditto")) {
        const dest = args[3];
        const app = path.join(dest, "Chromium.app", "Contents");
        fs.mkdirSync(path.join(app, "MacOS"), { recursive: true });
        fs.mkdirSync(path.join(app, "Frameworks", "Chromium Framework.framework", "Resources"), { recursive: true });
        fs.writeFileSync(path.join(app, "Frameworks", "Chromium Framework.framework", "Resources", "Chromium"), "decoy");
        fs.writeFileSync(path.join(app, "MacOS", "Chromium"), "the browser");
      }
      return "";
    };
    const { proEnsureBinary } = await import("../electron/proBinary");
    const exe = await asHost("darwin", "arm64", () => proEnsureBinary("cc_lic_mac_test", "https://example.test"));
    expect(urls[0]).toBe("https://example.test/api/v1/download/pro?platform=macos");
    expect(tools).toEqual(["/usr/bin/ditto", "/usr/bin/xattr"]);
    expect(exe).toBe(path.join(ROOT, "cache", "pro-155.0.8059.39-r43", "browser", "Chromium.app", "Contents", "MacOS", "Chromium"));
    expect(fs.readFileSync(exe, "utf8")).toBe("the browser");
    expect(fs.existsSync(path.join(ROOT, "cache", "pro-155.0.8059.39-r43", ".verified"))).toBe(true);

    // A second launch is a cache hit: no request, no extraction.
    urls.length = 0;
    tools.length = 0;
    expect(await asHost("darwin", "arm64", () => proEnsureBinary("cc_lic_mac_test", "https://example.test"))).toBe(exe);
    expect(urls).toEqual(["https://example.test/api/v1/download/pro?platform=macos"]); // the route is asked, the archive is not
    expect(tools).toEqual([]);
  });

  it("an Intel Mac is refused before anything is fetched", async () => {
    const f = vi.fn();
    globalThis.fetch = f as unknown as typeof fetch;
    const { proEnsureBinary } = await import("../electron/proBinary");
    await expect(asHost("darwin", "x64", () => proEnsureBinary("cc_lic_mac_test", "https://example.test"))).rejects.toThrow(
      /Apple Silicon \(M1 or later\) only; this Mac reports x64/,
    );
    expect(f).not.toHaveBeenCalled();
  });

  it("without the binary name in the answer, macOS still looks for Chromium (not chrome)", async () => {
    const zip = Buffer.from("zip2");
    const sha = createHash("sha256").update(zip).digest("hex");
    globalThis.fetch = vi.fn(async (u: string | URL) =>
      String(u).includes("/download/pro")
        ? new Response(JSON.stringify({ version: "155.0.8059.39", tag: "pro-mac-nobin", asset: "m.zip", url: "https://e/f", sha256: sha, size: zip.length }))
        : new Response(zip),
    ) as unknown as typeof fetch;
    macExtractHooks.run = async (file, args) => {
      if (file.endsWith("ditto")) {
        fs.mkdirSync(path.join(args[3], "Chromium.app", "Contents", "MacOS"), { recursive: true });
        fs.writeFileSync(path.join(args[3], "Chromium.app", "Contents", "MacOS", "Chromium"), "b");
      }
      return "";
    };
    const { proEnsureBinary } = await import("../electron/proBinary");
    const exe = await asHost("darwin", "arm64", () => proEnsureBinary("cc_lic_mac_test", "https://example.test"));
    expect(path.basename(exe)).toBe("Chromium");
  });
});

describe("the version catalog on a Mac", () => {
  it("licensed: Latest is the macOS 155 build, its binary the bundle's Chromium", () => {
    const r = resolveVersion(CAT, "latest", true, "darwin");
    expect(r).toMatchObject({ tier: "pro", version: "155.0.8059.39", selector: "" });
    expect(r.platform).toEqual({ asset: "clearcote-pro-155.0.8059.39-macos-arm64.zip", archive: "zip", binary: "Chromium" });
    expect(resolveVersion(CAT, "155", true, "darwin").selector).toBe("155.0.8059.39");
    expect(resolveVersion(CAT, "155.0.8059.39-r43", true, "darwin").selector).toBe("155.0.8059.39-r43");
  });

  it("only the builds that have a macOS entry are offered", () => {
    expect(listVersions(CAT, "darwin").map((v) => v.major)).toEqual([155]);
    expect(() => resolveVersion(CAT, "154", true, "darwin")).toThrow(/No build matches "154"\. Available: 155 \(pro\)/);
  });

  it("no licence: says the free builds have no macOS version and what to do, for Latest and for a pin", () => {
    expect(() => resolveVersion(CAT, "latest", false, "darwin")).toThrow(MAC_NEEDS_LICENSE);
    expect(() => resolveVersion(CAT, undefined, false, "darwin")).toThrow(MAC_NEEDS_LICENSE);
    expect(() => resolveVersion(CAT, "155", false, "darwin")).toThrow(MAC_NEEDS_LICENSE);
    expect(MAC_NEEDS_LICENSE).toMatch(/licence key in Settings → Licence/);
  });

  it("Windows and Linux resolve as before (lock)", () => {
    expect(platformTag("win32")).toBe("windows");
    expect(platformTag("linux")).toBe("linux");
    expect(resolveVersion(CAT, "latest", true, "win32")).toMatchObject({ version: "155.0.8059.39", platform: { binary: "chrome.exe" } });
    expect(resolveVersion(CAT, "latest", false, "win32")).toMatchObject({ tier: "free", version: "150.0.7871.114" });
    expect(resolveVersion(CAT, "latest", false, "linux")).toMatchObject({ tier: "free", version: "150.0.7871.114", platform: { binary: "chrome" } });
    expect(() => resolveVersion(CAT, "155", false, "win32")).toThrow(/PRO build — set a license key in Settings to use it \(the free build is 150\.0\.7871\.114\)/);
    expect(listVersions(CAT, "linux").map((v) => v.major)).toEqual([155, 154, 150]);
  });

  it("an OS with no build at all still fails, naming the three that have one", () => {
    expect(() => platformTag("freebsd")).toThrow(/Windows x64, Linux x64 and macOS \(Apple Silicon\) only/);
  });
});

describe("the header pill on a Mac", () => {
  const catalogFetch = () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(CAT))) as unknown as typeof fetch;
  };

  it("no licence: 'No browser for this Mac', pointing at the licence — not 'offline'", async () => {
    catalogFetch();
    const { launchTarget, resetLaunchTargetCache } = await import("../electron/launchTarget");
    resetLaunchTargetCache();
    const t = await launchTarget({}, { platform: "darwin", arch: "arm64" });
    expect(t).toMatchObject({ mode: "unavailable", licensed: false, reason: MAC_NEEDS_LICENSE });
    expect(describeTarget(t)).toEqual({ text: "No browser for this Mac", tone: "warn", title: MAC_NEEDS_LICENSE, section: "license" });
  });

  it("an Intel Mac with a licence: unavailable, pointing at Settings → Browser", async () => {
    catalogFetch();
    const { launchTarget, resetLaunchTargetCache } = await import("../electron/launchTarget");
    resetLaunchTargetCache();
    const t = await launchTarget({ licenseKey: "cc_lic_x" }, { platform: "darwin", arch: "x64" });
    expect(t.mode).toBe("unavailable");
    expect(t.reason).toMatch(/Apple Silicon/);
    expect(describeTarget(t).section).toBe("browser");
  });

  it("Apple Silicon with a licence: the managed macOS build", async () => {
    catalogFetch();
    const { launchTarget, resetLaunchTargetCache } = await import("../electron/launchTarget");
    resetLaunchTargetCache();
    const t = await asHost("darwin", "arm64", () => launchTarget({ licenseKey: "cc_lic_x" }, { platform: "darwin", arch: "arm64" }));
    expect(t).toMatchObject({ mode: "managed", licensed: true, major: 155, version: "155.0.8059.39" });
  });

  it("a picked Chromium.app is shown as the executable that will run", async () => {
    const app = path.join(ROOT, "Picked.app");
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents", "MacOS", "Picked"), "b");
    const { launchTarget } = await import("../electron/launchTarget");
    const t = await launchTarget({ binaryPath: app }, { platform: "darwin", arch: "arm64" });
    expect(t).toEqual({ mode: "custom", path: path.join(app, "Contents", "MacOS", "Picked") });
  });

  it("Windows with no licence: the open build, as before (lock)", async () => {
    catalogFetch();
    const { launchTarget, resetLaunchTargetCache } = await import("../electron/launchTarget");
    resetLaunchTargetCache();
    const t = await asHost("win32", "x64", () => launchTarget({}, { platform: "win32" }));
    expect(t).toMatchObject({ mode: "managed", licensed: false, major: 150 });
  });
});
