"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Profile } from "@/types/profile";
import { api, isElectron, type Settings, type DownloadProgress, type UpdateInfo, type ExitEvent } from "@/lib/ipc";
import ProfileEditor from "@/components/ProfileEditor";
import SettingsModal, { type Section as SettingsSection } from "@/components/SettingsModal";
import LibraryModal from "@/components/LibraryModal";
import ProfileCard from "@/components/ProfileCard";
import ShortcutsDialog from "@/components/ShortcutsDialog";
import UpdateBanner from "@/components/UpdateBanner";
import ExportDialog from "@/components/ExportDialog";
import BulkCreateDialog from "@/components/BulkCreateDialog";
import PromptDialog from "@/components/PromptDialog";
import GroupHeader from "@/components/GroupHeader";
import { fmtSize } from "@/components/StorageSection";
import { ConfirmProvider, useConfirm } from "@/components/Confirm";
import { dialogOpen } from "@/components/Dialog";
import { LogoMark } from "@/components/LogoMark";
import { Mascot } from "@/components/Mascot";
import {
  describeExit,
  describeLaunchError,
  describeLaunchWarnings,
  withSwap,
  type LaunchNotice,
  type NoticeAction,
} from "@/lib/launchError";
import { describeTarget, type LaunchTarget } from "@/lib/launchTarget";
import {
  SORT_LABELS,
  displayName,
  filterProfiles,
  groupKey,
  groupProfiles,
  isProfileDirty,
  moveGroup,
  nextSelection,
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

// Per-viewer list preferences (the renderer's own storage; per install in the desktop app).
const SORT_KEY = "clearcote.sort";
const GROUP_ORDER_KEY = "clearcote.groups.order";
const COLLAPSED_KEY = "clearcote.groups.collapsed";
const loadList = (key: string): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};
const saveList = (key: string, v: string[]) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
};

/** Typing in a field must never trigger a single-key shortcut. A checkbox, radio or button is not
 *  typing — counting every <input> left Esc and Ctrl+A dead after ticking a card's checkbox. */
function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName !== "INPUT") return false;
  const type = ((el as HTMLInputElement).type || "text").toLowerCase();
  return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"].includes(type);
}

interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
  action?: { label: string; run: () => void };
}

