// CR-LYJSFW, 0.26: when Profile Manager sends UDP through a SOCKS5 proxy, and in what order.
//
// Measured on ~30 fresh residential sticky sessions (2026-10-24): the FIRST UDP ASSOCIATE moves a
// sticky session to another exit, even with no datagram sent, and later associations leave it there.
// Check used to send one on every click, in parallel with the exit lookup, and the app sent another
// after every launch with Relay UDP on. These tests pin the new rules against a local SOCKS5 server
// that logs every UDP ASSOCIATE into the same timeline as the (stubbed) exit lookups:
//   - Check with Relay UDP off sends no UDP at all, unless asked.
//   - With Relay UDP on, Check, Resolve and the launch send the association BEFORE the exit lookup.
//   - Check names a move when the test moved the session.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import net from "node:net";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Profile } from "../electron/types";

/** One timeline for the whole file: "geo" for every exit lookup, "associate" for every UDP ASSOCIATE. */
const timeline: string[] = [];
/** The exits the stubbed lookup answers with, in turn (the last one repeats). */
let exits: string[] = ["81.2.3.4"];
const geoCheck = vi.hoisted(() => vi.fn());
vi.mock("../electron/geo", () => ({ geoCheck }));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-udppin-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const { checkProxy, resolveExit, pinUdpSession } = await import("../electron/proxycheck");
const { prepareProxySession } = await import("../electron/launcher");
const { describeCheck, UDP_NOT_TESTED } = await import("../src/lib/proxyReport");

/** SOCKS5 with a login; grants UDP ASSOCIATE and answers every datagram, logging the command. */
function fakeSocks() {
  const closers: (() => void)[] = [];
  const server = net.createServer((c) => {
    let stage = 0;
    let buf = Buffer.alloc(0);
    c.on("error", () => {});
    c.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        buf = buf.subarray(2 + buf[1]);
        c.write(Buffer.from([5, 2]));
        stage = 1;
      }
      if (stage === 1 && buf.length >= 2) {
        const ul = buf[1];
        if (buf.length < 3 + ul) return;
        const pl = buf[2 + ul];
        if (buf.length < 3 + ul + pl) return;
        buf = buf.subarray(3 + ul + pl);
        c.write(Buffer.from([1, 0]));
        stage = 2;
      }
      if (stage === 2 && buf.length >= 10) {
        stage = 3;
        if (buf[1] !== 3) {
          c.write(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
          return c.end();
        }
        timeline.push("associate");
        const relay = dgram.createSocket("udp4");
        closers.push(() => relay.close());
        relay.on("message", (msg, from) => relay.send(Buffer.concat([msg.subarray(0, 10), Buffer.from("answer")]), from.port, from.address));
        relay.bind(0, "127.0.0.1", () => {
          const port = relay.address().port;
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, port >> 8, port & 0xff]));
        });
      }
    });
  });
  return new Promise<{ url: string; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ url: `socks5://u:p@127.0.0.1:${port}`, close: () => (closers.forEach((f) => f()), server.close()) });
    }),
  );
}

let socks: { url: string; close: () => void };
beforeEach(async () => {
  timeline.length = 0;
  exits = ["81.2.3.4"];
  let n = 0;
  geoCheck.mockReset();
  geoCheck.mockImplementation(async () => {
    timeline.push("geo");
    const ip = exits[Math.min(n++, exits.length - 1)];
    return { ok: true, ip, country: "Denmark", countryCode: "DK", timezone: "Europe/Copenhagen", acceptLanguage: "da-DK,da,en", lat: 55.6, lon: 12.5 };
  });
  socks = await fakeSocks();
});
afterEach(() => socks.close());

const profile = (over: Partial<Profile> = {}): Profile =>
  ({ id: "p", name: "p", fingerprint: "seed", createdAt: "", updatedAt: "", proxy: socks.url, geoip: true, ...over }) as Profile;

describe("Check", () => {
  it("Relay UDP off: no UDP goes through the proxy, and the result says UDP was not tested", async () => {
    const c = await checkProxy(profile());
    expect(timeline).toEqual(["geo"]);
    expect(c.ok).toBe(true);
    expect(c.udp).toBeUndefined();
    expect(c.udpSkipped).toBe(true);
    expect(describeCheck(c).lines).toContain(UDP_NOT_TESTED);
  });

  it("clicking Check again and again never sends UDP while Relay UDP is off", async () => {
    for (let i = 0; i < 3; i++) await checkProxy(profile());
    expect(timeline).toEqual(["geo", "geo", "geo"]);
  });

  it("asked (Test UDP): exit, then the UDP test, then the exit again — never in parallel", async () => {
    const c = await checkProxy(profile(), { udp: true });
    expect(timeline).toEqual(["geo", "associate", "geo"]);
    expect(c.udp).toBe("works");
    expect(c.udpSkipped).toBeUndefined();
  });

  it("Relay UDP on: the same order without being asked", async () => {
    await checkProxy(profile({ socks5Udp: true }));
    expect(timeline).toEqual(["geo", "associate", "geo"]);
  });

  it("names the move when the UDP test moved the session, and reports where it stays", async () => {
    exits = ["87.50.91.122", "62.198.28.61"];
    const c = await checkProxy(profile({ socks5Udp: true }));
    expect(c.moved).toEqual({ from: "87.50.91.122", to: "62.198.28.61" });
    expect(c.geo?.ip).toBe("62.198.28.61");
    const lines = describeCheck(c).lines;
    expect(lines[0]).toContain("62.198.28.61");
    expect(lines).toContain("The UDP test moved this session from 87.50.91.122 to 62.198.28.61. It stays on 62.198.28.61 from now on.");
  });

  it("an HTTP proxy is never sent UDP and is not offered a test", async () => {
    const c = await checkProxy(profile({ proxy: "http://u:p@127.0.0.1:9", socks5Udp: true }));
    expect(timeline).toEqual(["geo"]);
    expect(c.udp).toBe("not-socks");
    expect(c.udpSkipped).toBeUndefined();
  });
});

describe("Resolve from proxy", () => {
  it("Relay UDP on: the first UDP association comes BEFORE the exit lookup", async () => {
    await resolveExit(profile({ socks5Udp: true }));
    expect(timeline).toEqual(["associate", "geo"]);
  });

  it("Relay UDP off: the exit lookup only", async () => {
    await resolveExit(profile());
    expect(timeline).toEqual(["geo"]);
  });
});

describe("launch", () => {
  it("Relay UDP on: associate, then geoip — and the verdict comes back for the launch message", async () => {
    const r = await prepareProxySession(profile({ socks5Udp: true }));
    expect(timeline).toEqual(["associate", "geo"]);
    expect(r.udp?.udp).toBe("works");
    expect(r.profile.webrtcIp).toBe("81.2.3.4");
  });

  it("Relay UDP on: the WebRTC IP is the exit AFTER the association", async () => {
    // The association moves the session: every lookup after it sees the new exit.
    exits = ["62.198.28.61"];
    const r = await prepareProxySession(profile({ socks5Udp: true, webrtcIp: undefined }));
    expect(r.profile.webrtcIp).toBe("62.198.28.61");
  });

  it("Relay UDP off: no UDP at all before the browser starts", async () => {
    const r = await prepareProxySession(profile());
    expect(timeline).toEqual(["geo"]);
    expect(r.udp).toBeUndefined();
  });

  it("an unreadable proxy is never pinned", async () => {
    expect(await pinUdpSession({ proxy: "socks5://", socks5Udp: true })).toBeNull();
  });
});
