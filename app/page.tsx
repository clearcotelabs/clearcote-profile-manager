"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Brand, Platform, Profile, TlsProfile } from "@/types/profile";
import { profileToArgs, proxyString } from "@/types/profile";
import { api, isElectron, type Settings, type GeoResult, type LibraryProfile, type FingerprintMeta, type LicenseStatus, type VersionOption } from "@/lib/ipc";
import { LogoMark } from "@/components/LogoMark";
import { Mascot } from "@/components/Mascot";

const PLATFORMS: Platform[] = ["windows", "macos", "linux", "android"];
const BRANDS: Brand[] = ["Chrome", "Edge", "Opera", "Vivaldi"];

const randomSeed = () =>
  Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

function newProfile(): Profile {
  const now = new Date().toISOString();
  return { id: "", name: "", fingerprint: randomSeed(), platform: "windows", geoip: false, createdAt: now, updatedAt: now };
}

const input =
  "w-full rounded-lg bg-ink/70 border border-line px-3 py-2 text-sm text-fog placeholder-fog/30 outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/40";
const label = "block text-[11px] font-medium uppercase tracking-wide text-fog/45 mb-1";
const btnGhost =
  "rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-fog/80 hover:bg-elevate transition";

export default function Page() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [running, setRunning] = useState<string[]>([]);
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
  async function launch(p: Profile) {
    const r = await api.launch(p);
    if (r.ok) {
      await api.profiles.save({ ...p, lastLaunchedAt: new Date().toISOString() });
      await refresh();
      notify(`Launched “${p.name || p.id}”.`);
    } else {
      notify(r.error || "Launch failed.");
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

      {editing && <Editor profile={editing} onChange={setEditing} onSave={save} onCancel={() => setEditing(null)} />}
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

function Editor({
  profile,
  onChange,
  onSave,
  onCancel,
}: {
  profile: Profile;
  onChange: (p: Profile) => void;
  onSave: (p: Profile) => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => onChange({ ...profile, [k]: v });
  const [geo, setGeo] = useState<GeoResult | null>(null);
  const [resolving, setResolving] = useState(false);
  const [libOpen, setLibOpen] = useState(false);
  const [fpMsg, setFpMsg] = useState<string | null>(null);
  // Available browser builds (from the public catalog) for the version dropdown.
  const [versions, setVersions] = useState<VersionOption[]>([]);
  useEffect(() => {
    let alive = true;
    api.listVersions?.().then((v) => alive && setVersions(v || [])).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  async function importFp() {
    setFpMsg(null);
    const r = await api.fp.import();
    if (r.ok && r.file) onChange({ ...profile, fingerprintProfile: r.file, fingerprintProfileMeta: r.meta });
    else if (r.error) setFpMsg(r.error);
  }
  function applyLibrary(file: string, meta?: FingerprintMeta) {
    onChange({ ...profile, fingerprintProfile: file, fingerprintProfileMeta: meta });
    setLibOpen(false);
    setFpMsg(null);
  }
  async function resolveGeo() {
    setResolving(true);
    const r = await api.geoCheck(profile);
    setResolving(false);
    setGeo(r);
    if (r.ok) {
      onChange({
        ...profile,
        timezone: r.timezone || profile.timezone,
        acceptLanguage: r.acceptLanguage || profile.acceptLanguage,
        location: r.lat != null && r.lon != null ? `${r.lat},${r.lon}` : profile.location,
        webrtcIp: r.ip || profile.webrtcIp,
      });
    }
  }
  const args = profileToArgs({ ...profile, userDataDir: `profiles/${profile.id || "<id>"}/userdata` });

  return (
    <>
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/60 p-6 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-2xl border border-line bg-surface p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">{profile.id ? "Edit profile" : "New profile"}</h2>
          <button className="text-fog/40 hover:text-fog" onClick={onCancel}>
            ✕
          </button>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={label}>Name</label>
            <input className={input} value={profile.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Acme — US East" />
          </div>

          <div className="sm:col-span-2">
            <label className={label}>Fingerprint seed</label>
            <div className="flex gap-2">
              <input className={input + " font-mono"} value={profile.fingerprint} onChange={(e) => set("fingerprint", e.target.value)} />
              <button className={btnGhost} onClick={() => set("fingerprint", randomSeed())} title="Randomize">
                ↻
              </button>
            </div>
          </div>

          <div className="sm:col-span-2 rounded-lg border border-line p-3">
            <div className="flex items-center justify-between">
              <div className={label + " mb-0"}>
                Captured fingerprint <span className="normal-case text-fog/30">(optional — adopt a real machine)</span>
              </div>
              {profile.fingerprintProfile && (
                <button
                  className="text-[11px] text-fog/40 hover:text-red-400"
                  onClick={() => onChange({ ...profile, fingerprintProfile: undefined, fingerprintProfileMeta: undefined })}
                >
                  Clear
                </button>
              )}
            </div>
            {profile.fingerprintProfile ? (
              <div className="mt-1.5 rounded-lg bg-ink/50 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
                  <span className="truncate text-xs font-medium text-accent">
                    {profile.fingerprintProfileMeta?.label || profile.fingerprintProfile}
                    {profile.fingerprintProfileMeta?.source === "library" && " · library"}
                  </span>
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-fog/45">
                  {profile.fingerprintProfileMeta?.renderer || "captured profile"}
                </div>
                <div className="mt-0.5 text-[11px] text-fog/40">
                  {[
                    profile.fingerprintProfileMeta?.cores && `${profile.fingerprintProfileMeta.cores} cores`,
                    profile.fingerprintProfileMeta?.memory && `${profile.fingerprintProfileMeta.memory} GB`,
                    profile.fingerprintProfileMeta?.screen,
                  ]
                    .filter(Boolean)
                    .join("  ·  ")}
                </div>
              </div>
            ) : (
              <p className="mt-1 text-xs text-fog/45">
                Load a real machine&apos;s GPU, screen, fonts, voices &amp; WebGL. Fields it doesn&apos;t set fall back to the seed above.
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              <button className={btnGhost} onClick={importFp}>Import from file…</button>
              <button className={btnGhost} onClick={() => setLibOpen(true)}>Browse library…</button>
            </div>
            {fpMsg && <div className="mt-1.5 text-[11px] text-amber-500">{fpMsg}</div>}
          </div>

          <div>
            <label className={label}>Browser version</label>
            <select
              className={input}
              value={profile.browserVersion || "latest"}
              onChange={(e) => set("browserVersion", e.target.value === "latest" ? undefined : e.target.value)}
            >
              <option value="latest">Latest (recommended)</option>
              {versions.map((v) => (
                <option key={v.version} value={String(v.major)}>
                  {v.major} · {v.tier === "pro" ? "Pro" : "Free"} ({v.version})
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-fog/45">
              Latest = newest of your tier (Pro → 150, free → 149). A Pro build needs a license key in Settings.
            </p>
          </div>
          <div>
            <label className={label}>Platform</label>
            <select className={input} value={profile.platform || "windows"} onChange={(e) => set("platform", e.target.value as Platform)}>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>Brand</label>
            <select className={input} value={profile.brand || ""} onChange={(e) => set("brand", (e.target.value || undefined) as Brand)}>
              <option value="">(default)</option>
              {BRANDS.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>TLS profile</label>
            <select className={input} value={profile.tlsProfile || ""} onChange={(e) => set("tlsProfile", (e.target.value || undefined) as TlsProfile)}>
              <option value="">match-persona (default)</option>
              <option value="native">native — build&apos;s TLS</option>
            </select>
          </div>

          <div>
            <label className={label}>Timezone (IANA)</label>
            <input className={input} value={profile.timezone || ""} onChange={(e) => set("timezone", e.target.value || undefined)} placeholder="America/New_York" />
          </div>
          <div>
            <label className={label}>Accept-Language</label>
            <input className={input} value={profile.acceptLanguage || ""} onChange={(e) => set("acceptLanguage", e.target.value || undefined)} placeholder="en-US,en" />
          </div>

          <div>
            <label className={label}>WebRTC IP</label>
            <input className={input} value={profile.webrtcIp || ""} onChange={(e) => set("webrtcIp", e.target.value || undefined)} placeholder="(proxy egress IP)" />
          </div>
          <div>
            <label className={label}>Hardware concurrency</label>
            <input className={input} type="number" value={profile.hardwareConcurrency ?? ""} onChange={(e) => set("hardwareConcurrency", e.target.value ? Number(e.target.value) : undefined)} placeholder="(persona default)" />
          </div>

          <div className="sm:col-span-2 rounded-lg border border-line bg-ink/40 px-3 py-2">
            <div className="flex items-center gap-2">
              <input id="geoip" type="checkbox" checked={!!profile.geoip} onChange={(e) => set("geoip", e.target.checked)} className="accent-[#38e0d6]" />
              <label htmlFor="geoip" className="flex-1 text-sm text-fog/80">
                <span className="font-medium">geoip</span> — auto-match timezone / language / WebRTC IP to the proxy&apos;s exit region
              </label>
              {profile.proxy && (
                <button className={btnGhost} onClick={resolveGeo} disabled={resolving}>
                  {resolving ? "Resolving…" : "Resolve from proxy →"}
                </button>
              )}
            </div>
            {geo && (
              <div className={`mt-2 font-mono text-[11px] ${geo.ok ? "text-accent" : "text-amber-500"}`}>
                {geo.ok
                  ? `egress ${geo.ip} · ${geo.country ?? "?"} · ${geo.timezone ?? "?"} · ${geo.acceptLanguage ?? "?"}`
                  : geo.error}
              </div>
            )}
          </div>

          <div className="sm:col-span-2 rounded-lg border border-line p-3">
            <div className={label}>Proxy</div>
            <input
              className={input + " font-mono"}
              value={proxyString(profile.proxy)}
              onChange={(e) => set("proxy", e.target.value || undefined)}
              placeholder="http://user:pass@host:8080  ·  socks5://host:1080"
            />
            <p className="mt-1.5 text-[11px] text-fog/40">
              One string, credentials inline. An authenticated http/https proxy is served to the browser through a local auth-injecting relay — no manual proxy prompt.
            </p>
          </div>

          <details className="sm:col-span-2 group rounded-lg border border-line p-3">
            <summary className="flex cursor-pointer list-none items-center justify-between text-[11px] font-medium uppercase tracking-wide text-fog/45">
              <span>Advanced stealth</span>
              <span className="text-fog/30 transition group-open:rotate-90">▸</span>
            </summary>
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex items-start gap-2 text-sm text-fog/80 sm:col-span-2">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[#38e0d6]"
                  checked={profile.fingerprintNoise !== false}
                  onChange={(e) => set("fingerprintNoise", e.target.checked)}
                />
                <span>
                  <span className="font-medium">Farbling noise</span> — on by default. Turn off so canvas / WebGL / audio
                  return natural, unperturbed values that read as untampered to strict detectors (best paired with a
                  captured profile). Identity spoofs stay on.
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm text-fog/80 sm:col-span-2">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[#38e0d6]"
                  checked={!!profile.disableGpuFingerprint}
                  onChange={(e) => set("disableGpuFingerprint", e.target.checked || undefined)}
                />
                <span>
                  <span className="font-medium">Use real GPU</span> — report the host&apos;s actual GPU / WebGL instead of
                  a spoofed one. Most coherent when the persona/profile GPU can&apos;t match the host&apos;s real render;
                  overrides the GPU spoof below.
                </span>
              </label>

              <div>
                <label className={label}>Storage quota (MB)</label>
                <input
                  className={input}
                  type="number"
                  value={profile.storageQuota ?? ""}
                  onChange={(e) => set("storageQuota", e.target.value ? Number(e.target.value) : undefined)}
                  placeholder="250000 (≈ 244 GB)"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={label}>Platform ver.</label>
                  <input className={input} value={profile.platformVersion || ""} onChange={(e) => set("platformVersion", e.target.value || undefined)} placeholder="(default)" />
                </div>
                <div>
                  <label className={label}>Brand ver.</label>
                  <input className={input} value={profile.brandVersion || ""} onChange={(e) => set("brandVersion", e.target.value || undefined)} placeholder="(default)" />
                </div>
              </div>

              <div>
                <label className={label}>GPU vendor</label>
                <input
                  className={input + " disabled:opacity-40"}
                  value={profile.gpuVendor || ""}
                  onChange={(e) => set("gpuVendor", e.target.value || undefined)}
                  placeholder="Google Inc. (Intel)"
                  disabled={!!profile.disableGpuFingerprint}
                />
              </div>
              <div>
                <label className={label}>GPU renderer</label>
                <input
                  className={input + " disabled:opacity-40"}
                  value={profile.gpuRenderer || ""}
                  onChange={(e) => set("gpuRenderer", e.target.value || undefined)}
                  placeholder="ANGLE (Intel, …)"
                  disabled={!!profile.disableGpuFingerprint}
                />
              </div>

              <div className="sm:col-span-2 rounded-lg border border-line/70 bg-ink/30 p-3">
                <div className={label + " mb-1"}>
                  Canvas bridge <span className="normal-case text-fog/30">(experimental — needs a real-GPU bridge host)</span>
                </div>
                <input
                  className={input + " font-mono"}
                  value={profile.canvasBridgeUrl || ""}
                  onChange={(e) => set("canvasBridgeUrl", e.target.value || undefined)}
                  placeholder="ws://bridge-host:8443/render"
                />
                <input
                  className={input + " mt-2 font-mono"}
                  value={profile.canvasBridgeAuth || ""}
                  onChange={(e) => set("canvasBridgeAuth", e.target.value || undefined)}
                  placeholder="user:secret"
                />
                <p className="mt-1.5 text-[11px] text-fog/40">
                  Renders canvas / WebGL on a remote real-GPU host so the pixel readback matches the claimed GPU — for
                  sites that pixel-hash the canvas. Leave blank to render locally.
                </p>
              </div>

              <p className="sm:col-span-2 text-[11px] text-fog/40">
                Tip: for the strongest coherence, adopt a captured profile whose <span className="text-fog/60">GPU vendor matches your host</span> and turn Farbling noise off.
              </p>
            </div>
          </details>

          <div>
            <label className={label}>Tags (comma-separated)</label>
            <input className={input} value={(profile.tags || []).join(", ")} onChange={(e) => set("tags", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} placeholder="us, social" />
          </div>
          <div>
            <label className={label}>Group</label>
            <input className={input} value={profile.group || ""} onChange={(e) => set("group", e.target.value || undefined)} placeholder="(optional)" />
          </div>

          <div className="sm:col-span-2">
            <label className={label}>Notes</label>
            <textarea className={input + " min-h-[60px] resize-y"} value={profile.notes || ""} onChange={(e) => set("notes", e.target.value || undefined)} />
          </div>

          <div className="sm:col-span-2">
            <label className={label}>Launch command (preview)</label>
            <pre className="max-h-28 overflow-auto rounded-lg bg-ink/80 p-3 font-mono text-[11px] leading-relaxed text-fog/60">
              chrome.exe {args.join(" \\\n  ")}
            </pre>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button className={btnGhost} onClick={onCancel}>
            Cancel
          </button>
          <button
            className="rounded-lg bg-sheen px-4 py-1.5 text-sm font-semibold text-[#07080a] disabled:opacity-40"
            disabled={!profile.fingerprint}
            onClick={() => onSave(profile)}
          >
            Save profile
          </button>
        </div>
      </div>
    </div>
    {libOpen && <LibraryModal onApply={applyLibrary} onClose={() => setLibOpen(false)} />}
    </>
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
  const shown = (list || []).filter((p) => vendor === "all" || p.gpuVendor === vendor);
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
                  {[p.gpuVendor, p.screen, p.name.replace(/\.json$/, "")].filter(Boolean).join("  ·  ")}
                </span>
              </span>
              <span className="ml-2 shrink-0 text-[11px] text-accent">{busy === p.name ? "applying…" : "Use →"}</span>
            </button>
          ))}
          {list && shown.length === 0 && <div className="p-4 text-sm text-fog/40">No profiles for this vendor.</div>}
        </div>
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

        <div className="mt-6 flex justify-end">
          <button className="rounded-lg bg-sheen px-4 py-1.5 text-sm font-semibold text-[#07080a]" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
