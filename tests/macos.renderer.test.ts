// macOS in the renderer: telling the OS from Electron's navigator, the names the UI uses for the
// browser, the persona a new profile starts with on a Mac, and the two coherence rules a Mac needs.
// The navigator strings are Electron 33's real ones per OS.

import { describe, it, expect } from "vitest";
import { browserCommandName, browserFileName, defaultPersonaPlatform, hostOsFrom, keysLabel, shortcutLabel } from "../src/lib/host";
import { newProfile } from "../src/lib/newProfile";
import { coherenceIssues } from "../src/lib/coherence";
import { applyModel } from "../src/lib/gpuPicker";
import { modelsForVendor } from "../src/lib/gpuModels";
import { fieldByKey } from "../src/lib/fields";

const UA = {
  mac: ["MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) clearcote-profile-manager/0.18.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36"],
  win: ["Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) clearcote-profile-manager/0.18.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36"],
  linux: ["Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) clearcote-profile-manager/0.18.0 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36"],
} as const;

describe("which OS the renderer is on", () => {
  it("reads Electron's navigator on each OS", () => {
    expect(hostOsFrom(...UA.mac)).toBe("macos");
    expect(hostOsFrom(...UA.win)).toBe("windows");
    expect(hostOsFrom(...UA.linux)).toBe("linux");
    expect(hostOsFrom("", "")).toBeUndefined();
  });
  it("an Apple Silicon Mac reports MacIntel too (navigator.platform is frozen there)", () => {
    expect(hostOsFrom("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos");
  });
});

describe("the names the UI uses for the browser", () => {
  it("what to pick, per OS", () => {
    expect(browserFileName("macos")).toBe("Chromium.app");
    expect(browserFileName("windows")).toBe("chrome.exe");
    expect(browserFileName("linux")).toBe("chrome");
    expect(browserFileName(undefined)).toBe("chrome.exe");
  });
  it("the command-line preview's program name, per OS", () => {
    expect(browserCommandName("macos")).toBe("Chromium");
    expect(browserCommandName("windows")).toBe("chrome.exe");
    expect(browserCommandName("linux")).toBe("chrome");
  });
  it("shortcuts read ⌘ on a Mac", () => {
    expect(shortcutLabel("S", "macos")).toBe("⌘S");
    expect(shortcutLabel("S", "windows")).toBe("Ctrl+S");
    expect(shortcutLabel("S", "linux")).toBe("Ctrl+S");
    expect(shortcutLabel(",", undefined)).toBe("Ctrl+,"); // the prerender, before the OS is known
  });
  it("the shortcuts list's key chips read ⌘ on a Mac, and only the Ctrl ones change", () => {
    expect(keysLabel("Ctrl N", "macos")).toBe("⌘ N");
    expect(keysLabel("Ctrl F  or  /", "macos")).toBe("⌘ F  or  /");
    expect(keysLabel("Esc", "macos")).toBe("Esc");
    expect(keysLabel("Ctrl N", "windows")).toBe("Ctrl N");
    expect(keysLabel("Ctrl N", "linux")).toBe("Ctrl N");
  });
});

describe("a new profile's persona", () => {
  it("on a Mac is macOS — the browser's fonts there are the Mac's", () => {
    expect(defaultPersonaPlatform("macos")).toBe("macos");
    expect(newProfile("seed", "t", defaultPersonaPlatform("macos")).platform).toBe("macos");
  });
  it("on Windows and Linux is Windows, as it always was (lock)", () => {
    expect(defaultPersonaPlatform("windows")).toBe("windows");
    expect(defaultPersonaPlatform("linux")).toBe("windows");
    expect(defaultPersonaPlatform(undefined)).toBe("windows");
    expect(newProfile("seed", "t")).toEqual({
      id: "",
      name: "",
      fingerprint: "seed",
      platform: "windows",
      geoip: true,
      widevine: true,
      createdAt: "t",
      updatedAt: "t",
    });
  });
  it("only the platform differs between a Mac's new profile and anyone else's", () => {
    const { platform: a, ...mac } = newProfile("s", "t", "macos");
    const { platform: b, ...win } = newProfile("s", "t");
    expect([a, b]).toEqual(["macos", "windows"]);
    expect(mac).toEqual(win);
  });
});

describe("coherence on a Mac", () => {
  const ids = (p: Record<string, unknown>, host?: "windows" | "linux" | "macos") =>
    coherenceIssues({ fingerprint: "s", widevine: true, ...p } as never, { hostPlatform: host }).map((i) => i.id);

  it("another OS's persona on a Mac is flagged, pointing at the Platform field", () => {
    const issues = coherenceIssues({ fingerprint: "s", widevine: true, platform: "windows" } as never, { hostPlatform: "macos" });
    const i = issues.find((x) => x.id === "persona-platform-on-mac")!;
    expect(i).toMatchObject({ severity: "warn", field: "platform" });
    expect(i.message).toMatch(/macOS's own, but the persona claims windows/);
    expect(i.fix).toMatch(/Set Platform to macos on a Mac, or import a fingerprint captured on windows/);
    expect(fieldByKey(i.field)).toBeDefined();
    expect(ids({ platform: "linux" }, "macos")).toContain("persona-platform-on-mac");
    expect(ids({ platform: "android" }, "macos")).toContain("persona-platform-on-mac");
  });

  it("is quiet for a macOS persona, an unset one (it launches as the host), or a capture from that OS", () => {
    expect(ids({ platform: "macos" }, "macos")).not.toContain("persona-platform-on-mac");
    expect(ids({}, "macos")).not.toContain("persona-platform-on-mac");
    expect(ids({ platform: "windows", fingerprintProfile: "win-capture.json" }, "macos")).not.toContain("persona-platform-on-mac");
  });

  it("never fires off a Mac (lock: a Windows persona on Windows or Linux is unchanged)", () => {
    for (const host of ["windows", "linux", undefined] as const) {
      expect(ids({ platform: "windows" }, host)).not.toContain("persona-platform-on-mac");
      expect(ids({ platform: "macos" }, host)).not.toContain("persona-platform-on-mac");
    }
  });

  it("a macOS persona given a picker model (a Direct3D string) is flagged — macOS draws through Metal", () => {
    const m = modelsForVendor("nvidia")[0];
    const picked = applyModel({ platform: "macos" } as { platform: string; gpuVendor?: string; gpuRenderer?: string }, m);
    expect(picked.gpuRenderer).toMatch(/Direct3D11/); // the table's only non-Linux form
    const issue = coherenceIssues({ fingerprint: "s", widevine: true, ...picked } as never, {}).find((i) => i.id === "gpu-direct3d-on-macos")!;
    expect(issue).toMatchObject({ severity: "warn", field: "gpuModel" });
    expect(issue.fix).toMatch(/Persona default/);
    expect(fieldByKey(issue.field)).toBeDefined();
  });

  it("is quiet for a Metal string, a Windows persona with Direct3D, or with the real GPU on", () => {
    const metal = "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)";
    const d3d = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 (0x00002484) Direct3D11 vs_5_0 ps_5_0, D3D11)";
    expect(ids({ platform: "macos", gpuRenderer: metal })).not.toContain("gpu-direct3d-on-macos");
    expect(ids({ platform: "windows", gpuRenderer: d3d })).not.toContain("gpu-direct3d-on-macos");
    expect(ids({ platform: "macos", gpuRenderer: d3d, disableGpuFingerprint: true })).not.toContain("gpu-direct3d-on-macos");
    expect(ids({ platform: "macos", gpuRenderer: d3d })).toContain("gpu-direct3d-on-macos");
  });

  it("a fresh profile on a Mac opens with no macOS warning at all", () => {
    const fresh = newProfile("s", "t", "macos");
    const got = coherenceIssues(fresh as never, { hostPlatform: "macos" }).map((i) => i.id);
    expect(got).not.toContain("persona-platform-on-mac");
    expect(got).not.toContain("gpu-direct3d-on-macos");
  });
});
