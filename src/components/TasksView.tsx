"use client";

// Saved tasks, as a page: every task that worked once and can run again without the model. The list on the
// left, the chosen task on the right: its recipe (goal with {{values}}, start page, how it runs), the values
// it asks for (changed here, saved as you type, which is how people try a task with other values), what Jet
// did the last time it finished, and its runs, each of which can run again with the same values.
// With no tasks yet, and under "Browse examples" later, a gallery of examples (src/lib/taskExamples.ts) shows
// what Jet can do; a card opens Run a task with it. Under the saved tasks, "Suggested" keeps a few examples in
// view (the featured ones not saved yet; with a search, the examples it matches), folded away on request.
// Saving goes through onSave (electron/tasks.ts normalizes and stores it); the page owns undo for delete.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SavedTask, TaskParam, StepSummary } from "@/lib/ipc";
import { t, useLocale } from "@/lib/i18n";
import { relativeTime } from "@/lib/profileList";
import { BUILTIN_SLOTS, looksSecret, templateSlots } from "../../electron/jetslots";
import StepTimeline, { SlotText } from "./StepTimeline";
import StepEditor from "./StepEditor";
import { ExampleGallery } from "./TaskExamples";
import { TASK_EXAMPLES, suggestedExamples, type TaskExample } from "@/lib/taskExamples";

/** Whether "Suggested" is folded away, remembered on this computer (best effort). */
const SUGGEST_KEY = "clearcote.tasks.suggested";

const ghost = "rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-fog/80 hover:bg-elevate transition disabled:opacity-40";
const primary = "rounded-lg bg-sheen px-3.5 py-1.5 text-[12px] font-semibold text-[#07080a] disabled:opacity-40";
const head = "text-[10px] font-semibold uppercase tracking-[0.08em] text-fog/40";
const input =
  "w-full rounded-lg border border-line bg-ink/70 px-3 py-2 text-sm text-fog outline-none placeholder:text-fog/30 focus:border-accent/60 focus:ring-1 focus:ring-accent/40";
const cell =
  "w-full min-w-0 rounded-md border border-line bg-ink/70 px-2 py-1 text-xs text-fog outline-none placeholder:text-fog/25 focus:border-accent/60";
const label = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-fog/45";

/** A slot that looks like a password is secret by default (as in the Run a task dialog). */

const BUILTIN: readonly string[] = BUILTIN_SLOTS;

/** One row per slot of the goal, from the task's saved params where it has one. */
function mergeParams(goal: string, params: TaskParam[]): TaskParam[] {
  return templateSlots(goal).map(
    (name) => params.find((p) => p.name === name) ?? { name, source: "profile" as const, ...(looksSecret(name) ? { secret: true } : {}) }
  );
}

function ago(at: number): string {
  return relativeTime(new Date(at).toISOString()) ?? "";
}

function goodUrl(u: string): boolean {
  const s = u.trim();
  if (!s) return true;
  try {
    const x = new URL(s);
    return (x.protocol === "http:" || x.protocol === "https:") && !!x.hostname;
  } catch {
    return false;
  }
}

