// electron/jetsync.ts — running one task on many profiles through Jet workers. The workers are fakes that
// speak the worker protocol over real streams, so what is pinned is the manager's side of it:
//   - who gets launched (with automation), who is refused and why, and what each worker is sent
//   - concurrency and the random gap between starts
//   - approve / cancel / stop reach the right worker, and a row's status follows the worker's events
//   - secret values never reach anything the board shows
//   - a worker that dies, or a Jet that is not installed, ends the row with a reason

import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  SyncManager,
  parseCommandLine,
  workerCommand,
  clampConcurrency,
  clampStagger,
  rowStatusFor,
  type SyncDeps,
  type SyncRun,
  type WorkerProc,
} from "../electron/jetsync";
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

describe("helpers", () => {
  it("splits a command line, keeping quoted paths whole", () => {
    expect(parseCommandLine("clearcote-jet")).toEqual(["clearcote-jet"]);
    expect(parseCommandLine('"C:\\Program Files\\Python312\\python.exe" -m clearcote_jet.cli')).toEqual([
      "C:\\Program Files\\Python312\\python.exe",
      "-m",
      "clearcote_jet.cli",
    ]);
    expect(parseCommandLine("  py   -3  ")).toEqual(["py", "-3"]);
    expect(parseCommandLine("a '' b")).toEqual(["a", "", "b"]);
  });

  it("starts the worker subcommand, from PATH unless a command is set", () => {
    expect(workerCommand({})).toEqual(["clearcote-jet", ["worker"]]);
    expect(workerCommand({ jetCommand: "  " })).toEqual(["clearcote-jet", ["worker"]]);
    expect(workerCommand({ jetCommand: "python -m clearcote_jet.cli" })).toEqual(["python", ["-m", "clearcote_jet.cli", "worker"]]);
  });

  it("keeps concurrency and the stagger in range", () => {
    expect(clampConcurrency(undefined)).toBe(2);
    expect(clampConcurrency(0)).toBe(1);
    expect(clampConcurrency(99)).toBe(10);
    expect(clampConcurrency("3")).toBe(3);
    expect(clampStagger([20, 5])).toEqual([5, 20]);
    expect(clampStagger([-1, 9999])).toEqual([0, 600]);
    expect(clampStagger("x")).toEqual([3, 20]);
  });

  it("maps Jet's result statuses, and anything unknown is a failure", () => {
    for (const s of ["done", "blocked", "needs_input", "budget", "cancelled", "stopped"]) expect(rowStatusFor(s)).toBe(s);
    expect(rowStatusFor("error")).toBe("failed");
    expect(rowStatusFor("diverged")).toBe("failed");
    expect(rowStatusFor(undefined)).toBe("failed");
  });
});

describe("start() refuses what cannot run", () => {
  it("an empty task, a non-web start page, no profiles, an unknown profile", () => {
    const h = harness();
    expect(h.mgr.start({ profileIds: ["a"], goal: "  " })).toMatchObject({ ok: false, error: /what the task is/ });
    expect(h.mgr.start({ profileIds: ["a"], goal: "x", url: "file:///c:/x" })).toMatchObject({ ok: false, error: /http or https/ });
    expect(h.mgr.start({ profileIds: ["a"], goal: "x", url: "javascript:alert(1)" })).toMatchObject({ ok: false });
    expect(h.mgr.start({ profileIds: [], goal: "x" })).toMatchObject({ ok: false, error: /Select at least one/ });
    expect(h.mgr.start({ profileIds: ["zzz"], goal: "x" })).toMatchObject({ ok: false, error: /no longer exists/ });
    expect(h.mgr.list()).toEqual([]);
  });

  it("a profile already running a task", async () => {
    const h = harness({ script: () => {} }); // never finishes
    startOk(h, { profileIds: ["a"], goal: "x" });
    await until(h.mgr, (r) => r[0].rows[0].status === "running");
    expect(h.mgr.start({ profileIds: ["b", "a"], goal: "y" })).toMatchObject({ ok: false, error: /already running a task/ });
  });
});

