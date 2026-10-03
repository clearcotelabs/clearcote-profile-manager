// electron/cloudapi.ts: the hosted API client. Where the key may go, how each call is made, and what
// every kind of failure turns into. The error bodies are the API's real ones (clearcote-site
// app/api/v1/browsers routes).

import { describe, it, expect } from "vitest";
import { CloudApi, CLOUD_USER_AGENT, DEFAULT_CLOUD_BASE, isFinalStatus, resolveApiBase, resolveApiKey } from "../electron/cloudapi";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function stub(responses: (Response | Error | ((c: Call) => Response | Promise<Response>))[]) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
    };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error("no more stubbed responses");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(call) : next;
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const SID = "bs_D6-_eN1aN3hOgJW1lh8R5dRQ";
const client = (fetchFn: typeof fetch, timeoutMs?: number) => new CloudApi({ apiKey: "cc_live_test", base: "https://www.clearcotelabs.com", fetch: fetchFn, timeoutMs });

describe("where the key comes from and goes to", () => {
  it("uses the saved key, then CLEARCOTE_API_KEY", () => {
    expect(resolveApiKey(" cc_live_saved ", { CLEARCOTE_API_KEY: "cc_live_env" })).toBe("cc_live_saved");
    expect(resolveApiKey("", { CLEARCOTE_API_KEY: " cc_live_env " })).toBe("cc_live_env");
    expect(resolveApiKey(undefined, {})).toBeUndefined();
    expect(resolveApiKey("   ", { CLEARCOTE_API_KEY: "  " })).toBeUndefined();
  });

  it("talks to clearcotelabs.com unless CLEARCOTE_API_URL or the saved base says otherwise", () => {
    expect(resolveApiBase(undefined, {})).toEqual({ ok: true, base: DEFAULT_CLOUD_BASE });
    expect(resolveApiBase("https://staging.example.com/", {})).toEqual({ ok: true, base: "https://staging.example.com" });
    expect(resolveApiBase("https://saved.example.com", { CLEARCOTE_API_URL: "https://env.example.com" })).toEqual({ ok: true, base: "https://env.example.com" });
  });

  it("never sends the key over plain http, except to this machine", () => {
    for (const local of ["http://127.0.0.1:3100", "http://localhost:4000", "http://[::1]:9"]) expect(resolveApiBase(local, {}).ok, local).toBe(true);
    for (const bad of ["http://www.clearcotelabs.com", "http://192.168.1.5:3000", "ftp://x.example", "ws://localhost:1"]) {
      const r = resolveApiBase(bad, {});
      expect(r.ok, bad).toBe(false);
      expect(!r.ok && r.error).toMatch(/https:\/\//);
    }
    expect(resolveApiBase("not a url", {})).toEqual({ ok: false, error: "The cloud API address “not a url” is not a URL." });
  });
});

describe("the calls", () => {
  it("creates a session: POST with the key, the app's User-Agent and the JSON body", async () => {
    const { calls, fetchFn } = stub([json(201, { id: SID, connectUrl: "wss://browser.clearcotelabs.com/s/x", worker: "w01", warnings: [] })]);
    const r = await client(fetchFn).create({ identity: "seed", keepAlive: true });
    expect(r).toEqual({ ok: true, data: { id: SID, connectUrl: "wss://browser.clearcotelabs.com/s/x", worker: "w01", warnings: [] } });
    expect(calls[0].url).toBe("https://www.clearcotelabs.com/api/v1/browsers");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.authorization).toBe("Bearer cc_live_test");
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(calls[0].headers["user-agent"]).toBe(CLOUD_USER_AGENT);
    expect(CLOUD_USER_AGENT).toMatch(/^clearcote-profile-manager\/\d+\.\d+\.\d+/);
    expect(JSON.parse(calls[0].body!)).toEqual({ identity: "seed", keepAlive: true });
  });

  it("reads the account, a session, its live view, and stops it", async () => {
    const view = { id: SID, status: "active", usage: { bytesUp: 6041, bytesDown: 14319, seconds: 21 }, costEur: 0.000021 };
    const { calls, fetchFn } = stub([
      json(200, { balanceEur: 4.9, sessions: [] }),
      json(200, view),
      json(200, { viewUrl: "wss://browser.clearcotelabs.com/v/x", expiresAt: "t", interactive: true }),
      json(200, { viewUrl: "wss://browser.clearcotelabs.com/v/y", interactive: false }),
      json(200, { ...view, status: "ended", endReason: "stopped:user" }),
    ]);
    const api = client(fetchFn);
    expect(await api.account()).toEqual({ ok: true, data: { balanceEur: 4.9, sessions: [] } });
    expect(await api.get(SID)).toEqual({ ok: true, data: view });
    expect((await api.live(SID, true)).ok).toBe(true);
    expect((await api.live(SID, false)).ok).toBe(true);
    const stopped = await api.stop(SID);
    expect(stopped.ok && stopped.data.endReason).toBe("stopped:user");
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://www.clearcotelabs.com", "")}`)).toEqual([
      "GET /api/v1/browsers?limit=1",
      `GET /api/v1/browsers/${SID}`,
      `GET /api/v1/browsers/${SID}/live?control=1`,
      `GET /api/v1/browsers/${SID}/live`,
      `DELETE /api/v1/browsers/${SID}`,
    ]);
    expect(calls.every((c) => c.headers.authorization === "Bearer cc_live_test")).toBe(true);
    expect(calls.filter((c) => c.method === "GET").every((c) => c.body === undefined && !c.headers["content-type"])).toBe(true);
  });

  it("never puts something that is not a session id into a URL path", async () => {
    const { calls, fetchFn } = stub([]);
    const api = client(fetchFn);
    for (const id of ["../../api/v1/browsers", "bs_short", "bs_x/live", ""]) {
      expect(await api.get(id)).toMatchObject({ ok: false, code: "BAD_ID" });
      expect(await api.stop(id)).toMatchObject({ ok: false, code: "BAD_ID" });
      expect(await api.live(id, true)).toMatchObject({ ok: false, code: "BAD_ID" });
    }
    expect(calls).toEqual([]);
  });
});

