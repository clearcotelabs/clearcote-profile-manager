// The pure half of the Widevine opt-in: parsing Google's Omaha response, unwrapping the CRX3
// container, and deciding which switches a seeded CDM needs. The network fetch and the on-disk seed
// are exercised by tests/launch.e2e.test.ts against a real browser.
//
// The security-relevant assertion here is the CRX3 one: what comes back is a NATIVE library that
// gets loaded into the browser process, so a truncated or malformed container must throw rather
// than produce a short buffer that later looks like a valid zip.

import { describe, it, expect } from "vitest";
import {
  omahaRequestBody,
  parseUpdate,
  crx3ToZip,
  widevineArgs,
  claimsChromeBrand,
  cdmPlatform,
  WIDEVINE_APP_ID,
} from "../electron/widevine";

describe("omahaRequestBody", () => {
  const body = omahaRequestBody() as any;

  it("asks for the Widevine component by Chrome's own app id", () => {
    expect(body.request.app[0].appid).toBe(WIDEVINE_APP_ID);
    // Version 0.0.0.0 is what makes the server answer with the latest build rather than a delta.
    expect(body.request.app[0].version).toBe("0.0.0.0");
  });

  it("requests a crx3 package for x64", () => {
    expect(body.request.acceptformat).toBe("crx3");
    expect(body.request.arch).toBe("x64");
    expect(body.request.protocol).toBe("3.1");
  });

  it("describes the OS it is actually running on", () => {
    // Asking as the wrong OS returns a CDM that cannot load.
    expect(body.request.os.platform).toBe(cdmPlatform().osPlatform);
    expect(body.request["@os"]).toBe(cdmPlatform().atOs);
  });
});

describe("cdmPlatform", () => {
  it("pairs the library name with its platform directory", () => {
    const p = cdmPlatform();
    if (process.platform === "linux") {
      expect(p).toMatchObject({ subdir: "linux_x64", filename: "libwidevinecdm.so" });
    } else {
      expect(p).toMatchObject({ subdir: "win_x64", filename: "widevinecdm.dll" });
    }
  });
});

describe("parseUpdate", () => {
  const pipelines = {
    response: {
      app: [
        {
          nextversion: "4.10.3050.0",
          updatecheck: {
            status: "ok",
            pipelines: [
              {
                operations: [
                  { urls: [{ url: "https://edgedl.example/cdm.crx3" }], out: { sha256: "a".repeat(64) } },
                ],
              },
            ],
          },
        },
      ],
    },
  };

  it("reads the modern pipelines shape", () => {
    expect(parseUpdate(pipelines)).toEqual(["https://edgedl.example/cdm.crx3", "a".repeat(64), "4.10.3050.0"]);
  });

  it("reads the classic codebase/package shape", () => {
    const classic = {
      response: {
        app: [
          {
            updatecheck: {
              status: "ok",
              urls: { url: [{ codebase: "https://edgedl.example/path/" }] },
              manifest: { version: "4.10.2891.0", packages: { package: [{ name: "cdm.crx3", hash_sha256: "b".repeat(64) }] } },
            },
          },
        ],
      },
    };
    // The trailing slash on the codebase must not produce a double slash.
    expect(parseUpdate(classic)).toEqual(["https://edgedl.example/path/cdm.crx3", "b".repeat(64), "4.10.2891.0"]);
  });

  it("throws when the server reports a non-ok status", () => {
    expect(() => parseUpdate({ response: { app: [{ updatecheck: { status: "noupdate" } }] } })).toThrow(/noupdate/);
  });

  it("throws rather than returning a partial result when no url is present", () => {
    expect(() => parseUpdate({ response: { app: [{ updatecheck: { status: "ok", pipelines: [] } }] } })).toThrow(
      /could not find a CDM download URL/i,
    );
  });

  it("throws on a junk response instead of dereferencing undefined", () => {
    expect(() => parseUpdate({})).toThrow();
    expect(() => parseUpdate(null)).toThrow();
  });
});

describe("crx3ToZip", () => {
  /** 'Cr24' + version + headerLen + header + payload. */
  const crx = (header: Buffer, payload: Buffer) => {
    const head = Buffer.alloc(12);
    head.write("Cr24", 0, "latin1");
    head.writeUInt32LE(3, 4);
    head.writeUInt32LE(header.length, 8);
    return Buffer.concat([head, header, payload]);
  };

  it("strips the CRX3 header and returns the zip payload", () => {
    const payload = Buffer.from("PKrest-of-zip");
    expect(crx3ToZip(crx(Buffer.alloc(40, 7), payload)).toString()).toBe(payload.toString());
  });

  it("passes a plain zip through untouched", () => {
    const zip = Buffer.from("PKalready-a-zip");
    expect(crx3ToZip(zip)).toBe(zip);
  });

  it("throws on a truncated header rather than returning a short buffer", () => {
    expect(() => crx3ToZip(Buffer.from("Cr24" + "xy"))).toThrow(/truncated/i);
  });

  it("throws when the declared header length runs past the buffer", () => {
    // A malformed length would otherwise subarray past the end and yield an empty "zip".
    const head = Buffer.alloc(12);
    head.write("Cr24", 0, "latin1");
    head.writeUInt32LE(3, 4);
    head.writeUInt32LE(0xffff, 8);
    expect(() => crx3ToZip(Buffer.concat([head, Buffer.alloc(10)]))).toThrow(/overruns/i);
  });
});

describe("widevineArgs", () => {
  it("forces the component scan on Windows, and adds nothing on Linux", () => {
    const out = widevineArgs([]);
    if (process.platform === "linux") {
      // The hint file IS the registration there; it is read at startup regardless.
      expect(out).toEqual([]);
    } else {
      expect(out).toEqual(["--component-updater=fast-update"]);
    }
  });

  it("never emits a second component-updater switch", () => {
    // Chromium takes the last occurrence, and a command line carrying the same switch twice is a
    // shape no real browser produces — the engine exposes its command line over CDP.
    expect(widevineArgs(["--component-updater=fast-update"])).toEqual([]);
    expect(widevineArgs(["--component-updater=something-else"])).toEqual([]);
  });
});

describe("claimsChromeBrand — who the CDM row applies to", () => {
  it("an unset brand counts, because it defaults to chrome", () => {
    // This is the case that matters: every profile created in the app has no explicit brand and
    // still ends up asserting "Google Chrome".
    expect(claimsChromeBrand(undefined)).toBe(true);
  });
  it("chrome in any casing or spelling counts", () => {
    expect(claimsChromeBrand("chrome")).toBe(true);
    expect(claimsChromeBrand("Chrome")).toBe(true);
    expect(claimsChromeBrand("Google Chrome")).toBe(true);
  });
  it("other brands do not — a de-Googled build reporting them is exempt", () => {
    expect(claimsChromeBrand("Chromium")).toBe(false);
    expect(claimsChromeBrand("Edge")).toBe(false);
    expect(claimsChromeBrand("Opera")).toBe(false);
    expect(claimsChromeBrand("Brave")).toBe(false);
  });
});
