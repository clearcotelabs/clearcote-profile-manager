// Start a hosted session: connect to its CDP URL once, confirm the browser answers, and let go.
//
// A hosted session's clocks only start when a client connects to its connectUrl (the worker's
// session.attach). This app does not automate the browser, the person drives it from the viewer
// window, so it connects, asks Browser.getVersion (a read-only command that proves the browser is up
// end to end), and closes. Sessions are created with keepAlive, so the worker keeps the browser
// running after the client goes, and the live view and human input keep it from idling out.

import { wsConnect, type WsConnection } from "./wsclient";

export type AttachResult = { ok: true; product?: string } | { ok: false; error: string; status?: number };

export async function attachOnce(
  connectUrl: string,
  opts: { timeoutMs?: number; connect?: typeof wsConnect } = {},
): Promise<AttachResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const connect = opts.connect ?? wsConnect;
  let ws: WsConnection | null = null;
  try {
    ws = await connect(connectUrl, { timeoutMs });
    const conn = ws;
    const reply = await new Promise<{ result?: { product?: string }; error?: { message?: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The cloud browser did not answer in ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs);
      conn.onMessage = (m) => {
        if (m.type !== "text") return;
        let j: { id?: number; result?: { product?: string }; error?: { message?: string } };
        try {
          j = JSON.parse(m.data);
        } catch {
          return;
        }
        if (j.id !== 1) return; // events, not our reply
        clearTimeout(timer);
        resolve(j);
      };
      void conn.closed.then(() => {
        clearTimeout(timer);
        reject(new Error("The cloud browser closed the connection before it answered."));
      });
      conn.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    });
    if (reply.error) return { ok: false, error: `The cloud browser refused: ${reply.error.message ?? "unknown error"}` };
    return { ok: true, product: reply.result?.product };
  } catch (e) {
    const err = e as Error & { status?: number };
    return { ok: false, error: err.message || String(e), ...(err.status ? { status: err.status } : {}) };
  } finally {
    await ws?.close().catch(() => {});
  }
}
