"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Profile } from "@/types/profile";
import { MIN_PROFILE_SCREEN_WIDTH, MIN_PROFILE_SCREEN_HEIGHT } from "@/types/profile";
import { api, isElectron, type Settings, type LibraryProfile, type FingerprintMeta, type LicenseStatus, type DownloadProgress, type CachedBuild, type UpdateInfo } from "@/lib/ipc";
import ProfileEditor from "@/components/ProfileEditor";
import { LogoMark } from "@/components/LogoMark";
import { Mascot } from "@/components/Mascot";


const randomSeed = () =>
  Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

function newProfile(): Profile {
  const now = new Date().toISOString();
  // geoip ON by default. It only does anything once a proxy is set, and when one IS set, matching
  // the persona's timezone/language/position to the proxy's exit region is what everyone wants —
  // the off-by-default version shipped a profile that looked configured while the Geolocation API
  // quietly kept reporting the real position, which is exactly how a customer found it.
  return { id: "", name: "", fingerprint: randomSeed(), platform: "windows", geoip: true, createdAt: now, updatedAt: now };
}

const input =
  "w-full rounded-lg bg-ink/70 border border-line px-3 py-2 text-sm text-fog placeholder-fog/30 outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/40";
const label = "block text-[11px] font-medium uppercase tracking-wide text-fog/45 mb-1";
const btnGhost =
  "rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-fog/80 hover:bg-elevate transition";

