// macOS packaging and updates. What it pins:
//   - the release's file names, as electron-builder will produce them from package.json, never
//     collide across platforms, and macOS ships disk images only
//   - the in-app update picks this Mac's own disk image, and every Windows / Linux copy — including
//     copies released BEFORE macOS existed, which take "the first .zip" — still gets its own file
//   - the afterPack hook ad-hoc signs the macOS app and leaves every other platform's alone
//   - the release workflow builds, checksums, attests and publishes the disk images; the test
//     workflow runs on a Mac

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pickAsset, type UpdateAsset } from "../electron/appupdate";

const require_ = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const build = pkg.build;
const read = (f: string) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

/** electron-builder's ${…} macros for one artifact. */
const name = (tpl: string, vars: Record<string, string>) => tpl.replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? `\${${k}}`);

/** Every file a release of version `v` carries, by the package.json templates. electron-builder
 *  names the Linux AppImage's arch x86_64 and everything else's x64. */
function releaseAssets(v: string): string[] {
  return [
    name(build.nsis.artifactName, { version: v, ext: "exe" }),
    name(build.artifactName, { version: v, arch: "x64", ext: "zip" }),
    name(build.artifactName, { version: v, arch: "x86_64", ext: "AppImage" }),
    name(build.artifactName, { version: v, arch: "x64", ext: "tar.gz" }),
    ...build.mac.target.flatMap((t: { target: string; arch: string[] }) =>
      t.arch.map((arch) => name(build.dmg.artifactName, { version: v, arch, ext: t.target })),
    ),
    "SHA256SUMS.txt",
  ];
}

const asAssets = (names: string[]): UpdateAsset[] => names.map((n) => ({ name: n, url: `https://gh/${n}`, size: 1 }));

describe("the release's file names", () => {
  const files = releaseAssets("0.18.0");

  it("are what the release notes and the updater expect", () => {
    expect(files).toEqual([
      "Clearcote-Profile-Manager-0.18.0-setup.exe",
      "Clearcote-Profile-Manager-0.18.0-x64.zip",
      "Clearcote-Profile-Manager-0.18.0-x86_64.AppImage",
      "Clearcote-Profile-Manager-0.18.0-x64.tar.gz",
      "Clearcote-Profile-Manager-0.18.0-mac-arm64.dmg",
      "Clearcote-Profile-Manager-0.18.0-mac-x64.dmg",
      "SHA256SUMS.txt",
    ]);
  });

  it("never collide (an Intel Mac build named like the Windows x64 zip would overwrite it)", () => {
    expect(new Set(files).size).toBe(files.length);
  });

  it("macOS ships disk images only — one per CPU — and never a .zip", () => {
    expect(build.mac.target).toEqual([{ target: "dmg", arch: ["arm64", "x64"] }]);
    expect(files.filter((f) => f.endsWith(".zip"))).toEqual(["Clearcote-Profile-Manager-0.18.0-x64.zip"]);
  });

  it("the mac build is unsigned by identity, ad-hoc signed by the hook, and gets a real icon", () => {
    expect(build.mac.identity).toBeNull();
    expect(build.mac.hardenedRuntime).toBe(false);
    expect(fs.existsSync(path.join(__dirname, "..", build.mac.icon))).toBe(true);
    expect(build.afterPack).toBe("./scripts/mac-adhoc-sign.cjs");
    expect(pkg.scripts["dist:mac"]).toBe("npm run build && electron-builder --mac --publish never");
  });
});

