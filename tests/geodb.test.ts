// The offline geoip database reader (electron/geodb.ts): zip extraction, address parsing, and — when the
// SDK's cached database is on this machine — real lookups against it.

import fs from "node:fs";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { geoFromRecord, ipBits, lookupFile, mmdbPath, unzipEntry } from "../electron/geodb";

/** A one-entry zip, deflated or stored. */
function zipOf(name: string, data: Buffer, deflate: boolean): Buffer {
  const body = deflate ? zlib.deflateRawSync(data) : data;
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(deflate ? 8 : 0, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(deflate ? 8 : 0, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBuf.length + body.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, body, central, nameBuf, eocd]);
}

describe("unzipEntry", () => {
  const payload = Buffer.from("MMDB ".repeat(5000));
  it("inflates a deflated entry", async () => {
    expect((await unzipEntry(zipOf("dir/geo.mmdb", payload, true), ".mmdb"))?.equals(payload)).toBe(true);
  });
  it("copies a stored entry", async () => {
    expect((await unzipEntry(zipOf("geo.mmdb", payload, false), ".mmdb"))?.equals(payload)).toBe(true);
  });
  it("answers null when no entry matches", async () => {
    expect(await unzipEntry(zipOf("README.txt", payload, true), ".mmdb")).toBeNull();
  });
  it("rejects something that is not a zip", async () => {
    await expect(unzipEntry(Buffer.from("not a zip at all, just some text here"), ".mmdb")).rejects.toThrow();
  });
});

describe("ipBits", () => {
  it("parses IPv4", () => {
    const b = ipBits("1.2.3.4")!;
    expect(b).toHaveLength(32);
    expect(b.slice(0, 8).join("")).toBe("00000001");
    expect(b.slice(24).join("")).toBe("00000100");
  });
  it("parses compressed IPv6 and an embedded IPv4 tail", () => {
    expect(ipBits("2001:db8::1")).toHaveLength(128);
    expect(ipBits("::ffff:1.2.3.4")!.slice(96).join("")).toBe(ipBits("1.2.3.4")!.join(""));
  });
  it("rejects what is not an address", () => {
    for (const s of ["", "1.2.3", "256.1.1.1", "example.com", "1::2::3", "12345::"]) expect(ipBits(s)).toBeNull();
  });
});

describe("geoFromRecord", () => {
  it("takes country, city, timezone and coordinates", () => {
    expect(
      geoFromRecord({
        country: { iso_code: "DE", names: { en: "Germany" } },
        city: { names: { en: "Berlin" } },
        location: { time_zone: "Europe/Berlin", latitude: 52.5, longitude: 13.4 },
      }),
    ).toEqual({ countryCode: "DE", country: "Germany", city: "Berlin", timezone: "Europe/Berlin", lat: 52.5, lon: 13.4 });
  });
  it("is null without a timezone or a position", () => {
    expect(geoFromRecord({ country: { iso_code: "DE" } })).toBeNull();
    expect(geoFromRecord(null)).toBeNull();
  });
});

const DB = mmdbPath();
describe.skipIf(!fs.existsSync(DB))("the cached geoip-all-in-one database", () => {
  it("places well-known addresses in the right country and timezone", () => {
    const de = geoFromRecord(lookupFile(DB, "85.214.132.117")); // Strato, Berlin
    expect(de?.countryCode).toBe("DE");
    expect(de?.timezone).toBe("Europe/Berlin");
    const jp = geoFromRecord(lookupFile(DB, "210.130.255.1")); // IIJ, Tokyo
    expect(jp?.countryCode).toBe("JP");
    expect(jp?.timezone).toBe("Asia/Tokyo");
    const v6 = geoFromRecord(lookupFile(DB, "2a01:4f8::1")); // Hetzner, Germany
    expect(v6?.countryCode).toBe("DE");
  });
  it("has nothing for private addresses", () => {
    expect(geoFromRecord(lookupFile(DB, "10.0.0.1"))).toBeNull();
    expect(geoFromRecord(lookupFile(DB, "192.168.1.1"))).toBeNull();
  });
});
