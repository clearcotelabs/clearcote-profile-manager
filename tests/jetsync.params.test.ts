// electron/jetsync.ts — a run's own values (params), secret ones included, and the saved task a run came from.
// Workers are fakes speaking the worker protocol over real streams (same helpers as tests/jetsync.test.ts).

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SyncManager, withRunParams, type SyncDeps, type SyncRun, type WorkerProc } from "../electron/jetsync";
import type { Profile, Settings } from "../electron/types";
type Line = Record<string, unknown>;

/** A worker whose behaviour a test scripts: it sees every line the manager writes. */
class FakeWorker extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  got: Line[] = [];
  killed = false;
  constructor(public onLine: (w: FakeWorker, msg: Line) => void) {
    super();
    let buf = "";
    this.stdin.on("data", (d: Buffer) => {
      buf += String(d);
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        this.got.push(msg);
        this.onLine(this, msg);
      }
    });
  }
  out(ev: Line) {
    this.stdout.write(JSON.stringify(ev) + "\n");
  }
  exit(code = 0) {
    this.stdout.end();
    this.emit("exit", code);
  }
  finish(result: Line) {
    this.out({ type: "result", ...result });
    this.exit(0);
  }
  kill() {
    this.killed = true;
    this.exit(1);
  }
}

const P = (id: string, over: Partial<Profile> = {}): Profile =>
  ({ id, name: `Name ${id}`, fingerprint: "1", createdAt: "", updatedAt: "", ...over }) as Profile;

interface Harness {
  deps: SyncDeps;
  mgr: SyncManager;
  workers: FakeWorker[];
  launched: string[];
  stopped: string[];
  sleeps: number[];
  spawned: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[];
  profiles: Map<string, Profile>;
  running: Map<string, string | undefined>;
}

function harness(opts: {
  profiles?: Profile[];
  script?: (w: FakeWorker, msg: Line) => void;
  settings?: Settings;
  running?: Record<string, string | undefined>;
  cloud?: string[];
  launchFails?: string;
  spawnError?: Error;
} = {}): Harness {
  const h = {} as Harness;
  h.workers = [];
  h.launched = [];
  h.stopped = [];
  h.sleeps = [];
  h.spawned = [];
  h.profiles = new Map((opts.profiles ?? [P("a"), P("b"), P("c")]).map((p) => [p.id, p]));
  h.running = new Map(Object.entries(opts.running ?? {}));
  const script = opts.script ?? ((w, msg) => msg.cmd === "run" && w.finish({ status: "done", skill: { used: "replayed" }, usage: { estimated_usd: 0 } }));
  let port = 9000;
  h.deps = {
    getProfile: (id) => h.profiles.get(id) ?? null,
    launch: async (p) => {
      h.launched.push(p.id);
      if (opts.launchFails) return { ok: false, error: opts.launchFails };
      const cdp = `http://127.0.0.1:${++port}`;
      h.running.set(p.id, cdp);
      return { ok: true, cdp };
    },
    stop: async (id) => {
      h.stopped.push(id);
      h.running.delete(id);
    },
    isRunning: (id) => h.running.has(id),
    cdpEndpoint: (id) => h.running.get(id),
    inCloud: (id) => (opts.cloud ?? []).includes(id),
    settings: () => opts.settings ?? {},
    spawnWorker: (cmd, args, env) => {
      if (opts.spawnError) throw opts.spawnError;
      h.spawned.push({ cmd, args, env });
      const w = new FakeWorker(script);
      h.workers.push(w);
      return w as unknown as WorkerProc;
    },
    random: () => 0.5,
    sleep: async (ms) => {
      h.sleeps.push(ms);
    },
  };
  h.mgr = new SyncManager(h.deps);
  return h;
}

/** Resolves when the run with that id has finished. */
function finished(mgr: SyncManager, runId: string): Promise<SyncRun> {
  return new Promise((resolve) => {
    const check = (runs: SyncRun[]) => {
      const r = runs.find((x) => x.id === runId);
      if (r?.state === "finished") {
        mgr.off("changed", check);
        resolve(r);
      }
    };
    mgr.on("changed", check);
    check(mgr.list());
  });
}

function until(mgr: SyncManager, pred: (runs: SyncRun[]) => boolean): Promise<SyncRun[]> {
  return new Promise((resolve) => {
    const check = (runs: SyncRun[]) => {
      if (pred(runs)) {
        mgr.off("changed", check);
        resolve(runs);
      }
    };
    mgr.on("changed", check);
    check(mgr.list());
  });
}

const startOk = (h: Harness, req: Parameters<SyncManager["start"]>[0]) => {
  const r = h.mgr.start(req);
  if (!r.ok) throw new Error(r.error);
  return r.runId;
};

