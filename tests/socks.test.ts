// The SOCKS5 client is exercised against a real local SOCKS5 server that speaks the actual wire
// protocol (RFC 1928 + RFC 1929) — not a mock of our own assumptions. That matters here: the whole
// reason this client exists is that the previous implementation assumed a capability (Chromium
// authenticating to SOCKS5) that did not exist, and no test noticed because nothing spoke SOCKS.

import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { socks5Connect, encodeAddress } from "../electron/socks";
import { parseProxy } from "../electron/proxy";

const VER = 0x05;
const AUTH_NONE = 0x00;
const AUTH_USERPASS = 0x02;
const AUTH_UNACCEPTABLE = 0xff;

interface FakeOpts {
  /** Credentials the server accepts. Unset = the server offers "no auth". */
  requireAuth?: { user: string; pass: string };
  /** Force a CONNECT reply code other than success. */
  replyCode?: number;
  /** Reply with a domain-name BND.ADDR instead of IPv4, to exercise variable-length reply parsing. */
  replyDomain?: string;
  /** Answer the greeting one byte at a time, so a client that assumes "one reply = one packet"
   *  fails. Real proxies split replies; localhost mocks usually don't. */
  dribble?: boolean;
  /** Bytes to send once the tunnel is open (stands in for the destination's response). */
  payload?: string;
}

interface Fake {
  port: number;
  close: () => Promise<void>;
  /** What the last client asked to connect to. */
  lastRequest?: { host: string; port: number };
  lastAuth?: { user: string; pass: string };
}

/** A deliberately small SOCKS5 server: enough of the protocol to prove the client's half. */
function startFakeSocks(opts: FakeOpts = {}): Promise<Fake> {
  const state: Fake = { port: 0, close: async () => {} };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    let stage: "greet" | "auth" | "request" | "tunnel" = "greet";
    let buf = Buffer.alloc(0);

    const send = (b: Buffer) => {
      if (!opts.dribble) return void sock.write(b);
      for (const byte of b) sock.write(Buffer.from([byte]));
    };

    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (stage === "greet") {
          if (buf.length < 2) return;
          const n = buf[1];
          if (buf.length < 2 + n) return;
          const methods = [...buf.subarray(2, 2 + n)];
          buf = buf.subarray(2 + n);
          if (opts.requireAuth) {
            if (!methods.includes(AUTH_USERPASS)) return void send(Buffer.from([VER, AUTH_UNACCEPTABLE]));
            send(Buffer.from([VER, AUTH_USERPASS]));
            stage = "auth";
          } else {
            send(Buffer.from([VER, AUTH_NONE]));
            stage = "request";
          }
          continue;
        }
        if (stage === "auth") {
          if (buf.length < 2) return;
          const ulen = buf[1];
          if (buf.length < 2 + ulen + 1) return;
          const plen = buf[2 + ulen];
          if (buf.length < 3 + ulen + plen) return;
          const user = buf.subarray(2, 2 + ulen).toString();
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
          buf = buf.subarray(3 + ulen + plen);
          state.lastAuth = { user, pass };
          const ok = user === opts.requireAuth!.user && pass === opts.requireAuth!.pass;
          send(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          if (!ok) return void sock.end();
          stage = "request";
          continue;
        }
        if (stage === "request") {
          if (buf.length < 5) return;
          const atyp = buf[3];
          let host = "";
          let consumed = 0;
          if (atyp === 0x01) {
            if (buf.length < 10) return;
            host = [...buf.subarray(4, 8)].join(".");
            consumed = 10;
          } else if (atyp === 0x03) {
            const len = buf[4];
            if (buf.length < 5 + len + 2) return;
            host = buf.subarray(5, 5 + len).toString();
            consumed = 5 + len + 2;
          } else {
            if (buf.length < 22) return;
            host = "ipv6";
            consumed = 22;
          }
          const port = buf.readUInt16BE(consumed - 2);
          buf = buf.subarray(consumed);
          state.lastRequest = { host, port };

          const code = opts.replyCode ?? 0x00;
          const addr = opts.replyDomain
            ? Buffer.concat([Buffer.from([0x03, opts.replyDomain.length]), Buffer.from(opts.replyDomain)])
            : Buffer.from([0x01, 127, 0, 0, 1]);
          const bnd = Buffer.alloc(2);
          bnd.writeUInt16BE(1080);
          send(Buffer.concat([Buffer.from([VER, code, 0x00]), addr, bnd]));
          if (code !== 0x00) return void sock.end();
          stage = "tunnel";
          if (opts.payload) sock.write(opts.payload);
          continue;
        }
        return; // tunnel: echo nothing, the tests only read
      }
    });
    sock.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      state.port = (server.address() as net.AddressInfo).port;
      // Destroy live connections first: server.close() only stops NEW connections and otherwise
      // waits for existing ones, which would hang the suite rather than fail it.
      state.close = () =>
        new Promise((r) => {
          for (const s of sockets) s.destroy();
          sockets.clear();
          server.close(() => r());
        });
      resolve(state);
    });
  });
}

