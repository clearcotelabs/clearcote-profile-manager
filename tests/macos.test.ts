// macOS support, the pieces that do not launch anything: which Macs have a build, where the browser
// sits inside its bundle, how a picked `.app` resolves, how the zip is unpacked, the Widevine CDM a
// Mac asks Google for, the keychain switch, and the app's own icon + picker. Hermetic: the darwin
// paths run on any host (the platform is a parameter), and the one test that needs a real Mac
// (ditto on a real bundle) runs only there — in CI on macos-latest.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appBinary,
  buildPlatformFor,
  bundleExecutable,
  catalogPlatformFor,
  defaultBinaryName,
  extractMacBundle,
  macExtractHooks,
  plistExecutable,
} from "../electron/macos";
import { findFile } from "../electron/proBinary";
import { cdmPlatform, omahaRequestBody, omahaUserAgent } from "../electron/widevine";
import { macosKeychainArgs, MOCK_KEYCHAIN_SWITCH } from "../electron/fpargs";
import { iconSource, pickBinaryDialog } from "../electron/hostui";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-mac-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const touch = (f: string, body = "x") => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  return f;
};

/** The real macOS PRO bundle's shape (SDK CRITICAL_MAC + the helper apps inside the framework),
 *  with a decoy file named "Chromium" inside the framework, where a plain name search lands first:
 *  "Frameworks" sorts before "MacOS". */
function fakeBundle(root: string, plist = true): string {
  const app = path.join(root, "Chromium.app");
  const fw = path.join(app, "Contents", "Frameworks", "Chromium Framework.framework");
  touch(path.join(fw, "Versions", "155.0.8059.39", "Chromium Framework"), "framework");
  touch(path.join(fw, "Versions", "155.0.8059.39", "Helpers", "Chromium Helper.app", "Contents", "MacOS", "Chromium Helper"));
  touch(path.join(fw, "Versions", "155.0.8059.39", "Resources", "Chromium"), "decoy");
  if (plist) {
    touch(
      path.join(app, "Contents", "Info.plist"),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Chromium</string>' +
        "<key>CFBundleIdentifier</key><string>org.chromium.Chromium</string></dict></plist>",
    );
  }
  return touch(path.join(app, "Contents", "MacOS", "Chromium"), "the browser");
}

describe("which Macs have a build", () => {
  it("the catalog key is macos on any Mac, and the other OSes are as before", () => {
    expect(catalogPlatformFor("darwin")).toBe("macos");
    expect(catalogPlatformFor("win32")).toBe("windows");
    expect(catalogPlatformFor("linux")).toBe("linux");
    expect(catalogPlatformFor("freebsd")).toBeNull();
  });

  it("a download on Apple Silicon asks for macos", () => {
    expect(buildPlatformFor("darwin", "arm64")).toBe("macos");
  });

  it("an Intel Mac is told the build is Apple Silicon only, and what to do instead", () => {
    expect(() => buildPlatformFor("darwin", "x64")).toThrow(/Apple Silicon.*reports x64/);
    expect(() => buildPlatformFor("darwin", "x64")).toThrow(/browser binary in Settings → Browser, or run the profile in the cloud/);
  });

  it("Windows and Linux are unchanged, whatever the CPU field says", () => {
    expect(buildPlatformFor("win32", "x64")).toBe("windows");
    expect(buildPlatformFor("linux", "x64")).toBe("linux");
    expect(buildPlatformFor("linux", "arm64")).toBe("linux");
    expect(() => buildPlatformFor("freebsd", "x64")).toThrow(/Windows x64, Linux x64 and macOS/);
  });

  it("the browser's file name per platform", () => {
    expect(defaultBinaryName("windows")).toBe("chrome.exe");
    expect(defaultBinaryName("linux")).toBe("chrome");
    expect(defaultBinaryName("macos")).toBe("Chromium");
  });
});

