// helper/server.ts — the localhost API end to end, on a real port with fake handlers: the Host and
// Origin gates, CORS/Private Network preflight, the pairing handshake through the helper's own page,
// token-bound RPC, the event stream, and revoking. Raw http.request so Host and Origin are exactly
// what each case says (fetch would set them itself).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createServer } from "../helper/server";
import { TokenStore } from "../helper/auth";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-helper-server-"));
const APP = "https://app.clearcotelabs.com";
const WWW = "https://www.clearcotelabs.com";

let port = 0;
let srv: ReturnType<typeof createServer>;
const logs: string[] = [];
const pairRequests: string[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: () => any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function req(method: string, p: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers }, setHost: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const b = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode || 0, headers: res.headers, body: b, json: () => JSON.parse(b) });
        });
      },
    );
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

const post = (p: string, origin: string, body: unknown, extra: Record<string, string> = {}) =>
  req("POST", p, { origin, "content-type": "application/json", ...extra }, JSON.stringify(body));

const rpc = (origin: string, token: string | undefined, channel: string, args: unknown[] = []) =>
  post("/v1/rpc", origin, { channel, args }, token ? { authorization: `Bearer ${token}` } : {});

/** The per-run secret the helper prints into its own forms. */
function scrapeSecret(html: string): string {
  const m = html.match(/name="secret" value="([^"]+)"/);
  if (!m) throw new Error("no secret in page");
  return m[1];
}

const local = (p: string, form: Record<string, string>, origin = `http://127.0.0.1:${port}`) =>
  req("POST", p, { origin, "content-type": "application/x-www-form-urlencoded" }, new URLSearchParams(form).toString());

/** Pair `origin` all the way through and return its token. */
async function pair(origin: string, name = "Test browser"): Promise<string> {
  const start = (await post("/v1/pair", origin, { name })).json();
  const page = await req("GET", `/pair/${start.id}`);
  const secret = scrapeSecret(page.body);
  const d = await local("/local/pair", { secret, id: start.id, decision: "approve" });
  expect(d.status).toBe(303);
  const got = (await req("GET", `/v1/pair/${start.id}`, { origin, "x-pair-secret": start.secret })).json();
  expect(got.status).toBe("approved");
  return got.token;
}

beforeAll(async () => {
  port = await freePort();
  const tokens = new TokenStore(path.join(TMP, "sites.json"));
  srv = createServer({
    port,
    version: "9.9.9-test",
    tokens,
    handlers: {
      "profiles:list": () => [{ id: "p1", name: "One" }],
      launch: async (c, p: { id: string }) => {
        c.emit("download:progress", { pct: 5, id: p.id });
        return { ok: true, pid: 123 };
      },
      boom: () => {
        throw new Error("kaput");
      },
    },
    log: (l) => logs.push(l),
    onPairRequest: (_p, url) => pairRequests.push(url),
  });
  await new Promise<void>((resolve) => srv.server.listen(port, "127.0.0.1", () => resolve()));
});

