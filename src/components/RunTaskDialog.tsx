"use client";

// "Run a task…" on the selected profiles. Jet works the task out in the first profile and replays it on
// the rest with no model calls, each profile with its own mouse path and timing (electron/jetsync.ts).
// The preview under the goal shows which {{values}} the task uses and which profiles have no value for
// one, before anything starts.

import { useId, useMemo, useRef, useState } from "react";
import Dialog, { DialogFooter, DialogHeader } from "./Dialog";
import type { Profile } from "@/types/profile";
import type { Settings, StartRequest } from "@/lib/ipc";
import { templateSlots, valuesFor } from "../../electron/jetslots";
import { t, tRich } from "@/lib/i18n";

const input =
  "w-full rounded-lg border border-line bg-ink/70 px-3 py-2 text-sm text-fog outline-none placeholder:text-fog/30 focus:border-accent/60 focus:ring-1 focus:ring-accent/40";
const label = "block text-[11px] font-medium uppercase tracking-wide text-fog/45 mb-1";
const btnGhost = "rounded-lg border border-line-strong px-3.5 py-1.5 text-sm text-fog/80 hover:bg-elevate";
const btnPrimary = "rounded-lg bg-sheen px-4 py-1.5 text-sm font-semibold text-[#07080a] disabled:opacity-40";

export default function RunTaskDialog({
  profiles,
  settings,
  onStart,
  onOpenSettings,
  onClose,
}: {
  /** The selected profiles, in the order they will start. */
  profiles: Profile[];
  settings: Settings;
  onStart: (req: StartRequest) => Promise<{ ok: true; runId: string } | { ok: false; error: string }>;
  /** Opens Settings → Tasks (where Jet is set up). */
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const ids = { goal: useId(), url: useId(), confirm: useId(), conc: useId(), smin: useId(), smax: useId(), close: useId() };
  const goalRef = useRef<HTMLTextAreaElement>(null);
  const [goal, setGoal] = useState("");
  const [url, setUrl] = useState("");
  const [confirm, setConfirm] = useState(true);
  const [concurrency, setConcurrency] = useState(settings.syncConcurrency ?? 2);
  const [stagger, setStagger] = useState<[number, number]>(settings.syncStaggerSec ?? [3, 20]);
  const [closeWhenDone, setCloseWhenDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slots = useMemo(() => templateSlots(goal), [goal]);
  const missing = useMemo(
    () => profiles.map((p) => ({ p, missing: valuesFor(goal, p).missing })).filter((x) => x.missing.length),
    [goal, profiles],
  );
  const secretSlots = useMemo(() => {
    const s = new Set<string>();
    for (const p of profiles) for (const k of valuesFor(goal, p).secret) s.add(k);
    return s;
  }, [goal, profiles]);
  const urlBad = !!url.trim() && !/^https?:\/\/\S+$/i.test(url.trim());
  const canStart = !!goal.trim() && !urlBad && !busy && missing.length < profiles.length;

  async function start() {
    if (!canStart) return;
    setBusy(true);
    setError(null);
    try {
      const r = await onStart({
        profileIds: profiles.map((p) => p.id),
        goal,
        url: url.trim() || undefined,
        confirm,
        concurrency,
        staggerSec: stagger,
        closeWhenDone,
      });
      if (r.ok) onClose();
      else setError(r.error);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  }

  const n = profiles.length;
  return (
    <Dialog onClose={onClose} labelledBy={titleId} className="max-h-[760px] max-w-2xl" initialFocus={goalRef}>
      <DialogHeader id={titleId} title={n === 1 ? t("Run a task on 1 profile") : t("Run a task on {n} profiles", { n })} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-run-task="1">
        <p className="mb-4 text-xs leading-relaxed text-fog/55">
          {t(
            "Jet works the task out in the first profile and saves it. The other profiles repeat it without the model, each on its own page with its own mouse movement and timing.",
          )}
        </p>
        <label htmlFor={ids.goal} className={label}>
          {t("Task")}
        </label>
        <textarea
          id={ids.goal}
          ref={goalRef}
          className={input + " min-h-[88px] resize-y"}
          placeholder={t("Log in as {{email}} with the password {{password}} and accept the new terms")}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          data-run-goal="1"
        />
        <p className="mt-1 text-[11px] text-fog/40">
          {tRich("Write {slot} for a value that differs per profile: its name, or one of its task values (in the profile's editor, under Identity).", {
            slot: <span className="font-mono">{"{{email}}"}</span>,
          })}
        </p>

        {slots.length > 0 && (
          <div className="mt-3 rounded-lg border border-line px-3 py-2.5 text-xs" aria-live="polite" data-run-slots="1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-fog/50">{t("Values used:")}</span>
              {slots.map((s) => (
                <span key={s} className="rounded bg-elevate px-1.5 py-0.5 font-mono text-fog/80">
                  {`{{${s}}}`}
                  {secretSlots.has(s) && <span className="ml-1 text-fog/40">· {t("secret")}</span>}
                </span>
              ))}
            </div>
            {missing.length > 0 ? (
              <div className="mt-2 text-warn" data-run-missing={missing.length}>
                {missing.length === 1
                  ? t("1 profile has no value for every slot and will be skipped:")
                  : t("{n} profiles have no value for every slot and will be skipped:", { n: missing.length })}
                <ul className="mt-1 space-y-0.5">
                  {missing.slice(0, 6).map(({ p, missing: m }) => (
                    <li key={p.id} className="truncate">
                      {p.name} — <span className="font-mono">{m.map((x) => `{{${x}}}`).join(", ")}</span>
                    </li>
                  ))}
                  {missing.length > 6 && <li>{t("and {n} more", { n: missing.length - 6 })}</li>}
                </ul>
              </div>
            ) : (
              <div className="mt-2 text-ok">{t("Every selected profile has a value for each.")}</div>
            )}
            {secretSlots.size > 0 && (
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
          />
          <p className={"mt-1 text-[11px] " + (urlBad ? "text-danger" : "text-fog/40")}>
            {urlBad
              ? t("The start page must be an http or https address.")
              : t("Opened in a new tab in each profile. Empty: the task starts on the tab that is open. A saved task is matched to its start page, so keep it the same between runs.")}
          </p>
        </div>

        <label htmlFor={ids.confirm} className="mt-4 flex items-start gap-2.5 rounded-lg border border-line px-3 py-2.5 text-sm text-fog/80">
          <input id={ids.confirm} type="checkbox" className="mt-0.5 accent-[#38e0d6]" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} data-run-confirm="1" />
          <span>
            {tRich("<b>Ask me before a click that can't be undone</b> — sending, buying, booking, deleting. Each profile waits there; approve them one by one or all at once.", {
              b: (s) => <span className="font-medium text-fog">{s}</span>,
            })}
          </span>
        </label>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
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
        <button className={btnPrimary} onClick={start} disabled={!canStart} data-run-start="1">
          {busy ? t("Starting…") : t("Run")}
        </button>
      </DialogFooter>
    </Dialog>
  );
}
