// Run one task on many profiles with Jet (clearcote-jet). The synchronizer copies the TASK, not the clicks:
// each profile opens its own browser with a local DevTools endpoint (electron/devtools.ts), a Jet worker
// attaches to it, and the task runs on that profile's own page with its own mouse path and timing. The first
// profile to finish teaches Jet the task (a skill); the rest replay it with no model calls.
//
// One worker process per profile, spoken to over stdio, one JSON object per line:
//   in:  {"cmd":"run", cdp, url, goal, values, secret, confirm, humanize, reuse}   then approve / cancel / stop
//   out: ready, step, needs_confirmation, result, error
// A profile waits for a free slot (concurrency) and then a random gap (stagger) before it starts, so a
// batch never acts in lockstep. Nothing here touches Electron: the desktop app and the web helper share it.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import type { LaunchResult, Profile, Settings } from "./types";
import { maskSecrets, normalizeTemplate, templateSlots, valuesFor } from "./jetslots";

export type RowStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_approval"
  | "done"
  | "blocked"
  | "needs_input"
  | "budget"
  | "failed"
  | "cancelled"
  | "stopped";

export const FINAL: ReadonlySet<RowStatus> = new Set(["done", "blocked", "needs_input", "budget", "failed", "cancelled", "stopped"]);

export interface StepSummary {
  kind: string;
  action: string;
  text?: string | null;
  replayed?: boolean;
  probability?: number | null;
  atMs?: number;
  /** The text with every value of the task's {{slots}} written as its slot: what a saved task keeps, so it
   *  shows {{email}} rather than one profile's address. */
  template?: string | null;
}

export interface SyncRow {
  profileId: string;
  name: string;
  status: RowStatus;
  detail?: string;
  steps: StepSummary[];
  pending?: { kind?: string; label: string; role?: string };
  /** learned, replayed, shortcut or repaired (Jet's result.skill.used). */
  skill?: string;
  usd?: number;
  url?: string;
  startedAt?: number;
  endedAt?: number;
  /** This run opened the browser (so "close when done" closes it). */
  launched?: boolean;
}

export interface SyncRun {
  id: string;
  goal: string;
  url?: string;
  confirm: boolean;
  concurrency: number;
  staggerSec: [number, number];
  closeWhenDone: boolean;
  createdAt: number;
  state: "running" | "finished";
  rows: SyncRow[];
  /** The saved task this run came from (electron/tasks.ts records the result into it). */
  taskId?: string;
  /** This run's own values that are not secret ({{slot}} → value); secret ones never leave the manager. */
  params?: Record<string, string>;
  /** The names (never the values) of this run's secret values, so the run can be saved as a task. */
  secretParams?: string[];
}

export interface StartRequest {
  profileIds: string[];
  goal: string;
  url?: string;
  confirm?: boolean;
  concurrency?: number;
  staggerSec?: [number, number];
  closeWhenDone?: boolean;
  /** Values for every profile of this run ({{slot}} → value). They win over a profile's own task values. */
  params?: Record<string, string>;
  /** Which of params are secret: typed only, never shown, never saved. */
  paramSecret?: string[];
  /** Slots the task marks secret, wherever their value comes from (a profile's own value too). */
  secretSlots?: string[];
  /** The saved task this run came from. */
  taskId?: string;
}

/** Typed text as a saved task keeps it: a value of the task's slots becomes its {{slot}} when it is the whole
 *  text, or inside longer text when it is at least 3 characters (so {{count}} = "1" leaves "10 results" alone). */
export function templateText(text: string, values: Record<string, string>, slots: string[]): string {
  const used = slots.filter((k) => values[k]);
  const whole = used.find((k) => values[k] === text);
  if (whole) return `{{${whole}}}`;
  return maskSecrets(text, values, used.filter((k) => values[k].length >= 3));
}

/** The profile as this run sees it: the run's own values in place of (or added to) its task values. */
export function withRunParams(p: Profile, params: Record<string, string> | undefined, secret: ReadonlySet<string>): Profile {
  if (!params || !Object.keys(params).length) return p;
  const own = new Map((p.vars ?? []).map((v) => [v.key.trim(), v]));
  const vars = (p.vars ?? []).filter((v) => !(v.key.trim() in params));
  // A value the profile keeps secret stays secret when the run supplies it.
  for (const [key, value] of Object.entries(params)) vars.push({ key, value, ...(secret.has(key) || own.get(key)?.secret ? { secret: true } : {}) });
  return { ...p, vars };
}