afterAll(async () => {
  srv.server.closeAllConnections?.();
  await new Promise((r) => srv.server.close(r));
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("gates", () => {
  it("refuses a request addressed to another name (DNS rebinding)", async () => {
    for (const host of [`evil.com:${port}`, `127.0.0.1.nip.io:${port}`, `127.0.0.1:${port + 1}`]) {
      const r = await req("GET", "/v1/hello", { host, origin: APP });
      expect(r.status).toBe(421);
    }
    expect((await req("GET", "/", { host: `evil.com:${port}` })).status).toBe(421);
  });

  it("refuses /v1 with no Origin or a site that is not allowed, without CORS headers", async () => {
    const none = await req("GET", "/v1/hello");
    expect(none.status).toBe(403);
    const evil = await req("GET", "/v1/hello", { origin: "https://evil.com" });
    expect(evil.status).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    const evilPair = await post("/v1/pair", "https://evil.com", { name: "x" });
    expect(evilPair.status).toBe(403);
    expect(pairRequests.length).toBe(0);
  });

  it("answers the preflight for an allowed site, Private Network Access included", async () => {
    const r = await req("OPTIONS", "/v1/rpc", {
      origin: APP,
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
      "access-control-request-private-network": "true",
    });
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe(APP);
    expect(r.headers["access-control-allow-private-network"]).toBe("true");
    expect(String(r.headers["access-control-allow-headers"])).toMatch(/Authorization/);
  });

  it("hello says who it is, and not paired", async () => {
    const r = await req("GET", "/v1/hello", { origin: APP });
    expect(r.status).toBe(200);
    expect(r.headers["access-control-allow-origin"]).toBe(APP);
    expect(r.json()).toEqual({ app: "clearcote-helper", version: "9.9.9-test", paired: false });
  });

  it("refuses a non-JSON POST (it would skip the preflight)", async () => {
    const r = await req("POST", "/v1/pair", { origin: APP, "content-type": "text/plain" }, "{}");
    expect(r.status).toBe(415);
    const r2 = await req("POST", "/v1/rpc", { origin: APP, "content-type": "text/plain" }, "{}");
    expect([401, 415]).toContain(r2.status);
  });
});

describe("pairing", () => {
  it("runs through the helper's own page, and hands the token over once", async () => {
    const before = pairRequests.length;
    const start = await post("/v1/pair", APP, { name: "Chrome on Windows" });
    expect(start.status).toBe(200);
    const s = start.json();
    expect(s.code).toMatch(/^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/);
    expect(s.approveUrl).toBe(`http://127.0.0.1:${port}/pair/${s.id}`);
    expect(pairRequests.length).toBe(before + 1);

    const pending = await req("GET", `/v1/pair/${s.id}`, { origin: APP, "x-pair-secret": s.secret });
    expect(pending.json()).toEqual({ status: "pending" });
    const wrong = await req("GET", `/v1/pair/${s.id}`, { origin: APP, "x-pair-secret": "nope" });
    expect(wrong.status).toBe(403);

    const page = await req("GET", `/pair/${s.id}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain(s.code);
    expect(page.body).toContain(APP);
    expect(String(page.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    const secret = scrapeSecret(page.body);

    // A foreign page cannot press Approve, with or without the secret.
    const foreign = await local("/local/pair", { secret, id: s.id, decision: "approve" }, "https://evil.com");
    expect(foreign.status).toBe(403);
    const noSecret = await local("/local/pair", { secret: "x", id: s.id, decision: "approve" });
    expect(noSecret.status).toBe(403);
    expect((await req("GET", `/v1/pair/${s.id}`, { origin: APP, "x-pair-secret": s.secret })).json().status).toBe("pending");

    const ok = await local("/local/pair", { secret, id: s.id, decision: "approve" });
    expect(ok.status).toBe(303);
    const got = (await req("GET", `/v1/pair/${s.id}`, { origin: APP, "x-pair-secret": s.secret })).json();
    expect(got.status).toBe("approved");
    expect(got.token).toMatch(/^cch_/);
    const again = (await req("GET", `/v1/pair/${s.id}`, { origin: APP, "x-pair-secret": s.secret })).json();
    expect(again).toEqual({ status: "expired" });

    const hello = await req("GET", "/v1/hello", { origin: APP, authorization: `Bearer ${got.token}` });
    expect(hello.json().paired).toBe(true);
  });

  it("deny gives no token", async () => {
    const s = (await post("/v1/pair", APP, { name: "x" })).json();
    const secret = scrapeSecret((await req("GET", `/pair/${s.id}`)).body);
    await local("/local/pair", { secret, id: s.id, decision: "deny" });
    expect((await req("GET", `/v1/pair/${s.id}`, { origin: APP, "x-pair-secret": s.secret })).json()).toEqual({ status: "denied" });
  });
});

describe("rpc", () => {
  let token = "";
  beforeAll(async () => {
    token = await pair(APP);
  });

  it("needs a token", async () => {
    const r = await rpc(APP, undefined, "profiles:list");
    expect(r.status).toBe(401);
    expect(r.json().code).toBe("NOT_PAIRED");
    expect((await rpc(APP, "cch_fake", "profiles:list")).status).toBe(401);
  });

  it("works with the token", async () => {
    const r = await rpc(APP, token, "profiles:list");
    expect(r.status).toBe(200);
    expect(r.headers["access-control-allow-origin"]).toBe(APP);
    expect(r.json()).toEqual({ ok: true, result: [{ id: "p1", name: "One" }] });
  });

  it("refuses the token from another allowed site", async () => {
    expect((await rpc(WWW, token, "profiles:list")).status).toBe(401);
  });

  it("404s an unknown channel, including prototype names", async () => {
    expect((await rpc(APP, token, "fs:rm")).status).toBe(404);
    expect((await rpc(APP, token, "constructor")).status).toBe(404);
    expect((await rpc(APP, token, "__proto__")).status).toBe(404);
  });

  it("reports a throwing handler as ok:false", async () => {
    const r = await rpc(APP, token, "boom");
    expect(r.json()).toEqual({ ok: false, error: "kaput" });
  });

  it("refuses a body that is not JSON", async () => {
    const r = await req("POST", "/v1/rpc", { origin: APP, "content-type": "application/json", authorization: `Bearer ${token}` }, "{nope");
    expect(r.status).toBe(400);
  });

  it("streams events emitted during a call", async () => {
    const lines: string[] = [];
    const stream = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const r = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "GET",
          path: "/v1/events",
          setHost: false,
          headers: { host: `127.0.0.1:${port}`, origin: APP, authorization: `Bearer ${token}` },
        },
        resolve,
      );
      r.on("error", reject);
      r.end();
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toBe("application/x-ndjson");
    let buf = "";
    const got = new Promise<void>((resolve) => {
      stream.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        const parts = buf.split("\n");
        buf = parts.pop() || "";
        for (const p of parts) if (p.trim()) lines.push(p);
        if (lines.some((l) => l.includes("download:progress"))) resolve();
      });
    });
    // wait for the hello line before calling, so the stream is registered
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (lines.length) {
          clearInterval(t);
          resolve();
        }
      }, 10);
    });
    const r = await rpc(APP, token, "launch", [{ id: "p1", name: "One" }]);
    expect(r.json()).toEqual({ ok: true, result: { ok: true, pid: 123 } });
    await got;
    stream.destroy();
    expect(JSON.parse(lines[0])).toEqual({ channel: "hello", data: null });
    const ev = lines.map((l) => JSON.parse(l)).find((e) => e.channel === "download:progress");
    expect(ev.data).toEqual({ pct: 5, id: "p1" });
    expect(logs.some((l) => l.includes("launch") && l.includes("One"))).toBe(true);
  });

  it("the events stream needs a token too", async () => {
    expect((await req("GET", "/v1/events", { origin: APP })).status).toBe(401);
  });
});

describe("the helper's own page", () => {
  it("is refused to another site", async () => {
    expect((await req("GET", "/", { origin: "https://evil.com" })).status).toBe(403);
    expect((await local("/local/revoke", { secret: "x", hash: "y" }, "https://evil.com")).status).toBe(403);
  });

  it("lists paired sites, and revoking removes access", async () => {
    const token = await pair(WWW, "To be removed");
    expect((await rpc(WWW, token, "profiles:list")).status).toBe(200);
    const page = await req("GET", "/");
    expect(page.status).toBe(200);
    expect(page.body).toContain("To be removed");
    const secret = scrapeSecret(page.body);
    const hashes = [...page.body.matchAll(/name="hash" value="([0-9a-f]{64})"/g)].map((m) => m[1]);
    // find the row for WWW: the hash input follows its origin cell
    const row = page.body.split("<tr>").find((r) => r.includes(WWW) && r.includes("To be removed"))!;
    const hash = row.match(/name="hash" value="([0-9a-f]{64})"/)![1];
    expect(hashes).toContain(hash);
    const r = await local("/local/revoke", { secret, hash });
    expect(r.status).toBe(303);
    expect((await rpc(WWW, token, "profiles:list")).status).toBe(401);
  });
});
