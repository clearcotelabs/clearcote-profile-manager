// The hosted API and its worker, on 127.0.0.1, for the desktop app's end-to-end test. It follows the
// real service's rules (clearcote-site app/api/v1/browsers + lib/hosted/service.ts, cc-gateway):
//
//   POST   /api/v1/browsers            201 {id, connectUrl, worker, warnings}; 401 without the key
//   GET    /api/v1/browsers?limit=N    {balanceEur, sessions}
//   GET    /api/v1/browsers/:id        the session's view; 404 for one that is not yours
//   DELETE /api/v1/browsers/:id        pending: ended at once ("cancelled"); active: stopRequested,
//                                      and the worker closes it on its next report (reportMs later)
//   GET    /api/v1/browsers/:id/live   {viewUrl, interactive}; 409 NOT_RUNNING unless active
//   WS     connectUrl                  one claim per URL: pending -> active, answers CDP
//                                      Browser.getVersion; keepAlive, so a client leaving detaches
//   WS     viewUrl                     the live view: hello, page meta, JPEG frames; records input
//
// Pricing as the service's default: EUR 1 per GB, no time charge, rounded up per micro-euro.

import type http from "node:http";
import { randomBytes } from "node:crypto";
import { startFakeWs, type FakeConn, type FakeWsServer } from "./fakews";

export interface FakeSession {
  id: string;
  status: "pending" | "active" | "ended" | "expired" | "lost";
  body: Record<string, unknown>;
  token: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  stopRequested: boolean;
  bytes: number;
  seconds: number;
}

export interface FakeRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body?: unknown;
}