/** A started worker: enough of a ChildProcess to talk to and to stop. */
export interface WorkerProc {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(ev: "exit", cb: (code: number | null) => void): unknown;
  on(ev: "error", cb: (e: Error) => void): unknown;
  kill(): unknown;
}

export interface SyncDeps {
  getProfile(id: string): Profile | null;
  launch(p: Profile): Promise<LaunchResult>;
  stop(id: string): Promise<unknown>;
  isRunning(id: string): boolean;
  cdpEndpoint(id: string): string | undefined;
  /** True when the profile runs in the cloud (a task needs a browser on this PC). */
  inCloud(id: string): boolean;
  settings(): Settings;
  spawnWorker(cmd: string, args: string[], env: NodeJS.ProcessEnv): WorkerProc;
  random?(): number;
  sleep?(ms: number): Promise<void>;
}

export const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_STAGGER: [number, number] = [3, 20];
export const MAX_CONCURRENCY = 10;
export const KEEP_RUNS = 5;
const MAX_STEPS_KEPT = 200;

/** A command line split into program + arguments; double or single quotes keep spaces together. */
export function parseCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let any = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

/** The program and arguments that start a Jet worker. */
export function workerCommand(s: Pick<Settings, "jetCommand">): [string, string[]] {
  const parts = parseCommandLine(s.jetCommand?.trim() || "clearcote-jet");
  return [parts[0], [...parts.slice(1), "worker"]];
}

export function clampConcurrency(n: unknown): number {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(MAX_CONCURRENCY, Math.max(1, v)) : DEFAULT_CONCURRENCY;
}

export function clampStagger(v: unknown): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) return DEFAULT_STAGGER;
  let [a, b] = v.map((x) => Math.max(0, Math.min(600, Number(x) || 0)));
  if (a > b) [a, b] = [b, a];
  return [a, b];
}

/** Jet's result status as a row status. */
export function rowStatusFor(jet: string | undefined): RowStatus {
  switch (jet) {
    case "done":
    case "blocked":
    case "needs_input":
    case "budget":
    case "cancelled":
    case "stopped":
      return jet;
    default:
      return "failed";
  }
}

let nextId = 1;

export class SyncManager extends EventEmitter {
  private runs: SyncRun[] = [];
  private workers = new Map<string, WorkerProc>(); // `${runId}/${profileId}`
  private stopRequested = new Set<string>();
  /** Each run's own values, secret ones included; kept here so they never reach list(). */
  private runValues = new Map<string, { params: Record<string, string>; secret: Set<string>; slots: Set<string> }>();

  constructor(private deps: SyncDeps) {
    super();
  }

  list(): SyncRun[] {
    return this.runs.map((r) => ({ ...r, rows: r.rows.map((x) => ({ ...x, steps: [...x.steps] })) }));
  }

  /** Busy profiles: a profile is in at most one unfinished row at a time. */
  busyProfiles(): Set<string> {
    const busy = new Set<string>();
    for (const r of this.runs) for (const row of r.rows) if (!FINAL.has(row.status)) busy.add(row.profileId);
    return busy;
  }