describe("failures", () => {
  it("passes the API's own message and code through", async () => {
    const cases: [number, unknown, { code?: string; error: string }][] = [
      [402, { error: "Your hosted-browser balance is EUR 0.12; at least EUR 0.50 is needed to start a browser.", code: "INSUFFICIENT_BALANCE" }, { code: "INSUFFICIENT_BALANCE", error: "Your hosted-browser balance is EUR 0.12; at least EUR 0.50 is needed to start a browser." }],
      [503, { error: "No worker that supports start_url, keepalive has capacity right now. Retry in a few seconds.", code: "NO_CAPACITY" }, { code: "NO_CAPACITY", error: "No worker that supports start_url, keepalive has capacity right now. Retry in a few seconds." }],
      [429, { error: "Rate limit exceeded." }, { error: "Rate limit exceeded." }],
      [400, { error: "country must be a 2-letter code like us" }, { error: "country must be a 2-letter code like us" }],
      [404, { error: "No such session.", code: "NOT_FOUND" }, { code: "NOT_FOUND", error: "No such session." }],
    ];
    for (const [status, body, want] of cases) {
      const { fetchFn } = stub([json(status, body)]);
      const r = await client(fetchFn).create({});
      expect(r, String(status)).toEqual({ ok: false, status, ...want, ...(want.code ? {} : { code: undefined }) });
    }
  });

  it("words a refused key for the person, pointing at Settings", async () => {
    const { fetchFn } = stub([json(401, { error: "Missing or invalid API key." })]);
    expect(await client(fetchFn).account()).toEqual({ ok: false, status: 401, code: "UNAUTHORIZED", error: "The API key was not accepted. Check it in Settings → Cloud." });
  });

  it("survives a body that is not JSON (a proxy's HTML error page)", async () => {
    const { fetchFn } = stub([new Response("<html>502 Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" })]);
    expect(await client(fetchFn).create({})).toEqual({ ok: false, status: 502, code: undefined, error: "www.clearcotelabs.com answered 502 Bad Gateway." });
  });

  it("reports a network failure without throwing", async () => {
    const { fetchFn } = stub([new TypeError("fetch failed")]);
    expect(await client(fetchFn).create({})).toEqual({
      ok: false,
      status: 0,
      code: "NETWORK",
      error: "Could not reach www.clearcotelabs.com. Check the connection and try again.",
    });
  });

  it("gives up on a server that never answers", async () => {
    const hang = (c: Call) =>
      new Promise<Response>((_r, reject) => {
        void c;
        setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 50);
      });
    const { fetchFn } = stub([hang]);
    expect(await client(fetchFn, 30).get(SID)).toEqual({ ok: false, status: 0, code: "TIMEOUT", error: "www.clearcotelabs.com did not answer in 0 s." });
  });

  it("treats ended, expired and lost as final, and nothing else", () => {
    for (const s of ["ended", "expired", "lost"]) expect(isFinalStatus(s)).toBe(true);
    for (const s of ["pending", "active", undefined, ""]) expect(isFinalStatus(s)).toBe(false);
  });
});
