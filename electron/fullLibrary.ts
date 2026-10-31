// The full device library: every usable capture in chrome-fingerprints (Vinyzu, GPL-3.0), downloaded from the
// original repo, checked, and converted on this computer (electron/vinyzu.ts). Optional, off until added.
//
// Two files at a pinned commit, each checked against its SHA-256, so what gets converted is exactly what the
// converter was tested on (tests/vinyzu.parity.test.ts). The build keeps:
//   device-library/index.json     the rows Device profiles lists (~1.8 MB), each with where its profile sits
//   device-library/profiles.bin   every profile gzipped on its own, back to back (~54 MB)
// so using a device reads one slice instead of decoding the 210 MB dataset again. Removing the folder turns
// the full library off.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { XzReadableStream } from "xz-decompress";
import { ROOT } from "./store";
import { screenWarningFromLabel } from "./fpargs";
import { buildLibrary, parseVarsPy, type LibraryRow } from "./vinyzu";
import type { LibraryProfile } from "./types";

export const UPSTREAM_REPO = "Vinyzu/chrome-fingerprints";
export const UPSTREAM_COMMIT = "c6358b6e9dfc0514c86cbcd9145caf03677d18a3";
const UPSTREAM_FILES = {
  "fingerprints.json.xz": "e233604a18706c124ec42fcca6398822035217311636ebfcb96e7313aaa7b060",
  "vars.py": "88a503e636503920f848b6829ce4fb8b44daefdecdbac36a18ff5dd983c69069",
} as const;
type UpstreamFile = keyof typeof UPSTREAM_FILES;
const rawUrl = (f: UpstreamFile) => `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_COMMIT}/chrome_fingerprints/${f}`;

/** What a full-library row's downloadUrl starts with: the dataset's page at the pinned commit, then #<id>.
 *  It is never fetched — fp:use reads the profile from the cache — but it is a real page to open. */
export const FULL_URL_PREFIX = `https://github.com/${UPSTREAM_REPO}/blob/${UPSTREAM_COMMIT}/chrome_fingerprints/fingerprints.json.xz#`;

/** Bump when the converter's output changes: a cache built by another version is rebuilt (from the kept
 *  upstream files when they are still there, so without downloading again). */
const BUILD_VERSION = 1;

export const libraryDir = () => path.join(ROOT, "device-library");
const indexPath = () => path.join(libraryDir(), "index.json");
const binPath = () => path.join(libraryDir(), "profiles.bin");
const upstreamPath = (f: UpstreamFile) => path.join(libraryDir(), "upstream", f);

interface CachedRow extends LibraryRow {
  /** Where its gzipped profile sits in profiles.bin. */
  at: [offset: number, length: number];
}
interface CachedIndex {
  version: number;
  commit: string;
  builtAt: string;
  kept: number;
  skipped: number;
  rows: CachedRow[];
}

export interface FullLibraryStatus {
  /** Built and ready: Device profiles lists these devices too. */
  on: boolean;
  count?: number;
  /** Captures the quality filter left out (virtual machines, software rendering, implausible hardware). */
  skipped?: number;
  builtAt?: string;
  /** Bytes the cache takes on disk. */
  bytes?: number;
}

/** xz -> text, with xz-embedded compiled to WebAssembly (Node has no xz decoder of its own). */
export async function decodeXz(buf: Uint8Array): Promise<string> {
  const stream = new XzReadableStream(new Blob([new Uint8Array(buf)]).stream() as ReadableStream<Uint8Array>);
  return new Response(stream).text();
}

const sha256 = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

let cached: CachedIndex | null | undefined;
function readIndex(): CachedIndex | null {
  if (cached !== undefined) return cached;
  try {
    const idx = JSON.parse(fs.readFileSync(indexPath(), "utf8")) as CachedIndex;
    cached = idx.version === BUILD_VERSION && idx.commit === UPSTREAM_COMMIT && fs.existsSync(binPath()) ? idx : null;
  } catch {
    cached = null;
  }
  return cached;
}

export function status(): FullLibraryStatus {
  const idx = readIndex();
  if (!idx) return { on: false };
  let bytes = 0;
  for (const f of [indexPath(), binPath(), upstreamPath("fingerprints.json.xz"), upstreamPath("vars.py")]) {
    try {
      bytes += fs.statSync(f).size;
    } catch {
      /* not kept */
    }
  }
  return { on: true, count: idx.rows.length, skipped: idx.skipped, builtAt: idx.builtAt, bytes };
}

