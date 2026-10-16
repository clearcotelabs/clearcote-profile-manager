// The offline geoip database the SDK resolves exit IPs with (SDK 0.47+): daijro's "geoip-all-in-one"
// MaxMind DB (IP2Location + GeoLite2 + DB-IP merged, timezone computed from coordinates). Cached in the
// SAME directory as the Python / Node / .NET SDKs, so one download (~52 MB zip -> ~120 MB) serves all of
// them and this app. The data is GPL-3.0; it is downloaded on first use, never bundled.
//
// Dependency-free like the rest of the main process: a small zip reader (the archive holds one deflated
// .mmdb) and a MaxMind DB reader that reads the file through a descriptor, so the 120 MB database is
// never held in memory — one lookup is a ~128-node tree walk plus one record.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const inflateRaw = promisify(zlib.inflateRaw);

export const MMDB_URL =
  "https://github.com/daijro/geoip-all-in-one/releases/latest/download/geoip-aio-all.mmdb.zip";
const MMDB_NAME = "geoip-aio-all.mmdb";
const MMDB_MAX_AGE_DAYS = 30;

/** Where the database is cached — the SDK's own location (CLEARCOTE_CACHE/geoip when set). */
export function geoCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLEARCOTE_CACHE) return path.join(env.CLEARCOTE_CACHE, "geoip");
  if (process.platform === "win32")
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "clearcote", "geoip");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "clearcote", "geoip");
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "clearcote", "geoip");
}

export function mmdbPath(): string {
  return path.join(geoCacheRoot(), MMDB_NAME);
}

// --- zip ------------------------------------------------------------------------------------------

/** The bytes of the first entry whose name ends in `suffix`, from a zip held in memory. Stored and
 *  deflated entries only (all the geoip archive uses); no zip64. */
export async function unzipEntry(zip: Buffer, suffix: string): Promise<Buffer | null> {
  // End of central directory: 22 bytes + a comment of up to 64 KB, at the very end.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = zip.readUInt16LE(at + 10);
    const csize = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (!name.toLowerCase().endsWith(suffix)) continue;
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error("corrupt zip local header");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + csize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return await inflateRaw(data);
    throw new Error(`unsupported zip compression method ${method}`);
  }
  return null;
}

// --- download -------------------------------------------------------------------------------------

let inflight: Promise<string | null> | null = null;

/**
 * The cached database path, downloading it when missing or older than 30 days. A failed refresh keeps
 * a stale database (it still beats none). Concurrent callers share one download. Never rejects.
 */
