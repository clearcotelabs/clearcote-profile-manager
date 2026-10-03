// electron/cloud.ts: the cloud sessions the app runs. Start, attach, follow, stop, restart, and every
// way each of those goes wrong, against a stub of the hosted API that keeps sessions in memory.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudManager, type CloudEnded, type CloudSessionState, type CloudDeps } from "../electron/cloud";
import type { CloudApi, CloudResult, SessionView, CreatedSession, LiveView, CloudAccount } from "../electron/cloudapi";
import type { AttachResult } from "../electron/cdpattach";

let dir = "";
let file = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-cloud-test-"));
  file = path.join(dir, "cloud-sessions.json");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

type Fail = { status: number; code?: string; error: string };

/** The hosted API, in memory. Queue failures on a method to make the next call fail that way. */
class FakeApi {
  sessions = new Map<string, SessionView>();
  bodies: Record<string, unknown>[] = [];
  calls: string[] = [];
  fail: Partial<Record<"create" | "get" | "stop" | "live", Fail[]>> = {};
  private n = 0;
  private take(m: keyof FakeApi["fail"]): Fail | undefined {
    return this.fail[m]?.shift();
  }
  async create(body: Record<string, unknown>): Promise<CloudResult<CreatedSession>> {
    this.calls.push("create");
    const f = this.take("create");
    if (f) return { ok: false, ...f };
    this.bodies.push(body);
    const id = `bs_test${String(++this.n).padStart(16, "0")}`;
    this.sessions.set(id, { id, status: "pending", usage: { bytesUp: 0, bytesDown: 0, seconds: 0 }, costEur: 0 });
    return { ok: true, data: { id, connectUrl: `wss://browser.test/s/${id}`, worker: "w01", warnings: ["a warning from the API"] } };
  }
  async get(id: string): Promise<CloudResult<SessionView>> {
    this.calls.push(`get ${id}`);
    const f = this.take("get");
    if (f) return { ok: false, ...f };
    const s = this.sessions.get(id);
    return s ? { ok: true, data: { ...s } } : { ok: false, status: 404, code: "NOT_FOUND", error: "No such session." };
  }
  async stop(id: string): Promise<CloudResult<SessionView>> {
    this.calls.push(`stop ${id}`);
    const f = this.take("stop");
    if (f) return { ok: false, ...f };
    const s = this.sessions.get(id);
    if (!s) return { ok: false, status: 404, code: "NOT_FOUND", error: "No such session." };
    // Like requestStop: a session nobody attached to ends at once; a running one is only marked, and
    // its worker closes it on its next report (report() below).
    if (s.status === "pending") {
      s.status = "ended";
      s.endReason = "cancelled";
    } else if (s.status === "active") s.stopRequested = true;
    return { ok: true, data: { ...s } };
  }
  /** The worker's next report: a session asked to stop is closed, with its final usage. */
  report(id: string, endReason = "client_closed_browser") {
    const s = this.sessions.get(id)!;
    if (s.stopRequested) {
      s.status = "ended";
      s.endReason = endReason;
    }
  }
  async live(id: string, control: boolean): Promise<CloudResult<LiveView>> {
    this.calls.push(`live ${id} ${control}`);
    const f = this.take("live");
    if (f) return { ok: false, ...f };
    return { ok: true, data: { viewUrl: `wss://browser.test/v/${id}`, interactive: control } };
  }
  async account(): Promise<CloudResult<CloudAccount>> {
    return { ok: true, data: { balanceEur: 1, sessions: [] } };
  }
  /** The worker activates a session once a client attached. */
  activate(id: string) {
    const s = this.sessions.get(id);
    if (s) s.status = "active";
  }
  use(id: string, bytes: number, seconds: number, costEur: number) {
    const s = this.sessions.get(id)!;
    s.usage = { bytesUp: Math.round(bytes / 10), bytesDown: bytes - Math.round(bytes / 10), seconds };
    s.costEur = costEur;
  }
}

