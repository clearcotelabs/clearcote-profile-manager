"use client";

// Settings, laid out like the profile editor: a pinned header, a section rail, ONE scrolling panel
// and a pinned footer. The previous modal was a single box centred in a `fixed inset-0 flex` overlay
// with no height cap and no overflow, so once its content outgrew the window both its top and its
// Done button were pushed off-screen with nothing able to scroll them back. The frame (and Esc,
// focus, scroll locking) now comes from the shared Dialog, and only the panel scrolls.

import { useEffect, useId, useState } from "react";
import { api, type Settings, type LicenseStatus, type CachedBuild } from "@/lib/ipc";
import Dialog, { DialogFooter, DialogHeader } from "./Dialog";
import { useConfirm } from "./Confirm";

export type Section = "browser" | "license" | "updates" | "storage";

const SECTIONS: { id: Section; label: string; title: string; blurb: string }[] = [
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
    title: "Downloaded browsers",
    blurb: "Verified browser builds cached on disk. Remove one to reclaim space; it downloads again on the next launch that needs it.",
  },
];

const input =
  "w-full min-w-0 rounded-lg bg-ink/70 border border-line px-3 py-2 text-sm text-fog placeholder-fog/30 outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/40";
const btn =
  "shrink-0 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-fog/80 hover:bg-elevate transition disabled:opacity-40 disabled:hover:bg-transparent";

const fmtSize = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

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
  const confirm = useConfirm();

  // ── Licence ──────────────────────────────────────────────────────────────
  const [key, setKey] = useState(settings.licenseKey || "");
  const [reveal, setReveal] = useState(false);
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const dirty = (key.trim() || undefined) !== (settings.licenseKey || undefined);

  async function saveKey() {
    await onSaveSettings({ licenseKey: key.trim() || undefined });
    setStatus(null);
  }
  async function checkKey() {
    setChecking(true);
    setStatus(null);
    try {
      if (dirty) await onSaveSettings({ licenseKey: key.trim() || undefined });
      setStatus(await api.license.check(key.trim() || undefined));
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

  // ── Storage ──────────────────────────────────────────────────────────────
  const [cached, setCached] = useState<CachedBuild[] | null>(null);
  const [busyTag, setBusyTag] = useState<string | null>(null);
  const loadCache = () => api.cache.list().then(setCached).catch(() => setCached([]));
  useEffect(() => {
    void loadCache();
  }, []);
  const total = (cached || []).reduce((s, b) => s + b.sizeBytes, 0);
  async function removeCached(b: CachedBuild) {
    const ok = await confirm({
      title: `Remove build ${b.version}?`,
      body: `This frees ${fmtSize(b.sizeBytes)}. It downloads again, and is verified again, on the next launch that needs it.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    setBusyTag(b.tag);
    try {
      await api.cache.remove(b.tag);
      await loadCache();
    } finally {
      setBusyTag(null);
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
                      {s.id === "storage" && cached && cached.length > 0 && (
                        <span className="ml-auto rounded-full bg-elevate px-1.5 text-[10px] tabular-nums text-fog/50">
                          {cached.length}
                        </span>
                      )}
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
                      <button className={btn} onClick={checkKey} disabled={checking || !key.trim()}>
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
                        {status.ok ? (
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
                    title="With a key"
                    hint="Profiles launch the licence-gated browser (downloaded and SHA-256 verified), and each running browser holds one of your plan's slots. The free plan always runs the latest build."
                  />
                  <Row
                    title="Without a key"
                    hint="Profiles launch the open build, and the app never contacts the licence service."
                  />
                </Card>
                <p className="text-[11px] text-fog/35">
                  Check briefly takes one slot to ask the licence service, so on a one-browser plan it reports the limit
                  while a profile is running.
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
              <>
                {cached === null ? (
                  <div className="text-xs text-fog/45">Loading…</div>
                ) : cached.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-xs text-fog/45">
                    Nothing downloaded yet.
                  </div>
                ) : (
                  <>
                    <div className="mb-3 flex items-baseline gap-2">
                      <span className="text-2xl font-semibold tabular-nums">{fmtSize(total)}</span>
                      <span className="text-xs text-fog/45">
                        in {cached.length} build{cached.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <Card>
                      {cached.map((b) => (
                        <div key={b.tag} className="flex items-center gap-3 px-4 py-2.5">
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                              b.tier === "pro" ? "bg-accent/10 text-accent" : "bg-elevate text-fog/60"
                            }`}
                          >
                            {b.tier === "pro" ? "PRO" : "FREE"}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fog/80" title={b.path}>
                            {b.version}
                          </span>
                          <span className="shrink-0 text-[11px] tabular-nums text-fog/45">{fmtSize(b.sizeBytes)}</span>
                          <button
                            className="shrink-0 rounded-md px-2 py-1 text-[11px] text-danger/80 hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                            onClick={() => removeCached(b)}
                            disabled={busyTag === b.tag}
                          >
                            {busyTag === b.tag ? "Removing…" : "Remove"}
                          </button>
                        </div>
                      ))}
                    </Card>
                  </>
                )}
              </>
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
