// The chrome-fingerprints dataset (Vinyzu, GPL-3.0) -> clearcote-profile JSON, in TypeScript, so the full
// library can be built on this computer from the original repo instead of from files we host.
//
// A port of two Python files, kept line for line so a diff against them stays readable:
//   - clearcote-browser tools/fingerprint-collect/convert_dataset.py  (`convert`, the canonical mapping)
//   - clearcote-profiles curate.py                                    (`isCurated`, `gpuVendor`, `normalize`, ...)
// tests/vinyzu.parity.test.ts compares every record against the Python output; change both together.
//
// Pure: no fs, no network (electron/fullLibrary.ts downloads, verifies and caches).

/** The lists in the dataset's vars.py that records index into. */
export interface VinyzuTables {
  webgl_extensions: string[];
  voice_uris: string[];
  fonts: string[];
  keyboard_codes: string[];
  [name: string]: string[];
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

// ---- vars.py: `name = ['a', "b", ...]` assignments of Python string literals ----

const PY_ESCAPES: Record<string, string> = { "\\": "\\", "'": "'", '"': '"', n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", "0": "\0" };

/** Every `name = [ '...', "...", ... ]` list of strings in a vars.py. Throws on anything else. */
export function parseVarsPy(src: string): VinyzuTables {
  const out: Record<string, string[]> = {};
  let i = 0;
  const n = src.length;
  const ws = () => {
    while (i < n) {
      if (/\s/.test(src[i])) i++;
      else if (src[i] === "#") while (i < n && src[i] !== "\n") i++;
      else break;
    }
  };
  const fail = (what: string) => {
    throw new Error(`vars.py: ${what} at offset ${i}`);
  };
  const str = (): string => {
    const q = src[i++];
    let s = "";
    while (i < n && src[i] !== q) {
      const c = src[i++];
      if (c === "\n") fail("newline in a string");
      if (c !== "\\") {
        s += c;
        continue;
      }
      const e = src[i++];
      if (e === "\n") continue; // line continuation
      if (e in PY_ESCAPES) s += PY_ESCAPES[e];
      else if (e === "x" || e === "u" || e === "U") {
        const len = e === "x" ? 2 : e === "u" ? 4 : 8;
        const hex = src.slice(i, i + len);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) fail(`bad \\${e} escape`);
        s += String.fromCodePoint(parseInt(hex, 16));
        i += len;
      } else s += "\\" + e; // Python keeps an unknown escape as written
    }
    if (src[i++] !== q) fail("unterminated string");
    return s;
  };
  for (ws(); i < n; ws()) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\[/.exec(src.slice(i, i + 200));
    if (!m) fail("expected `name = [`");
    i += m![0].length;
    const list: string[] = [];
    for (;;) {
      ws();
      if (src[i] === "]") {
        i++;
        break;
      }
      if (src[i] !== "'" && src[i] !== '"') fail("expected a string");
      let s = str();
      // Adjacent literals are one string in Python: 'Mozilla/5.0 (' 'KHTML, like Gecko)' across lines.
      for (ws(); src[i] === "'" || src[i] === '"'; ws()) s += str();
      list.push(s);
      if (src[i] === ",") i++;
      else if (src[i] !== "]") fail("expected , or ]");
    }
    out[m![1]] = list;
  }
  for (const k of ["webgl_extensions", "voice_uris", "fonts", "keyboard_codes"])
    if (!Array.isArray(out[k])) throw new Error(`vars.py: no ${k} table`);
  return out as VinyzuTables;
}

// ---- convert_dataset.py ----

const WEBGL_EXPLICIT: Record<string, string> = {
  maxTextureSize: "MAX_TEXTURE_SIZE",
  maxCubeMapTextureSize: "MAX_CUBE_MAP_TEXTURE_SIZE",
  maxRenderBufferSize: "MAX_RENDERBUFFER_SIZE",
  maxVaryingVectors: "MAX_VARYING_VECTORS",
  maxVertexUniformVectors: "MAX_VERTEX_UNIFORM_VECTORS",
  maxFragmentUniformVectors: "MAX_FRAGMENT_UNIFORM_VECTORS",
  maxCombinedTextureImageUnits: "MAX_COMBINED_TEXTURE_IMAGE_UNITS",
  maxTextureImageUnits: "MAX_TEXTURE_IMAGE_UNITS",
  maxVertexAttribs: "MAX_VERTEX_ATTRIBS",
  maxVertexTextureImageUnits: "MAX_VERTEX_TEXTURE_IMAGE_UNITS",
  maxViewportDims: "MAX_VIEWPORT_DIMS",
  aliasedLineWidthRange: "ALIASED_LINE_WIDTH_RANGE",
  aliasedPointSizeRange: "ALIASED_POINT_SIZE_RANGE",
  alphaBits: "ALPHA_BITS", blueBits: "BLUE_BITS", depthBits: "DEPTH_BITS",
  greenBits: "GREEN_BITS", redBits: "RED_BITS", stencilBits: "STENCIL_BITS",
  subpixelBits: "SUBPIXEL_BITS", sampleBuffers: "SAMPLE_BUFFERS", samples: "SAMPLES",
  maxColorAttachmentsWebgl: "MAX_COLOR_ATTACHMENTS",
  maxDrawBuffersWebgl: "MAX_DRAW_BUFFERS",
  // WebGL2 (dataset key WITHOUT the trailing "2"):
  max3DTextureSize: "MAX_3D_TEXTURE_SIZE",
  maxArrayTextureLayers: "MAX_ARRAY_TEXTURE_LAYERS",
  maxDrawBuffers: "MAX_DRAW_BUFFERS",
  maxColorAttachments: "MAX_COLOR_ATTACHMENTS",
  maxSamples: "MAX_SAMPLES",
  maxVertexUniformBlocks: "MAX_VERTEX_UNIFORM_BLOCKS",
  maxFragmentUniformBlocks: "MAX_FRAGMENT_UNIFORM_BLOCKS",
  maxCombinedUniformBlocks: "MAX_COMBINED_UNIFORM_BLOCKS",
  maxUniformBufferBindings: "MAX_UNIFORM_BUFFER_BINDINGS",
  maxVertexUniformComponents: "MAX_VERTEX_UNIFORM_COMPONENTS",
  maxFragmentUniformComponents: "MAX_FRAGMENT_UNIFORM_COMPONENTS",
  maxTextureLodBias: "MAX_TEXTURE_LOD_BIAS",
  maxElementIndex: "MAX_ELEMENT_INDEX",
  max3dTextureSize: "MAX_3D_TEXTURE_SIZE", // case guard
};

function camelToScreaming(name: string): string {
  return name
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_")
    .replace(/(?<=[A-Za-z])(?=[0-9])/g, "_")
    .toUpperCase();
}

export function toGlConst(base: string): string {
  if (Object.prototype.hasOwnProperty.call(WEBGL_EXPLICIT, base)) return WEBGL_EXPLICIT[base];
  if (base.endsWith("Webgl")) base = base.slice(0, -5);
  return camelToScreaming(base);
}

// Python's int() and float() on a string: surrounding whitespace allowed, "_" between digits.
const PY_INT = /^[+-]?\d+(?:_\d+)*$/;
const PY_DIGITS = String.raw`\d+(?:_\d+)*`;
const PY_FLOAT = new RegExp(String.raw`^[+-]?(?:(?:${PY_DIGITS})?\.${PY_DIGITS}|${PY_DIGITS}\.?)(?:[eE][+-]?${PY_DIGITS})?$`);

/** Coerce a numeric string to a number; pass everything else through unchanged. */
export function pyNum(v: Json): Json {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (PY_INT.test(s) || PY_FLOAT.test(s)) return Number(s.replace(/_/g, ""));
  if (/^[+-]?(?:inf|infinity|nan)$/i.test(s)) throw new Error(`non-finite number ${JSON.stringify(v)}`);
  return v;
}

/** Dataset values: numeric strings -> numbers; {"0":a,"1":b} range objects -> [a, b]. */
function convValue(v: Json): Json {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
      return keys.map((_, i) => {
        if (!(String(i) in v)) throw new Error(`range object without key ${i}`);
        return pyNum(v[String(i)]);
      });
    }
  }
  return pyNum(v);
}