function manager(opts: Omit<Partial<CloudDeps>, "api"> & { api?: FakeApi | { error: string; code: string } } = {}) {
  const { api, ...over } = opts;
  const fake = api && !("error" in api) ? api : new FakeApi();
  const attached: string[] = [];
  const deps: CloudDeps = {
    api: () => (api && "error" in api ? api : (fake as unknown as CloudApi)),
    attach: async (url): Promise<AttachResult> => {
      attached.push(url);
      const id = url.split("/").pop()!;
      fake.activate(id);
      return { ok: true, product: "Chrome/153.0.8010.53" };
    },
    file,
    pollMs: 60_000,
    capacityRetryMs: [1, 1, 1],
    ...over,
  };
  const m = new CloudManager(deps);
  const changes: CloudSessionState[][] = [];
  const ended: CloudEnded[] = [];
  m.on("changed", (l) => changes.push(l));
  m.on("ended", (e) => ended.push(e));
  return { m, fake, attached, changes, ended };
}
const profile = (id = "acct-1", over: Record<string, unknown> = {}) => ({ id, name: `Profile ${id}`, fingerprint: `seed-${id}`, ...over });
const onDisk = () => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>[];

describe("starting", () => {
  it("plans, creates, attaches once, and reports it running", async () => {
    const { m, fake, attached, changes } = manager();
    const r = await m.start(profile("acct-1", { platform: "windows", cloud: { country: "us" } }));
    expect(r).toEqual({ ok: true, sid: "bs_test0000000000000001", warnings: ["a warning from the API"] });
    expect(fake.bodies[0]).toMatchObject({ identity: "seed-acct-1", platform: "windows", proxy: "managed", country: "us", keepAlive: true });
    expect(attached).toEqual(["wss://browser.test/s/bs_test0000000000000001"]);
    expect(changes.map((l) => l.map((s) => s.status))).toEqual([["starting"], ["running"]]);
    const s = m.get("acct-1")!;
    expect(s).toMatchObject({ profileId: "acct-1", name: "Profile acct-1", sid: "bs_test0000000000000001", status: "running", exit: "US · included IP" });
    expect(m.has("acct-1")).toBe(true);
    m.dispose();
  });

  it("names the exit as the profile's proxy without its credentials", async () => {
    const { m } = manager();
    await m.start(profile("p", { proxy: "http://user:secret@proxy.example:8080" }));
    expect(m.get("p")!.exit).toBe("http://proxy.example:8080");
    expect(JSON.stringify(onDisk())).not.toContain("secret");
    m.dispose();
  });

  it("refuses a second start of the same profile, and a profile open on this PC", async () => {
    const { m, fake } = manager({ runningLocally: (id) => id === "local" });
    await m.start(profile("acct-1"));
    expect(await m.start(profile("acct-1"))).toMatchObject({ ok: false, code: "ALREADY_RUNNING" });
    expect(await m.start(profile("local"))).toMatchObject({ ok: false, code: "RUNNING_LOCALLY" });
    expect(fake.calls.filter((c) => c === "create")).toHaveLength(1);
    m.dispose();
  });

  it("refuses a profile the cloud cannot run, before anything is created", async () => {
    const { m, fake } = manager();
    const r = await m.start(profile("p", { proxy: "https://proxy.example:443" }));
    expect(r).toMatchObject({ ok: false, code: "PROFILE", field: "proxy" });
    expect(fake.calls).toEqual([]);
    m.dispose();
  });

  it("says what to do when there is no API key", async () => {
    const { m } = manager({ api: { error: "", code: "NO_KEY" } });
    const r = await m.start(profile());
    expect(r).toEqual({ ok: false, error: "Add your Clearcote API key in Settings → Cloud to run profiles in the cloud.", code: "NO_KEY" });
    m.dispose();
  });

  it("passes the API's refusal through: balance, key, limits", async () => {
    const fake = new FakeApi();
    fake.fail.create = [{ status: 402, code: "INSUFFICIENT_BALANCE", error: "Your balance is too low." }];
    const { m } = manager({ api: fake });
    expect(await m.start(profile())).toEqual({ ok: false, error: "Your balance is too low.", code: "INSUFFICIENT_BALANCE", status: 402 });
    expect(m.list()).toEqual([]);
    m.dispose();
  });

  it("tries again when the service has no free browser, and then succeeds", async () => {
    const fake = new FakeApi();
    const busy = { status: 503, code: "NO_CAPACITY", error: "No hosted browser capacity right now. Retry in a few seconds." };
    fake.fail.create = [busy, busy];
    const waits: number[] = [];
    const { m } = manager({ api: fake, capacityRetryMs: [3000, 5000, 8000], sleep: async (ms) => void waits.push(ms) });
    const r = await m.start(profile());
    expect(r.ok).toBe(true);
    expect(waits).toEqual([3000, 5000]);
    expect(fake.calls.filter((c) => c === "create")).toHaveLength(3);
    m.dispose();
  });

  it("gives up after the last retry, with the service's message", async () => {
    const fake = new FakeApi();
    const busy = { status: 503, code: "NO_CAPACITY", error: "No hosted browser capacity right now. Retry in a few seconds." };
    fake.fail.create = [busy, busy, busy, busy, busy];
    const { m } = manager({ api: fake, sleep: async () => {} });
    expect(await m.start(profile())).toEqual({ ok: false, ...busy });
    expect(fake.calls.filter((c) => c === "create")).toHaveLength(4);
    m.dispose();
  });

  it("does not retry other refusals", async () => {
    const fake = new FakeApi();
    fake.fail.create = [{ status: 400, error: "country must be a 2-letter code like us" }];
    const { m } = manager({ api: fake, sleep: async () => { throw new Error("should not wait"); } });
    expect((await m.start(profile())).ok).toBe(false);
    expect(fake.calls).toEqual(["create"]);
    m.dispose();
  });

  it("ends a session that would not attach, so it does not hold a slot until it expires", async () => {
    const { m, fake, changes } = manager({ attach: async () => ({ ok: false, error: "409: Another client is attached.", status: 409 }) });
    const r = await m.start(profile());
    expect(r).toEqual({ ok: false, error: "The cloud browser did not start: 409: Another client is attached.", code: "ATTACH", status: 409 });
    expect(fake.calls).toEqual(["create", "stop bs_test0000000000000001"]);
    expect(m.list()).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
    expect(onDisk()).toEqual([]);
    m.dispose();
  });

  it("reports a session stopped while it was still starting as not started", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { m, ended } = manager({
      attach: async () => {
        await gate;
        return { ok: true };
      },
    });
    const starting = m.start(profile());
    await new Promise((r) => setTimeout(r, 5));
    expect(m.get("acct-1")!.status).toBe("starting");
    await m.stop("acct-1");
    release();
    expect(await starting).toEqual({ ok: false, error: "It was stopped before it finished starting.", code: "STOPPED" });
    expect(m.list()).toEqual([]);
    expect(ended).toEqual([expect.objectContaining({ reason: "stopped:user" })]);
    m.dispose();
  });

  it("follows a session stopped just as its browser came up, instead of calling it running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = new FakeApi();
    const { m } = manager({
      api: fake,
      attach: async (url) => {
        fake.activate(url.split("/").pop()!); // the worker claimed it...
        await gate; // ...but the reply is still on its way
        return { ok: true };
      },
    });
    const starting = m.start(profile());
    await new Promise((r) => setTimeout(r, 5));
    await m.stop("acct-1");
    release();
    expect(await starting).toMatchObject({ ok: false, code: "STOPPED" });
    expect(m.get("acct-1")!.status).toBe("stopping");
    fake.report("bs_test0000000000000001");
    await m.refresh();
    expect(m.list()).toEqual([]);
    m.dispose();
  });

  it("a failed attach only removes its own session", async () => {
    let fail!: () => void;
    const gate = new Promise<void>((r) => (fail = r));
    const fake = new FakeApi();
    let n = 0;
    const { m } = manager({
      api: fake,
      attach: async (url) => {
        if (++n === 1) {
          await gate;
          return { ok: false, error: "gone" };
        }
        fake.activate(url.split("/").pop()!);
        return { ok: true };
      },
    });
    const first = m.start(profile());
    await new Promise((r) => setTimeout(r, 5));
    await m.stop("acct-1"); // pending: ends at once
    expect((await m.start(profile())).ok).toBe(true); // started again meanwhile
    fail();
    expect(await first).toMatchObject({ ok: false, code: "STOPPED" });
    expect(m.get("acct-1")).toMatchObject({ sid: "bs_test0000000000000002", status: "running" });
    m.dispose();
  });
});

