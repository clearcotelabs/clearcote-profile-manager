"use client";

// The steps a saved task replays, edited by hand (electron/taskskill.ts). Jet learns a task's steps the first time it
// finishes; here they can be changed, moved, removed or added, and new kinds of step added: go to an address, wait,
// wait until something is true, press a key, run the page's own JavaScript, click or type by CSS selector, and
// "if … then … else" and "repeat while" blocks around other steps. Saved steps are what the next run does, exactly:
// a run that cannot get through them stops there and says where, and Jet does not learn over them. "Reset to what
// Jet learns" forgets them, and the next run works the task out again.
//
// The web version edits steps too, but cannot save ones that run JavaScript (helper/policy.ts).

import { useEffect, useState } from "react";
import { api, isWeb, type ConditionType, type EditKind, type EditStep, type StepCondition, type TaskSkill } from "@/lib/ipc";
import { t, tx } from "@/lib/i18n";
import { useConfirm } from "./Confirm";
import { SlotText } from "./StepTimeline";

const ghost = "rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-fog/80 hover:bg-elevate transition disabled:opacity-40";
const primary = "rounded-lg bg-sheen px-3.5 py-1.5 text-[12px] font-semibold text-[#07080a] disabled:opacity-40";
const cell =
  "min-w-0 rounded-md border border-line bg-ink/70 px-2 py-1 text-xs text-fog outline-none placeholder:text-fog/25 focus:border-accent/60";
const tiny = "rounded-md px-1.5 py-0.5 text-[11px] text-fog/50 hover:bg-elevate hover:text-fog disabled:opacity-30";

const KIND_LABEL: Record<EditKind, string> = {
  click: tx("Click"),
  fill: tx("Type text"),
  select: tx("Choose"),
  scroll: tx("Scroll"),
  find: tx("Find text"),
  wait: tx("Wait"),
  goto: tx("Go to"),
  key: tx("Press key"),
  js: tx("Run JavaScript"),
  wait_for: tx("Wait until"),
  if: tx("If"),
  while: tx("Repeat while"),
};
const KIND_ORDER: EditKind[] = ["click", "fill", "select", "goto", "wait", "wait_for", "key", "scroll", "find", "js", "if", "while"];

const CONDITION_LABEL: Record<ConditionType, string> = {
  text: tx("the page shows"),
  control: tx("there is a button or field"),
  url: tx("the address contains"),
  selector: tx("an element matches (CSS)"),
  js: tx("this JavaScript is true"),
};
const CONDITION_HINT: Record<ConditionType, string> = {
  text: tx("Text on the page, e.g. Out of stock"),
  control: tx("Its label, e.g. Load more"),
  url: tx("Part of the address, e.g. /checkout"),
  selector: tx("e.g. #captcha, .error"),
  js: tx("e.g. document.querySelectorAll('.item').length > 10"),
};

