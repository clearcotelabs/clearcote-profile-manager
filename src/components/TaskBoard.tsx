"use client";

// The run board: one row per profile of the latest task run, with what it is doing, where it stopped and
// why. A row waiting before a click that can't be undone gets Approve / Don't; the header approves every
// waiting row at once, stops the run, or clears finished runs. It docks above the page and folds away.

import { useState } from "react";
import type { RowStatus, SyncRow, SyncRun } from "@/lib/ipc";
import { t, tx } from "@/lib/i18n";

const STATUS: Record<RowStatus, { label: string; cls: string }> = {
  queued: { label: tx("Waiting"), cls: "bg-elevate text-fog/60" },
  starting: { label: tx("Opening"), cls: "bg-accent/15 text-accent" },
  running: { label: tx("Running"), cls: "bg-accent/15 text-accent" },
  waiting_approval: { label: tx("Needs you"), cls: "bg-warn/15 text-warn" },
  done: { label: tx("Done"), cls: "bg-ok/15 text-ok" },
  blocked: { label: tx("Stuck"), cls: "bg-danger/15 text-danger" },
  needs_input: { label: tx("Missing value"), cls: "bg-warn/15 text-warn" },
  budget: { label: tx("Too many steps"), cls: "bg-danger/15 text-danger" },
  failed: { label: tx("Failed"), cls: "bg-danger/15 text-danger" },
  cancelled: { label: tx("Not done"), cls: "bg-elevate text-fog/60" },
  stopped: { label: tx("Stopped"), cls: "bg-elevate text-fog/60" },
};

const SKILL: Record<string, string> = {
  learned: tx("learned"),
  replayed: tx("replayed"),
  shortcut: tx("replayed"),
  repaired: tx("relearned a step"),
};

const btn = "rounded-md border border-line-strong px-2 py-0.5 text-[11px] text-fog/80 hover:bg-elevate disabled:opacity-40";

