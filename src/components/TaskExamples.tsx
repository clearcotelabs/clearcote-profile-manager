"use client";

// The task examples (src/lib/taskExamples.ts), browsable two ways:
// - ExamplePicker: compact, inside Run a task ("More examples…"): category tabs, a search box, one line each.
// - ExampleGallery: cards grouped by category, on the Tasks page; a card opens Run a task with it.
// Search matches the translated title and category and the (English) goal, so both languages find it.

import { useMemo, useState } from "react";
import { EXAMPLE_CATEGORIES, TASK_EXAMPLES, type ExampleCategory, type TaskExample } from "@/lib/taskExamples";
import { t, useLocale } from "@/lib/i18n";
import { SlotText } from "./StepTimeline";

const search =
  "min-w-0 flex-1 rounded-lg border border-line bg-ink/70 px-3 py-1.5 text-sm text-fog placeholder-fog/30 outline-none focus:border-accent/60";

const catTitle = (id: ExampleCategory) => t(EXAMPLE_CATEGORIES.find((c) => c.id === id)?.title ?? id);

function useFiltered(q: string, cat: ExampleCategory | "all") {
  // The search matches translated titles: a language switch searches the new ones.
  const locale = useLocale();
  return useMemo(() => {
    const s = q.trim().toLowerCase();
    return TASK_EXAMPLES.filter(
      (ex) =>
        (cat === "all" || ex.category === cat) &&
        (!s || `${t(ex.title)} ${ex.title} ${catTitle(ex.category)} ${ex.goal}`.toLowerCase().includes(s)),
    );
  }, [q, cat, locale]);
}

export function ExamplePicker({ onPick, onClose }: { onPick: (ex: TaskExample) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<ExampleCategory | "all">("all");
  const shown = useFiltered(q, cat);
  const tab = (on: boolean) => "rounded-md px-2 py-0.5 text-[11px] " + (on ? "bg-elevate text-fog" : "text-fog/50 hover:text-fog");
  return (
    <div className="mb-2 rounded-lg border border-line bg-surface/70" data-run-example-picker="1">
      <div className="flex items-center gap-2 border-b border-line p-2">
        <input
          className={search}
          placeholder={t("Search examples…")}
          aria-label={t("Search examples")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            // Escape closes the picker, not the whole dialog (Dialog skips a handled Escape).
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
          autoFocus
        />
        <button className="text-xs text-fog/50 hover:text-fog" onClick={onClose}>
          {t("Close")}
        </button>
      </div>
      <div className="flex flex-wrap gap-1 border-b border-line px-2 py-1.5" role="tablist" aria-label={t("Example categories")}>
        <button role="tab" aria-selected={cat === "all"} className={tab(cat === "all")} onClick={() => setCat("all")}>
          {t("All")}
        </button>
        {EXAMPLE_CATEGORIES.map((c) => (
          <button key={c.id} role="tab" aria-selected={cat === c.id} className={tab(cat === c.id)} onClick={() => setCat(c.id)} data-example-tab={c.id}>
            {t(c.title)}
          </button>
        ))}
      </div>
      <ul className="max-h-60 divide-y divide-line overflow-y-auto">
        {shown.map((ex) => (
          <li key={ex.id}>
            <button className="block w-full px-3 py-2 text-left hover:bg-elevate" onClick={() => onPick(ex)} data-example={ex.id}>
              <div className="flex items-baseline gap-2">
                <span className="text-[12px] font-medium text-fog">{t(ex.title)}</span>
                {cat === "all" && <span className="text-[10px] text-fog/35">{catTitle(ex.category)}</span>}
              </div>
              <SlotText text={ex.goal} className="mt-0.5 line-clamp-1 text-[11px] text-fog/50" />
            </button>
          </li>
        ))}
        {shown.length === 0 && <li className="px-3 py-5 text-center text-xs text-fog/40">{t("No example matches “{q}”.", { q: q.trim() })}</li>}
      </ul>
    </div>
  );
}

export function ExampleGallery({ onPick }: { onPick: (ex: TaskExample) => void }) {
  const [q, setQ] = useState("");
  const shown = useFiltered(q, "all");
  const groups = EXAMPLE_CATEGORIES.map((c) => ({ ...c, items: shown.filter((ex) => ex.category === c.id) })).filter((g) => g.items.length);
  return (
    <div data-example-gallery={shown.length}>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-fog/60">{t("Pick an example to open it in Run a task, then change the words to fit your site. Values like {example} are filled from each profile or once per run.", { example: "{{email}}" })}</p>
        <input className={search + " max-w-xs"} placeholder={t("Search examples…")} aria-label={t("Search examples")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {groups.map((g) => (
        <section key={g.id} className="mb-5" data-example-group={g.id}>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-fog/40">{t(g.title)}</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2.5">
            {g.items.map((ex) => (
              <button
                key={ex.id}
                className="flex flex-col rounded-xl border border-line bg-surface/70 px-3.5 py-3 text-left transition hover:border-accent/50 hover:bg-elevate"
                onClick={() => onPick(ex)}
                data-example={ex.id}
              >
                <span className="text-[13px] font-medium text-fog">{t(ex.title)}</span>
                <SlotText text={ex.goal} className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-fog/55" />
                {ex.url !== "https://" && <span className="mt-1.5 truncate font-mono text-[10px] text-fog/35">{ex.url}</span>}
              </button>
            ))}
          </div>
        </section>
      ))}
      {shown.length === 0 && <p className="py-6 text-center text-xs text-fog/40">{t("No example matches “{q}”.", { q: q.trim() })}</p>}
    </div>
  );
}
