// The chrome-fingerprints converter (electron/vinyzu.ts) on small hand-made inputs, and the full library's cache
// (electron/fullLibrary.ts) refusing a file that isn't the pinned one. The whole dataset against the Python
// generator is tests/vinyzu.parity.test.ts (opt-in: it needs the dataset).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildLibrary,
  convert,
  gpuFamily,
  gpuVendor,
  isCurated,
  parseVarsPy,
  pyNum,
  summary,
  toGlConst,
  type VinyzuTables,
} from "../electron/vinyzu";

// The data folder electron/store.ts asks Electron for (vi.mock runs before the imports, hence vi.hoisted).
const ROOT = vi.hoisted(() => {
  const req = require as (m: string) => unknown;
  const { mkdtempSync } = req("node:fs") as typeof import("node:fs");
  const { tmpdir } = req("node:os") as typeof import("node:os");
  return mkdtempSync(`${tmpdir()}/ccpm-vinyzu-`);
});
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

const VARS = String.raw`codecs = ['audio/ogg; codecs=vorbis', "video/mp4; codecs=\"avc1\""]

# a comment
keyboard_codes = ['KeyA', 'KeyB']
webgl_extensions = ['ANGLE_instanced_arrays', 'EXT_blend_minmax',
                    'WEBGL_lose_context']
user_agents = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ('
               'KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36']
voice_uris = ['Microsoft David - English (United States)', 'Microsoft Zira – caf\xe9']
fonts = ['Arial', 'It\'s a font', 'Back\\slash']
`;

const tables = (): VinyzuTables => parseVarsPy(VARS);

/** A dataset record shaped like chrome-fingerprints' own. */
const record = (over: Record<string, unknown> = {}) => ({
  hardware_concurrency: 8,
  device_memory: 8,
  do_not_track: null,
  navigator: { platform: { name: "Windows", version: "15.0.0", architecture: "x86", bitness: "64" }, vendor: "Google Inc." },
  screen: { width: 1920, height: 1080, avail_width: 1920, avail_height: 1040 },
  webgl: {
    unmasked_renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    unmasked_vendor: "Google Inc. (NVIDIA)",
    version: "WebGL 1.0",
    version2: "WebGL 2.0",
    extensions: [0, 2, "OES_custom"],
    extensions2: [1],
    properties: { maxTextureSize: "16384", aliasedLineWidthRange: { "0": "1", "1": "1" }, maxSamples2: "16", max3DTextureSize2: 2048 },
  },
  audio: { sample_rate: "48000", base_latency: "0.01" },
  speech: [{ voice_uri: 1, lang: "en-US", local_service: true, default: false }],
  fonts: [0, 2, 99, "Custom Font"],
  keyboard: { KeyA: 0, KeyQ: 1 },
  css: { "color-gamut": "srgb" },
  ...over,
});

describe("vars.py", () => {
  it("reads every list, with Python's escapes and adjacent literals joined", () => {
    const t = tables();
    expect(t.codecs).toEqual(["audio/ogg; codecs=vorbis", 'video/mp4; codecs="avc1"']);
    expect(t.webgl_extensions).toEqual(["ANGLE_instanced_arrays", "EXT_blend_minmax", "WEBGL_lose_context"]);
    expect(t.user_agents).toEqual(["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36"]);
    expect(t.voice_uris[1]).toBe("Microsoft Zira – café");
    expect(t.fonts).toEqual(["Arial", "It's a font", "Back\\slash"]);
  });
  it("refuses anything that isn't a list of strings, and a file without the tables records use", () => {
    expect(() => parseVarsPy("fonts = [1, 2]")).toThrow(/expected a string/);
    expect(() => parseVarsPy("import os")).toThrow(/expected `name = \[`/);
    expect(() => parseVarsPy("codecs = ['a']")).toThrow(/no webgl_extensions table/);
  });
});