describe("withRunParams", () => {
  it("returns the profile as is without params", () => {
    const p = P("a", { vars: [{ key: "q", value: "x" }] });
    expect(withRunParams(p, undefined, new Set())).toBe(p);
    expect(withRunParams(p, {}, new Set())).toBe(p);
  });

  it("overrides a profile var of the same key and adds new ones with the secret flag", () => {
    const p = P("a", { vars: [{ key: "q", value: "own" }, { key: "email", value: "a@x.io" }] });
    const out = withRunParams(p, { q: "run value", pw: "s3cret" }, new Set(["pw"]));
    expect(out.vars).toEqual([
      { key: "email", value: "a@x.io" },
      { key: "q", value: "run value" },
      { key: "pw", value: "s3cret", secret: true },
    ]);
    expect(p.vars).toEqual([{ key: "q", value: "own" }, { key: "email", value: "a@x.io" }]); // not mutated
  });

  it("works on a profile with no vars", () => {
    expect(withRunParams(P("a"), { q: "v" }, new Set()).vars).toEqual([{ key: "q", value: "v" }]);
  });
});

describe("start() with params", () => {
  it("sends run values (secret too) to the worker but list() shows only the non-secret ones", async () => {
    const h = harness({ profiles: [P("a", { vars: [{ key: "query", value: "profile own" }] })] });
    const id = startOk(h, {
      profileIds: ["a"],
      goal: "search {{query}} and log in with {{pw}}",
      params: { query: "red shoes", pw: "hunter2!" },
      paramSecret: ["pw"],
    });
    expect(JSON.stringify(h.mgr.list())).not.toContain("hunter2!");
    expect(h.mgr.list()[0].params).toEqual({ query: "red shoes" });
    const run = await finished(h.mgr, id);
    expect(run.rows[0].status).toBe("done");
    expect(h.workers[0].got[0]).toMatchObject({ cmd: "run", values: { query: "red shoes", pw: "hunter2!" }, secret: ["pw"] });
    const listed = JSON.stringify(h.mgr.list());
    expect(listed).not.toContain("hunter2!");
    expect(listed).not.toContain("profile own");
    expect(run.params).toEqual({ query: "red shoes" });
  });

  it("a step keeps the typed text for the board and a {{slot}} template for a saved task", async () => {
    const h = harness({
      profiles: [P("a", { vars: [{ key: "email", value: "ana@example.com" }, { key: "pw", value: "hunter2!", secret: true }] })],
      script: (w, msg) => {
        if (msg.cmd !== "run") return;
        w.out({ type: "step", kind: "fill", action: "Email", text: "ana@example.com", probability: 1 });
        w.out({ type: "step", kind: "fill", action: "Password", text: "hunter2!", probability: 1 });
        w.out({ type: "step", kind: "click", action: "Sign in", text: null, probability: 1 });
        w.finish({ status: "done", skill: { used: "learned" }, usage: { estimated_usd: 0 } });
      },
    });
    const id = startOk(h, { profileIds: ["a"], goal: "log in as {{email}} with {{pw}}" });
    const run = await finished(h.mgr, id);
    const [email, pw, click] = run.rows[0].steps;
    expect(email).toMatchObject({ text: "ana@example.com", template: "{{email}}" });
    expect(pw).toMatchObject({ text: "{{pw}}" });
    expect(pw.template).toBeUndefined();
    expect(click.template).toBeUndefined();
  });

  it("only secret params: no params on the run at all", async () => {
    const h = harness({ profiles: [P("a")] });
    const id = startOk(h, { profileIds: ["a"], goal: "log in with {{pw}}", params: { pw: "hunter2!" }, paramSecret: ["pw"] });
    const run = await finished(h.mgr, id);
    expect(run.params).toBeUndefined();
    expect(h.workers[0].got[0]).toMatchObject({ values: { pw: "hunter2!" }, secret: ["pw"] });
    expect(JSON.stringify(h.mgr.list())).not.toContain("hunter2!");
  });

  it("a profile lacking {{query}} that the run provides is not needs_input", async () => {
    const h = harness({ profiles: [P("a"), P("b", { vars: [{ key: "other", value: "1" }] })] });
    const id = startOk(h, { profileIds: ["a", "b"], goal: "search {{query}}", params: { query: "boots" } });
    const run = await finished(h.mgr, id);
    expect(run.rows.map((r) => r.status)).toEqual(["done", "done"]);
    expect(h.workers.map((w) => (w.got[0] as { values: Record<string, string> }).values)).toEqual([{ query: "boots" }, { query: "boots" }]);
  });

  it("without the param the same profile is needs_input", async () => {
    const h = harness({ profiles: [P("a")] });
    const run = await finished(h.mgr, startOk(h, { profileIds: ["a"], goal: "search {{query}}" }));
    expect(run.rows[0].status).toBe("needs_input");
    expect(h.workers).toHaveLength(0);
  });

  it("carries taskId and emits finished once with the finished run", async () => {
    const h = harness({ profiles: [P("a"), P("b")] });
    const got: SyncRun[] = [];
    h.mgr.on("finished", (r: SyncRun) => got.push(r));
    const id = startOk(h, { profileIds: ["a", "b"], goal: "do it", taskId: "task-123", params: { q: "v" } });
    expect(h.mgr.list()[0].taskId).toBe("task-123");
    await finished(h.mgr, id);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id, taskId: "task-123", state: "finished", params: { q: "v" } });
    expect(got[0].rows.map((r) => r.status)).toEqual(["done", "done"]);
  });
});