  start(req: StartRequest): { ok: true; runId: string } | { ok: false; error: string } {
    const goal = normalizeTemplate(String(req.goal ?? ""));
    if (!goal) return { ok: false, error: "Say what the task is." };
    if (goal.length > 4000) return { ok: false, error: "The task is too long (4,000 characters at most)." };
    let url: string | undefined;
    if (req.url?.trim()) {
      try {
        const u = new URL(req.url.trim());
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
        url = u.href;
      } catch {
        return { ok: false, error: "The start page must be an http or https address." };
      }
    }
    const ids = [...new Set((req.profileIds ?? []).map(String))];
    if (!ids.length) return { ok: false, error: "Select at least one profile." };
    const busy = this.busyProfiles();
    const already = ids.filter((id) => busy.has(id));
    if (already.length) return { ok: false, error: `${already.length === 1 ? "A selected profile is" : `${already.length} selected profiles are`} already running a task.` };
    const rows: SyncRow[] = [];
    for (const id of ids) {
      const p = this.deps.getProfile(id);
      if (!p) return { ok: false, error: `Profile ${id} no longer exists.` };
      rows.push({ profileId: id, name: p.name, status: "queued", steps: [] });
    }
    const s = this.deps.settings();
    const run: SyncRun = {
      id: `run-${Date.now().toString(36)}-${nextId++}`,
      goal,
      url,
      confirm: req.confirm !== false,
      concurrency: clampConcurrency(req.concurrency ?? s.syncConcurrency),
      staggerSec: clampStagger(req.staggerSec ?? s.syncStaggerSec),
      closeWhenDone: !!req.closeWhenDone,
      createdAt: Date.now(),
      state: "running",
      rows,
    };
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.params ?? {})) if (/^[A-Za-z_][\w.-]{0,63}$/.test(k) && String(v).trim()) params[k] = String(v);
    const secretParams = new Set((req.paramSecret ?? []).map(String));
    // A run value for a slot any of these profiles keeps secret is secret too (never shown, never recorded).
    for (const id of ids) for (const v of this.deps.getProfile(id)?.vars ?? []) if (v.secret && v.key.trim() in params) secretParams.add(v.key.trim());
    const secretSlots = new Set([...(req.secretSlots ?? []).map(String), ...secretParams]);
    if (Object.keys(params).length || secretSlots.size) {
      this.runValues.set(run.id, { params, secret: secretParams, slots: secretSlots });
      const shown = Object.fromEntries(Object.entries(params).filter(([k]) => !secretParams.has(k)));
      if (Object.keys(shown).length) run.params = shown;
      const hidden = Object.keys(params).filter((k) => secretParams.has(k));
      if (hidden.length) run.secretParams = hidden;
    }
    if (typeof req.taskId === "string" && req.taskId) run.taskId = req.taskId;
    this.runs.unshift(run);
    this.trim();
    this.changed();
    void this.drive(run);
    return { ok: true, runId: run.id };
  }

  /** Go ahead with the click a row (or, without a profile, every waiting row) stopped before. */
  approve(runId: string, profileId?: string): number {
    return this.control(runId, profileId, "approve", (r) => r.status === "waiting_approval", "running");
  }

  /** Don't make that click: the row ends as cancelled. */
  cancel(runId: string, profileId?: string): number {
    return this.control(runId, profileId, "cancel", (r) => r.status === "waiting_approval", undefined);
  }

  /** Stop a row, or the whole run: queued rows never start, running ones stop as soon as they can. */
  stop(runId: string, profileId?: string): number {
    const run = this.runs.find((r) => r.id === runId);
    if (!run) return 0;
    let n = 0;
    for (const row of run.rows) {
      if (profileId && row.profileId !== profileId) continue;
      if (FINAL.has(row.status)) continue;
      const key = `${run.id}/${row.profileId}`;
      this.stopRequested.add(key);
      const w = this.workers.get(key);
      if (w) this.send(w, { cmd: "stop" });
      else this.finish(run, row, "stopped", "Stopped before it started.");
      n++;
    }
    this.changed();
    return n;
  }

  /** Forget finished runs (the board's Clear). */
  clearFinished(): void {
    this.runs = this.runs.filter((r) => r.state !== "finished");
    this.changed();
  }

  /** Stop everything now (the app is quitting). */
  async shutdown(): Promise<void> {
    for (const run of this.runs) if (run.state === "running") this.stop(run.id);
    for (const w of this.workers.values()) w.kill();
  }

  private control(runId: string, profileId: string | undefined, cmd: string, ok: (r: SyncRow) => boolean, next?: RowStatus): number {
    const run = this.runs.find((r) => r.id === runId);
    if (!run) return 0;
    let n = 0;
    for (const row of run.rows) {
      if ((profileId && row.profileId !== profileId) || !ok(row)) continue;
      const w = this.workers.get(`${run.id}/${row.profileId}`);
      if (!w) continue;
      // The new status first: the worker may answer before send() returns.
      if (next) {
        row.status = next;
        row.pending = undefined;
        row.detail = undefined;
      }
      this.send(w, { cmd });
      n++;
    }
    if (n) this.changed();
    return n;
  }

  private async drive(run: SyncRun): Promise<void> {
    const queue = [...run.rows];
    let first = true;
    const lane = async () => {
      for (;;) {
        const row = queue.shift();
        if (!row) return;
        if (row.status !== "queued") continue; // stopped while waiting
        if (!first) {
          const [a, b] = run.staggerSec;
          await this.sleep((a + (b - a) * this.random()) * 1000);
          if (row.status !== "queued") continue;
        }
        first = false;
        await this.runRow(run, row);
      }
    };
    await Promise.all(Array.from({ length: Math.min(run.concurrency, run.rows.length) }, lane));
    run.state = "finished";
    this.runValues.delete(run.id);
    this.changed();
    this.emit("finished", this.list().find((r) => r.id === run.id) ?? run);
  }

  private async runRow(run: SyncRun, row: SyncRow): Promise<void> {
    const key = `${run.id}/${row.profileId}`;
    row.startedAt = Date.now();
    const stored = this.deps.getProfile(row.profileId);
    if (!stored) return this.finish(run, row, "failed", "The profile no longer exists.");
    const rv = this.runValues.get(run.id);
    const p = withRunParams(stored, rv?.params, rv?.secret ?? new Set());
    const found = valuesFor(run.goal, p);
    const { values, missing } = found;
    // A slot the task marks secret is secret on every profile, even where the profile's own value is not.
    const secret = [...new Set([...found.secret, ...[...(rv?.slots ?? [])].filter((k) => k in values)])];
    if (missing.length) {
      return this.finish(run, row, "needs_input", `This profile has no value for ${missing.map((m) => `{{${m}}}`).join(", ")}. Add it under Task values in the profile.`);
    }
    if (this.deps.inCloud(p.id)) return this.finish(run, row, "failed", "This profile is running in the cloud. Tasks run in a browser on this PC: stop the cloud browser first.");

    row.status = "starting";
    this.changed();
    let cdp = this.deps.cdpEndpoint(p.id);
    if (!cdp) {
      if (this.deps.isRunning(p.id)) {
        return this.finish(run, row, "failed", "This profile's browser was opened without automation, so Jet cannot reach it. Close it and run the task again, or turn on Allow automation in Settings.");
      }
      const r = await this.deps.launch(p);
      if (!r.ok) return this.finish(run, row, "failed", r.error || "The browser did not start.");
      row.launched = true;
      cdp = r.cdp ?? this.deps.cdpEndpoint(p.id);
      if (!cdp) return this.finish(run, row, "failed", "The browser started but did not open its automation port.");
    }
    if (this.stopRequested.has(key)) return this.finish(run, row, "stopped", "Stopped before it started.");

    const s = this.deps.settings();
    const [cmd, args] = workerCommand(s);
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" };
    if (s.jetApiKey?.trim()) env.TYPESAFE_API_KEY = s.jetApiKey.trim();
    const mask = (t: string) => maskSecrets(t, values, secret);

    let w: WorkerProc;
    try {
      w = this.deps.spawnWorker(cmd, args, env);
    } catch (e) {
      return this.finish(run, row, "failed", notFound(cmd, e));
    }
    this.workers.set(key, w);
    row.status = "running";
    this.changed();

    const stderr: string[] = [];
    w.stderr?.on("data", (d: Buffer) => {
      stderr.push(String(d));
      if (stderr.length > 40) stderr.shift();
    });
    let ended = false;
    const done = new Promise<void>((resolve) => {
      const end = (status: RowStatus, detail?: string) => {
        if (!ended) {
          ended = true;
          this.finish(run, row, status, detail ? mask(detail) : undefined);
        }
        resolve();
      };
      let exitCode: number | null = null;
      const crashed = () => {
        if (this.stopRequested.has(key)) end("stopped", "Stopped.");
        else if (tooOld(stderr)) end("failed", JET_TOO_OLD);
        else end("failed", `Jet stopped without finishing (exit code ${exitCode}). ${lastLines(stderr)}`.trim());
      };
      if (w.stdout) {
        const rl = readline.createInterface({ input: w.stdout });
        // Its output closes after its last line: only then is a missing result a crash.
        rl.on("close", () => setTimeout(crashed, 20));
        rl.on("line", (line) => {
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line);
          } catch {
            return; // not ours
          }
          this.onEvent(run, row, ev, mask, end, (t) => templateText(t, values, templateSlots(run.goal)));
        });
      }
      w.on("error", (e) => end("failed", notFound(cmd, e)));
      w.on("exit", (code) => {
        exitCode = code;
        if (!w.stdout) crashed();
      });
    });
    this.send(w, {
      cmd: "run",
      cdp,
      url: run.url,
      goal: run.goal,
      values,
      secret,
      confirm: run.confirm,
      humanize: true,
      reuse: true,
    });
    await done;
    this.workers.delete(key);
    try {
      w.stdin?.end();
    } catch {
      /* already closed */
    }
    if (run.closeWhenDone && row.launched) await this.deps.stop(p.id).catch(() => undefined);
  }

  private onEvent(run: SyncRun, row: SyncRow, ev: Record<string, unknown>, mask: (t: string) => string, end: (s: RowStatus, d?: string) => void, toTemplate: (t: string) => string = (t) => t): void {
    switch (ev.type) {
      case "step": {
        const text = typeof ev.text === "string" ? mask(ev.text) : null;
        const template = text === null ? null : toTemplate(text);
        row.steps.push({
          kind: String(ev.kind ?? ""),
          action: mask(String(ev.action ?? "")),
          text,
          replayed: !!ev.replayed,
          probability: typeof ev.probability === "number" ? ev.probability : null,
          atMs: typeof ev.at_ms === "number" ? ev.at_ms : undefined,
          ...(template !== text ? { template } : {}),
        });
        if (row.steps.length > MAX_STEPS_KEPT) row.steps.shift();
        if (typeof ev.led_to === "string") row.url = mask(ev.led_to);
        this.changed();
        return;
      }
      case "needs_confirmation": {
        const pend = (ev.pending ?? {}) as { kind?: string; label?: string; role?: string };
        row.status = "waiting_approval";
        row.pending = { kind: pend.kind, label: mask(String(pend.label ?? "")), role: pend.role };
        row.detail = typeof ev.detail === "string" ? mask(ev.detail) : undefined;
        this.changed();
        return;
      }
      case "result": {
        const usage = ev.usage as { estimated_usd?: number } | undefined;
        if (typeof usage?.estimated_usd === "number") row.usd = usage.estimated_usd;
        const skill = ev.skill as { used?: string } | undefined;
        if (skill?.used) row.skill = skill.used;
        if (typeof ev.url === "string") row.url = mask(ev.url);
        end(rowStatusFor(String(ev.status)), typeof ev.detail === "string" ? ev.detail : undefined);
        return;
      }
      case "error":
        end("failed", String(ev.message ?? "Jet reported an error."));
        return;
    }
  }

  private finish(run: SyncRun, row: SyncRow, status: RowStatus, detail?: string): void {
    row.status = status;
    row.detail = detail;
    row.pending = undefined;
    row.endedAt = Date.now();
    this.changed();
  }

  private send(w: WorkerProc, msg: unknown): void {
    try {
      w.stdin?.write(JSON.stringify(msg) + "\n");
    } catch {
      /* the worker is gone; its exit ends the row */
    }
  }

  private trim(): void {
    const finished = this.runs.filter((r) => r.state === "finished");
    if (this.runs.length > KEEP_RUNS && finished.length) {
      const drop = new Set(finished.slice(-(this.runs.length - KEEP_RUNS)).map((r) => r.id));
      this.runs = this.runs.filter((r) => !drop.has(r.id));
    }
  }

  private changed(): void {
    this.emit("changed", this.list());
  }

  private random(): number {
    return this.deps.random ? this.deps.random() : Math.random();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }
}