/** Python's isinstance(v, int): JSON integers and booleans. */
const isPyInt = (v: Json): v is number | boolean => typeof v === "boolean" || (typeof v === "number" && Number.isInteger(v));

/** Python's list[i]: negative counts from the end, out of range raises. */
function pyIndex(list: string[], i: number | boolean): string {
  const k = Number(i) < 0 ? list.length + Number(i) : Number(i);
  if (k < 0 || k >= list.length) throw new Error(`table index ${i} out of range`);
  return list[k];
}

/** `table[i] if isinstance(i, int) and i < len(table) else i` — the bounded lookups. */
function lookup(list: string[], i: Json): Json {
  return isPyInt(i) && Number(i) < list.length ? pyIndex(list, i) : i;
}

const obj = (v: Json | undefined): Obj => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
/** Python's dict.get(k): a missing key reads as None. */
const get = (o: Obj, k: string): Json => (k in o ? o[k] : null);

function mapNavigator(nav: Obj): Obj {
  const plat = obj(nav.platform || null);
  const he: Obj = {
    platform: get(plat, "name"),
    platformVersion: get(plat, "version"),
    architecture: get(plat, "architecture"),
    bitness: get(plat, "bitness"),
    model: "model" in plat ? plat.model : "",
    wow64: "wow64" in plat ? plat.wow64 : false,
    mobile: false,
  };
  return {
    app_codename: get(nav, "app_codename"),
    app_name: get(nav, "app_name"),
    app_version: get(nav, "app_version"),
    product: get(nav, "product"),
    product_sub: get(nav, "product_sub"),
    vendor: get(nav, "vendor"),
    vendor_sub: get(nav, "vendor_sub"),
    pdf_viewer_enabled: get(nav, "pdf_viewer_enabled"),
    uadata: { platform: get(plat, "name"), mobile: false, high_entropy: he },
  };
}

