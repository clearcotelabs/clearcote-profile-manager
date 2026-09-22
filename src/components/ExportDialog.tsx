"use client";

// Export, with secrets only on purpose.
//
// Export always stripped proxy passwords and the cookie encryption key. Safe for pasting into a
// ticket — but moving to a new machine then silently lost every proxy password, and without the key
// a copied data folder's cookies cannot be read. Now it is a choice, off by default, said plainly.

import { useId, useRef, useState } from "react";
import Dialog from "./Dialog";

export default function ExportDialog({
  count,
  single,
  onExport,
  onClose,
}: {
  count: number;
  /** The one profile's name, when exporting from its card. */
  single?: string;
  onExport: (includeSecrets: boolean) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const boxId = useId();
  const ref = useRef<HTMLButtonElement>(null);
  const [secrets, setSecrets] = useState(false);
  const what = single ? `“${single}”` : count === 1 ? "1 profile" : `${count} profiles`;
  return (
    <Dialog onClose={onClose} labelledBy={titleId} variant="fit" layer="top" className="max-w-md" initialFocus={ref}>
      <div className="px-5 pb-4 pt-5">
        <h2 id={titleId} className="text-base font-semibold">
          Export {what}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-fog/60">
          Saves {count === 1 ? "its settings" : "their settings"} to a JSON file. Browser data — cookies, logins,
          history — is not included; it stays in each profile's data folder.
        </p>
        <label htmlFor={boxId} className="mt-4 flex items-start gap-2.5 rounded-lg border border-line px-3 py-2.5 text-sm">
          <input
            id={boxId}
            type="checkbox"
            className="mt-0.5 accent-[#38e0d6]"
            checked={secrets}
            onChange={(e) => setSecrets(e.target.checked)}
          />
          <span>
            <span className="font-medium text-fog">Include proxy passwords and encryption keys</span>
            <span className="mt-0.5 block text-xs text-fog/45">For moving to another computer you control.</span>
          </span>
        </label>
        {secrets && (
          <p role="alert" className="mt-2 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
            Anyone with this file can use your proxies and read cookies copied with the data folder. Don't share it.
          </p>
        )}
      </div>
      <div className="flex flex-none justify-end gap-2 border-t border-line bg-ink/40 px-5 py-3">
        <button className="rounded-lg border border-line-strong px-3.5 py-1.5 text-sm text-fog/80 hover:bg-elevate" onClick={onClose}>
          Cancel
        </button>
        <button
          ref={ref}
          className="rounded-lg bg-sheen px-3.5 py-1.5 text-sm font-semibold text-[#07080a] hover:opacity-95"
          onClick={() => onExport(secrets)}
        >
          Export…
        </button>
      </div>
    </Dialog>
  );
}
