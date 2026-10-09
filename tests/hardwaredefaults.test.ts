// Issue report CR-KUDD3V: the profile defaults and hardware fields a customer had to fix by hand.
// Each block names what was measured on the shipped r35 build (SESSION-CONTEXT/187).

import { describe, it, expect } from "vitest";
import { coherenceIssues } from "../src/lib/coherence";
import { FIELDS, fieldByKey, selectOptions } from "../src/lib/fields";
import { newProfile } from "../src/lib/newProfile";
import { profilesFromProxyList } from "../src/lib/bulkCreate";
import { fingerprintArgs } from "../electron/fpargs";
import { parseProxy, proxyArgs } from "../electron/proxyargs";
import { localOnlySettings } from "../electron/cloudbody";

const issues = (p: Record<string, unknown>, ctx = {}) => coherenceIssues(p, ctx);
const ids = (p: Record<string, unknown>, ctx = {}) => issues(p, ctx).map((i) => i.id);
const CLEAN = { brand: "Chromium", browserVersion: "154" };

describe("a new profile", () => {
  const p = newProfile("seed123", "2026-10-09T00:00:00.000Z");

  it("has Widevine on, so the default Chrome brand holds up", () => {
    expect(p.widevine).toBe(true);
    expect(ids(p as unknown as Record<string, unknown>)).not.toContain("chrome-brand-without-widevine");
  });

  it("keeps the earlier defaults", () => {
    expect(p).toMatchObject({ fingerprint: "seed123", platform: "windows", geoip: true });
  });

  it("opens with no coherence issue at all", () => {
    expect(issues(p as unknown as Record<string, unknown>)).toEqual([]);
  });

  it("is the same for profiles made from a proxy list", () => {
    const r = profilesFromProxyList("h1.example:1\nh2.example:2", { namePattern: "P {n}", geoip: true }, [], {
      now: "2026-10-09T00:00:00.000Z",
    });
    expect(r.profiles.every((x) => x.widevine === true)).toBe(true);
  });
});

