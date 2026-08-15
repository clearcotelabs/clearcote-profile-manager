// A minimal SOCKS5 client (RFC 1928) with username/password authentication (RFC 1929).
//
// Why this exists: the app needs to make ONE small HTTP request through a profile's proxy — the
// geo lookup that fills timezone / language / location / WebRTC IP from the proxy's exit region.
// Electron's network stack is stock Chromium, and stock Chromium cannot authenticate to a SOCKS5
// proxy at all: there is no `login` event for it, and the credentials in `proxyRules` are ignored.
// So the geo check silently failed for exactly the proxies most people use (residential SOCKS5 with
// user/pass), the profile kept its unset location, and the browser reported the host's real
// position — the "geolocation doesn't change" report.
//
// The engine solves this on the LAUNCH path with --socks5-credentials (r14+). That switch is inside
// the browser, though, so it does nothing for a request the app makes itself. Hence ~90 lines of
// SOCKS5 here, used only by geo.ts.
//
// Deliberately narrow: CONNECT only, no BIND/UDP-ASSOCIATE, no GSSAPI. Those are not needed to
// fetch one JSON document, and the engine — not this file — carries the browser's proxy traffic.

import net from "node:net";
import type { ParsedProxy } from "./proxyargs";

/** SOCKS5 wire constants, named so the handshake below reads as the RFC does. */
const VER = 0x05;
const AUTH_NONE = 0x00;
const AUTH_USERPASS = 0x02;
const AUTH_UNACCEPTABLE = 0xff;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REPLY_OK = 0x00;

/** RFC 1928 §6 reply codes — surfaced verbatim so a failure says WHY, not just "it failed". */
const REPLY_TEXT: Record<number, string> = {
  0x01: "general SOCKS server failure",
  0x02: "connection not allowed by ruleset",
  0x03: "network unreachable",
  0x04: "host unreachable",
  0x05: "connection refused",
  0x06: "TTL expired",
  0x07: "command not supported",
  0x08: "address type not supported",
};

/**
 * A single-listener reader over the socket for the duration of the handshake.
 *
 * A SOCKS handshake is a sequence of short replies, and TCP gives no guarantee that one reply
 * arrives as one 'data' event — assuming it does is the classic way these clients pass on localhost
 * and fail against a real proxy. The subtler trap is the fix for that: attaching a fresh 'data'
 * listener per read and pushing the surplus back with unshift(). Adding a 'data' listener puts the
 * socket in FLOWING mode, and removing it does not stop the flow — so bytes that arrive between two
 * reads are emitted to nobody and lost, and the next read waits forever for data already gone.
 *
 * So: ONE listener, attached once, appending into one buffer that reads are served from. `release`
 * detaches it and unshifts whatever is left, handing the caller a socket positioned exactly at the
 * first byte it has not consumed.
 */
class HandshakeReader {
  private buf = Buffer.alloc(0);
  private want = 0;
  private pending?: { resolve: (b: Buffer) => void; reject: (e: Error) => void };
  private failure?: Error;
  private readonly onData = (chunk: Buffer) => {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.settle();
  };
  private readonly onError = (e: Error) => this.abort(e);
  private readonly onClose = () =>
    this.abort(new Error("proxy closed the connection during the SOCKS5 handshake"));

  constructor(private readonly sock: net.Socket) {
    sock.on("data", this.onData);
    sock.on("error", this.onError);
    sock.on("close", this.onClose);
  }

  private settle(): void {
    if (!this.pending || this.buf.length < this.want) return;
    const { resolve } = this.pending;
    this.pending = undefined;
    const out = this.buf.subarray(0, this.want);
    this.buf = this.buf.subarray(this.want);
    resolve(out);
  }

  private abort(e: Error): void {
    this.failure = e;
    const p = this.pending;
    this.pending = undefined;
    p?.reject(e);
  }