export function ensureMmdb(log: (m: string) => void = () => {}): Promise<string | null> {
  const file = mmdbPath();
  let stale = true;
  try {
    stale = (Date.now() - fs.statSync(file).mtimeMs) / 86_400_000 >= MMDB_MAX_AGE_DAYS;
  } catch {
    /* missing */
  }
  if (!stale) return Promise.resolve(file);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      log("geoip: downloading the geoip-all-in-one database (~52 MB, first use only)");
      const res = await fetch(MMDB_URL, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const mmdb = await unzipEntry(Buffer.from(await res.arrayBuffer()), ".mmdb");
      if (!mmdb) throw new Error("no .mmdb in the archive");
      openMetadata(mmdb); // refuse to install something that is not a MaxMind DB
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, mmdb);
      closeReader();
      fs.renameSync(tmp, file);
      log("geoip: database ready");
      return file;
    } catch (e) {
      log(`geoip: database download failed (${(e as Error).message})`);
      return fs.existsSync(file) ? file : null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Whether a first-use download is running right now (for a precise "still downloading" message). */
export function mmdbDownloading(): boolean {
  return inflight !== null;
}

// --- MaxMind DB reader ----------------------------------------------------------------------------

/** Random access to the database bytes: a Buffer in tests, a file descriptor in the app. */
interface Source {
  size: number;
  read(offset: number, length: number): Buffer;
}

function bufferSource(b: Buffer): Source {
  return { size: b.length, read: (o, n) => b.subarray(o, o + n) };
}

function fileSource(fd: number): Source {
  return {
    size: fs.fstatSync(fd).size,
    read(o, n) {
      const out = Buffer.alloc(n);
      const got = fs.readSync(fd, out, 0, n, o);
      return out.subarray(0, got);
    },
  };
}

const METADATA_MARKER = Buffer.from("\xab\xcd\xefMaxMind.com", "latin1");

interface Meta {
  nodeCount: number;
  recordSize: number;
  ipVersion: number;
  treeSize: number;
}

/** Decode one data-section value at `offset` (relative to `base`); returns the value and the next offset. */
function decode(src: Source, base: number, offset: number): [unknown, number] {
  const ctrl = src.read(base + offset, 1)[0];
  offset += 1;
  let type = ctrl >> 5;
  if (type === 1) {
    // Pointer into the data section: decode the value it points at, continue after the pointer.
    const ss = (ctrl >> 3) & 3;
    const b = src.read(base + offset, ss + 1);
    const v = ctrl & 7;
    let p: number;
    if (ss === 0) p = (v << 8) | b[0];
    else if (ss === 1) p = ((v << 16) | (b[0] << 8) | b[1]) + 2048;
    else if (ss === 2) p = ((v << 24) | (b[0] << 16) | (b[1] << 8) | b[2]) + 526336;
    else p = b.readUInt32BE(0);
    return [decode(src, base, p)[0], offset + ss + 1];
  }
  if (type === 0) {
    type = 7 + src.read(base + offset, 1)[0];
    offset += 1;
  }
  let size = ctrl & 0x1f;
  if (size >= 29) {
    const extra = size - 28;
    const b = src.read(base + offset, extra);
    offset += extra;
    if (size === 29) size = 29 + b[0];
    else if (size === 30) size = 285 + b.readUInt16BE(0);
    else size = 65821 + ((b[0] << 16) | (b[1] << 8) | b[2]);
  }
  switch (type) {
    case 2: // utf8 string
      return [src.read(base + offset, size).toString("utf8"), offset + size];
    case 3: // double
      return [src.read(base + offset, 8).readDoubleBE(0), offset + 8];
    case 4: // bytes
      return [Buffer.from(src.read(base + offset, size)), offset + size];
    case 5: // uint16
    case 6: // uint32
    case 8: // int32
    case 9: // uint64
    case 10: {
      // uint128 — the fields this app reads never use the wide ones; a Number is close enough.
      const b = src.read(base + offset, size);
      let n = 0;
      for (const x of b) n = n * 256 + x;
      if (type === 8 && size === 4) n = b.readInt32BE(0);
      return [n, offset + size];
    }
    case 7: {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < size; i++) {
        const [k, o1] = decode(src, base, offset);
        const [v, o2] = decode(src, base, o1);
        out[String(k)] = v;
        offset = o2;
      }
      return [out, offset];
    }
    case 11: {
      const out: unknown[] = [];
      for (let i = 0; i < size; i++) {
        const [v, o] = decode(src, base, offset);
        out.push(v);
        offset = o;
      }
      return [out, offset];
    }
    case 14: // boolean: the size IS the value
      return [size !== 0, offset];
    case 15: // float
      return [src.read(base + offset, 4).readFloatBE(0), offset + 4];
    default:
      throw new Error(`unsupported MaxMind DB data type ${type}`);
  }
}

function readMetadata(src: Source): Meta {
  const tailLen = Math.min(src.size, 128 * 1024);
  const tail = src.read(src.size - tailLen, tailLen);
  const at = tail.lastIndexOf(METADATA_MARKER);
  if (at < 0) throw new Error("not a MaxMind DB (no metadata marker)");
  const start = src.size - tailLen + at + METADATA_MARKER.length;
  const [m] = decode(src, start, 0) as [Record<string, unknown>, number];
  const nodeCount = Number(m.node_count);
  const recordSize = Number(m.record_size);
  if (![24, 28, 32].includes(recordSize) || !(nodeCount > 0)) throw new Error("unsupported MaxMind DB layout");
  return { nodeCount, recordSize, ipVersion: Number(m.ip_version), treeSize: (recordSize * 2 / 8) * nodeCount };
}

function openMetadata(b: Buffer): Meta {
  return readMetadata(bufferSource(b));
}

