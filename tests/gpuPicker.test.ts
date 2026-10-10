// The GPU model picker's logic (src/lib/gpuPicker.ts) and its place in the field schema. Two things
// matter: a profile saved before the picker existed reads back EXACTLY as it was (Custom with its
// strings intact — no schema change, no rewrite on open), and whatever the picker writes is the
// pair the engine prints for the persona's platform.

import { describe, it, expect } from "vitest";
import {
  PICKER_CUSTOM,
  PICKER_DEFAULT,
  applyModel,
  claimedVendor,
  clearModel,
  isCustom,
  modelFromOptionValue,
  modelOptionValue,
  pickerGroups,
  pickerValue,
  randomGpu,
  selectGpuOption,
  selectedModel,
  showGpuPicker,
  stringPlatformFor,
  withPlatform,
} from "../src/lib/gpuPicker";
import { GPU_MODELS, findModel, stringsFor } from "../src/lib/gpuModels";
import { countSet, fieldByKey, fieldsIn, hostFieldFor, isFieldSet, searchFields } from "../src/lib/fields";

const model = (name: string) => GPU_MODELS.find((m) => m.name === name)!;
const RTX4070 = model("GeForce RTX 4070");
const RX6700 = model("Radeon RX 6700 XT");
const UHD770 = model("UHD Graphics 770 (Raptor Lake)");

/** The strings a user typed by hand before the picker existed. */
const LEGACY = {
  gpuVendor: "Google Inc. (Intel)",
  gpuRenderer: "ANGLE (Intel, Intel(R) HD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
};

describe("what the select shows", () => {
  it("the persona default when nothing is stored", () => {
    expect(pickerValue({})).toBe(PICKER_DEFAULT);
    expect(pickerValue({ gpuVendor: "", gpuRenderer: "" })).toBe(PICKER_DEFAULT);
    expect(pickerValue({ gpuVendor: undefined, gpuRenderer: "  " })).toBe(PICKER_DEFAULT);
    expect(isCustom({})).toBe(false);
  });

  it("the model when the stored pair is a table entry, in either platform form", () => {
    expect(pickerValue({ ...stringsFor(RTX4070, "windows") })).toBe(modelOptionValue(RTX4070));
    expect(pickerValue({ ...stringsFor(RTX4070, "linux") })).toBe(modelOptionValue(RTX4070));
    expect(pickerValue({ ...stringsFor(UHD770, "linux"), platform: "linux" })).toBe(modelOptionValue(UHD770));
    expect(selectedModel({ ...stringsFor(RX6700, "windows") })).toBe(RX6700);
  });

  it("Custom for a legacy pair that matches no entry — with the strings left exactly as they were", () => {
    const p = { ...LEGACY };
    expect(pickerValue(p)).toBe(PICKER_CUSTOM);
    expect(isCustom(p)).toBe(true);
    expect(selectedModel(p)).toBeNull();
    expect(p).toEqual(LEGACY); // reading never rewrites
  });

  it("Custom for one half set on its own", () => {
    expect(pickerValue({ gpuVendor: "Google Inc. (NVIDIA)" })).toBe(PICKER_CUSTOM);
    expect(pickerValue({ gpuRenderer: "something" })).toBe(PICKER_CUSTOM);
  });

  it("Custom when the editor holds it open, even over strings that match a model", () => {
    expect(pickerValue({ ...stringsFor(RTX4070, "windows") }, true)).toBe(PICKER_CUSTOM);
    expect(isCustom({ ...stringsFor(RTX4070, "windows") }, true)).toBe(true);
  });

  it("option values are stable ids that round-trip to the model", () => {
    for (const m of GPU_MODELS) {
      expect(modelOptionValue(m)).toMatch(/^(nvidia|intel|amd):0x[0-9a-f]+$/);
      expect(modelFromOptionValue(modelOptionValue(m))).toBe(m);
    }
    expect(modelFromOptionValue("nvidia:0xffff")).toBeNull();
    expect(modelFromOptionValue("")).toBeNull();
  });
});

