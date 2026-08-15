// The update check. Three things here are load-bearing and easy to get subtly wrong: comparing
// versions, picking the asset that matches how the app was installed, and reading the checksums.

import { describe, it, expect } from "vitest";
import { compareVersions, pickAsset, parseSums, type UpdateAsset } from "../electron/appupdate";

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

describe("pickAsset — match how the app was installed", () => {
  const assets: UpdateAsset[] = [
    { name: "Clearcote-Profile-Manager-0.10.0-setup.exe", url: "u1", size: 1 },
    { name: "Clearcote-Profile-Manager-0.10.0-x64.zip", url: "u2", size: 2 },
    { name: "SHA256SUMS.txt", url: "u3", size: 3 },
  ];

  it("an NSIS install gets the installer — it sits beside its uninstaller", () => {
    const got = pickAsset(assets, {
      execPath: "C:/Apps/Clearcote/app.exe",
      existsSync: (p) => p.includes("Uninstall"),
    });
    expect(got?.name).toMatch(/setup\.exe$/);
  });

  it("a portable copy gets the zip, never the installer", () => {
    // Handing a zip user an installer would silently create a SECOND, separate installation while
    // they carry on running the old folder.
    const got = pickAsset(assets, { execPath: "D:/portable/cc/app.exe", existsSync: () => false });
    expect(got?.name).toMatch(/\.zip$/);
  });

  it("never offers the checksums file as the download", () => {
    for (const exists of [() => true, () => false]) {
      expect(pickAsset(assets, { execPath: "C:/x/app.exe", existsSync: exists })?.name).not.toMatch(/SHA256SUMS/);
    }
  });

  it("returns nothing when the release has no usable asset", () => {
    expect(pickAsset([{ name: "SHA256SUMS.txt", url: "u", size: 1 }], { execPath: "C:/x/app.exe", existsSync: () => false })).toBeUndefined();
    expect(pickAsset([], { execPath: "C:/x/app.exe", existsSync: () => false })).toBeUndefined();
  });

  it("falls back to the installer when only it is published", () => {
    const only = [assets[0]];
    expect(pickAsset(only, { execPath: "C:/x/app.exe", existsSync: () => false })?.name).toMatch(/setup\.exe$/);
  });

  it("survives a filesystem that throws", () => {
    expect(() =>
      pickAsset(assets, {
        execPath: "C:/x/app.exe",
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
