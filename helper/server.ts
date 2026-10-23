// The helper's localhost API. Two kinds of caller:
//
//   /v1/*     the web profile manager, from an allowed site (auth.ts). CORS-checked, token-checked.
//   / , /local/*   the helper's own page, opened on this computer: pairing approval, paired sites,
//             recent activity. Only answers its own origin, and every form carries a per-run secret.
//
// The API is one RPC route over the same handlers the desktop app uses (electron/handlers.ts), plus
// an event stream for progress and "a browser closed". It listens on 127.0.0.1 only.

import http from "node:http";
import crypto from "node:crypto";
import { allowedOrigins, hostOk, isLocalOrigin, Pairings, TokenStore, type Pairing } from "./auth";
import type { Handler } from "../electron/handlers";
import { statusPage, pairPage } from "./pages";

export interface ServerOptions {
  port: number;
  /** The code from `--pair-code` / CLEARCOTE_HELPER_PAIR_CODE: the page showing it pairs without the approval page. */
  pairCode?: string;
  version: string;
  handlers: Record<string, Handler>;
  tokens: TokenStore;
  extraOrigins?: string[];
  /** A pairing request arrived: open the approval page for the person. */
  onPairRequest(p: Pairing, url: string): void;
  log(line: string): void;
}

/** Calls the web page may make that change nothing — kept out of the visible activity log. */
const QUIET = new Set([
  "profiles:list", "profiles:get", "running", "cloud:list", "launchTarget", "settings:get", "versions:list",
  "versions:revisions", "host:gpu", "cache:list", "storage:plan", "storage:temp", "storage:profileSizes",
  "resolveBinary", "cloud:viewUrl", "fp:library", "license:check", "license:loginPoll",
]);

const MAX_BODY = 16 * 1024 * 1024; // an import of many profiles with their fingerprints

export interface Activity {
  at: string;
  origin: string;
  what: string;
}