  /** Resolve with exactly `n` bytes, or reject if the socket errors/closes first. */
  read(n: number): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure);
    this.want = n;
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.settle();
    });
  }

  /** Detach and give any already-buffered destination bytes back to the socket, leaving it PAUSED.
   *
   *  Pause first, unconditionally. Our 'data' listener put the socket in flowing mode, and removing
   *  it does not undo that — so anything the destination sent between release() and the caller
   *  attaching its own listener would be emitted to nobody and lost. Pausing parks those bytes in
   *  the readable buffer instead, where nothing can drop them.
   *
   *  The socket stays paused on purpose. Node only auto-resumes on a 'data' listener when the
   *  stream was never EXPLICITLY paused; after a pause() call the caller must resume() (or read()).
   *  Handing back a paused socket with every byte still buffered is the state that cannot silently
   *  lose data — see the contract on socks5Connect. */
  release(): void {
    this.sock.pause();
    this.sock.removeListener("data", this.onData);
    this.sock.removeListener("error", this.onError);
    this.sock.removeListener("close", this.onClose);
    if (this.buf.length) {
      this.sock.unshift(this.buf);
      this.buf = Buffer.alloc(0);
    }
  }
}

/** The SOCKS5 address field for a destination: a literal IP keeps its family, anything else is
 *  sent as a domain name so the PROXY resolves it — resolving locally would leak a DNS query for
 *  the destination from the real host, which defeats the point of using the proxy. */
export function encodeAddress(host: string): Buffer {
  const family = net.isIP(host);
  if (family === 4) return Buffer.concat([Buffer.from([ATYP_IPV4]), Buffer.from(host.split(".").map(Number))]);
  if (family === 6) {
    const groups = expandIpv6(host);
    const out = Buffer.alloc(16);
    groups.forEach((g, i) => out.writeUInt16BE(g, i * 2));
    return Buffer.concat([Buffer.from([ATYP_IPV6]), out]);
  }
  const name = Buffer.from(host, "utf8");
  if (name.length > 255) throw new Error(`hostname too long for SOCKS5 (${name.length} > 255)`);
  return Buffer.concat([Buffer.from([ATYP_DOMAIN, name.length]), name]);
}

/** Expand an IPv6 literal (including "::" compression) to its eight 16-bit groups. */
function expandIpv6(host: string): number[] {
  const [head, tail] = host.split("::");
  const h = head ? head.split(":").filter(Boolean) : [];
  const t = tail !== undefined ? tail.split(":").filter(Boolean) : [];
  const fill = new Array(Math.max(0, 8 - h.length - t.length)).fill("0");
  return [...h, ...(tail !== undefined ? fill : []), ...t].map((g) => parseInt(g || "0", 16));
}

/** Byte length of the address in a SOCKS5 reply, so the trailing BND.ADDR/BND.PORT can be consumed
 *  before the tunnel is handed over — leaving them unread would corrupt the first payload read. */
function replyAddressLength(atyp: number, firstByte: number): number {
  if (atyp === ATYP_IPV4) return 4;
  if (atyp === ATYP_IPV6) return 16;
  if (atyp === ATYP_DOMAIN) return 1 + firstByte; // length octet is the byte we peeked
  throw new Error(`proxy replied with an unsupported address type (0x${atyp.toString(16)})`);
}

/**
 * Open a TCP tunnel to `destHost:destPort` through a SOCKS5 proxy and resolve the socket, which is
 * then a plain byte pipe to the destination (write your HTTP request straight into it).
 *
 * Authenticates with RFC 1929 username/password when the proxy asks for it and the parsed proxy
 * carries credentials. The caller owns the returned socket; on any failure the socket is destroyed
 * before the promise rejects, so no handle leaks.
 *
 * CONTRACT: the returned socket is PAUSED, and may already hold bytes the destination sent while
 * the handshake was finishing. Attach your listeners, then call `sock.resume()` — an explicitly
 * paused stream is not resumed by adding a 'data' listener, so forgetting this reads nothing even
 * though the bytes are sitting in the buffer. This is the only handover that cannot lose data:
 * leaving the socket flowing instead would drop whatever arrives before the caller subscribes.
 */