describe("finding the browser inside an extracted build", () => {
  it("a macOS bundle resolves to Chromium.app/Contents/MacOS/Chromium, never the framework's decoy", () => {
    const exe = fakeBundle(tmp);
    expect(findFile(tmp, "Chromium")).toBe(exe);
    expect(appBinary(tmp, "Chromium")).toBe(exe);
  });

  it("one folder down (an archive with a top-level folder) is found too", () => {
    const exe = fakeBundle(path.join(tmp, "clearcote-pro-155.0.8059.39-macos-arm64"));
    expect(findFile(tmp, "Chromium")).toBe(exe);
  });

  it("the name search never descends into a framework", () => {
    touch(path.join(tmp, "X.framework", "Versions", "A", "Chromium"));
    expect(findFile(tmp, "Chromium")).toBeNull();
  });

  it("a flat Windows / Linux tree is found exactly as before", () => {
    const win = touch(path.join(tmp, "win", "clearcote", "chrome.exe"));
    const lin = touch(path.join(tmp, "lin", "chrome"));
    expect(findFile(path.join(tmp, "win"), "chrome.exe")).toBe(win);
    expect(findFile(path.join(tmp, "lin"), "chrome")).toBe(lin);
    expect(findFile(path.join(tmp, "win"), "CHROME.EXE")).toBe(win); // case-insensitive, as it was
  });
});

describe("a picked .app resolves to the executable inside it", () => {
  it("by CFBundleExecutable from Info.plist", () => {
    fs.mkdirSync(path.join(tmp, "Clearcote.app", "Contents", "MacOS"), { recursive: true });
    touch(
      path.join(tmp, "Clearcote.app", "Contents", "Info.plist"),
      "<plist><dict><key>CFBundleExecutable</key>\n  <string>Chromium</string></dict></plist>",
    );
    const exe = touch(path.join(tmp, "Clearcote.app", "Contents", "MacOS", "Chromium"));
    touch(path.join(tmp, "Clearcote.app", "Contents", "MacOS", "other"));
    expect(bundleExecutable(path.join(tmp, "Clearcote.app"))).toBe(exe);
    expect(bundleExecutable(path.join(tmp, "Clearcote.app") + "/")).toBe(exe);
  });

  it("without a readable Info.plist, the file named after the bundle", () => {
    const exe = fakeBundle(tmp, false);
    expect(bundleExecutable(path.join(tmp, "Chromium.app"))).toBe(exe);
  });

  it("else the only file in Contents/MacOS", () => {
    const exe = touch(path.join(tmp, "Renamed.app", "Contents", "MacOS", "Chromium"));
    expect(bundleExecutable(path.join(tmp, "Renamed.app"))).toBe(exe);
  });

  it("anything else comes back unchanged", () => {
    const file = touch(path.join(tmp, "chrome.exe"));
    expect(bundleExecutable(file)).toBe(file);
    expect(bundleExecutable(path.join(tmp, "missing.app"))).toBe(path.join(tmp, "missing.app"));
    const notDir = touch(path.join(tmp, "file.app")); // a FILE named .app
    expect(bundleExecutable(notDir)).toBe(notDir);
    const empty = path.join(tmp, "Empty.app");
    fs.mkdirSync(empty);
    expect(bundleExecutable(empty)).toBe(empty); // no executable: left for the spawn to report
  });

  it("plistExecutable reads the XML form and gives up on anything else", () => {
    expect(plistExecutable("<key>CFBundleExecutable</key><string> Chromium </string>")).toBe("Chromium");
    expect(plistExecutable("bplist00\u0000\u0001")).toBeNull();
    expect(plistExecutable("<key>CFBundleName</key><string>Chromium</string>")).toBeNull();
  });
});