export function createServer(opts: ServerOptions) {
  const origins = allowedOrigins(opts.extraOrigins);
  const pairings = new Pairings();
  if (opts.pairCode && !pairings.allowCode(opts.pairCode)) opts.log(`Ignored the pairing code "${opts.pairCode}": it is not a code the web page shows.`);
  const localSecret = crypto.randomBytes(24).toString("base64url");
  const streams = new Set<http.ServerResponse>();
  const activity: Activity[] = [];
  const selfUrl = `http://127.0.0.1:${opts.port}`;

  const note = (origin: string, what: string) => {
    activity.unshift({ at: new Date().toISOString(), origin, what });
    activity.length = Math.min(activity.length, 200);
    opts.log(`${origin}  ${what}`);
  };

  /** Push an event to every connected page. */
  const broadcast = (channel: string, data: unknown) => {
    const line = JSON.stringify({ channel, data }) + "\n";
    for (const s of streams) s.write(line);
  };

  const json = (res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error("too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  const cors = (origin: string): http.OutgoingHttpHeaders => ({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Pair-Secret",
    // Chrome's Private Network Access preflight: a public site may reach this local server.
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  });

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL, origin: string) {
    const h = cors(origin);
    if (req.method === "OPTIONS") {
      res.writeHead(204, h);
      return res.end();
    }

    // Unauthenticated: is a helper here, and is this page already paired.
    if (url.pathname === "/v1/hello" && req.method === "GET") {
      const site = opts.tokens.check(bearer(req), origin);
      return json(res, 200, { app: "clearcote-helper", version: opts.version, paired: !!site }, h);
    }

    if (url.pathname === "/v1/pair" && req.method === "POST") {
      if (!isJson(req)) return json(res, 415, { error: "JSON only" }, h);
      let name = "A browser";
      let code: string | undefined;
      try {
        const body = JSON.parse(await readBody(req));
        name = String(body?.name || name);
        if (typeof body?.code === "string") code = body.code;
      } catch {
        /* default name */
      }
      const p = pairings.start(origin, name, code, (pp) => opts.tokens.issue(pp.origin, pp.name));
      if (p.status === "approved") {
        note(origin, `paired as “${p.name}” (code ${p.code}, from the command line)`);
      } else {
        note(origin, `asked to pair (code ${p.code})`);
        opts.onPairRequest(p, `${selfUrl}/pair/${p.id}`);
      }
      return json(res, 200, { id: p.id, code: p.code, secret: p.secret, approveUrl: `${selfUrl}/pair/${p.id}`, status: p.status }, h);
    }

    const pairMatch = url.pathname.match(/^\/v1\/pair\/([A-Za-z0-9_-]{8,64})$/);
    if (pairMatch && req.method === "GET") {
      const r = pairings.collect(pairMatch[1], String(req.headers["x-pair-secret"] || ""));
      if (!r) return json(res, 403, { error: "Not your pairing request." }, h);
      return json(res, 200, r, h);
    }

    // Everything else needs a token paired by this same site.
    const site = opts.tokens.check(bearer(req), origin);
    if (!site) return json(res, 401, { error: "Not paired", code: "NOT_PAIRED" }, h);

    if (url.pathname === "/v1/events" && req.method === "GET") {
      res.writeHead(200, { ...h, "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      res.write(JSON.stringify({ channel: "hello", data: null }) + "\n");
      streams.add(res);
      const ping = setInterval(() => res.write("\n"), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        streams.delete(res);
      });
      return;
    }

    if (url.pathname === "/v1/rpc" && req.method === "POST") {
      if (!isJson(req)) return json(res, 415, { error: "JSON only" }, h);
      let channel = "";
      let args: unknown[] = [];
      try {
        const body = JSON.parse(await readBody(req));
        channel = String(body?.channel || "");
        args = Array.isArray(body?.args) ? body.args : [];
      } catch {
        return json(res, 400, { error: "Bad request" }, h);
      }
      const fn = Object.prototype.hasOwnProperty.call(opts.handlers, channel) ? opts.handlers[channel] : undefined;
      if (!fn) return json(res, 404, { error: `Unknown call ${channel}` }, h);
      if (!QUIET.has(channel)) note(origin, describe(channel, args));
      try {
        const result = await fn({ emit: broadcast }, ...args);
        return json(res, 200, { ok: true, result: result ?? null }, h);
      } catch (e) {
        return json(res, 200, { ok: false, error: String((e as Error)?.message || e) }, h);
      }
    }

    return json(res, 404, { error: "Not found" }, h);
  }

  async function local(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const html = (body: string) => {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // Nothing loads from anywhere, nothing frames it.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        "X-Frame-Options": "DENY",
        // Not "no-referrer": with it Chrome sends `Origin: null` on the page's own form posts.
        "Referrer-Policy": "same-origin",
      });
      res.end(body);
    };

    if (req.method === "GET" && url.pathname === "/") {
      return html(statusPage({ version: opts.version, sites: opts.tokens.list(), pending: pairings.pending(), activity, secret: localSecret }));
    }
    const pm = url.pathname.match(/^\/pair\/([A-Za-z0-9_-]{8,64})$/);
    if (req.method === "GET" && pm) {
      return html(pairPage({ pairing: pairings.get(pm[1]), secret: localSecret }));
    }

    if (req.method === "POST" && url.pathname.startsWith("/local/")) {
      // Only the helper's own page posts here: its origin, and the secret printed into its forms.
      if (!isLocalOrigin(header(req, "origin"), opts.port)) return json(res, 403, { error: "Forbidden" });
      const form = new URLSearchParams(await readBody(req).catch(() => ""));
      const a = Buffer.from(form.get("secret") || "");
      const b = Buffer.from(localSecret);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json(res, 403, { error: "Forbidden" });

      if (url.pathname === "/local/pair") {
        const id = form.get("id") || "";
        const approve = form.get("decision") === "approve";
        const p = pairings.decide(id, approve, (pp) => opts.tokens.issue(pp.origin, pp.name));
        if (p) note(p.origin, approve ? `paired as “${p.name}”` : "pairing denied");
        res.writeHead(303, { Location: `/pair/${encodeURIComponent(id)}` });
        return res.end();
      }
      if (url.pathname === "/local/revoke") {
        const hash = form.get("hash") || "";
        const site = opts.tokens.list().find((s) => s.hash === hash);
        if (opts.tokens.revoke(hash) && site) note(site.origin, `access removed (“${site.name}”)`);
        res.writeHead(303, { Location: "/" });
        return res.end();
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }

  const server = http.createServer((req, res) => {
    // DNS rebinding: only requests addressed to this helper by its own name.
    if (!hostOk(req.headers.host, opts.port)) {
      res.writeHead(421, { "Content-Type": "text/plain" });
      return res.end("Wrong host");
    }
    const url = new URL(req.url || "/", selfUrl);
    const origin = header(req, "origin");

    if (url.pathname.startsWith("/v1/")) {
      // A browser always sends Origin on these (cross-origin fetches). No Origin, or a site that is not
      // the web profile manager: no CORS headers, so the page cannot read anything, and no action.
      if (!origin || !origins.has(origin)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        return res.end("This site may not use the Clearcote helper.");
      }
      return void api(req, res, url, origin).catch((e) => {
        if (!res.headersSent) json(res, 500, { error: String((e as Error)?.message || e) }, cors(origin));
      });
    }
    // The helper's own pages: never from another site (a top-level visit has no Origin on GET).
    if (origin && !isLocalOrigin(origin, opts.port)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      return res.end("Forbidden");
    }
    return void local(req, res, url).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  return { server, broadcast, url: selfUrl };
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function bearer(req: http.IncomingMessage): string | undefined {
  const a = header(req, "authorization") || "";
  return a.startsWith("Bearer ") ? a.slice(7).trim() : undefined;
}

/** Forces a CORS preflight on every POST, so the origin check runs before anything happens. */
function isJson(req: http.IncomingMessage): boolean {
  return (header(req, "content-type") || "").toLowerCase().startsWith("application/json");
}

/** One line for the activity log: what was asked, naming the profile where there is one. */
function describe(channel: string, args: unknown[]): string {
  const a = args[0] as { id?: string; name?: string } | string | undefined;
  const who = typeof a === "string" ? a : a && typeof a === "object" ? a.name || a.id : undefined;
  return who ? `${channel}  ${String(who).slice(0, 60)}` : channel;
}