export interface FakeCloud {
  base: string;
  key: string;
  sessions: Map<string, FakeSession>;
  requests: FakeRequest[];
  cdp: FakeConn[];
  views: FakeConn[];
  balanceEur: number;
  /** The JPEG the live view sends. */
  frame: Buffer;
  /** Fail the next creates with these answers, in order. */
  refuseCreate: { status: number; error: string; code?: string }[];
  /** How long after a DELETE the worker's next report closes a running session. */
  reportMs: number;
  use(id: string, bytes: number, seconds: number): void;
  /** The service ends a session on its own (idle, a cap, the balance). */
  end(id: string, reason: string): void;
  costEur(s: FakeSession): number;
  close(): Promise<void>;
}

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export async function startFakeCloud(opts: { key: string; balanceEur?: number; reportMs?: number }): Promise<FakeCloud> {
  const sessions = new Map<string, FakeSession>();
  const requests: FakeRequest[] = [];
  const timers = new Set<NodeJS.Timeout>();
  let ws!: FakeWsServer;

  const cloud: FakeCloud = {
    base: "",
    key: opts.key,
    sessions,
    requests,
    cdp: [],
    views: [],
    balanceEur: opts.balanceEur ?? 4.9,
    frame: Buffer.alloc(0),
    refuseCreate: [],
    reportMs: opts.reportMs ?? 800,
    use(id, bytes, seconds) {
      const s = sessions.get(id)!;
      s.bytes = bytes;
      s.seconds = seconds;
    },
    end(id, reason) {
      const s = sessions.get(id)!;
      s.status = "ended";
      s.endReason = reason;
      s.endedAt = new Date().toISOString();
      for (const v of cloud.views) if (v.path.startsWith(`/v/${id}?`)) v.close(1000);
    },
    costEur: (s) => Math.ceil((s.bytes * 1_000_000) / 1e9) / 1_000_000,
    async close() {
      for (const t of timers) clearTimeout(t);
      await ws.close();
    },
  };

  const view = (s: FakeSession) => ({
    id: s.id,
    status: s.status,
    worker: "w01",
    proxy: typeof s.body.proxy === "object" ? "custom" : "managed",
    note: s.body.note ?? null,
    profile: s.body.profile ?? null,
    createdAt: s.createdAt,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    endReason: s.endReason,
    stopRequested: s.stopRequested,
    usage: { bytesUp: Math.round(s.bytes / 10), bytesDown: s.bytes - Math.round(s.bytes / 10), gb: s.bytes / 1e9, seconds: s.seconds },
    traffic: [],
    costEur: cloud.costEur(s),
    pricing: { eurPerGb: 1, eurPerHour: 0 },
    recording: null,
    handoff: null,
  });

  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, headers: req.headers, body });
      if (req.headers.authorization !== `Bearer ${cloud.key}`) return json(res, 401, { error: "Missing or invalid API key." });

      const m = url.pathname.match(/^\/api\/v1\/browsers(?:\/(bs_[A-Za-z0-9_-]+))?(\/live)?$/);
      if (!m) return json(res, 404, { error: "Not found." });
      const [, id, live] = m;

      if (!id && req.method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 20);
        return json(res, 200, { balanceEur: cloud.balanceEur, sessions: [...sessions.values()].reverse().slice(0, limit).map(view) });
      }
      if (!id && req.method === "POST") {
        const refusal = cloud.refuseCreate.shift();
        if (refusal) return json(res, refusal.status, { error: refusal.error, ...(refusal.code ? { code: refusal.code } : {}) });
        const b = (body ?? {}) as Record<string, unknown>;
        const name = (b.profile as { name?: string; persist?: boolean } | undefined)?.persist ? (b.profile as { name: string }).name : null;
        if (name) {
          const writer = [...sessions.values()].find(
            (s) => (s.status === "pending" || s.status === "active") && (s.body.profile as { name?: string; persist?: boolean } | undefined)?.persist && (s.body.profile as { name: string }).name === name,
          );
          if (writer) return json(res, 409, { error: `Session ${writer.id} is already saving to profile "${name}". Stop it first, or open the profile read-only (persist: false).`, code: "PROFILE_IN_USE" });
        }
        const s: FakeSession = {
          id: `bs_${randomBytes(12).toString("base64url")}`,
          status: "pending",
          body: b,
          token: randomBytes(16).toString("hex"),
          createdAt: new Date().toISOString(),
          startedAt: null,
          endedAt: null,
          endReason: null,
          stopRequested: false,
          bytes: 0,
          seconds: 0,
        };
        sessions.set(s.id, s);
        return json(res, 201, { id: s.id, status: "pending", connectUrl: `${ws.url(`/s/${s.id}`)}?token=${s.token}`, worker: "w01", warnings: [] });
      }
      const s = id ? sessions.get(id) : undefined;
      if (!s) return json(res, 404, { error: "No such session.", code: "NOT_FOUND" });
      if (live && req.method === "GET") {
        if (s.status !== "active") return json(res, 409, { error: "Live view is only available while the browser is running.", code: "NOT_RUNNING" });
        const control = ["1", "true"].includes(url.searchParams.get("control") ?? "");
        return json(res, 200, { viewUrl: `${ws.url(`/v/${s.id}`)}?t=${randomBytes(8).toString("hex")}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), interactive: control });
      }
      if (req.method === "GET") return json(res, 200, view(s));
      if (req.method === "DELETE") {
        if (s.status === "pending") {
          s.status = "ended";
          s.endReason = "cancelled";
          s.endedAt = new Date().toISOString();
        } else if (s.status === "active" && !s.stopRequested) {
          s.stopRequested = true;
          const t = setTimeout(() => {
            timers.delete(t);
            if (s.status === "active") cloud.end(s.id, "stopped:user");
          }, cloud.reportMs);
          timers.add(t);
        }
        return json(res, 200, view(s));
      }
      return json(res, 405, { error: "Method not allowed." });
    });
  };

  ws = await startFakeWs({
    onRequest,
    refuse: (path) => {
      const u = new URL(path, "http://x");
      const cdp = u.pathname.match(/^\/s\/(bs_[A-Za-z0-9_-]+)$/);
      if (cdp) {
        const s = sessions.get(cdp[1]);
        if (!s || u.searchParams.get("token") !== s.token) return { status: 404, body: JSON.stringify({ error: "Unknown session." }) };
        if (s.status === "pending") return undefined;
        // keepAlive: a running session takes a client again (the reconnect path).
        if (s.status === "active" && s.body.keepAlive === true) return undefined;
        return { status: 409, body: JSON.stringify({ error: "This connect URL was already used. Create a new session.", code: "ALREADY_CLAIMED" }) };
      }
      const v = u.pathname.match(/^\/v\/(bs_[A-Za-z0-9_-]+)$/);
      if (v) return sessions.get(v[1])?.status === "active" ? undefined : { status: 410, body: JSON.stringify({ error: "This session has ended.", code: "ENDED" }) };
      return { status: 404, body: "{}" };
    },
    onConnection: (c) => {
      const u = new URL(c.path, "http://x");
      if (u.pathname.startsWith("/s/")) {
        const s = sessions.get(u.pathname.slice(3))!;
        s.status = "active";
        s.startedAt ??= new Date().toISOString();
        cloud.cdp.push(c);
        c.onText = (t) => {
          const cmd = JSON.parse(t) as { id: number; method: string };
          if (cmd.method === "Browser.getVersion") c.sendText(JSON.stringify({ id: cmd.id, result: { product: "Chrome/153.0.8010.53", protocolVersion: "1.3" } }));
          else c.sendText(JSON.stringify({ id: cmd.id, error: { code: -32601, message: `'${cmd.method}' wasn't found` } }));
        };
      } else {
        cloud.views.push(c);
        c.sendText(JSON.stringify({ hello: true, control: true }));
        c.sendText(JSON.stringify({ url: "https://example.com/", title: "Example Domain", tabs: 1 }));
        if (cloud.frame.length) c.sendBinary(cloud.frame);
      }
    },
  });
  cloud.base = `http://127.0.0.1:${ws.port}`;
  return cloud;
}