export async function socks5Connect(
  proxy: ParsedProxy,
  destHost: string,
  destPort: number,
  timeoutMs = 12000,
): Promise<net.Socket> {
  const sock = net.connect({ host: proxy.host, port: proxy.port });

  // One deadline for the WHOLE handshake. `setTimeout` alone only emits an event — it never closes
  // the socket — so without destroying it here a proxy that accepts the connection and then says
  // nothing would leave the caller waiting forever.
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    sock.destroy();
  }, timeoutMs);
  const timeoutError = () =>
    new Error(`timed out talking to the SOCKS5 proxy ${proxy.host}:${proxy.port} after ${timeoutMs}ms`);

  const fail = (msg: string): never => {
    throw new Error(msg);
  };

  let reader: HandshakeReader | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", reject);
      sock.once("close", () => reject(timedOut ? timeoutError() : new Error("proxy connection closed")));
    });

    reader = new HandshakeReader(sock);

    // ── Greeting: offer the methods we can actually perform, most capable first.
    const hasCreds = !!(proxy.username || proxy.password);
    const methods = hasCreds ? [AUTH_USERPASS, AUTH_NONE] : [AUTH_NONE];
    sock.write(Buffer.from([VER, methods.length, ...methods]));

    const greeting = await reader.read(2);
    if (greeting[0] !== VER) fail(`not a SOCKS5 proxy (replied version 0x${greeting[0].toString(16)})`);
    const method = greeting[1];

    if (method === AUTH_UNACCEPTABLE) {
      fail(
        hasCreds
          ? "the SOCKS5 proxy rejected username/password authentication"
          : "the SOCKS5 proxy requires authentication but the proxy string has no credentials",
      );
    }

    if (method === AUTH_USERPASS) {
      if (!hasCreds) fail("the SOCKS5 proxy asked for credentials but the proxy string has none");
      const user = Buffer.from(proxy.username ?? "", "utf8");
      const pass = Buffer.from(proxy.password ?? "", "utf8");
      if (user.length > 255 || pass.length > 255) fail("SOCKS5 username/password must each be at most 255 bytes");
      // RFC 1929: VER(=0x01 for the auth sub-negotiation, NOT 0x05) ULEN UNAME PLEN PASSWD
      sock.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      const authReply = await reader.read(2);
      if (authReply[1] !== 0x00) fail("SOCKS5 authentication failed — check the proxy username/password");
    } else if (method !== AUTH_NONE) {
      fail(`the SOCKS5 proxy demanded an unsupported auth method (0x${method.toString(16)})`);
    }

    // ── CONNECT request.
    sock.write(
      Buffer.concat([
        Buffer.from([VER, CMD_CONNECT, 0x00]),
        encodeAddress(destHost),
        (() => {
          const p = Buffer.alloc(2);
          p.writeUInt16BE(destPort);
          return p;
        })(),
      ]),
    );

    const head = await reader.read(4); // VER REP RSV ATYP
    if (head[1] !== REPLY_OK) {
      fail(`SOCKS5 CONNECT failed: ${REPLY_TEXT[head[1]] ?? `code 0x${head[1].toString(16)}`}`);
    }
    // Consume BND.ADDR + BND.PORT so the socket is positioned at the first destination byte.
    // Leaving them unread would make them look like the first bytes of the destination's response.
    const atyp = head[3];
    const peek = atyp === ATYP_DOMAIN ? await reader.read(1) : Buffer.alloc(1);
    const addrLen = replyAddressLength(atyp, peek[0]);
    await reader.read((atyp === ATYP_DOMAIN ? addrLen - 1 : addrLen) + 2);

    clearTimeout(deadline);
    reader.release();
    return sock;
  } catch (e) {
    clearTimeout(deadline);
    reader?.release();
    sock.destroy();
    if (timedOut) throw timeoutError();
    throw e instanceof Error ? e : new Error(String(e));
  }
}