export default function Page() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [running, setRunning] = useState<string[]>([]);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [dl, setDl] = useState<DownloadProgress | null>(null);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState<Settings>({});
  const [binary, setBinary] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Resolved after mount so the first client render matches the server prerender
  // (window.clearcote only exists in the Electron renderer → avoids a hydration mismatch).
  const [isEl, setIsEl] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [mounted, setMounted] = useState(false);
  // App update. Checked once on launch (the main process applies the once-a-day throttle and the
  // "off" setting), so a user on an old build learns that a fix shipped — which is otherwise
  // impossible: the browser engine updates itself while the app driving it cannot.
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updDl, setUpdDl] = useState<{ pct: number; seenMB: number; totalMB: number } | null>(null);
  const [updFile, setUpdFile] = useState<{ path: string; verified: boolean } | null>(null);
  const [updBusy, setUpdBusy] = useState(false);
  const [updErr, setUpdErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setProfiles(await api.profiles.list());
    setRunning(await api.running());
  }, []);

  useEffect(() => {
    setMounted(true);
    setIsEl(isElectron);
    // sync from the theme the no-flash inline script already applied
    setTheme(document.documentElement.classList.contains("light") ? "light" : "dark");
    refresh();
    api.settings.get().then(setSettings);
    api.resolveBinary().then(setBinary);
  }, [refresh]);

  useEffect(() => {
    if (!mounted) return;
    document.documentElement.classList.toggle("light", theme === "light");
    try {
      localStorage.setItem("clearcote.theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme, mounted]);
  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  useEffect(() => {
    const t = setInterval(async () => setRunning(await api.running()), 2500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let alive = true;
    api.update?.check().then((u) => alive && u?.available && setUpdate(u)).catch(() => {});
    const off = api.onUpdateProgress?.((p) => setUpdDl(p));
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  async function downloadUpdate() {
    if (!update) return;
    setUpdBusy(true);
    setUpdErr(null);
    setUpdDl(null);
    try {
      const r = await api.update.download(update);
      if (r.ok && r.path) setUpdFile({ path: r.path, verified: !!r.verified });
      else setUpdErr(r.error || "Download failed.");
    } finally {
      setUpdBusy(false);
      setUpdDl(null);
    }
  }
  async function skipUpdate() {
    if (update) await api.update.skip(update.latest);
    setUpdate(null);
  }

  const notify = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 3500);
  };

  async function save(p: Profile) {
    const id = p.id || `${slugify(p.name) || "profile"}-${randomSeed().slice(0, 4)}`;
    const saved = await api.profiles.save({ ...p, id });
    setEditing(null);
    await refresh();
    notify(`Saved “${saved.name || saved.id}”.`);
  }
  async function remove(p: Profile) {
    if (!confirm(`Delete “${p.name || p.id}” and its saved browser data?`)) return;
    await api.profiles.remove(p.id);
    await refresh();
    notify("Deleted.");
  }
  function duplicate(p: Profile) {
    setEditing({ ...p, id: "", name: `${p.name} copy`, fingerprint: randomSeed(), createdAt: "", updatedAt: "" });
  }
  // Live browser-download progress (first launch of a version downloads 100–250 MB).
  useEffect(() => {
    const off = api.onDownloadProgress?.((prog) => setDl(prog));
    return () => off?.();
  }, []);

  async function launch(p: Profile) {
    setLaunchingId(p.id);
    setDl(null);
    try {
      const r = await api.launch(p);
      if (r.ok) {
        await api.profiles.save({ ...p, lastLaunchedAt: new Date().toISOString() });
        await refresh();
        // Warnings mean the browser DID start but an option silently won't take effect (a switch
        // the resolved build predates, or geoip failing to resolve). Saying so beats letting the
        // user discover it from a site that blocks them.
        notify(r.warnings?.length ? `Launched “${p.name || p.id}” — ${r.warnings.join(" ")}` : `Launched “${p.name || p.id}”.`);
      } else {
        notify(r.error || "Launch failed.");
      }
    } finally {
      setLaunchingId(null);
      setDl(null);
    }
  }
  async function stop(p: Profile) {
    await api.stop(p.id);
    setTimeout(refresh, 300);
  }
  async function pickBinary() {
    const b = await api.pickBinary();
    if (b) {
      setBinary(b);
      setSettings(await api.settings.get());
      notify("Browser binary set.");
    }
  }
  async function doExport() {
    const r = await api.exportProfiles();
    notify(r.ok ? `Exported ${r.count} profile${r.count === 1 ? "" : "s"} (proxy passwords redacted).` : "Export canceled.");
  }
  async function doImport() {
    const r = await api.importProfiles();
    if (r.ok) {
      await refresh();
      notify(`Imported ${r.count} profile${r.count === 1 ? "" : "s"}.`);
    } else {
      notify(r.error || "Import canceled.");
    }
  }

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return profiles;
    return profiles.filter((p) =>
      [p.name, p.fingerprint, p.group, p.notes, ...(p.tags || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [profiles, query]);

  return (
    <main className="app-sheen relative min-h-screen">
      <div className="relative z-10 mx-auto max-w-6xl px-6 py-6 animate-fade-up">
        {/* Header */}
        <header className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <LogoMark className="h-8 w-8" />
            <div>
              <div className="text-[15px] font-semibold tracking-tight">
                Clear<span className="text-fog/55">cote</span>{" "}
                <span className="text-fog/45 font-normal">Profile Manager</span>
              </div>
              <div className="text-xs text-fog/40">A clear coat for your browser identity.</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={`hidden sm:inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${
                binary ? "border-accent/30 text-accent" : "border-amber-500/40 text-amber-500"
              }`}
              title={binary || "No binary resolved — set it in Settings"}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${binary ? "bg-accent" : "bg-amber-400"}`} />
              {binary ? "Browser ready" : "Browser not set"}
            </span>
            <button
              className={btnGhost + " w-8 px-0 text-sm"}
              onClick={toggleTheme}
              title="Toggle light / dark theme"
              aria-label="Toggle light or dark theme"
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <button className={btnGhost} onClick={() => setShowSettings(true)}>
              Settings
            </button>
            <button
              className="rounded-lg bg-sheen px-3.5 py-1.5 text-xs font-semibold text-[#07080a] shadow-[0_0_20px_-6px_rgba(56,224,214,0.6)] hover:opacity-95 transition"
              onClick={() => setEditing(newProfile())}
            >
              + New profile
            </button>
          </div>
        </header>

        {!isEl && (
          <div className="mt-4 rounded-lg border border-iris/25 bg-iris/5 px-3 py-2 text-xs text-iris">
            Browser preview — profiles are stored locally in this browser and launching is disabled. Run the desktop app for the full experience.
          </div>
        )}

        {/* A new release exists. Notified, never installed behind your back: this build is unsigned,
            so an unattended install would be an unverified code path — see electron/appupdate.ts. */}
        {update && (
          <div className="mt-4 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2.5 text-xs">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="font-medium text-accent">Version {update.latest} is available</span>
              <span className="text-fog/40">you have {update.current}</span>
              <span className="flex-1" />
              {!updFile && (
                <>
                  <button className={btnGhost + " py-1"} onClick={() => api.update.openReleases(update.releaseUrl)}>
                    What&apos;s new
                  </button>
                  <button
                    className="rounded-lg bg-sheen px-3 py-1 text-xs font-semibold text-[#07080a] disabled:opacity-40"
                    onClick={downloadUpdate}
                    disabled={updBusy || !update.asset}
                    title={update.asset?.name || "No matching asset — use the release page"}
                  >
                    {updBusy ? "Downloading…" : "Download"}
                  </button>
                  <button className={btnGhost + " py-1"} onClick={skipUpdate}>
                    Skip
                  </button>
                </>
              )}
              {updFile && (
                <>
                  <button
                    className="rounded-lg bg-sheen px-3 py-1 text-xs font-semibold text-[#07080a]"
                    onClick={() => api.update.run(updFile.path)}
                  >
                    Run installer
                  </button>
                  <button className={btnGhost + " py-1"} onClick={() => api.update.reveal(updFile.path)}>
                    Show in folder
                  </button>
                </>
              )}
            </div>

            {updDl && (
              <div className="mt-2">
                <div className="h-1 w-full overflow-hidden rounded bg-line">
                  <div className="h-full bg-sheen transition-all" style={{ width: `${updDl.pct}%` }} />
                </div>
                <p className="mt-1 text-[11px] text-fog/40">
                  {updDl.pct}% · {updDl.seenMB.toFixed(1)} / {updDl.totalMB.toFixed(1)} MB
                </p>
              </div>
            )}

            {updFile && (
              // "Downloaded" and "downloaded and verified" are different claims, so which one it is
              // gets said. The checksum ships from the same release as the binary, so it catches a
              // corrupted or tampered download — not a compromised release. Signing is what would
              // cover that, and this build is unsigned.
              <p className="mt-2 text-[11px] text-fog/45">
                {updFile.verified
                  ? "✓ SHA-256 matches the checksum published with the release — so the download is intact. That is not a signature: the app is unsigned, and Windows will warn on first run (More info → Run anyway)."
                  : "⚠ Downloaded, but the release published no checksums file, so nothing could be verified. Check it by hand before running it."}
              </p>
            )}

            {updErr && <p className="mt-2 text-[11px] text-amber-500">{updErr}</p>}
            {!update.asset && (
              <p className="mt-2 text-[11px] text-fog/45">
                No asset matched this installation, so nothing is offered automatically — open the release page and
                pick the right one.
              </p>
            )}
          </div>
        )}

        {/* Toolbar */}
        <div className="mt-6 flex items-center gap-3">
          <input
            className={input + " max-w-sm"}
            placeholder="Search profiles, seeds, tags…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="text-xs text-fog/35">
            {profiles.length} profile{profiles.length === 1 ? "" : "s"}
          </div>
          <div className="ml-auto flex gap-2">
            <button className={btnGhost} onClick={doImport}>
              Import
            </button>
            <button className={btnGhost} onClick={doExport} disabled={profiles.length === 0}>
              Export
            </button>
          </div>
        </div>

        {/* List */}
        {filtered.length === 0 ? (
          <div className="mt-8 flex flex-col items-center text-center animate-fade-up">
            <div className="relative">
              <span aria-hidden className="pointer-events-none absolute -left-5 top-5 h-1.5 w-1.5 rounded-full bg-accent animate-twinkle" />
              <span aria-hidden className="pointer-events-none absolute right-1 -top-1 h-1 w-1 rounded-full bg-iris animate-twinkle [animation-delay:1s]" />
              <span aria-hidden className="pointer-events-none absolute -right-6 bottom-14 h-1.5 w-1.5 rounded-full bg-sky animate-twinkle [animation-delay:2.1s]" />
              <Mascot
                animate={profiles.length === 0}
                className={profiles.length === 0 ? "w-56 max-w-[58vw]" : "w-28 opacity-70"}
              />
            </div>
            <h2 className="mt-3 text-xl font-semibold">
              {profiles.length === 0 ? "Meet Clyde — your first identity awaits" : "No matches"}
            </h2>
            <p className="mt-1.5 max-w-sm text-sm text-fog/50">
              {profiles.length === 0
                ? "Chameleons blend in to stay unseen. Spin up a profile — a saved fingerprint seed, proxy, and persistent session — and launch it any time."
                : "Try a different search."}
            </p>
            {profiles.length === 0 && (
              <button
                className="mt-6 rounded-lg bg-sheen px-5 py-2.5 text-sm font-semibold text-[#07080a] shadow-[0_0_26px_-6px_rgba(56,224,214,0.55)] transition hover:opacity-95 active:scale-[0.98]"
                onClick={() => setEditing(newProfile())}
              >
                + Create your first profile
              </button>
            )}
          </div>
        ) : (
          <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((p) => {
              const isRunning = running.includes(p.id);
              return (
                <div
                  key={p.id}
                  className="group rounded-xl border border-line bg-surface/80 p-4 transition duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-[0_10px_30px_-14px_rgba(56,224,214,0.35)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{p.name || p.id}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-fog/40 truncate">
                        seed {p.fingerprint}
                      </div>
                    </div>
                    {isRunning && (
                      <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> running
                      </span>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {p.platform && <Chip>{p.platform}</Chip>}
                    {p.timezone && <Chip>{p.timezone}</Chip>}
                    {p.geoip && <Chip accent>geoip</Chip>}
                    {p.proxy && <Chip>proxy</Chip>}
                    {p.fingerprintProfile && <Chip accent>fp</Chip>}
                    {p.fingerprintNoise === false && <Chip>noise off</Chip>}
                    {p.disableGpuFingerprint && <Chip>real gpu</Chip>}
                    {p.canvasBridgeUrl && <Chip accent>bridge</Chip>}
                    {(p.tags || []).map((t) => (
                      <Chip key={t}>#{t}</Chip>
                    ))}
                  </div>

                  <div className="mt-4 flex items-center gap-1.5">
                    {isRunning ? (
                      <button
                        className="flex-1 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-semibold text-fog hover:bg-elevate"
                        onClick={() => stop(p)}
                      >
                        Stop
                      </button>
                    ) : launchingId === p.id ? (
                      <div className="flex-1">
                        {dl && dl.id === p.id ? (
                          <>
                            <div className="flex items-center justify-between text-[11px] font-medium text-fog/70">
                              <span>Downloading Chrome {dl.version.split(".")[0]}…</span>
                              <span>{dl.pct}% · {dl.seenMB}/{dl.totalMB} MB</span>
                            </div>
                            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-line">
                              <div
                                className="h-full rounded-full bg-sheen transition-[width] duration-200"
                                style={{ width: `${dl.pct}%` }}
                              />
                            </div>
                          </>
                        ) : (
                          <div className="rounded-lg bg-elevate px-3 py-1.5 text-center text-xs font-semibold text-fog/70">
                            <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent align-middle" />
                            Launching…
                          </div>
                        )}
                      </div>
                    ) : (
                      <button
                        className="flex-1 rounded-lg bg-sheen px-3 py-1.5 text-xs font-semibold text-[#07080a] hover:opacity-95"
                        onClick={() => launch(p)}
                      >
                        Launch
                      </button>
                    )}
                    <button className={btnGhost} onClick={() => setEditing(p)}>
                      Edit
                    </button>
                    <button className={btnGhost} onClick={() => duplicate(p)} title="Duplicate">
                      Dup
                    </button>
                    <button
                      className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-fog/50 hover:bg-red-500/10 hover:text-red-400"
                      onClick={() => remove(p)}
                      title="Delete"
                    >
                      Del
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {editing && (
        <ProfileEditor
          profile={editing}
          onChange={setEditing}
          onSave={save}
          onCancel={() => setEditing(null)}
          renderLibrary={(onApply, onClose) => <LibraryModal onApply={onApply} onClose={onClose} />}
        />
      )}
      {showSettings && (
        <SettingsModal
          binary={binary}
          settings={settings}
          onPick={pickBinary}
          onSaveSettings={async (patch) => {
            const next = { ...settings, ...patch };
            setSettings(next);
            await api.settings.set(next);
          }}
          onClose={() => setShowSettings(false)}
        />
      )}
      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line bg-surface px-4 py-2 text-sm shadow-lg">
          {toast}
        </div>
      )}
    </main>
  );
}

function Chip({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-[10px] ${
        accent ? "bg-accent/10 text-accent" : "bg-elevate text-fog/55"
      }`}
    >
      {children}
    </span>
  );
}

function LibraryModal({
  onApply,
  onClose,
}: {
  onApply: (file: string, meta?: FingerprintMeta) => void;
  onClose: () => void;
}) {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-line bg-surface p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">clearcote-profiles library</h2>
          <button className="text-fog/40 hover:text-fog" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="mt-1 text-xs text-fog/45">
          Curated real-GPU desktop fingerprints. <span className="text-fog/65">Pick one whose GPU vendor matches your host</span> so the imported GPU stays coherent with the real render.
        </p>
        {err && <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-500">{err}</div>}
        {vendors.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {["all", ...vendors].map((v) => (
              <button
                key={v}
                onClick={() => setVendor(v)}
                className={`rounded-md px-2 py-1 text-[11px] ${vendor === v ? "bg-accent/15 text-accent" : "bg-elevate text-fog/55 hover:text-fog/80"}`}
              >
                {v}
                {v !== "all" && <span className="ml-1 text-fog/30">{(list || []).filter((p) => p.gpuVendor === v).length}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 flex-1 overflow-y-auto rounded-lg border border-line">
          {!list && !err && <div className="p-4 text-sm text-fog/40">Loading…</div>}
          {shown.map((p) => (
            <button
              key={p.name}
              onClick={() => pick(p)}
              disabled={!!busy}
              className="flex w-full items-center justify-between gap-2 border-b border-line/50 px-3 py-2 text-left last:border-0 hover:bg-elevate disabled:opacity-50"
            >
              <span className="min-w-0">
                <span className="block truncate text-[12px] text-fog/75">
                  {p.renderer ? p.renderer.replace(/^ANGLE \(/, "").replace(/\)$/, "") : p.name.replace(/\.json$/, "")}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[10px] text-fog/40">
                  {p.screenWarning && <span className="mr-1 text-amber-500" title={p.screenWarning}>⚠</span>}
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
          From{" "}
          <span className="font-mono">github.com/clearcotelabs/clearcote-profiles</span> · or use{" "}
          <span className="font-mono">Import from file…</span> for your own capture.
        </p>
      </div>
    </div>
  );
}

function SettingsModal({
  binary,
  settings,
  onPick,
  onSaveSettings,
  onClose,
}: {
  binary: string | null;
  settings: Settings;
  onPick: () => void;
  onSaveSettings: (patch: Partial<Settings>) => Promise<void> | void;
  onClose: () => void;
}) {
  const [key, setKey] = useState(settings.licenseKey || "");
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const dirty = (key.trim() || undefined) !== (settings.licenseKey || undefined);

  // Downloaded-browser cache (view + remove to force a re-download).
  const [updMsg, setUpdMsg] = useState<string | null>(null);
  const [cached, setCached] = useState<CachedBuild[] | null>(null);
  const [busyTag, setBusyTag] = useState<string | null>(null);
  const loadCache = () => api.cache.list().then(setCached).catch(() => setCached([]));
  useEffect(() => {
    void loadCache();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fmtSize = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
  async function removeCached(b: CachedBuild) {
    if (!confirm(`Remove the downloaded ${b.version} browser (${fmtSize(b.sizeBytes)})?\nIt will re-download automatically on the next launch that needs it.`)) return;
    setBusyTag(b.tag);
    try {
      await api.cache.remove(b.tag);
      await loadCache();
    } finally {
      setBusyTag(null);
    }
  }

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

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Settings</h2>
          <button className="text-fog/40 hover:text-fog" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="mt-5">
          <div className={label}>Clearcote browser binary</div>
          <p className="mb-2 text-xs text-fog/45">
            Path to <span className="font-mono">chrome.exe</span>. Auto-detected from a sibling <span className="font-mono">win-x64</span> build or <span className="font-mono">CLEARCOTE_BINARY</span>; override here.
          </p>
          <div className="rounded-lg bg-ink/70 px-3 py-2 font-mono text-[11px] text-fog/60 break-all">
            {settings.binaryPath || binary || "(not set)"}
          </div>
          <button className="mt-3 rounded-lg border border-line-strong px-3 py-1.5 text-xs hover:bg-elevate" onClick={onPick}>
            Choose binary…
          </button>
        </div>

        <div className="mt-6 border-t border-line pt-5">
          <div className={label}>PRO license key</div>
          <p className="mb-2 text-xs text-fog/45">
            With a key, profiles launch the <span className="font-medium text-fog/70">license-gated PRO browser</span> (auto-downloaded + SHA-256 verified) and claim one floating-concurrency slot. Leave blank for the free build — no key means no contact with the license backend.
          </p>
          <div className="flex gap-2">
            <input
              className={`${input} font-mono`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="cc_lic_…"
            />
            <button
              className="shrink-0 rounded-lg border border-line-strong px-3 py-1.5 text-xs hover:bg-elevate disabled:opacity-40"
              onClick={saveKey}
              disabled={!dirty}
            >
              Save
            </button>
            <button
              className="shrink-0 rounded-lg border border-line-strong px-3 py-1.5 text-xs hover:bg-elevate disabled:opacity-40"
              onClick={checkKey}
              disabled={checking || !key.trim()}
            >
              {checking ? "Checking…" : "Check"}
            </button>
          </div>
          {status && (
            <div
              className={`mt-2 rounded-lg px-3 py-2 text-xs ${
                status.ok
                  ? "bg-emerald-500/10 text-emerald-300"
                  : "bg-rose-500/10 text-rose-300"
              }`}
            >
              {status.ok ? (
                <>
                  ✓ Valid{status.plan ? ` — ${status.plan} plan` : ""}
                  {typeof status.limit === "number"
                    ? ` · ${status.used ?? 0}/${status.limit === 0 ? "unlimited" : status.limit} slots in use`
                    : ""}
                </>
              ) : (
                <>✕ {status.error || "Invalid license."}</>
              )}
            </div>
          )}
        </div>

        <div className="mt-6 border-t border-line pt-5">
          <div className="flex items-center justify-between">
            {/* Update checking. A toggle rather than invisible behaviour: this audience is exactly
                the one that cares whether an app phones home, and the copy says where it goes. */}
            <div className="rounded-lg border border-line p-3">
              <label className="flex items-start gap-2.5 text-sm text-fog/80">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[#38e0d6]"
                  checked={settings.updateCheck !== false}
                  onChange={(e) => onSaveSettings({ updateCheck: e.target.checked })}
                />
                <span>
                  <span className="font-medium text-fog">Check for app updates</span> — once a day, ask
                  <span className="font-mono text-[11px]"> api.github.com</span> whether a newer release exists. Nothing
                  is downloaded or installed without you clicking: this build is unsigned, so an unattended install
                  would be a code path nobody verified.
                  <span className="mt-1 block text-[11px] text-fog/40">
                    The browser engine already updates itself, so with this off an old app can sit on fixed bugs
                    indefinitely.
                  </span>
                </span>
              </label>
              <div className="mt-2 flex items-center gap-2">
                <button
                  className={btnGhost + " py-1 text-xs"}
                  onClick={async () => {
                    setUpdMsg("Checking…");
                    const u = await api.update.check(true);
                    setUpdMsg(
                      !u
                        ? "Could not reach GitHub."
                        : u.available
                          ? `Version ${u.latest} is available — see the banner.`
                          : `Up to date (${u.current}).`,
                    );
                  }}
                >
                  Check now
                </button>
                {settings.lastUpdateCheck && (
                  <span className="text-[11px] text-fog/35">
                    last checked {new Date(settings.lastUpdateCheck).toLocaleString()}
                  </span>
                )}
              </div>
              {updMsg && <p className="mt-1.5 text-[11px] text-fog/50">{updMsg}</p>}
            </div>

            <div className={label}>Downloaded browsers</div>
            {cached && cached.length > 0 && (
              <span className="text-[11px] text-fog/45">
                {cached.length} · {fmtSize(cached.reduce((s, b) => s + b.sizeBytes, 0))}
              </span>
            )}
          </div>
          <p className="mb-2 text-xs text-fog/45">
            Verified browser builds cached on disk. Remove one to reclaim space or force a fresh
            re-download on the next launch that needs it.
          </p>
          {cached === null ? (
            <div className="text-xs text-fog/45">Loading…</div>
          ) : cached.length === 0 ? (
            <div className="rounded-lg bg-ink/70 px-3 py-2 text-xs text-fog/45">Nothing downloaded yet.</div>
          ) : (
            <div className="space-y-1.5">
              {cached.map((b) => (
                <div key={b.tag} className="flex items-center gap-3 rounded-lg bg-ink/70 px-3 py-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      b.tier === "pro" ? "bg-sheen/20 text-sheen" : "bg-elevate text-fog/60"
                    }`}
                  >
                    {b.tier === "pro" ? "PRO" : "FREE"}
                  </span>
                  <span className="font-mono text-xs text-fog/80 break-all">{b.version}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-fog/45">{fmtSize(b.sizeBytes)}</span>
                  <button
                    className="shrink-0 rounded-md border border-line-strong px-2 py-1 text-[11px] text-rose-300 hover:bg-rose-500/10 disabled:opacity-40"
                    onClick={() => removeCached(b)}
                    disabled={busyTag === b.tag}
                  >
                    {busyTag === b.tag ? "Removing…" : "Remove"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end">
          <button className="rounded-lg bg-sheen px-4 py-1.5 text-sm font-semibold text-[#07080a]" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