function mapWebgl(webgl: Obj, tables: VinyzuTables): Obj {
  const resolveExt = (lst: Json[]) => lst.map((i) => (isPyInt(i) ? pyIndex(tables.webgl_extensions, i) : i));
  const w1: Obj = {};
  const w2: Obj = {};
  for (const [key, val] of Object.entries(obj(webgl.properties || null))) {
    const c = convValue(val);
    if (key.endsWith("2")) w2[toGlConst(key.slice(0, -1))] = c;
    else w1[toGlConst(key)] = c;
  }
  const debug: Obj = {
    VENDOR: get(webgl, "vendor"),
    RENDERER: get(webgl, "renderer"),
    VERSION: get(webgl, "version"),
    SHADING_LANGUAGE_VERSION: get(webgl, "shading_language"),
    UNMASKED_VENDOR_WEBGL: get(webgl, "unmasked_vendor"),
    UNMASKED_RENDERER_WEBGL: get(webgl, "unmasked_renderer"),
  };
  const debug2: Obj = { ...debug, VERSION: get(webgl, "version2"), SHADING_LANGUAGE_VERSION: get(webgl, "shading_language2") };
  return {
    webgl1: { parameters: w1, extensions: resolveExt(arr(webgl.extensions || null)), debug },
    webgl2: { parameters: w2, extensions: resolveExt(arr(webgl.extensions2 || null)), debug: debug2 },
  };
}

function mapSpeech(speech: Json, tables: VinyzuTables): Json[] {
  return arr(speech || null).map((s0) => {
    const s = obj(s0);
    const uri = lookup(tables.voice_uris, get(s, "voice_uri"));
    return { voice_uri: uri, name: uri, lang: get(s, "lang"), local_service: get(s, "local_service"), default: get(s, "default") };
  });
}

