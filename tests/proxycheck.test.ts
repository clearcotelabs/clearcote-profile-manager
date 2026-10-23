import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import dgram from "node:dgram";
import { dnsQuery, parseBound, probeSocksUdp, socksUdpPacket } from "../electron/proxycheck";
import { parseProxy } from "../electron/proxyargs";
import { describeCheck, launchReport, udpLine } from "../src/lib/proxyReport";

/** A tiny SOCKS5 server: optional login, and UDP ASSOCIATE answered with `rep`. With rep 0 it opens
 *  a UDP relay that answers every datagram itself (when `answer` is true), so no traffic leaves. */
function fakeSocks(opts: { login?: [string, string]; rep: number; answer?: boolean }) {
  const closers: (() => void)[] = [];
  const seen: { user?: string; pass?: string; datagrams: Buffer[] } = { datagrams: [] };
  const server = net.createServer((c) => {
    let stage = 0;
    let buf = Buffer.alloc(0);
    c.on("error", () => {});
    c.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + methods.length);
        const want = opts.login ? 2 : 0;
        c.write(Buffer.from([5, methods.includes(want) ? want : 0xff]));
        stage = opts.login ? 1 : 2;
      }
      if (stage === 1 && buf.length >= 2) {
        const ul = buf[1];
        if (buf.length < 3 + ul) return;
        const pl = buf[2 + ul];
        if (buf.length < 3 + ul + pl) return;
        seen.user = buf.subarray(2, 2 + ul).toString();
        seen.pass = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        const ok = seen.user === opts.login![0] && seen.pass === opts.login![1];
        c.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) return c.end();
        stage = 2;
      }
      if (stage === 2 && buf.length >= 10) {
        stage = 3;
        if (buf[1] !== 3 || opts.rep !== 0) {
          c.write(Buffer.from([5, opts.rep || 7, 0, 1, 0, 0, 0, 0, 0, 0]));
          return c.end();
        }
        const relay = dgram.createSocket("udp4");
        closers.push(() => relay.close());
        relay.on("message", (msg, from) => {
          seen.datagrams.push(msg);
          if (opts.answer) relay.send(Buffer.concat([msg.subarray(0, 10), Buffer.from("answer")]), from.port, from.address);
        });
        relay.bind(0, "127.0.0.1", () => {
          const port = relay.address().port;
          // 0.0.0.0 = "the address you connected to", as many proxies answer.
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, port >> 8, port & 0xff]));
        });
      }
    });
  });
  return new Promise<{ url: string; seen: typeof seen; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      const auth = opts.login ? `${encodeURIComponent(opts.login[0])}:${encodeURIComponent(opts.login[1])}@` : "";
      resolve({
        url: `socks5://${auth}127.0.0.1:${port}`,
        seen,
        close: () => {
          closers.forEach((f) => f());
          server.close();
        },
      });
    }),
  );
}

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

describe("SOCKS5 UDP probe", () => {
  it("works when the proxy grants UDP and an answer comes back through the relay", async () => {
    const s = await fakeSocks({ rep: 0, answer: true, login: ["user-x", "p@ss:word"] });
    stop = s.close;
    const r = await probeSocksUdp(parseProxy(s.url)!, 4000);
    expect(r.udp).toBe("works");
    // The login went through decoded exactly once.
    expect(s.seen.user).toBe("user-x");
    expect(s.seen.pass).toBe("p@ss:word");
    // The datagram carried the SOCKS UDP header for 1.1.1.1:53 and a DNS question.
    expect([...s.seen.datagrams[0].subarray(0, 10)]).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 0, 53]);
  });

  it("refused: the proxy answers 'command not supported'", async () => {
    const s = await fakeSocks({ rep: 7 });
    stop = s.close;
    const r = await probeSocksUdp(parseProxy(s.url)!, 4000);
    expect(r.udp).toBe("refused");
    expect(r.detail).toContain("not supported");
  });

  it("no-reply: granted, but nothing comes back", async () => {
    const s = await fakeSocks({ rep: 0, answer: false });
    stop = s.close;
    const r = await probeSocksUdp(parseProxy(s.url)!, 3000);
    expect(r.udp).toBe("no-reply");
    expect(s.seen.datagrams.length).toBe(1);
  });

  it("error: a wrong login is reported, not taken for 'refused'", async () => {
    const s = await fakeSocks({ rep: 0, login: ["a", "b"] });
    stop = s.close;
    const r = await probeSocksUdp(parseProxy(s.url.replace("a:b@", "a:wrong@"))!, 3000);
    expect(r.udp).toBe("error");
    expect(r.detail).toContain("login");
  });

  it("error: nothing listening", async () => {
    const r = await probeSocksUdp(parseProxy("socks5://127.0.0.1:1")!, 2000);
    expect(r.udp).toBe("error");
  });

  it("an HTTP proxy is never tried", async () => {
    expect((await probeSocksUdp(parseProxy("http://u:p@127.0.0.1:1")!)).udp).toBe("not-socks");
  });

  it("builds the packets byte for byte", () => {
    expect(dnsQuery(0x1234).subarray(0, 4).toString("hex")).toBe("12340100");
    expect(socksUdpPacket("1.2.3.4", 53, Buffer.from("x")).toString("hex")).toBe("0000000101020304003578");
    expect(parseBound(Buffer.from([1, 10, 0, 0, 1, 0x1f, 0x90]))).toEqual({ host: "10.0.0.1", port: 8080, len: 7 });
    expect(parseBound(Buffer.from([3, 3, 0x61, 0x62, 0x63, 0, 80]))).toEqual({ host: "abc", port: 80, len: 7 });
  });
});

describe("what the results say", () => {
  const geo = { ok: true, ip: "81.2.3.4", country: "Netherlands", city: "Amsterdam" };

  it("a working proxy: where it exits, how fast, and UDP in plain words", () => {
    const d = describeCheck({ ok: true, ms: 1234, geo, udp: "refused" });
    expect(d.tone).toBe("ok");
    expect(d.lines[0]).toBe("Works · exits in Amsterdam, Netherlands (81.2.3.4) · answered in 1.2 s");
    expect(d.lines[1]).toContain("refuses it");
    expect(d.lines[1]).toContain("safe");
  });

  it("a broken proxy", () => {
    const d = describeCheck({ ok: false, error: "the proxy refused the login" });
    expect(d.tone).toBe("bad");
    expect(d.lines[0]).toBe("Doesn't work: the proxy refused the login.");
  });

  it("every UDP verdict has a sentence", () => {
    for (const v of ["works", "refused", "no-reply", "not-socks", "error"] as const) expect(udpLine(v)?.text.length).toBeGreaterThan(20);
    expect(udpLine(undefined)).toBeNull();
  });

  it("the launch message", () => {
    expect(launchReport({}, "A")).toBe("Launched “A” · no proxy: it uses this computer's own connection.");
    expect(launchReport({ proxy: "http://h:1", geoip: true }, "B", { ...geo, at: "x", proxy: "http h:1" })).toBe(
      "Launched “B” · exits in Amsterdam, Netherlands (81.2.3.4) · time zone and language follow the proxy.",
    );
    expect(launchReport({ proxy: "http://h:1", geoip: false }, "C")).toBe("Launched “C” · through its proxy.");
  });
});