describe("unpacking the macOS zip", () => {
  const real = macExtractHooks.run;
  afterEach(() => {
    macExtractHooks.run = real;
  });

  it("uses ditto, then clears the quarantine from every bundle it unpacked", async () => {
    const calls: Array<[string, string[]]> = [];
    macExtractHooks.run = async (file, args) => {
      calls.push([file, args]);
      if (file.endsWith("ditto")) fakeBundle(args[3]);
      return "";
    };
    const dest = path.join(tmp, "incoming");
    await extractMacBundle("b.zip", "/x/b.zip", dest);
    expect(calls[0]).toEqual(["/usr/bin/ditto", ["-x", "-k", "/x/b.zip", dest]]);
    expect(calls.slice(1)).toEqual([["/usr/bin/xattr", ["-dr", "com.apple.quarantine", path.join(dest, "Chromium.app")]]]);
  });

  it("falls back to unzip when ditto is missing", async () => {
    const calls: string[] = [];
    macExtractHooks.run = async (file) => {
      calls.push(file);
      if (file.endsWith("ditto")) throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      return "";
    };
    await extractMacBundle("b.zip", "/x/b.zip", path.join(tmp, "in"));
    expect(calls).toEqual(["/usr/bin/ditto", "/usr/bin/unzip", "/usr/bin/xattr"]);
  });

  it("a ditto that runs and fails is reported, not papered over by unzip", async () => {
    macExtractHooks.run = async (file) => {
      if (file.endsWith("ditto")) throw Object.assign(new Error("ditto: Couldn't read PKZip signature"), { code: 1 });
      return "";
    };
    await expect(extractMacBundle("b.zip", "/x/b.zip", path.join(tmp, "in"))).rejects.toThrow(
      /Could not unpack b\.zip with \/usr\/bin\/ditto: ditto: Couldn't read PKZip signature/,
    );
  });

  it("no ditto and no unzip: says what it needs", async () => {
    macExtractHooks.run = async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    await expect(extractMacBundle("b.zip", "/x/b.zip", path.join(tmp, "in"))).rejects.toThrow(/needs \/usr\/bin\/ditto or \/usr\/bin\/unzip/);
  });

  it("a failing xattr does not fail the extraction (clearing the quarantine is best-effort)", async () => {
    macExtractHooks.run = async (file, args) => {
      if (file.endsWith("ditto")) fakeBundle(args[3]);
      if (file.endsWith("xattr")) throw new Error("xattr: No such xattr");
      return "";
    };
    await expect(extractMacBundle("b.zip", "/x/b.zip", path.join(tmp, "in"))).resolves.toBeUndefined();
  });

  // The real thing, on a real Mac (CI macos-latest): a bundle with a framework symlink, zipped and
  // unpacked by ditto, keeps the symlink and the exec bit, and resolves to the right executable.
  it.runIf(process.platform === "darwin")("ditto round-trip on a real Mac keeps the bundle's symlinks and exec bits", async () => {
    const src = path.join(tmp, "src");
    const exe = fakeBundle(src);
    fs.chmodSync(exe, 0o755);
    const fw = path.join(src, "Chromium.app", "Contents", "Frameworks", "Chromium Framework.framework");
    fs.symlinkSync("155.0.8059.39", path.join(fw, "Versions", "Current"));
    const zip = path.join(tmp, "b.zip");
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", path.join(src, "Chromium.app"), zip]);
    const dest = path.join(tmp, "out");
    await extractMacBundle("b.zip", zip, dest);
    const got = findFile(dest, "Chromium")!;
    expect(got).toBe(path.join(dest, "Chromium.app", "Contents", "MacOS", "Chromium"));
    expect(fs.statSync(got).mode & 0o111).not.toBe(0);
    const current = path.join(dest, "Chromium.app", "Contents", "Frameworks", "Chromium Framework.framework", "Versions", "Current");
    expect(fs.lstatSync(current).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(current, "Chromium Framework"), "utf8")).toBe("framework");
  });
});

