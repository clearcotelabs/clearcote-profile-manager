import { describe, it, expect, beforeEach } from "vitest";
import { startLogin, pollLogin, _resetLogins, DEVICE_CLIENT_NAME } from "../electron/devicelogin";

const BASE = "https://www.clearcotelabs.com";

/** A fake site: answers device/code, then device/token from a script of answers. */
function site(tokenAnswers: Array<{ status: number; body: Record<string, unknown> }>, codeBody?: Record<string, unknown>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    const ans = url.endsWith("/device/code")
      ? {
          status: 200,
          body: codeBody ?? {
            device_code: "dev-secret",
            user_code: "ABCD-EFGH",
            verification_uri: `${BASE}/activate`,
            verification_uri_complete: `${BASE}/activate?code=ABCD-EFGH`,
            expires_in: 600,
            interval: 5,
          },
        }
      : tokenAnswers.shift()!;
    return new Response(JSON.stringify(ans.body), { status: ans.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("device login", () => {
  beforeEach(() => _resetLogins());

  it("starts with the profile manager's name and hands out an id, never the device code", async () => {
    const { f, calls } = site([]);
    const r = await startLogin(BASE, f, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls[0].url).toBe(`${BASE}/api/v1/device/code`);
    expect(calls[0].body.client_name).toBe(DEVICE_CLIENT_NAME);
    expect(r.userCode).toBe("ABCD-EFGH");
    expect(r.verificationUri).toBe(`${BASE}/activate?code=ABCD-EFGH`);
    expect(JSON.stringify(r)).not.toContain("dev-secret");
  });

  it("refuses an answer that sends the person to another site", async () => {
    const { f } = site([], { device_code: "x", user_code: "ABCD-EFGH", verification_uri_complete: "https://evil.example/activate", interval: 5 });
    const r = await startLogin(BASE, f, 0);
    expect(r).toEqual({ ok: false, error: "The sign-in answer pointed somewhere unexpected." });
  });

  it("waits, respects the interval and slow_down, then returns the key once", async () => {
    const { f, calls } = site([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { status: 200, body: { license_key: "cc_lic_abc", plan: "pro", account_email: "p***@example.com", expires_at: null } },
    ]);
    const s = await startLogin(BASE, f, 0);
    if (!s.ok) throw new Error(s.error);
    expect(await pollLogin(s.id, f, 6_000)).toEqual({ status: "pending" });
    expect(await pollLogin(s.id, f, 7_000)).toEqual({ status: "pending" }); // too soon: no request
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
    expect(await pollLogin(s.id, f, 12_000)).toEqual({ status: "pending" }); // slow_down: +5 s
    expect(await pollLogin(s.id, f, 16_000)).toEqual({ status: "pending" }); // inside the longer wait
    const done = await pollLogin(s.id, f, 23_000);
    expect(done).toMatchObject({ status: "approved", key: "cc_lic_abc", plan: "pro", account: "p***@example.com" });
    expect(calls.filter((c) => c.url.endsWith("/token")).every((c) => c.body.device_code === "dev-secret")).toBe(true);
    expect((await pollLogin(s.id, f, 30_000)).status).toBe("expired"); // handed out: gone
  });

  it("reports denied and expired, and an unknown id", async () => {
    const { f } = site([{ status: 400, body: { error: "access_denied" } }]);
    const s = await startLogin(BASE, f, 0);
    if (!s.ok) throw new Error(s.error);
    expect((await pollLogin(s.id, f, 6_000)).status).toBe("denied");
    expect((await pollLogin("nope", f, 6_000)).status).toBe("expired");
    const t = site([]);
    const s2 = await startLogin(BASE, t.f, 0);
    if (!s2.ok) throw new Error(s2.error);
    expect((await pollLogin(s2.id, t.f, 601_000)).status).toBe("expired");
  });
});
