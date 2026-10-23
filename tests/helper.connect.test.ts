// helper/server.ts started with a pairing code (`clearcote connect CODE`): the page that sends the
// same code is paired with no approval page, and gets its token on its usual status call.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createServer } from "../helper/server";
import { TokenStore } from "../helper/auth";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-helper-connect-"));
const APP = "https://app.clearcotelabs.com";
let port = 0;
let srv: ReturnType<typeof createServer>;
const logs: string[] = [];
const pairRequests: string[] = [];

function req(method: string, p: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; json: () => any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers }, setHost: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const b = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode || 0, json: () => JSON.parse(b) });
        });
      },
    );
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const post = (p: string, body: unknown, extra: Record<string, string> = {}) =>
  req("POST", p, { origin: APP, "content-type": "application/json", ...extra }, JSON.stringify(body));

beforeAll(async () => {
  port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  srv = createServer({
    port,
    version: "9.9.9-test",
    pairCode: "4f7-k2q",
    tokens: new TokenStore(path.join(TMP, "sites.json")),
    handlers: { "profiles:list": () => [] },
    log: (l) => logs.push(l),
    onPairRequest: (_p, url) => pairRequests.push(url),
  });
  await new Promise<void>((resolve) => srv.server.listen(port, "127.0.0.1", () => resolve()));
});

afterAll(async () => {
  srv.server.closeAllConnections?.();
  await new Promise((r) => srv.server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("pairing with the code from the command line", () => {
  it("a wrong code is an ordinary request: the approval page opens", async () => {
    const s = (await post("/v1/pair", { name: "x", code: "222-222" })).json();
    expect(s.status).toBe("pending");
    expect(pairRequests).toHaveLength(1);
  });

  it("the right code pairs at once, without the approval page, and the token works", async () => {
    const s = (await post("/v1/pair", { name: "Chrome on Windows", code: "4F7-K2Q" })).json();
    expect(s.status).toBe("approved");
    expect(s.token).toBeUndefined(); // only the status call, with the secret, hands it over
    expect(pairRequests).toHaveLength(1);
    const got = (await req("GET", `/v1/pair/${s.id}`, { origin: APP, "x-pair-secret": s.secret })).json();
    expect(got.status).toBe("approved");
    const list = await post("/v1/rpc", { channel: "profiles:list", args: [] }, { authorization: `Bearer ${got.token}` });
    expect(list.json()).toEqual({ ok: true, result: [] });
    expect(logs.some((l) => l.includes("from the command line"))).toBe(true);
  });

  it("works once", async () => {
    const s = (await post("/v1/pair", { name: "x", code: "4F7-K2Q" })).json();
    expect(s.status).toBe("pending");
    expect(pairRequests).toHaveLength(2);
  });
});