describe("the option groups", () => {
  it("put this machine's vendor first and label it so, with the others after", () => {
    const g = pickerGroups("amd");
    expect(g.map((x) => x.vendor)).toEqual(["amd", "nvidia", "intel"]);
    expect(g[0].host).toBe(true);
    expect(g[0].label).toBe("AMD — this machine's GPU maker");
    expect(g[1].label).toBe("NVIDIA");
    expect(g[1].host).toBe(false);
    expect(pickerGroups("intel").map((x) => x.vendor)).toEqual(["intel", "nvidia", "amd"]);
    expect(pickerGroups("nvidia").map((x) => x.vendor)).toEqual(["nvidia", "intel", "amd"]);
  });

  it("list every vendor, in table order, when the host is unknown — none marked as the host", () => {
    const g = pickerGroups("unknown");
    expect(g.map((x) => x.vendor)).toEqual(["nvidia", "intel", "amd"]);
    expect(g.every((x) => !x.host)).toBe(true);
    expect(g.map((x) => x.label)).toEqual(["NVIDIA", "Intel", "AMD"]);
  });

  it("each group holds exactly that vendor's models", () => {
    for (const g of pickerGroups("nvidia")) {
      expect(g.models.length).toBeGreaterThan(0);
      expect(g.models.every((m) => m.vendor === g.vendor)).toBe(true);
    }
  });
});

describe("selecting a model writes BOTH strings in the persona platform's form", () => {
  it("Windows is the default form, for windows, macos and an unset platform", () => {
    for (const platform of ["windows", "macos", undefined]) {
      const p = applyModel({ platform, name: "x" }, RTX4070);
      expect(p.gpuVendor, String(platform)).toBe("Google Inc. (NVIDIA)");
      expect(p.gpuRenderer, String(platform)).toBe("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)");
      expect(p.name).toBe("x"); // the rest of the profile is untouched
    }
    expect(stringPlatformFor("windows")).toBe("windows");
    expect(stringPlatformFor("macos")).toBe("windows");
    expect(stringPlatformFor(undefined)).toBe("windows");
    expect(stringPlatformFor("linux")).toBe("linux");
  });

  it("a Linux persona takes the OpenGL form", () => {
    const p = applyModel({ platform: "linux" }, RX6700);
    expect(p.gpuVendor).toBe("Google Inc. (AMD)");
    expect(p.gpuRenderer).toBe("ANGLE (AMD, AMD Radeon RX 6700 XT (radeonsi navi22 ACO), OpenGL 4.6)");
  });

  it("through the select: the default clears, a model writes, Custom keeps the strings and holds", () => {
    const start = { platform: "windows", ...stringsFor(RTX4070, "windows"), name: "n" };

    const def = selectGpuOption(start, PICKER_DEFAULT);
    expect(def.profile).toEqual({ platform: "windows", name: "n" });
    expect("gpuVendor" in def.profile).toBe(false); // the key is dropped, not set to ""
    expect(def.forceCustom).toBe(false);

    const pick = selectGpuOption(start, modelOptionValue(UHD770));
    expect(pick.profile).toEqual({ platform: "windows", name: "n", ...stringsFor(UHD770, "windows") });
    expect(pick.forceCustom).toBe(false);

    const custom = selectGpuOption(start, PICKER_CUSTOM);
    expect(custom.profile).toEqual(start); // the model's strings are the starting point for editing
    expect(custom.forceCustom).toBe(true);
    expect(pickerValue(custom.profile, custom.forceCustom)).toBe(PICKER_CUSTOM);

    const bogus = selectGpuOption(start, "nvidia:0xdead");
    expect(bogus.profile).toEqual(start);
  });

  it("clearModel drops both keys", () => {
    expect(clearModel({ ...LEGACY, name: "k" })).toEqual({ name: "k" });
  });
});