describe("a typed screen size next to an identity that has its own screen", () => {
  // r35: screen.width = typed, CSS device-width = the persona's. Matching the real monitor did not help.
  const screen = { screenWidth: 1920, screenHeight: 1080, availWidth: 1920, availHeight: 1032 };

  it("warns under a seed, and says to leave the fields empty", () => {
    const i = issues({ ...CLEAN, fingerprint: "abc", ...screen }).find((x) => x.id === "screen-spoofed-by-hand");
    expect(i?.message).toContain("the seed");
    expect(i?.fix).toMatch(/Leave the four screen fields empty/);
    expect(i?.fix).not.toMatch(/matches this host's real display/);
  });

  it("warns under a captured fingerprint", () => {
    const i = issues({ ...CLEAN, fingerprint: "abc", fingerprintProfile: "cap.json", ...screen }).find(
      (x) => x.id === "screen-spoofed-by-hand",
    );
    expect(i?.message).toContain("the captured fingerprint");
  });

  it("warns under Light stealth, whose pixel ratio rescales the CSS screen", () => {
    const i = issues({ ...CLEAN, fingerprint: "abc", lightStealth: true, ...screen }).find(
      (x) => x.id === "screen-spoofed-by-hand",
    );
    expect(i?.message).toContain("Light stealth");
    expect(i?.fix).toMatch(/Leave the four screen fields empty/);
  });

  it("keeps the real-display advice when nothing else supplies a screen", () => {
    const i = issues({ ...CLEAN, ...screen }).find((x) => x.id === "screen-spoofed-by-hand");
    expect(i?.fix).toMatch(/matches this host's real display/);
  });

  it("is silent when the screen fields are empty", () => {
    expect(ids({ ...CLEAN, fingerprint: "abc" })).not.toContain("screen-spoofed-by-hand");
  });

  it("the editor's own screen copy no longer tells people to match their display", () => {
    const w = fieldByKey("screenWidth")!;
    expect(`${w.groupNote} ${w.why}`).not.toMatch(/only when (it|they) match/);
    expect(w.groupNote).toMatch(/Best left empty/);
    // Empty is the persona's screen under a seed, not the real display.
    for (const k of ["screenWidth", "screenHeight", "availWidth", "availHeight"]) {
      expect(fieldByKey(k)?.placeholder, k).toBe("persona default");
    }
  });
});

describe("third-party cookies (allowed by default, as in Chrome)", () => {
  // User decision 2026-10-09: allowed unless the profile blocks them. r35 and older block by
  // default, so an unblocked profile must tell them to allow; r36 allows on its own.
  const count = (a: string[], s: string) => a.filter((x) => x === s).length;

  it("a profile that does not block sends --allow-third-party-cookies, exactly once", () => {
    const a = fingerprintArgs({ fingerprint: "s" });
    expect(count(a, "--allow-third-party-cookies")).toBe(1);
    expect(a).not.toContain("--block-third-party-cookies");
  });

  it("a new profile does not block", () => {
    const p = newProfile("s", "2026-10-09T00:00:00.000Z");
    expect(fingerprintArgs(p)).toContain("--allow-third-party-cookies");
  });

  it("blocking sends --block-third-party-cookies and never the allow switch", () => {
    const a = fingerprintArgs({ fingerprint: "s", blockThirdPartyCookies: true });
    expect(count(a, "--block-third-party-cookies")).toBe(1);
    expect(a).not.toContain("--allow-third-party-cookies");
  });

  it("holds under Light stealth too", () => {
    expect(fingerprintArgs({ fingerprint: "s", lightStealth: true })).toContain("--allow-third-party-cookies");
  });

  it("is a 'Block' checkbox, off by default", () => {
    const f = fieldByKey("blockThirdPartyCookies")!;
    expect(f.type).toBe("check");
    expect(f.defaultOn).toBeFalsy();
    expect(f.label).toMatch(/^Block/);
    expect(fieldByKey("allowThirdPartyCookies")).toBeUndefined();
  });

  it("raises no warning on any build, blocked or not", () => {
    for (const major of [151, 154]) {
      expect(ids({ ...CLEAN }, { major }).some((i) => i.includes("third-party"))).toBe(false);
      expect(ids({ ...CLEAN, blockThirdPartyCookies: true }, { major }).some((i) => i.includes("third-party"))).toBe(false);
    }
  });
});

describe("transparent proxy", () => {
  const proxy = parseProxy("http://user:pass@gw.example.com:8080");

  it("rides along with a direct proxy", () => {
    expect(proxyArgs(proxy, { transparentProxy: true })).toContain("--transparent-proxy");
  });

  it("rides along with the local auth relay", () => {
    expect(proxyArgs(proxy, { relayUrl: "http://127.0.0.1:5555", transparentProxy: true })).toEqual([
      "--proxy-server=http://127.0.0.1:5555",
      "--transparent-proxy",
    ]);
  });

  it("never appears without a proxy", () => {
    expect(proxyArgs(null, { transparentProxy: true })).toEqual([]);
  });

  it("is off unless asked for", () => {
    expect(proxyArgs(proxy)).not.toContain("--transparent-proxy");
  });

  it("warns when set without a proxy", () => {
    expect(ids({ ...CLEAN, transparentProxy: true })).toContain("transparent-proxy-without-proxy");
    expect(ids({ ...CLEAN, transparentProxy: true, proxy: "http://gw.example.com:8080" })).not.toContain(
      "transparent-proxy-without-proxy",
    );
  });

  it("warns on a build older than 152", () => {
    const p = { ...CLEAN, transparentProxy: true, proxy: "http://gw.example.com:8080" };
    expect(ids(p, { major: 151 })).toContain("transparent-proxy-needs-152");
    expect(ids(p, { major: 154 })).not.toContain("transparent-proxy-needs-152");
  });

  it("is listed as staying on this PC for a cloud run, as is blocking cookies", () => {
    expect(localOnlySettings({ id: "x", fingerprint: "s", transparentProxy: true, blockThirdPartyCookies: true })).toEqual([
      "Transparent proxy",
      "Third-party cookies blocked",
    ]);
  });
});

describe("CPU cores and memory are lists", () => {
  const cores = fieldByKey("hardwareConcurrency")!;
  const memory = fieldByKey("deviceMemory")!;

  it("CPU cores is a numeric select with even thread counts and no 2", () => {
    expect(cores.type).toBe("select");
    expect(cores.numeric).toBe(true);
    const values = (cores.options ?? []).map((o) => o.value).filter((v) => v !== "");
    expect(values.every((v) => Number(v) % 2 === 0)).toBe(true);
    expect(values).not.toContain("2");
    expect(values).toEqual(expect.arrayContaining(["8", "16", "24", "28"]));
  });

  it("memory stores a number too", () => expect(memory.numeric).toBe(true));

  it("hides the 1 GB phone value on a desktop platform", () => {
    expect(selectOptions(memory, { platform: "windows" }, "").map((o) => o.value)).not.toContain("1");
    expect(selectOptions(memory, {}, "").map((o) => o.value)).not.toContain("1");
  });

  it("offers it on Android", () => {
    expect(selectOptions(memory, { platform: "android" }, "").map((o) => o.value)).toContain("1");
  });

  it("still shows a value the profile already holds, hidden or not", () => {
    expect(selectOptions(memory, { platform: "windows" }, "1").map((o) => o.value)).toContain("1");
    // A core count typed before the field was a list.
    const opts = selectOptions(cores, {}, "10");
    expect(opts.map((o) => o.value)).toContain("10");
    expect(opts.find((o) => o.value === "10")?.label).toMatch(/set before/);
  });
});

describe("storage quota", () => {
  const f = fieldByKey("storageQuota")!;

  it("no longer suggests a value real Chrome never reports", () => {
    // Chrome reports usage + 10 GiB (kStaticStorageQuota); 250000 MB arrives as ~244 GiB.
    expect(f.placeholder).not.toMatch(/250000/);
    expect(`${f.placeholder} ${f.hint} ${f.why}`).toMatch(/10 GB/);
  });

  it("drops the incognito claim, which Chrome's fixed quota made untrue", () => {
    expect(f.why).not.toMatch(/incognito or a throwaway/);
  });
});

describe("every select option set stays well-formed", () => {
  it("no select repeats a value", () => {
    for (const f of FIELDS.filter((x) => x.type === "select")) {
      const values = (f.options ?? []).map((o) => o.value);
      expect(new Set(values).size, f.key).toBe(values.length);
    }
  });
});
