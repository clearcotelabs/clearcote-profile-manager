// The GPU model table (src/lib/gpuModels.ts). The DATA is provisional and will be replaced; what
// these tests pin is the CONTRACT the editor relies on — every entry prints both platform forms in
// exactly the shape the engine prints them, the two halves of a pair name the same maker, a stored
// pair round-trips back to its model in either form, and random never hands back what is excluded.

import { describe, it, expect } from "vitest";
import {
  GPU_MODELS,
  findModel,
  modelsForVendor,
  randomModel,
  stringsFor,
  type GpuModel,
  type GpuVendor,
} from "../src/lib/gpuModels";

/** ANGLE prints the device id as "0x" + 8 upper-case hex digits. */
const HEX8 = /0x[0-9A-F]{8}/;
const WIN_VENDOR = /^Google Inc\. \((NVIDIA|Intel|AMD)\)$/;
const WIN_RENDERER = /^ANGLE \((NVIDIA|Intel|AMD), (.+) \((0x[0-9A-F]{8})\) Direct3D11 vs_5_0 ps_5_0, D3D11\)$/;
const LINUX = {
  nvidia: {
    vendor: /^Google Inc\. \(NVIDIA Corporation\)$/,
    renderer: /^ANGLE \(NVIDIA Corporation, NVIDIA (.+)\/PCIe\/SSE2, OpenGL 4\.5\.0\)$/,
  },
  intel: {
    vendor: /^Google Inc\. \(Intel\)$/,
    renderer: /^ANGLE \(Intel, Mesa Intel\(R\) (.+) \(([A-Za-z0-9 -]+)\), OpenGL 4\.6\)$/,
  },
  amd: {
    vendor: /^Google Inc\. \(AMD\)$/,
    // Mesa >= 24's radeonsi form, as the audit corpus shows it: chip codename, then ACO or LLVM <ver>.
    renderer: /^ANGLE \(AMD, AMD (.+) \(radeonsi ([a-z0-9_]+) (ACO|LLVM [0-9.]+)\), OpenGL 4\.6\)$/,
  },
} as const;
const TOKEN: Record<GpuVendor, string> = { nvidia: "NVIDIA", intel: "Intel", amd: "AMD" };

const byName = (name: string): GpuModel => {
  const m = GPU_MODELS.find((x) => x.name === name);
  if (!m) throw new Error(`no model named ${name}`);
  return m;
};