/** The oldest Jet with the worker this runner speaks to. */
export const MIN_JET = "0.3.0";
const JET_TOO_OLD = `This Jet is too old to run tasks on profiles (it needs ${MIN_JET} or newer). Update it with "pip install -U git+https://github.com/clearcotelabs/clearcote-jet".`;

/** An older Jet has no `worker` command: argparse says so on stderr. */
function tooOld(lines: string[]): boolean {
  return /invalid choice: '?worker'?/.test(lines.join(""));
}

function lastLines(lines: string[]): string {
  const t = lines.join("").trim().split(/\r?\n/).slice(-3).join(" ").trim();
  return t ? `Last output: ${t.slice(0, 400)}` : "";
}

function notFound(cmd: string, e: unknown): string {
  const code = (e as { code?: string })?.code;
  if (code === "ENOENT") {
    return `Jet is not installed or not found (${cmd}). Install it with "pip install -U git+https://github.com/clearcotelabs/clearcote-jet", or set the command under Settings → Tasks.`;
  }
  return `Could not start Jet (${cmd}): ${String((e as Error)?.message || e)}`;
}

/** Start a real worker process. */
export function spawnJet(cmd: string, args: string[], env: NodeJS.ProcessEnv): WorkerProc {
  const child: ChildProcess = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  return child as unknown as WorkerProc;
}
