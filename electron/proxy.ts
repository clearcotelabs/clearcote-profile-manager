// The local auth-injecting relay for authenticated http/https proxies.
//
// Parsing and switch-building live in ./proxyargs (pure, no `node:` imports, so the renderer can
// import it too); this module owns the socket machinery and re-exports them so existing importers
// keep working. Chromium's --proxy-server IGNORES inline credentials, so they travel by one of two
// routes:
//
//   http/https + credentials → the relay below listens on 127.0.0.1, forwards to the upstream proxy
//     with Proxy-Authorization injected, and the browser is pointed at it — so the browser never
//     sees (or has to prompt for) the credentials. Verified end-to-end against a real authenticated
//     proxy (HTTP + HTTPS/CONNECT).
//
//   socks5 + credentials → --socks5-credentials, native in the engine since 151 r14 (RFC 1929,
//     which stock Chromium does not implement at all). No relay: this one speaks HTTP upstream, not
//     SOCKS. See proxyArgs() in ./proxyargs.
import http from "node:http";
import net from "node:net";

export {
  parseProxy,
  proxyServerArg,
  redactProxyString,
  isAuthenticatedSocks,
  needsRelay,
  socks5CredentialsArg,
  proxyArgs,
  socks5AuthSupportWarning,
  socks5UdpSupportWarning,
  SOCKS5_AUTH_MIN_MAJOR,
  SOCKS5_UDP_MIN_MAJOR,
  type ParsedProxy,
} from "./proxyargs";

import type { ParsedProxy } from "./proxyargs";

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
