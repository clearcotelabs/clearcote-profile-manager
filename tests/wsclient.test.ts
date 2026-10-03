// electron/wsclient.ts: the small WebSocket client the main process uses to start a cloud browser.
// The codec is checked on its own, and the client against tests/helpers/fakews.ts, a server written
// independently of it.

import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { acceptFor, decodeFrames, encodeFrame, wsConnect, MAX_MESSAGE_BYTES, WsError, type WsMessage } from "../electron/wsclient";
import { startFakeWs, type FakeWsServer, type FakeConn } from "./helpers/fakews";

const servers: FakeWsServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});
async function server(opts: Parameters<typeof startFakeWs>[0] = {}) {
  const s = await startFakeWs(opts);
  servers.push(s);
  return s;
}
const until = async (ok: () => boolean, what: string, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
/** A server frame, built here independently of the code under test. */
const serverFrame = (opcode: number, payload: Buffer, fin = true) => {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (len >= 126) {
    head[0] = (fin ? 0x80 : 0) | opcode;
    if (len < 65536) {
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
  }
  return Buffer.concat([head, payload]);
};

describe("frame codec", () => {
  it("computes the RFC 6455 accept value (the RFC's own example)", () => {
    // RFC 6455 section 1.3.
    expect(acceptFor("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("masks every client frame, with the shortest length encoding", () => {
    const mask = Buffer.from([1, 2, 3, 4]);
    for (const [len, headLen, marker] of [
      [0, 2, 0],
      [125, 2, 125],
      [126, 4, 126],
      [65535, 4, 126],
      [65536, 10, 127],
    ] as const) {
      const payload = randomBytes(len);
      const f = encodeFrame(0x2, payload, mask);
      expect(f[0]).toBe(0x82);
      expect(f[1] & 0x80, `mask bit for ${len}`).toBe(0x80);
      expect(f[1] & 0x7f).toBe(marker);
      expect(f.subarray(headLen, headLen + 4)).toEqual(mask);
      const body = f.subarray(headLen + 4);
      expect(body.length).toBe(len);
      for (let i = 0; i < Math.min(len, 64); i++) expect(body[i] ^ mask[i & 3]).toBe(payload[i]);
    }
  });

  it("decodes whole frames and leaves a partial one for later", () => {
    const a = serverFrame(0x1, Buffer.from("hello"));
    const b = serverFrame(0x2, randomBytes(300));
    const both = Buffer.concat([a, b]);
    const cut = both.subarray(0, both.length - 7);
    const first = decodeFrames(cut);
    expect(first.frames.map((f) => f.opcode)).toEqual([0x1]);
    expect(first.rest.length).toBe(b.length - 7);
    const second = decodeFrames(Buffer.concat([first.rest, both.subarray(both.length - 7)]));
    expect(second.frames.map((f) => [f.opcode, f.payload.length])).toEqual([[0x2, 300]]);
    expect(second.rest.length).toBe(0);
  });

  it("decodes the 64-bit length", () => {
    const big = randomBytes(70_000);
    const { frames } = decodeFrames(serverFrame(0x2, big));
    expect(frames[0].payload.equals(big)).toBe(true);
  });

  it("refuses what a server must never send: a masked frame, reserved bits, an oversized length", () => {
    const masked = Buffer.from([0x81, 0x80 | 1, 0, 0, 0, 0, 0x41]);
    expect(() => decodeFrames(masked)).toThrow(WsError);
    expect(() => decodeFrames(Buffer.from([0xc1, 0x00]))).toThrow(/reserved/);
    const huge = Buffer.alloc(10);
    huge[0] = 0x82;
    huge[1] = 127;
    huge.writeBigUInt64BE(BigInt(MAX_MESSAGE_BYTES + 1), 2);
    expect(() => decodeFrames(huge)).toThrow(/frame/);
  });
});

describe("wsConnect against a real server", () => {
  it("connects, sends masked text, and receives text and binary", async () => {
    let conn!: FakeConn;
    const s = await server({ onConnection: (c) => (conn = c) });
    const ws = await wsConnect(s.url("/devtools/browser/abc?token=x"));
    const got: WsMessage[] = [];
    ws.onMessage = (m) => got.push(m);
    ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    await until(() => conn?.texts.length === 1, "server got the text");
    expect(conn.path).toBe("/devtools/browser/abc?token=x");
    expect(conn.frames.every((f) => f.masked)).toBe(true);
    expect(JSON.parse(conn.texts[0])).toEqual({ id: 1, method: "Browser.getVersion" });
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(5000)]);
    conn.sendText("héllo ✓");
    conn.sendBinary(jpeg);
    await until(() => got.length === 2, "client got both");
    expect(got[0]).toEqual({ type: "text", data: "héllo ✓" });
    expect(got[1].type).toBe("binary");
    expect((got[1] as { data: Buffer }).data.equals(jpeg)).toBe(true);
    await ws.close();
  });

  it("joins a fragmented message, and answers a ping with the same payload", async () => {
    let conn!: FakeConn;
    const s = await server({ onConnection: (c) => (conn = c) });
    const ws = await wsConnect(s.url());
    const got: WsMessage[] = [];
    ws.onMessage = (m) => got.push(m);
    await until(() => !!conn, "connected");
    const text = JSON.stringify({ id: 1, result: { product: "Chrome/153.0.8010.53", userAgent: "x".repeat(400) } });
    conn.ping(Buffer.from("are-you-there"));
    conn.sendText(text, { fragments: 4 });
    await until(() => got.length === 1, "message joined");
    expect(got[0]).toEqual({ type: "text", data: text });
    const pong = conn.frames.find((f) => f.opcode === 0xa);
    expect(pong?.masked).toBe(true);
    expect(pong?.data.toString()).toBe("are-you-there");
    await ws.close();
  });

  it("receives a message sent with the 16-bit and the 64-bit length", async () => {
    let conn!: FakeConn;
    const s = await server({ onConnection: (c) => (conn = c) });
    const ws = await wsConnect(s.url());
    const got: Buffer[] = [];
    ws.onMessage = (m) => m.type === "binary" && got.push(m.data);
    await until(() => !!conn, "connected");
    const mid = randomBytes(40_000);
    const big = randomBytes(200_000);
    conn.sendBinary(mid);
    conn.sendBinary(big);
    await until(() => got.length === 2, "both arrived", 5000);
    expect(got[0].equals(mid)).toBe(true);
    expect(got[1].equals(big)).toBe(true);
    await ws.close();
  });

  it("closes with a handshake: a masked close frame with the code, then the socket goes", async () => {
    let conn!: FakeConn;
    const s = await server({ onConnection: (c) => (conn = c) });
    const ws = await wsConnect(s.url());
    await until(() => !!conn, "connected");
    await ws.close(1000);
    expect(await conn.clientClosed).toBe(1000);
    const close = conn.frames.find((f) => f.opcode === 0x8)!;
    expect(close.masked).toBe(true);
    await ws.closed;
  });

  it("answers the server's close, and reports its code", async () => {
    let conn!: FakeConn;
    const s = await server({ onConnection: (c) => (conn = c) });
    const ws = await wsConnect(s.url());
    await until(() => !!conn, "connected");
    conn.close(4001);
    const closed = await ws.closed;
    expect(closed.code).toBe(4001);
    await until(() => conn.frames.some((f) => f.opcode === 0x8), "client echoed the close");
    expect(() => ws.send("late")).toThrow(/closing/);
  });

  it("reports a refused upgrade with its status and the server's own message", async () => {
    const s = await server({ refuse: () => ({ status: 409, body: JSON.stringify({ error: "Another client is attached to this session." }) }) });
    const err = await wsConnect(s.url()).catch((e) => e as WsError);
    expect(err).toBeInstanceOf(WsError);
    expect((err as WsError).status).toBe(409);
    expect((err as WsError).message).toBe("409: Another client is attached to this session.");
  });

  it("refuses a server that answers with the wrong Sec-WebSocket-Accept", async () => {
    const s = await server({ wrongAccept: true });
    await expect(wsConnect(s.url())).rejects.toThrow(/Sec-WebSocket-Accept/);
  });

  it("times out when the server never answers the upgrade", async () => {
    const s = await server({ hang: true });
    const t = Date.now();
    await expect(wsConnect(s.url(), { timeoutMs: 300 })).rejects.toThrow(/No answer from 127\.0\.0\.1:\d+ in 0 s/);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("reports a closed port, and refuses addresses that are not ws:// or wss://", async () => {
    const s = await server();
    const port = s.port;
    await s.close();
    servers.pop();
    await expect(wsConnect(`ws://127.0.0.1:${port}/`, { timeoutMs: 2000 })).rejects.toThrow(/Could not connect to 127\.0\.0\.1/);
    await expect(wsConnect("https://example.com/")).rejects.toThrow(/Not a WebSocket address: https:/);
    await expect(wsConnect("not a url")).rejects.toThrow(/Not a WebSocket address/);
  });
});
