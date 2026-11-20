// A small .zip reader on Node's own zlib, for the two archives this app downloads from Google's component
// updater: the Widevine CDM and the CRLSet (both CRX3, unwrapped to a plain zip by crx3ToZip).
//
// Why it exists: on Linux the system `tar` is GNU tar on Ubuntu, Debian and Fedora, and GNU tar cannot read
// .zip ("tar exited 2"), so on a standard Linux PC both installs failed and the browser started without DRM and
// without the revocation list (measured on Ubuntu, GNU tar 1.34, 2026-11-20). Windows (System32 bsdtar) and
// macOS (bsdtar) read zip with `tar` and keep using it. The engine archive itself is .tar.xz and never comes here.
//
// Supports what those archives use: stored (0) and deflate (8) entries, no zip64, no encryption. Every entry is
// checked against its CRC-32 and size, and a name that would land outside the destination is refused.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** CRC-32 (IEEE), the zip checksum. zlib.crc32 where the runtime has it (Node 20.15+ / 22.2+). */
const crc32: (b: Buffer) => number =
  typeof (zlib as unknown as { crc32?: unknown }).crc32 === "function"
    ? (b) => (zlib as unknown as { crc32: (d: Buffer) => number }).crc32(b) >>> 0
    : (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
          let c = n;
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
          table[n] = c >>> 0;
        }
        return (b: Buffer) => {
          let c = 0xffffffff;
          for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xff] ^ (c >>> 8);
          return (c ^ 0xffffffff) >>> 0;
        };
      })();

export interface ZipEntry {
  name: string;
  isDir: boolean;
  data?: Buffer;
  /** Unix permission bits, when the archive was made on a Unix system and carries them. */
  mode?: number;
}

/** Every entry of a zip held in memory, decompressed and verified. Throws on anything it cannot read exactly. */
export function readZip(buf: Buffer): ZipEntry[] {
  // The end-of-central-directory record sits in the last 22 bytes plus a comment of at most 65535 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip archive (no end of central directory)");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("zip64 archives are not supported");

  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new Error("corrupt zip (central directory)");
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new Error(`encrypted zip entry: ${name}`);
    const mode = madeBy === 3 ? (external >>> 16) & 0o777 : undefined;
    if (name.endsWith("/")) { out.push({ name, isDir: true, mode }); continue; }

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL) throw new Error(`corrupt zip (local header of ${name})`);
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + compSize > buf.length) throw new Error(`corrupt zip (${name} runs past the end)`);
    const raw = buf.subarray(start, start + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported zip compression method ${method} (${name})`);
    if (data.length !== size) throw new Error(`zip entry ${name}: ${data.length} bytes, expected ${size}`);
    if (crc32(data) !== crc) throw new Error(`zip entry ${name}: CRC-32 mismatch`);
    out.push({ name, isDir: false, data, mode });
  }
  return out;
}

/** Where `name` lands under `dest`, or an error when it would land outside it (absolute, drive letter, "..") . */
function target(dest: string, name: string): string {
  const clean = name.replace(/\\/g, "/");
  if (clean.startsWith("/") || /^[A-Za-z]:/.test(clean) || clean.split("/").includes("..")) {
    throw new Error(`zip entry outside the destination: ${name}`);
  }
  const root = path.resolve(dest);
  const full = path.resolve(root, clean);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`zip entry outside the destination: ${name}`);
  return full;
}

/** Extract `archive` (a .zip file) into `dest`. Every entry is read and checked before anything is written. */
export function extractZipFile(archive: string, dest: string): void {
  const entries = readZip(readFileSync(archive));
  const planned = entries.map((e) => ({ e, full: target(dest, e.name) }));
  mkdirSync(dest, { recursive: true });
  for (const { e, full } of planned) {
    if (e.isDir) { mkdirSync(full, { recursive: true }); continue; }
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, e.data!);
    if (e.mode && process.platform !== "win32") {
      try { chmodSync(full, e.mode | 0o600); } catch { /* the file is written; its bits stay the default */ }
    }
  }
}