describe("Widevine on a Mac", () => {
  it("asks for the Apple Silicon CDM, as Google's server publishes it (mac_arm64, libwidevinecdm.dylib)", () => {
    expect(cdmPlatform("darwin", "arm64")).toMatchObject({ atOs: "mac", osPlatform: "Mac OS X", subdir: "mac_arm64", filename: "libwidevinecdm.dylib", arch: "arm64" });
    const body = omahaRequestBody("darwin", "arm64") as any;
    expect(body.request["@os"]).toBe("mac");
    expect(body.request.arch).toBe("arm64");
    expect(body.request.os).toEqual({ arch: "arm64", platform: "Mac OS X", version: "14.0.0" });
    expect(omahaUserAgent("darwin")).toMatch(/Macintosh; Intel Mac OS X 10_15_7/); // what Chrome on Apple Silicon sends too
  });

  it("an Intel Mac asks for the x64 one", () => {
    expect(cdmPlatform("darwin", "x64")).toMatchObject({ subdir: "mac_x64", filename: "libwidevinecdm.dylib", arch: "x64" });
  });

  it("Windows and Linux requests are byte-for-byte what they were", () => {
    const old = (atOs: string, platform: string, version: string) => ({
      request: {
        "@os": atOs,
        "@updater": "clearcote",
        acceptformat: "crx3",
        protocol: "3.1",
        arch: "x64",
        nacl_arch: "x86-64",
        prodversion: "151.0.0.0",
        updaterversion: "151.0.0.0",
        dedup: "cr",
        os: { arch: "x86_64", platform, version },
        app: [{ appid: "oimompecagnajdejgnnjijobebaeigek", version: "0.0.0.0", updatecheck: {}, ping: { r: -2 } }],
      },
    });
    expect(JSON.stringify(omahaRequestBody("win32", "x64"))).toBe(JSON.stringify(old("win", "Windows", "10.0.19045.0")));
    expect(JSON.stringify(omahaRequestBody("linux", "x64"))).toBe(JSON.stringify(old("Linux", "Linux", "6.1.0")));
    // arm64 Windows/Linux hosts still ask for x64, as before (the browser there is x64).
    expect(JSON.stringify(omahaRequestBody("win32", "arm64"))).toBe(JSON.stringify(old("win", "Windows", "10.0.19045.0")));
    expect(cdmPlatform("win32")).toMatchObject({ subdir: "win_x64", filename: "widevinecdm.dll" });
    expect(cdmPlatform("linux")).toMatchObject({ subdir: "linux_x64", filename: "libwidevinecdm.so" });
    expect(omahaUserAgent("win32")).toMatch(/Windows NT 10\.0/);
    expect(omahaUserAgent("linux")).toMatch(/X11; Linux x86_64/);
  });
});

describe("--use-mock-keychain", () => {
  it("on macOS: no Safe Storage keychain prompt on every launch of the unsigned build", () => {
    expect(macosKeychainArgs("darwin", [])).toEqual([MOCK_KEYCHAIN_SWITCH]);
    expect(MOCK_KEYCHAIN_SWITCH).toBe("--use-mock-keychain");
  });
  it("never twice when extraArgs already has it", () => {
    expect(macosKeychainArgs("darwin", ["--use-mock-keychain"])).toEqual([]);
  });
  it("nothing on Windows or Linux", () => {
    expect(macosKeychainArgs("win32", [])).toEqual([]);
    expect(macosKeychainArgs("linux", [])).toEqual([]);
  });
});

describe("the app's own icon and the browser picker", () => {
  it("on macOS the tray icon comes from the .app bundle, not the executable inside it", () => {
    expect(iconSource("/Applications/Clearcote Profile Manager.app/Contents/MacOS/Clearcote Profile Manager", "darwin")).toBe(
      "/Applications/Clearcote Profile Manager.app",
    );
    // not inside a bundle (a bare electron binary): the executable, as before
    expect(iconSource("/usr/local/bin/electron", "darwin")).toBe("/usr/local/bin/electron");
  });
  it("Windows and Linux use the executable, as before", () => {
    expect(iconSource("C:\\Apps\\Clearcote\\Clearcote Profile Manager.exe", "win32")).toBe("C:\\Apps\\Clearcote\\Clearcote Profile Manager.exe");
    expect(iconSource("/opt/clearcote/clearcote-profile-manager", "linux")).toBe("/opt/clearcote/clearcote-profile-manager");
  });
  it("the picker offers .app bundles on macOS, and is unchanged elsewhere", () => {
    expect(pickBinaryDialog("darwin")).toMatchObject({
      title: "Select the Clearcote browser (Chromium.app)",
      properties: ["openFile"],
      filters: [{ name: "Applications", extensions: ["app"] }, { name: "All files", extensions: ["*"] }],
    });
    expect(pickBinaryDialog("win32")).toEqual({
      title: "Select the Clearcote chrome.exe",
      properties: ["openFile"],
      filters: [{ name: "Clearcote browser", extensions: ["exe"] }],
    });
    expect(pickBinaryDialog("linux")).toEqual({
      title: "Select the Clearcote chrome binary",
      properties: ["openFile"],
      filters: [{ name: "All files", extensions: ["*"] }],
    });
  });
});
