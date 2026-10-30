"use client";

// Settings → Tasks: the Jet setup checklist (Python, Jet, model key; see JetSetup), the Jet command for those
// who set it by hand, and whether every launch opens a local automation port (so your own scripts can drive
// the windows this app opens).

import { useEffect, useState } from "react";
import JetSetup from "./JetSetup";
import { api, type Settings } from "@/lib/ipc";
import { t, tRich } from "@/lib/i18n";

const input =
  "w-full min-w-0 rounded-lg bg-ink/70 border border-line px-3 py-2 text-sm text-fog placeholder-fog/30 outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/40";
const btn =
  "shrink-0 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-fog/80 hover:bg-elevate transition disabled:opacity-40 disabled:hover:bg-transparent";
const JET_URL = "https://github.com/clearcotelabs/clearcote-jet";

export default function TasksSection({
  settings,
  onSaveSettings,
}: {
  settings: Settings;
  onSaveSettings: (patch: Partial<Settings>) => Promise<void> | void;
}) {
  const [cmd, setCmd] = useState(settings.jetCommand ?? "");
  const desktop = !!api.sync;
  const dirty = cmd !== (settings.jetCommand ?? "");
  // The app may set the command itself (after Install Jet): follow it while the field is untouched.
  useEffect(() => setCmd(settings.jetCommand ?? ""), [settings.jetCommand]);

  if (!desktop) {
    return (
      <div className="rounded-xl border border-line bg-ink/30 px-4 py-3.5 text-xs leading-relaxed text-fog/60" data-tasks-web="1">
        {t("Running tasks on profiles is in the desktop app only: it opens each browser's automation port, which a web page must not be able to do.")}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-tasks-settings="1">
      <JetSetup settings={settings} onSaveSettings={onSaveSettings} />

      <details className="rounded-xl border border-line bg-ink/30 px-4 py-3 text-xs text-fog/55" data-jet-advanced="1">
        <summary className="cursor-pointer select-none text-[13px] text-fog/75">{t("Advanced: the Jet command")}</summary>
        <p className="mt-2 leading-relaxed">
          {tRich("Set by the app when it installs Jet. Leave it empty to use {bin} from PATH, or give the full command, for example a Python of your own.", {
            bin: <span className="font-mono text-fog/70">clearcote-jet</span>,
          })}
        </p>
        <input
          id="jet-command"
          aria-label={t("Jet command")}
          className={`${input} mt-2 font-mono`}
          placeholder={'clearcote-jet   or   "C:\\Python312\\python.exe" -m clearcote_jet.cli'}
          value={cmd}
          spellCheck={false}
          onChange={(e) => setCmd(e.target.value)}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button className={btn} disabled={!dirty} onClick={() => onSaveSettings({ jetCommand: cmd.trim() || undefined })} data-jet-save="1">
            {t("Save")}
          </button>
          <button className={btn} onClick={() => void api.openExternal(JET_URL)}>
            {t("About Jet ↗")}
          </button>
          {dirty && <span className="text-[11px] text-warn">{t("Not saved yet.")}</span>}
        </div>
      </details>

      <div className="divide-y divide-line rounded-xl border border-line bg-ink/30">
        <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-fog">{t("Allow automation on every launch")}</div>
            <div className="mt-0.5 text-xs leading-relaxed text-fog/45">
              {t("Every browser this app opens gets a local DevTools port, so the SDK, Playwright or Jet can drive it. While a profile runs, any program on this PC can use that port. Running a task turns it on for its own launches only, so this can stay off.")}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={!!settings.automation}
            aria-label={t("Allow automation on every launch")}
            onClick={() => onSaveSettings({ automation: !settings.automation })}
            className={"relative h-5 w-9 shrink-0 rounded-full transition-colors " + (settings.automation ? "bg-accent" : "bg-line-strong")}
            data-automation-toggle="1"
          >
            <span
              className={
                "absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform " + (settings.automation ? "translate-x-[18px]" : "translate-x-0.5")
              }
            />
          </button>
        </div>
      </div>
      <p className="text-[11px] text-fog/35">
        {t("Learned tasks are saved by Jet on this PC (~/.clearcote-jet/skills). Secret task values are never written into them.")}
      </p>
    </div>
  );
}
