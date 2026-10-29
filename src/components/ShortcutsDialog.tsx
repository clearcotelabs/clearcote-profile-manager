"use client";

import { useId } from "react";
import Dialog, { DialogHeader } from "./Dialog";
import { hostOs, keysLabel } from "@/lib/host";
import { t, tx } from "@/lib/i18n";

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: tx("Anywhere"),
    keys: [
      ["Ctrl N", tx("New profile")],
      ["Ctrl Shift N", tx("New profile from the last-used template")],
      ["Ctrl K", tx("Find a profile or a command")],
      ["Ctrl F  or  /", tx("Search profiles")],
      ["Ctrl ,", tx("Settings")],
      ["Ctrl A", tx("Select every profile shown")],
      ["Esc", tx("Clear the selection, or close the details panel")],
      ["?", tx("This list")],
    ],
  },
  {
    title: tx("On a focused profile"),
    keys: [
      ["Enter", tx("Launch")],
      ["E", tx("Edit")],
      ["Delete", tx("Delete (can be undone)")],
      ["Space", tx("Select it (Shift for a range)")],
      ["← ↑ → ↓", tx("Move between profiles")],
    ],
  },
  {
    title: tx("In a dialog"),
    keys: [
      ["Ctrl S", tx("Save the profile")],
      ["Esc", tx("Close — asks first if there are unsaved changes")],
    ],
  },
];

export default function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const host = hostOs();
  return (
    <Dialog onClose={onClose} labelledBy={titleId} variant="fit" className="max-w-md">
      <DialogHeader id={titleId} title={t("Keyboard shortcuts")} onClose={onClose} />
      <div className="space-y-4 px-5 py-4">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-fog/40">{t(g.title)}</h3>
            <dl className="divide-y divide-line rounded-lg border border-line">
              {g.keys.map(([k, what]) => (
                <div key={k} className="flex items-center justify-between gap-4 px-3 py-1.5 text-[13px]">
                  <dt className="text-fog/70">{t(what)}</dt>
                  <dd>
                    <kbd className="whitespace-nowrap rounded border border-line-strong bg-ink/60 px-1.5 py-0.5 font-sans text-[11px] text-fog/70">
                      {keysLabel(k, host)}
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
