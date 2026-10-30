// Regression tests for the review of 0.32.0: secrets that slipped through (a slot the task marks secret on a
// profile that does not, a run value replacing a profile's secret one, URLs and encoded forms, history kept
// after a value turned secret), saved steps garbled by short values, a probe that rejected instead of
// answering, a path with ' quoted wrong, and an unreadable tasks.json overwritten by the next save.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SyncManager, templateText, withRunParams, type SyncDeps, type SyncRun, type WorkerProc } from "../electron/jetsync";
import { looksSecret, maskSecrets } from "../electron/jetslots";
import { execFile, quote } from "../electron/jetsetup";
import { parseCommandLine } from "../electron/jetsync";
import { readTasks, recordRun, saveTask } from "../electron/tasks";
import type { Profile } from "../electron/types";

type Line = Record<string, unknown>;

class FakeWorker extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  got: Line[] = [];
  constructor(onLine: (w: FakeWorker, msg: Line) => void) {
    super();
    let buf = "";
    this.stdin.on("data", (d: Buffer) => {
      buf += String(d);
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        this.got.push(msg);
        onLine(this, msg);
      }
    });
  }
  out(ev: Line) {
    this.stdout.write(JSON.stringify(ev) + "\n");
  }
  kill() {
    this.stdout.end();
    this.emit("exit", 1);
  }
}

const P = (id: string, over: Partial<Profile> = {}): Profile => ({ id, name: `Name ${id}`, fingerprint: "1", createdAt: "", updatedAt: "", ...over }) as Profile;

function manager(profiles: Profile[], script: (w: FakeWorker, msg: Line) => void) {
  const workers: FakeWorker[] = [];
  const map = new Map(profiles.map((p) => [p.id, p]));
  const deps: SyncDeps = {
    getProfile: (id) => map.get(id) ?? null,
    launch: async () => ({ ok: true, cdp: "http://127.0.0.1:9" }),
    stop: async () => undefined,
    isRunning: () => false,
    cdpEndpoint: () => undefined,
    inCloud: () => false,
    settings: () => ({}),
    spawnWorker: () => {
      const w = new FakeWorker(script);
      workers.push(w);
      return w as unknown as WorkerProc;
    },
    random: () => 0,
    sleep: async () => undefined,
  };
  return { mgr: new SyncManager(deps), workers };
}
const finished = (mgr: SyncManager, id: string) =>
  new Promise<SyncRun>((resolve) => mgr.on("finished", (r: SyncRun) => r.id === id && resolve(r)));

/** A worker that types the request's values back as steps, visits a URL with the password, and finishes. */
const echo = (w: FakeWorker, msg: Line) => {
  if (msg.cmd !== "run") return;
  const values = msg.values as Record<string, string>;
  for (const v of Object.values(values)) w.out({ type: "step", kind: "fill", action: "Field", text: v, probability: 1 });
  const pw = values.password ?? values.login ?? "";
  w.out({ type: "step", kind: "click", action: "Go", text: null, probability: 1, led_to: `https://x.example/?pw=${encodeURIComponent(pw)}` });
  w.out({ type: "result", status: "done", skill: { used: "learned" }, usage: { estimated_usd: 0 } });
  w.stdout.end();
  w.emit("exit", 0);
};