/** The bits of an IPv4 / IPv6 address, most significant first; null when it is not an address. */
export function ipBits(ip: string): number[] | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  const bytes: number[] = [];
  if (v4) {
    for (const p of v4.slice(1)) {
      const n = Number(p);
      if (n > 255) return null;
      bytes.push(n);
    }
  } else {
    if (!/^[0-9a-f:.]+$/i.test(ip) || !ip.includes(":")) return null;
    let s = ip;
    // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two hextets.
    const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (tail) {
      const q = tail.slice(1).map(Number);
      s = s.slice(0, tail.index) + ((q[0] << 8) | q[1]).toString(16) + ":" + ((q[2] << 8) | q[3]).toString(16);
    }
    const halves = s.split("::");
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(":") : [];
    const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
    const groups = [...head, ...Array(Math.max(0, fill)).fill("0"), ...rest];
    if (groups.length !== 8) return null;
    for (const g of groups) {
      const n = parseInt(g, 16);
      if (!/^[0-9a-f]{1,4}$/i.test(g) || Number.isNaN(n)) return null;
      bytes.push(n >> 8, n & 0xff);
    }
  }
  const bits: number[] = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  return bits;
}

function readRecord(src: Source, meta: Meta, node: number, bit: number): number {
  const rs = meta.recordSize;
  const off = node * (rs * 2 / 8);
  if (rs === 24) {
    const b = src.read(off + bit * 3, 3);
    return (b[0] << 16) | (b[1] << 8) | b[2];
  }
  if (rs === 28) {
    const b = src.read(off, 7);
    return bit === 0
      ? ((b[3] & 0xf0) << 20) | (b[0] << 16) | (b[1] << 8) | b[2]
      : (((b[3] & 0x0f) << 24) | (b[4] << 16) | (b[5] << 8) | b[6]) >>> 0;
  }
  return src.read(off + bit * 4, 4).readUInt32BE(0);
}

/** The record stored for `ip`, or null when the database has none. */
export function lookupIn(src: Source, meta: Meta, ip: string): Record<string, unknown> | null {
  let bits = ipBits(ip);
  if (!bits) return null;
  if (bits.length === 128 && meta.ipVersion === 4) return null;
  // An IPv4 address in an IPv6 tree lives under ::/96 (the SDKs' readers all do the same).
  if (bits.length === 32 && meta.ipVersion === 6) bits = [...Array(96).fill(0), ...bits];
  let node = 0;
  for (const bit of bits) {
    if (node >= meta.nodeCount) break;
    node = readRecord(src, meta, node, bit);
  }
  if (node <= meta.nodeCount) return null; // == nodeCount is the tree's "no data" marker
  const dataOffset = node - meta.nodeCount - 16;
  const [rec] = decode(src, meta.treeSize + 16, dataOffset);
  return rec && typeof rec === "object" ? (rec as Record<string, unknown>) : null;
}

/** Test seam: look an address up in a database held in memory. */
export function lookupBuffer(db: Buffer, ip: string): Record<string, unknown> | null {
  const src = bufferSource(db);
  return lookupIn(src, readMetadata(src), ip);
}

let reader: { fd: number; src: Source; meta: Meta; file: string; mtimeMs: number } | null = null;

function closeReader(): void {
  if (reader) {
    try {
      fs.closeSync(reader.fd);
    } catch {
      /* already closed */
    }
    reader = null;
  }
}

/** Look `ip` up in the cached database file. Reopens it when it was replaced since the last lookup. */
export function lookupFile(file: string, ip: string): Record<string, unknown> | null {
  const mtimeMs = fs.statSync(file).mtimeMs;
  if (!reader || reader.file !== file || reader.mtimeMs !== mtimeMs) {
    closeReader();
    const fd = fs.openSync(file, "r");
    try {
      const src = fileSource(fd);
      reader = { fd, src, meta: readMetadata(src), file, mtimeMs };
    } catch (e) {
      fs.closeSync(fd);
      throw e;
    }
  }
  return lookupIn(reader.src, reader.meta, ip);
}

export interface DbGeo {
  countryCode?: string;
  country?: string;
  city?: string;
  timezone?: string;
  lat?: number;
  lon?: number;
}

/** The fields a launch needs, from one database record. */
export function geoFromRecord(rec: Record<string, unknown> | null): DbGeo | null {
  if (!rec) return null;
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const country = obj(rec.country);
  const location = obj(rec.location);
  const city = obj(rec.city);
  const en = (o: Record<string, unknown>) => {
    const names = obj(o.names);
    return typeof names.en === "string" ? names.en : undefined;
  };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const out: DbGeo = {
    countryCode: typeof country.iso_code === "string" ? country.iso_code : undefined,
    country: en(country),
    city: en(city),
    timezone: typeof location.time_zone === "string" ? location.time_zone : undefined,
    lat: num(location.latitude),
    lon: num(location.longitude),
  };
  return out.timezone || out.lat != null ? out : null;
}
