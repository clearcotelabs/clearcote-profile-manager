// A WebSocket SERVER for tests, written independently of electron/wsclient.ts (the client under
// test): a codec shared by both sides would agree with itself even where both are wrong. It checks
// what the RFC demands of a client (every frame masked, a valid Sec-WebSocket-Key) and can do what a
// real server does to one: fragment a message, ping, use the 16- and 64-bit lengths, refuse the
// upgrade with a JSON body, or close.

import http from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

export interface ReceivedFrame {
  opcode: number;
  fin: boolean;
  masked: boolean;
  data: Buffer;
}

export interface FakeConn {
  path: string;
  headers: http.IncomingHttpHeaders;
  /** Every frame the client sent, unmasked, in order. */
  frames: ReceivedFrame[];
  /** Whole text messages from the client. */
  texts: string[];
  onText: (text: string) => void;
  sendText(text: string, opts?: { fragments?: number }): void;
  sendBinary(data: Buffer): void;
  ping(payload?: Buffer): void;
  /** A close frame with this code; the socket ends once the client answers (or right away with `drop`). */
  close(code?: number, opts?: { drop?: boolean }): void;
  destroy(): void;
  /** Settles when the client's close frame arrives. */
  clientClosed: Promise<number | undefined>;
}

function frame(opcode: number, payload: Buffer, fin = true): Buffer {
  const len = payload.length;
  const head = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const out = Buffer.alloc(head + len);
  out[0] = (fin ? 0x80 : 0) | opcode;
  if (len < 126) out[1] = len;
  else if (len < 65536) {
    out[1] = 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  payload.copy(out, head);
  return out;
}

export interface FakeWsServer {
  url: (path?: string) => string;
  port: number;
  server: http.Server;
  conns: FakeConn[];
  close(): Promise<void>;
}

export async function startFakeWs(opts: {
  /** Refuse an upgrade: return the HTTP status and body to answer with instead. */
  refuse?: (path: string, headers: http.IncomingHttpHeaders) => { status: number; body: string } | undefined;
  /** Answer with a wrong Sec-WebSocket-Accept (a broken or hostile server). */
  wrongAccept?: boolean;
  /** Never answer the upgrade at all. */
  hang?: boolean;
  onConnection?: (c: FakeConn) => void;
  /** Plain HTTP requests (the fake cloud API uses this). */
  onRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => void;
} = {}): Promise<FakeWsServer> {
  const conns: FakeConn[] = [];
  const sockets = new Set<Duplex>();
  const server = http.createServer((req, res) => {
    if (opts.onRequest) return opts.onRequest(req, res);
    res.writeHead(404).end();
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.on("upgrade", (req, socket, head) => {
    sockets.add(socket);
    const path = req.url ?? "/";
    if (opts.hang) return;
    const refused = opts.refuse?.(path, req.headers);
    if (refused) {
      socket.end(
        `HTTP/1.1 ${refused.status} Refused\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(refused.body)}\r\nConnection: close\r\n\r\n${refused.body}`,
      );
      return;
    }
    const key = String(req.headers["sec-websocket-key"] ?? "");
    if (Buffer.from(key, "base64").length !== 16 || req.headers["sec-websocket-version"] !== "13") {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const accept = opts.wrongAccept
      ? "AAAAAAAAAAAAAAAAAAAAAAAAAAA="
      : createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);

    let buf = Buffer.from(head);
    let parts: Buffer[] = [];
    let partOp = 0;
    let resolveClosed!: (c: number | undefined) => void;
    const conn: FakeConn = {
      path,
      headers: req.headers,
      frames: [],
      texts: [],
      onText: () => {},
      sendText: (text, o = {}) => {
        const data = Buffer.from(text, "utf8");
        const n = Math.max(1, o.fragments ?? 1);
        const size = Math.ceil(data.length / n);
        for (let i = 0; i < n; i++) {
          const chunk = data.subarray(i * size, (i + 1) * size);
          socket.write(frame(i === 0 ? 0x1 : 0x0, chunk, i === n - 1));
        }
      },
      sendBinary: (data) => socket.write(frame(0x2, data)),
      ping: (payload = Buffer.from("hb")) => socket.write(frame(0x9, payload)),
      close: (code = 1000, o = {}) => {
        const p = Buffer.alloc(2);
        p.writeUInt16BE(code, 0);
        socket.write(frame(0x8, p));
        if (o.drop) socket.end();
      },
      destroy: () => socket.destroy(),
      clientClosed: new Promise((r) => (resolveClosed = r)),
    };
    conns.push(conn);

    const feed = () => {
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let p = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          p = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          p = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < p + maskLen + len) return;
        const mask = masked ? buf.subarray(p, p + 4) : null;
        const data = Buffer.alloc(len);
        for (let i = 0; i < len; i++) data[i] = buf[p + maskLen + i] ^ (mask ? mask[i & 3] : 0);
        buf = buf.subarray(p + maskLen + len);
        conn.frames.push({ opcode, fin, masked, data });
        if (!masked) {
          // RFC 6455 5.1: a server MUST close the connection on an unmasked client frame.
          socket.destroy();
          return;
        }
        if (opcode === 0x8) {
          resolveClosed(data.length >= 2 ? data.readUInt16BE(0) : undefined);
          socket.end(frame(0x8, data.subarray(0, 2)));
          return;
        }
        if (opcode === 0x1 || (opcode === 0x0 && partOp === 0x1)) {
          if (opcode === 0x1) {
            partOp = 0x1;
            parts = [];
          }
          parts.push(data);
          if (fin) {
            const text = Buffer.concat(parts).toString("utf8");
            partOp = 0;
            conn.texts.push(text);
            conn.onText(text);
          }
        }
      }
    };
    socket.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      feed();
    });
    socket.on("close", () => resolveClosed(undefined));
    socket.on("error", () => {});
    opts.onConnection?.(conn);
    if (buf.length) feed();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: (p = "/") => `ws://127.0.0.1:${port}${p}`,
    port,
    server,
    conns,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
