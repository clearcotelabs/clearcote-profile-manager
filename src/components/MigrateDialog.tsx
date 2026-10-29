"use client";

// Moving in from another browser, and adding cookies to one profile.
//
// One dialog for both: a file (or pasted text) goes to the main process, which reads it (electron/migrate.ts).
// "profiles" makes new profiles from another antidetect browser's export; "cookies" adds cookies to a saved
// profile. Either way the cookies go into the browser at its next launch, which this says, because nothing
// visible happens until then.

import { useId, useRef, useState } from "react";
import Dialog from "./Dialog";
import { t } from "@/lib/i18n";
import type { CookieImportResult, MigrateResult } from "@/lib/ipc";

export type MigrateMode = { kind: "profiles" } | { kind: "cookies"; id: string; name: string };

export default function MigrateDialog({
  mode,
  onImport,
  onClose,
}: {
  mode: MigrateMode;
  /** Runs the import; the dialog shows what came back and stays open on an error. */
  onImport: (text: string, filename: string) => Promise<MigrateResult | CookieImportResult>;
  onClose: () => void;
}) {
  const titleId = useId();
  const textId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const cookies = mode.kind === "cookies";

  async function pick(f: File | undefined) {
    if (!f) return;
    setError(null);
    if (f.size > 20 * 1024 * 1024) {
      setError(t("That file is over 20 MB — too big to be a cookie file or a profile list."));
      return;
    }
    setFilename(f.name);
    setText(await f.text());
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await onImport(text, filename);
      if (!r.ok) setError(r.error || t("Import failed."));
      else if ("warnings" in r && r.warnings?.length) setWarnings(r.warnings);
      else onClose();
    } finally {
      setBusy(false);
    }
  }

  if (warnings.length) {
    return (
      <Dialog onClose={onClose} labelledBy={titleId} variant="fit" layer="top" className="max-w-lg">
        <div className="px-5 pb-4 pt-5">
          <h2 id={titleId} className="text-base font-semibold">
            {t("Imported, with notes")}
          </h2>
          <ul className="mt-3 max-h-64 list-disc space-y-1 overflow-auto pl-5 text-xs text-fog/60">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
        <div className="flex flex-none justify-end gap-2 border-t border-line bg-ink/40 px-5 py-3">
          <button className="rounded-lg bg-sheen px-3.5 py-1.5 text-sm font-semibold text-[#07080a] hover:opacity-95" onClick={onClose}>
            {t("Done")}
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog onClose={onClose} labelledBy={titleId} variant="fit" layer="top" className="max-w-lg">
      <div
        className="px-5 pb-4 pt-5"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void pick(e.dataTransfer.files?.[0]);
        }}
      >
        <h2 id={titleId} className="text-base font-semibold">
          {cookies ? t("Import cookies into “{name}”", { name: mode.name }) : t("Move in from another browser")}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-fog/60">
          {cookies
            ? t("A cookies.txt file, or the JSON a cookie extension (Cookie-Editor, EditThisCookie) or another antidetect browser exports. They go into the browser the next time this profile opens, so you stay signed in.")
            : t("The profile list exported from AdsPower, Dolphin Anty, GoLogin, Multilogin, Octo or similar, as JSON or CSV — or one cookie file. Names, notes, tags, groups, proxies and cookies come across.")}
        </p>
        {!cookies && (
          <p className="mt-2 text-xs leading-relaxed text-fog/45">
            {t("The old fingerprint is not copied: each profile gets a persona from a real device with the same operating system. Cookies are added at each profile's first launch.")}
          </p>
        )}
        <div className="mt-4 flex items-center gap-2">
          <button
            className="rounded-lg border border-line-strong px-3 py-1.5 text-sm text-fog/80 hover:bg-elevate"
            onClick={() => fileRef.current?.click()}
          >
            {t("Choose file…")}
          </button>
          <span className="truncate text-xs text-fog/45">{filename || t("or drop it here, or paste below")}</span>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".json,.txt,.csv,.tsv,application/json,text/plain,text/csv"
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
        <label htmlFor={textId} className="sr-only">
          {t("File contents")}
        </label>
        <textarea
          id={textId}
          className="mt-3 h-36 w-full resize-y rounded-lg border border-line bg-ink/70 px-3 py-2 font-mono text-xs text-fog placeholder-fog/30 outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/40"
          spellCheck={false}
          placeholder={cookies ? '[{"domain": ".example.com", "name": "sid", "value": "…"}]' : "name,proxy,cookies\nAccount 1,host:port:user:pass,[…]"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value) setFilename("");
          }}
        />
        {error && (
          <p role="alert" className="mt-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
      <div className="flex flex-none justify-end gap-2 border-t border-line bg-ink/40 px-5 py-3">
        <button className="rounded-lg border border-line-strong px-3.5 py-1.5 text-sm text-fog/80 hover:bg-elevate" onClick={onClose}>
          {t("Cancel")}
        </button>
        <button
          className="rounded-lg bg-sheen px-3.5 py-1.5 text-sm font-semibold text-[#07080a] hover:opacity-95 disabled:opacity-40"
          disabled={busy || !text.trim()}
          onClick={() => void submit()}
        >
          {busy ? t("Importing…") : t("Import")}
        </button>
      </div>
    </Dialog>
  );
}
