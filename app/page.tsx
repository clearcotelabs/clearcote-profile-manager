"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Profile } from "@/types/profile";
import { api, isElectron, type Settings, type DownloadProgress, type UpdateInfo } from "@/lib/ipc";
import ProfileEditor from "@/components/ProfileEditor";
import SettingsModal, { type Section as SettingsSection } from "@/components/SettingsModal";
import LibraryModal from "@/components/LibraryModal";
import ProfileCard from "@/components/ProfileCard";
import ShortcutsDialog from "@/components/ShortcutsDialog";
import UpdateBanner from "@/components/UpdateBanner";
import { ConfirmProvider, useConfirm } from "@/components/Confirm";
import { dialogOpen } from "@/components/Dialog";
import { LogoMark } from "@/components/LogoMark";
import { Mascot } from "@/components/Mascot";
import { describeLaunchError, describeLaunchWarnings, type LaunchNotice, type NoticeAction } from "@/lib/launchError";
import { describeTarget, type LaunchTarget } from "@/lib/launchTarget";
import {
  SORT_LABELS,
  displayName,
  groupProfiles,
  isProfileDirty,
  proxySummary,
  sortProfiles,
  type SortKey,
} from "@/lib/profileList";

/** The host OS, for the few strings that would otherwise name the wrong platform's files. The
 *  renderer has a real navigator, so this needs no extra IPC (same trick as the editor). */
function hostIsWindows(): boolean {
  if (typeof navigator === "undefined") return true;
  return `${navigator.platform} ${navigator.userAgent}`.toLowerCase().includes("win");
}

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
const btnGhost =
  "rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-fog/80 hover:bg-elevate transition disabled:opacity-40";

const SORT_KEY = "clearcote.sort";

/** Typing in a field must never trigger a single-key shortcut. */
function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
  action?: { label: string; run: () => void };
}

export default function Page() {
  return (
    <ConfirmProvider>
      <Manager />
    </ConfirmProvider>
  );
}

