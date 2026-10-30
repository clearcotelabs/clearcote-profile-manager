"use client";

// "Run a task…" on the selected profiles. Jet works the task out in the first profile and replays it on
// the rest with no model calls, each profile with its own mouse path and timing (electron/jetsync.ts).
//
// Made to work without reading docs:
// - Jet setup (Python, Jet, model key) is a checklist at the top until it is ready (JetSetup).
// - Examples (src/lib/taskExamples.ts) fill the task in one click, a few as chips and the rest under
//   "More examples…"; chips insert a {{value}} at the cursor.
// - A value a profile lacks is typed right here, in a grid, and saved to that profile's task values on Run,
//   instead of a trip to each profile's editor.
// - "Try it on the first profile" (on by default for more than one) runs one profile; the run board then
//   offers the rest once it worked (onTrial).
// - A value can be "the same for every profile" for this run (a search term, a date) instead of each
//   profile's own; those are run values, never written to the profiles.
// - Opened from a saved task, everything is prefilled; "Save as a task" keeps the recipe for next time and
//   the run is recorded into it (steps and history, electron/tasks.ts).

import { useId, useMemo, useRef, useState } from "react";
import Dialog, { DialogFooter, DialogHeader } from "./Dialog";
import JetSetup from "./JetSetup";
import { ExamplePicker } from "./TaskExamples";
import type { Profile, ProfileVar } from "@/types/profile";
import { api, type SavedTask, type Settings, type StartRequest, type TaskParam } from "@/lib/ipc";
import { looksSecret, profileValues, templateSlots, valuesFor } from "../../electron/jetslots";
import { t, tRich } from "@/lib/i18n";
import { FEATURED_EXAMPLES, exampleById, type TaskExample } from "@/lib/taskExamples";

const input =
  "w-full rounded-lg border border-line bg-ink/70 px-3 py-2 text-sm text-fog outline-none placeholder:text-fog/30 focus:border-accent/60 focus:ring-1 focus:ring-accent/40";
const cell =
  "w-full min-w-0 rounded-md border border-line bg-ink/70 px-2 py-1 text-xs text-fog outline-none placeholder:text-fog/25 focus:border-accent/60";
const label = "block text-[11px] font-medium uppercase tracking-wide text-fog/45 mb-1";
const btnGhost = "rounded-lg border border-line-strong px-3.5 py-1.5 text-sm text-fog/80 hover:bg-elevate";
const btnPrimary = "rounded-lg bg-sheen px-4 py-1.5 text-sm font-semibold text-[#07080a] disabled:opacity-40";
const chip = "rounded-md border border-line px-2 py-0.5 font-mono text-[11px] text-fog/70 hover:border-accent/50 hover:text-fog";

/** The profile with the values typed in the dialog added to (or replacing) its task values. */
export function withFills(p: Profile, fills: Record<string, string> | undefined, secret: Set<string>): Profile {
  if (!fills) return p;
  const vars: ProfileVar[] = [...(p.vars ?? [])];
  for (const [key, value] of Object.entries(fills)) {
    if (!value.trim()) continue;
    const i = vars.findIndex((v) => v.key === key);
    const v: ProfileVar = { key, value, ...(secret.has(key) ? { secret: true } : {}) };
    if (i >= 0) vars[i] = v;
    else vars.push(v);
  }
  return { ...p, vars };
}

/** An example's "same for every profile" slots, as dialog modes. */
function sameForAll(ex: TaskExample | undefined): Record<string, TaskParam["source"]> {
  return Object.fromEntries((ex?.same ?? []).map((s) => [s, "run" as const]));
}

