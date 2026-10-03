// electron/cdpattach.ts: starting a cloud browser by connecting once, asking Browser.getVersion and
// letting go. Against a local server that plays the worker's CDP endpoint.

import { describe, it, expect, afterEach } from "vitest";
import { attachOnce } from "../electron/cdpattach";
import { startFakeWs, type FakeWsServer, type FakeConn } from "./helpers/fakews";

const servers: FakeWsServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});
async function cdp(onCommand: (conn: FakeConn, cmd: { id: number; method: string }) => void, opts: Parameters<typeof startFakeWs>[0] = {}) {
  const s = await startFakeWs({
    ...opts,
    onConnection: (c) => {
      c.onText = (t) => onCommand(c, JSON.parse(t));
    },
  });
  servers.push(s);
  return s;
}

describe("attachOnce", () => {
  it("asks Browser.getVersion, returns the product, and closes the connection", async () => {
    const s = await cdp((c, cmd) => {
      expect(cmd.method).toBe("Browser.getVersion");
      c.sendText(JSON.stringify({ id: cmd.id, result: { product: "Chrome/153.0.8010.53", protocolVersion: "1.3" } }));
    });
    const r = await attachOnce(s.url("/session/bs_x?token=t"));
    expect(r).toEqual({ ok: true, product: "Chrome/153.0.8010.53" });
    const conn = s.conns[0];
    expect(conn.texts).toEqual([JSON.stringify({ id: 1, method: "Browser.getVersion" })]);
    // It let go: a masked close frame went out, so a keep-alive session detaches instead of hanging on.
    expect(await conn.clientClosed).toBe(1000);
  });

  it("ignores events that arrive before its reply", async () => {
    const s = await cdp((c, cmd) => {
      c.sendText(JSON.stringify({ method: "Target.targetCreated", params: { targetInfo: { type: "page" } } }));
      c.sendText(JSON.stringify({ id: 99, result: {} }));
      c.sendText("not json at all");
      c.sendText(JSON.stringify({ id: cmd.id, result: { product: "Chrome/153" } }), { fragments: 3 });
    });
    expect(await attachOnce(s.url())).toEqual({ ok: true, product: "Chrome/153" });
  });

  it("reports a CDP error reply", async () => {
    const s = await cdp((c, cmd) => c.sendText(JSON.stringify({ id: cmd.id, error: { code: -32000, message: "Not allowed" } })));
    expect(await attachOnce(s.url())).toEqual({ ok: false, error: "The cloud browser refused: Not allowed" });
  });

  it("reports a connection the worker closes before answering", async () => {
    const s = await cdp((c) => c.close(1011, { drop: true }));
    const r = await attachOnce(s.url(), { timeoutMs: 5000 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("The cloud browser closed the connection before it answered.");
  });

  it("reports a refused connect URL with its status (used, expired, someone else attached)", async () => {
    const s = await cdp(() => {}, { refuse: () => ({ status: 410, body: JSON.stringify({ error: "This connect URL was already used." }) }) });
    expect(await attachOnce(s.url())).toEqual({ ok: false, error: "410: This connect URL was already used.", status: 410 });
  });

  it("gives up when the browser never answers", async () => {
    const s = await cdp(() => {});
    const t = Date.now();
    const r = await attachOnce(s.url(), { timeoutMs: 400 });
    expect(r).toEqual({ ok: false, error: "The cloud browser did not answer in 0 s." });
    expect(Date.now() - t).toBeLessThan(4000);
  });
});