describe("Pick one at random", () => {
  const nvidiaPool = GPU_MODELS.filter((m) => m.vendor === "nvidia");

  it("stays within this machine's vendor and never returns the model already chosen", () => {
    let p: Record<string, unknown> = { platform: "windows", ...stringsFor(RTX4070, "windows") };
    for (let k = 0; k < 60; k++) {
      const before = selectedModel(p)!;
      p = randomGpu(p, "nvidia");
      const after = selectedModel(p)!;
      expect(after.vendor).toBe("nvidia");
      expect(after).not.toBe(before);
      expect(nvidiaPool).toContain(after);
    }
  });

  it("writes the persona platform's form", () => {
    const p = randomGpu({ platform: "linux" }, "intel");
    expect(p.gpuVendor).toBe("Google Inc. (Intel)");
    expect(p.gpuRenderer).toMatch(/^ANGLE \(Intel, Mesa Intel\(R\) .+, OpenGL 4\.6\)$/);
    expect(findModel(p.gpuVendor, p.gpuRenderer)!.vendor).toBe("intel");
  });

  it("draws from every vendor when the host is unknown", () => {
    const seen = new Set<string>();
    for (let i = 0; i < GPU_MODELS.length; i++) {
      seen.add(selectedModel(randomGpu({}, "unknown", () => (i + 0.5) / GPU_MODELS.length))!.vendor);
    }
    expect([...seen].sort()).toEqual(["amd", "intel", "nvidia"]);
  });

  it("from the persona default or a custom pair, excludes nothing", () => {
    const fromDefault = randomGpu({ platform: "windows" }, "amd", () => 0);
    expect(selectedModel(fromDefault)).toBe(GPU_MODELS.filter((m) => m.vendor === "amd")[0]);
    const fromCustom = randomGpu({ platform: "windows", ...LEGACY }, "amd", () => 0);
    expect(selectedModel(fromCustom)).toBe(GPU_MODELS.filter((m) => m.vendor === "amd")[0]);
  });
});

describe("changing the persona platform", () => {
  it("rewrites a table model's strings in the new platform's form, both ways", () => {
    const win = { platform: "windows", ...stringsFor(RTX4070, "windows"), name: "n" };
    const lin = withPlatform(win, "linux");
    expect(lin).toEqual({ platform: "linux", name: "n", ...stringsFor(RTX4070, "linux") });
    expect(withPlatform(lin, "windows")).toEqual(win);
    // macOS has no form of its own and takes the Windows one.
    expect(withPlatform(lin, "macos")).toEqual({ ...win, platform: "macos" });
  });

  it("leaves custom strings alone — they are the user's own", () => {
    const p = { platform: "windows", ...LEGACY };
    expect(withPlatform(p, "linux")).toEqual({ platform: "linux", ...LEGACY });
  });

  it("leaves nothing-stored as nothing", () => {
    const out = withPlatform({ platform: "windows", name: "n" }, "linux");
    expect(out).toEqual({ platform: "linux", name: "n" });
    expect("gpuVendor" in out).toBe(false);
  });

  it("to Android keeps whatever is stored, in whatever form — the picker is hidden there", () => {
    const p = { platform: "windows", ...stringsFor(RTX4070, "windows") };
    expect(withPlatform(p, "android")).toEqual({ ...p, platform: "android" });
    expect(showGpuPicker({ platform: "android" })).toBe(false);
    for (const platform of ["windows", "linux", "macos", undefined]) expect(showGpuPicker({ platform }), String(platform)).toBe(true);
  });

  it("back from Android rewrites a table model for the platform it lands on", () => {
    const p = { platform: "android", ...stringsFor(RTX4070, "windows") };
    expect(withPlatform(p, "linux")).toEqual({ platform: "linux", ...stringsFor(RTX4070, "linux") });
  });
});