/** convert_dataset.convert(rec, tables) with include_version=False: the device, never the browser version. */
export function convert(rec: Obj, tables: VinyzuTables): Obj {
  const keyboard: Obj = {};
  for (const [k, idx] of Object.entries(obj(rec.keyboard || null))) keyboard[k] = lookup(tables.keyboard_codes, idx);
  const audio: Obj = {};
  for (const [k, v] of Object.entries(obj(rec.audio || null))) audio[k] = pyNum(v);
  return {
    meta: { schema_version: 1, source: "chrome-fingerprints", captured_at: null, chrome_version: null },
    hardware_concurrency: get(rec, "hardware_concurrency"),
    device_memory: get(rec, "device_memory"),
    do_not_track: get(rec, "do_not_track"),
    navigator: mapNavigator(obj(rec.navigator || null)),
    screen: obj(rec.screen || null),
    webgl: mapWebgl(obj(rec.webgl || null), tables),
    audio,
    speech: mapSpeech(get(rec, "speech"), tables),
    fonts: { detected: arr(rec.fonts || null).map((i) => lookup(tables.fonts, i)), probed: null },
    css: obj(rec.css || null),
    keyboard,
    webgpu: get(rec, "webgpu"),
    webrtc: get(rec, "webrtc"),
    network: null,
  };
}

// ---- curate.py ----

const SOFTWARE = ["swiftshader", "llvmpipe", "software", "microsoft basic", "subzero"];
const VM = ["parallels", "vmware", "virtualbox", "svga", "qxl", "virgl", "gallium"];
const FAMILIES = ["RTX", "GTX", "GeForce", "NVIDIA", "Quadro", "Radeon", "AMD", "Arc", "Iris", "UHD", "Intel", "Apple", "Adreno", "Mali"];
const VENDORS: [string, string[]][] = [
  ["Intel", ["intel", "iris", "uhd"]],
  ["NVIDIA", ["nvidia", "geforce", "rtx", "gtx", "quadro", "nvs"]],
  ["AMD", ["amd", "radeon"]],
  ["Apple", ["apple"]],
  ["Qualcomm", ["adreno"]],
  ["ARM", ["mali"]],
];

export function renderer(profile: Obj): string {
  const r = obj(obj(obj(profile.webgl || null).webgl1 || null).debug || null).UNMASKED_RENDERER_WEBGL;
  return typeof r === "string" ? r : "";
}

export const isRealGpu = (p: Obj) => {
  const r = renderer(p).toLowerCase();
  return r.includes("angle") && !SOFTWARE.some((m) => r.includes(m));
};
export const isVm = (p: Obj) => VM.some((m) => renderer(p).toLowerCase().includes(m));

export function isPlausible(p: Obj): boolean {
  const hc = p.hardware_concurrency;
  const dm = p.device_memory;
  const hcN = isPyInt(hc ?? null) ? Number(hc) : NaN;
  const hcOk = hc === 1 || hc === true || (hcN % 2 === 0 && hcN >= 2 && hcN <= 128);
  const dmOk = typeof dm === "number" && (dm === 2 || dm === 4 || dm === 8);
  const w2 = obj(obj(obj(p.webgl || null).webgl2 || null).parameters || null);
  return hcOk && dmOk && Object.keys(w2).length > 0;
}

export const isCurated = (p: Obj) => isRealGpu(p) && !isVm(p) && isPlausible(p);

export function gpuFamily(p: Obj): string {
  const r = renderer(p).toLowerCase();
  return FAMILIES.find((f) => r.includes(f.toLowerCase())) ?? "other";
}

export function gpuVendor(p: Obj): string {
  const r = renderer(p).toLowerCase();
  return VENDORS.find(([, markers]) => markers.some((m) => r.includes(m)))?.[0] ?? "other";
}

/** Python's "%s" of a JSON value, for the "WxH" screen label. */
const pyStr = (v: Json | undefined): string =>
  v === undefined || v === null ? "None" : typeof v === "boolean" ? (v ? "True" : "False") : String(v);

/** One manifest row (curate.summary): what index.json lists for a profile. */
export function summary(p: Obj) {
  const screen = obj(p.screen || null);
  return {
    id: obj(p.meta || null).id as string,
    gpu_vendor: gpuVendor(p),
    gpu_family: gpuFamily(p),
    renderer: renderer(p),
    screen: `${pyStr(screen.width)}x${pyStr(screen.height)}`,
    hardware_concurrency: get(p, "hardware_concurrency"),
    device_memory: get(p, "device_memory"),
  };
}
export type LibraryRow = ReturnType<typeof summary>;