const open: Fake[] = [];
async function fake(opts?: FakeOpts): Promise<Fake> {
  const f = await startFakeSocks(opts);
  open.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

/** A bare TCP server for the "not actually a SOCKS proxy" cases, with the same
 *  destroy-then-close discipline so a test failure never turns into a hung suite. */
async function rawServer(onConn: (s: net.Socket) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => {});
    onConn(s);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => r());
      }),
  };
}

const proxyTo = (port: number, creds = "") =>
  parseProxy(`socks5://${creds}127.0.0.1:${port}`)!;

describe("encodeAddress", () => {
  it("IPv4 literal keeps its family (ATYP 0x01)", () =>
    expect([...encodeAddress("1.2.3.4")]).toEqual([0x01, 1, 2, 3, 4]));
  it("a hostname is sent as a DOMAIN so the PROXY resolves it — no local DNS leak", () => {
    const b = encodeAddress("ip-api.com");
    expect(b[0]).toBe(0x03);
    expect(b[1]).toBe("ip-api.com".length);
    expect(b.subarray(2).toString()).toBe("ip-api.com");
  });
  it("IPv6 literal expands :: to eight groups (ATYP 0x04, 16 bytes)", () => {
    const b = encodeAddress("::1");
    expect(b[0]).toBe(0x04);
    expect(b.length).toBe(17);
    expect(b[16]).toBe(1);
  });
  it("rejects a hostname too long for the length octet", () =>
    expect(() => encodeAddress("a".repeat(256))).toThrow(/too long/i));
});

describe("socks5Connect — unauthenticated proxy", () => {
  it("completes the handshake and forwards the destination", async () => {
    const f = await fake({ payload: "hello" });
    const sock = await socks5Connect(proxyTo(f.port), "example.com", 80);
    expect(f.lastRequest).toEqual({ host: "example.com", port: 80 });
    sock.destroy();
  });

  it("hands over a socket positioned at the FIRST destination byte", async () => {
    // If BND.ADDR/BND.PORT were left unread, they would arrive as the first "payload" bytes and
    // corrupt the HTTP response the caller parses.
    const f = await fake({ payload: "HTTP/1.1 200 OK" });
    const sock = await socks5Connect(proxyTo(f.port), "example.com", 80);
    // Per the socks5Connect contract the socket comes back PAUSED, holding whatever arrived while
    // the handshake finished — subscribe, then resume.
    const first = await new Promise<string>((res) => {
      sock.once("data", (d) => res(d.toString()));
      sock.resume();
    });
    expect(first).toBe("HTTP/1.1 200 OK");
    sock.destroy();
  });

  it("survives a proxy that dribbles the handshake one byte per packet", async () => {
    const f = await fake({ dribble: true, payload: "ok" });
    const sock = await socks5Connect(proxyTo(f.port), "example.com", 443);
    expect(f.lastRequest).toEqual({ host: "example.com", port: 443 });
    sock.destroy();
  });

  it("consumes a variable-length DOMAIN reply address correctly", async () => {
    const f = await fake({ replyDomain: "relay.example.net", payload: "PAYLOAD" });
    const sock = await socks5Connect(proxyTo(f.port), "example.com", 80);
    const first = await new Promise<string>((res) => {
      sock.once("data", (d) => res(d.toString()));
      sock.resume();
    });
    expect(first).toBe("PAYLOAD");
    sock.destroy();
  });
});

