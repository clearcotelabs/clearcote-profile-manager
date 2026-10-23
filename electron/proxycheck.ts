// "Check proxy": does the proxy work, where does it exit, how slow is it, and does it carry UDP.
//
// The exit comes from geo.ts (the same echo + geo lookup "Resolve from proxy" uses), but nothing is
// written to the profile — this only reports. UDP is tested for real: a SOCKS5 UDP ASSOCIATE (RFC
// 1928), then one small DNS question through the relay it hands out. "Relay UDP through the proxy"
// only works when both succeed; most residential proxies refuse the command, and an HTTP proxy can
// never carry UDP at all.

import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { geoCheck } from "./geo";
import { parseProxy, proxyProblem, type ParsedProxy } from "./proxyargs";
import type { GeoResult, Profile } from "./types";

/** works: a datagram went out and an answer came back · refused: the proxy said no to UDP ·
 *  no-reply: it agreed, but nothing came back · not-socks: an HTTP(S) proxy, which cannot carry UDP ·
 *  error: the proxy could not be reached or logged into for the test. */
export type UdpVerdict = "works" | "refused" | "no-reply" | "not-socks" | "error";

export interface ProxyCheck {
  ok: boolean;
  /** Round trip of the exit lookup through the proxy, in ms. */
  ms?: number;
  geo?: GeoResult;
  udp?: UdpVerdict;
  udpDetail?: string;
  error?: string;
}

const REPLIES: Record<number, string> = {
  1: "general failure",
  2: "not allowed by the proxy's rules",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "UDP is not supported by this proxy",
  8: "address type not supported",
};

/** Reads exactly n bytes from a socket, or fails on close/timeout. */
function reader(sock: net.Socket) {
  let buf = Buffer.alloc(0);
  let wake: (() => void) | null = null;
  let failed: Error | null = null;
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    wake?.();
  });
  const fail = (e: Error) => {
    failed = e;
    wake?.();
  };
  sock.on("error", fail);
  sock.on("close", () => fail(new Error("the proxy closed the connection")));
  return async (n: number): Promise<Buffer> => {
    while (buf.length < n) {
      if (failed) throw failed;
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
}

/** A DNS question for example.com (A), as a UDP payload. */
export function dnsQuery(id = 0x4343): Buffer {
  const name = Buffer.concat([Buffer.from([7]), Buffer.from("example"), Buffer.from([3]), Buffer.from("com"), Buffer.from([0])]);
  const head = Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  return Buffer.concat([head, name, Buffer.from([0x00, 0x01, 0x00, 0x01])]);
}

/** The SOCKS5 UDP request header (RFC 1928 §7) for an IPv4 destination, followed by the data. */
export function socksUdpPacket(ip: string, port: number, data: Buffer): Buffer {
  const octets = ip.split(".").map(Number);
  return Buffer.concat([Buffer.from([0, 0, 0, 1, ...octets, port >> 8, port & 0xff]), data]);
}

/** Parses a SOCKS5 reply's bound address (after VER, REP, RSV): returns host, port and the bytes used. */
export function parseBound(b: Buffer): { host: string; port: number; len: number } | null {
  const atyp = b[0];
  if (atyp === 1 && b.length >= 7) return { host: [...b.subarray(1, 5)].join("."), port: b.readUInt16BE(5), len: 7 };
  if (atyp === 4 && b.length >= 19) {
    const parts: string[] = [];
    for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(1 + i).toString(16));
    return { host: parts.join(":"), port: b.readUInt16BE(17), len: 19 };
  }
  if (atyp === 3 && b.length >= 2 && b.length >= 2 + b[1] + 2) {
    const n = b[1];
    return { host: b.subarray(2, 2 + n).toString(), port: b.readUInt16BE(2 + n), len: 4 + n };
  }
  return null;
}