describe("a run", () => {
  it("launches each profile with automation, attaches a worker and sends it the task", async () => {
    const h = harness({ settings: { jetApiKey: " tsk_123 " } });
    const id = startOk(h, { profileIds: ["a", "b"], goal: "Log in as {{ name }}", url: "https://example.com/login", confirm: true });
    const run = await finished(h.mgr, id);
    expect(run.rows.map((r) => r.status)).toEqual(["done", "done"]);
    expect(h.launched).toEqual(["a", "b"]);
    expect(h.spawned[0]).toMatchObject({ cmd: "clearcote-jet", args: ["worker"] });
    expect(h.spawned[0].env.TYPESAFE_API_KEY).toBe("tsk_123");
    const first = h.workers[0].got[0];
    expect(first).toMatchObject({
      cmd: "run",
      cdp: "http://127.0.0.1:9001",
      url: "https://example.com/login",
      goal: "Log in as {{name}}", // one spelling of a slot, so Jet learns one skill
      values: { name: "Name a" },
      secret: [],
      confirm: true,
      reuse: true,
    });
    expect(h.workers[1].got[0]).toMatchObject({ cdp: "http://127.0.0.1:9002", values: { name: "Name b" } });
    expect(run.rows[0].skill).toBe("replayed");
  });

  it("uses a browser that is already open with automation, without launching it", async () => {
    const h = harness({ running: { a: "http://127.0.0.1:7777" } });
    const run = await finished(h.mgr, startOk(h, { profileIds: ["a"], goal: "x" }));
    expect(run.rows[0].status).toBe("done");
    expect(h.launched).toEqual([]);
    expect(h.workers[0].got[0].cdp).toBe("http://127.0.0.1:7777");
  });

  it("refuses a browser that was opened without automation, and one in the cloud", async () => {
    const h = harness({ running: { a: undefined }, cloud: ["b"] });
    const run = await finished(h.mgr, startOk(h, { profileIds: ["a", "b"], goal: "x" }));
    expect(run.rows[0]).toMatchObject({ status: "failed", detail: expect.stringMatching(/opened without automation/) });
    expect(run.rows[1]).toMatchObject({ status: "failed", detail: expect.stringMatching(/running in the cloud/) });
    expect(h.launched).toEqual([]);
    expect(h.workers).toHaveLength(0);
  });

  it("a profile missing a value ends as needs_input before anything starts", async () => {
    const h = harness({ profiles: [P("a", { vars: [{ key: "email", value: "a@x.io" }] }), P("b")] });
    const run = await finished(h.mgr, startOk(h, { profileIds: ["a", "b"], goal: "Sign in as {{email}}" }));
    expect(run.rows[0].status).toBe("done");
    expect(run.rows[1]).toMatchObject({ status: "needs_input", detail: expect.stringMatching(/\{\{email\}\}/) });
    expect(h.launched).toEqual(["a"]);
  });

  it("a launch that fails ends the row with the launcher's reason", async () => {
    const h = harness({ launchFails: "Concurrency limit reached (1/1 in use)." });
    const run = await finished(h.mgr, startOk(h, { profileIds: ["a"], goal: "x" }));
    expect(run.rows[0]).toMatchObject({ status: "failed", detail: "Concurrency limit reached (1/1 in use)." });
  });

  it("runs at most `concurrency` at once and waits a random gap before each later start", async () => {
    let live = 0;
    let peak = 0;
    const h = harness({
      profiles: [P("a"), P("b"), P("c"), P("d")],
      script: (w, msg) => {
        if (msg.cmd !== "run") return;
        live++;
        peak = Math.max(peak, live);
        setTimeout(() => {
          live--;
          w.finish({ status: "done" });
        }, 20);
      },
    });
    const run = await finished(h.mgr, startOk(h, { profileIds: ["a", "b", "c", "d"], goal: "x", concurrency: 2, staggerSec: [2, 10] }));
    expect(run.rows.every((r) => r.status === "done")).toBe(true);
    expect(peak).toBe(2);
    // the first start is immediate; each later one waits min + (max-min)*random = 2 + 8*0.5 = 6 s
    expect(h.sleeps).toEqual([6000, 6000, 6000]);
  });

  it("closes only the browsers it opened when asked to", async () => {
    const h = harness({ running: { a: "http://127.0.0.1:7777" } });
    await finished(h.mgr, startOk(h, { profileIds: ["a", "b"], goal: "x", closeWhenDone: true }));
    expect(h.stopped).toEqual(["b"]);
  });

  it("follows steps and the result: the board shows them, secrets masked", async () => {
    const h = harness({
      profiles: [P("a", { vars: [{ key: "email", value: "ana@x.io" }, { key: "pw", value: "hunter2!", secret: true }] })],
      script: (w, msg) => {
        if (msg.cmd !== "run") return;
        w.out({ type: "ready", version: "0.3.0" });
        w.out({ type: "step", kind: "type", action: "Email", text: "ana@x.io", probability: 0.98, at_ms: 120 });
        w.out({ type: "step", kind: "type", action: "Password", text: "hunter2!", replayed: true, at_ms: 300 });
        w.out({ type: "step", kind: "click", action: "Sign in as hunter2!", led_to: "https://x.io/home" });
        w.finish({ status: "done", detail: "typed hunter2! ok", url: "https://x.io/home", skill: { used: "learned" }, usage: { estimated_usd: 0.0008 } });
      },
    });
    const run = await finished(h.mgr, startOk(h, { profileIds: ["a"], goal: "Log in as {{email}} with {{pw}}" }));
    const row = run.rows[0];
    expect(h.workers[0].got[0]).toMatchObject({ values: { email: "ana@x.io", pw: "hunter2!" }, secret: ["pw"] });
    expect(row.steps.map((s) => s.text)).toEqual(["ana@x.io", "{{pw}}", null]);
    expect(row.steps[2].action).toBe("Sign in as {{pw}}");
    expect(row.steps[1].replayed).toBe(true);
    expect(row).toMatchObject({ status: "done", skill: "learned", usd: 0.0008, url: "https://x.io/home", detail: "typed {{pw}} ok" });
    expect(JSON.stringify(h.mgr.list())).not.toContain("hunter2!");
  });

  it("a worker that exits without a result fails the row with its last output", async () => {
    const h = harness({
      script: (w, msg) => {
        if (msg.cmd !== "run") return;
        w.stderr.write("Traceback...\nModuleNotFoundError: No module named 'mcp'\n");
        setTimeout(() => w.exit(1), 5);
      },
    });
    const run = await finished(h.mgr, startOk(h, { profileIds: ["a"], goal: "x" }));
    expect(run.rows[0].status).toBe("failed");
    expect(run.rows[0].detail).toMatch(/exit code 1/);
    expect(run.rows[0].detail).toMatch(/No module named 'mcp'/);
  });

  it("a Jet without the worker command (before 0.3.0) says to update it", async () => {
    const h = harness({
      script: (w, msg) => {
        if (msg.cmd !== "run") return;
        w.stderr.write("usage: clearcote-jet [-h] {browser,run,read} ...\nclearcote-jet: error: argument command: invalid choice: 'worker' (choose from browser, run, read)\n");
        setTimeout(() => w.exit(2), 5);
      },
    });
    const run = await finished(h.mgr, startOk(h, { profileIds: ["a"], goal: "x" }));
    expect(run.rows[0]).toMatchObject({ status: "failed", detail: expect.stringMatching(/too old.*0\.3\.0.*pip install -U clearcote-jet/) });
  });

  it("a worker error event fails the row", async () => {
    const h = harness({ script: (w, m) => m.cmd === "run" && (w.out({ type: "error", message: "Could not attach to the browser" }), w.exit(1)) });
    const run = await finished(h.mgr, startOk(h, { profileIds: ["a"], goal: "x" }));
    expect(run.rows[0]).toMatchObject({ status: "failed", detail: "Could not attach to the browser" });
  });

  it("Jet not installed says how to install it", async () => {
    const e = Object.assign(new Error("spawn clearcote-jet ENOENT"), { code: "ENOENT" });
    const h = harness({ spawnError: e });
    const run = await finished(h.mgr, startOk(h, { profileIds: ["a"], goal: "x" }));
    expect(run.rows[0]).toMatchObject({ status: "failed", detail: expect.stringMatching(/pip install clearcote-jet/) });
  });
});

