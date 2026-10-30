// The run-a-task API in the browser preview (next dev, no Electron). Off by default: a start says it needs
// the desktop app. With localStorage["clearcote.mock.sync"] = "ok" it plays a run, so the dialog and the
// board can be designed and tested without Jet: each profile starts, takes two steps, stops before
// "Place order" when approval is on, and ends done (the first "learned", the rest "replayed"). A profile
// missing a {{value}} ends as needs_input, as in the app.

import type { Profile } from "@/types/profile";
import type { StartRequest, SyncRun, SyncRow } from "../../electron/jetsync";
import { normalizeTemplate, valuesFor } from "../../electron/jetslots";
import { t } from "@/lib/i18n";
import type { JetSetupApi, JetStatus, KeyState, SavedTask, SyncApi, TasksApi } from "./ipc";

export function buildSyncMock(readProfiles: () => Profile[]): SyncApi {
  let runs: SyncRun[] = [];
  /** Each run's own values (secret ones too), as the main process keeps them. */
  const runParams = new Map<string, Record<string, string>>();
  const listeners = new Set<(r: SyncRun[]) => void>();
  const copy = () => runs.map((r) => ({ ...r, rows: r.rows.map((x) => ({ ...x, steps: [...x.steps] })) }));
  const changed = () => listeners.forEach((cb) => cb(copy()));
  const final = (s: SyncRow["status"]) => ["done", "blocked", "needs_input", "budget", "failed", "cancelled", "stopped"].includes(s);
  const later = (ms: number, fn: () => void) => setTimeout(fn, ms);
  const settle = (run: SyncRun) => {
    if (run.state !== "finished" && run.rows.every((r) => final(r.status))) {
      run.state = "finished";
      if (run.taskId) recordMockRun(run);
    }
    changed();
  };

  function play(run: SyncRun, row: SyncRow, i: number) {
    const p = readProfiles().find((x) => x.id === row.profileId);
    const extra = runParams.get(run.id) ?? {};
    const withRun = p && Object.keys(extra).length ? { ...p, vars: [...(p.vars ?? []).filter((x) => !(x.key in extra)), ...Object.entries(extra).map(([key, value]) => ({ key, value }))] } : p;
    const v = withRun ? valuesFor(run.goal, withRun) : { missing: ["?"], values: {}, secret: [] };
    later(150 + i * 250, () => {
      if (row.status !== "queued") return;
      if (v.missing.length) {
        Object.assign(row, { status: "needs_input", detail: t("This profile has no value for {slots}.", { slots: v.missing.map((m) => `{{${m}}}`).join(", ") }) });
        return settle(run);
      }
      row.status = "running";
      row.startedAt = Date.now();
      changed();
      later(300, () => {
        if (row.status !== "running") return;
        row.steps.push({ kind: "click", action: "Reject additional cookies", replayed: i > 0, probability: i > 0 ? null : 0.91 });
        row.steps.push({ kind: "type", action: "Search", text: "example", replayed: i > 0, probability: i > 0 ? null : 1 });
        if (run.confirm) {
          row.status = "waiting_approval";
          row.pending = { kind: "click", label: "Place order", role: "button" };
          row.detail = 'stopped before "Place order", which can\'t be taken back: confirm to go ahead';
          changed();
        } else finish(run, row, i);
      });
    });
  }

  function finish(run: SyncRun, row: SyncRow, i: number) {
    row.steps.push({ kind: "click", action: "Place order", replayed: i > 0 });
    Object.assign(row, { status: "done", pending: undefined, detail: undefined, skill: i === 0 ? "learned" : "replayed", usd: i === 0 ? 0.0008 : 0, endedAt: Date.now() });
    settle(run);
  }

  const find = (id: string) => runs.find((r) => r.id === id);
  const each = (runId: string, profileId: string | undefined, pred: (r: SyncRow) => boolean, fn: (r: SyncRow, i: number) => void) => {
    const run = find(runId);
    if (!run) return 0;
    let n = 0;
    run.rows.forEach((r, i) => {
      if ((!profileId || r.profileId === profileId) && pred(r)) {
        fn(r, i);
        n++;
      }
    });
    settle(run);
    return n;
  };

  return {
    list: async () => copy(),
    start: async (req: StartRequest) => {
      let mode: string | null = null;
      try {
        mode = localStorage.getItem("clearcote.mock.sync");
      } catch {
        mode = null;
      }
      if (mode !== "ok" && mode !== "setup") return { ok: false, error: t("Running a task needs the desktop app (this is the browser preview).") };
      const goal = normalizeTemplate(req.goal ?? "");
      if (!goal) return { ok: false, error: t("Say what the task is.") };
      if (!req.profileIds?.length) return { ok: false, error: t("Select at least one profile.") };
      const all = readProfiles();
      const run: SyncRun = {
        id: `run-${Date.now().toString(36)}`,
        goal,
        url: req.url,
        confirm: req.confirm !== false,
        concurrency: req.concurrency ?? 2,
        staggerSec: req.staggerSec ?? [3, 20],
        closeWhenDone: !!req.closeWhenDone,
        createdAt: Date.now(),
        state: "running",
        rows: req.profileIds.map((id) => ({ profileId: id, name: all.find((p) => p.id === id)?.name ?? id, status: "queued", steps: [] })),
        ...(req.taskId ? { taskId: req.taskId } : {}),
      };
      if (req.params && Object.keys(req.params).length) {
        runParams.set(run.id, req.params);
        const secret = new Set(req.paramSecret ?? []);
        const shown = Object.fromEntries(Object.entries(req.params).filter(([k]) => !secret.has(k)));
        if (Object.keys(shown).length) run.params = shown;
      }
      runs = [run, ...runs].slice(0, 5);
      run.rows.forEach((row, i) => play(run, row, i));
      changed();
      return { ok: true, runId: run.id };
    },
    approve: async (runId, profileId) =>
      each(runId, profileId, (r) => r.status === "waiting_approval", (r, i) => finish(find(runId)!, r, i)),
    cancel: async (runId, profileId) =>
      each(runId, profileId, (r) => r.status === "waiting_approval", (r) => Object.assign(r, { status: "cancelled", pending: undefined, detail: undefined })),
    stop: async (runId, profileId) =>
      each(runId, profileId, (r) => !final(r.status), (r) => Object.assign(r, { status: "stopped", pending: undefined, detail: t("Stopped.") })),
    clear: async () => {
      runs = runs.filter((r) => r.state !== "finished");
      changed();
    },
    onChanged: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** The setup checklist in the preview. localStorage["clearcote.mock.sync"] = "ok": ready. "setup": Python
 *  found, Jet not installed and no key; Install Jet succeeds after a moment, and any key but "bad" is accepted. */
export function buildJetSetupMock(): JetSetupApi {
  const mode = () => (typeof localStorage === "undefined" ? null : localStorage.getItem("clearcote.mock.sync"));
  let installed = false;
  let keyOk = false;
  const python = { cmd: ["py", "-3"], exe: "C:\\Python313\\python.exe", version: "3.13.2" };
  const status = (): JetStatus => {
    const m = mode();
    if (m === "ok") return { python, jet: { ok: true, version: "0.3.1", command: "clearcote-jet" }, key: { ok: true, source: "settings" }, ready: true };
    if (m !== "setup") return { python: null, jet: { ok: false, reason: "missing" }, key: { ok: false, reason: "missing" }, ready: false };
    const jet: JetStatus["jet"] = installed ? { ok: true, version: "0.3.1", command: '"C:\\Python313\\python.exe" -m clearcote_jet.cli' } : { ok: false, reason: "missing" };
    const key: KeyState = keyOk ? { ok: true, source: "settings" } : { ok: false, reason: "missing" };
    return { python, jet, key, ready: jet.ok && key.ok };
  };
  return {
    status: async () => {
      await new Promise((r) => setTimeout(r, 200));
      return status();
    },
    install: async () => {
      await new Promise((r) => setTimeout(r, 1200));
      if (mode() !== "setup" && mode() !== "ok") return { ok: false, error: "No Python 3.10 or newer was found on this PC." };
      installed = true;
      return { ok: true, status: status() };
    },
    checkKey: async (key) => {
      await new Promise((r) => setTimeout(r, 300));
      if (!key?.trim()) return keyOk ? { ok: true, source: "settings" } : { ok: false, reason: "missing" };
      if (key.trim() === "bad") return { ok: false, reason: "rejected" };
      keyOk = true;
      return { ok: true, source: "settings" };
    },
  };
}

/** Saved tasks in the preview, kept in localStorage["clearcote.mock.tasks"]. */
export function buildTasksMock(): TasksApi {
  const KEY = TASKS_KEY;
  const listeners = new Set<() => void>();
  const read = (): SavedTask[] => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "[]");
    } catch {
      return [];
    }
  };
  const write = (l: SavedTask[]) => localStorage.setItem(KEY, JSON.stringify(l));
  return {
    list: async () => read(),
    save: async (t) => {
      const now = Date.now();
      const list = read();
      const id = t.id || `task-${now.toString(36)}`;
      const prev = list.find((x) => x.id === id);
      // As electron/tasks.ts: an update changes the recipe only; history and steps stay as recorded.
      const runs = prev ? { history: prev.history, steps: prev.steps, stepsFrom: prev.stepsFrom, createdAt: prev.createdAt } : {};
      const task: SavedTask = { params: [], confirm: true, history: [], createdAt: now, ...prev, ...t, ...runs, id, name: t.name?.trim() || prev?.name || String(t.goal ?? "Task").slice(0, 60), goal: String(t.goal ?? prev?.goal ?? ""), updatedAt: now } as SavedTask;
      // As normalizeTask: a secret value never keeps a default.
      task.params = (task.params ?? []).map((p) => (p.secret ? (({ default: _d, ...rest }) => rest)(p) : p));
      write(prev ? list.map((x) => (x.id === id ? task : x)) : [task, ...list]);
      listeners.forEach((cb) => cb());
      return task;
    },
    remove: async (id) => {
      const list = read();
      write(list.filter((x) => x.id !== id));
      listeners.forEach((cb) => cb());
      return list.some((x) => x.id === id);
    },
    onChanged: (cb) => {
      listeners.add(cb);
      window.addEventListener(TASKS_EVENT, cb);
      return () => {
        listeners.delete(cb);
        window.removeEventListener(TASKS_EVENT, cb);
      };
    },
  };
}

const TASKS_KEY = "clearcote.mock.tasks";
const TASKS_EVENT = "clearcote-mock-tasks";

/** As electron/handlers.ts does: a finished run of a saved task goes into its history and step timeline. */
function recordMockRun(run: SyncRun) {
  try {
    const list: SavedTask[] = JSON.parse(localStorage.getItem(TASKS_KEY) || "[]");
    const task = list.find((x) => x.id === run.taskId);
    if (!task) return;
    const done = run.rows.filter((r) => r.status === "done");
    task.history = [{ at: run.createdAt, total: run.rows.length, done: done.length, ...(run.params ? { params: run.params } : {}) }, ...(task.history ?? [])].slice(0, 20);
    const learned = done.find((r) => r.skill === "learned");
    const best = learned ?? done[0];
    if (best?.steps.length && (learned || !task.steps?.length)) {
      task.steps = best.steps;
      task.stepsFrom = best.name;
    }
    localStorage.setItem(TASKS_KEY, JSON.stringify(list));
    window.dispatchEvent(new Event(TASKS_EVENT));
  } catch {
    /* preview only */
  }
}
