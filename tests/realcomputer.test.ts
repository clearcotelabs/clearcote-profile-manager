// "This computer" (realComputer): this computer's screen / touch / display language instead of the persona's.
// The readers are the SDK's (sdk/node/test/realcomputer.test.ts covers them in depth); here: the profile rules.
import { describe, expect, it, vi } from "vitest";
import { applyRealComputer, parseWindows, realComputerParts, type HostFacts } from "../electron/realcomputer";
import type { Profile } from "../electron/types";
import { fieldByKey } from "../src/lib/fields";

const FACTS: HostFacts = { display: { width: 3440, height: 1440, availWidth: 3440, availHeight: 1392, devicePixelRatio: 1 }, touch: 2, language: "en-GB" };
const read = (f: HostFacts = FACTS) => vi.fn(async () => f);
const prof = (over: Partial<Profile> = {}) => ({ id: "p", name: "p", fingerprint: "s1", createdAt: "", updatedAt: "", ...over }) as Profile;

describe("realComputerParts", () => {
  it("'all' and true are every part, 'screen' the screen, an SDK object picks, anything else is off", () => {
    expect(realComputerParts("all")).toEqual({ screen: true, touch: true, languages: true });
    expect(realComputerParts(true)).toEqual({ screen: true, touch: true, languages: true });
    expect(realComputerParts("screen")).toEqual({ screen: true, touch: false, languages: false });
    expect(realComputerParts({ touch: true })).toEqual({ screen: false, touch: true, languages: false });
    expect(realComputerParts(undefined)).toEqual({ screen: false, touch: false, languages: false });
  });
  it("the Windows reader is the SDK's", () => expect(parseWindows("3440 1440 3440 1392 96 2 en-GB")).toEqual(FACTS));
});

describe("applyRealComputer", () => {
  it("unset: unchanged, nothing read", async () => {
    const r = read();
    const p = prof();
    expect((await applyRealComputer(p, r)).profile).toBe(p);
    expect(r).not.toHaveBeenCalled();
  });
  it("'screen': only the screen", async () => {
    const { profile } = await applyRealComputer(prof({ realComputer: "screen" }), read());
    expect(profile).toMatchObject({ screenWidth: 3440, screenHeight: 1440, availWidth: 3440, availHeight: 1392, devicePixelRatio: 1 });
    expect(profile.maxTouchPoints).toBeUndefined();
    expect(profile.acceptLanguage).toBeUndefined();
  });
  it("'all': screen, touch and language; the saved profile is not changed", async () => {
    const p = prof({ realComputer: "all" });
    const { profile, warning } = await applyRealComputer(p, read());
    expect(profile).toMatchObject({ screenWidth: 3440, maxTouchPoints: 2, acceptLanguage: "en-GB,en-US,en" }); // as Chrome writes it
    expect(warning).toBeUndefined();
    expect(p.screenWidth).toBeUndefined();
  });
  it("values the profile sets itself win", async () => {
    const { profile } = await applyRealComputer(prof({ realComputer: "all", screenWidth: 1920, screenHeight: 1080, maxTouchPoints: 0, acceptLanguage: "de-DE" }), read());
    expect(profile).toMatchObject({ screenWidth: 1920, screenHeight: 1080, maxTouchPoints: 0, acceptLanguage: "de-DE" });
    expect(profile.availWidth).toBeUndefined();
  });
  it("a proxy with GeoIP on keeps the languages; GeoIP off or no proxy uses this computer's", async () => {
    expect((await applyRealComputer(prof({ realComputer: "all", proxy: "http://h:1", geoip: true }), read())).profile.acceptLanguage).toBeUndefined();
    expect((await applyRealComputer(prof({ realComputer: "all", proxy: "http://h:1", geoip: false }), read())).profile.acceptLanguage).toBe("en-GB,en-US,en");
    expect((await applyRealComputer(prof({ realComputer: "all", geoip: true }), read())).profile.acceptLanguage).toBe("en-GB,en-US,en");
  });
  it("pass-through is left alone", async () => {
    const r = read();
    const p = prof({ realComputer: "all", fingerprint: "off" });
    expect((await applyRealComputer(p, r)).profile).toBe(p);
    expect(r).not.toHaveBeenCalled();
  });
  it("what cannot be read stays generated, with a launch note", async () => {
    const { profile, warning } = await applyRealComputer(prof({ realComputer: "all" }), read({ display: null, touch: null, language: "en-US" }));
    expect(profile.screenWidth).toBeUndefined();
    expect(profile.maxTouchPoints).toBeUndefined();
    expect(profile.acceptLanguage).toBe("en-US,en");
    expect(warning).toMatch(/screen and touch could not be read/);
  });
});

describe("the editor field", () => {
  it("is a select in Hardware: generated (unset), screen, all", () => {
    const f = fieldByKey("realComputer")!;
    expect(f.cat).toBe("hardware");
    expect(f.type).toBe("select");
    expect(f.defaultOption).toBe("");
    expect(f.options?.map((o) => o.value)).toEqual(["", "screen", "all"]);
  });
});