describe("following and stopping", () => {
  it("reads usage and cost on every poll", async () => {
    const { m, fake, changes } = manager();
    await m.start(profile());
    fake.use("bs_test0000000000000001", 2_100_000, 18, 0.0021);
    await m.refresh();
    expect(m.get("acct-1")).toMatchObject({ bytes: 2_100_000, seconds: 18, costEur: 0.0021 });
    expect(changes.at(-1)![0].costEur).toBe(0.0021);
    m.dispose();
  });

  it("notices a session the service ended, and says why", async () => {
    const { m, fake, ended } = manager();
    await m.start(profile());
    const s = fake.sessions.get("bs_test0000000000000001")!;
    fake.use(s.id, 5_000_000, 1800, 0.005);
    s.status = "ended";
    s.endReason = "idle_timeout";
    await m.refresh();
    expect(m.list()).toEqual([]);
    expect(ended).toEqual([
      { profileId: "acct-1", name: "Profile acct-1", sid: s.id, reason: "idle_timeout", status: "ended", bytes: 5_000_000, costEur: 0.005 },
    ]);
    expect(onDisk()).toEqual([]);
    m.dispose();
  });

  it("drops a session the service no longer knows", async () => {
    const { m, fake, ended } = manager();
    await m.start(profile());
    fake.sessions.clear();
    await m.refresh();
    expect(m.list()).toEqual([]);
    expect(ended[0]).toMatchObject({ profileId: "acct-1", reason: null });
    m.dispose();
  });

  it("keeps a session through a network hiccup or a server error", async () => {
    const fake = new FakeApi();
    const { m, ended } = manager({ api: fake });
    await m.start(profile());
    fake.fail.get = [{ status: 0, code: "NETWORK", error: "offline" }, { status: 502, error: "Bad Gateway" }];
    await m.refresh();
    await m.refresh();
    expect(m.list()).toHaveLength(1);
    expect(ended).toEqual([]);
    m.dispose();
  });

  it("does not poll a session that is still starting", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { m, fake } = manager({ attach: async () => (await gate, { ok: true }) });
    const starting = m.start(profile());
    await new Promise((r) => setTimeout(r, 5));
    await m.refresh();
    expect(fake.calls.filter((c) => c.startsWith("get"))).toEqual([]);
    release();
    await starting;
    m.dispose();
  });

  it("stops: DELETE, then “stopping” until the worker closed it, then the final usage", async () => {
    const { m, fake, ended } = manager();
    await m.start(profile());
    const sid = "bs_test0000000000000001";
    fake.use(sid, 20_360, 21, 0.000021);
    expect(await m.stop("acct-1")).toEqual({ ok: true });
    expect(fake.calls).toContain(`stop ${sid}`);
    // Still running on the worker, still billing and still holding its profile: not ended yet.
    expect(m.get("acct-1")).toMatchObject({ status: "stopping", costEur: 0.000021 });
    expect(ended).toEqual([]);
    expect(onDisk()).toHaveLength(1);
    await m.refresh();
    expect(ended).toEqual([]);
    fake.use(sid, 24_000, 23, 0.000025);
    fake.report(sid);
    await m.refresh();
    // The person's own stop, whatever reason the worker gave, with what it finally cost.
    expect(ended).toEqual([{ profileId: "acct-1", name: "Profile acct-1", sid, reason: "stopped:user", status: "ended", bytes: 24_000, costEur: 0.000025 }]);
    expect(m.list()).toEqual([]);
    expect(onDisk()).toEqual([]);
    m.dispose();
  });

  it("ends a session that never started at once when stopped", async () => {
    const fake = new FakeApi();
    const { m, ended } = manager({ api: fake, attach: async () => ({ ok: true }) }); // attached, but the service never saw it
    await m.start(profile());
    expect(await m.stop("acct-1")).toEqual({ ok: true });
    expect(ended).toEqual([expect.objectContaining({ reason: "stopped:user", status: "ended" })]);
    expect(m.list()).toEqual([]);
    m.dispose();
  });

  it("asks every 2 s while one is stopping, and back to the normal pace after", async () => {
    const { m, fake } = manager({ pollMs: 60_000, stopPollMs: 20 });
    await m.start(profile());
    await m.stop("acct-1");
    const gets = () => fake.calls.filter((c) => c.startsWith("get")).length;
    await new Promise((r) => setTimeout(r, 120));
    expect(gets()).toBeGreaterThanOrEqual(2);
    fake.report("bs_test0000000000000001");
    await new Promise((r) => setTimeout(r, 60));
    expect(m.list()).toEqual([]);
    const after = gets();
    await new Promise((r) => setTimeout(r, 80));
    expect(gets()).toBe(after);
    m.dispose();
  });

  it("refuses to start a profile again while it is still stopping", async () => {
    const { m, fake } = manager();
    await m.start(profile());
    await m.stop("acct-1");
    expect(await m.start(profile())).toEqual({ ok: false, error: "This profile is still stopping in the cloud. Start it again once it has stopped.", code: "STOPPING" });
    fake.report("bs_test0000000000000001");
    await m.refresh();
    expect((await m.start(profile())).ok).toBe(true);
    m.dispose();
  });

  it("notices a stop asked for elsewhere (the dashboard)", async () => {
    const { m, fake, ended } = manager();
    await m.start(profile());
    const sid = "bs_test0000000000000001";
    fake.sessions.get(sid)!.stopRequested = true;
    await m.refresh();
    expect(m.get("acct-1")!.status).toBe("stopping");
    fake.report(sid, "stopped:user");
    await m.refresh();
    expect(ended[0]).toMatchObject({ reason: "stopped:user" });
    m.dispose();
  });

  it("does not open the live view of a session that is stopping", async () => {
    const { m, fake } = manager();
    await m.start(profile());
    await m.stop("acct-1");
    expect(await m.viewUrl("acct-1")).toEqual({ ok: false, error: "Stopping…", ended: false });
    expect(fake.calls.some((c) => c.startsWith("live"))).toBe(false);
    m.dispose();
  });

  it("puts it back to running when the stop fails, and lets the person try again", async () => {
    const fake = new FakeApi();
    const { m } = manager({ api: fake });
    await m.start(profile());
    fake.fail.stop = [{ status: 0, code: "NETWORK", error: "Could not reach www.clearcotelabs.com." }];
    expect(await m.stop("acct-1")).toEqual({ ok: false, error: "Could not reach www.clearcotelabs.com." });
    expect(m.get("acct-1")!.status).toBe("running");
    expect(await m.stop("acct-1")).toEqual({ ok: true });
    expect(m.get("acct-1")!.status).toBe("stopping");
    // A second stop that fails (quitting while offline) leaves it stopping, not running.
    fake.fail.stop = [{ status: 502, error: "Bad Gateway" }];
    expect((await m.stop("acct-1")).ok).toBe(false);
    expect(m.get("acct-1")!.status).toBe("stopping");
    m.dispose();
  });

  it("treats a stop of a session that is already gone as done", async () => {
    const { m, fake } = manager();
    await m.start(profile());
    fake.sessions.clear();
    expect(await m.stop("acct-1")).toEqual({ ok: true });
    expect(m.list()).toEqual([]);
    expect(await m.stop("never-started")).toEqual({ ok: true });
    m.dispose();
  });

  it("stops everything when the app quits with “close browsers”", async () => {
    const { m, fake } = manager();
    await m.start(profile("a"));
    await m.start(profile("b"));
    await m.stopAll();
    expect(fake.calls.filter((c) => c.startsWith("stop"))).toHaveLength(2);
    expect([...fake.sessions.values()].every((s) => s.stopRequested)).toBe(true);
    expect(m.list().map((s) => s.status)).toEqual(["stopping", "stopping"]);
    m.dispose();
  });

  it("hands the viewer a control view URL, and says when the session is gone", async () => {
    const fake = new FakeApi();
    const { m } = manager({ api: fake });
    expect(await m.viewUrl("acct-1")).toEqual({ ok: false, error: "This profile is not running in the cloud.", ended: true });
    await m.start(profile());
    expect(await m.viewUrl("acct-1")).toEqual({ ok: true, viewUrl: "wss://browser.test/v/bs_test0000000000000001", interactive: true });
    expect(fake.calls).toContain("live bs_test0000000000000001 true");
    fake.fail.live = [{ status: 404, code: "NOT_FOUND", error: "No such session." }, { status: 503, error: "busy" }];
    expect(await m.viewUrl("acct-1")).toEqual({ ok: false, error: "No such session.", ended: true });
    expect(await m.viewUrl("acct-1")).toEqual({ ok: false, error: "busy", ended: false });
    m.dispose();
  });
});

