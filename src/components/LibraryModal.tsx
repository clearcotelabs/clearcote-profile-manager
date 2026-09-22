"use client";

// The clearcote-profiles library picker (opens over the profile editor).

import { useEffect, useId, useMemo, useState } from "react";
import { api, type FingerprintMeta, type LibraryProfile } from "@/lib/ipc";
import { MIN_PROFILE_SCREEN_HEIGHT, MIN_PROFILE_SCREEN_WIDTH } from "@/types/profile";
import Dialog, { DialogHeader } from "./Dialog";

export default function LibraryModal({
  onApply,
  onClose,
}: {
  onApply: (file: string, meta?: FingerprintMeta) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [list, setList] = useState<LibraryProfile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [vendor, setVendor] = useState<string>("all");
  useEffect(() => {
    api.fp.library().then((r) => (r.ok ? setList(r.profiles || []) : setErr(r.error || "Failed to load library.")));
  }, []);
  async function pick(p: LibraryProfile) {
    setBusy(p.name);
    const r = await api.fp.use(p);
    setBusy(null);
    if (r.ok && r.file) onApply(r.file, r.meta);
    else setErr(r.error || "Failed to apply this profile.");
  }
  const vendors = useMemo(
    () => Array.from(new Set((list || []).map((p) => p.gpuVendor).filter(Boolean) as string[])).sort(),
    [list],
  );
  // A capture from a display too small to hold a real browser window produces impossible geometry
  // (window bigger than its own screen), so those are hidden by default rather than silently
  // offered. The count is shown so the filtering is never invisible.
  const [hideSmall, setHideSmall] = useState(true);
  const byVendor = (list || []).filter((p) => vendor === "all" || p.gpuVendor === vendor);
  const smallCount = byVendor.filter((p) => p.screenWarning).length;
  const shown = hideSmall ? byVendor.filter((p) => !p.screenWarning) : byVendor;

  return (
    // "fit": sized to its content; on a very short window the whole frame scrolls, and the list keeps
    // a usable minimum instead of collapsing to a sliver (it measured 25px at 420px tall).
    <Dialog onClose={onClose} labelledBy={titleId} variant="fit" layer="top" className="max-w-lg sm:max-h-[80vh]">
      <DialogHeader id={titleId} title="clearcote-profiles library" onClose={onClose} />
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-5 pt-3">
        <p className="text-xs text-fog/45">
          Curated real-GPU desktop fingerprints.{" "}
          <span className="text-fog/65">Pick one whose GPU vendor matches your host</span> so the imported GPU stays
          coherent with the real render.
        </p>
        {err && <div className="mt-3 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">{err}</div>}
        {vendors.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by GPU vendor">
            {["all", ...vendors].map((v) => (
              <button
                key={v}
                onClick={() => setVendor(v)}
                aria-pressed={vendor === v}
                className={`rounded-md px-2 py-1 text-[11px] ${vendor === v ? "bg-accent/15 text-accent" : "bg-elevate text-fog/55 hover:text-fog/80"}`}
              >
                {v}
                {v !== "all" && <span className="ml-1 text-fog/30">{(list || []).filter((p) => p.gpuVendor === v).length}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 min-h-[160px] flex-1 overflow-y-auto rounded-lg border border-line">
          {!list && !err && <div className="p-4 text-sm text-fog/40">Loading…</div>}
          {shown.map((p) => (
            <button
              key={p.name}
              onClick={() => pick(p)}
              disabled={!!busy}
              className="flex w-full items-center justify-between gap-2 border-b border-line/50 px-3 py-2 text-left last:border-0 hover:bg-elevate focus:bg-elevate focus:outline-none disabled:opacity-50"
            >
              <span className="min-w-0">
                <span className="block truncate text-[12px] text-fog/75">
                  {p.renderer ? p.renderer.replace(/^ANGLE \(/, "").replace(/\)$/, "") : p.name.replace(/\.json$/, "")}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[10px] text-fog/40">
                  {p.screenWarning && (
                    <span className="mr-1 text-warn" title={p.screenWarning}>
                      ⚠
                    </span>
                  )}
                  {[p.gpuVendor, p.screen, p.name.replace(/\.json$/, "")].filter(Boolean).join("  ·  ")}
                </span>
              </span>
              <span className="ml-2 shrink-0 text-[11px] text-accent">{busy === p.name ? "applying…" : "Use →"}</span>
            </button>
          ))}
          {list && shown.length === 0 && <div className="p-4 text-sm text-fog/40">No profiles for this vendor.</div>}
        </div>
        {smallCount > 0 && (
          <label className="mt-2 flex items-center gap-2 text-[11px] text-fog/45">
            <input type="checkbox" className="accent-[#38e0d6]" checked={hideSmall} onChange={(e) => setHideSmall(e.target.checked)} />
            <span>
              Hide {smallCount} capture{smallCount === 1 ? "" : "s"} with a display too small to contain a browser window
              (under {MIN_PROFILE_SCREEN_WIDTH}×{MIN_PROFILE_SCREEN_HEIGHT}) — the window would be bigger than its own screen.
            </span>
          </label>
        )}
        <p className="mt-3 text-[11px] text-fog/35">
          From <span className="font-mono">github.com/clearcotelabs/clearcote-profiles</span> · or use{" "}
          <span className="font-mono">Import from file…</span> for your own capture.
        </p>
      </div>
    </Dialog>
  );
}