export default function TaskBoard({
  runs,
  onApprove,
  onCancel,
  onStop,
  onClear,
  trial,
  onContinue,
  onDismissTrial,
  onSaveRun,
  raised = false,
}: {
  runs: SyncRun[];
  onApprove: (runId: string, profileId?: string) => void;
  onCancel: (runId: string, profileId: string) => void;
  onStop: (runId: string, profileId?: string) => void;
  onClear: () => void;
  /** This run tried the task on one profile; `rest` more are waiting to be offered. */
  trial?: { runId: string; rest: number };
  onContinue?: (runId: string) => void;
  onDismissTrial?: (runId: string) => void;
  /** Keep a run that worked as a saved task (not offered for a run of a saved task: that one is recorded). */
  onSaveRun?: (run: SyncRun) => void;
  /** The bulk-actions bar is showing: sit above it. */
  raised?: boolean;
}) {
  const [folded, setFolded] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const run = runs[0];
  if (!run) return null;
  const done = run.rows.filter((r) => r.status === "done").length;
  const waiting = run.rows.filter((r) => r.status === "waiting_approval").length;
  const active = run.state === "running";
  const usd = run.rows.reduce((a, r) => a + (r.usd ?? 0), 0);

  return (
    <section
      aria-label={t("Task run")}
      data-task-board="1"
      className={
        "fixed right-4 z-30 w-[min(460px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-line-strong bg-surface/95 shadow-2xl backdrop-blur " +
        (raised ? "bottom-20" : "bottom-4")
      }
    >
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <button className="min-w-0 flex-1 text-left" onClick={() => setFolded((v) => !v)} aria-expanded={!folded}>
          <div className="truncate text-[13px] font-semibold text-fog" title={run.goal}>
            {run.goal}
          </div>
          <div className="text-[11px] text-fog/50" data-task-summary="1">
            {t("{done} of {n} done", { done, n: run.rows.length })}
            {waiting > 0 && <> · <span className="text-warn">{t("{n} waiting for you", { n: waiting })}</span></>}
            {usd > 0 && <> · ${usd.toFixed(4)}</>}
            {!active && <> · {t("finished")}</>}
          </div>
        </button>
        {waiting > 0 && (
          <button className={btn + " border-warn/50 text-warn"} onClick={() => onApprove(run.id)} data-task-approve-all="1">
            {waiting === 1 ? t("Approve") : t("Approve all {n}", { n: waiting })}
          </button>
        )}
        {!active && done > 0 && !run.taskId && onSaveRun && (
          <button className={btn + " border-accent/50 text-accent"} onClick={() => onSaveRun(run)} data-task-save="1">
            {t("Save as a task")}
          </button>
        )}
        {active ? (
          <button className={btn} onClick={() => onStop(run.id)} data-task-stop="1">
            {t("Stop")}
          </button>
        ) : (
          <button className={btn} onClick={onClear} data-task-clear="1">
            {t("Clear")}
          </button>
        )}
        <button className="px-1 text-fog/40 hover:text-fog" onClick={() => setFolded((v) => !v)} aria-label={folded ? t("Show") : t("Hide")}>
          {folded ? "▴" : "▾"}
        </button>
      </header>
      {!folded && trial && trial.runId === run.id && !active && (
        <TrialBanner run={run} rest={trial.rest} onContinue={() => onContinue?.(run.id)} onDismiss={() => onDismissTrial?.(run.id)} />
      )}
      {!folded && (
        <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto">
          {run.rows.map((row) => (
            <Row
              key={row.profileId}
              row={row}
              open={open === row.profileId}
              onToggle={() => setOpen((o) => (o === row.profileId ? null : row.profileId))}
              onApprove={() => onApprove(run.id, row.profileId)}
              onCancel={() => onCancel(run.id, row.profileId)}
              onStop={() => onStop(run.id, row.profileId)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({
  row,
  open,
  onToggle,
  onApprove,
  onCancel,
  onStop,
}: {
  row: SyncRow;
  open: boolean;
  onToggle: () => void;
  onApprove: () => void;
  onCancel: () => void;
  onStop: () => void;
}) {
  const st = STATUS[row.status] ?? STATUS.failed;
  const last = row.steps[row.steps.length - 1];
  const live = !["done", "blocked", "needs_input", "budget", "failed", "cancelled", "stopped"].includes(row.status);
  return (
    <li className="px-3 py-2" data-task-row={row.profileId} data-status={row.status}>
      <div className="flex items-center gap-2">
        <button className="min-w-0 flex-1 truncate text-left text-[13px] text-fog" onClick={onToggle} aria-expanded={open}>
          {row.name}
        </button>
        {row.skill && <span className="text-[10px] text-fog/40">{t(SKILL[row.skill] ?? row.skill)}</span>}
        <span className={"rounded-full px-2 py-0.5 text-[10px] font-semibold " + st.cls}>{t(st.label)}</span>
        {live && row.status !== "waiting_approval" && (
          <button className="px-1 text-[11px] text-fog/40 hover:text-danger" onClick={onStop} aria-label={t("Stop")} title={t("Stop")}>
            ■
          </button>
        )}
      </div>
      {row.status === "waiting_approval" && row.pending && (
        <div className="mt-1.5 flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-fog/70">
            {t("Next: {action}", { action: `${row.pending.kind ?? "click"} “${row.pending.label}”` })}
          </span>
          <button className={btn + " border-warn/50 text-warn"} onClick={onApprove} data-task-approve={row.profileId}>
            {t("Approve")}
          </button>
          <button className={btn} onClick={onCancel} data-task-cancel={row.profileId}>
            {t("Don't")}
          </button>
        </div>
      )}
      {row.status !== "waiting_approval" && (row.detail || last) && (
        <div className="mt-0.5 truncate text-[11px] text-fog/45" title={row.detail || undefined}>
          {row.detail || `${last!.kind} “${last!.action}”${last!.text ? ` ← ${last!.text}` : ""}`}
        </div>
      )}
      {open && row.steps.length > 0 && (
        <ol className="mt-1.5 space-y-0.5 border-l border-line pl-2 font-mono text-[11px] text-fog/60">
          {row.steps.map((s, i) => (
            <li key={i} className="truncate">
              {i + 1}. {s.kind} “{s.action}”{s.text ? ` ← ${s.text}` : ""}
              <span className="text-fog/35"> {s.replayed ? t("replayed") : s.probability != null ? `p=${s.probability.toFixed(2)}` : ""}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

/** After a trial on one profile: offer the rest when it worked, say what to do when it did not. */
function TrialBanner({ run, rest, onContinue, onDismiss }: { run: SyncRun; rest: number; onContinue: () => void; onDismiss: () => void }) {
  const row = run.rows[0];
  const ok = row?.status === "done";
  return (
    <div className={"flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5 text-xs " + (ok ? "bg-ok/5" : "bg-warn/5")} data-task-trial={ok ? "ok" : "failed"}>
      <span className="min-w-0 flex-1 text-fog/75">
        {ok
          ? rest === 1
            ? t("It worked on {name}. Jet saved the task, so the other profile repeats it without the model.", { name: row.name })
            : t("It worked on {name}. Jet saved the task, so the other {n} repeat it without the model.", { name: row.name, n: rest })
          : t("It did not finish on {name}. Open the row to see the last steps, then change the task and try again.", { name: row?.name ?? "" })}
      </span>
      {ok ? (
        <button className="rounded-md bg-sheen px-2.5 py-1 text-[11px] font-semibold text-[#07080a]" onClick={onContinue} data-task-continue="1">
          {rest === 1 ? t("Run on the other profile") : t("Run on the other {n}", { n: rest })}
        </button>
      ) : (
        <button className={btn} onClick={onContinue} data-task-continue="1">
          {t("Run on the others anyway")}
        </button>
      )}
      <button className="px-1 text-fog/40 hover:text-fog" onClick={onDismiss} aria-label={t("Dismiss")}>
        ✕
      </button>
    </div>
  );
}
