// A small WebSocket client (RFC 6455) for the main process.
//
// Electron 33's Node has no WebSocket client, and the app has no runtime dependencies. The one thing
// the main process needs a socket for is the cloud attach (cdpattach.ts): connect to a session's CDP
// URL, send one command, read the reply, close. So this implements the client half of the protocol
// and nothing more: text and binary messages, fragments, the three length encodings, ping/pong and
// the closing handshake. Frames from the client are masked, as the RFC requires.

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Larger than any CDP reply this app reads; a bigger frame is a protocol error, not a buffer. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export type WsMessage = { type: "text"; data: string } | { type: "binary"; data: Buffer };

export class WsError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** The Sec-WebSocket-Accept a server must answer for this key. */
export function acceptFor(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/** One client frame: FIN set, masked, with the shortest length encoding that fits. */
export function encodeFrame(opcode: number, payload: Buffer, mask: Buffer = randomBytes(4)): Buffer {
  const len = payload.length;
  const head = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const out = Buffer.alloc(head + 4 + len);
  out[0] = 0x80 | (opcode & 0x0f);
  if (len < 126) out[1] = 0x80 | len;
  else if (len < 65536) {
    out[1] = 0x80 | 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 0x80 | 127;
    out.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    out.writeUInt32BE(len >>> 0, 6);
  }
  mask.copy(out, head);
  for (let i = 0; i < len; i++) out[head + 4 + i] = payload[i] ^ mask[i & 3];
  return out;
}

type Frame = { fin: boolean; opcode: number; payload: Buffer };

/**
 * Pull complete frames off the front of `buf`. Returns them and what is left over (a partial frame).
 * Throws on what a server must never send: a masked frame, an oversized one, or reserved bits.
 */
export function decodeFrames(buf: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    if (b0 & 0x70) throw new WsError("The server set reserved bits (no extension was negotiated).");
    if (b1 & 0x80) throw new WsError("The server sent a masked frame.");
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const hi = buf.readUInt32BE(p);
      const lo = buf.readUInt32BE(p + 4);
      len = hi * 2 ** 32 + lo;
      p += 8;
    }
    if (len > MAX_MESSAGE_BYTES) throw new WsError(`The server sent a ${len}-byte frame.`);
    if (buf.length - p < len) break;
    frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload: buf.subarray(p, p + len) });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

/** An open connection. Messages arrive on `onMessage`; `closed` settles when the socket is gone. */
export class WsConnection {
  onMessage: (m: WsMessage) => void = () => {};
  readonly closed: Promise<{ code?: number; reason?: string }>;
  private buf: Buffer;
  private parts: Buffer[] = [];
  private partOpcode = 0;
  private closing = false;
  private resolveClosed!: (v: { code?: number; reason?: string }) => void;

  constructor(private readonly socket: Duplex, head: Buffer) {
    this.buf = Buffer.from(head);
    this.closed = new Promise((r) => (this.resolveClosed = r));
    socket.on("data", (d: Buffer) => this.feed(d));
    socket.on("close", () => this.resolveClosed({}));
    socket.on("error", () => this.resolveClosed({}));
    if (this.buf.length) setImmediate(() => this.feed(Buffer.alloc(0)));
  }

  private feed(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    let decoded: ReturnType<typeof decodeFrames>;
    try {
      decoded = decodeFrames(this.buf);
    } catch {
      this.socket.destroy();
      return;
    }
    this.buf = Buffer.from(decoded.rest);
    for (const f of decoded.frames) this.handle(f);
  }

  private handle(f: Frame): void {
    if (f.opcode === 0x9) return void this.write(0xa, f.payload); // ping -> pong, same payload
    if (f.opcode === 0xa) return; // pong
    if (f.opcode === 0x8) {
      const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : undefined;
      const reason = f.payload.length > 2 ? f.payload.subarray(2).toString("utf8") : undefined;
      if (!this.closing) {
        this.closing = true;
        this.write(0x8, f.payload.subarray(0, 2));
      }
      this.socket.end();
      this.resolveClosed({ code, reason });
      return;
    }
    if (f.opcode === 0x1 || f.opcode === 0x2) {
      if (f.fin) return this.emit(f.opcode, f.payload);
      this.partOpcode = f.opcode;
      this.parts = [Buffer.from(f.payload)];
      return;
    }
    if (f.opcode === 0x0 && this.partOpcode) {
      this.parts.push(Buffer.from(f.payload));
      if (this.parts.reduce((n, b) => n + b.length, 0) > MAX_MESSAGE_BYTES) return void this.socket.destroy();
      if (f.fin) {
        const op = this.partOpcode;
        const all = Buffer.concat(this.parts);
        this.parts = [];
        this.partOpcode = 0;
        this.emit(op, all);
      }
    }
  }

  private emit(opcode: number, payload: Buffer): void {
    this.onMessage(opcode === 0x1 ? { type: "text", data: payload.toString("utf8") } : { type: "binary", data: Buffer.from(payload) });
  }

  private write(opcode: number, payload: Buffer): void {
    if (!this.socket.destroyed) this.socket.write(encodeFrame(opcode, payload));
  }

  send(text: string): void {
    if (this.closing) throw new WsError("The connection is closing.");
    this.write(0x1, Buffer.from(text, "utf8"));
  }

  /** The closing handshake: send a close frame, wait briefly for the server's, then drop the socket. */
  async close(code = 1000, waitMs = 2000): Promise<void> {
    if (!this.closing) {
      this.closing = true;
      const p = Buffer.alloc(2);
      p.writeUInt16BE(code, 0);
      this.write(0x8, p);
    }
    const timer = new Promise<void>((r) => setTimeout(r, waitMs).unref?.());
    await Promise.race([this.closed.then(() => undefined), timer]);
    this.socket.destroy();
  }
}

/** Open a WebSocket to ws:// or wss://. Rejects with WsError (and the HTTP status) when refused. */
export function wsConnect(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<WsConnection> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return reject(new WsError(`Not a WebSocket address: ${url}`));
    }
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return reject(new WsError(`Not a WebSocket address: ${u.protocol}//`));
    const key = randomBytes(16).toString("base64");
    const lib = u.protocol === "wss:" ? https : http;
    const req = lib.request({
      protocol: u.protocol === "wss:" ? "https:" : "http:",
      hostname: u.hostname.replace(/^\[|\]$/g, ""),
      port: u.port || (u.protocol === "wss:" ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: "GET",
      headers: {
        ...opts.headers,
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": key,
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new WsError(`No answer from ${u.host} in ${Math.round((opts.timeoutMs ?? 30000) / 1000)} s.`));
    }, opts.timeoutMs ?? 30000);
    req.on("upgrade", (res, socket, head) => {
      clearTimeout(timer);
      if (res.headers["sec-websocket-accept"] !== acceptFor(key)) {
        socket.destroy();
        return reject(new WsError("The server answered the upgrade with the wrong Sec-WebSocket-Accept."));
      }
      resolve(new WsConnection(socket, head));
    });
    req.on("response", (res) => {
      clearTimeout(timer);
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        if (body.length < 2000) body += c;
      });
      res.on("end", () => {
        let msg = body.trim();
        try {
          const j = JSON.parse(body) as { error?: string; message?: string };
          msg = j.error || j.message || msg;
        } catch {
          /* plain text */
        }
        reject(new WsError(msg ? `${res.statusCode}: ${msg.slice(0, 300)}` : `The server refused the connection (${res.statusCode}).`, res.statusCode));
      });
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(new WsError(`Could not connect to ${u.host}: ${e.message}`));
    });
    req.end();
  });
}
