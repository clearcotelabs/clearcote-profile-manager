// The zlib zip reader Linux uses for the Widevine CDM and the CRLSet: GNU tar, the PATH `tar` on Ubuntu, Debian
// and Fedora, cannot read .zip, so both installs failed there ("tar exited 2", measured 2026-11-20).
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { extractZipFile, readZip } from "../electron/unzip";
import { crx3ToZip, extractZip } from "../electron/widevine";

const dirs: string[] = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-unzip-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  return (c ^ 0xffffffff) >>> 0;
}

interface In { name: string; data?: string | Buffer; method?: 0 | 8; mode?: number; badCrc?: boolean }
/** A minimal zip writer, independent of the reader under test. */
function zip(entries: In[], comment = ""): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = e.data === undefined ? Buffer.alloc(0) : Buffer.from(e.data);
    const method = e.name.endsWith("/") ? 0 : e.method ?? 8;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = e.badCrc ? (crc32(data) ^ 1) >>> 0 : crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(((e.mode ?? 0o644) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp); centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const c = Buffer.from(comment, "latin1");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(c.length, 20);
  return Buffer.concat([...locals, cd, end, c]);
}

describe("readZip / extractZipFile", () => {
  it("reads stored and deflated files and folders, with the CDM's layout", () => {
    const lib = Buffer.alloc(200000, 7);
    const buf = zip([
      { name: "manifest.json", data: '{"version":"4.10.3112.0"}' },
      { name: "_platform_specific/" },
      { name: "_platform_specific/linux_x64/libwidevinecdm.so", data: lib, mode: 0o755 },
      { name: "LICENSE", data: "text", method: 0 },
    ], "a trailing archive comment");
    const dest = mk(), archive = path.join(mk(), "cdm.zip");
    fs.writeFileSync(archive, buf);
    extractZipFile(archive, dest);
    expect(fs.readFileSync(path.join(dest, "manifest.json"), "utf8")).toBe('{"version":"4.10.3112.0"}');
    expect(fs.readFileSync(path.join(dest, "_platform_specific", "linux_x64", "libwidevinecdm.so")).equals(lib)).toBe(true);
    expect(fs.readFileSync(path.join(dest, "LICENSE"), "utf8")).toBe("text");
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(dest, "_platform_specific", "linux_x64", "libwidevinecdm.so")).mode & 0o777).toBe(0o755);
    }
  });

  it("refuses a damaged entry and writes nothing", () => {
    const dest = mk(), archive = path.join(mk(), "bad.zip");
    fs.writeFileSync(archive, zip([{ name: "ok.txt", data: "fine" }, { name: "crl-set", data: "x".repeat(100), badCrc: true }]));
    expect(() => extractZipFile(archive, dest)).toThrow(/CRC-32/);
    expect(fs.readdirSync(dest)).toEqual([]);
  });

  it("refuses names that would land outside the destination", () => {
    for (const name of ["../evil", "a/../../evil", "/etc/evil", "C:/evil", "..\\evil"]) {
      const dest = mk(), archive = path.join(mk(), "t.zip");
      fs.writeFileSync(archive, zip([{ name, data: "x" }]));
      expect(() => extractZipFile(archive, dest), name).toThrow(/outside the destination/);
    }
  });

  it("refuses what is not a zip, and zip64", () => {
    expect(() => readZip(Buffer.from("plainly not a zip archive at all"))).toThrow(/not a zip/);
    const z = zip([{ name: "a", data: "b" }]);
    z.writeUInt32LE(0xffffffff, z.length - 22 + 16);
    expect(() => readZip(z)).toThrow(/zip64/);
  });

  it("is what extractZip uses on Linux, after crx3ToZip, with the reason in the error", async () => {
    const payload = zip([{ name: "crl-set", data: "CRLSET-BYTES" }]);
    const header = Buffer.from([0x0a, 0x0b, 0x0c]);
    const crx = Buffer.concat([Buffer.from("Cr24"), Buffer.from([3, 0, 0, 0]), Buffer.from([header.length, 0, 0, 0]), header, payload]);
    const archive = path.join(mk(), "crlset.zip"), dest = mk();
    fs.writeFileSync(archive, crx3ToZip(crx));
    await extractZip(archive, dest, "the CRLSet", "linux");
    expect(fs.readFileSync(path.join(dest, "crl-set"), "utf8")).toBe("CRLSET-BYTES");
    fs.writeFileSync(archive, Buffer.from("garbage"));
    await expect(extractZip(archive, mk(), "the CRLSet", "linux")).rejects.toThrow(/could not extract the CRLSet: not a zip/);
  });
});