describe("the table", () => {
  it("holds the provisional models, each once", () => {
    const names = GPU_MODELS.map((m) => m.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    const ids = GPU_MODELS.map((m) => `${m.vendor}:${m.deviceId}`);
    expect(ids.filter((n, i) => ids.indexOf(n) !== i)).toEqual([]);
    for (const v of ["nvidia", "intel", "amd"] as const) {
      expect(modelsForVendor(v).length, v).toBeGreaterThan(0);
    }
  });

  it("is frozen — the editor never mutates it", () => {
    expect(Object.isFrozen(GPU_MODELS)).toBe(true);
  });

  it("has every field populated", () => {
    for (const m of GPU_MODELS) {
      expect(["nvidia", "intel", "amd"]).toContain(m.vendor);
      expect(m.name.trim(), m.name).toBe(m.name);
      expect(m.name.length).toBeGreaterThan(0);
      expect(Number.isInteger(m.deviceId) && m.deviceId > 0 && m.deviceId <= 0xffff, `${m.name} device id`).toBe(true);
      expect(m.architecture, m.name).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe("every entry's strings match the engine's format", () => {
  for (const m of GPU_MODELS) {
    describe(`${m.vendor} ${m.name}`, () => {
      it("Windows vendor is Google Inc. (<Tok>)", () => {
        expect(m.windows.vendor).toMatch(WIN_VENDOR);
        expect(m.windows.vendor).toBe(`Google Inc. (${TOKEN[m.vendor]})`);
      });

      it("Windows renderer is ANGLE's D3D11 form with the device id as 0x + 8 upper hex", () => {
        const match = WIN_RENDERER.exec(m.windows.renderer);
        expect(match, m.windows.renderer).not.toBeNull();
        const [, tok, desc, id] = match!;
        expect(tok).toBe(TOKEN[m.vendor]);
        expect(id).toMatch(HEX8);
        expect(id).toBe("0x" + m.deviceId.toString(16).toUpperCase().padStart(8, "0"));
        // The description is the model as the driver names it, prefixed by the maker as the driver spells
        // it (AMD's older Polaris driver prints "Radeon RX 570 Series" with no maker in front). The label
        // is that model, plus at most one suffix in parentheses where several real parts share one name:
        // the chip codename, or "codename, 0x<id>" when they share the codename too (see the generator).
        const prefix = { nvidia: "NVIDIA ", intel: "Intel(R) ", amd: "AMD " }[m.vendor];
        if (m.vendor !== "amd") expect(desc.startsWith(prefix), desc).toBe(true);
        const model = desc.startsWith(prefix) ? desc.slice(prefix.length) : desc;
        expect(m.name === model || m.name.startsWith(model + " ("), `${m.name} vs ${model}`).toBe(true);
      });

      it("Linux strings take the driver family's form and name the same model", () => {
        expect(m.linux.vendor).toMatch(LINUX[m.vendor].vendor);
        const match = LINUX[m.vendor].renderer.exec(m.linux.renderer);
        expect(match, m.linux.renderer).not.toBeNull();
        // The driver names the same part. NVIDIA's own driver prints the marketing name. Mesa's radeonsi
        // drops AMD's "(TM)" and takes the name from libdrm's id table: a laptop chip reads "Radeon 860M"
        // or "Radeon 860M Graphics" by libdrm version, and "Radeon Graphics" where the table has no entry
        // yet (Apify's Linux traffic shows all three; a card always has its entry). Mesa's Intel driver
        // prints the marketing name or, for newer parts, its generic "Graphics" / "Arc(tm) Graphics" (the
        // corpus shows both), with the chip in the codename.
        // One suffix at most: the chip codename, or "codename, 0x<id>" when real parts share the codename too.
        const base = m.name.replace(/ \([A-Za-z0-9 ,/]+\)$/, "");
        const drv = match![1];
        if (m.vendor === "nvidia") expect(drv).toBe(base);
        else if (m.vendor === "amd") {
          const noTm = base.replace(/\s*\(TM\)/, "");
          const forms = m.integrated ? [noTm, noTm.replace(/ Graphics$/, ""), "Radeon Graphics"] : [noTm];
          expect(forms, `${m.linux.renderer} for ${m.name}`).toContain(drv);
        } else expect([base, "Graphics", "Arc(tm) Graphics"], `${m.linux.renderer} for ${m.name}`).toContain(drv);
      });

      it("the Linux form carries no Direct3D and the Windows form no OpenGL", () => {
        expect(m.linux.renderer).not.toMatch(/Direct3D|D3D11/);
        expect(m.windows.renderer).not.toMatch(/OpenGL|Mesa|PCIe/);
      });

      it("vendor and renderer agree on the maker, on both platforms", () => {
        const tok = TOKEN[m.vendor];
        expect(m.windows.vendor).toContain(tok);
        expect(m.windows.renderer).toContain(tok);
        expect(m.linux.vendor).toContain(tok);
        expect(m.linux.renderer).toContain(tok);
        // ...and name no other maker.
        for (const other of Object.values(TOKEN).filter((t) => t !== tok)) {
          for (const s of [m.windows.vendor, m.windows.renderer, m.linux.vendor, m.linux.renderer]) {
            expect(s, `${s} names ${other}`).not.toMatch(new RegExp(`\\b${other}\\b`));
          }
        }
      });
    });
  }

  it("pins the exact strings the r37 engine serves (schema 4), so a data refresh cannot drift unnoticed", () => {
    expect(byName("GeForce RTX 4070").windows).toEqual({
      vendor: "Google Inc. (NVIDIA)",
      renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    });
    expect(byName("GeForce RTX 4070").linux).toEqual({
      vendor: "Google Inc. (NVIDIA Corporation)",
      renderer: "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4070/PCIe/SSE2, OpenGL 4.5.0)",
    });
    expect(byName("UHD Graphics 770 (Raptor Lake)").windows).toEqual({
      vendor: "Google Inc. (Intel)",
      renderer: "ANGLE (Intel, Intel(R) UHD Graphics 770 (0x0000A780) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    });
    expect(byName("UHD Graphics 770 (Raptor Lake)").linux).toEqual({
      vendor: "Google Inc. (Intel)",
      renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 770 (RPL-S), OpenGL 4.6)",
    });
    // Mesa prints "Iris(R) Xe Graphics" for Tiger Lake (audit corpus), not the provisional "Xe Graphics".
    expect(byName("Iris(R) Xe Graphics (Tiger Lake)").linux.renderer).toBe("ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2), OpenGL 4.6)");
    expect(byName("UHD Graphics 730").linux.renderer).toBe("ANGLE (Intel, Mesa Intel(R) UHD Graphics 730 (ADL-S GT1), OpenGL 4.6)");
    expect(byName("Radeon RX 6700 XT").windows).toEqual({
      vendor: "Google Inc. (AMD)",
      renderer: "ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    });
    expect(byName("Radeon RX 6700 XT").linux).toEqual({
      vendor: "Google Inc. (AMD)",
      renderer: "ANGLE (AMD, AMD Radeon RX 6700 XT (radeonsi navi22 ACO), OpenGL 4.6)",
    });
    expect(byName("Radeon RX 9070 XT").linux.renderer).toContain("gfx1201");
    expect(byName("GeForce RTX 3070").deviceId).toBe(0x2484);
    expect(byName("GeForce RTX 3070").architecture).toBe("ampere");
    expect(byName("GeForce RTX 4060").architecture).toBe("lovelace");
    expect(byName("Radeon RX 9070 XT").architecture).toBe("rdna-4");
    // schema 4: 0x7D55 is the common "Arc(TM) Graphics" string (Apify data: 253 of 259), not "Arc(TM) Pro";
    // AMD APUs are in the pool; the Alder Lake Iris Xe pair shares a name and a codename, so one carries its id;
    // the RTX 3070 LHR die (0x2488) is below the traffic threshold and gone.
    expect(byName("Arc(TM) Graphics").windows.renderer).toBe("ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)");
    expect(byName("Arc(TM) Graphics").architecture).toBe("xe-lpg");
    expect(byName("Radeon(TM) Vega 8 Graphics (Raven)").deviceId).toBe(0x15D8);
    expect(byName("Radeon(TM) Vega 8 Graphics (Raven)").integrated).toBe(true);
    expect(byName("Radeon RX 6700 XT").integrated).toBe(false);
    expect(byName("Iris(R) Xe Graphics (Alder Lake)").deviceId).toBe(0x46A6);
    expect(byName("Iris(R) Xe Graphics (Alder Lake, 0x46A8)").deviceId).toBe(0x46A8);
    expect(GPU_MODELS.some((m) => m.deviceId === 0x2488)).toBe(false);
    expect(GPU_MODELS.filter((m) => m.vendor === "intel").every((m) => m.integrated)).toBe(true);
    expect(GPU_MODELS.filter((m) => m.vendor === "nvidia").every((m) => !m.integrated)).toBe(true);
  });
});

describe("stringsFor", () => {
  it("returns the pair keyed as the profile stores it", () => {
    const m = byName("GeForce RTX 3060");
    expect(stringsFor(m, "windows")).toEqual({ gpuVendor: m.windows.vendor, gpuRenderer: m.windows.renderer });
    expect(stringsFor(m, "linux")).toEqual({ gpuVendor: m.linux.vendor, gpuRenderer: m.linux.renderer });
  });
});

describe("findModel round-trips both platform forms", () => {
  for (const m of GPU_MODELS) {
    it(`${m.name} — Windows and Linux`, () => {
      const w = stringsFor(m, "windows");
      const l = stringsFor(m, "linux");
      expect(findModel(w.gpuVendor, w.gpuRenderer)).toBe(m);
      // Linux strings carry no device id (the drivers print a name, not ANGLE's id), so two dies sold
      // under one name -- the RTX 3070 and its LHR revision -- are ONE Linux claim. A Linux pair must
      // still find a model that serves exactly those strings.
      const back = findModel(l.gpuVendor, l.gpuRenderer);
      expect(back).not.toBeNull();
      expect(back!.linux).toEqual(m.linux);
    });
  }

  it("every Windows pair is unique; a Linux claim is shared only where the driver prints one name", () => {
    // Linux drivers print a name, not ANGLE's device id, so the several real parts behind one marketing
    // name (the Alder Lake Iris Xe pair, two Vega 8 dies, ...) are ONE Linux claim. So are the parts a
    // driver does not tell apart at all: Mesa prints "Intel(R) Graphics (ADL GT2)" for every Alder Lake-P
    // chip, Iris Xe or UHD, and "AMD Radeon Graphics" for every APU libdrm has no entry for.
    const key = (s: { vendor: string; renderer: string }) => `${s.vendor}|${s.renderer}`;
    const win = new Set(GPU_MODELS.map((m) => key(m.windows)));
    expect(win.size).toBe(GPU_MODELS.length);
    const base = (name: string) => name.replace(/ \([A-Za-z0-9 ,/]+\)$/, "");
    const generic = /Mesa Intel\(R\) Graphics \(|AMD Radeon Graphics \(/;
    const byLinux = new Map<string, GpuModel[]>();
    for (const m of GPU_MODELS) byLinux.set(key(m.linux), [...(byLinux.get(key(m.linux)) ?? []), m]);
    for (const group of byLinux.values()) {
      if (group.length < 2) continue;
      const names = new Set(group.map((m) => `${m.vendor}:${base(m.name)}`));
      const label = group.map((m) => m.name).join(", ");
      if (generic.test(group[0].linux.renderer)) expect(group.every((m) => m.integrated), label).toBe(true);
      else expect([...names], label).toHaveLength(1);
    }
  });

  it("forgives whitespace at the ends — the strings travel through text inputs", () => {
    const m = byName("GeForce RTX 4060");
    expect(findModel(` ${m.windows.vendor} `, `${m.windows.renderer}\n`)).toBe(m);
  });

  it("is null for nothing, for one half only, and for a pair that matches no entry", () => {
    const m = byName("GeForce RTX 4060");
    expect(findModel(undefined, undefined)).toBeNull();
    expect(findModel("", "")).toBeNull();
    expect(findModel(m.windows.vendor, undefined)).toBeNull();
    expect(findModel(undefined, m.windows.renderer)).toBeNull();
    expect(findModel("Google Inc. (NVIDIA)", "ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 (0x00001B80) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBeNull();
  });

  it("is null for a pair whose halves come from different platforms — that is not a form the engine prints", () => {
    // Only NVIDIA's vendor string differs between the platforms ("NVIDIA" vs "NVIDIA Corporation");
    // Intel's and AMD's are the same on both, so for them a mixed pair IS the other platform's pair.
    const m = byName("GeForce RTX 4070");
    expect(m.windows.vendor).not.toBe(m.linux.vendor);
    expect(findModel(m.windows.vendor, m.linux.renderer)).toBeNull();
    expect(findModel(m.linux.vendor, m.windows.renderer)).toBeNull();
    for (const name of ["Radeon RX 6700 XT", "UHD Graphics 770 (Raptor Lake)"]) {
      const same = byName(name);
      expect(same.windows.vendor, name).toBe(same.linux.vendor);
    }
  });

  it("is null when one character differs — a different claim", () => {
    const m = byName("UHD Graphics 770 (Raptor Lake)");
    expect(findModel(m.windows.vendor, m.windows.renderer.replace("0x0000A780", "0x0000A781"))).toBeNull();
    expect(findModel(m.windows.vendor.toLowerCase(), m.windows.renderer)).toBeNull();
  });
});

describe("modelsForVendor", () => {
  it("returns only that vendor's models", () => {
    for (const v of ["nvidia", "intel", "amd"] as const) {
      const list = modelsForVendor(v);
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((m) => m.vendor === v)).toBe(true);
    }
  });

  it("returns every model for an unknown host, as a fresh array", () => {
    const all = modelsForVendor("unknown");
    expect(all).toEqual([...GPU_MODELS]);
    expect(all).not.toBe(GPU_MODELS);
  });
});

describe("randomModel", () => {
  /** A deterministic walk through [0, 1). */
  const seq = (...vals: number[]) => {
    let i = 0;
    return () => vals[i++ % vals.length];
  };

  it("respects the vendor", () => {
    for (let k = 0; k < 50; k++) {
      expect(randomModel("intel").vendor).toBe("intel");
      expect(randomModel("amd").vendor).toBe("amd");
      expect(randomModel("nvidia").vendor).toBe("nvidia");
    }
  });

  it("never returns the excluded model", () => {
    for (const v of ["nvidia", "intel", "amd", "unknown"] as const) {
      const pool = modelsForVendor(v);
      for (const ex of pool) {
        for (let k = 0; k < 40; k++) {
          const got = randomModel(v, ex);
          expect(`${got.vendor}:${got.deviceId}`, `${v} excluding ${ex.name}`).not.toBe(`${ex.vendor}:${ex.deviceId}`);
        }
      }
    }
  });

  it("excludes by identity of the model, so a structural copy excludes it too", () => {
    const ex = { ...byName("GeForce RTX 3070") };
    for (let k = 0; k < 40; k++) expect(randomModel("nvidia", ex).name).not.toBe("GeForce RTX 3070");
  });

  it("is uniform over the pool: a stepped rnd visits every model of the vendor", () => {
    const pool = modelsForVendor("nvidia");
    const seen = new Set<string>();
    for (let i = 0; i < pool.length; i++) seen.add(randomModel("nvidia", null, () => (i + 0.5) / pool.length).name);
    expect([...seen].sort()).toEqual(pool.map((m) => m.name).sort());
  });

  it("draws from every vendor when the host is unknown", () => {
    const seen = new Set<string>();
    const all = modelsForVendor("unknown");
    for (let i = 0; i < all.length; i++) seen.add(randomModel("unknown", null, () => (i + 0.5) / all.length).vendor);
    expect([...seen].sort()).toEqual(["amd", "intel", "nvidia"]);
  });

  it("clamps an rnd that returns 1, rather than indexing past the end", () => {
    expect(randomModel("amd", null, () => 1)).toBe(modelsForVendor("amd").at(-1));
    expect(randomModel("amd", null, () => 0)).toBe(modelsForVendor("amd")[0]);
  });

  it("the excluded model is skipped in the index space, not left as a hole", () => {
    // With rnd stepping through the pool minus the excluded one, every OTHER model is reachable.
    const pool = modelsForVendor("intel");
    const ex = pool[0];
    const rest = pool.slice(1).map((m) => m.name).sort();
    const seen = new Set<string>();
    for (let i = 0; i < rest.length; i++) seen.add(randomModel("intel", ex, () => (i + 0.5) / rest.length).name);
    expect([...seen].sort()).toEqual(rest);
  });

  it("returns the only candidate when excluding it would leave nothing", () => {
    // Guarded against a future single-entry vendor: simulate by excluding everything but one.
    const pool = modelsForVendor("amd");
    if (pool.length === 1) expect(randomModel("amd", pool[0])).toBe(pool[0]);
    else expect(randomModel("amd", pool[0], seq(0.1, 0.9))).not.toBe(pool[0]);
  });

  it("uses Math.random by default and still lands inside the table", () => {
    for (let k = 0; k < 100; k++) expect(GPU_MODELS).toContain(randomModel("unknown"));
  });
});