export default function RunTaskDialog({
  profiles: selected,
  allProfiles,
  task,
  example,
  settings,
  onStart,
  onSaveProfiles,
  onSaveSettings,
  onTrial,
  onSaveTask,
  onOpenSettings,
  onClose,
}: {
  /** The selected profiles, in the order they will start (may be empty: then pick here). */
  profiles: Profile[];
  /** Every profile, to pick from. */
  allProfiles: Profile[];
  /** Prefill from this saved task (Tasks page -> Run). */
  task?: SavedTask;
  /** Prefill from this example (Tasks page -> an example card). Ignored with a task. */
  example?: TaskExample;
  /** Create or update a saved task. */
  onSaveTask: (t: Partial<SavedTask>) => Promise<SavedTask>;
  settings: Settings;
  onStart: (req: StartRequest) => Promise<{ ok: true; runId: string } | { ok: false; error: string }>;
  /** Save profiles whose task values were typed in this dialog. */
  onSaveProfiles: (list: Profile[]) => Promise<void>;
  onSaveSettings: (patch: Partial<Settings>) => Promise<void> | void;
  /** A trial run on the first profile started: the rest, to offer on the run board when it worked. */
  onTrial: (runId: string, rest: StartRequest) => void;
  /** Opens Settings → Tasks. */
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const ids = { goal: useId(), url: useId(), confirm: useId(), conc: useId(), smin: useId(), smax: useId(), close: useId(), trial: useId() };
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const from = task ? undefined : example;
  const [goal, setGoal] = useState(task?.goal ?? from?.goal ?? "");
  const [url, setUrl] = useState(task?.url ?? from?.url ?? "");
  const [confirm, setConfirm] = useState(task?.confirm ?? true);
  const [concurrency, setConcurrency] = useState(task?.concurrency ?? settings.syncConcurrency ?? 2);
  const [stagger, setStagger] = useState<[number, number]>(task?.staggerSec ?? settings.syncStaggerSec ?? [3, 20]);
  const [closeWhenDone, setCloseWhenDone] = useState(task?.closeWhenDone ?? false);
  const [chosen, setChosen] = useState<string[]>(selected.map((p) => p.id));
  const [picking, setPicking] = useState(selected.length === 0);
  const profiles = useMemo(() => chosen.map((id) => allProfiles.find((p) => p.id === id)).filter((p): p is Profile => !!p), [chosen, allProfiles]);
  // A task that already finished somewhere has been learned: no need to try it on one profile first.
  const learned = !!task?.history.some((h) => h.done > 0);
  const [trial, setTrial] = useState(selected.length > 1 && !learned);
  const [save, setSave] = useState(!!task);
  const [taskName, setTaskName] = useState(task?.name ?? (from ? t(from.title) : ""));
  /** Per slot: each profile's own value, or one value for the whole run. */
  const [mode, setMode] = useState<Record<string, TaskParam["source"]>>(() =>
    task ? Object.fromEntries(task.params.map((p) => [p.name, p.source])) : sameForAll(from),
  );
  const [browsing, setBrowsing] = useState(false);
  const [runVals, setRunVals] = useState<Record<string, string>>(() =>
    Object.fromEntries((task?.params ?? []).filter((p) => p.source === "run" && p.default).map((p) => [p.name, p.default as string])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Without the setup API (the browser preview) nothing can be checked, so nothing blocks.
  const [ready, setReady] = useState(!api.jetSetup);
  /** Values typed here: profile id → slot → value. */
  const [fills, setFills] = useState<Record<string, Record<string, string>>>({});
  /** Slots marked secret in the grid (default: the ones that look like passwords). */
  const [secretOverride, setSecretOverride] = useState<Record<string, boolean>>(() =>
    Object.fromEntries((task?.params ?? []).map((p) => [p.name, !!p.secret])),
  );

  const slots = useMemo(() => templateSlots(goal), [goal]);
  /** Secret by default: a slot that looks like a password, or one any of these profiles keeps secret. */
  const keptSecret = useMemo(() => new Set(profiles.flatMap((p) => (p.vars ?? []).filter((v) => v.secret).map((v) => v.key.trim()))), [profiles]);
  const isSecret = (s: string) => secretOverride[s] ?? (looksSecret(s) || keptSecret.has(s));
  const secretSet = useMemo(
    () => new Set(slots.filter((s) => secretOverride[s] ?? (looksSecret(s) || keptSecret.has(s)))),
    [slots, secretOverride, keptSecret],
  );
  /** Values typed in the grid that still apply: for a slot of this goal that each profile fills itself. A
   *  column that was renamed in the goal or switched to "same for all" is never written to the profiles. */
  const gridFor = (id: string) => {
    const f = fills[id];
    if (!f) return undefined;
    const kept = Object.fromEntries(Object.entries(f).filter(([k]) => slots.includes(k) && mode[k] !== "run"));
    return Object.keys(kept).length ? kept : undefined;
  };
  const runSlots = useMemo(() => slots.filter((s) => mode[s] === "run"), [slots, mode]);
  /** This run's own values (the slots set to "same for every profile"); never saved to a profile. */
  const params = useMemo(() => Object.fromEntries(runSlots.filter((s) => runVals[s]?.trim()).map((s) => [s, runVals[s]])), [runSlots, runVals]);
  /** The profiles with the values typed in the grid: what gets saved. */
  const filled = useMemo(() => profiles.map((p) => withFills(p, gridFor(p.id), secretSet)), [profiles, fills, secretSet, slots, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  /** ...and with this run's values on top: what the task sees. */
  const effective = useMemo(() => filled.map((p) => withFills(p, params, secretSet)), [filled, params, secretSet]);
  /** Before the grid: which profile lacks which per-profile slot (rows and columns stay put while typing). */
  const lacking = useMemo(
    () => profiles.map((p) => ({ p, missing: valuesFor(goal, p).missing.filter((m) => mode[m] !== "run") })).filter((x) => x.missing.length),
    [goal, profiles, mode],
  );
  const gridSlots = useMemo(() => slots.filter((s) => mode[s] !== "run" && lacking.some((x) => x.missing.includes(s))), [slots, lacking, mode]);
  const stillMissing = useMemo(() => effective.filter((p) => valuesFor(goal, p).missing.length).length, [effective, goal]);
  const runMissing = runSlots.filter((s) => !runVals[s]?.trim());
  const known = useMemo(() => {
    const keys = new Set<string>(["name"]);
    for (const p of profiles) for (const k of Object.keys(profileValues(p).values)) if (k !== "id") keys.add(k);
    return [...keys].slice(0, 12);
  }, [profiles]);

  const urlBad = !!url.trim() && url.trim() !== "https://" && !/^https?:\/\/\S+$/i.test(url.trim());
  const canStart = ready && !!goal.trim() && !urlBad && !busy && profiles.length > 0 && !runMissing.length && stillMissing < profiles.length;

  function insert(slot: string) {
    const el = goalRef.current;
    const token = `{{${slot}}}`;
    const at = el?.selectionStart ?? goal.length;
    const end = el?.selectionEnd ?? at;
    const next = goal.slice(0, at) + token + goal.slice(end);
    setGoal(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  }

  function pickExample(ex: TaskExample) {
    setGoal(ex.goal);
    if (!url.trim()) setUrl(ex.url);
    setMode((m) => ({ ...m, ...sameForAll(ex) }));
    setBrowsing(false);
    requestAnimationFrame(() => goalRef.current?.focus());
  }

  async function start() {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    try {
      const changed = filled.filter((p, i) => p !== profiles[i]);
      if (changed.length) await onSaveProfiles(changed);
      let taskId = task?.id;
      if (save) {
        const savedTask = await onSaveTask({
          ...(task ? { id: task.id } : {}),
          name: taskName.trim() || goal.trim().slice(0, 60),
          goal,
          url: url.trim() && url.trim() !== "https://" ? url.trim() : undefined,
          params: slots.map((s) => {
            const hint = task?.params.find((p) => p.name === s)?.hint;
            return {
              name: s,
              source: mode[s] === "run" ? ("run" as const) : ("profile" as const),
              ...(secretSet.has(s) ? { secret: true } : mode[s] === "run" && runVals[s]?.trim() ? { default: runVals[s] } : {}),
              ...(hint ? { hint } : {}),
            };
          }),
          confirm,
          concurrency,
          staggerSec: stagger,
          closeWhenDone,
        });
        taskId = savedTask.id;
      }
      const runnable = effective.filter((p) => !valuesFor(goal, p).missing.length).map((p) => p.id);
      const skipped = profiles.map((p) => p.id).filter((id) => !runnable.includes(id));
      const base: StartRequest = {
        profileIds: [...runnable, ...skipped],
        goal,
        url: url.trim() && url.trim() !== "https://" ? url.trim() : undefined,
        confirm,
        concurrency,
        staggerSec: stagger,
        closeWhenDone,
        ...(Object.keys(params).length ? { params, paramSecret: Object.keys(params).filter((k) => secretSet.has(k)) } : {}),
        // Secret for this run wherever the value comes from, a profile's own value too.
        ...(secretSet.size ? { secretSlots: [...secretSet] } : {}),
        ...(taskId ? { taskId } : {}),
      };
      const first = trial && runnable.length > 1;
      // The rest of a trial are the profiles that can run; the ones still missing a value were named above.
      const r = await onStart(first ? { ...base, profileIds: [runnable[0]] } : base);
      if (!r.ok) return setError(r.error);
      if (first) onTrial(r.runId, { ...base, profileIds: runnable.slice(1) });
      onClose();
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  }

  const n = profiles.length;
  const runnableCount = n - stillMissing;
  /** A trial needs one profile to try and at least one to go on to. */
  const trialOn = trial && runnableCount > 1;
  return (
    <Dialog onClose={onClose} labelledBy={titleId} className="max-h-[820px] max-w-2xl" initialFocus={goalRef}>
      <DialogHeader
        id={titleId}
        title={task ? t("Run “{name}”", { name: task.name }) : n === 1 ? t("Run a task on 1 profile") : t("Run a task on {n} profiles", { n })}
        onClose={onClose}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-run-task="1">
        <div className="mb-4">
          <JetSetup settings={settings} onSaveSettings={onSaveSettings} onReady={setReady} compact />
        </div>

        <div className="mb-4 rounded-lg border border-line px-3 py-2.5 text-xs" data-run-profiles={profiles.length}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-fog/70">
              {profiles.length === 0
                ? t("Choose the profiles to run it on:")
                : profiles.length <= 3
                  ? t("On: {names}", { names: profiles.map((p) => p.name).join(", ") })
                  : t("On {n} profiles: {names} and {more} more", { n: profiles.length, names: profiles.slice(0, 2).map((p) => p.name).join(", "), more: profiles.length - 2 })}
            </span>
            <button className="text-fog/50 hover:text-fog" onClick={() => setPicking((v) => !v)} data-run-pick="1">
              {picking ? t("Done") : t("Change")}
            </button>
          </div>
          {picking && (
            <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto">
              {allProfiles.map((p) => (
                <li key={p.id}>
                  <label className="flex items-center gap-2 rounded px-1 py-0.5 text-fog/75 hover:bg-elevate">
                    <input
                      type="checkbox"
                      className="accent-[#38e0d6]"
                      checked={chosen.includes(p.id)}
                      onChange={(e) => setChosen((c) => (e.target.checked ? [...c, p.id] : c.filter((x) => x !== p.id)))}
                      data-run-pick-profile={p.id}
                    />
                    <span className="truncate">{p.name}</span>
                    {p.group && <span className="text-fog/35">· {p.group}</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mb-1 flex items-end justify-between gap-3">
          <label htmlFor={ids.goal} className={label + " mb-0"}>
            {t("What should each profile do?")}
          </label>
          {!goal.trim() && (
            <div className="flex flex-wrap justify-end gap-1.5" data-run-examples="1">
              <span className="text-[11px] text-fog/40">{t("Examples:")}</span>
              {FEATURED_EXAMPLES.map(exampleById).map(
                (ex) =>
                  ex && (
                    <button key={ex.id} className="rounded-md bg-elevate px-2 py-0.5 text-[11px] text-fog/75 hover:text-fog" onClick={() => pickExample(ex)} data-example={ex.id}>
                      {t(ex.title)}
                    </button>
                  ),
              )}
              <button
                className="rounded-md px-1.5 py-0.5 text-[11px] text-accent/80 hover:text-accent"
                onClick={() => setBrowsing((v) => !v)}
                aria-expanded={browsing}
                data-run-more-examples="1"
              >
                {t("More examples…")}
              </button>
            </div>
          )}
        </div>
        {browsing && <ExamplePicker onPick={pickExample} onClose={() => setBrowsing(false)} />}
        <textarea
          id={ids.goal}
          ref={goalRef}
          className={input + " min-h-[80px] resize-y"}
          placeholder={t("Describe it as you would to a person, for example: Log in with {{email}} and the password {{password}}, then open Orders")}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          data-run-goal="1"
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-fog/40" data-run-chips="1">
          <span>{t("Different per profile? Insert a value:")}</span>
          {known.map((k) => (
            <button key={k} className={chip} onClick={() => insert(k)}>
              {`{{${k}}}`}
            </button>
          ))}
          <span>{tRich("or type your own, like {slot}.", { slot: <span className="font-mono">{"{{email}}"}</span> })}</span>
        </div>

        {slots.length > 0 && (
          <div className="mt-3 rounded-lg border border-line px-3 py-2.5 text-xs" aria-live="polite" data-run-slots="1">
            <div className="mb-2.5 space-y-1.5" data-run-sources="1">
              {slots.map((s) => {
                const run = mode[s] === "run";
                return (
                  <div key={s} className="flex flex-wrap items-center gap-2" data-run-source={s}>
                    <span className="w-28 shrink-0 truncate font-mono text-fog/75">{`{{${s}}}`}</span>
                    <div className="flex overflow-hidden rounded-md border border-line text-[11px]" role="group" aria-label={t("Where {slot} comes from", { slot: s })}>
                      <button
                        className={"px-2 py-0.5 " + (!run ? "bg-elevate text-fog" : "text-fog/45 hover:text-fog")}
                        aria-pressed={!run}
                        onClick={() => setMode((m) => ({ ...m, [s]: "profile" }))}
                      >
                        {t("Each profile's own")}
                      </button>
                      <button
                        className={"px-2 py-0.5 " + (run ? "bg-elevate text-fog" : "text-fog/45 hover:text-fog")}
                        aria-pressed={run}
                        onClick={() => setMode((m) => ({ ...m, [s]: "run" }))}
                        data-run-source-run={s}
                      >
                        {t("Same for all")}
                      </button>
                    </div>
                    {run && (
                      <>
                        <input
                          className={cell + " min-w-[8rem] flex-1" + (!runVals[s]?.trim() ? " border-warn/50" : "")}
                          aria-label={t("{slot} for every profile", { slot: s })}
                          type={isSecret(s) ? "password" : "text"}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder={task?.params.find((p) => p.name === s)?.hint ?? t("value for this run")}
                          value={runVals[s] ?? ""}
                          onChange={(e) => setRunVals((v) => ({ ...v, [s]: e.target.value }))}
                          data-run-value={s}
                        />
                        <label className="inline-flex items-center gap-1 text-[10px] text-fog/45">
                          <input type="checkbox" className="accent-[#38e0d6]" checked={isSecret(s)} onChange={(e) => setSecretOverride((o) => ({ ...o, [s]: e.target.checked }))} />
                          {t("secret")}
                        </label>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            {gridSlots.length === 0 ? (
              <div className="text-ok">{t("Every selected profile has a value for each.")}</div>
            ) : (
              <>
                <div className="mb-2 text-fog/65">
                  {lacking.length === 1
                    ? t("1 profile needs a value. Type it here; it is saved to the profile:")
                    : t("{n} profiles need values. Type them here; they are saved to each profile:", { n: lacking.length })}
                </div>
                <div className="max-h-56 overflow-auto">
                  <table className="w-full border-separate border-spacing-x-1.5 border-spacing-y-1" data-run-fill="1">
                    <thead>
                      <tr>
                        <th className="w-1/4 text-left font-normal text-fog/40">{t("Profile")}</th>
                        {gridSlots.map((s) => (
                          <th key={s} className="text-left font-normal">
                            <span className="font-mono text-fog/70">{`{{${s}}}`}</span>
                            <label className="ml-2 inline-flex items-center gap-1 text-[10px] text-fog/45">
                              <input
                                type="checkbox"
                                className="accent-[#38e0d6]"
                                checked={isSecret(s)}
                                onChange={(e) => setSecretOverride((o) => ({ ...o, [s]: e.target.checked }))}
                              />
                              {t("secret")}
                            </label>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {lacking.map(({ p, missing: m }) => (
                        <tr key={p.id}>
                          <td className="max-w-[10rem] truncate text-fog/75" title={p.name}>
                            {p.name}
                          </td>
                          {gridSlots.map((s) => (
                            <td key={s}>
                              {m.includes(s) ? (
                                <input
                                  className={cell}
                                  aria-label={t("{slot} for {name}", { slot: s, name: p.name })}
                                  type={isSecret(s) ? "password" : "text"}
                                  autoComplete="off"
                                  spellCheck={false}
                                  value={fills[p.id]?.[s] ?? ""}
                                  onChange={(e) => setFills((f) => ({ ...f, [p.id]: { ...f[p.id], [s]: e.target.value } }))}
                                  data-run-fill-cell={`${p.id}:${s}`}
                                />
                              ) : (
                                <span className="text-fog/30">{t("has one")}</span>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {stillMissing > 0 ? (
                  <div className="mt-2 text-warn" data-run-missing={stillMissing}>
                    {stillMissing === 1
                      ? t("1 profile still has an empty value and will be skipped.")
                      : t("{n} profiles still have an empty value and will be skipped.", { n: stillMissing })}
                  </div>
                ) : (
                  <div className="mt-2 text-ok">{t("Every selected profile has a value for each.")}</div>
                )}
              </>
            )}
            {secretSet.size > 0 && (
              <div className="mt-2 text-fog/45">{t("Secret values are typed only: Jet's model, the run board and the saved task see the name, never the value.")}</div>
            )}
          </div>
        )}

        <div className="mt-4">
          <label htmlFor={ids.url} className={label}>
            {t("Start page")}
          </label>
          <input
            id={ids.url}
            className={input + (urlBad ? " border-danger/60" : "")}
            placeholder="https://example.com/login"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            spellCheck={false}
            data-run-url="1"
          />
          <p className={"mt-1 text-[11px] " + (urlBad ? "text-danger" : "text-fog/40")}>
            {urlBad
              ? t("The start page must be an http or https address.")
              : t("Opened in a new tab in each profile. Empty: the task starts on the tab that is open. A saved task is matched to its start page, so keep it the same between runs.")}
          </p>
        </div>

        {runnableCount > 1 && (
          <label htmlFor={ids.trial} className="mt-4 flex items-start gap-2.5 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2.5 text-sm text-fog/80">
            <input id={ids.trial} type="checkbox" className="mt-0.5 accent-[#38e0d6]" checked={trial} onChange={(e) => setTrial(e.target.checked)} data-run-trial="1" />
            <span>
              {tRich("<b>Try it on {name} first</b> — Jet learns the task there. When it worked, the run board offers the other {n} in one click.", {
                b: (s) => <span className="font-medium text-fog">{s}</span>,
                name: effective.find((p) => !valuesFor(goal, p).missing.length)?.name ?? profiles[0]?.name ?? "",
                n: runnableCount - 1,
              })}
            </span>
          </label>
        )}

        <label htmlFor={ids.confirm} className="mt-3 flex items-start gap-2.5 rounded-lg border border-line px-3 py-2.5 text-sm text-fog/80">
          <input id={ids.confirm} type="checkbox" className="mt-0.5 accent-[#38e0d6]" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} data-run-confirm="1" />
          <span>
            {tRich("<b>Ask me before a click that can't be undone</b> — sending, buying, booking, deleting. Each profile waits there; approve them one by one or all at once.", {
              b: (s) => <span className="font-medium text-fog">{s}</span>,
            })}
          </span>
        </label>

        <details className="mt-3 rounded-lg border border-line px-3 py-2.5" data-run-pacing="1">
          <summary className="cursor-pointer select-none text-sm text-fog/70">
            {t("Pacing: {n} at a time, {a}–{b} s apart", { n: concurrency, a: stagger[0], b: stagger[1] })}
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor={ids.conc} className={label}>
                {t("At the same time")}
              </label>
              <input id={ids.conc} type="number" min={1} max={10} className={input} value={concurrency} onChange={(e) => setConcurrency(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} />
            </div>
            <div className="sm:col-span-2">
              <span className={label}>{t("Wait between starts (seconds)")}</span>
              <div className="flex items-center gap-2">
                <input id={ids.smin} aria-label={t("Shortest wait")} type="number" min={0} max={600} className={input} value={stagger[0]} onChange={(e) => setStagger([Math.max(0, Number(e.target.value) || 0), stagger[1]])} />
                <span className="text-fog/40">–</span>
                <input id={ids.smax} aria-label={t("Longest wait")} type="number" min={0} max={600} className={input} value={stagger[1]} onChange={(e) => setStagger([stagger[0], Math.max(0, Number(e.target.value) || 0)])} />
              </div>
            </div>
          </div>
          <p className="mt-1 text-[11px] text-fog/40">
            {t("Each profile waits a random time in this range before it starts, so a batch never acts in step. Your licence's browser limit still applies.")}
          </p>
          <label htmlFor={ids.close} className="mt-3 flex items-center gap-2.5 text-sm text-fog/70">
            <input id={ids.close} type="checkbox" className="accent-[#38e0d6]" checked={closeWhenDone} onChange={(e) => setCloseWhenDone(e.target.checked)} />
            {t("Close the browsers this task opened when it ends")}
          </label>
        </details>

        <div className="mt-3 flex flex-wrap items-center gap-2.5 rounded-lg border border-line px-3 py-2.5 text-sm text-fog/80" data-run-save="1">
          <label className="flex items-center gap-2.5">
            <input type="checkbox" className="accent-[#38e0d6]" checked={save} onChange={(e) => setSave(e.target.checked)} data-run-save-toggle="1" />
            {task ? t("Update the saved task") : t("Save as a task")}
          </label>
          {save && (
            <input
              className={cell + " min-w-[10rem] flex-1 text-sm"}
              aria-label={t("Task name")}
              placeholder={goal.trim().slice(0, 60) || t("Task name")}
              value={taskName}
              onChange={(e) => setTaskName(e.target.value)}
              data-run-save-name="1"
            />
          )}
          <p className="w-full text-[11px] text-fog/40">
            {t("A saved task keeps its steps and every run, and runs again later from the Tasks page, with other profiles or other values.")}
          </p>
        </div>

        {error && (
          <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" data-run-error="1">
            {error}
          </div>
        )}
      </div>
      <DialogFooter>
        <button className="text-xs text-fog/50 hover:text-fog" onClick={onOpenSettings}>
          {t("Jet settings…")}
        </button>
        <span className="flex-1" />
        <button className={btnGhost} onClick={onClose}>
          {t("Cancel")}
        </button>
        <button className={btnPrimary} onClick={start} disabled={!canStart} data-run-start="1" title={!ready ? t("Finish setting up Jet first.") : undefined}>
          {busy
            ? t("Starting…")
            : n === 0
              ? t("Select at least one profile.")
              : trialOn
                ? t("Try it on 1 profile")
                : n === 1
                  ? t("Run")
                  : runnableCount === 1
                    ? t("Run on 1 profile")
                    : t("Run on {n} profiles", { n: runnableCount })}
        </button>
      </DialogFooter>
    </Dialog>
  );
}