describe("secrets", () => {
  it("a slot the task marks secret is secret on a profile that does not mark it", async () => {
    const { mgr, workers } = manager([P("a", { vars: [{ key: "password", value: "p@ss w0rd" }] })], echo);
    const r = mgr.start({ profileIds: ["a"], goal: "log in with {{password}}", secretSlots: ["password"] });
    if (!r.ok) throw new Error(r.error);
    const run = await finished(mgr, r.runId);
    expect(workers[0].got[0]).toMatchObject({ secret: ["password"] });
    const shown = JSON.stringify(mgr.list());
    expect(shown).not.toContain("p@ss w0rd");
    expect(shown).not.toContain(encodeURIComponent("p@ss w0rd"));
    expect(run.rows[0].url).toBe("https://x.example/?pw={{password}}");
  });

  it("a run value for a slot a profile keeps secret stays secret and is not shown as a run value", async () => {
    const { mgr } = manager([P("a", { vars: [{ key: "login", value: "old", secret: true }] })], echo);
    const r = mgr.start({ profileIds: ["a"], goal: "use {{login}}", params: { login: "new-secret" } });
    if (!r.ok) throw new Error(r.error);
    const run = await finished(mgr, r.runId);
    expect(run.params).toBeUndefined();
    expect(run.secretParams).toEqual(["login"]);
    expect(JSON.stringify(mgr.list())).not.toContain("new-secret");
    expect(withRunParams(P("a", { vars: [{ key: "login", value: "x", secret: true }] }), { login: "y" }, new Set()).vars).toEqual([{ key: "login", value: "y", secret: true }]);
  });

  it("maskSecrets also masks a value as a URL or a form carries it", () => {
    const v = { pw: "p@ss w" };
    expect(maskSecrets("a=p%40ss%20w&b=p%40ss+w&c=p@ss w", v, ["pw"])).toBe("a={{pw}}&b={{pw}}&c={{pw}}");
  });

  it("a history value is dropped once its slot is secret", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-fixes-"));
    try {
      const file = path.join(dir, "tasks.json");
      saveTask(file, { id: "t", goal: "use {{apikey}}", params: [{ name: "apikey", source: "run" }] });
      recordRun(file, "t", { at: 1, total: 1, done: 1, params: { apikey: "sk-live-123", q: "shoes" } });
      saveTask(file, { id: "t", goal: "use {{apikey}}", params: [{ name: "apikey", source: "run", secret: true }] });
      expect(readTasks(file)[0].history[0].params).toEqual({ q: "shoes" });
      expect(fs.readFileSync(file, "utf8")).not.toContain("sk-live-123");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("looksSecret goes by whole words", () => {
    for (const s of ["password", "pw", "api_key", "apiKey", "otpCode", "pin", "card.cvv", "TOKEN"]) expect(looksSecret(s), s).toBe(true);
    for (const s of ["zipcode", "shipping_city", "passport", "promo_code", "spinner", "monkey", "email"]) expect(looksSecret(s), s).toBe(false);
  });
});

describe("saved steps", () => {
  it("a short value is a slot only when it is the whole text", () => {
    const values = { count: "1", name: "Jo", email: "ana@example.com" };
    const slots = ["count", "name", "email"];
    expect(templateText("10 results", values, slots)).toBe("10 results");
    expect(templateText("Join", values, slots)).toBe("Join");
    expect(templateText("1", values, slots)).toBe("{{count}}");
    expect(templateText("to ana@example.com now", values, slots)).toBe("to {{email}} now");
  });
});

describe("Jet setup helpers", () => {
  it("execFile answers, never rejects, when the program cannot be started at all", async () => {
    const r = await execFile("bad\0name", []);
    expect(r.code).toBeNull();
    expect(r.spawnError).toBeTruthy();
  });

  it("quote keeps a path with ' or spaces in one piece for parseCommandLine", () => {
    for (const p of ["C:\\Users\\O'Brien\\python.exe", "C:\\Program Files\\Python\\python.exe", "/usr/bin/python3"]) {
      expect(parseCommandLine(`${quote(p)} -m clearcote_jet.cli`)).toEqual([p, "-m", "clearcote_jet.cli"]);
    }
  });
});

describe("tasks.json", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-fixes-"));
    file = path.join(dir, "tasks.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("a file that cannot be parsed is kept aside, not overwritten", () => {
    fs.writeFileSync(file, '[{"id":"a","goal":"g"},]');
    saveTask(file, { id: "b", goal: "new" });
    const bad = fs.readdirSync(dir).filter((f) => f.startsWith("tasks.json.bad-"));
    expect(bad).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, bad[0]), "utf8")).toBe('[{"id":"a","goal":"g"},]');
    expect(readTasks(file).map((t) => t.id)).toEqual(["b"]);
    expect(fs.readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});