describe("across a restart", () => {
  it("writes the running sessions to its file, without secrets or usage", async () => {
    const { m } = manager();
    await m.start(profile("a", { proxy: "socks5://u:pw@p.example:1080" }));
    const rows = onDisk();
    expect(rows).toEqual([{ profileId: "a", name: "Profile a", sid: "bs_test0000000000000001", startedAt: expect.any(String), exit: "socks5://p.example:1080" }]);
    m.dispose();
  });

  it("takes back the sessions still running and drops the ones that ended meanwhile", async () => {
    const first = manager();
    await first.m.start(profile("a"));
    await first.m.start(profile("b"));
    first.m.dispose();
    const fake = first.fake;
    fake.sessions.get("bs_test0000000000000002")!.status = "ended";
    fake.use("bs_test0000000000000001", 1000, 60, 0.001);

    const second = manager({ api: fake });
    await second.m.restore();
    expect(second.m.list().map((s) => [s.profileId, s.status, s.costEur])).toEqual([["a", "running", 0.001]]);
    expect(onDisk().map((r) => r.profileId)).toEqual(["a"]);
    second.m.dispose();
  });

  it("keeps a session it cannot check yet, instead of forgetting a browser that is still billing", async () => {
    const first = manager();
    await first.m.start(profile("a"));
    first.m.dispose();
    const fake = first.fake;
    fake.fail.get = [{ status: 0, code: "NETWORK", error: "offline" }];
    const second = manager({ api: fake });
    await second.m.restore();
    expect(second.m.list().map((s) => [s.profileId, s.status])).toEqual([["a", "running"]]);
    expect(onDisk().map((r) => r.profileId)).toEqual(["a"]);
    // Back online: the next poll reads it normally.
    fake.use("bs_test0000000000000001", 4096, 30, 0.0001);
    await second.m.refresh();
    expect(second.m.get("a")).toMatchObject({ bytes: 4096, seconds: 30 });
    second.m.dispose();
  });

  it("drops a session the service no longer knows, and a row with a broken id", async () => {
    fs.writeFileSync(
      file,
      JSON.stringify([
        { profileId: "gone", sid: "bs_gone000000000000000000" },
        { profileId: "bad", sid: "../../etc" },
      ]),
    );
    const { m, fake } = manager();
    await m.restore();
    expect(m.list()).toEqual([]);
    expect(onDisk()).toEqual([]);
    expect(fake.calls).toEqual(["get bs_gone000000000000000000", "get ../../etc"]);
    m.dispose();
  });

  it("brings back a session someone already asked to stop as stopping", async () => {
    const first = manager();
    await first.m.start(profile("a"));
    first.fake.sessions.get("bs_test0000000000000001")!.stopRequested = true;
    first.m.dispose();
    const second = manager({ api: first.fake });
    await second.m.restore();
    expect(second.m.get("a")!.status).toBe("stopping");
    second.m.dispose();
  });

  it("leaves the file alone when there is no key to check it with", async () => {
    const first = manager();
    await first.m.start(profile("a"));
    first.m.dispose();
    const second = manager({ api: { error: "", code: "NO_KEY" } });
    await second.m.restore();
    expect(second.m.list()).toEqual([]);
    expect(onDisk()).toHaveLength(1);
    second.m.dispose();
  });

  it("ignores a missing, broken or hand-edited file", async () => {
    const a = manager();
    await a.m.restore();
    expect(a.m.list()).toEqual([]);
    fs.writeFileSync(file, "{not json");
    await a.m.restore();
    fs.writeFileSync(file, JSON.stringify([{ profileId: 7, sid: "x" }, "junk", null, { profileId: "p" }]));
    await a.m.restore();
    expect(a.m.list()).toEqual([]);
    a.m.dispose();
  });

  it("polls on its own while sessions run, and stops polling when none do", async () => {
    const { m, fake } = manager({ pollMs: 20, stopPollMs: 20 });
    await m.start(profile());
    await new Promise((r) => setTimeout(r, 120));
    const polls = fake.calls.filter((c) => c.startsWith("get")).length;
    expect(polls).toBeGreaterThanOrEqual(2);
    await m.stop("acct-1");
    fake.report("bs_test0000000000000001");
    await new Promise((r) => setTimeout(r, 60));
    expect(m.list()).toEqual([]);
    const after = fake.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls.length).toBe(after);
    m.dispose();
  });
});
