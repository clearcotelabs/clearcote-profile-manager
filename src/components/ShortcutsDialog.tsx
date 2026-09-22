"use client";

import { useId } from "react";
import Dialog, { DialogHeader } from "./Dialog";

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: "Anywhere",
    keys: [
      ["Ctrl N", "New profile"],
      ["Ctrl F  or  /", "Search profiles"],
      ["Ctrl ,", "Settings"],
      ["?", "This list"],
    ],
  },
  {
    title: "On a focused profile",
    keys: [
      ["Enter", "Launch"],
      ["E", "Edit"],
      ["Delete", "Delete (can be undone)"],
      ["← ↑ → ↓", "Move between profiles"],
    ],
  },
  {
    title: "In a dialog",
    keys: [
      ["Ctrl S", "Save the profile"],
      ["Esc", "Close — asks first if there are unsaved changes"],
    ],
  },
];

export default function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  return (
    <Dialog onClose={onClose} labelledBy={titleId} variant="fit" className="max-w-md">
      <DialogHeader id={titleId} title="Keyboard shortcuts" onClose={onClose} />
      <div className="space-y-4 px-5 py-4">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fog/40">{g.title}</h3>
            <dl className="divide-y divide-line rounded-lg border border-line">
              {g.keys.map(([k, what]) => (
                <div key={k} className="flex items-center justify-between gap-4 px-3 py-1.5 text-[13px]">
                  <dt className="text-fog/70">{what}</dt>
                  <dd>
                    <kbd className="whitespace-nowrap rounded border border-line-strong bg-ink/60 px-1.5 py-0.5 font-sans text-[11px] text-fog/70">
                      {k}
                    </kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