describe("socks5Connect — the handover contract", () => {
  it("returns a PAUSED socket with the early bytes buffered, not dropped", async () => {
    const f = await fake({ payload: "EARLY" });
    const sock = await socks5Connect(proxyTo(f.port), "example.com", 80);
    // Deliberately wait before subscribing: a flowing socket would emit "EARLY" to nobody here.
    await new Promise((r) => setTimeout(r, 50));
    expect(sock.isPaused()).toBe(true);
    const first = await new Promise<string>((res) => {
      sock.once("data", (d) => res(d.toString()));
      sock.resume();
    });
    expect(first).toBe("EARLY");
    sock.destroy();
  });
});

describe("socks5Connect — RFC 1929 username/password", () => {
  it("authenticates with the parsed credentials", async () => {
    const f = await fake({ requireAuth: { user: "alice", pass: "s3cret" }, payload: "ok" });
    const sock = await socks5Connect(proxyTo(f.port, "alice:s3cret@"), "example.com", 80);
    expect(f.lastAuth).toEqual({ user: "alice", pass: "s3cret" });
    sock.destroy();
  });

  it("sends the real dataimpulse-style username verbatim", async () => {
    const user = "e5112c5f515764418d14__cr.us";
    const pass = "38db09f77925c928";
    const f = await fake({ requireAuth: { user, pass }, payload: "ok" });
    const sock = await socks5Connect(proxyTo(f.port, `${user}:${pass}@`), "ip-api.com", 80);
    expect(f.lastAuth).toEqual({ user, pass });
    sock.destroy();
  });

  it("rejects wrong credentials with a message naming the cause", async () => {
    const f = await fake({ requireAuth: { user: "alice", pass: "right" } });
    await expect(socks5Connect(proxyTo(f.port, "alice:wrong@"), "example.com", 80)).rejects.toThrow(
      /authentication failed/i,
    );
  });

  it("explains the failure when the proxy demands auth and the string has none", async () => {
    const f = await fake({ requireAuth: { user: "alice", pass: "s3cret" } });
    await expect(socks5Connect(proxyTo(f.port), "example.com", 80)).rejects.toThrow(
      /requires authentication but the proxy string has no credentials/i,
    );
  });
});

describe("socks5Connect — failure reporting", () => {
  it("surfaces the RFC 1928 reply code in words", async () => {
    const f = await fake({ replyCode: 0x05 });
    await expect(socks5Connect(proxyTo(f.port), "example.com", 80)).rejects.toThrow(/connection refused/i);
  });

  it("host unreachable is distinguishable from refused", async () => {
    const f = await fake({ replyCode: 0x04 });
    await expect(socks5Connect(proxyTo(f.port), "example.com", 80)).rejects.toThrow(/host unreachable/i);
  });

  it("a non-SOCKS5 server is called out rather than hanging", async () => {
    const { port, close } = await rawServer((s) => s.write(Buffer.from([0x04, 0x00])));
    try {
      await expect(socks5Connect(parseProxy(`socks5://127.0.0.1:${port}`)!, "e.com", 80)).rejects.toThrow(
        /not a SOCKS5 proxy/i,
      );
    } finally {
      await close();
    }
  });

  it("times out instead of hanging when the proxy never answers", async () => {
    const { port, close } = await rawServer(() => {}); // accepts, says nothing
    try {
      await expect(
        socks5Connect(parseProxy(`socks5://127.0.0.1:${port}`)!, "e.com", 80, 300),
      ).rejects.toThrow(/timed out/i);
    } finally {
      await close();
    }
  });

  it("a refused proxy connection rejects rather than resolving a dead socket", async () => {
    // Port 1 on loopback: nothing listens, so connect() fails immediately.
    await expect(socks5Connect(parseProxy("socks5://127.0.0.1:1")!, "e.com", 80, 2000)).rejects.toThrow();
  });
});