/** RFC 1928 UDP ASSOCIATE, then one DNS question to 1.1.1.1 through the relay. */
export async function probeSocksUdp(px: ParsedProxy, timeoutMs = 6000): Promise<{ udp: UdpVerdict; detail?: string }> {
  if (!px.scheme.startsWith("socks5")) return { udp: "not-socks", detail: "An HTTP proxy only carries ordinary connections, never UDP." };
  const sock = net.connect({ host: px.host, port: px.port });
  sock.setNoDelay(true);
  const timer = setTimeout(() => sock.destroy(new Error("the proxy did not answer in time")), timeoutMs);
  const read = reader(sock);
  let udpSock: dgram.Socket | null = null;
  try {
    await new Promise<void>((ok, bad) => {
      sock.once("connect", ok);
      sock.once("error", bad);
    });
    const auth = !!(px.username || px.password);
    sock.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]));
    const [ver, method] = await read(2);
    if (ver !== 5) return { udp: "error", detail: "This is not a SOCKS5 proxy." };
    if (method === 2) {
      // parseProxy has already decoded them.
      const u = Buffer.from(px.username || "");
      const p = Buffer.from(px.password || "");
      sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
      const [, status] = await read(2);
      if (status !== 0) return { udp: "error", detail: "The proxy refused the login." };
    } else if (method !== 0) {
      return { udp: "error", detail: "The proxy wants a login method this test does not speak." };
    }
    // UDP ASSOCIATE from "any address": the client's own address is not known before NAT.
    sock.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]));
    const [, rep, , atyp] = await read(4);
    if (rep !== 0) return { udp: "refused", detail: REPLIES[rep] ? `The proxy said: ${REPLIES[rep]}.` : `The proxy refused (code ${rep}).` };
    const rest = atyp === 1 ? await read(6) : atyp === 4 ? await read(18) : await read(1).then(async (l) => Buffer.concat([l, await read(l[0] + 2)]));
    const bound = parseBound(Buffer.concat([Buffer.from([atyp]), rest]));
    if (!bound) return { udp: "error", detail: "The proxy's answer could not be read." };
    // A relay of 0.0.0.0 means "the address you connected to".
    let relayHost = bound.host === "0.0.0.0" || bound.host === "0:0:0:0:0:0:0:0" ? sock.remoteAddress || px.host : bound.host;
    if (net.isIP(relayHost) === 0) relayHost = (await dns.lookup(relayHost)).address;
    const family = net.isIP(relayHost) === 6 ? "udp6" : "udp4";
    const udp = dgram.createSocket(family);
    udpSock = udp;
    const answered = new Promise<boolean>((resolve) => {
      udp.on("message", () => resolve(true));
      udp.on("error", () => resolve(false));
      setTimeout(() => resolve(false), Math.max(1500, timeoutMs - 1500));
    });
    udp.send(socksUdpPacket("1.1.1.1", 53, dnsQuery()), bound.port, relayHost);
    return (await answered)
      ? { udp: "works" }
      : { udp: "no-reply", detail: "The proxy accepted UDP, but no answer came back through it." };
  } catch (e) {
    return { udp: "error", detail: (e as Error)?.message || String(e) };
  } finally {
    clearTimeout(timer);
    udpSock?.close();
    sock.destroy();
  }
}

/** The whole check. Never changes the profile. */
export async function checkProxy(profile: Profile): Promise<ProxyCheck> {
  const unreadable = proxyProblem(profile.proxy);
  if (unreadable) return { ok: false, error: unreadable };
  let px: ParsedProxy | null;
  try {
    px = parseProxy(profile.proxy);
  } catch (e) {
    return { ok: false, error: `This proxy address cannot be read (${(e as Error)?.message || e}).` };
  }
  if (!px) return { ok: false, error: "There is no proxy to check." };
  const t0 = Date.now();
  let ms = 0;
  const [geo, udp] = await Promise.all([
    geoCheck(profile).then((g) => {
      ms = Date.now() - t0;
      return g;
    }),
    probeSocksUdp(px),
  ]);
  if (!geo.ok) return { ok: false, error: geo.error || "The proxy did not work.", geo, udp: udp.udp, udpDetail: udp.detail };
  return { ok: true, ms, geo, udp: udp.udp, udpDetail: udp.detail };
}
