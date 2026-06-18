"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Brand, Platform, Profile } from "@/types/profile";
import { profileToArgs } from "@/types/profile";
import { api, isElectron, type Settings, type GeoResult } from "@/lib/ipc";
import { LogoMark } from "@/components/LogoMark";

const PLATFORMS: Platform[] = ["windows", "macos", "linux"];
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
  "w-full rounded-lg bg-ink/70 border border-white/10 px-3 py-2 text-sm text-fog placeholder-fog/30 outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/40";
const label = "block text-[11px] font-medium uppercase tracking-wide text-fog/45 mb-1";
const btnGhost =
  "rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-fog/80 hover:bg-white/5 transition";

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

  const refresh = useCallback(async () => {
    setProfiles(await api.profiles.list());
    setRunning(await api.running());
  }, []);

  useEffect(() => {
    setIsEl(isElectron);
    refresh();
    api.settings.get().then(setSettings);
    api.resolveBinary().then(setBinary);
  }, [refresh]);

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
      <div className="relative z-10 mx-auto max-w-6xl px-6 py-6">
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
                binary ? "border-accent/30 text-accent" : "border-amber-400/30 text-amber-300"
              }`}
              title={binary || "No binary resolved — set it in Settings"}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${binary ? "bg-accent" : "bg-amber-400"}`} />
              {binary ? "Browser ready" : "Browser not set"}
            </span>
            <button className={btnGhost} onClick={() => setShowSettings(true)}>
              Settings
            </button>
            <button
              className="rounded-lg bg-sheen px-3.5 py-1.5 text-xs font-semibold text-ink shadow-[0_0_20px_-6px_rgba(56,224,214,0.6)] hover:opacity-95 transition"
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
          <div className="mt-16 flex flex-col items-center text-center">
            <LogoMark className="h-12 w-12 opacity-80" />
            <h2 className="mt-4 text-lg font-semibold">
              {profiles.length === 0 ? "No profiles yet" : "No matches"}
            </h2>
            <p className="mt-1 max-w-sm text-sm text-fog/45">
              {profiles.length === 0
                ? "Create your first identity — a saved fingerprint seed, proxy, and persistent session you can launch any time."
                : "Try a different search."}
            </p>
            {profiles.length === 0 && (
              <button
                className="mt-5 rounded-lg bg-sheen px-4 py-2 text-sm font-semibold text-ink"
                onClick={() => setEditing(newProfile())}
              >
                + Create a profile
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
                  className="group rounded-xl border border-white/10 bg-surface/80 p-4 transition hover:border-accent/30"
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
                    {p.proxy?.server && <Chip>proxy</Chip>}
                    {(p.tags || []).map((t) => (
                      <Chip key={t}>#{t}</Chip>
                    ))}
                  </div>

                  <div className="mt-4 flex items-center gap-1.5">
                    {isRunning ? (
                      <button
                        className="flex-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs font-semibold text-fog hover:bg-white/5"
                        onClick={() => stop(p)}
                      >
                        Stop
                      </button>
                    ) : (
                      <button
                        className="flex-1 rounded-lg bg-sheen px-3 py-1.5 text-xs font-semibold text-ink hover:opacity-95"
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
                      className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-fog/50 hover:bg-red-500/10 hover:text-red-300"
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
          onClose={() => setShowSettings(false)}
        />
      )}
      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-white/10 bg-surface px-4 py-2 text-sm shadow-lg">
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
        accent ? "bg-accent/10 text-accent" : "bg-white/5 text-fog/55"
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
  const setProxy = (k: "server" | "username" | "password", v: string) =>
    onChange({ ...profile, proxy: { server: "", ...(profile.proxy || {}), [k]: v } });
  const [geo, setGeo] = useState<GeoResult | null>(null);
  const [resolving, setResolving] = useState(false);
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
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/60 p-6 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-2xl border border-white/10 bg-surface p-6 shadow-2xl">
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

          <div className="sm:col-span-2 rounded-lg border border-white/10 bg-ink/40 px-3 py-2">
            <div className="flex items-center gap-2">
              <input id="geoip" type="checkbox" checked={!!profile.geoip} onChange={(e) => set("geoip", e.target.checked)} className="accent-[#38e0d6]" />
              <label htmlFor="geoip" className="flex-1 text-sm text-fog/80">
                <span className="font-medium">geoip</span> — auto-match timezone / language / WebRTC IP to the proxy&apos;s exit region
              </label>
              {profile.proxy?.server && (
                <button className={btnGhost} onClick={resolveGeo} disabled={resolving}>
                  {resolving ? "Resolving…" : "Resolve from proxy →"}
                </button>
              )}
            </div>
            {geo && (
              <div className={`mt-2 font-mono text-[11px] ${geo.ok ? "text-accent" : "text-amber-300"}`}>
                {geo.ok
                  ? `egress ${geo.ip} · ${geo.country ?? "?"} · ${geo.timezone ?? "?"} · ${geo.acceptLanguage ?? "?"}`
                  : geo.error}
              </div>
            )}
          </div>

          <div className="sm:col-span-2 rounded-lg border border-white/10 p-3">
            <div className={label}>Proxy</div>
            <input className={input + " mb-2"} value={profile.proxy?.server || ""} onChange={(e) => setProxy("server", e.target.value)} placeholder="http://host:8080 or socks5://host:1080" />
            <div className="grid grid-cols-2 gap-2">
              <input className={input} value={profile.proxy?.username || ""} onChange={(e) => setProxy("username", e.target.value)} placeholder="username" />
              <input className={input} type="password" value={profile.proxy?.password || ""} onChange={(e) => setProxy("password", e.target.value)} placeholder="password" />
            </div>
          </div>

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
            className="rounded-lg bg-sheen px-4 py-1.5 text-sm font-semibold text-ink disabled:opacity-40"
            disabled={!profile.fingerprint}
            onClick={() => onSave(profile)}
          >
            Save profile
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({
  binary,
  settings,
  onPick,
  onClose,
}: {
  binary: string | null;
  settings: Settings;
  onPick: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-surface p-6 shadow-2xl">
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
          <button className="mt-3 rounded-lg border border-white/15 px-3 py-1.5 text-xs hover:bg-white/5" onClick={onPick}>
            Choose binary…
          </button>
        </div>
        <div className="mt-6 flex justify-end">
          <button className="rounded-lg bg-sheen px-4 py-1.5 text-sm font-semibold text-ink" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