export default function TasksView(props: {
  tasks: SavedTask[];
  /** How many profiles are selected right now (Run uses them; 0 means the dialog asks). */
  selectedCount: number;
  /** Open Run a task prefilled with this task. */
  onRun: (task: SavedTask) => void;
  /** Create or update; resolves to the saved task. */
  onSave: (task: Partial<SavedTask>) => Promise<SavedTask>;
  onDelete: (task: SavedTask) => void;
  /** Start a new task from scratch (opens Run a task empty). */
  onNew: () => void;
  /** Open Run a task prefilled with an example. */
  onExample: (example: TaskExample) => void;
  /** The steps a task replays can be read and edited here (a backend that has tasks.steps). */
  canEditSteps?: boolean;
}) {
  const { tasks, onNew, onExample } = props;
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const locale = useLocale();
  const [suggestOpen, setSuggestOpenState] = useState(() => {
    try {
      return localStorage.getItem(SUGGEST_KEY) !== "hidden";
    } catch {
      return true;
    }
  });
  const setSuggestOpen = (open: boolean) => {
    setSuggestOpenState(open);
    try {
      localStorage.setItem(SUGGEST_KEY, open ? "shown" : "hidden");
    } catch {
      /* not remembered: still works for this page */
    }
  };

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return tasks;
    return tasks.filter((x) => `${x.name} ${x.goal} ${x.url ?? ""}`.toLowerCase().includes(s));
  }, [tasks, q]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the locale changes the translated titles a search matches
  const suggested = useMemo(() => suggestedExamples(tasks, q, t), [tasks, q, locale]);
  const task = tasks.find((x) => x.id === picked) ?? shown[0] ?? null;

  if (tasks.length === 0) {
    return (
      <div data-tasks-view="empty">
        <div className="mt-10 text-center">
          <p className="text-base font-semibold">{t("No saved tasks yet")}</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-fog/50">
            {t("Save a task after it worked, or create one here. A saved task runs again without the model.")}
          </p>
          <button className={primary + " mt-4"} onClick={onNew} data-task-new="1">
            {t("New task")}
          </button>
        </div>
        <div className="mt-10">
          <h3 className="mb-1 text-sm font-semibold text-fog">{t("Or start from an example")}</h3>
          <ExampleGallery onPick={onExample} />
        </div>
      </div>
    );
  }

  return (
    <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]" data-tasks-view={tasks.length}>
      <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface/70 lg:max-h-[calc(100vh-11rem)]">
        <div className="flex items-center gap-2 border-b border-line p-2">
          <input
            className="min-w-0 flex-1 rounded-lg border border-line bg-ink/70 px-3 py-1.5 text-sm text-fog placeholder-fog/30 outline-none focus:border-accent/60"
            placeholder={t("Search tasks…")}
            aria-label={t("Search tasks")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className={ghost} onClick={onNew} data-task-new="1">
            {t("New task")}
          </button>
        </div>
        <button
          className={
            "flex items-center gap-2 border-b border-line px-3 py-2 text-left text-[12px] font-medium transition " +
            (browsing ? "bg-accent/10 text-fog" : "text-accent hover:bg-elevate")
          }
          onClick={() => setBrowsing((v) => !v)}
          aria-pressed={browsing}
          data-task-examples="1"
        >
          <span className="flex-1">{t("Browse examples ({n})", { n: TASK_EXAMPLES.length })}</span>
          <span aria-hidden="true" className="text-fog/40">
            {browsing ? "‹" : "›"}
          </span>
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ul className="divide-y divide-line" aria-label={t("Saved tasks")}>
            {shown.map((x) => (
              <TaskItem
                key={x.id}
                task={x}
                active={!browsing && task?.id === x.id}
                onPick={() => {
                  setPicked(x.id);
                  setBrowsing(false);
                }}
              />
            ))}
            {shown.length === 0 && <li className="px-3 py-6 text-center text-xs text-fog/40">{t("No task matches “{q}”.", { q: q.trim() })}</li>}
          </ul>
          {suggested.length > 0 && (
            <section className="border-t border-line" aria-label={t("Suggested examples")} data-task-suggested={suggested.length}>
              <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
                <button
                  className={head + " flex-1 text-left hover:text-fog/70"}
                  onClick={() => setSuggestOpen(!suggestOpen)}
                  aria-expanded={suggestOpen}
                  data-task-suggested-toggle="1"
                >
                  {q.trim() ? t("Examples matching “{q}”", { q: q.trim() }) : t("Suggested")} {suggestOpen ? "▾" : "▸"}
                </button>
                <button className="text-[11px] text-accent hover:underline" onClick={() => setBrowsing(true)} data-task-suggested-all="1">
                  {t("See all {n}", { n: TASK_EXAMPLES.length })}
                </button>
              </div>
              {suggestOpen && (
                <ul className="pb-1.5">
                  {suggested.map((ex) => (
                    <li key={ex.id}>
                      <button className="block w-full px-3 py-2 text-left transition hover:bg-elevate" onClick={() => onExample(ex)} data-task-suggestion={ex.id}>
                        <div className="truncate text-[12px] font-medium text-fog/80">{t(ex.title)}</div>
                        <SlotText text={ex.goal} className="mt-0.5 line-clamp-1 text-[11px] text-fog/45" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
        <div className="border-t border-line px-3 py-1.5 text-[11px] text-fog/40">
          {tasks.length === 1 ? t("1 task") : t("{n} tasks", { n: tasks.length })}
        </div>
      </aside>

      {browsing ? (
        <section className="min-w-0 rounded-xl border border-line bg-surface/70 px-4 py-3" aria-label={t("Examples")}>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="flex-1 text-base font-semibold text-fog">{t("Examples")}</h2>
            <button className={ghost} onClick={() => setBrowsing(false)}>
              {t("Close")}
            </button>
          </div>
          <ExampleGallery onPick={onExample} />
        </section>
      ) : task ? (
        <Detail key={task.id} {...props} task={task} onPicked={(id) => setPicked(id)} />
      ) : (
        <div className="rounded-xl border border-line bg-surface/70 p-6 text-center text-sm text-fog/45">{t("Pick a task on the left.")}</div>
      )}
    </div>
  );
}

function lastRunLine(task: SavedTask) {
  const h = task.history[0];
  if (!h) return <span className="text-fog/35">{t("Not run yet")}</span>;
  const ok = h.total > 0 && h.done === h.total;
  return (
    <span>
      <span className={ok ? "text-ok" : "text-warn"}>{t("{done} of {n} done", { done: h.done, n: h.total })}</span>
      <span className="text-fog/40"> · {ago(h.at)}</span>
    </span>
  );
}

function TaskItem({ task, active, onPick }: { task: SavedTask; active: boolean; onPick: () => void }) {
  const runs = task.history.length;
  return (
    <li data-task-item={task.id}>
      <button
        className={"block w-full px-3 py-2.5 text-left transition " + (active ? "bg-accent/10" : "hover:bg-elevate")}
        onClick={onPick}
        aria-current={active ? "true" : undefined}
      >
        <div className="truncate text-[13px] font-medium text-fog">{task.name}</div>
        <SlotText text={task.goal} className="mt-0.5 line-clamp-2 text-[11px] text-fog/55" />
        <div className="mt-1 flex items-center gap-2 text-[11px]">
          {lastRunLine(task)}
          <span className="flex-1" />
          {runs > 0 && <span className="text-fog/35">{runs === 1 ? t("1 run") : t("{n} runs", { n: runs })}</span>}
        </div>
      </button>
    </li>
  );
}

function Detail({
  task,
  selectedCount,
  onRun,
  onSave,
  onDelete,
  onPicked,
  canEditSteps,
}: {
  task: SavedTask;
  selectedCount: number;
  onRun: (task: SavedTask) => void;
  onSave: (task: Partial<SavedTask>) => Promise<SavedTask>;
  onDelete: (task: SavedTask) => void;
  onPicked: (id: string) => void;
  canEditSteps?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const duplicate = async () => {
    setErr(null);
    setBusy(true);
    try {
      const copy = await onSave({
        name: t("{name} (copy)", { name: task.name }),
        goal: task.goal,
        url: task.url,
        params: task.params,
        confirm: task.confirm,
        concurrency: task.concurrency,
        staggerSec: task.staggerSec,
        closeWhenDone: task.closeWhenDone,
      });
      onPicked(copy.id);
    } catch (e) {
      setErr(t("Could not copy the task: {msg}", { msg: (e as Error)?.message ?? String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const params = useRef<ParamsControl | null>(null);

  return (
    <section className="min-w-0 rounded-xl border border-line bg-surface/70" aria-label={task.name} data-task-detail={task.id}>
      {editing ? (
        <EditForm
          task={task}
          onCancel={() => setEditing(false)}
          onSave={async (patch) => {
            await onSave({ ...task, ...patch, params: mergeParams(patch.goal, task.params) });
            setEditing(false);
          }}
        />
      ) : (
        <>
          <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-fog" title={task.name}>
              {task.name}
            </h2>
            <button className={ghost} onClick={() => setEditing(true)} data-task-edit="1">
              {t("Edit")}
            </button>
            <button className={ghost} onClick={duplicate} disabled={busy} data-task-duplicate="1">
              {t("Duplicate")}
            </button>
            <button
              className={ghost + " hover:border-danger/50 hover:text-danger"}
              onClick={() => {
                params.current?.cancel();
                onDelete(task);
              }}
              data-task-delete="1"
            >
              {t("Delete")}
            </button>
            <button
              className={primary}
              onClick={() => {
                const waiting = params.current?.flush();
                onRun(waiting ? { ...task, params: waiting } : task);
              }}
              data-task-run="1"
            >
              {selectedCount > 0 ? t("Run on {n} selected", { n: selectedCount }) : t("Run…")}
            </button>
          </header>
          {err && (
            <div role="alert" className="mx-4 mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
              {err}
            </div>
          )}
          <Recipe task={task} />
          <Params task={task} onSave={onSave} control={params} />
        </>
      )}

      <div className="border-t border-line px-4 py-3">
        <h3 className={head + " mb-2"}>{t("What Jet did")}</h3>
        {canEditSteps && <StepEditor key={task.id} taskId={task.id} hasUrl={!!task.url} />}
        <StepTimeline steps={task.steps ?? ([] as StepSummary[])} from={task.stepsFrom} />
      </div>

      <History task={task} onRun={onRun} />
    </section>
  );
}

function Recipe({ task }: { task: SavedTask }) {
  const pacing: string[] = [];
  const n = task.concurrency ?? 1;
  pacing.push(n === 1 ? t("one at a time") : t("{n} at a time", { n }));
  if (task.staggerSec && (task.staggerSec[0] > 0 || task.staggerSec[1] > 0)) {
    pacing.push(t("waits {min}–{max} s between starts", { min: task.staggerSec[0], max: task.staggerSec[1] }));
  }
  if (task.closeWhenDone) pacing.push(t("closes the browser when done"));
  return (
    <div className="px-4 py-3">
      <h3 className={head + " mb-2"}>{t("Recipe")}</h3>
      <SlotText text={task.goal} className="block whitespace-pre-wrap text-[13px] leading-relaxed text-fog" />
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12px]">
        <dt className="text-fog/45">{t("Start page")}</dt>
        <dd className="truncate font-mono text-[11px] text-fog/75" title={task.url}>
          {task.url || <span className="font-sans text-fog/35">{t("The page that is open")}</span>}
        </dd>
        <dt className="text-fog/45">{t("Asks before a final click")}</dt>
        <dd className={task.confirm ? "text-ok" : "text-fog/60"}>{task.confirm ? t("Yes") : t("No")}</dd>
        <dt className="text-fog/45">{t("Pacing")}</dt>
        <dd className="text-fog/70">{pacing.join(" · ")}</dd>
      </dl>
    </div>
  );
}

/** The values a task asks for, saved as they change (400 ms after the last keystroke). */
/** What the task's header needs from the values pane: save edits still waiting now, or drop them. */
interface ParamsControl {
  /** Saves what is waiting and returns it (null when nothing is). */
  flush(): TaskParam[] | null;
  cancel(): void;
}

function Params({
  task,
  onSave,
  control,
}: {
  task: SavedTask;
  onSave: (task: Partial<SavedTask>) => Promise<SavedTask>;
  control: React.MutableRefObject<ParamsControl | null>;
}) {
  const [rows, setRows] = useState<TaskParam[]>(() => mergeParams(task.goal, task.params));
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const latest = useRef(task);
  latest.current = task;
  const save = useRef(onSave);
  save.current = onSave;
  const pending = useRef<TaskParam[] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uid = useId();

  const flush = (): TaskParam[] | null => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next) return null;
    setSaved("saving");
    save
      .current({ ...latest.current, params: next })
      .then(() => setSaved("saved"))
      .catch(() => setSaved("error"));
    return next;
  };
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  };
  control.current = { flush, cancel };
  // A change still waiting is saved when the pane goes (another task picked, Edit opened); a deleted task
  // was cancelled first, so it is not saved back.
  useEffect(() => () => void flush(), []); // eslint-disable-line react-hooks/exhaustive-deps
  // The task changed elsewhere (Run a task saved it, a run was recorded): follow it unless an edit is waiting.
  useEffect(() => {
    if (!pending.current) setRows(mergeParams(task.goal, task.params));
  }, [task.goal, task.params]);

  const change = (name: string, patch: Partial<TaskParam>) => {
    const next = rows.map((p) => {
      if (p.name !== name) return p;
      const r: TaskParam = { ...p, ...patch };
      if (r.secret || r.source !== "run") delete r.default;
      if (!r.hint) delete r.hint;
      if (!r.secret) delete r.secret;
      return r;
    });
    setRows(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 400);
  };

  return (
    <div className="border-t border-line px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className={head}>{t("Values it asks for")}</h3>
        <span className="flex-1" />
        <span className="text-[10px] text-fog/35" aria-live="polite">
          {saved === "saving" ? t("Saving…") : saved === "saved" ? t("Saved") : saved === "error" ? <span className="text-danger">{t("Not saved")}</span> : null}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-fog/45">{t("This task asks for nothing: it does the same thing on every profile.")}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((p) => {
            const builtin = BUILTIN.includes(p.name);
            const id = `${uid}-${p.name}`;
            return (
              <li key={p.name} className="rounded-lg border border-line px-3 py-2.5" data-task-param={p.name}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded border border-iris/40 bg-iris/10 px-1.5 py-px font-mono text-[12px] text-iris">{`{{${p.name}}}`}</span>
                  {builtin ? (
                    <span className="text-[11px] text-fog/45">
                      {p.name === "otp" ? t("The profile's 2FA code, worked out when it is typed") : t("Comes from the profile itself")}
                    </span>
                  ) : (
                    <div role="radiogroup" aria-label={t("Where {slot} comes from", { slot: `{{${p.name}}}` })} className="inline-flex overflow-hidden rounded-lg border border-line text-[11px]">
                      {(["profile", "run"] as const).map((src) => (
                        <button
                          key={src}
                          role="radio"
                          aria-checked={p.source === src}
                          className={"px-2.5 py-1 transition " + (p.source === src ? "bg-accent/15 text-accent" : "text-fog/60 hover:bg-elevate")}
                          onClick={() => change(p.name, { source: src })}
                          data-param-source={src}
                        >
                          {src === "profile" ? t("Each profile's own value") : t("Same for every profile, asked when it runs")}
                        </button>
                      ))}
                    </div>
                  )}
                  <span className="flex-1" />
                  {!builtin && (
                    <label className="inline-flex items-center gap-1.5 text-[11px] text-fog/60">
                      <input type="checkbox" className="accent-[#38e0d6]" checked={!!p.secret} onChange={(e) => change(p.name, { secret: e.target.checked })} data-param-secret="1" />
                      {t("Secret")}
                    </label>
                  )}
                </div>
                {!builtin && (
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {p.source === "run" && !p.secret && (
                      <div>
                        <label htmlFor={`${id}-def`} className="mb-0.5 block text-[10px] text-fog/40">
                          {t("Default value")}
                        </label>
                        <input id={`${id}-def`} className={cell} value={p.default ?? ""} placeholder={t("Typed when it runs")} onChange={(e) => change(p.name, { default: e.target.value })} data-param-default="1" />
                      </div>
                    )}
                    <div className={p.source === "run" && !p.secret ? "" : "sm:col-span-2"}>
                      <label htmlFor={`${id}-hint`} className="mb-0.5 block text-[10px] text-fog/40">
                        {t("Hint")}
                      </label>
                      <input id={`${id}-hint`} className={cell} value={p.hint ?? ""} maxLength={200} placeholder={t("For example: the search words")} onChange={(e) => change(p.name, { hint: e.target.value })} data-param-hint="1" />
                    </div>
                  </div>
                )}
                {p.secret && !builtin && <p className="mt-1.5 text-[10px] text-fog/40">{t("Typed only: never saved with the task or shown to the model.")}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function EditForm({
  task,
  onCancel,
  onSave,
}: {
  task: SavedTask;
  onCancel: () => void;
  onSave: (patch: { name: string; goal: string; url?: string; confirm: boolean }) => Promise<void>;
}) {
  const [name, setName] = useState(task.name);
  const [goal, setGoal] = useState(task.goal);
  const [url, setUrl] = useState(task.url ?? "");
  const [confirm, setConfirm] = useState(task.confirm);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const uid = useId();
  const urlBad = !goodUrl(url);
  const can = !!goal.trim() && !urlBad && !busy;

  const submit = async () => {
    if (!can) return;
    setErr(null);
    setBusy(true);
    try {
      await onSave({ name: name.trim(), goal: goal.trim(), url: url.trim() || undefined, confirm });
    } catch (e) {
      setErr(t("Could not save the task: {msg}", { msg: (e as Error)?.message ?? String(e) }));
      setBusy(false);
    }
  };

  return (
    <form
      className="border-b border-line px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      data-task-editing="1"
    >
      <div>
        <label htmlFor={`${uid}-name`} className={label}>
          {t("Name")}
        </label>
        <input id={`${uid}-name`} className={input} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="mt-3">
        <label htmlFor={`${uid}-goal`} className={label}>
          {t("What to do")}
        </label>
        <textarea id={`${uid}-goal`} className={input + " min-h-[90px] resize-y"} value={goal} onChange={(e) => setGoal(e.target.value)} />
        <p className="mt-1 text-[11px] text-fog/40">
          {templateSlots(goal).length
            ? t("Asks for: {slots}", { slots: templateSlots(goal).join(", ") })
            : t("Write a value it should ask for in double braces, like {example}.", { example: "{{email}}" })}
        </p>
      </div>
      <div className="mt-3">
        <label htmlFor={`${uid}-url`} className={label}>
          {t("Start page")}
        </label>
        <input
          id={`${uid}-url`}
          className={input + (urlBad ? " border-danger/60" : "")}
          value={url}
          placeholder="https://"
          onChange={(e) => setUrl(e.target.value)}
          aria-invalid={urlBad || undefined}
        />
        <p className={"mt-1 text-[11px] " + (urlBad ? "text-danger" : "text-fog/40")}>
          {urlBad ? t("Use an address that starts with http:// or https://, or leave it empty.") : t("Empty: it starts on the page that is open.")}
        </p>
      </div>
      <label className="mt-3 flex items-start gap-2.5 rounded-lg border border-line px-3 py-2.5 text-sm text-fog/80">
        <input type="checkbox" className="mt-0.5 accent-[#38e0d6]" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
        <span>{t("Ask me before a click that can't be undone (sending, buying, deleting)")}</span>
      </label>
      {err && (
        <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
          {err}
        </div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className={ghost} onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button type="submit" className={primary} disabled={!can} data-task-save="1">
          {busy ? t("Saving…") : t("Save")}
        </button>
      </div>
    </form>
  );
}

function History({ task, onRun }: { task: SavedTask; onRun: (task: SavedTask) => void }) {
  const secret = new Set(task.params.filter((p) => p.secret).map((p) => p.name));
  return (
    <div className="border-t border-line px-4 py-3" data-task-history={task.history.length}>
      <h3 className={head + " mb-2"}>{t("Runs")}</h3>
      {task.history.length === 0 ? (
        <p className="text-xs text-fog/45">{t("Not run yet.")}</p>
      ) : (
        <ul className="divide-y divide-line">
          {task.history.map((h, i) => {
            const ok = h.total > 0 && h.done === h.total;
            const vals = Object.entries(h.params ?? {}).filter(([k]) => !secret.has(k));
            return (
              <li key={`${h.at}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 text-[12px]" data-task-run-entry={i}>
                <span className="w-24 shrink-0 text-fog/55" title={new Date(h.at).toLocaleString()}>
                  {ago(h.at)}
                </span>
                <span className={"shrink-0 font-medium " + (ok ? "text-ok" : "text-warn")}>{t("{done} of {n} done", { done: h.done, n: h.total })}</span>
                {h.usd != null && h.usd > 0 && <span className="shrink-0 font-mono text-[11px] text-fog/40">${h.usd.toFixed(4)}</span>}
                <span className="flex min-w-0 flex-1 flex-wrap gap-1">
                  {vals.map(([k, v]) => (
                    <span key={k} className="max-w-[16rem] truncate rounded-md border border-line bg-ink/70 px-1.5 py-px font-mono text-[10px] text-fog/70" title={`${k} = ${v}`}>
                      <span className="text-iris">{k}</span> = {v}
                    </span>
                  ))}
                </span>
                <button
                  className={ghost}
                  onClick={() =>
                    onRun({
                      ...task,
                      params: task.params.map((p) => (p.source === "run" && !p.secret && h.params?.[p.name] !== undefined ? { ...p, default: h.params[p.name] } : p)),
                    })
                  }
                  data-task-run-again={i}
                >
                  {vals.length ? t("Run again with these values") : t("Run again")}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
