// The run-a-task API in the browser preview (next dev, no Electron). Off by default: a start says it needs
// the desktop app. With localStorage["clearcote.mock.sync"] = "ok" it plays a run, so the dialog and the
// board can be designed and tested without Jet: each profile starts, takes two steps, stops before
// "Place order" when approval is on, and ends done (the first "learned", the rest "replayed"). A profile
// missing a {{value}} ends as needs_input, as in the app.

import type { Profile } from "@/types/profile";
import type { StartRequest, SyncRun, SyncRow } from "../../electron/jetsync";
import { normalizeTemplate, valuesFor } from "../../electron/jetslots";
import { t } from "@/lib/i18n";
import type { SyncApi } from "./ipc";

export function buildSyncMock(readProfiles: () => Profile[]): SyncApi {
  let runs: SyncRun[] = [];
  const listeners = new Set<(r: SyncRun[]) => void>();
  const copy = () => runs.map((r) => ({ ...r, rows: r.rows.map((x) => ({ ...x, steps: [...x.steps] })) }));
  const changed = () => listeners.forEach((cb) => cb(copy()));
  const final = (s: SyncRow["status"]) => ["done", "blocked", "needs_input", "budget", "failed", "cancelled", "stopped"].includes(s);
  const later = (ms: number, fn: () => void) => setTimeout(fn, ms);
  const settle = (run: SyncRun) => {
    if (run.rows.every((r) => final(r.status))) run.state = "finished";
    changed();
  };

  function play(run: SyncRun, row: SyncRow, i: number) {
    const p = readProfiles().find((x) => x.id === row.profileId);
    const v = p ? valuesFor(run.goal, p) : { missing: ["?"], values: {}, secret: [] };
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
      if (mode !== "ok") return { ok: false, error: t("Running a task needs the desktop app (this is the browser preview).") };
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
      };
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
