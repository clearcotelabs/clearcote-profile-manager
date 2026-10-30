"use client";

// What Jet did, step by step: one node per step with what kind of step it was, what it acted on, what it
// typed (a secret reads as its {{slot}}, never the value), whether the model chose it or it was replayed
// from the saved task, how sure the model was, and how long it took since the step before. An <ol>, so a
// screen reader reads it as a numbered list.

import type { ReactNode } from "react";
import type { StepSummary } from "@/lib/ipc";
import { t, tx } from "@/lib/i18n";

const SLOT = /\{\{\s*([A-Za-z_][\w.-]{0,63})\s*\}\}/g;

type Kind = "click" | "type" | "select" | "scroll" | "key" | "navigate" | "other";

const KINDS: Record<Kind, { label: string; cls: string; icon: ReactNode }> = {
  click: {
    label: tx("Click"),
    cls: "border-accent/40 bg-accent/10 text-accent",
    icon: <path d="M5 3l7 16 2.2-6.8L21 10 5 3z" />,
  },
  type: {
    label: tx("Type"),
    cls: "border-iris/40 bg-iris/10 text-iris",
    icon: (
      <>
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
      </>
    ),
  },
  select: {
    label: tx("Choose"),
    cls: "border-sky/40 bg-sky/10 text-sky",
    icon: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M9 11l3 3 3-3" />
      </>
    ),
  },
  scroll: {
    label: tx("Scroll"),
    cls: "border-line-strong bg-elevate text-fog/70",
    icon: <path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4" />,
  },
  key: {
    label: tx("Key"),
    cls: "border-line-strong bg-elevate text-fog/70",
    icon: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <path d="M9 15l3-6 3 6M10 13h4" />
      </>
    ),
  },
  navigate: {
    label: tx("Open page"),
    cls: "border-ok/40 bg-ok/10 text-ok",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" />
      </>
    ),
  },
  other: {
    label: tx("Step"),
    cls: "border-line-strong bg-elevate text-fog/60",
    icon: <circle cx="12" cy="12" r="3" />,
  },
};

function kindOf(kind: string): Kind {
  const k = kind.toLowerCase();
  if (k === "fill" || k === "type" || k === "press_sequentially") return "type";
  if (k === "select" || k === "check" || k === "uncheck") return "select";
  if (k === "navigate" || k === "goto" || k === "open") return "navigate";
  if (k === "click" || k === "scroll" || k === "key") return k;
  if (k === "press" || k === "keypress") return "key";
  if (k === "dblclick" || k === "hover" || k === "tap") return "click";
  return "other";
}

/** "+0.8 s", "+12 s", "+2 m 5 s". */
function gap(ms: number): string {
  if (ms < 0) return "";
  if (ms < 10_000) return `+${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `+${s} s`;
  return `+${Math.floor(s / 60)} m ${s % 60} s`;
}

/** Text with each {{slot}} shown as a value chip. */
export function SlotText({ text, className = "" }: { text: string; className?: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(SLOT)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    out.push(
      <span key={i} className="mx-px inline-block rounded border border-iris/40 bg-iris/10 px-1 font-mono text-[0.92em] text-iris" title={t("A value it asks for")}>
        {`{{${m[1]}}}`}
      </span>
    );
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <span className={className}>{out}</span>;
}

export default function StepTimeline({ steps, from, compact = false }: { steps: StepSummary[]; from?: string; compact?: boolean }) {
  if (!steps.length) {
    return (
      <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-fog/45" data-step-timeline="empty">
        {t("No steps yet: run the task once and its steps show here.")}
      </div>
    );
  }
  const learned = steps.filter((s) => !s.replayed).length;
  const lastAt = steps[steps.length - 1].atMs;
  return (
    <div data-step-timeline={steps.length}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-2 text-[11px] text-fog/50">
        <span className="font-medium text-fog/75">
          {from
            ? steps.length === 1
              ? t("1 step, from {name}", { name: from })
              : t("{n} steps, from {name}", { n: steps.length, name: from })
            : steps.length === 1
              ? t("1 step")
              : t("{n} steps", { n: steps.length })}
        </span>
        {lastAt != null && lastAt > 0 && <span>· {t("{time} in all", { time: gap(lastAt).slice(1) })}</span>}
        <span>
          ·{" "}
          {learned === 0
            ? t("all replayed without the model")
            : learned === steps.length
              ? t("all chosen by the model")
              : t("{n} chosen by the model, the rest replayed", { n: learned })}
        </span>
      </div>
      <ol className="relative" aria-label={t("Steps Jet took")}>
        {steps.map((s, i) => {
          const k = KINDS[kindOf(s.kind)];
          const prev = i > 0 ? steps[i - 1].atMs : 0;
          const dt = s.atMs != null && prev != null ? s.atMs - prev : null;
          const p = s.probability;
          const end = i === steps.length - 1;
          return (
            <li key={i} className={"relative flex gap-3 " + (end ? "" : compact ? "pb-1.5" : "pb-3")} data-step={i + 1} data-step-kind={s.kind}>
              {!end && <span aria-hidden className="absolute bottom-0 left-[13px] top-7 w-px bg-line-strong" />}
              <span
                aria-hidden
                className={"relative z-[1] flex h-7 w-7 shrink-0 items-center justify-center rounded-full border " + k.cls}
                title={t(k.label)}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  {k.icon}
                </svg>
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-mono text-[10px] text-fog/35">{i + 1}</span>
                  <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-fog/45">{t(k.label)}</span>
                  <span className={"min-w-0 text-[13px] text-fog " + (compact ? "truncate" : "break-words")} title={s.action}>
                    {s.action ? `“${s.action}”` : null}
                  </span>
                  <span className="flex-1" />
                  {dt != null && dt >= 0 && i > 0 && <span className="font-mono text-[10px] text-fog/35">{gap(dt)}</span>}
                  <span
                    className={
                      "rounded-full px-1.5 py-px text-[10px] font-semibold " + (s.replayed ? "bg-ok/15 text-ok" : "bg-accent/15 text-accent")
                    }
                    title={s.replayed ? t("Repeated from the saved task, no model call") : t("Chosen by the model")}
                  >
                    {s.replayed ? t("replayed") : t("learned")}
                  </span>
                </div>
                {s.text ? (
                  <div className="mt-1">
                    <SlotText
                      text={s.text}
                      className={"inline-block max-w-full rounded-md border border-line bg-ink/70 px-2 py-0.5 font-mono text-[11px] text-fog/80 " + (compact ? "truncate" : "break-all")}
                    />
                  </div>
                ) : null}
                {p != null && !s.replayed && !compact && (
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-fog/40" title={t("How sure the model was")}>
                    <span className="h-1 w-16 overflow-hidden rounded-full bg-elevate" aria-hidden>
                      <span
                        className={"block h-full rounded-full " + (p >= 0.8 ? "bg-ok" : p >= 0.5 ? "bg-accent" : "bg-warn")}
                        style={{ width: `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%` }}
                      />
                    </span>
                    <span>{t("{pct}% sure", { pct: Math.round(Math.max(0, Math.min(1, p)) * 100) })}</span>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