/** The rows for Device profiles, in the shape the clearcote-profiles samples come in. Empty while off. */
export function list(): LibraryProfile[] {
  return (readIndex()?.rows ?? []).map((r) => ({
    name: `${r.id}.json`,
    downloadUrl: FULL_URL_PREFIX + r.id,
    gpuVendor: r.gpu_vendor,
    gpuFamily: r.gpu_family,
    renderer: r.renderer,
    screen: r.screen,
    cores: typeof r.hardware_concurrency === "number" ? r.hardware_concurrency : undefined,
    memory: typeof r.device_memory === "number" ? r.device_memory : undefined,
    screenWarning: screenWarningFromLabel(r.screen) ?? undefined,
    full: true,
  }));
}

export const isFullUrl = (url: unknown) => typeof url === "string" && url.startsWith(FULL_URL_PREFIX);

/** One device's profile JSON, from the cache. */
export function readProfile(url: string): string {
  const id = url.slice(FULL_URL_PREFIX.length);
  const row = readIndex()?.rows.find((r) => r.id === id);
  if (!row) throw new Error("This device is not in the full library on this computer. Add the full library again.");
  const [offset, length] = row.at;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(binPath(), "r");
  try {
    fs.readSync(fd, buf, 0, length, offset);
  } finally {
    fs.closeSync(fd);
  }
  return zlib.gunzipSync(buf).toString("utf8");
}

/** The upstream file: kept from an earlier build, or downloaded. Checked either way. */
async function upstream(f: UpstreamFile, fetchImpl: typeof fetch): Promise<Buffer> {
  try {
    const kept = fs.readFileSync(upstreamPath(f));
    if (sha256(kept) === UPSTREAM_FILES[f]) return kept;
  } catch {
    /* download it */
  }
  const res = await fetchImpl(rawUrl(f), { headers: { "User-Agent": "clearcote-profile-manager" } });
  if (!res.ok) throw new Error(`Downloading ${f} from ${UPSTREAM_REPO} failed (${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== UPSTREAM_FILES[f])
    throw new Error(`${f} from ${UPSTREAM_REPO} is not the file this app was tested with, so it was not used.`);
  return buf;
}

let building: Promise<FullLibraryStatus> | null = null;

/** Download (unless kept), check, convert and cache. One build at a time; a second call joins the first. */
export function build(fetchImpl: typeof fetch = fetch): Promise<FullLibraryStatus> {
  building ??= doBuild(fetchImpl).finally(() => {
    building = null;
  });
  return building;
}

async function doBuild(fetchImpl: typeof fetch): Promise<FullLibraryStatus> {
  const xz = await upstream("fingerprints.json.xz", fetchImpl);
  const vars = await upstream("vars.py", fetchImpl);
  const tables = parseVarsPy(vars.toString("utf8"));
  const records = JSON.parse(await decodeXz(xz));
  if (!Array.isArray(records)) throw new Error("The dataset is not a list of captures.");

  // Built beside the live cache, then swapped in, so a failed build leaves the old one working.
  const dir = libraryDir();
  const tmp = `${dir}.building`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, "upstream"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "upstream", "fingerprints.json.xz"), xz);
  fs.writeFileSync(path.join(tmp, "upstream", "vars.py"), vars);
  const fd = fs.openSync(path.join(tmp, "profiles.bin"), "w");
  const rows: CachedRow[] = [];
  let offset = 0;
  let result: { kept: number; skipped: number };
  try {
    result = buildLibrary(records, tables, (profile, row) => {
      const gz = zlib.gzipSync(JSON.stringify(profile));
      fs.writeSync(fd, gz);
      rows.push({ ...row, at: [offset, gz.length] });
      offset += gz.length;
    });
  } finally {
    fs.closeSync(fd);
  }
  const idx: CachedIndex = {
    version: BUILD_VERSION,
    commit: UPSTREAM_COMMIT,
    builtAt: new Date().toISOString(),
    kept: result.kept,
    skipped: result.skipped,
    rows,
  };
  fs.writeFileSync(path.join(tmp, "index.json"), JSON.stringify(idx));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  cached = undefined;
  return status();
}

/** Turn the full library off: its cache goes. Profiles already using one of its devices keep their copy. */
export function remove(): FullLibraryStatus {
  fs.rmSync(libraryDir(), { recursive: true, force: true });
  cached = undefined;
  return status();
}
