"use client";

// Settings, laid out like the profile editor: a pinned header, a section rail, ONE scrolling panel
// and a pinned footer. The previous modal was a single box centred in a `fixed inset-0 flex` overlay
// with no height cap and no overflow, so once its content outgrew the window both its top and its
// Done button were pushed off-screen with nothing able to scroll them back. The frame (and Esc,
// focus, scroll locking) now comes from the shared Dialog, and only the panel scrolls.

import { useId, useState } from "react";
import { api, type Settings, type LicenseStatus } from "@/lib/ipc";
import Dialog, { DialogFooter, DialogHeader } from "./Dialog";
import StorageSection from "./StorageSection";

export type Section = "general" | "browser" | "license" | "updates" | "storage";

/** Where a free key comes from: sign in with GitHub, Licenses, "Get it free" (the site's own FAQ). */
export const FREE_KEY_URL = "https://www.clearcotelabs.com/dashboard/licenses";

const SECTIONS: { id: Section; label: string; title: string; blurb: string }[] = [
  {
    id: "general",
    label: "General",
    title: "General",
    blurb: "How the app behaves.",
  },
  {
    id: "browser",
    label: "Browser",
    title: "Browser",
    blurb: "Which Clearcote build profiles launch with.",
  },
  {
    id: "license",
    label: "Licence",
    title: "Licence",
    blurb: "A key unlocks the licence-gated browser. It is only sent to the licence service, and only when a key is set.",
  },
  {
    id: "updates",
    label: "Updates",
    title: "App updates",
    blurb: "Know when a new version of this app is out. Nothing is installed without you.",
  },
  {
    id: "storage",
    label: "Storage",
    title: "Storage",
    blurb: "What the app keeps on disk, what each part is for, and what can go.",
  },
];

const input =
  "w-full min-w-0 rounded-lg bg-ink/70 border border-line px-3 py-2 text-sm text-fog placeholder-fog/30 outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/40";
const btn =
  "shrink-0 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-fog/80 hover:bg-elevate transition disabled:opacity-40 disabled:hover:bg-transparent";

function hostIsWindows(): boolean {
  if (typeof navigator === "undefined") return true;
  return `${navigator.platform} ${navigator.userAgent}`.toLowerCase().includes("win");
}

/** A titled group of rows — the one visual unit every section is built from. */
function Card({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-line rounded-xl border border-line bg-ink/30">{children}</div>;
}

/** Label + explanation on the left, the control on the right; stacks on a narrow window. */
function Row({
  title,
  hint,
  children,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-fog">{title}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-fog/45">{hint}</div>}
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={
        "relative h-5 w-9 shrink-0 rounded-full transition-colors " + (checked ? "bg-accent" : "bg-line-strong")
      }
    >
      <span
        className={
          "absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform " +
          (checked ? "translate-x-[18px]" : "translate-x-0.5")
        }
      />
    </button>
  );
}