/** The engine reads color-gamut as boolean media-query keys; mirror the dataset's string into one. */
export function normalize(p: Obj): Obj {
  const css = p.css;
  if (css && typeof css === "object" && !Array.isArray(css)) {
    const g = css["color-gamut"];
    if (g === "srgb" || g === "p3" || g === "rec2020") css[`color-gamut:${g}`] = true;
  }
  return p;
}

export const ATTRIBUTION = "chrome-fingerprints (https://github.com/Vinyzu/chrome-fingerprints, GPL-3.0)";
export const vinyzuId = (index: number) => `vinyzu-${String(index).padStart(5, "0")}`;

// ---- beyond curate.py: what the curation leaves out, kept with a label instead of dropped ----

/** Why a capture is a higher risk, in the order curate.py's checks would reject it:
 *  - "no-gpu":    drawn in software (SwiftShader, llvmpipe): a server, VPS or VM without a graphics card
 *  - "vm":        a virtual machine's graphics adapter (Parallels, VMware, VirtualBox)
 *  - "unusual":   not a normal desktop capture (no ANGLE renderer, an empty one)
 *  - "old-gpu":   no WebGL2, which this browser always has
 *  - "likely-vm": an odd thread count or 0.5–1 GB of memory, typical of a virtual machine */
export type DeviceRisk = "no-gpu" | "vm" | "unusual" | "old-gpu" | "likely-vm";
/** The virtual machine a "vm" capture ran in. */
export type VmProduct = "vmware" | "virtualbox" | "parallels" | "other";

export function riskOf(p: Obj): DeviceRisk | null {
  if (isCurated(p)) return null;
  const r = renderer(p).toLowerCase();
  if (SOFTWARE.some((m) => r.includes(m))) return "no-gpu";
  if (isVm(p)) return "vm";
  if (!isRealGpu(p)) return "unusual";
  const w2 = obj(obj(obj(p.webgl || null).webgl2 || null).parameters || null);
  if (!Object.keys(w2).length) return "old-gpu";
  return "likely-vm";
}

export function vmProduct(rendererString: string): VmProduct {
  const r = rendererString.toLowerCase();
  return r.includes("vmware") || r.includes("svga") ? "vmware" : r.includes("virtualbox") ? "virtualbox" : r.includes("parallels") ? "parallels" : "other";
}

/** A library row with its risk, when it has one (the curated ones have none and match index.json). */
export type BuiltRow = LibraryRow & { risk?: DeviceRisk; vm?: VmProduct };

/** generate.py without --samples: every record converted, curated, tagged. `each` receives the kept ones in
 *  dataset order; returns how many were kept and skipped. With `includeRisky`, what the curation would skip is
 *  kept too, labelled with its risk (only a record that cannot be converted is skipped). */
export function buildLibrary(
  records: Json[],
  tables: VinyzuTables,
  each: (profile: Obj, row: BuiltRow) => void,
  opts: { includeRisky?: boolean } = {},
) {
  let kept = 0;
  let skipped = 0;
  let risky = 0;
  records.forEach((rec, index) => {
    let profile: Obj;
    try {
      profile = convert(obj(rec), tables);
    } catch {
      skipped++;
      return;
    }
    const risk = riskOf(profile);
    if (risk && !opts.includeRisky) {
      skipped++;
      return;
    }
    normalize(profile);
    const meta = profile.meta as Obj;
    meta.id = vinyzuId(index);
    meta.source = ATTRIBUTION;
    meta.gpu_vendor = gpuVendor(profile);
    meta.gpu_family = gpuFamily(profile);
    const row: BuiltRow = summary(profile);
    if (risk) {
      meta.risk = risk;
      row.risk = risk;
      if (risk === "vm") row.vm = vmProduct(row.renderer);
      risky++;
    } else kept++;
    each(profile, row);
  });
  return { kept, skipped, risky };
}
