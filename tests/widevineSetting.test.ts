// Widevine Auto / On / Off (0.42.5): the setting reader (electron + its renderer mirror), the launch decision,
// and what the renderer can tell about a held-back Auto.
import { describe, expect, it } from "vitest";
import { widevineDecision, widevineSetting as mainSetting, CDM_HOST_VERIFY_SYMBOL, WIDEVINE_HELD_BACK_NOTE } from "../electron/widevine";
import { autoHeldBack, widevineSetting as rendererSetting, MIN_REVISION_CDM_HOST_VERIFICATION } from "../src/lib/widevineSetting";

const VALUES: unknown[] = [undefined, null, "", true, false, "on", "off", "auto", "garbage", 1, 0];

describe("widevineSetting", () => {
  it("reads 'auto' and the old checkbox's true as Auto; 'on' as On; 'off', false and a missing value as Off", () => {
    expect(mainSetting("auto")).toBe("auto");
    expect(mainSetting(true)).toBe("auto");
    expect(mainSetting(undefined)).toBe("off"); // the old checkbox stored nothing when unticked
    expect(mainSetting("")).toBe("off");
    expect(mainSetting("on")).toBe("on");
    expect(mainSetting("off")).toBe("off");
    expect(mainSetting(false)).toBe("off");
  });
  it("the renderer mirror answers exactly like the main process", () => {
    for (const v of VALUES) expect(rendererSetting(v), String(v)).toBe(mainSetting(v));
  });
});

describe("widevineDecision", () => {
  const verified = () => true;
  const unverified = () => false;
  it("Auto on Windows/macOS seeds only with host verification, and says when it held back", () => {
    for (const platform of ["win32", "darwin"] as const) {
      expect(widevineDecision("auto", verified, platform)).toEqual({ seed: true, heldBack: false });
      expect(widevineDecision("auto", unverified, platform)).toEqual({ seed: false, heldBack: true });
      expect(widevineDecision(true, unverified, platform)).toEqual({ seed: false, heldBack: true }); // old default = Auto
    }
  });
  it("Auto on Linux always seeds and never reads the binary", () => {
    expect(widevineDecision("auto", () => { throw new Error("probed"); }, "linux")).toEqual({ seed: true, heldBack: false });
  });
  it("On always seeds, Off never, whatever the engine", () => {
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(widevineDecision("on", unverified, platform)).toEqual({ seed: true, heldBack: false });
      expect(widevineDecision("off", verified, platform)).toEqual({ seed: false, heldBack: false });
      expect(widevineDecision(false, verified, platform)).toEqual({ seed: false, heldBack: false });
    }
  });
  it("probes the symbol a host-verified CDM host carries, and its note names the way out", () => {
    expect(CDM_HOST_VERIFY_SYMBOL).toBe("VerifyCdmHost_0");
    expect(WIDEVINE_HELD_BACK_NOTE).toContain("r63");
    expect(WIDEVINE_HELD_BACK_NOTE).toContain("Choose On");
  });
});

describe("autoHeldBack (renderer)", () => {
  it("is true on Windows/macOS for the open build and PRO revisions before r63", () => {
    expect(MIN_REVISION_CDM_HOST_VERIFICATION).toBe(63);
    expect(autoHeldBack({ hostPlatform: "windows", tier: "pro", revision: 62 })).toBe(true);
    expect(autoHeldBack({ hostPlatform: "macos", tier: "pro", revision: 49 })).toBe(true);
    expect(autoHeldBack({ hostPlatform: "windows", tier: "free" })).toBe(true);
  });
  it("is false from r63 and on Linux, and unknown without a host or a revision", () => {
    expect(autoHeldBack({ hostPlatform: "windows", tier: "pro", revision: 63 })).toBe(false);
    expect(autoHeldBack({ hostPlatform: "linux", tier: "free" })).toBe(false);
    expect(autoHeldBack({ hostPlatform: "windows", tier: "pro" })).toBeUndefined();
    expect(autoHeldBack({})).toBeUndefined();
  });
});