describe("approvals and stopping", () => {
  // A worker that stops before "Place order" and then does what it is told.
  const confirming = (w: FakeWorker, msg: Line) => {
    if (msg.cmd === "run") {
      w.out({ type: "needs_confirmation", pending: { kind: "click", label: "Place order", role: "button" }, detail: "stopped before Place order" });
    } else if (msg.cmd === "approve") {
      w.out({ type: "step", kind: "click", action: "Place order" });
      w.finish({ status: "done" });
    } else if (msg.cmd === "cancel") {
      w.finish({ status: "cancelled" });
    } else if (msg.cmd === "stop") {
      w.finish({ status: "stopped" });
    }
  };

  it("a row waits for approval; approving one sends approve to that worker only", async () => {
    const h = harness({ script: confirming });
    const id = startOk(h, { profileIds: ["a", "b"], goal: "Buy it", concurrency: 2 });
    await until(h.mgr, (r) => r[0].rows.every((x) => x.status === "waiting_approval"));
    expect(h.mgr.list()[0].rows[0].pending).toEqual({ kind: "click", label: "Place order", role: "button" });
    expect(h.mgr.approve(id, "a")).toBe(1);
    await until(h.mgr, (r) => r[0].rows[0].status === "done");
    expect(h.workers[0].got.map((m) => m.cmd)).toEqual(["run", "approve"]);
    expect(h.workers[1].got.map((m) => m.cmd)).toEqual(["run"]);
    expect(h.mgr.list()[0].rows[1].status).toBe("waiting_approval");
    expect(h.mgr.cancel(id, "b")).toBe(1);
    const run = await finished(h.mgr, id);
    expect(run.rows.map((r) => r.status)).toEqual(["done", "cancelled"]);
  });

  it("approve without a profile approves every waiting row", async () => {
    const h = harness({ script: confirming });
    const id = startOk(h, { profileIds: ["a", "b", "c"], goal: "Buy it", concurrency: 3 });
    await until(h.mgr, (r) => r[0].rows.every((x) => x.status === "waiting_approval"));
    expect(h.mgr.approve(id)).toBe(3);
    const run = await finished(h.mgr, id);
    expect(run.rows.map((r) => r.status)).toEqual(["done", "done", "done"]);
  });

  it("approve does nothing to a row that is not waiting", async () => {
    const h = harness({ script: () => {} });
    const id = startOk(h, { profileIds: ["a"], goal: "x" });
    await until(h.mgr, (r) => r[0].rows[0].status === "running");
    expect(h.mgr.approve(id, "a")).toBe(0);
    expect(h.workers[0].got.map((m) => m.cmd)).toEqual(["run"]);
  });

  it("stopping a run stops running workers and never starts the queued ones", async () => {
    const h = harness({ script: confirming, profiles: [P("a"), P("b"), P("c")] });
    const id = startOk(h, { profileIds: ["a", "b", "c"], goal: "Buy it", concurrency: 1 });
    await until(h.mgr, (r) => r[0].rows[0].status === "waiting_approval");
    h.mgr.stop(id);
    const run = await finished(h.mgr, id);
    expect(run.rows.map((r) => r.status)).toEqual(["stopped", "stopped", "stopped"]);
    expect(h.workers).toHaveLength(1);
    expect(h.workers[0].got.map((m) => m.cmd)).toEqual(["run", "stop"]);
    expect(h.launched).toEqual(["a"]);
  });

  it("a worker that is stopped and exits without a result counts as stopped, not failed", async () => {
    const h = harness({ script: (w, m) => m.cmd === "stop" && w.exit(0) });
    const id = startOk(h, { profileIds: ["a"], goal: "x" });
    await until(h.mgr, (r) => r[0].rows[0].status === "running");
    h.mgr.stop(id, "a");
    const run = await finished(h.mgr, id);
    expect(run.rows[0].status).toBe("stopped");
  });

  it("shutdown stops everything", async () => {
    const h = harness({ script: () => {} });
    const id = startOk(h, { profileIds: ["a", "b"], goal: "x", concurrency: 1 });
    await until(h.mgr, (r) => r[0].rows[0].status === "running");
    await h.mgr.shutdown();
    const run = await finished(h.mgr, id);
    expect(run.rows.map((r) => r.status)).toEqual(["stopped", "stopped"]);
    expect(h.workers[0].killed).toBe(true);
  });
});

describe("the run list", () => {
  it("keeps the newest runs, and Clear forgets finished ones", async () => {
    const h = harness();
    for (let i = 0; i < 7; i++) await finished(h.mgr, startOk(h, { profileIds: ["a"], goal: `task ${i}` }));
    const goals = h.mgr.list().map((r) => r.goal);
    expect(goals.length).toBeLessThanOrEqual(6);
    expect(goals[0]).toBe("task 6");
    h.mgr.clearFinished();
    expect(h.mgr.list()).toEqual([]);
  });

  it("list() hands out copies the caller cannot change", async () => {
    const h = harness();
    await finished(h.mgr, startOk(h, { profileIds: ["a"], goal: "x" }));
    const copy = h.mgr.list();
    copy[0].rows[0].status = "failed";
    copy[0].rows[0].steps.push({ kind: "x", action: "y" });
    expect(h.mgr.list()[0].rows[0].status).toBe("done");
    expect(h.mgr.list()[0].rows[0].steps).toHaveLength(0);
  });
});

beforeEach(() => {});
