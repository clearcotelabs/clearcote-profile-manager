"use client";

// A profile's task values (Profile.vars): what a task's {{slots}} are filled with on this profile. A secret
// one (a password) is typed only: it is masked here, never shown in the run board, left out of exports,
// and Jet's model sees its name, not its value.

import { useId } from "react";
import type { ProfileVar } from "@/types/profile";
import { t } from "@/lib/i18n";

const input =
  "w-full min-w-0 rounded-lg border border-line bg-ink/70 px-2.5 py-1.5 text-sm text-fog outline-none placeholder:text-fog/30 focus:border-accent/60 focus:ring-1 focus:ring-accent/40";
const KEY = /^[A-Za-z_][\w.-]{0,63}$/;

export default function TaskValues({ value, onChange }: { value?: ProfileVar[]; onChange: (v: ProfileVar[] | undefined) => void }) {
  const base = useId();
  const rows = value ?? [];
  const set = (i: number, patch: Partial<ProfileVar>) => {
    const next = rows.map((r, j) => (j === i ? { ...r, ...patch } : r));
    onChange(next);
  };
  const remove = (i: number) => {
    const next = rows.filter((_, j) => j !== i);
    onChange(next.length ? next : undefined);
  };
  const dup = (k: string) => rows.filter((r) => r.key.trim() === k.trim()).length > 1;

  return (
    <div className="space-y-2" data-task-values="1">
      {rows.map((r, i) => {
        const bad = !!r.key && !KEY.test(r.key.trim());
        return (
          <div key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
            <input
              id={`${base}-k${i}`}
              aria-label={t("Name")}
              className={input + " font-mono sm:w-40" + (bad || dup(r.key) ? " border-danger/60" : "")}
              placeholder="email"
              value={r.key}
              spellCheck={false}
              onChange={(e) => set(i, { key: e.target.value })}
            />
            <input
              id={`${base}-v${i}`}
              aria-label={t("Value")}
              className={input + " flex-1"}
              type={r.secret ? "password" : "text"}
              autoComplete="off"
              placeholder={r.secret ? "••••••" : "ana@example.com"}
              value={r.value}
              onChange={(e) => set(i, { value: e.target.value })}
            />
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-fog/60">
              <input type="checkbox" className="accent-[#38e0d6]" checked={!!r.secret} onChange={(e) => set(i, { secret: e.target.checked || undefined })} />
              {t("Secret")}
            </label>
            <button className="shrink-0 px-1 text-fog/40 hover:text-danger" onClick={() => remove(i)} aria-label={t("Remove")}>
              ✕
            </button>
            {(bad || dup(r.key)) && (
              <p className="w-full text-[11px] text-danger">
                {bad ? t("Use letters, digits, _ . or -, starting with a letter.") : t("This name is used twice; the last one wins.")}
              </p>
            )}
          </div>
        );
      })}
      <button
        className="rounded-lg border border-dashed border-line-strong px-3 py-1.5 text-xs text-fog/70 hover:bg-elevate"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
        data-task-values-add="1"
      >
        {t("+ Add a value")}
      </button>
    </div>
  );
}