describe("the in-app update on every platform", () => {
  const rel = asAssets(releaseAssets("0.18.0"));
  const winInstalled = { platform: "win32" as const, execPath: "C:/Apps/Clearcote/app.exe", existsSync: (p: string) => /Uninstall/.test(p) };
  const winPortable = { platform: "win32" as const, execPath: "C:/Tools/Clearcote/app.exe", existsSync: () => false };

  it("an Apple Silicon Mac gets the arm64 disk image, an Intel Mac the x64 one", () => {
    const mac = { execPath: "/Applications/Clearcote Profile Manager.app/Contents/MacOS/Clearcote Profile Manager", platform: "darwin" as const };
    expect(pickAsset(rel, { ...mac, arch: "arm64" })?.name).toBe("Clearcote-Profile-Manager-0.18.0-mac-arm64.dmg");
    expect(pickAsset(rel, { ...mac, arch: "x64" })?.name).toBe("Clearcote-Profile-Manager-0.18.0-mac-x64.dmg");
  });

  it("a Mac is never handed another OS's file — a release without disk images offers none", () => {
    const old = asAssets(["Clearcote-Profile-Manager-0.17.1-setup.exe", "Clearcote-Profile-Manager-0.17.1-x64.zip", "Clearcote-Profile-Manager-0.17.1-x86_64.AppImage"]);
    expect(pickAsset(old, { execPath: "/Applications/X.app/Contents/MacOS/X", platform: "darwin", arch: "arm64" })).toBeUndefined();
  });

  it("Windows and Linux copies of THIS version get their own files (lock)", () => {
    expect(pickAsset(rel, winInstalled)?.name).toBe("Clearcote-Profile-Manager-0.18.0-setup.exe");
    expect(pickAsset(rel, winPortable)?.name).toBe("Clearcote-Profile-Manager-0.18.0-x64.zip");
    expect(pickAsset(rel, { platform: "linux", execPath: "/opt/c/c", appImage: "/home/u/C.AppImage" })?.name).toBe("Clearcote-Profile-Manager-0.18.0-x86_64.AppImage");
    expect(pickAsset(rel, { platform: "linux", execPath: "/opt/c/c", appImage: "" })?.name).toBe("Clearcote-Profile-Manager-0.18.0-x64.tar.gz");
  });

  it("a portable Windows copy skips a -mac- zip even if one is listed first", () => {
    const withMacZip = asAssets(["Clearcote-Profile-Manager-0.18.0-mac-arm64.zip", ...releaseAssets("0.18.0")]);
    expect(pickAsset(withMacZip, winPortable)?.name).toBe("Clearcote-Profile-Manager-0.18.0-x64.zip");
  });

  // The pickAsset that shipped in 0.17.1 and before — what every installed copy will run against
  // the first release that has macOS in it. Copied verbatim (Windows half), since those copies
  // cannot be changed.
  function pickAsset0171(assets: UpdateAsset[], opts: { platform: string; installed: boolean; appImage?: string }) {
    const find = (re: RegExp) => assets.find((a) => re.test(a.name));
    if (opts.platform === "linux") {
      const appImage = find(/\.AppImage$/i);
      const tarball = find(/\.tar\.gz$/i);
      return opts.appImage ? appImage ?? tarball : tarball ?? appImage;
    }
    const setup = find(/setup\.exe$/i);
    const zip = find(/\.zip$/i);
    return opts.installed ? setup : zip ?? setup;
  }

  it("copies from before macOS still get their own file from a release that has disk images", () => {
    // GitHub lists assets in upload order, and the publish step globs *.zip before *.dmg; sort both
    // ways so neither order can hand an old copy the wrong file.
    for (const order of [releaseAssets("0.18.0"), [...releaseAssets("0.18.0")].sort(), [...releaseAssets("0.18.0")].reverse()]) {
      const a = asAssets(order);
      expect(pickAsset0171(a, { platform: "win32", installed: false })?.name).toBe("Clearcote-Profile-Manager-0.18.0-x64.zip");
      expect(pickAsset0171(a, { platform: "win32", installed: true })?.name).toBe("Clearcote-Profile-Manager-0.18.0-setup.exe");
      expect(pickAsset0171(a, { platform: "linux", installed: false, appImage: "/x" })?.name).toBe("Clearcote-Profile-Manager-0.18.0-x86_64.AppImage");
      expect(pickAsset0171(a, { platform: "linux", installed: false })?.name).toBe("Clearcote-Profile-Manager-0.18.0-x64.tar.gz");
    }
  });
});

describe("the afterPack hook: ad-hoc signing", () => {
  const hook = require_("../scripts/mac-adhoc-sign.cjs") as {
    adhocSign: (ctx: unknown, run: (f: string, a: string[], o: unknown) => void) => string | null;
    default: (ctx: unknown) => Promise<void>;
  };
  const ctx = (platform: string) => ({
    electronPlatformName: platform,
    appOutDir: "/build/release/mac-arm64",
    packager: { appInfo: { productFilename: "Clearcote Profile Manager" } },
  });

  it("signs the macOS app ad hoc, deep, then verifies it strictly", () => {
    const calls: Array<[string, string[]]> = [];
    const app = hook.adhocSign(ctx("darwin"), (f, a) => calls.push([f, a]));
    const want = path.join("/build/release/mac-arm64", "Clearcote Profile Manager.app");
    expect(app).toBe(want);
    expect(calls).toEqual([
      ["codesign", ["--force", "--deep", "--sign", "-", want]],
      ["codesign", ["--verify", "--deep", "--strict", "--verbose=2", want]],
    ]);
  });

  it("does nothing for Windows and Linux packages", async () => {
    for (const p of ["win32", "linux"]) {
      const calls: unknown[] = [];
      expect(hook.adhocSign(ctx(p), () => calls.push(1))).toBeNull();
      expect(calls).toEqual([]);
      await expect(hook.default(ctx(p))).resolves.toBeUndefined(); // the real hook, no codesign on PATH needed
    }
  });

  it("a failing verify fails the build (the error is not swallowed)", () => {
    expect(() =>
      hook.adhocSign(ctx("darwin"), (_f, a) => {
        if (a[0] === "--verify") throw new Error("code object is not signed at all");
      }),
    ).toThrow(/not signed/);
  });
});

describe("the workflows", () => {
  const release = read(".github/workflows/release.yml");
  const test = read(".github/workflows/test.yml");

  it("release: a macos-latest job collects the disk images", () => {
    expect(release).toMatch(/- os: macos-latest\s+name: macos[\s\S]*?artifacts: \|\s+release\/\*\.dmg/);
  });

  it("release: the disk images are checksummed, attested and published", () => {
    expect(release).toMatch(/files=\(\*\.exe \*\.zip \*\.AppImage \*\.tar\.gz \*\.dmg\)/);
    const attest = release.slice(release.indexOf("Attest build provenance"), release.indexOf("Publish GitHub Release"));
    expect(attest).toContain("release/*.dmg");
    const publish = release.slice(release.indexOf("Publish GitHub Release"));
    expect(publish.slice(0, publish.indexOf("body:"))).toContain("release/*.dmg");
    expect(publish).toContain("mac-arm64.dmg");
  });

  it("test: runs on macOS as well as Linux", () => {
    expect(test).toMatch(/os: \[ubuntu-latest, macos-latest\]/);
    expect(test).toContain("runs-on: ${{ matrix.os }}");
  });
});