describe("the vendor a pair claims (for the coherence rule)", () => {
  it("is the model's vendor for a table entry, in either form", () => {
    expect(claimedVendor(stringsFor(RX6700, "windows"))).toBe("amd");
    expect(claimedVendor(stringsFor(RX6700, "linux"))).toBe("amd");
    expect(claimedVendor(stringsFor(UHD770, "linux"))).toBe("intel");
  });

  it("is read off a custom string when it names a maker, and null when it does not", () => {
    expect(claimedVendor(LEGACY)).toBe("intel");
    expect(claimedVendor({ gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0)" })).toBe("nvidia");
    expect(claimedVendor({ gpuVendor: "Google Inc. (AMD)", gpuRenderer: "x" })).toBe("amd");
    expect(claimedVendor({ gpuRenderer: "Radeon Pro 5500M" })).toBe("amd");
    expect(claimedVendor({ gpuRenderer: "Apple M2" })).toBeNull();
    expect(claimedVendor({ gpuRenderer: "Mali-G78" })).toBeNull();
    expect(claimedVendor({})).toBeNull();
  });
});

describe("its place in the field schema", () => {
  it("is a full-width custom Hardware control, disabled under 'Use real GPU', hidden for Android", () => {
    const f = fieldByKey("gpuModel")!;
    expect(f).toMatchObject({ cat: "hardware", type: "custom", custom: "gpuModel", full: true, disabledBy: "disableGpuFingerprint", label: "GPU model" });
    expect(f.reads).toEqual(["gpuVendor", "gpuRenderer"]);
    expect(f.showWhen!({ platform: "android" })).toBe(false);
    expect(f.showWhen!({ platform: "windows" })).toBe(true);
    expect(f.showWhen!({})).toBe(true);
    expect(f.hint).toBeTruthy();
    expect(f.why).toMatch(/own GPU maker/);
    expect(f.why).toMatch(/seed/);
  });

  it("the two stored strings stay in the schema, hosted inside it, and still disabled under 'Use real GPU'", () => {
    for (const k of ["gpuVendor", "gpuRenderer"]) {
      const f = fieldByKey(k)!;
      expect(f.hostedBy, k).toBe("gpuModel");
      expect(f.disabledBy, k).toBe("disableGpuFingerprint");
      expect(f.cat, k).toBe("hardware");
      expect(f.type, k).toBe("text");
    }
    // Contiguous, so the picker and its hosted strings read as one thing in the category order.
    const keys = fieldsIn("hardware").map((f) => f.key);
    const i = keys.indexOf("gpuModel");
    expect(keys.slice(i, i + 3)).toEqual(["gpuModel", "gpuVendor", "gpuRenderer"]);
  });

  it("a deep-link to a hosted string lands on the picker", () => {
    expect(hostFieldFor("gpuRenderer")?.key).toBe("gpuModel");
    expect(hostFieldFor("gpuVendor")?.key).toBe("gpuModel");
    expect(hostFieldFor("gpuModel")?.key).toBe("gpuModel");
    expect(hostFieldFor("timezone")?.key).toBe("timezone");
    expect(hostFieldFor("nope")).toBeUndefined();
  });

  it("the picker shows the dot when either string is set, and the badge counts the strings once", () => {
    const f = fieldByKey("gpuModel")!;
    expect(isFieldSet({}, f)).toBe(false);
    expect(isFieldSet({ gpuVendor: "Google Inc. (NVIDIA)" }, f)).toBe(true);
    expect(isFieldSet({ gpuRenderer: "x" }, f)).toBe(true);
    // Both strings set: the badge says 2 (the stored keys), not 3 (the picker counted on top).
    expect(countSet({ ...stringsFor(RTX4070, "windows") }, "hardware")).toBe(2);
    expect(countSet({}, "hardware")).toBe(0);
  });

  it("is found by the switch names, the makers, and 'random'", () => {
    for (const q of ["--fingerprint-gpu-vendor", "--fingerprint-gpu-renderer", "nvidia", "radeon", "random", "graphics card"]) {
      expect(searchFields(q).map((f) => f.key), q).toContain("gpuModel");
    }
    expect(searchFields("--fingerprint-gpu-renderer").map((f) => f.key)).toContain("gpuRenderer");
  });
});