const KEYS = ["Enter", "Tab", "Escape", "Space", "Backspace", "Delete", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End"];

/** A new step of this kind, keeping what still applies from the step it replaces. */
export function newStep(kind: EditKind, from?: EditStep): EditStep {
  const keep = from ? { ...(from.label ? { label: from.label } : {}), ...(from.selector ? { selector: from.selector } : {}) } : {};
  const cond: StepCondition = from?.condition ?? { type: "text", value: "" };
  switch (kind) {
    case "click":
      return { kind, label: "", ...keep };
    case "fill":
      return { kind, label: "", text: from?.text ?? "", ...keep };
    case "select":
      return { kind, label: from?.label ?? "", value: from?.value ?? "" };
    case "scroll":
      return { kind, label: "Scroll down", delta: 560 };
    case "find":
      return { kind, label: "Find text", text: from?.text ?? "" };
    case "wait":
      return { kind, seconds: 2 };
    case "goto":
      return { kind, url: from?.url ?? "https://" };
    case "key":
      return { kind, key: "Enter" };
    case "js":
      return { kind, code: from?.code ?? "" };
    case "wait_for":
      return { kind, condition: cond, seconds: 15 };
    case "if":
      return { kind, condition: cond, then: from?.then ?? [], else: from?.else ?? [] };
    case "while":
      return { kind, condition: { ...cond, type: from?.condition ? cond.type : "control" }, then: from?.then ?? [], max: 10 };
  }
}

/** What is missing for a step to run, or null. Mirrors Jet's own check (clearcote_jet/skills.py check_steps). */
export function stepProblem(s: EditStep): string | null {
  switch (s.kind) {
    case "click":
    case "fill":
      if (!s.selector?.trim() && !s.label?.trim()) return t("Say what to use: its label or a CSS selector.");
      if (s.kind === "fill" && typeof s.text !== "string") return t("Say what to type.");
      return null;
    case "select":
      return s.label?.trim() ? null : t("Say which dropdown and option, e.g. Country → Germany.");
    case "goto":
      return /^https?:\/\/\S+/.test(s.url ?? "") || (s.url ?? "").includes("{{") ? null : t("Use an address that starts with https://");
    case "js":
      return s.code?.trim() ? null : t("Write the JavaScript to run.");
    case "wait_for":
    case "if":
    case "while":
      return s.condition?.value?.trim() ? null : t("Say what to check.");
    default:
      return null;
  }
}

function allProblems(steps: EditStep[], prefix = ""): string[] {
  return steps.flatMap((s, i) => {
    const n = `${prefix}${i + 1}`;
    const p = stepProblem(s);
    return [
      ...(p ? [t("Step {n}: {problem}", { n, problem: p })] : []),
      ...allProblems(s.then ?? [], `${n}.`),
      ...(s.kind === "if" ? allProblems(s.else ?? [], `${n}.`) : []),
    ];
  });
}

/** One step as a sentence, for the read-only list. */
function sentence(s: EditStep): string {
  const what = s.selector ? s.selector : s.label ? `“${s.label}”` : "";
  const c = s.condition;
  const cond = c ? `${t(CONDITION_LABEL[c.type])} “${c.value}”` : "";
  const not = !!c?.not;
  switch (s.kind) {
    case "click":
      return t("Click {what}", { what });
    case "fill":
      return t("Type {text} into {what}", { text: s.text ?? "", what });
    case "select":
      return t("Choose {what}", { what });
    case "scroll":
      return t("Scroll down");
    case "find":
      return t("Find {text} on the page", { text: s.text ?? "" });
    case "wait":
      return t("Wait {n} s", { n: s.seconds ?? 1 });
    case "goto":
      return t("Go to {url}", { url: s.url ?? "" });
    case "key":
      return t("Press {key}", { key: s.key ?? "" });
    case "js":
      return t("Run JavaScript");
    case "wait_for":
      return not ? t("Wait while {cond} (up to {n} s)", { cond, n: s.seconds ?? 15 }) : t("Wait until {cond} (up to {n} s)", { cond, n: s.seconds ?? 15 });
    case "if":
      return not ? t("Unless {cond}", { cond }) : t("If {cond}", { cond });
    case "while":
      return not
        ? t("Repeat until {cond} (at most {n} times)", { cond, n: s.max ?? 10 })
        : t("Repeat while {cond} (at most {n} times)", { cond, n: s.max ?? 10 });
  }
}

export default function StepEditor({ taskId, hasUrl }: { taskId: string; hasUrl: boolean }) {
  const tasks = api.tasks!;
  const confirm = useConfirm();
  const [skill, setSkill] = useState<TaskSkill | null | undefined>(undefined);
  const [err, setErr] = useState<{ text: string; code?: string } | null>(null);
  const [draft, setDraft] = useState<EditStep[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setSkill(undefined);
    setErr(null);
    setDraft(null);
    if (!hasUrl) return;
    tasks
      .steps(taskId)
      .then((r) => {
        if (!alive) return;
        if (r.ok) setSkill(r.skill);
        else setErr({ text: r.error, code: r.code });
      })
      .catch((e) => alive && setErr({ text: String(e?.message || e) }));
    return () => {
      alive = false;
    };
  }, [taskId, hasUrl, tasks]);

  if (!hasUrl) {
    return <p className="mb-3 text-[12px] text-fog/45">{t("Give this task a start page (Edit) to change its steps by hand.")}</p>;
  }

  const save = async () => {
    if (!draft) return;
    const problems = allProblems(draft);
    if (problems.length) {
      setErr({ text: problems.join(" ") });
      return;
    }
    setBusy(true);
    try {
      const r = await tasks.saveSteps(taskId, draft);
      if (!r.ok) setErr({ text: r.error, code: r.code });
      else {
        setSkill(r.skill);
        setDraft(null);
        setErr(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    const ok = await confirm({
      title: t("Reset to what Jet learns?"),
      body: t("Your steps are removed. The next run works the task out again with the model, and Jet learns its steps anew."),
      confirmLabel: t("Reset"),
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await tasks.resetSteps(taskId);
      if (!r.ok) setErr({ text: r.error, code: r.code });
      else {
        // What the next run uses now, as the backend says (nothing, until Jet learns the task again).
        const again = await tasks.steps(taskId);
        setSkill(again.ok ? again.skill : null);
        setErr(null);
      }
    } finally {
      setBusy(false);
    }
  };

  if (draft) {
    const problems = allProblems(draft);
    return (
      <div className="mb-4 rounded-xl border border-accent/30 bg-surface/60 p-3" data-step-editor>
        <p className="mb-2 text-[12px] text-fog/55">
          {t("These steps run exactly as written next time. Use {{name}} for a task value, as in the goal.")}
        </p>
        <StepList steps={draft} onChange={setDraft} prefix="" />
        {err && (
          <div role="alert" className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            {err.text}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className={primary} onClick={() => void save()} disabled={busy || !!problems.length} data-steps-save="1" title={problems.join(" ")}>
            {busy ? t("Saving…") : t("Save steps")}
          </button>
          <button
            className={ghost}
            onClick={() => {
              setDraft(null);
              setErr(null);
            }}
            disabled={busy}
          >
            {t("Cancel")}
          </button>
          {problems.length > 0 && <span className="text-[11px] text-warn">{problems[0]}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3" data-steps-view>
      {skill === undefined && !err && <p className="text-[12px] text-fog/40">{t("Reading the steps…")}</p>}
      {err && (
        <div role="alert" className="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
          {err.text}
        </div>
      )}
      {skill?.edited && (
        <div className="mb-2 rounded-xl border border-line bg-surface/50 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-iris/15 px-2 py-px text-[10px] font-semibold text-iris" data-steps-edited>
              {t("Edited by hand")}
            </span>
            <span className="text-[11px] text-fog/45">{t("The next run does these steps exactly, with no model.")}</span>
          </div>
          <ReadOnly steps={skill.steps} />
        </div>
      )}
      {skill !== undefined && (
        <div className="flex flex-wrap items-center gap-2">
          {skill && !skill.edited && (
            <span className="text-[11px] text-fog/45">
              {skill.steps.length === 1 ? t("Jet learned 1 step.") : t("Jet learned {n} steps.", { n: skill.steps.length })}
            </span>
          )}
          {skill === null && <span className="text-[11px] text-fog/45">{t("Jet has not learned this task yet. Run it once, or write its steps yourself.")}</span>}
          <span className="flex-1" />
          <button className={ghost} onClick={() => setDraft(structuredClone(skill?.steps ?? []))} data-steps-edit="1">
            {skill ? t("Edit steps") : t("Write steps")}
          </button>
          {skill && (
            <button className={ghost + " hover:border-danger/50 hover:text-danger"} onClick={() => void reset()} disabled={busy} data-steps-reset="1">
              {t("Reset to what Jet learns")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ReadOnly({ steps, prefix = "" }: { steps: EditStep[]; prefix?: string }) {
  if (!steps.length) return <p className="text-[12px] text-fog/35">{t("No steps.")}</p>;
  return (
    <ol className="space-y-1">
      {steps.map((s, i) => {
        const n = `${prefix}${i + 1}`;
        return (
          <li key={n} data-readonly-step={n}>
            <div className="flex gap-2 text-[12px]">
              <span className="w-8 shrink-0 font-mono text-[10px] leading-5 text-fog/35">{n}</span>
              <SlotText text={sentence(s)} className="min-w-0 break-words text-fog/85" />
            </div>
            {s.kind === "js" && s.code && (
              <pre className="ml-10 mt-1 max-h-24 overflow-auto rounded-md border border-line bg-ink/70 px-2 py-1 font-mono text-[11px] text-fog/70">{s.code}</pre>
            )}
            {(s.kind === "if" || s.kind === "while") && (
              <div className="ml-6 mt-1 border-l border-line pl-3">
                <ReadOnly steps={s.then ?? []} prefix={`${n}.`} />
              </div>
            )}
            {s.kind === "if" && (s.else ?? []).length > 0 && (
              <div className="ml-6 mt-1 border-l border-line pl-3">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-fog/40">{t("Otherwise")}</div>
                <ReadOnly steps={s.else ?? []} prefix={`${n}.`} />
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepList({ steps, onChange, prefix }: { steps: EditStep[]; onChange: (next: EditStep[]) => void; prefix: string }) {
  const put = (i: number, s: EditStep) => onChange(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  const insert = (at: number, kind: EditKind = "click") => onChange([...steps.slice(0, at), newStep(kind), ...steps.slice(at)]);
  return (
    <div>
      <ol className="space-y-2">
        {steps.map((s, i) => {
          const n = `${prefix}${i + 1}`;
          return (
            <li key={i} className="rounded-lg border border-line bg-ink/40 p-2" data-edit-step={n}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-8 shrink-0 font-mono text-[10px] text-fog/40">{n}</span>
                <select
                  className={cell}
                  value={s.kind}
                  aria-label={t("What step {n} does", { n })}
                  onChange={(e) => put(i, newStep(e.target.value as EditKind, s))}
                >
                  {KIND_ORDER.filter((k) => !(isWeb && k === "js" && s.kind !== "js")).map((k) => (
                    <option key={k} value={k}>
                      {t(KIND_LABEL[k])}
                    </option>
                  ))}
                </select>
                <span className="flex-1" />
                <button className={tiny} onClick={() => move(i, -1)} disabled={i === 0} aria-label={t("Move step {n} up", { n })}>
                  ↑
                </button>
                <button className={tiny} onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label={t("Move step {n} down", { n })}>
                  ↓
                </button>
                <button className={tiny} onClick={() => insert(i + 1)} aria-label={t("Add a step after step {n}", { n })}>
                  +
                </button>
                <button
                  className={tiny + " hover:text-danger"}
                  onClick={() => onChange(steps.filter((_, j) => j !== i))}
                  aria-label={t("Delete step {n}", { n })}
                >
                  ✕
                </button>
              </div>
              <div className="mt-2 pl-10">
                <StepFields step={s} n={n} onChange={(next) => put(i, next)} />
              </div>
            </li>
          );
        })}
      </ol>
      <button className={ghost + " mt-2"} onClick={() => insert(steps.length)} data-steps-add={prefix || "top"}>
        {prefix ? t("+ Add a step here") : t("+ Add a step")}
      </button>
    </div>
  );
}

function StepFields({ step: s, n, onChange }: { step: EditStep; n: string; onChange: (s: EditStep) => void }) {
  const set = (patch: Partial<EditStep>) => onChange({ ...s, ...patch });
  const row = "flex flex-wrap items-center gap-2";
  switch (s.kind) {
    case "click":
    case "fill": {
      const bySelector = s.selector !== undefined;
      return (
        <div className="space-y-2">
          <div className={row}>
            <select
              className={cell}
              value={bySelector ? "css" : "label"}
              aria-label={t("How step {n} finds what it uses", { n })}
              onChange={(e) => {
                const next = { ...s };
                if (e.target.value === "css") next.selector = "";
                else delete next.selector;
                onChange(next);
              }}
            >
              <option value="label">{t("by its label")}</option>
              <option value="css">{t("by CSS selector")}</option>
            </select>
            {bySelector ? (
              <input
                className={cell + " flex-1 font-mono"}
                value={s.selector}
                placeholder="#login, button[type=submit]"
                aria-label={t("CSS selector for step {n}", { n })}
                onChange={(e) => set({ selector: e.target.value })}
              />
            ) : (
              <input
                className={cell + " flex-1"}
                value={s.label ?? ""}
                placeholder={s.kind === "fill" ? t("e.g. Email") : t("e.g. Sign in")}
                aria-label={t("Label for step {n}", { n })}
                onChange={(e) => set({ label: e.target.value })}
              />
            )}
          </div>
          {s.kind === "fill" && (
            <input
              className={cell + " w-full font-mono"}
              value={s.text ?? ""}
              placeholder={t("What to type, e.g. {{email}}")}
              aria-label={t("Text for step {n}", { n })}
              onChange={(e) => set({ text: e.target.value })}
            />
          )}
        </div>
      );
    }
    case "select":
      return (
        <input
          className={cell + " w-full"}
          value={s.label ?? ""}
          placeholder={t("Dropdown → option, e.g. Country → Germany")}
          aria-label={t("Dropdown and option for step {n}", { n })}
          onChange={(e) => set({ label: e.target.value })}
        />
      );
    case "scroll":
      return <span className="text-[11px] text-fog/45">{t("Scrolls down about one screen.")}</span>;
    case "find":
      return (
        <input
          className={cell + " w-full"}
          value={s.text ?? ""}
          placeholder={t("Words to scroll to")}
          aria-label={t("Text to find for step {n}", { n })}
          onChange={(e) => set({ text: e.target.value })}
        />
      );
    case "wait":
      return <Seconds value={s.seconds ?? 1} n={n} onChange={(v) => set({ seconds: v })} label={t("seconds")} />;
    case "goto":
      return (
        <input
          className={cell + " w-full font-mono"}
          value={s.url ?? ""}
          placeholder="https://"
          aria-label={t("Address for step {n}", { n })}
          onChange={(e) => set({ url: e.target.value })}
        />
      );
    case "key":
      return (
        <select className={cell} value={s.key ?? "Enter"} aria-label={t("Key for step {n}", { n })} onChange={(e) => set({ key: e.target.value })}>
          {KEYS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      );
    case "js":
      return (
        <div>
          <textarea
            className={cell + " min-h-[64px] w-full resize-y font-mono"}
            value={s.code ?? ""}
            placeholder={"document.querySelector('#accept')?.click();"}
            aria-label={t("JavaScript for step {n}", { n })}
            onChange={(e) => set({ code: e.target.value })}
          />
          <p className="mt-1 text-[11px] text-fog/40">{t("Runs in the page, as its own scripts do. It can read and change anything on the page.")}</p>
        </div>
      );
    case "wait_for":
      return (
        <div className="space-y-2">
          <Condition value={s.condition!} n={n} onChange={(c) => set({ condition: c })} />
          <Seconds value={s.seconds ?? 15} n={n} onChange={(v) => set({ seconds: v })} label={t("seconds at most, then the run stops")} />
        </div>
      );
    case "if":
      return (
        <div className="space-y-2">
          <Condition value={s.condition!} n={n} onChange={(c) => set({ condition: c })} />
          <Block title={t("Then")}>
            <StepList steps={s.then ?? []} prefix={`${n}.`} onChange={(v) => set({ then: v })} />
          </Block>
          <Block title={t("Otherwise")}>
            <StepList steps={s.else ?? []} prefix={`${n}.else.`} onChange={(v) => set({ else: v })} />
          </Block>
        </div>
      );
    case "while":
      return (
        <div className="space-y-2">
          <Condition value={s.condition!} n={n} onChange={(c) => set({ condition: c })} />
          <Seconds value={s.max ?? 10} n={n} max={100} onChange={(v) => set({ max: v })} label={t("times at most")} />
          <Block title={t("Repeat")}>
            <StepList steps={s.then ?? []} prefix={`${n}.`} onChange={(v) => set({ then: v })} />
          </Block>
        </div>
      );
  }
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-l-2 border-line pl-3">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-fog/40">{title}</div>
      {children}
    </div>
  );
}

function Seconds({ value, n, onChange, label, max = 600 }: { value: number; n: string; onChange: (v: number) => void; label: string; max?: number }) {
  return (
    <label className="flex items-center gap-2 text-[11px] text-fog/55">
      <input
        type="number"
        min={0}
        max={max}
        step={max === 600 ? 0.5 : 1}
        className={cell + " w-20"}
        value={value}
        aria-label={`${label} (${t("step {n}", { n })})`}
        onChange={(e) => onChange(Math.min(max, Math.max(0, Number(e.target.value) || 0)))}
      />
      {label}
    </label>
  );
}

function Condition({ value: c, n, onChange }: { value: StepCondition; n: string; onChange: (c: StepCondition) => void }) {
  const types = (Object.keys(CONDITION_LABEL) as ConditionType[]).filter((k) => !(isWeb && k === "js" && c.type !== "js"));
  return (
    <div className="flex flex-wrap items-center gap-2" data-condition={n}>
      <select
        className={cell}
        value={c.not ? "not" : "is"}
        aria-label={t("Whether step {n} checks for or against it", { n })}
        onChange={(e) => onChange({ ...c, not: e.target.value === "not" || undefined })}
      >
        <option value="is">{t("when")}</option>
        <option value="not">{t("unless")}</option>
      </select>
      <select className={cell} value={c.type} aria-label={t("What step {n} checks", { n })} onChange={(e) => onChange({ ...c, type: e.target.value as ConditionType })}>
        {types.map((k) => (
          <option key={k} value={k}>
            {t(CONDITION_LABEL[k])}
          </option>
        ))}
      </select>
      <input
        className={cell + " min-w-[12rem] flex-1" + (c.type === "js" || c.type === "selector" ? " font-mono" : "")}
        value={c.value}
        placeholder={t(CONDITION_HINT[c.type])}
        aria-label={t("Value step {n} checks", { n })}
        onChange={(e) => onChange({ ...c, value: e.target.value })}
      />
    </div>
  );
}