export default function SettingsModal({
  binary,
  settings,
  onPick,
  onSaveSettings,
  onClose,
  initialSection = "browser",
}: {
  binary: string | null;
  settings: Settings;
  onPick: () => void;
  onSaveSettings: (patch: Partial<Settings>) => Promise<void> | void;
  onClose: () => void;
  /** Open on this section — the header pill and a launch error's action point at the right one. */
  initialSection?: Section;
}) {
  const [section, setSection] = useState<Section>(initialSection);
  const current = SECTIONS.find((s) => s.id === section)!;
  const titleId = useId();

  // ── Licence ──────────────────────────────────────────────────────────────
  const [key, setKey] = useState(settings.licenseKey || "");
  const [reveal, setReveal] = useState(false);
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const dirty = (key.trim() || undefined) !== (settings.licenseKey || undefined);

  async function saveKey() {
    const next = key.trim() || undefined;
    await onSaveSettings({ licenseKey: next });
    setStatus(null);
    // A saved key is checked at once, so a typo shows up here instead of at the next launch.
    if (next) await checkKey(next);
  }
  async function checkKey(saved?: string) {
    setChecking(true);
    setStatus(null);
    try {
      if (saved === undefined && dirty) await onSaveSettings({ licenseKey: key.trim() || undefined });
      setStatus(await api.license.check(saved ?? (key.trim() || undefined)));
    } finally {
      setChecking(false);
    }
  }

  // ── Updates ──────────────────────────────────────────────────────────────
  const [updMsg, setUpdMsg] = useState<string | null>(null);
  const [updChecking, setUpdChecking] = useState(false);
  async function checkNow() {
    setUpdChecking(true);
    setUpdMsg(null);
    try {
      const u = await api.update.check(true);
      setUpdMsg(
        !u ? "Could not reach GitHub." : u.available ? `Version ${u.latest} is available — see the banner.` : `You're up to date (${u.current}).`,
      );
    } finally {
      setUpdChecking(false);
    }
  }

  const exe = hostIsWindows() ? "chrome.exe" : "chrome";
  const custom = settings.binaryPath;

  return (
    <Dialog onClose={onClose} labelledBy={titleId} className="max-h-[620px] max-w-3xl">
      <DialogHeader id={titleId} title="Settings" onClose={onClose} />

        <div className="grid min-h-0 flex-1 grid-cols-[160px_1fr] max-sm:grid-cols-1 max-sm:grid-rows-[auto_1fr]">
          {/* Rail — a row of tabs on a narrow window */}
          <nav className="min-h-0 border-r border-line bg-ink/30 max-sm:border-b max-sm:border-r-0">
            <ul className="flex flex-col gap-0.5 p-2.5 max-sm:flex-row max-sm:overflow-x-auto">
              {SECTIONS.map((s) => {
                const on = s.id === section;
                return (
                  <li key={s.id}>
                    <button
                      onClick={() => setSection(s.id)}
                      aria-current={on}
                      className={
                        "flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-[13px] " +
                        (on ? "bg-accent/10 font-semibold text-accent" : "text-fog/60 hover:bg-elevate hover:text-fog")
                      }
                    >
                      {s.label}
                      {s.id === "license" && settings.licenseKey && (
                        <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent" title="Key set" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Panel — the only thing that scrolls */}
          <div className="min-h-0 overflow-y-auto px-5 py-4">
            <h3 className="text-[15px] font-semibold">{current.title}</h3>
            <p className="mb-4 mt-0.5 max-w-[62ch] text-xs text-fog/40">{current.blurb}</p>

            {section === "general" && (
              <Card>
                <div className="px-4 py-3.5">
                  {/* A plain heading, not <legend>: a legend sits ON the card's top border. */}
                  <div id="close-behavior-title" className="text-[13px] font-medium text-fog">
                    When you close the window while browsers are running
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-fog/45">
                    The app keeps each browser's licence renewed. If it quits, a browser on the free plan stops by itself
                    within a few minutes.
                  </p>
                  <div className="mt-3 space-y-1.5" role="radiogroup" aria-labelledby="close-behavior-title">
                    {(
                      [
                        ["ask", "Ask me each time"],
                        ["tray", "Keep running in the tray"],
                        ["quit", "Close the browsers and quit"],
                      ] as const
                    ).map(([v, text]) => (
                      <label key={v} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-fog/80 hover:bg-elevate">
                        <input
                          type="radio"
                          name="close-behavior"
                          className="accent-[#38e0d6]"
                          checked={(settings.closeBehavior ?? "ask") === v}
                          onChange={() => onSaveSettings({ closeBehavior: v })}
                        />
                        {text}
                      </label>
                    ))}
                  </div>
                </div>
              </Card>
            )}

            {section === "browser" && (
              <Card>
                <Row
                  title={custom ? "Custom binary" : "Automatic"}
                  hint={
                    custom
                      ? "Every profile launches this file, whatever version it asks for."
                      : "Each profile's browser version is downloaded on first use and checked against its SHA-256."
                  }
                >
                  <span
                    className={
                      "rounded-full px-2 py-0.5 text-[11px] font-medium " +
                      (custom ? "bg-warn/10 text-warn" : "bg-accent/10 text-accent")
                    }
                  >
                    {custom ? "Override" : "Managed"}
                  </span>
                </Row>
                <div className="px-4 py-3.5">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-fog/40">
                    {custom ? "Path" : "Fallback when offline"}
                  </div>
                  <div className="mt-1.5 break-all rounded-lg bg-ink/70 px-3 py-2 font-mono text-[11px] text-fog/60">
                    {custom || binary || "(none found)"}
                  </div>
                  <p className="mt-2 text-xs text-fog/40">
                    Point at a local <span className="font-mono">{exe}</span> to test your own build. The{" "}
                    <span className="font-mono">CLEARCOTE_BINARY</span> environment variable does the same.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button className={btn} onClick={onPick}>
                      Choose {exe}…
                    </button>
                    {custom && (
                      <button className={btn} onClick={() => onSaveSettings({ binaryPath: undefined })}>
                        Use automatic
                      </button>
                    )}
                  </div>
                </div>
              </Card>
            )}

            {section === "license" && (
              <div className="space-y-4">
                <Card>
                  <div className="px-4 py-3.5">
                    <label htmlFor="lic-key" className="text-[13px] font-medium text-fog">
                      Licence key
                    </label>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <div className="relative min-w-[220px] flex-1">
                        <input
                          id="lic-key"
                          className={`${input} pr-14 font-mono`}
                          type={reveal ? "text" : "password"}
                          autoComplete="off"
                          spellCheck={false}
                          value={key}
                          onChange={(e) => {
                            setKey(e.target.value);
                            setStatus(null);
                          }}
                          onKeyDown={(e) => e.key === "Enter" && dirty && void saveKey()}
                          placeholder="cc_lic_…"
                        />
                        <button
                          type="button"
                          className="absolute inset-y-0 right-2 my-auto h-6 rounded px-1.5 text-[11px] text-fog/45 hover:text-fog"
                          onClick={() => setReveal((v) => !v)}
                          aria-label={reveal ? "Hide key" : "Show key"}
                        >
                          {reveal ? "Hide" : "Show"}
                        </button>
                      </div>
                      <button className={btn} onClick={saveKey} disabled={!dirty}>
                        Save
                      </button>
                      <button className={btn} onClick={() => checkKey()} disabled={checking || !key.trim()}>
                        {checking ? "Checking…" : "Check"}
                      </button>
                    </div>
                    {dirty && <p className="mt-2 text-[11px] text-warn">Not saved yet — press Save or Enter.</p>}
                    {status && (
                      <div
                        className={`mt-3 rounded-lg px-3 py-2 text-xs ${
                          status.ok ? "bg-ok/10 text-ok" : "bg-danger/10 text-danger"
                        }`}
                      >
                        {status.ok && status.busy ? (
                          <>✓ Valid — every browser slot is in use right now, so the check could not take one.</>
                        ) : status.ok ? (
                          <>
                            ✓ Valid{status.plan ? ` — ${status.plan} plan` : ""}
                            {typeof status.limit === "number"
                              ? ` · ${status.used ?? 0}/${status.limit === 0 ? "unlimited" : status.limit} browsers in use`
                              : ""}
                          </>
                        ) : (
                          <>✕ {status.error || "Invalid licence."}</>
                        )}
                      </div>
                    )}
                  </div>
                </Card>
                <Card>
                  <Row
                    title="No key yet?"
                    hint="A free key runs the same licensed build, one browser at a time. Sign in with GitHub, open Licenses and click Get it free. It lasts 30 days and renews for free."
                  >
                    <button className={btn} onClick={() => void api.openExternal(FREE_KEY_URL)}>
                      Get a free key ↗
                    </button>
                  </Row>
                </Card>
                <Card>
                  <Row
                    title="With a key"
                    hint="Profiles launch the licence-gated browser (downloaded and SHA-256 verified), and each running browser holds one of your plan's slots. The free plan always runs the latest build."
                  />
                  <Row
                    title="Without a key"
                    hint="Profiles launch the open build, and the app never contacts the licence service."
                  />
                </Card>
                <p className="text-[11px] text-fog/35">
                  A saved key is checked straight away. The check briefly takes one browser slot, so while every slot is in
                  use it can only confirm the key is valid.
                </p>
              </div>
            )}

            {section === "updates" && (
              <Card>
                <Row
                  title="Check for updates when the app starts"
                  hint={
                    <>
                      Each time the app starts, it asks <span className="font-mono">api.github.com</span> whether a newer
                      release exists and suggests upgrading. This build is unsigned, so nothing is installed behind your
                      back — you download and run the installer yourself, and its checksum is verified first.
                    </>
                  }
                >
                  <Toggle
                    label="Check for updates when the app starts"
                    checked={settings.updateCheck !== false}
                    onChange={(v) => onSaveSettings({ updateCheck: v })}
                  />
                </Row>
                <Row
                  title="Check now"
                  hint={
                    updMsg ??
                    (settings.lastUpdateCheck
                      ? `Last checked ${new Date(settings.lastUpdateCheck).toLocaleString()}.`
                      : "Not checked yet.")
                  }
                >
                  <button className={btn} onClick={checkNow} disabled={updChecking}>
                    {updChecking ? "Checking…" : "Check now"}
                  </button>
                </Row>
                {settings.updateCheck === false && (
                  <div className="px-4 py-3 text-[11px] text-warn">
                    The browser engine updates itself, but with this off the app can sit on already-fixed bugs.
                  </div>
                )}
              </Card>
            )}

            {section === "storage" && (
              <StorageSection
                autoPrune={settings.autoPruneBuilds !== false}
                onAutoPrune={(v) => onSaveSettings({ autoPruneBuilds: v })}
              />
            )}
          </div>
        </div>

        <DialogFooter className="justify-end">
          <span className="mr-auto text-[11px] text-fog/35">Changes save as you make them — the licence key saves with Save.</span>
          <button className="rounded-lg bg-sheen px-4 py-1.5 text-sm font-semibold text-[#07080a]" onClick={onClose}>
            Done
          </button>
        </DialogFooter>
    </Dialog>
  );
}
