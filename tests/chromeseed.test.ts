// What Google's servers switch off in every Chrome after its first session (Topics, Attribution Reporting,
// Fenced Frames) is switched off on every profile launch too, in ONE --disable-features switch.
import { describe, expect, it } from "vitest";
import { CHROME_SEED_DISABLED_FEATURES, chromeSeedArgs, fingerprintArgs, mergeFeatureFlags, type FpInput } from "../electron/fpargs";

const ALL = "BrowsingTopics,ConversionMeasurement,FencedFrames,FencedFramesAPIChanges,FencedFramesAutomaticBeaconCredentials,FencedFramesCrossOriginAutomaticBeaconData,FencedFramesCrossOriginEventReporting,FencedFramesLocalUnpartitionedDataAccess,FencedFramesReportEventHeaderChanges,FencedFramesSrcPermissionsPolicy";
const disabled = (args: string[]) => args.filter((a) => a.startsWith("--disable-features="));

describe("chromeSeedArgs", () => {
  it("is the list measured on genuine Chrome, the SDK's own", () => {
    expect(CHROME_SEED_DISABLED_FEATURES.join(",")).toBe(ALL);
    expect(chromeSeedArgs()).toEqual([`--disable-features=${ALL}`]);
    expect(chromeSeedArgs(["--disable-features=Foo", "--lang=fi"])).toEqual([`--disable-features=${ALL}`]);
  });
  it("leaves out a feature the profile's extra flags turn on", () => {
    expect(chromeSeedArgs(["--enable-features=BrowsingTopics,Other"])[0]).toBe(`--disable-features=${ALL.replace("BrowsingTopics,", "")}`);
    expect(chromeSeedArgs(["--enable-features=FencedFrames:implementation_type/mparch"])[0]).toBe(`--disable-features=${ALL.replace(",FencedFrames,", ",")}`);
    expect(chromeSeedArgs([`--enable-features=${ALL}`])).toEqual([]);
  });
});

describe("a profile launch", () => {
  const launchArgs = (p: Partial<FpInput>) => mergeFeatureFlags([...fingerprintArgs({ fingerprint: "s1", ...p } as FpInput, { hostPlatform: "windows" }), ...(p.extraArgs ?? [])]);
  it("carries the list in one switch, on Windows and Linux personas", () => {
    for (const platform of ["windows", "linux"] as const) {
      const off = disabled(launchArgs({ platform }));
      expect(off).toHaveLength(1);
      expect(off[0]).toContain(ALL);
    }
  });
  it("keeps the profile's own disabled features next to it", () => {
    const off = disabled(launchArgs({ extraArgs: ["--disable-features=Foo"], webrtcMdns: "off" } as Partial<FpInput>));
    expect(off).toHaveLength(1);
    for (const f of ["Foo", "WebRtcHideLocalIpsWithMdns", "BrowsingTopics", "FencedFramesSrcPermissionsPolicy"]) expect(off[0]).toContain(f);
  });
  it("lets the profile turn one back on", () => {
    const args = launchArgs({ extraArgs: ["--enable-features=BrowsingTopics"] });
    expect(disabled(args)[0]).not.toContain("BrowsingTopics");
    expect(disabled(args)[0]).toContain("ConversionMeasurement");
    expect(args.find((a) => a.startsWith("--enable-features="))).toContain("BrowsingTopics");
  });
});
