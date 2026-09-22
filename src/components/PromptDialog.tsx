"use client";

// One text field, one question: "Set group", "Add tag", "Rename group". Suggestions come from what
// already exists, so a typo does not quietly start a second group.

import { useId, useRef, useState } from "react";
import Dialog from "./Dialog";

export default function PromptDialog({
  title,
  label,
  initial = "",
  suggestions = [],
  confirmLabel,
  hint,
  allowEmpty = false,
  onConfirm,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  suggestions?: string[];
  confirmLabel: string;
  hint?: string;
  /** An empty answer is meaningful (e.g. "no group"). */
  allowEmpty?: boolean;
  onConfirm: (value: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const inputId = useId();
  const listId = useId();
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const ok = allowEmpty || value.trim().length > 0;
  const submit = () => {
    if (!ok) return;
    onConfirm(value.trim());
  };
  return (
    <Dialog onClose={onClose} labelledBy={titleId} variant="fit" layer="top" className="max-w-md" initialFocus={ref}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="px-5 pb-4 pt-5">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <label htmlFor={inputId} className="mt-3 block text-[11px] font-medium uppercase tracking-wide text-fog/45">
            {label}
          </label>
          <input
            id={inputId}
            ref={ref}
            list={suggestions.length ? listId : undefined}
            className="mt-1 w-full rounded-lg border border-line bg-ink/70 px-3 py-2 text-sm text-fog outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/40"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
          />
          {suggestions.length > 0 && (
            <datalist id={listId}>
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
          {hint && <p className="mt-2 text-xs text-fog/45">{hint}</p>}
        </div>
        <div className="flex flex-none justify-end gap-2 border-t border-line bg-ink/40 px-5 py-3">
          <button type="button" className="rounded-lg border border-line-strong px-3.5 py-1.5 text-sm text-fog/80 hover:bg-elevate" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ok}
            className="rounded-lg bg-sheen px-3.5 py-1.5 text-sm font-semibold text-[#07080a] hover:opacity-95 disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
