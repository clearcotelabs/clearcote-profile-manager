"use client";

// Ctrl+K: one box that finds a profile and does something with it, or runs any app command.
// Typing "shop" lists Launch / Details / Edit for the matching profiles; "proxy list" finds
// "New profiles from a proxy list". Enter runs the highlighted line.

import { useId, useMemo, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import Dialog from "./Dialog";

export interface Command {
  id: string;
  label: string;
  /** Right-hand hint: a shortcut or what it acts on. */
  hint?: string;
  /** Extra words it should be found by. */
  keywords?: string;
  section: string;
  run: () => void;
}

/** Every word of the query appears in the label or keywords (any order). Exported for tests. */
export function matchCommands(list: Command[], query: string, limit = 40): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list.slice(0, limit);
  const scored: { c: Command; s: number }[] = [];
  for (const c of list) {
    const label = c.label.toLowerCase();
    const hay = `${label} ${(c.keywords ?? "").toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    // Prefer matches in the label, and at the start of a word.
    let s = 0;
    for (const w of words) {
      if (label.startsWith(w)) s += 3;
      else if (label.includes(` ${w}`)) s += 2;
      else if (label.includes(w)) s += 1;
    }
    scored.push({ c, s });
  }
  return scored
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.c);
}

export default function CommandPalette({
  commands,
  profileCommands,
  onClose,
}: {
  /** App commands, shown with an empty query. */
  commands: Command[];
  /** Per-profile commands, only searched (a list of 300 profiles × 3 is not a menu). */
  profileCommands: Command[];
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const shown = useMemo(
    () => (q.trim() ? matchCommands([...profileCommands, ...commands], q) : commands),
    [q, commands, profileCommands],
  );
  const cur = Math.min(i, Math.max(shown.length - 1, 0));

  function run(c: Command | undefined) {
    if (!c) return;
    onClose();
    // After the dialog has handed focus back, so a command that opens another dialog keeps it.
    setTimeout(c.run, 0);
  }

  let lastSection = "";
  return (
    <Dialog onClose={onClose} variant="fit" initialFocus={inputRef} className="max-w-xl self-start mt-[10vh]">
      <div className="border-b border-line px-4 py-3">
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={shown[cur] ? `${listId}-${cur}` : undefined}
          aria-label={t("Find a profile or a command")}
          placeholder={t("Find a profile or a command…")}
          className="w-full bg-transparent text-[15px] text-fog placeholder-fog/35 outline-none"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setI(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setI(Math.min(cur + 1, shown.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setI(Math.max(cur - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(shown[cur]);
            }
          }}
        />
      </div>
      <ul id={listId} role="listbox" aria-label={t("Results")} className="max-h-[55vh] overflow-y-auto py-1.5">
        {shown.length === 0 && <li className="px-4 py-6 text-center text-sm text-fog/45">{t("No matches")}</li>}
        {shown.map((c, n) => {
          const head = c.section !== lastSection ? c.section : null;
          lastSection = c.section;
          return (
            <li key={c.id} role="presentation">
              {head && <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-fog/35">{head}</div>}
              <div
                id={`${listId}-${n}`}
                role="option"
                aria-selected={n === cur}
                onMouseMove={() => setI(n)}
                onClick={() => run(c)}
                className={"mx-1.5 flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-sm " + (n === cur ? "bg-accent/10 text-fog" : "text-fog/75")}
              >
                <span className="min-w-0 truncate">{c.label}</span>
                {c.hint && <span className="shrink-0 text-[11px] text-fog/40">{c.hint}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-3 border-t border-line px-4 py-2 text-[11px] text-fog/40">
        <span>{t("↑↓ to move · Enter to run · Esc to close")}</span>
      </div>
    </Dialog>
  );
}
