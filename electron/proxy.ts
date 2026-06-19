// Proxy handling. A profile's `proxy` is a single string, e.g.
//   http://user:pass@host:port  ·  socks5://host:1080  ·  host:8080
//
// Chromium's --proxy-server IGNORES inline credentials (it would just prompt). So for an
// authenticated http/https proxy we run a tiny LOCAL relay on 127.0.0.1 that forwards to the
// upstream proxy with Proxy-Authorization injected, and point the spawned browser at the relay —
// the browser never sees (or has to prompt for) the credentials. Verified end-to-end against a
// real authenticated proxy (HTTP + HTTPS/CONNECT).
import http from "node:http";
import net from "node:net";

export interface ParsedProxy {
  scheme: string; // http | https | socks5 | socks4 | socks
  host: string;
  port: number;
  username?: string;
  password?: string;
  raw: string; // the original/normalized string
}

/** Parse a proxy string ("scheme://user:pass@host:port", "user:pass@host:port", "host:port") —
 *  or the legacy { server, username, password } object — into its parts. Returns null if unusable. */
export function parseProxy(input: unknown): ParsedProxy | null {
  if (!input) return null;
  let raw: string;
  if (typeof input === "object") {
    const o = input as { server?: string; username?: string; password?: string };
    if (!o.server) return null;
    try {
      const u = new URL(/:\/\//.test(o.server) ? o.server : `http://${o.server}`);
      if (o.username) u.username = o.username;
      if (o.password) u.password = o.password;
      raw = u.toString();
    } catch {
      return null;
    }
  } else {
    raw = String(input).trim();
  }
  if (!raw) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    const scheme = (u.protocol || "http:").replace(":", "") || "http";
    const port = Number(u.port) || (scheme === "https" ? 443 : scheme.startsWith("socks") ? 1080 : 80);
    return {
      scheme,
      host: u.hostname,
      port,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      raw,
    };
  } catch {
    return null;
  }
}

/** The --proxy-server value WITHOUT credentials (for direct, non-relayed use). */
export function proxyServerArg(p: ParsedProxy): string {
  return `${p.scheme}://${p.host}:${p.port}`;
}

/** Only authenticated http/https proxies need the relay; SOCKS + credential-less proxies go
 *  straight to chrome (SOCKS auth and no-auth are handled natively / not at all by Chromium). */
export function needsRelay(p: ParsedProxy): boolean {
  return !!p.username && (p.scheme === "http" || p.scheme === "https");
}

/** A proxy string with the password removed (for export / display). */
export function redactProxyString(input: unknown): string {
  const p = parseProxy(input);
  if (!p) return typeof input === "string" ? input : "";
  if (!p.password) return p.raw;
  try {
    const u = new URL(/:\/\//.test(p.raw) ? p.raw : `http://${p.raw}`);
    u.password = "";
    return u.toString();
  } catch {
    return p.raw;
  }
}

export interface Relay {
  url: string; // "http://127.0.0.1:<port>" to give chrome via --proxy-server
  stop: () => void;
}

/** Start a local HTTP proxy that forwards to `up` with Proxy-Authorization injected. */
export function startRelay(up: ParsedProxy): Promise<Relay> {
  const auth =
    up.username != null
      ? "Basic " + Buffer.from(`${up.username}:${up.password ?? ""}`).toString("base64")
      : undefined;

  const server = http.createServer((req, res) => {
    // plain HTTP: forward the absolute-URI request to the upstream proxy
    const headers = { ...req.headers };
    if (auth) headers["proxy-authorization"] = auth;
    const upReq = http.request(
      { host: up.host, port: up.port, method: req.method, path: req.url, headers },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upReq.on("error", () => {
      try {
        res.writeHead(502);
        res.end();
      } catch {
        /* ignore */
      }
    });
    req.pipe(upReq);
  });

  server.on("connect", (req, client, head) => {
    // HTTPS: open a CONNECT tunnel through the upstream proxy with auth, then splice the sockets
    const upstream = net.connect(up.port, up.host, () => {
      let line = `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n`;
      if (auth) line += `Proxy-Authorization: ${auth}\r\n`;
      upstream.write(line + "\r\n");
    });
    let established = false;
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      upstream.removeListener("data", onData);
      const statusLine = buf.subarray(0, idx).toString("latin1").split("\r\n")[0];
      if (/^HTTP\/1\.[01] 200/.test(statusLine)) {
        established = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const leftover = buf.subarray(idx + 4);
        if (leftover.length) client.write(leftover);
        if (head && head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      } else {
        try {
          client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        } catch {
          /* ignore */
        }
        upstream.end();
      }
    };
    upstream.on("data", onData);
    upstream.on("error", () => {
      if (!established) {
        try {
          client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        } catch {
          /* ignore */
        }
      }
    });
    client.on("error", () => upstream.destroy());
  });

  server.on("clientError", (_e, sock) => {
    try {
      sock.destroy();
    } catch {
      /* ignore */
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        stop: () => {
          try {
            server.close();
          } catch {
            /* ignore */
          }
        },
      });
    });
  });
}
