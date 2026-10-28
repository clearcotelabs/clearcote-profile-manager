// "Check proxy": does the proxy work, where does it exit, how slow is it, and does it carry UDP.
//
// The exit comes from geo.ts (the same echo + geo lookup "Resolve from proxy" uses), but nothing is
// written to the profile — this only reports. UDP is tested for real: a SOCKS5 UDP ASSOCIATE (RFC
// 1928), then one small DNS question through the relay it hands out. "Relay UDP through the proxy"
// only works when both succeed; most residential proxies refuse the command, and an HTTP proxy can
// never carry UDP at all.
//
// A UDP test is NOT harmless (CR-LYJSFW, measured 2026-10-24 on ~30 fresh residential sticky
// sessions): the FIRST UDP ASSOCIATE moves a sticky session to another exit — one of the vendor's
// exits that carry UDP — even when no datagram is ever sent (17 of 18 moved; untouched sessions 0 of
// 7). Later associations leave it there (1 move in 66). Check used to run that test on every click,
// in parallel with the exit lookup, so "Resolve" showed one address and the second "Check" another;
// after a launch with Relay UDP on the app ran it again by itself and moved the session under the
// running browser. So now:
//   - Check tests UDP only when Relay UDP is on (the launch will make that association anyway) or
//     when asked (`udp: true`, the editor's "Test UDP", which warns first). It tests BEFORE the
//     final exit lookup and reports the move, so the address it shows is where the session stays.
//   - Resolve and launch make the association first when Relay UDP is on (pinUdpSession), so the
//     exit they look up is the one the browser's UDP will leave from too.

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
  /** True when UDP was deliberately not tested (a SOCKS5 proxy, Relay UDP off, not asked). */
  udpSkipped?: boolean;
  /** The UDP test moved the session: where it exited before the test and where it exits now. */
  moved?: { from: string; to: string };
  error?: string;
}

/** What a caller may ask of Check. `udp: true` tests UDP even with Relay UDP off. */
export interface CheckOptions {
  udp?: boolean;
}

/** A SOCKS5 proxy whose profile relays UDP: the case where the first association has to come first. */
function relaysUdp(profile: Pick<Profile, "proxy" | "socks5Udp">): ParsedProxy | null {
  if (!profile.socks5Udp) return null;
  try {
    const px = parseProxy(profile.proxy);
    return px && px.scheme.startsWith("socks5") ? px : null;
  } catch {
    return null;
  }
}

/**
 * The proxy the browser is handed when Relay UDP is on: a socks5 proxy given by host name, with that name
 * looked up to an IPv4 address here. The engine relays UDP (WebRTC, and HTTP/3 on PRO r54+) only through
 * a proxy given as an IP address — it opens the association without a host lookup of its own — so a
 * provider gateway given by name was never relayed. Looked up once, every connection of the browser (TCP
 * and UDP) goes to the same address. Anything else comes back unchanged; so does a name that does not
 * resolve, with a warning (UDP is then not relayed, as before).
 */
export async function relayProxyByIp(
  px: ParsedProxy | null,
  socks5Udp: boolean | undefined,
  lookup: (host: string) => Promise<string> = async (host) => (await dns.lookup(host, { family: 4 })).address,
): Promise<{ proxy: ParsedProxy | null; warning?: string }> {
  if (!px || !socks5Udp || !px.scheme.startsWith("socks5") || !px.host || net.isIP(px.host.replace(/^\[|\]$/g, ""))) {
    return { proxy: px };
  }
  try {
    return { proxy: { ...px, host: await lookup(px.host) } };
  } catch (e) {
    return {
      proxy: px,
      warning: `Could not look up the proxy host ${px.host} (${String((e as Error)?.message || e)}). UDP is relayed only through a proxy given as an IP address, so it is not relayed on this launch.`,
    };
  }
}

/**
 * With Relay UDP on, make the session's first UDP association now — before anything looks up the
 * exit — and report whether UDP gets through. Null when there is nothing to pin (no SOCKS5 proxy,
 * Relay UDP off). Never throws: a failed pin is a verdict, and the caller goes on.
 */
export async function pinUdpSession(profile: Pick<Profile, "proxy" | "socks5Udp">): Promise<{ udp: UdpVerdict; detail?: string } | null> {
  const px = relaysUdp(profile);
  return px ? probeSocksUdp(px) : null;
}

/** "Resolve from proxy": the exit a launch will present. With Relay UDP on, the session is pinned
 *  first, so the address stored is the one the browser ends up with. */
export async function resolveExit(profile: Profile): Promise<GeoResult> {
  if (!proxyProblem(profile.proxy)) await pinUdpSession(profile);
  return geoCheck(profile);
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

/** The whole check. Never changes the profile. UDP is tested only with Relay UDP on or `opts.udp`
 *  (see the top of this file for why a test is not harmless). */
export async function checkProxy(profile: Profile, opts: CheckOptions = {}): Promise<ProxyCheck> {
  const unreadable = proxyProblem(profile.proxy);
  if (unreadable) return { ok: false, error: unreadable };
  let px: ParsedProxy | null;
  try {
    px = parseProxy(profile.proxy);
  } catch (e) {
    return { ok: false, error: `This proxy address cannot be read (${(e as Error)?.message || e}).` };
  }
  if (!px) return { ok: false, error: "There is no proxy to check." };
  const socks5 = px.scheme.startsWith("socks5");
  const lookup = async () => {
    const t0 = Date.now();
    const g = await geoCheck(profile);
    return { g, ms: Date.now() - t0 };
  };

  // No UDP test: the exit and the speed only. An HTTP proxy cannot carry UDP, which needs no test.
  if (!socks5 || !(opts.udp || profile.socks5Udp)) {
    const { g, ms } = await lookup();
    const udpPart = socks5 ? { udpSkipped: true } : { udp: "not-socks" as const, udpDetail: "An HTTP proxy only carries ordinary connections, never UDP." };
    if (!g.ok) return { ok: false, error: g.error || "The proxy did not work.", geo: g, ...udpPart };
    return { ok: true, ms, geo: g, ...udpPart };
  }

  // UDP test: where it exits now, the test, then where it exits after — in that order, never in
  // parallel, so the address reported is the one the session stays on, and a move is named.
  const before = await lookup();
  const udp = await probeSocksUdp(px);
  const after = await lookup();
  const geo = after.g.ok ? after.g : before.g;
  const moved = before.g.ok && after.g.ok && before.g.ip && after.g.ip && before.g.ip !== after.g.ip ? { from: before.g.ip, to: after.g.ip } : undefined;
  if (!geo.ok) return { ok: false, error: geo.error || "The proxy did not work.", geo, udp: udp.udp, udpDetail: udp.detail };
  return { ok: true, ms: after.g.ok ? after.ms : before.ms, geo, udp: udp.udp, udpDetail: udp.detail, ...(moved ? { moved } : {}) };
}