describe("convert (convert_dataset.py)", () => {
  it("numbers the way Python's int() and float() read them", () => {
    expect(pyNum("16384")).toBe(16384);
    expect(pyNum(" 0.01 ")).toBe(0.01);
    expect(pyNum("1_000")).toBe(1000);
    expect(pyNum("1e-3")).toBe(0.001);
    expect(pyNum(".5")).toBe(0.5);
    expect(pyNum("srgb")).toBe("srgb");
    expect(pyNum("")).toBe("");
    expect(pyNum(7)).toBe(7);
  });
  it("names WebGL parameters as the engine reads them", () => {
    expect(toGlConst("maxRenderBufferSize")).toBe("MAX_RENDERBUFFER_SIZE");
    expect(toGlConst("maxColorAttachmentsWebgl")).toBe("MAX_COLOR_ATTACHMENTS");
    expect(toGlConst("maxUniformBlockSize")).toBe("MAX_UNIFORM_BLOCK_SIZE");
    expect(toGlConst("maxClipDistancesWebgl")).toBe("MAX_CLIP_DISTANCES");
    expect(toGlConst("max3DTextureSize")).toBe("MAX_3D_TEXTURE_SIZE");
    expect(toGlConst("maxViewport2Dims")).toBe("MAX_VIEWPORT_2_DIMS");
  });
  it("maps a record: the device only, tables looked up, WebGL2 keys split off, no browser version", () => {
    const p = convert(record(), tables()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a test reads deep
    expect(p.hardware_concurrency).toBe(8);
    expect(p.webgl.webgl1.parameters).toEqual({ MAX_TEXTURE_SIZE: 16384, ALIASED_LINE_WIDTH_RANGE: [1, 1] });
    expect(p.webgl.webgl2.parameters).toEqual({ MAX_SAMPLES: 16, MAX_3D_TEXTURE_SIZE: 2048 });
    expect(p.webgl.webgl1.extensions).toEqual(["ANGLE_instanced_arrays", "WEBGL_lose_context", "OES_custom"]);
    expect(p.webgl.webgl2.debug.VERSION).toBe("WebGL 2.0");
    expect(p.audio).toEqual({ sample_rate: 48000, base_latency: 0.01 });
    expect(p.speech[0]).toMatchObject({ voice_uri: "Microsoft Zira – café", name: "Microsoft Zira – café", lang: "en-US" });
    // In range: looked up. Out of range or not an index: kept as it was.
    expect(p.fonts).toEqual({ detected: ["Arial", "Back\\slash", 99, "Custom Font"], probed: null });
    expect(p.keyboard).toEqual({ KeyA: "KeyA", KeyQ: "KeyB" });
    expect(p.navigator.uadata.high_entropy).toEqual({
      platform: "Windows", platformVersion: "15.0.0", architecture: "x86", bitness: "64", model: "", wow64: false, mobile: false,
    });
    expect(JSON.stringify(p)).not.toMatch(/Chrome\/117|uaFullVersion|brands/);
  });
  it("fails a record whose extension index is out of range, as Python's list index does", () => {
    expect(() => convert(record({ webgl: { extensions: [9] } }), tables())).toThrow(/out of range/);
  });
});

describe("curation (curate.py)", () => {
  const curated = (over: Record<string, unknown>) => isCurated(convert(record(over), tables()));
  const gl = (renderer: string) => ({ webgl: { ...record().webgl, unmasked_renderer: renderer } });
  it("keeps a real desktop GPU with plausible hardware", () => {
    expect(curated({})).toBe(true);
    expect(curated({ hardware_concurrency: 1 })).toBe(true);
  });
  it("drops software rendering, virtual machines and implausible hardware", () => {
    expect(curated(gl("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)"))).toBe(false);
    expect(curated(gl("ANGLE (VMware, Inc., VMware SVGA 3D Direct3D11 vs_5_0 ps_5_0, D3D11)"))).toBe(false);
    expect(curated(gl("Mali-G78"))).toBe(false); // not ANGLE: not a desktop Chrome capture
    expect(curated({ hardware_concurrency: 6.5 })).toBe(false);
    expect(curated({ hardware_concurrency: 3 })).toBe(false);
    expect(curated({ device_memory: 16 })).toBe(false);
    expect(curated({ webgl: { ...record().webgl, properties: { maxTextureSize: "16384" } } })).toBe(false); // no WebGL2
  });
  it("buckets the GPU maker and line, and lists a row like index.json's", () => {
    const p = convert(record(), tables());
    expect([gpuVendor(p), gpuFamily(p)]).toEqual(["NVIDIA", "RTX"]);
    const intel = convert(record(gl("ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)")), tables());
    expect([gpuVendor(intel), gpuFamily(intel)]).toEqual(["Intel", "Iris"]);
    expect(summary({ ...p, meta: { id: "vinyzu-00007" } })).toMatchObject({ id: "vinyzu-00007", screen: "1920x1080", gpu_vendor: "NVIDIA" });
    expect(summary({ ...p, screen: {} }).screen).toBe("NonexNone");
  });
  it("builds a library: ids from the dataset position, attribution and color-gamut set, the rest skipped", () => {
    const rows: string[] = [];
    const out = buildLibrary([record(), record({ device_memory: 3 }), record({ webgl: { extensions: [9] } }), record()], tables(), (p, row) => {
      rows.push(row.id);
      expect((p.meta as Record<string, unknown>).source).toMatch(/Vinyzu\/chrome-fingerprints, GPL-3\.0/);
      expect((p.css as Record<string, unknown>)["color-gamut:srgb"]).toBe(true);
    });
    expect(out).toEqual({ kept: 2, skipped: 2 });
    expect(rows).toEqual(["vinyzu-00000", "vinyzu-00003"]);
  });
});

describe("the full library's cache", () => {
  it("is off until added, refuses a download that isn't the pinned file, and keeps nothing from it", async () => {
    const fl = await import("../electron/fullLibrary");
    expect(fl.status()).toEqual({ on: false });
    expect(fl.list()).toEqual([]);
    const fetchImpl = vi.fn(async () => new Response("not the dataset")) as unknown as typeof fetch;
    await expect(fl.build(fetchImpl)).rejects.toThrow(/not the file this app was tested with/);
    expect(vi.mocked(fetchImpl).mock.calls[0][0]).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/Vinyzu\/chrome-fingerprints\/[0-9a-f]{40}\/chrome_fingerprints\/fingerprints\.json\.xz$/,
    );
    expect(fl.status().on).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "device-library"))).toBe(false);
    expect(() => fl.readProfile(fl.FULL_URL_PREFIX + "vinyzu-00001")).toThrow(/not in the full library/);
  });
  it("a failed download says so", async () => {
    const fl = await import("../electron/fullLibrary");
    await expect(fl.build((async () => new Response("", { status: 503 })) as unknown as typeof fetch)).rejects.toThrow(/failed \(503\)/);
  });
});