function Manager() {
  const confirm = useConfirm();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [running, setRunning] = useState<string[]>([]);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [dl, setDl] = useState<DownloadProgress | null>(null);
  // The editor works on a copy; `editingInitial` is what was opened, so closing can tell whether
  // anything would be lost.
  const [editing, setEditing] = useState<Profile | null>(null);
  const [editingInitial, setEditingInitial] = useState<Profile | null>(null);
  const [editingField, setEditingField] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [settings, setSettings] = useState<Settings>({});
  const [binary, setBinary] = useState<string | null>(null);
  const [target, setTarget] = useState<LaunchTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // A launch error or warning stays on its card until dismissed or the next launch of that profile.
  const [notices, setNotices] = useState<Record<string, LaunchNotice>>({});
  const [toast, setToast] = useState<Toast | null>(null);
  // Resolved after mount so the first client render matches the server prerender
  // (window.clearcote only exists in the Electron renderer → avoids a hydration mismatch).
  const [isEl, setIsEl] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [mounted, setMounted] = useState(false);
  // App update. Checked every time the app starts (unless turned off in Settings), so a user on an
  // old build learns that a fix shipped — which is otherwise impossible: the browser engine updates
  // itself while the app driving it cannot.
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updDl, setUpdDl] = useState<{ pct: number; seenMB: number; totalMB: number } | null>(null);
  const [updFile, setUpdFile] = useState<{ path: string; verified: boolean } | null>(null);
  const [updBusy, setUpdBusy] = useState(false);
  const [updErr, setUpdErr] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setProfiles(await api.profiles.list());
    setRunning(await api.running());
  }, []);
  const refreshTarget = useCallback(() => {
    api
      .launchTarget()
      .then(setTarget)
      .catch(() => setTarget(null));
  }, []);

  useEffect(() => {
    setMounted(true);
    setIsEl(isElectron);
    // sync from the theme the no-flash inline script already applied
    setTheme(document.documentElement.classList.contains("light") ? "light" : "dark");
    try {
      const saved = localStorage.getItem(SORT_KEY) as SortKey | null;
      if (saved && saved in SORT_LABELS) setSort(saved);
    } catch {
      /* ignore */
    }
    refresh();
    refreshTarget();
    api.settings.get().then(setSettings);
    api.resolveBinary().then(setBinary);
  }, [refresh, refreshTarget]);

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

  // Live browser-download progress (first launch of a version downloads 100–250 MB).
  useEffect(() => {
    const off = api.onDownloadProgress?.((prog) => setDl(prog));
    return () => off?.();
  }, []);

  // ── Toasts ────────────────────────────────────────────────────────────────
  // One at a time. Its timer is keyed on the toast's id, so a replaced toast can no longer cut the
  // new one short (the old setTimeout-per-call did exactly that). Errors stay until dismissed.
  const toastSeq = useRef(0);
  const notify = useCallback((text: string, opts: { tone?: Toast["tone"]; action?: Toast["action"] } = {}) => {
    setToast({ id: ++toastSeq.current, text, tone: opts.tone ?? "info", action: opts.action });
  }, []);
  useEffect(() => {
    if (!toast || toast.tone === "error") return;
    const t = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), toast.action ? 8000 : 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // ── Editor ────────────────────────────────────────────────────────────────
  const editorDirty = !!(editing && editingInitial && isProfileDirty(editing, editingInitial));

  function openEditor(p: Profile, field?: string) {
    setEditing(p);
    setEditingInitial(p);
    setEditingField(field);
  }
  function closeEditorNow() {
    setEditing(null);
    setEditingInitial(null);
    setEditingField(undefined);
  }
  async function closeEditor() {
    if (editorDirty) {
      const ok = await confirm({
        title: "Discard your changes?",
        body: `“${editing?.name?.trim() || "This profile"}” has changes that are not saved.`,
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        tone: "danger",
      });
      if (!ok) return;
    }
    closeEditorNow();
  }
  // Closing the window (or reloading) with unsaved edits asks too — the main process shows the
  // prompt, since Electron shows none for beforeunload by itself.
  useEffect(() => {
    if (!editorDirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [editorDirty]);

  async function save(p: Profile) {
    const id = p.id || `${slugify(p.name) || "profile"}-${randomSeed().slice(0, 4)}`;
    const saved = await api.profiles.save({ ...p, id });
    closeEditorNow();
    await refresh();
    notify(`Saved “${displayName(saved)}”.`);
  }

  function duplicate(p: Profile) {
    openEditor({
      ...p,
      id: "",
      name: `${p.name || p.id} copy`,
      fingerprint: randomSeed(),
      createdAt: "",
      updatedAt: "",
      lastLaunchedAt: undefined,
    });
  }

  // ── Delete (recoverable) ──────────────────────────────────────────────────
  async function remove(p: Profile) {
    const ok = await confirm({
      title: `Delete “${displayName(p)}”?`,
      body: (
        <>
          This removes the profile <span className="text-fog/80">and its saved browser data</span> — cookies, logins,
          history and extensions. You can undo it for a few seconds.
        </>
      ),
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    // Focus moves to a neighbour, not to <body>, so a keyboard user keeps their place.
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-card]"));
    const i = cards.findIndex((c) => c.dataset.card === p.id);
    const next = (cards[i + 1] ?? cards[i - 1])?.dataset.card;
    const r = await api.profiles.remove(p.id);
    if (!r.ok) {
      notify(r.error, { tone: "error" });
      return;
    }
    setNotices(({ [p.id]: _gone, ...rest }) => rest);
    await refresh();
    if (next) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-card="${CSS.escape(next)}"]`)?.focus());
    notify(`Deleted “${displayName(p)}”.`, {
      action: {
        label: "Undo",
        run: async () => {
          const back = await api.profiles.restore(r.trashId);
          if (!back.ok) {
            notify(back.error, { tone: "error" });
            return;
          }
          await refresh();
          notify(`Restored “${displayName(back.profile)}”.`);
        },
      },
    });
  }

  // ── Launch ────────────────────────────────────────────────────────────────
  async function launch(p: Profile) {
    setLaunchingId(p.id);
    setDl(null);
    setNotices(({ [p.id]: _old, ...rest }) => rest);
    try {
      const r = await api.launch(p);
      if (r.ok) {
        // The main process records the launch (lastLaunchedAt) on the saved profile itself.
        await refresh();
        refreshTarget(); // a first lease teaches us the plan; a download changes "downloaded"
        // Warnings mean the browser DID start but an option silently won't take effect. They go on
        // the card, where they stay readable, rather than into a toast that vanishes.
        if (r.warnings?.length) setNotices((n) => ({ ...n, [p.id]: describeLaunchWarnings(r.warnings!) }));
        notify(`Launched “${displayName(p)}”.`);
      } else {
        setNotices((n) => ({ ...n, [p.id]: describeLaunchError(r.error, r.code) }));
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

  function noticeAction(p: Profile, a: NoticeAction) {
    if (a.kind === "retry") void launch(p);
    else if (a.kind === "settings") setSettingsOpen(a.section);
    else openEditor(p, a.field);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify("Copied to the clipboard.");
    } catch {
      notify("Could not copy to the clipboard.", { tone: "error" });
    }
  }

  async function pickBinary() {
    const b = await api.pickBinary();
    if (b) {
      setBinary(b);
      setSettings(await api.settings.get());
      refreshTarget();
      notify("Browser binary set.");
    }
  }
  async function doExport(ids?: string[]) {
    const r = await api.exportProfiles(ids ? { ids } : undefined);
    if (r.ok) notify(`Exported ${r.count} profile${r.count === 1 ? "" : "s"} — proxy passwords and encryption keys left out.`);
  }
  async function doImport() {
    const r = await api.importProfiles();
    if (r.ok) {
      await refresh();
      notify(
        `Imported ${r.count} profile${r.count === 1 ? "" : "s"}` +
          (r.renamed ? ` — ${r.renamed} under a new id, because theirs was already taken.` : "."),
      );
    } else if (r.error) {
      notify(`Import failed: ${r.error}`, { tone: "error" });
    }
  }
  async function openData(p: Profile) {
    const r = await api.profiles.openData(p.id);
    if (!r.ok && r.error) notify(r.error, { tone: "error" });
  }

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
  // "Later" hides the suggestion for this session only; it comes back on the next start unless
  // update checks are turned off in Settings.
  function laterUpdate() {
    setUpdate(null);
  }

  // ── List ──────────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    const hits = !q
      ? profiles
      : profiles.filter((p) =>
          [p.name, p.id, p.fingerprint, p.group, p.notes, p.browserVersion, proxySummary(p.proxy), ...(p.tags || [])]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(q),
        );
    return sortProfiles(hits, running, sort);
  }, [profiles, query, running, sort]);
  const sections = useMemo(() => groupProfiles(filtered), [filtered]);
  const runningCount = profiles.filter((p) => running.includes(p.id)).length;

  function changeSort(k: SortKey) {
    setSort(k);
    try {
      localStorage.setItem(SORT_KEY, k);
    } catch {
      /* ignore */
    }
  }

  /** Arrow keys between cards. Up/Down go to the nearest card in the row above/below by position,
   *  which also works across group sections with different column counts. */
  function moveFocus(fromId: string, key: string) {
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-card]"));
    const i = cards.findIndex((c) => c.dataset.card === fromId);
    if (i < 0) return;
    if (key === "ArrowRight" || key === "ArrowLeft") {
      cards[key === "ArrowRight" ? Math.min(i + 1, cards.length - 1) : Math.max(i - 1, 0)]?.focus();
      return;
    }
    const here = cards[i].getBoundingClientRect();
    const cx = here.left + here.width / 2;
    const down = key === "ArrowDown";
    const cand = cards
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => (down ? r.top > here.top + 4 : r.top < here.top - 4));
    if (!cand.length) return;
    const rowTop = down ? Math.min(...cand.map((c) => c.r.top)) : Math.max(...cand.map((c) => c.r.top));
    const row = cand.filter((c) => Math.abs(c.r.top - rowTop) < 4);
    row.sort((a, b) => Math.abs(a.r.left + a.r.width / 2 - cx) - Math.abs(b.r.left + b.r.width / 2 - cx));
    row[0].el.focus();
    row[0].el.scrollIntoView({ block: "nearest" });
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────
  // Page-level shortcuts stand down while any dialog is open, and single keys never fire while
  // typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialogOpen() || e.defaultPrevented) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && !e.altKey && k === "n") {
        e.preventDefault();
        openEditor(newProfile());
      } else if (mod && !e.altKey && k === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen("browser");
      } else if (!mod && !e.altKey && !isTyping(e.target)) {
        if (e.key === "/") {
          e.preventDefault();
          searchRef.current?.focus();
        } else if (e.key === "?") {
          e.preventDefault();
          setShortcutsOpen(true);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // openEditor only calls state setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const view = describeTarget(isEl ? target : target ?? { mode: "preview" });
  const pillTone = {
    ok: "border-accent/30 text-accent hover:bg-accent/5",
    warn: "border-warn/40 text-warn hover:bg-warn/5",
    muted: "border-line text-fog/50 hover:bg-elevate",
  }[view.tone];
  const dotTone = { ok: "bg-accent", warn: "bg-warn", muted: "bg-fog/30" }[view.tone];
  const current = target && target.mode === "managed" ? { version: target.version, major: target.major, plan: target.plan } : undefined;

  return (
    // data-ready: set once hydrated and the shortcuts are live — what the UI tests wait for.
    <main className="app-sheen relative min-h-screen" data-ready={mounted ? "1" : undefined}>
      <div className="relative z-10 mx-auto max-w-6xl px-6 py-6 animate-fade-up">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <LogoMark className="h-8 w-8" />
            <div>
              <h1 className="text-[15px] font-semibold tracking-tight">
                Clear<span className="text-fog/55">cote</span>{" "}
                <span className="text-fog/45 font-normal">Profile Manager</span>
              </h1>
              <div className="text-xs text-fog/40">A clear coat for your browser identity.</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* What the next launch actually runs — and a way to change it. */}
            <button
              className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition sm:inline-flex ${pillTone}`}
              title={view.title}
              onClick={() => setSettingsOpen(view.section)}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${dotTone}`} />
              {view.text}
            </button>
            <button
              className={btnGhost + " w-8 px-0 text-sm"}
              onClick={toggleTheme}
              title="Toggle light / dark theme"
              aria-label="Toggle light or dark theme"
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <button
              className={btnGhost + " w-8 px-0"}
              onClick={() => setShortcutsOpen(true)}
              title="Keyboard shortcuts (?)"
              aria-label="Keyboard shortcuts"
            >
              ?
            </button>
            <button className={btnGhost} onClick={() => setSettingsOpen("browser")} title="Settings (Ctrl+,)">
              Settings
            </button>
            <button
              className="rounded-lg bg-sheen px-3.5 py-1.5 text-xs font-semibold text-[#07080a] shadow-[0_0_20px_-6px_rgba(56,224,214,0.6)] hover:opacity-95 transition"
              onClick={() => openEditor(newProfile())}
              title="New profile (Ctrl+N)"
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

        {update && (
          <UpdateBanner
            update={update}
            file={updFile}
            busy={updBusy}
            progress={updDl}
            error={updErr}
            windows={hostIsWindows()}
            onDownload={downloadUpdate}
            onLater={laterUpdate}
            onRun={() => updFile && api.update.run(updFile.path)}
            onReveal={() => updFile && api.update.reveal(updFile.path)}
            onOpenReleases={() => api.update.openReleases(update.releaseUrl)}
          />
        )}

        {/* Toolbar */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <input
            ref={searchRef}
            className={input + " max-w-sm"}
            placeholder="Search names, groups, tags, proxies…"
            aria-label="Search profiles"
            title="Search (Ctrl+F or /)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              } else if (e.key === "ArrowDown" || e.key === "Enter") {
                const first = document.querySelector<HTMLElement>("[data-card]");
                if (first) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
          />
          <div className="text-xs text-fog/35" aria-live="polite">
            {filtered.length !== profiles.length
              ? `${filtered.length} of ${profiles.length}`
              : `${profiles.length} profile${profiles.length === 1 ? "" : "s"}`}
            {runningCount > 0 && <span className="text-accent/80"> · {runningCount} running</span>}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-fog/40">
              Sort
              <select
                className="rounded-lg border border-line bg-ink/70 px-2 py-1.5 text-xs text-fog/80 outline-none focus:border-accent/60"
                value={sort}
                onChange={(e) => changeSort(e.target.value as SortKey)}
              >
                {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                  <option key={k} value={k}>
                    {SORT_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <button className={btnGhost} onClick={doImport}>
              Import
            </button>
            <button className={btnGhost} onClick={() => doExport()} disabled={profiles.length === 0}>
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
            {profiles.length === 0 ? (
              <button
                className="mt-6 rounded-lg bg-sheen px-5 py-2.5 text-sm font-semibold text-[#07080a] shadow-[0_0_26px_-6px_rgba(56,224,214,0.55)] transition hover:opacity-95 active:scale-[0.98]"
                onClick={() => openEditor(newProfile())}
              >
                + Create your first profile
              </button>
            ) : (
              <button className={btnGhost + " mt-4"} onClick={() => setQuery("")}>
                Clear search
              </button>
            )}
          </div>
        ) : (
          sections.map((sec) => (
            <section key={sec.group === null ? "none" : `g:${sec.group}`} className="mt-5" aria-label={sec.group ?? (sections.length > 1 ? "No group" : "Profiles")}>
              {sections.length > 1 && (
                <h2 className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-fog/45">
                  {sec.group ?? "No group"}
                  <span className="font-normal text-fog/25">{sec.profiles.length}</span>
                </h2>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {sec.profiles.map((p) => (
                  <ProfileCard
                    key={p.id}
                    profile={p}
                    running={running.includes(p.id)}
                    launching={launchingId === p.id}
                    download={dl && dl.id === p.id ? dl : null}
                    notice={notices[p.id]}
                    current={current}
                    onLaunch={() => launch(p)}
                    onStop={() => stop(p)}
                    onEdit={(field) => openEditor(p, field)}
                    onDuplicate={() => duplicate(p)}
                    onDelete={() => remove(p)}
                    onExport={() => doExport([p.id])}
                    onOpenData={() => openData(p)}
                    onDismissNotice={() => setNotices(({ [p.id]: _gone, ...rest }) => rest)}
                    onNoticeAction={(a) => noticeAction(p, a)}
                    onCopy={copy}
                    onArrow={(key) => moveFocus(p.id, key)}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      {editing && (
        <ProfileEditor
          profile={editing}
          onChange={setEditing}
          onSave={save}
          onCancel={closeEditor}
          dirty={editorDirty}
          initialField={editingField}
          renderLibrary={(onApply, onClose) => <LibraryModal onApply={onApply} onClose={onClose} />}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          binary={binary}
          settings={settings}
          initialSection={settingsOpen}
          onPick={pickBinary}
          onSaveSettings={async (patch) => {
            const next = { ...settings, ...patch };
            setSettings(next);
            setSettings(await api.settings.set(next));
            refreshTarget();
          }}
          onClose={() => {
            setSettingsOpen(null);
            refreshTarget();
          }}
        />
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}

      {/* Always mounted, so screen readers announce each new message. */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {toast?.text}
      </div>
      {toast && (
        <div
          className={
            "fixed bottom-5 left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg border bg-surface px-4 py-2 text-sm shadow-lg " +
            (toast.tone === "error" ? "border-danger/40" : "border-line")
          }
        >
          <span className={toast.tone === "error" ? "text-danger" : ""}>{toast.text}</span>
          {toast.action && (
            <button
              className="shrink-0 rounded-md px-1.5 py-0.5 font-semibold text-accent hover:bg-accent/10"
              onClick={() => {
                const run = toast.action!.run;
                setToast(null);
                run();
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button className="shrink-0 text-fog/40 hover:text-fog" onClick={() => setToast(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </main>
  );
}