type PromptKind = { kind: "set-group" } | { kind: "add-tag" } | { kind: "rename-group"; key: string; name: string };

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
  // Click a tag or a group to narrow the list; "running" shows only open browsers.
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState<{ key: string; name: string } | null>(null);
  const [runningOnly, setRunningOnly] = useState(false);
  const [groupOrder, setGroupOrder] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  // Multi-select: the ids, and the last one clicked (Shift+click selects the range to it).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [settings, setSettings] = useState<Settings>({});
  const [binary, setBinary] = useState<string | null>(null);
  const [target, setTarget] = useState<LaunchTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [exportReq, setExportReq] = useState<{ ids?: string[]; single?: string; count: number } | null>(null);
  const [bulkCreateOpen, setBulkCreateOpen] = useState(false);
  const [prompt, setPrompt] = useState<PromptKind | null>(null);
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
    setGroupOrder(loadList(GROUP_ORDER_KEY));
    setCollapsed(loadList(COLLAPSED_KEY));
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

  // A browser that stopped without being asked: say why on its card (electron/exitreason.ts).
  useEffect(() => {
    const off = api.onBrowserExited?.((ev: ExitEvent) => {
      const n = describeExit(ev);
      if (n) setNotices((all) => ({ ...all, [ev.id]: n }));
      setRunning((r) => r.filter((id) => id !== ev.id));
      void refresh();
    });
    return () => off?.();
  }, [refresh]);

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
      lastGeo: undefined,
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
    forget([p.id]);
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

  /** Drop a removed profile's notice and selection. */
  function forget(ids: string[]) {
    setNotices((all) => {
      const next = { ...all };
      for (const id of ids) delete next[id];
      return next;
    });
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) next.delete(id);
      return next;
    });
  }

  // ── Launch / stop ─────────────────────────────────────────────────────────
  /** Launch one profile. Resolves to the failure code, if it failed — bulk launch stops on a
   *  plan's browser limit instead of piling the same error onto every card. */
  async function launch(p: Profile): Promise<{ ok: boolean; code?: string }> {
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
        // On a plan at its limit with one other profile open here, offer to swap them.
        const open = await api.running();
        const others = profiles.filter((x) => x.id !== p.id && open.includes(x.id)).map((x) => ({ id: x.id, name: displayName(x) }));
        setNotices((n) => ({ ...n, [p.id]: withSwap(describeLaunchError(r.error, r.code), r.code, others) }));
      }
      return { ok: r.ok, code: r.code };
    } finally {
      setLaunchingId(null);
      setDl(null);
    }
  }
  async function stop(p: Profile) {
    await api.stop(p.id);
    await refresh();
  }

  async function noticeAction(p: Profile, a: NoticeAction) {
    if (a.kind === "retry") void launch(p);
    else if (a.kind === "settings") setSettingsOpen(a.section);
    else if (a.kind === "swap") {
      // Stop resolves once the slot is checked back in, so the launch right after gets it.
      await api.stop(a.stopId);
      void launch(p);
    } else openEditor(p, a.field);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify("Copied to the clipboard.");
    } catch {
      notify("Could not copy to the clipboard.", { tone: "error" });
    }
  }

  async function checkGeo(p: Profile) {
    notify(`Checking where “${displayName(p)}” exits…`);
    const r = await api.checkProfileGeo(p.id);
    if (r.ok) {
      await refresh();
      notify(`“${displayName(p)}” exits in ${[r.city, r.country].filter(Boolean).join(", ") || "an unknown place"}${r.ip ? ` as ${r.ip}` : ""}.`);
    } else notify(r.error || "The proxy location could not be checked.", { tone: "error" });
  }

  async function clearCache(p: Profile) {
    const ok = await confirm({
      title: `Clear the cache of “${displayName(p)}”?`,
      body: "Cached pages, scripts and shaders are removed; they rebuild as you browse. Cookies, logins, saved site data, history and extensions stay.",
      confirmLabel: "Clear cache",
    });
    if (!ok) return;
    const r = await api.profiles.clearCache(p.id);
    if (r.ok) notify(`Cleared ${fmtSize(r.freedBytes ?? 0)} of cache from “${displayName(p)}”.`);
    else notify(r.error || "Could not clear the cache.", { tone: "error" });
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

  // ── Export / import / create ──────────────────────────────────────────────
  function openExport(ids?: string[]) {
    const count = ids ? ids.length : profiles.length;
    const single = ids?.length === 1 ? displayName(profiles.find((p) => p.id === ids[0]) ?? ({ id: ids[0] } as Profile)) : undefined;
    setExportReq({ ids, single, count });
  }
  async function doExport(includeSecrets: boolean) {
    const req = exportReq;
    setExportReq(null);
    const r = await api.exportProfiles({ ids: req?.ids, includeSecrets });
    if (r.ok) {
      notify(
        `Exported ${r.count} profile${r.count === 1 ? "" : "s"}` +
          (includeSecrets ? " — with proxy passwords and encryption keys. Keep the file private." : " — proxy passwords and encryption keys left out."),
      );
    }
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
  async function createMany(list: Profile[]) {
    for (const p of list) await api.profiles.save(p);
    setBulkCreateOpen(false);
    await refresh();
    notify(`Created ${list.length} profile${list.length === 1 ? "" : "s"}.`);
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
  const filtered = useMemo(
    () =>
      sortProfiles(
        filterProfiles(profiles, { query, tag: tagFilter ?? undefined, group: groupFilter?.key, runningOnly }, running),
        running,
        sort,
      ),
    [profiles, query, tagFilter, groupFilter, runningOnly, running, sort],
  );
  const sections = useMemo(() => groupProfiles(filtered, groupOrder), [filtered, groupOrder]);
  const runningCount = profiles.filter((p) => running.includes(p.id)).length;
  const groupNames = useMemo(
    () => Array.from(new Map(profiles.filter((p) => p.group?.trim()).map((p) => [groupKey(p.group), p.group!.trim()])).values()).sort(),
    [profiles],
  );
  const filtering = !!(query.trim() || tagFilter || groupFilter || runningOnly);
  // A heading (and folding) shows for every named group; only a lone "No group" list goes without.
  const hasHeading = (s: { group: string | null }) => sections.length > 1 || s.group !== null;
  const visibleIds = sections.filter((s) => !(collapsed.includes(s.key) && hasHeading(s))).flatMap((s) => s.profiles.map((p) => p.id));

  function changeSort(k: SortKey) {
    setSort(k);
    try {
      localStorage.setItem(SORT_KEY, k);
    } catch {
      /* ignore */
    }
  }
  function clearFilters() {
    setQuery("");
    setTagFilter(null);
    setGroupFilter(null);
    setRunningOnly(false);
  }

  // ── Groups ────────────────────────────────────────────────────────────────
  function toggleCollapse(key: string) {
    setCollapsed((c) => {
      const next = c.includes(key) ? c.filter((k) => k !== key) : [...c, key];
      saveList(COLLAPSED_KEY, next);
      return next;
    });
  }
  function moveGroupBy(key: string, dir: -1 | 1) {
    const next = moveGroup(
      sections.map((s) => s.key),
      key,
      dir,
    );
    setGroupOrder(next);
    saveList(GROUP_ORDER_KEY, next);
  }
  async function renameGroup(key: string, from: string, to: string) {
    const n = await api.profiles.renameGroup(from, to);
    // Keep its place and fold state under the new name.
    const newKey = groupKey(to);
    const swapKey = (list: string[]) => list.map((k) => (k === key ? newKey : k)).filter((k, i, a) => k && a.indexOf(k) === i);
    setGroupOrder((o) => {
      const next = swapKey(o);
      saveList(GROUP_ORDER_KEY, next);
      return next;
    });
    setCollapsed((c) => {
      const next = swapKey(c);
      saveList(COLLAPSED_KEY, next);
      return next;
    });
    if (groupFilter?.key === key) setGroupFilter(newKey ? { key: newKey, name: to } : null);
    await refresh();
    notify(to ? `Renamed the group to “${to}” (${n} profile${n === 1 ? "" : "s"}).` : `Ungrouped ${n} profile${n === 1 ? "" : "s"}.`);
  }

  // ── Selection + bulk actions ──────────────────────────────────────────────
  function toggleSelect(id: string, range: boolean) {
    // Read the anchor NOW. React runs this updater immediately only when nothing else is pending;
    // otherwise it runs later, after the anchor below has moved to `id` — and reading the ref in
    // there collapsed a Shift+click range to the one card clicked, intermittently.
    const from = anchor.current;
    const order = visibleIds;
    setSelected((s) => nextSelection(s, id, { range, from, order }));
    anchor.current = id;
  }
  const selectedProfiles = profiles.filter((p) => selected.has(p.id));

  async function bulkLaunch() {
    let done = 0;
    for (const p of selectedProfiles) {
      if (running.includes(p.id)) continue;
      const r = await launch(p);
      if (r.ok) done++;
      else if (r.code === "CONCURRENCY_LIMIT_EXCEEDED") {
        notify(`Launched ${done}, then reached your plan's browser limit.`, { tone: "error" });
        return;
      }
    }
    notify(`Launched ${done} profile${done === 1 ? "" : "s"}.`);
  }
  async function bulkStop() {
    const ids = selectedProfiles.map((p) => p.id).filter((id) => running.includes(id));
    await Promise.all(ids.map((id) => api.stop(id)));
    await refresh();
    notify(`Stopped ${ids.length} browser${ids.length === 1 ? "" : "s"}.`);
  }
  async function bulkDelete() {
    const deletable = selectedProfiles.filter((p) => !running.includes(p.id));
    const skipped = selectedProfiles.length - deletable.length;
    if (!deletable.length) {
      notify("Stop their browsers first — running profiles can't be deleted.", { tone: "error" });
      return;
    }
    const ok = await confirm({
      title: `Delete ${deletable.length} profile${deletable.length === 1 ? "" : "s"}?`,
      body: (
        <>
          This removes them <span className="text-fog/80">and their saved browser data</span> — cookies, logins, history and
          extensions. You can undo it for a few seconds.
          {skipped ? ` ${skipped} running profile${skipped === 1 ? " is" : "s are"} left alone.` : ""}
        </>
      ),
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    const trashed: string[] = [];
    for (const p of deletable) {
      const r = await api.profiles.remove(p.id);
      if (r.ok) trashed.push(r.trashId);
    }
    forget(deletable.map((p) => p.id));
    await refresh();
    notify(`Deleted ${trashed.length} profile${trashed.length === 1 ? "" : "s"}.`, {
      action: {
        label: "Undo",
        run: async () => {
          let back = 0;
          for (const t of trashed) if ((await api.profiles.restore(t)).ok) back++;
          await refresh();
          notify(`Restored ${back} profile${back === 1 ? "" : "s"}.`);
        },
      },
    });
  }
  async function bulkEdit(change: (p: Profile) => Profile, done: string) {
    for (const p of selectedProfiles) await api.profiles.save(change(p));
    await refresh();
    notify(done);
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
  const kb = useRef({ visibleIds, selectedCount: selected.size, filtering });
  kb.current = { visibleIds, selectedCount: selected.size, filtering };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialogOpen() || e.defaultPrevented) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const typing = isTyping(e.target);
      if (mod && !e.altKey && k === "n") {
        e.preventDefault();
        openEditor(newProfile());
      } else if (mod && !e.altKey && k === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen("general");
      } else if (mod && !e.altKey && k === "a" && !typing) {
        e.preventDefault();
        setSelected(new Set(kb.current.visibleIds));
      } else if (!mod && !e.altKey && !typing) {
        if (e.key === "/") {
          e.preventDefault();
          searchRef.current?.focus();
        } else if (e.key === "?") {
          e.preventDefault();
          setShortcutsOpen(true);
        } else if (e.key === "Escape" && kb.current.selectedCount) {
          e.preventDefault();
          setSelected(new Set());
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
  const takenNames = useMemo(
    () => profiles.filter((p) => p.id !== editing?.id).map((p) => (p.name ?? "").trim().toLowerCase()).filter(Boolean),
    [profiles, editing?.id],
  );

  return (
    // data-ready: set once hydrated and the shortcuts are live — what the UI tests wait for.
    <main className="app-sheen relative min-h-screen" data-ready={mounted ? "1" : undefined}>
      <div className={"relative z-10 mx-auto max-w-6xl px-6 py-6 animate-fade-up " + (selected.size ? "pb-24" : "")}>
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
            <button className={btnGhost} onClick={() => setSettingsOpen("general")} title="Settings (Ctrl+,)">
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
          <button
            className={
              "rounded-lg border px-2.5 py-1.5 text-xs font-medium transition " +
              (runningOnly ? "border-accent/50 bg-accent/10 text-accent" : "border-line text-fog/70 hover:bg-elevate")
            }
            aria-pressed={runningOnly}
            onClick={() => setRunningOnly((v) => !v)}
            title="Show only profiles whose browser is open"
          >
            Running{runningCount ? ` · ${runningCount}` : ""}
          </button>
          <div className="text-xs text-fog/35" aria-live="polite">
            {filtered.length !== profiles.length
              ? `${filtered.length} of ${profiles.length}`
              : `${profiles.length} profile${profiles.length === 1 ? "" : "s"}`}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
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
            <button className={btnGhost} onClick={() => setBulkCreateOpen(true)} title="One profile per proxy">
              From proxy list…
            </button>
            <button className={btnGhost} onClick={doImport}>
              Import
            </button>
            <button className={btnGhost} onClick={() => openExport()} disabled={profiles.length === 0}>
              Export
            </button>
          </div>
        </div>

        {/* Active filters */}
        {(tagFilter || groupFilter) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-fog/40">Showing</span>
            {tagFilter && (
              <button
                className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-accent hover:bg-accent/15"
                onClick={() => setTagFilter(null)}
                aria-label={`Remove the tag filter #${tagFilter}`}
              >
                #{tagFilter} <span aria-hidden>✕</span>
              </button>
            )}
            {groupFilter && (
              <button
                className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-accent hover:bg-accent/15"
                onClick={() => setGroupFilter(null)}
                aria-label={`Remove the group filter ${groupFilter.name}`}
              >
                {groupFilter.name} <span aria-hidden>✕</span>
              </button>
            )}
          </div>
        )}

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
              {profiles.length === 0 ? "Meet Clyde — your first identity awaits" : runningOnly && !query && !tagFilter && !groupFilter ? "Nothing is running" : "No matches"}
            </h2>
            <p className="mt-1.5 max-w-sm text-sm text-fog/50">
              {profiles.length === 0
                ? "Chameleons blend in to stay unseen. Spin up a profile — a saved fingerprint seed, proxy, and persistent session — and launch it any time."
                : "Try a different search or filter."}
            </p>
            {profiles.length === 0 ? (
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                <button
                  className="rounded-lg bg-sheen px-5 py-2.5 text-sm font-semibold text-[#07080a] shadow-[0_0_26px_-6px_rgba(56,224,214,0.55)] transition hover:opacity-95 active:scale-[0.98]"
                  onClick={() => openEditor(newProfile())}
                >
                  + Create your first profile
                </button>
                <button className={btnGhost + " px-4 py-2.5 text-sm"} onClick={() => setBulkCreateOpen(true)}>
                  From a proxy list…
                </button>
              </div>
            ) : (
              filtering && (
                <button className={btnGhost + " mt-4"} onClick={clearFilters}>
                  Clear search and filters
                </button>
              )
            )}
          </div>
        ) : (
          sections.map((sec, si) => {
            const folded = collapsed.includes(sec.key) && hasHeading(sec);
            const named = sections.filter((s) => s.group !== null);
            const ni = named.findIndex((s) => s.key === sec.key);
            return (
              <section key={sec.group === null ? "none" : `g:${sec.key}`} className="mt-5" aria-label={sec.group ?? (sections.length > 1 ? "No group" : "Profiles")}>
                {hasHeading(sec) && (
                  <GroupHeader
                    name={sec.group ?? "No group"}
                    count={sec.profiles.length}
                    running={sec.profiles.filter((p) => running.includes(p.id)).length}
                    collapsed={folded}
                    isGroup={sec.group !== null}
                    canMoveUp={ni > 0}
                    canMoveDown={ni >= 0 && ni < named.length - 1}
                    onToggle={() => toggleCollapse(sec.key)}
                    onFilter={() => setGroupFilter({ key: sec.key, name: sec.group ?? "No group" })}
                    onRename={() => setPrompt({ kind: "rename-group", key: sec.key, name: sec.group ?? "" })}
                    onMove={(dir) => moveGroupBy(sec.key, dir)}
                    onUngroup={() => void renameGroup(sec.key, sec.group ?? "", "")}
                  />
                )}
                {!folded && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-section={si}>
                    {sec.profiles.map((p) => (
                      <ProfileCard
                        key={p.id}
                        profile={p}
                        running={running.includes(p.id)}
                        launching={launchingId === p.id}
                        download={dl && dl.id === p.id ? dl : null}
                        notice={notices[p.id]}
                        current={current}
                        selected={selected.has(p.id)}
                        selecting={selected.size > 0}
                        onToggleSelect={({ range }) => toggleSelect(p.id, range)}
                        onFilterTag={(t) => setTagFilter(t)}
                        onLaunch={() => void launch(p)}
                        onStop={() => stop(p)}
                        onEdit={(field) => openEditor(p, field)}
                        onDuplicate={() => duplicate(p)}
                        onDelete={() => remove(p)}
                        onExport={() => openExport([p.id])}
                        onOpenData={() => openData(p)}
                        onCheckGeo={() => checkGeo(p)}
                        onClearCache={() => clearCache(p)}
                        onDismissNotice={() => setNotices(({ [p.id]: _gone, ...rest }) => rest)}
                        onNoticeAction={(a) => noticeAction(p, a)}
                        onCopy={copy}
                        onArrow={(key) => moveFocus(p.id, key)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>

      {/* Bulk actions for the selected profiles */}
      {selected.size > 0 && (
        <div
          role="region"
          aria-label="Selected profiles"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-line-strong bg-surface/95 px-4 py-2.5 backdrop-blur"
          style={{ paddingBottom: "calc(0.625rem + env(safe-area-inset-bottom, 0px))" }}
        >
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2">
            <span className="mr-1 text-sm font-semibold">{selected.size} selected</span>
            <button className={btnGhost} onClick={bulkLaunch}>
              Launch
            </button>
            <button className={btnGhost} onClick={bulkStop} disabled={!selectedProfiles.some((p) => running.includes(p.id))}>
              Stop
            </button>
            <button className={btnGhost} onClick={() => setPrompt({ kind: "set-group" })}>
              Set group…
            </button>
            <button className={btnGhost} onClick={() => setPrompt({ kind: "add-tag" })}>
              Add tag…
            </button>
            <button className={btnGhost} onClick={() => openExport([...selected])}>
              Export…
            </button>
            <button className={btnGhost + " text-danger hover:bg-danger/10"} onClick={bulkDelete}>
              Delete…
            </button>
            <span className="flex-1" />
            <button className="text-xs text-fog/50 hover:text-fog" onClick={() => setSelected(new Set(visibleIds))} title="Ctrl+A">
              Select all {visibleIds.length}
            </button>
            <button className="text-xs text-fog/50 hover:text-fog" onClick={() => setSelected(new Set())} title="Esc">
              Clear selection
            </button>
          </div>
        </div>
      )}

      {editing && (
        <ProfileEditor
          profile={editing}
          onChange={setEditing}
          onSave={save}
          onCancel={closeEditor}
          dirty={editorDirty}
          initialField={editingField}
          takenNames={takenNames}
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
      {exportReq && (
        <ExportDialog count={exportReq.count} single={exportReq.single} onExport={doExport} onClose={() => setExportReq(null)} />
      )}
      {bulkCreateOpen && (
        <BulkCreateDialog
          existingIds={profiles.map((p) => p.id)}
          groups={groupNames}
          onCreate={createMany}
          onClose={() => setBulkCreateOpen(false)}
        />
      )}
      {prompt?.kind === "set-group" && (
        <PromptDialog
          title={`Set the group of ${selected.size} profile${selected.size === 1 ? "" : "s"}`}
          label="Group"
          suggestions={groupNames}
          confirmLabel="Set group"
          allowEmpty
          hint="Leave it empty to take them out of any group."
          onClose={() => setPrompt(null)}
          onConfirm={(v) => {
            setPrompt(null);
            void bulkEdit(
              (p) => {
                const out = { ...p, group: v || undefined };
                if (!v) delete out.group;
                return out;
              },
              v ? `Moved ${selected.size} profile${selected.size === 1 ? "" : "s"} to “${v}”.` : `Ungrouped ${selected.size} profile${selected.size === 1 ? "" : "s"}.`,
            );
          }}
        />
      )}
      {prompt?.kind === "add-tag" && (
        <PromptDialog
          title={`Tag ${selected.size} profile${selected.size === 1 ? "" : "s"}`}
          label="Tag"
          suggestions={Array.from(new Set(profiles.flatMap((p) => p.tags ?? []))).sort()}
          confirmLabel="Add tag"
          onClose={() => setPrompt(null)}
          onConfirm={(v) => {
            setPrompt(null);
            const tag = v.replace(/^#/, "");
            void bulkEdit(
              (p) => ({ ...p, tags: (p.tags ?? []).some((t) => t.toLowerCase() === tag.toLowerCase()) ? p.tags : [...(p.tags ?? []), tag] }),
              `Tagged ${selected.size} profile${selected.size === 1 ? "" : "s"} #${tag}.`,
            );
          }}
        />
      )}
      {prompt?.kind === "rename-group" && (
        <PromptDialog
          title={`Rename “${prompt.name}”`}
          label="New name"
          initial={prompt.name}
          confirmLabel="Rename"
          hint="Every profile in the group moves with it."
          onClose={() => setPrompt(null)}
          onConfirm={(v) => {
            const p = prompt;
            setPrompt(null);
            if (v && v !== p.name) void renameGroup(p.key, p.name, v);
          }}
        />
      )}

      {/* Always mounted, so screen readers announce each new message. */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {toast?.text}
      </div>
      {toast && (
        <div
          className={
            "fixed left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-lg border bg-surface px-4 py-2 text-sm shadow-lg " +
            (selected.size ? "bottom-20 " : "bottom-5 ") +
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
