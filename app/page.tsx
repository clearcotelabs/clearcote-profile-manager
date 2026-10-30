"use client";

import { needsHelper, ACCOUNT_WHY } from "@/lib/webPreview";
import { t, tRich, useLocale } from "@/lib/i18n";
import { takeJustPaired } from "@/lib/helperBridge";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Profile } from "@/types/profile";
import {
  api,
  hasBackend,
  type Settings,
  type DownloadProgress,
  type UpdateInfo,
  type ExitEvent,
  type CloudSession,
  type LaunchResult,
  type SyncRun,
  type StartRequest,
  type SavedTask,
} from "@/lib/ipc";
import ProfileEditor from "@/components/ProfileEditor";
import SettingsModal, { type Section as SettingsSection } from "@/components/SettingsModal";
import LibraryModal from "@/components/LibraryModal";
import ProfileCard, { type CardProps } from "@/components/ProfileCard";
import ProfileTable from "@/components/ProfileTable";
import ProfileInspector from "@/components/ProfileInspector";
import Sidebar, { type PageKey, type RunningItem } from "@/components/Sidebar";
import CommandPalette, { type Command } from "@/components/CommandPalette";
import ProxiesView from "@/components/ProxiesView";
import { attentionReasons, inView, proxyInventory, replaceProxy, tagCounts, VIEW_LABELS, type ProxyRow, type ViewKey } from "@/lib/workspace";
import ShortcutsDialog from "@/components/ShortcutsDialog";
import UpdateBanner from "@/components/UpdateBanner";
import ExportDialog from "@/components/ExportDialog";
import MigrateDialog, { type MigrateMode } from "@/components/MigrateDialog";
import BulkCreateDialog from "@/components/BulkCreateDialog";
import RunTaskDialog from "@/components/RunTaskDialog";
import TaskBoard from "@/components/TaskBoard";
import TasksView from "@/components/TasksView";
import type { TaskExample } from "@/lib/taskExamples";
import Menu from "@/components/Menu";
import { launchReport, udpLine } from "@/lib/proxyReport";
import { ManageTemplatesDialog, SaveTemplateDialog } from "@/components/TemplateDialogs";
import {
  describeTemplate,
  markUsed,
  nextNumber,
  profileFromTemplate,
  readTemplates,
  sortTemplates,
  templateFromProfile,
  upsertTemplate,
  type ProfileTemplate,
} from "@/lib/templates";
import type { HostGpuVendor } from "@/lib/gpuPicker";
import PromptDialog from "@/components/PromptDialog";
import GroupHeader from "@/components/GroupHeader";
import { fmtSize } from "@/components/StorageSection";
import { ConfirmProvider, useConfirm } from "@/components/Confirm";
import { dialogOpen } from "@/components/Dialog";
import { LogoMark } from "@/components/LogoMark";
import { Mascot } from "@/components/Mascot";
import {
  describeCloudEnd,
  describeCloudError,
  describeExit,
  describeLaunchError,
  describeLaunchWarnings,
  withSwap,
  type LaunchNotice,
  type NoticeAction,
} from "@/lib/launchError";
import { describeTarget, type LaunchTarget } from "@/lib/launchTarget";
import { newProfile } from "@/lib/newProfile";
import { defaultPersonaPlatform, hostOs, shortcutLabel, type HostOs } from "@/lib/host";
import {
  SORT_LABELS,
  displayName,
  filterProfiles,
  geoLabel,
  proxySummary,
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

const freshProfile = (): Profile =>
  newProfile(randomSeed(), new Date().toISOString(), defaultPersonaPlatform(hostOs()));

const input =
  "w-full rounded-lg bg-ink/70 border border-line px-3 py-2 text-sm text-fog placeholder-fog/30 outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/40";
const btnGhost =
  "rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-fog/80 hover:bg-elevate transition disabled:opacity-40";

// Per-viewer list preferences (the renderer's own storage; per install in the desktop app).
const SORT_KEY = "clearcote.sort";
const LAYOUT_KEY = "clearcote.layout";
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
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
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

type PromptKind =
  | { kind: "set-group" }
  | { kind: "add-tag" }
  | { kind: "rename-group"; key: string; name: string }
  | { kind: "replace-proxy"; row: ProxyRow };

export default function Page() {
  useLocale();
  return (
    <ConfirmProvider>
      <Manager />
    </ConfirmProvider>
  );
}

/** Where the cloud balance is topped up (dashboard → Browsers). */
const CLOUD_TOPUP_URL = "https://www.clearcotelabs.com/dashboard/browsers";

function Manager() {
  useLocale();
  const confirm = useConfirm();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  // The OS, read after mount: the page is prerendered, and a label that differed between the
  // prerender and a Mac's first render would be a hydration mismatch React leaves unpatched.
  const [host, setHost] = useState<HostOs | undefined>(undefined);
  useEffect(() => setHost(hostOs()), []);
  const [running, setRunning] = useState<string[]>([]);
  // Profiles running on Clearcote's servers, as the main process follows them (electron/cloud.ts).
  const [cloudSessions, setCloudSessions] = useState<CloudSession[]>([]);
  const [cloudStartingId, setCloudStartingId] = useState<string | null>(null);
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
  // The workspace: which page, which list, cards or a table, whose details are open.
  const [page, setPage] = useState<PageKey>("profiles");
  const [view, setView] = useState<ViewKey>("all");
  const runningOnly = view === "running";
  const [layout, setLayout] = useState<"cards" | "table">("cards");
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [proxyChecking, setProxyChecking] = useState<Set<string>>(new Set());
  const [groupOrder, setGroupOrder] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  // Multi-select: the ids, and the last one clicked (Shift+click selects the range to it).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [settings, setSettings] = useState<Settings>({});
  const [binary, setBinary] = useState<string | null>(null);
  const [target, setTarget] = useState<LaunchTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null);
  /** Settings was opened by "Use my Clearcote account": it starts the sign-in itself. */
  const [autoLogin, setAutoLogin] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [migrate, setMigrate] = useState<MigrateMode | null>(null);
  const [exportReq, setExportReq] = useState<{ ids?: string[]; single?: string; count: number } | null>(null);
  const [bulkCreateOpen, setBulkCreateOpen] = useState(false);
  // Run a task on the selected profiles (Jet): the dialog, and the runs the board shows.
  const [runTaskOpen, setRunTaskOpen] = useState(false);
  const [taskRuns, setTaskRuns] = useState<SyncRun[]>([]);
  /** Trial runs on one profile (Run a task → Try it first): run id → the request for the rest. */
  const [trials, setTrials] = useState<Record<string, StartRequest>>({});
  /** Saved tasks (Tasks page), and the one Run a task was opened from. */
  const [savedTasks, setSavedTasks] = useState<SavedTask[]>([]);
  const [runTaskFor, setRunTaskFor] = useState<SavedTask | undefined>(undefined);
  /** ...or the example it was opened from (Tasks page → an example card). */
  const [runTaskExample, setRunTaskExample] = useState<TaskExample | undefined>(undefined);
  /** Run a task opens fresh every time: only what this opening passes (a saved task or an example). */
  const openRunTask = (task?: SavedTask, example?: TaskExample) => {
    setRunTaskFor(task);
    setRunTaskExample(task ? undefined : example);
    setRunTaskOpen(true);
  };
  /** Every way the dialog closes forgets what it was opened with. */
  const closeRunTask = () => {
    setRunTaskOpen(false);
    setRunTaskFor(undefined);
    setRunTaskExample(undefined);
  };
  // Templates: the profile being saved as one, the manage dialog, and the template the open editor
  // was started from (its use is counted when that profile is saved).
  const [saveTplFor, setSaveTplFor] = useState<Profile | null>(null);
  const [manageTplOpen, setManageTplOpen] = useState(false);
  const [editingFrom, setEditingFrom] = useState<ProfileTemplate | null>(null);
  const [hostVendor, setHostVendor] = useState<HostGpuVendor>("unknown");
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
    setIsEl(hasBackend);
    // sync from the theme the no-flash inline script already applied
    setTheme(document.documentElement.classList.contains("light") ? "light" : "dark");
    try {
      const saved = localStorage.getItem(SORT_KEY) as SortKey | null;
      if (saved && saved in SORT_LABELS) setSort(saved);
      if (localStorage.getItem(LAYOUT_KEY) === "table") setLayout("table");
    } catch {
      /* ignore */
    }
    setGroupOrder(loadList(GROUP_ORDER_KEY));
    setCollapsed(loadList(COLLAPSED_KEY));
    refresh();
    refreshTarget();
    // The GPU maker of this computer, for templates that give every profile a new random GPU.
    api.hostGpu?.().then((g) => g && setHostVendor(g.vendor)).catch(() => {});
    api.settings.get().then((s) => {
      setSettings(s);
      // Just paired (web version) and no key yet: offer the account sign-in now, and start it when that
      // is what the person connected for.
      const reason = takeJustPaired();
      if (reason && !s.licenseKey && api.license.loginStart) {
        setAutoLogin(reason === ACCOUNT_WHY);
        setSettingsOpen("license");
      }
    });
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
  const toggleTheme = () => setTheme((th) => (th === "dark" ? "light" : "dark"));

  useEffect(() => {
    const iv = setInterval(async () => setRunning(await api.running()), 2500);
    return () => clearInterval(iv);
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

  // Cloud sessions: the list now, every change after (usage, cost, stopping), and a notice on the card
  // when the service ends one on its own (idle, a cap, the balance).
  useEffect(() => {
    let alive = true;
    void api.cloud.list().then((l) => alive && setCloudSessions(l));
    const offChanged = api.cloud.onChanged((l) => setCloudSessions(l));
    const offEnded = api.cloud.onEnded((ev) => {
      const n = describeCloudEnd(ev);
      if (n) setNotices((all) => ({ ...all, [ev.profileId]: n }));
    });
    return () => {
      alive = false;
      offChanged();
      offEnded();
    };
  }, []);

  // Task runs (desktop app only): the list now, every change after.
  useEffect(() => {
    const sync = api.sync;
    if (!sync) return;
    let alive = true;
    void sync.list().then((r) => alive && setTaskRuns(r));
    const off = sync.onChanged((r) => setTaskRuns(r));
    return () => {
      alive = false;
      off();
    };
  }, []);

  // Saved tasks: the list now, and again when a run of one was recorded into it.
  useEffect(() => {
    const tasks = api.tasks;
    if (!tasks) return;
    let alive = true;
    const load = () => void tasks.list().then((l) => alive && setSavedTasks(l));
    load();
    const off = tasks.onChanged(load);
    return () => {
      alive = false;
      off();
    };
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
    const tm = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), toast.action ? 8000 : 3500);
    return () => clearTimeout(tm);
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
    setEditingFrom(null);
  }
  async function closeEditor() {
    if (editorDirty) {
      const ok = await confirm({
        title: t("Discard your changes?"),
        body: t("“{name}” has changes that are not saved.", { name: editing?.name?.trim() || t("This profile") }),
        confirmLabel: t("Discard"),
        cancelLabel: t("Keep editing"),
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

  async function save(p: Profile): Promise<Profile> {
    const id = p.id || `${slugify(p.name) || "profile"}-${randomSeed().slice(0, 4)}`;
    const from = !p.id ? editingFrom : null;
    const saved = await api.profiles.save({ ...p, id });
    closeEditorNow();
    await refresh();
    if (from) await saveTemplates(markUsed(templates, from.id, new Date().toISOString()));
    notify(t("Saved “{name}”.", { name: displayName(saved) }));
    return saved;
  }

  // ── Templates ─────────────────────────────────────────────────────────────
  const templates = useMemo(() => sortTemplates(readTemplates(settings.templates)), [settings.templates]);
  // The latest settings, so two quick template changes never write from a stale copy.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  async function saveTemplates(list: ProfileTemplate[]) {
    const next = { ...settingsRef.current, templates: list };
    settingsRef.current = next;
    setSettings(next);
    setSettings(await api.settings.set(next));
  }
  async function saveAsTemplate(p: Profile, choice: { name: string; proxy: ProfileTemplate["proxy"]; gpu: ProfileTemplate["gpu"] }) {
    const now = new Date().toISOString();
    const replacing = templates.some((tpl) => tpl.name.trim().toLowerCase() === choice.name.trim().toLowerCase());
    await saveTemplates(upsertTemplate(templates, templateFromProfile(p, choice, now, `tpl-${randomSeed()}`), now));
    setSaveTplFor(null);
    notify(
      replacing
        ? t("Replaced the template “{name}”. Use it from the ▾ next to New profile.", { name: choice.name.trim() })
        : t("Saved the template “{name}”. Use it from the ▾ next to New profile.", { name: choice.name.trim() }),
    );
  }
  /** Open the editor on a new profile made from a template — on the proxy, when it asks for one. */
  function newFromTemplate(tpl: ProfileTemplate) {
    const p = profileFromTemplate(tpl, {
      seed: randomSeed(),
      now: new Date().toISOString(),
      number: nextNumber(tpl, profiles.map((x) => x.name)),
      hostVendor,
    });
    openEditor(p, tpl.proxy === "ask" ? "proxy" : undefined);
    setEditingFrom(tpl);
  }

  /** "Create & launch": the saved copy is what launches, as the web version's helper only launches
   *  stored profiles. */
  async function saveAndLaunch(p: Profile) {
    await launch(await save(p));
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
      title: t("Delete “{name}”?", { name: displayName(p) }),
      body: (
        <>
          {tRich(
            "This removes the profile <em>and its saved browser data</em> — cookies, logins, history and extensions. You can undo it for a few seconds.",
            { em: (s) => <span className="text-fog/80">{s}</span> },
          )}
        </>
      ),
      confirmLabel: t("Delete"),
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
    notify(t("Deleted “{name}”.", { name: displayName(p) }), {
      action: {
        label: t("Undo"),
        run: async () => {
          const back = await api.profiles.restore(r.trashId);
          if (!back.ok) {
            notify(back.error, { tone: "error" });
            return;
          }
          await refresh();
          notify(t("Restored “{name}”.", { name: displayName(back.profile) }));
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
  /** The message after a launch: where it exits (when the launch just looked that up for geoip) and,
   *  with "Relay UDP" on, whether the proxy really carries UDP — from the UDP association the launch
   *  made BEFORE it started the browser. This used to run a whole proxy check after the launch, and
   *  that check's own UDP test moved a residential sticky session to another exit under the running
   *  browser (CR-LYJSFW). Nothing here touches the proxy any more. */
  async function reportLaunch(p: Profile, r: LaunchResult) {
    const fresh = (await api.profiles.get(p.id).catch(() => null)) ?? p;
    const g = fresh.lastGeo;
    const recent = g && Date.now() - Date.parse(g.at) < 2 * 60_000 ? g : undefined;
    const text = launchReport(fresh, displayName(p), recent);
    // A refused UDP is safe (WebRTC stays blocked), so it is information, not an error.
    const u = p.socks5Udp && p.proxy ? udpLine(r.udp, r.udpDetail) : null;
    notify(u ? `${text} ${u.text}` : text);
  }

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
        void reportLaunch(p, r);
      } else if (needsHelper(r)) {
        // The web preview: the connect window is already open.
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

  // ── Cloud ─────────────────────────────────────────────────────────────────
  /** Run a profile on Clearcote's servers; its viewer window opens when it is up. */
  async function cloudStart(p: Profile) {
    setCloudStartingId(p.id);
    setNotices(({ [p.id]: _old, ...rest }) => rest);
    try {
      const r = await api.cloud.start(p);
      setCloudSessions(await api.cloud.list());
      if (r.ok) {
        await refresh();
        if (r.warnings.length) setNotices((n) => ({ ...n, [p.id]: describeLaunchWarnings(r.warnings) }));
        notify(t("“{name}” is running in the cloud.", { name: displayName(p) }));
      } else if (!needsHelper(r)) {
        const n = describeCloudError(r);
        if (n) setNotices((all) => ({ ...all, [p.id]: n }));
      }
    } finally {
      setCloudStartingId(null);
    }
  }
  async function cloudStop(p: Profile) {
    const r = await api.cloud.stop(p.id);
    setCloudSessions(await api.cloud.list());
    if (r.ok) notify(t("Stopping “{name}” in the cloud.", { name: displayName(p) }));
    else notify(r.error || t("It could not be stopped. Try again."), { tone: "error" });
  }
  async function cloudOpen(p: Profile) {
    if (!(await api.cloud.open(p.id))) notify(t("It is no longer running in the cloud."), { tone: "error" });
  }

  async function noticeAction(p: Profile, a: NoticeAction) {
    if (a.kind === "retry") void launch(p);
    else if (a.kind === "retry-cloud") void cloudStart(p);
    else if (a.kind === "topup") void api.openExternal(CLOUD_TOPUP_URL);
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
      notify(t("Copied to the clipboard."));
    } catch {
      notify(t("Could not copy to the clipboard."), { tone: "error" });
    }
  }

  async function checkGeo(p: Profile) {
    notify(t("Checking where “{name}” exits…", { name: displayName(p) }));
    const r = await api.checkProfileGeo(p.id);
    if (r.ok) {
      await refresh();
      const place = [r.city, r.country].filter(Boolean).join(", ") || t("an unknown place");
      notify(
        r.ip
          ? t("“{name}” exits in {place} as {ip}.", { name: displayName(p), place, ip: r.ip })
          : t("“{name}” exits in {place}.", { name: displayName(p), place }),
      );
    } else if (!needsHelper(r)) notify(r.error || t("The proxy location could not be checked."), { tone: "error" });
  }

  async function clearCache(p: Profile) {
    const ok = await confirm({
      title: t("Clear the cache of “{name}”?", { name: displayName(p) }),
      body: t("Cached pages, scripts and shaders are removed; they rebuild as you browse. Cookies, logins, saved site data, history and extensions stay."),
      confirmLabel: t("Clear cache"),
    });
    if (!ok) return;
    const r = await api.profiles.clearCache(p.id);
    if (r.ok) notify(t("Cleared {size} of cache from “{name}”.", { size: fmtSize(r.freedBytes ?? 0), name: displayName(p) }));
    else notify(r.error || t("Could not clear the cache."), { tone: "error" });
  }

  async function pickBinary() {
    const b = await api.pickBinary();
    if (b) {
      setBinary(b);
      setSettings(await api.settings.get());
      refreshTarget();
      notify(t("Browser binary set."));
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
      const n = r.count ?? 0;
      notify(
        includeSecrets
          ? n === 1
            ? t("Exported 1 profile — with proxy passwords and encryption keys. Keep the file private.")
            : t("Exported {n} profiles — with proxy passwords and encryption keys. Keep the file private.", { n })
          : n === 1
            ? t("Exported 1 profile — proxy passwords and encryption keys left out.")
            : t("Exported {n} profiles — proxy passwords and encryption keys left out.", { n }),
      );
    }
  }
  async function doImport() {
    const r = await api.importProfiles();
    if (r.ok) {
      await refresh();
      const n = r.count ?? 0;
      notify(
        r.renamed
          ? n === 1
            ? t("Imported 1 profile — {renamed} under a new id, because theirs was already taken.", { renamed: r.renamed })
            : t("Imported {n} profiles — {renamed} under a new id, because theirs was already taken.", { n, renamed: r.renamed })
          : n === 1
            ? t("Imported 1 profile.")
            : t("Imported {n} profiles.", { n }),
      );
    } else if (r.error && !needsHelper(r)) {
      notify(t("Import failed: {error}", { error: r.error }), { tone: "error" });
    }
  }
  async function doMigrate(mode: MigrateMode, text: string, filename: string) {
    if (mode.kind === "cookies") {
      const r = api.importCookies ? await api.importCookies(mode.id, text) : { ok: false, error: t("Update the app to import cookies.") };
      if (r.ok) {
        const n = r.count ?? 0;
        notify(
          n === 1
            ? t("1 cookie added to “{name}”. It goes into the browser at its next launch.", { name: mode.name })
            : t("{n} cookies added to “{name}”. They go into the browser at its next launch.", { n, name: mode.name }),
        );
      }
      return r;
    }
    const r = api.migrateImport ? await api.migrateImport(text, filename) : { ok: false, error: t("Update the app to import from another browser.") };
    if (r.ok) {
      await refresh();
      const n = r.count ?? 0;
      const c = r.cookies ?? 0;
      notify(
        c
          ? n === 1
            ? t("Imported 1 profile with {c} cookies. They go in at its first launch.", { c })
            : t("Imported {n} profiles with {c} cookies. They go in at each one's first launch.", { n, c })
          : n === 1
            ? t("Imported 1 profile.")
            : t("Imported {n} profiles.", { n }),
      );
    }
    return r;
  }
  async function createMany(list: Profile[], template?: ProfileTemplate) {
    for (const p of list) await api.profiles.save(p);
    setBulkCreateOpen(false);
    await refresh();
    if (template && list.length) await saveTemplates(markUsed(templates, template.id, new Date().toISOString(), list.length));
    const n = list.length;
    notify(
      template
        ? n === 1
          ? t("Created 1 profile from “{template}”.", { template: template.name })
          : t("Created {n} profiles from “{template}”.", { n, template: template.name })
        : n === 1
          ? t("Created 1 profile.")
          : t("Created {n} profiles.", { n }),
    );
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
      else setUpdErr(r.error || t("Download failed."));
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
  const cloudById = useMemo(() => new Map(cloudSessions.map((c) => [c.profileId, c])), [cloudSessions]);
  // "Running" means open anywhere: on this PC or in the cloud.
  const active = useMemo(() => [...running, ...cloudSessions.map((c) => c.profileId).filter((id) => !running.includes(id))], [running, cloudSessions]);
  // Why each profile needs attention: a launch notice still on it, or a coherence error.
  const attention = useMemo(() => {
    const m = new Map<string, { text: string; field?: string }[]>();
    for (const p of profiles) {
      const r = attentionReasons(p, notices[p.id], { hostPlatform: host });
      if (r.length) m.set(p.id, r);
    }
    return m;
  }, [profiles, notices, host]);
  const activeSet = useMemo(() => new Set(active), [active]);
  const attentionSet = useMemo(() => new Set(attention.keys()), [attention]);
  const viewCounts = useMemo(() => {
    const o = { active: activeSet, attention: attentionSet };
    const n = (v: ViewKey) => profiles.filter((p) => inView(p, v, o)).length;
    return { all: profiles.length, running: n("running"), attention: n("attention"), recent: n("recent") };
  }, [profiles, activeSet, attentionSet]);
  const filtered = useMemo(
    () =>
      sortProfiles(
        filterProfiles(profiles, { query, tag: tagFilter ?? undefined, group: groupFilter?.key, runningOnly }, active).filter((p) =>
          inView(p, view, { active: activeSet, attention: attentionSet }),
        ),
        active,
        sort,
      ),
    [profiles, query, tagFilter, groupFilter, runningOnly, active, sort, view, activeSet, attentionSet],
  );
  const proxyRows = useMemo(() => proxyInventory(profiles), [profiles]);
  const tagList = useMemo(() => tagCounts(profiles), [profiles]);
  const groupList = useMemo(() => {
    const m = new Map<string, { key: string; name: string; count: number }>();
    for (const p of profiles) {
      const name = p.group?.trim();
      if (!name) continue;
      const k = groupKey(name);
      const cur = m.get(k);
      if (cur) cur.count++;
      else m.set(k, { key: k, name, count: 1 });
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [profiles]);
  const sections = useMemo(() => groupProfiles(filtered, groupOrder), [filtered, groupOrder]);
  const groupNames = useMemo(
    () => Array.from(new Map(profiles.filter((p) => p.group?.trim()).map((p) => [groupKey(p.group), p.group!.trim()])).values()).sort(),
    [profiles],
  );
  const filtering = !!(query.trim() || tagFilter || groupFilter || view !== "all");
  // A heading (and folding) shows for every named group; only a lone "No group" list goes without.
  const hasHeading = (s: { group: string | null }) => sections.length > 1 || s.group !== null;
  const visibleIds =
    layout === "table"
      ? filtered.map((p) => p.id)
      : sections.filter((s) => !(collapsed.includes(s.key) && hasHeading(s))).flatMap((s) => s.profiles.map((p) => p.id));

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
    setView("all");
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
    notify(
      to
        ? n === 1
          ? t("Renamed the group to “{name}” (1 profile).", { name: to })
          : t("Renamed the group to “{name}” ({n} profiles).", { name: to, n })
        : n === 1
          ? t("Ungrouped 1 profile.")
          : t("Ungrouped {n} profiles.", { n }),
    );
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
      if (active.includes(p.id)) continue;
      const r = await launch(p);
      if (r.ok) done++;
      else if (r.code === "CONCURRENCY_LIMIT_EXCEEDED") {
        notify(t("Launched {n}, then reached your plan's browser limit.", { n: done }), { tone: "error" });
        return;
      }
    }
    notify(done === 1 ? t("Launched 1 profile.") : t("Launched {n} profiles.", { n: done }));
  }
  async function bulkStop() {
    const ids = selectedProfiles.map((p) => p.id).filter((id) => running.includes(id));
    const inCloud = selectedProfiles.map((p) => p.id).filter((id) => cloudById.has(id));
    await Promise.all([...ids.map((id) => api.stop(id)), ...inCloud.map((id) => api.cloud.stop(id))]);
    await refresh();
    setCloudSessions(await api.cloud.list());
    ids.push(...inCloud);
    notify(ids.length === 1 ? t("Stopped 1 browser.") : t("Stopped {n} browsers.", { n: ids.length }));
  }
  async function bulkDelete() {
    const deletable = selectedProfiles.filter((p) => !active.includes(p.id));
    const skipped = selectedProfiles.length - deletable.length;
    if (!deletable.length) {
      notify(t("Stop their browsers first — running profiles can't be deleted."), { tone: "error" });
      return;
    }
    const ok = await confirm({
      title: deletable.length === 1 ? t("Delete 1 profile?") : t("Delete {n} profiles?", { n: deletable.length }),
      body: (
        <>
          {tRich(
            "This removes them <em>and their saved browser data</em> — cookies, logins, history and extensions. You can undo it for a few seconds.",
            { em: (s) => <span className="text-fog/80">{s}</span> },
          )}
          {skipped
            ? " " + (skipped === 1 ? t("1 running profile is left alone.") : t("{n} running profiles are left alone.", { n: skipped }))
            : ""}
        </>
      ),
      confirmLabel: t("Delete"),
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
    notify(trashed.length === 1 ? t("Deleted 1 profile.") : t("Deleted {n} profiles.", { n: trashed.length }), {
      action: {
        label: t("Undo"),
        run: async () => {
          let back = 0;
          for (const trashId of trashed) if ((await api.profiles.restore(trashId)).ok) back++;
          await refresh();
          notify(back === 1 ? t("Restored 1 profile.") : t("Restored {n} profiles.", { n: back }));
        },
      },
    });
  }
  async function refreshTasks() {
    if (api.tasks) setSavedTasks(await api.tasks.list());
  }
  async function saveTask(task: Partial<SavedTask>): Promise<SavedTask> {
    const saved = await api.tasks!.save(task);
    await refreshTasks();
    return saved;
  }
  async function deleteTask(task: SavedTask) {
    if (!api.tasks || !(await api.tasks.remove(task.id))) return;
    await refreshTasks();
    notify(t("Deleted the task “{name}”.", { name: task.name }), {
      action: {
        label: t("Undo"),
        run: async () => {
          await api.tasks!.save(task);
          await refreshTasks();
        },
      },
    });
  }
  /** Run board -> Save as a task: the recipe of a run that worked, its steps and the run itself. */
  async function saveRunAsTask(run: SyncRun) {
    const done = run.rows.filter((r) => r.status === "done");
    const best = done.find((r) => r.skill === "learned" || r.skill === "repaired") ?? done[0];
    const saved = await saveTask({
      name: run.goal.slice(0, 60),
      goal: run.goal,
      url: run.url,
      confirm: run.confirm,
      concurrency: run.concurrency,
      staggerSec: run.staggerSec,
      closeWhenDone: run.closeWhenDone,
      params: [
        ...Object.keys(run.params ?? {}).map((name) => ({ name, source: "run" as const, default: run.params![name] })),
        // A secret run value is asked again each time it runs: its name is kept, never its value.
        ...(run.secretParams ?? []).map((name) => ({ name, source: "run" as const, secret: true })),
      ],
      ...(best ? { steps: best.steps.map(({ template, ...s }) => (template !== undefined ? { ...s, text: template } : s)), stepsFrom: best.name } : {}),
      history: [{ at: run.createdAt, total: run.rows.length, done: done.length, ...(run.params ? { params: run.params } : {}) }],
    });
    notify(t("Saved as a task. Find it under Tasks."), { action: { label: t("Open"), run: () => setPage("tasks") } });
    return saved;
  }

  async function bulkEdit(change: (p: Profile) => Profile, done: string) {
    for (const p of selectedProfiles) await api.profiles.save(change(p));
    await refresh();
    notify(done);
  }

  /** Arrow keys between cards. Up/Down go to the nearest card in the row above/below by position,
   *  which also works across group sections with different column counts. */
  function moveFocus(fromId: string, key: string) {
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-card], [data-row]"));
    const i = cards.findIndex((c) => (c.dataset.card ?? c.dataset.row) === fromId);
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

  // ── Workspace ─────────────────────────────────────────────────────────────
  function changeLayout(l: "cards" | "table") {
    setLayout(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* ignore */
    }
  }
  function goProfiles(v: ViewKey = view) {
    setPage("profiles");
    setView(v);
    setSidebarOpen(false);
  }

  /** Everything a card, a table row and the details panel need for one profile — one place, so the
   *  three never disagree about what an action does. */
  function cardProps(p: Profile): CardProps {
    return {
      profile: p,
      running: running.includes(p.id),
      launching: launchingId === p.id,
      download: dl && dl.id === p.id ? dl : null,
      notice: notices[p.id],
      current,
      selected: selected.has(p.id),
      selecting: selected.size > 0,
      onToggleSelect: ({ range }) => toggleSelect(p.id, range),
      onFilterTag: (tag) => {
        setTagFilter(tag);
        goProfiles();
      },
      onLaunch: () => void launch(p),
      onStop: () => stop(p),
      cloud: cloudById.get(p.id),
      cloudStarting: cloudStartingId === p.id,
      onCloudStart: () => void cloudStart(p),
      onCloudStop: () => void cloudStop(p),
      onCloudOpen: () => void cloudOpen(p),
      onEdit: (field) => openEditor(p, field),
      onDuplicate: () => duplicate(p),
      onSaveTemplate: () => setSaveTplFor(p),
      onDelete: () => remove(p),
      onExport: () => openExport([p.id]),
      onImportCookies: () => setMigrate({ kind: "cookies", id: p.id, name: p.name || p.id }),
      onOpenData: () => openData(p),
      onCheckGeo: () => checkGeo(p),
      onClearCache: () => clearCache(p),
      onDismissNotice: () => setNotices(({ [p.id]: _gone, ...rest }) => rest),
      onNoticeAction: (a) => noticeAction(p, a),
      onCopy: copy,
      onArrow: (key) => moveFocus(p.id, key),
      onDetails: () => setDetailsId(p.id),
    };
  }
  const detailsProfile = detailsId ? profiles.find((p) => p.id === detailsId) : undefined;

  // ── Proxies page ──────────────────────────────────────────────────────────
  async function checkProxy(row: ProxyRow) {
    const p = row.profiles[0];
    if (!p) return;
    setProxyChecking((s) => new Set(s).add(row.key));
    try {
      await checkGeo(p);
    } finally {
      setProxyChecking((s) => {
        const n = new Set(s);
        n.delete(row.key);
        return n;
      });
    }
  }
  async function checkAllProxies() {
    // One at a time: a burst of lookups through the same provider looks like what it is.
    setPage("proxies");
    setProxyChecking(new Set(proxyRows.map((r) => r.key)));
    let failed = 0;
    for (const row of proxyRows) {
      const r = await api.checkProfileGeo(row.profiles[0].id).catch(() => ({ ok: false }));
      if (!r.ok) failed++;
      setProxyChecking((s) => {
        const n = new Set(s);
        n.delete(row.key);
        return n;
      });
    }
    await refresh();
    notify(
      failed
        ? t("Checked {n} proxies; {failed} did not answer.", { n: proxyRows.length, failed })
        : proxyRows.length === 1
          ? t("Checked 1 proxy.")
          : t("Checked {n} proxies.", { n: proxyRows.length }),
      failed ? { tone: "error" } : {},
    );
  }
  async function doReplaceProxy(row: ProxyRow, to: string) {
    let n = 0;
    for (const p of row.profiles) {
      const next = replaceProxy(p, row.key, to);
      if (next !== p) {
        // The old exit was measured through the old server; it says nothing about the new one.
        const { lastGeo: _old, ...rest } = next;
        await api.profiles.save(rest);
        n++;
      }
    }
    await refresh();
    notify(n === 1 ? t("Moved 1 profile to the new proxy.") : t("Moved {n} profiles to the new proxy.", { n }));
  }
  function showProxyProfiles(row: ProxyRow) {
    setQuery(`${row.host}:${row.port}`);
    setTagFilter(null);
    setGroupFilter(null);
    goProfiles("all");
  }

  // ── Open now (sidebar) ────────────────────────────────────────────────────
  const runningItems: RunningItem[] = [
    ...profiles
      .filter((p) => running.includes(p.id))
      .map((p) => ({ id: p.id, name: displayName(p), where: "local" as const, detail: geoLabel(p)?.text })),
    ...cloudSessions.map((c) => ({
      id: c.profileId,
      name: displayName(profiles.find((p) => p.id === c.profileId) ?? ({ id: c.profileId } as Profile)),
      where: "cloud" as const,
      detail: c.exit,
      stopping: c.status === "stopping",
    })),
  ];
  function stopRunning(id: string) {
    const p = profiles.find((x) => x.id === id) ?? ({ id } as Profile);
    if (cloudById.has(id)) void cloudStop(p);
    else void stop(p);
  }
  function openRunning(id: string) {
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    if (cloudById.has(id)) void cloudOpen(p);
    else {
      setDetailsId(id);
      setSidebarOpen(false);
    }
  }

  // ── Command palette ───────────────────────────────────────────────────────
  function paletteCommands(): { commands: Command[]; profileCommands: Command[] } {
    const app = t("Commands");
    const nav = t("Go to");
    const commands: Command[] = [
      { id: "new", section: app, label: t("New profile"), hint: shortcutLabel("N", host), run: () => openEditor(freshProfile()) },
      ...templates.slice(0, 8).map((tpl) => ({
        id: `tpl:${tpl.id}`,
        section: app,
        label: t("New profile from “{template}”", { template: tpl.name }),
        keywords: "template",
        run: () => newFromTemplate(tpl),
      })),
      { id: "bulk", section: app, label: t("New profiles from a proxy list…"), keywords: "bulk create import", run: () => setBulkCreateOpen(true) },
      { id: "import", section: app, label: t("Import profiles from a file…"), run: () => void doImport() },
      { id: "migrate", section: app, label: t("Move in from another browser…"), keywords: "adspower dolphin gologin multilogin octo", run: () => setMigrate({ kind: "profiles" }) },
      { id: "export", section: app, label: t("Export all profiles…"), run: () => openExport() },
      { id: "templates", section: app, label: t("Manage templates…"), run: () => setManageTplOpen(true) },
      { id: "checkall", section: app, label: t("Check every proxy"), keywords: "proxies geo exit", run: () => void checkAllProxies() },
      {
        id: "layout",
        section: app,
        label: layout === "cards" ? t("Show profiles as a table") : t("Show profiles as cards"),
        keywords: "view layout density",
        run: () => changeLayout(layout === "cards" ? "table" : "cards"),
      },
      { id: "theme", section: app, label: t("Toggle light or dark theme"), run: toggleTheme },
      { id: "settings", section: app, label: t("Settings"), hint: shortcutLabel(",", host), run: () => setSettingsOpen("general") },
      { id: "shortcuts", section: app, label: t("Keyboard shortcuts"), hint: "?", run: () => setShortcutsOpen(true) },
      { id: "v:all", section: nav, label: t("All profiles"), run: () => goProfiles("all") },
      { id: "v:running", section: nav, label: t("Running"), run: () => goProfiles("running") },
      { id: "v:attention", section: nav, label: t("Needs attention"), run: () => goProfiles("attention") },
      { id: "v:recent", section: nav, label: t("Used this week"), run: () => goProfiles("recent") },
      { id: "v:proxies", section: nav, label: t("Proxies"), run: () => setPage("proxies") },
      ...(api.tasks && api.sync ? [{ id: "v:tasks", section: nav, label: t("Tasks"), run: () => setPage("tasks") }] : []),
      ...groupList.map((g) => ({
        id: `g:${g.key}`,
        section: nav,
        label: t("Group {name}", { name: g.name }),
        run: () => {
          setGroupFilter({ key: g.key, name: g.name });
          goProfiles();
        },
      })),
    ];
    const sec = t("Profiles");
    const profileCommands: Command[] = profiles.flatMap((p) => {
      const name = displayName(p);
      const kw = [p.group, ...(p.tags ?? []), proxySummary(p.proxy)].filter(Boolean).join(" ");
      const live = active.includes(p.id);
      const first: Command = cloudById.has(p.id)
        ? { id: `o:${p.id}`, section: sec, label: t("Open the cloud window of {name}", { name }), keywords: kw, run: () => void cloudOpen(p) }
        : running.includes(p.id)
          ? { id: `s:${p.id}`, section: sec, label: t("Stop {name}", { name }), keywords: kw, run: () => void stop(p) }
          : { id: `l:${p.id}`, section: sec, label: t("Launch {name}", { name }), keywords: kw, run: () => void launch(p) };
      return [
        first,
        { id: `d:${p.id}`, section: sec, label: t("Details of {name}", { name }), keywords: kw, run: () => setDetailsId(p.id) },
        { id: `e:${p.id}`, section: sec, label: t("Edit {name}", { name }), keywords: kw, run: () => openEditor(p) },
        ...(live ? [] : [{ id: `c:${p.id}`, section: sec, label: t("Run {name} in the cloud", { name }), keywords: kw, run: () => void cloudStart(p) }]),
      ];
    });
    return { commands, profileCommands };
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────
  // Page-level shortcuts stand down while any dialog is open, and single keys never fire while
  // typing in a field.
  // The most recently used template, for Ctrl+Shift+N (read through the ref, like the rest).
  const newFromLast = () => (templates[0] ? newFromTemplate(templates[0]) : setManageTplOpen(true));
  const detailsOpen = !!detailsProfile;
  const kb = useRef({ visibleIds, selectedCount: selected.size, filtering, newFromLast, detailsOpen });
  kb.current = { visibleIds, selectedCount: selected.size, filtering, newFromLast, detailsOpen };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialogOpen() || e.defaultPrevented) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const typing = isTyping(e.target);
      if (mod && !e.altKey && e.shiftKey && k === "n") {
        e.preventDefault();
        kb.current.newFromLast();
      } else if (mod && !e.altKey && k === "n") {
        e.preventDefault();
        openEditor(freshProfile());
      } else if (mod && !e.altKey && !e.shiftKey && k === "k") {
        e.preventDefault();
        setPaletteOpen(true);
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
        } else if (e.key === "Escape" && kb.current.detailsOpen) {
          e.preventDefault();
          setDetailsId(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // openEditor only calls state setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pill = describeTarget(isEl ? target : target ?? { mode: "preview" });
  // No key yet: "Use my Clearcote account" is the first thing in the header (and the pill does the same).
  const offerAccount = mounted && !settings.licenseKey && !!api.license.loginStart;
  function startAccountLogin() {
    setAutoLogin(true);
    setSettingsOpen("license");
  }
  const pillTone = {
    ok: "border-accent/30 text-accent hover:bg-accent/5",
    warn: "border-warn/40 text-warn hover:bg-warn/5",
    muted: "border-line text-fog/50 hover:bg-elevate",
  }[pill.tone];
  const dotTone = { ok: "bg-accent", warn: "bg-warn", muted: "bg-fog/30" }[pill.tone];
  const sidebar = (
    <Sidebar
      page={page}
      onPage={(p) => {
        setPage(p);
        setSidebarOpen(false);
      }}
      view={view}
      onView={(v) => goProfiles(v)}
      counts={viewCounts}
      groups={groupList}
      group={groupFilter?.key ?? null}
      onGroup={(g) => setGroupFilter(g)}
      tags={tagList}
      tag={tagFilter}
      onTag={(tag) => setTagFilter(tag)}
      proxies={proxyRows.length}
      tasks={api.tasks && api.sync ? savedTasks.length : undefined}
      running={runningItems}
      onStopRunning={stopRunning}
      onOpenRunning={openRunning}
      footer={
        <button
          className="flex w-full items-center justify-between rounded-lg px-2 py-1 text-[11px] text-fog/45 hover:bg-elevate hover:text-fog"
          onClick={() => setPaletteOpen(true)}
          aria-label={t("Open the command bar")}
        >
          <span>{t("Commands and search")}</span>
          <kbd className="rounded border border-line px-1 font-mono text-[10px]">{shortcutLabel("K", host)}</kbd>
        </button>
      }
    />
  );
  const current = target && target.mode === "managed" ? { version: target.version, major: target.major, plan: target.plan } : undefined;
  const takenNames = useMemo(
    () => profiles.filter((p) => p.id !== editing?.id).map((p) => (p.name ?? "").trim().toLowerCase()).filter(Boolean),
    [profiles, editing?.id],
  );

  return (
    // data-ready: set once hydrated and the shortcuts are live — what the UI tests wait for.
    <main className="app-sheen relative min-h-screen" data-ready={mounted ? "1" : undefined}>
      <div className="relative z-10 flex min-h-screen">
      {/* The workspace column: always there from 768 px, a drawer below that. */}
      <div className="sticky top-0 hidden h-screen md:block">{sidebar}</div>
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div className="h-full">{sidebar}</div>
          <button className="flex-1 bg-scrim" aria-label={t("Close the side panel")} onClick={() => setSidebarOpen(false)} />
        </div>
      )}
      <div className="min-w-0 flex-1">
      <div className={"mx-auto max-w-6xl px-6 py-6 animate-fade-up " + (selected.size ? "pb-24" : "")}>
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              className={btnGhost + " w-8 px-0 md:hidden"}
              onClick={() => setSidebarOpen(true)}
              aria-label={t("Open the side panel")}
            >
              ☰
            </button>
            <LogoMark className="h-8 w-8" />
            <div>
              <h1 className="text-[15px] font-semibold tracking-tight">
                Clear<span className="text-fog/55">cote</span>{" "}
                <span className="text-fog/45 font-normal">{t("Profile Manager")}</span>
              </h1>
              <div className="text-xs text-fog/40">{t("A clear coat for your browser identity.")}</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {offerAccount && (
              <button
                className="inline-flex items-center gap-1.5 rounded-lg border border-accent/50 bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent transition hover:bg-accent/20"
                onClick={startAccountLogin}
                title={t("Sign in on clearcotelabs.com and approve: your licence key is filled in for you")}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
                </svg>
                {t("Use my Clearcote account")}
              </button>
            )}
            {/* What the next launch actually runs — and a way to change it. */}
            <button
              className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition sm:inline-flex ${pillTone}`}
              title={offerAccount ? t("No licence key yet: use your Clearcote account") : pill.title}
              onClick={() => (offerAccount ? startAccountLogin() : setSettingsOpen(pill.section))}
              data-launch-target="1"
            >
              <span className={`h-1.5 w-1.5 rounded-full ${dotTone}`} />
              {pill.text}
            </button>
            <button
              className={btnGhost + " hidden items-center gap-2 text-fog/55 lg:inline-flex"}
              onClick={() => setPaletteOpen(true)}
              title={t("Find a profile or a command ({shortcut})", { shortcut: shortcutLabel("K", host) })}
              data-palette-button
            >
              {t("Find anything…")}
              <kbd className="rounded border border-line px-1 font-mono text-[10px] text-fog/40">{shortcutLabel("K", host)}</kbd>
            </button>
            <button
              className={btnGhost + " w-8 px-0 text-sm"}
              onClick={toggleTheme}
              title={t("Toggle light / dark theme")}
              aria-label={t("Toggle light or dark theme")}
            >
              {/* the ☀/☾ glyphs drew hairline-thin (☾ nearly invisible on light); stroked icons match the bar */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mx-auto">
                {theme === "dark" ? (
                  <>
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                  </>
                ) : (
                  <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
                )}
              </svg>
            </button>
            <button
              className={btnGhost + " w-8 px-0"}
              onClick={() => setShortcutsOpen(true)}
              title={t("Keyboard shortcuts (?)")}
              aria-label={t("Keyboard shortcuts")}
            >
              ?
            </button>
            <button className={btnGhost} onClick={() => setSettingsOpen("general")} title={t("Settings ({shortcut})", { shortcut: shortcutLabel(",", host) })}>
              {t("Settings")}
            </button>
            <div className="flex shadow-[0_0_20px_-6px_rgba(56,224,214,0.6)]" data-new-split="1">
              <button
                className="rounded-l-lg bg-sheen px-3.5 py-1.5 text-xs font-semibold text-[#07080a] hover:opacity-95 transition"
                onClick={() => openEditor(freshProfile())}
                title={t("New profile ({shortcut})", { shortcut: shortcutLabel("N", host) })}
              >
                {t("+ New profile")}
              </button>
              <Menu
                label={t("New from a template")}
                trigger="▾"
                triggerClassName="h-full rounded-r-lg border-l border-[#07080a]/25 bg-sheen px-2 py-1.5 text-xs font-bold text-[#07080a] hover:opacity-95 transition"
                items={[
                  ...(templates.length
                    ? templates.slice(0, 12).map((tpl, i) => ({
                        label: tpl.name,
                        hint: describeTemplate(tpl),
                        shortcut: i === 0 ? shortcutLabel("Shift+N", host) : undefined,
                        onSelect: () => newFromTemplate(tpl),
                      }))
                    : [
                        {
                          label: t("No templates yet"),
                          hint: t("Open ⋯ on any profile and choose Save as template"),
                          disabled: true,
                          onSelect: () => {},
                        },
                      ]),
                  "separator" as const,
                  { label: t("From proxy list…"), onSelect: () => setBulkCreateOpen(true) },
                  { label: t("Manage templates…"), onSelect: () => setManageTplOpen(true) },
                ]}
              />
            </div>
          </div>
        </header>

        {!isEl && (
          <div className="mt-4 rounded-lg border border-iris/25 bg-iris/5 px-3 py-2 text-xs text-iris">
            {t("Browser preview — profiles are stored locally in this browser and launching is disabled. Run the desktop app for the full experience.")}
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
            macos={host === "macos"}
            onDownload={downloadUpdate}
            onLater={laterUpdate}
            onRun={() => updFile && api.update.run(updFile.path)}
            onReveal={() => updFile && api.update.reveal(updFile.path)}
            onOpenReleases={() => api.update.openReleases(update.releaseUrl)}
          />
        )}

        {page === "tasks" ? (
          <>
            <h2 className="mt-6 text-lg font-semibold">{t("Tasks")}</h2>
            <TasksView
              tasks={savedTasks}
              selectedCount={selected.size}
              onRun={(task) => openRunTask(task)}
              onSave={saveTask}
              onDelete={(task) => void deleteTask(task)}
              onNew={() => openRunTask()}
              onExample={(ex) => openRunTask(undefined, ex)}
            />
          </>
        ) : page === "proxies" ? (
          <>
            <h2 className="mt-6 text-lg font-semibold">{t("Proxies")}</h2>
            <ProxiesView
              rows={proxyRows}
              profileCount={profiles.length}
              checking={proxyChecking}
              onCheck={(r) => void checkProxy(r)}
              onCheckAll={() => void checkAllProxies()}
              onShowProfiles={showProxyProfiles}
              onReplace={(row) => setPrompt({ kind: "replace-proxy", row })}
              onFromList={() => setBulkCreateOpen(true)}
            />
          </>
        ) : (
        <>
        {/* Toolbar */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <input
            ref={searchRef}
            className={input + " max-w-sm"}
            placeholder={t("Search names, groups, tags, proxies…")}
            aria-label={t("Search profiles")}
            title={t("Search ({shortcut} or /)", { shortcut: shortcutLabel("F", host) })}
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
          <div className="inline-flex overflow-hidden rounded-lg border border-line" role="group" aria-label={t("Show profiles as")}>
            {(["cards", "table"] as const).map((l) => (
              <button
                key={l}
                className={"px-2.5 py-1.5 text-xs font-medium transition " + (layout === l ? "bg-elevate text-fog" : "text-fog/55 hover:text-fog")}
                aria-pressed={layout === l}
                onClick={() => changeLayout(l)}
              >
                {l === "cards" ? t("Cards") : t("Table")}
              </button>
            ))}
          </div>
          <div className="text-xs text-fog/35" aria-live="polite">
            {filtered.length !== profiles.length
              ? t("{shown} of {total}", { shown: filtered.length, total: profiles.length })
              : profiles.length === 1
                ? t("1 profile")
                : t("{n} profiles", { n: profiles.length })}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-fog/40">
              {t("Sort")}
              <select
                className="rounded-lg border border-line bg-ink/70 px-2 py-1.5 text-xs text-fog/80 outline-none focus:border-accent/60"
                value={sort}
                onChange={(e) => changeSort(e.target.value as SortKey)}
              >
                {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                  <option key={k} value={k}>
                    {t(SORT_LABELS[k])}
                  </option>
                ))}
              </select>
            </label>
            <button className={btnGhost} onClick={() => setBulkCreateOpen(true)} title={t("One profile per proxy")}>
              {t("From proxy list…")}
            </button>
            <button className={btnGhost} onClick={doImport}>
              {t("Import")}
            </button>
            <button className={btnGhost} onClick={() => setMigrate({ kind: "profiles" })} title={t("AdsPower, Dolphin Anty, GoLogin, Multilogin, Octo…")}>
              {t("Move in from another browser…")}
            </button>
            <button className={btnGhost} onClick={() => openExport()} disabled={profiles.length === 0}>
              {t("Export")}
            </button>
          </div>
        </div>

        {/* Active filters */}
        {(tagFilter || groupFilter || view !== "all") && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-fog/40">{t("Showing")}</span>
            {view !== "all" && (
              <button
                className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-accent hover:bg-accent/15"
                onClick={() => setView("all")}
                aria-label={t("Show every profile again")}
              >
                {t(VIEW_LABELS[view])} <span aria-hidden>✕</span>
              </button>
            )}
            {tagFilter && (
              <button
                className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-accent hover:bg-accent/15"
                onClick={() => setTagFilter(null)}
                aria-label={t("Remove the tag filter #{tag}", { tag: tagFilter })}
              >
                #{tagFilter} <span aria-hidden>✕</span>
              </button>
            )}
            {groupFilter && (
              <button
                className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-accent hover:bg-accent/15"
                onClick={() => setGroupFilter(null)}
                aria-label={t("Remove the group filter {name}", { name: groupFilter.name })}
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
              {profiles.length === 0
                ? t("Meet Clyde — your first identity awaits")
                : runningOnly && !query && !tagFilter && !groupFilter
                  ? t("Nothing is running")
                  : view === "attention" && !query && !tagFilter && !groupFilter
                    ? t("Nothing needs attention")
                    : view === "recent" && !query && !tagFilter && !groupFilter
                      ? t("Nothing launched this week")
                      : t("No matches")}
            </h2>
            <p className="mt-1.5 max-w-sm text-sm text-fog/50">
              {profiles.length === 0
                ? t("Chameleons blend in to stay unseen. Spin up a profile — a saved fingerprint seed, proxy, and persistent session — and launch it any time.")
                : t("Try a different search or filter.")}
            </p>
            {profiles.length === 0 ? (
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                <button
                  className="rounded-lg bg-sheen px-5 py-2.5 text-sm font-semibold text-[#07080a] shadow-[0_0_26px_-6px_rgba(56,224,214,0.55)] transition hover:opacity-95 active:scale-[0.98]"
                  onClick={() => openEditor(freshProfile())}
                >
                  {t("+ Create your first profile")}
                </button>
                <button className={btnGhost + " px-4 py-2.5 text-sm"} onClick={() => setBulkCreateOpen(true)}>
                  {t("From a proxy list…")}
                </button>
              </div>
            ) : (
              filtering && (
                <button className={btnGhost + " mt-4"} onClick={clearFilters}>
                  {t("Clear search and filters")}
                </button>
              )
            )}
          </div>
        ) : layout === "table" ? (
          <div className="mt-5">
            <ProfileTable
              rows={filtered.map((p) => ({ ...cardProps(p), attention: attention.get(p.id) ?? [], open: detailsId === p.id }))}
            />
          </div>
        ) : (
          sections.map((sec, si) => {
            const folded = collapsed.includes(sec.key) && hasHeading(sec);
            const named = sections.filter((s) => s.group !== null);
            const ni = named.findIndex((s) => s.key === sec.key);
            return (
              <section key={sec.group === null ? "none" : `g:${sec.key}`} className="mt-5" aria-label={sec.group ?? (sections.length > 1 ? t("No group") : t("Profiles"))}>
                {hasHeading(sec) && (
                  <GroupHeader
                    name={sec.group ?? t("No group")}
                    count={sec.profiles.length}
                    running={sec.profiles.filter((p) => active.includes(p.id)).length}
                    collapsed={folded}
                    isGroup={sec.group !== null}
                    canMoveUp={ni > 0}
                    canMoveDown={ni >= 0 && ni < named.length - 1}
                    onToggle={() => toggleCollapse(sec.key)}
                    onFilter={() => setGroupFilter({ key: sec.key, name: sec.group ?? t("No group") })}
                    onRename={() => setPrompt({ kind: "rename-group", key: sec.key, name: sec.group ?? "" })}
                    onMove={(dir) => moveGroupBy(sec.key, dir)}
                    onUngroup={() => void renameGroup(sec.key, sec.group ?? "", "")}
                  />
                )}
                {!folded && (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3" data-section={si}>
                    {sec.profiles.map((p) => (
                      <ProfileCard key={p.id} {...cardProps(p)} />
                    ))}
                  </div>
                )}
              </section>
            );
          })
        )}
        </>
        )}
      </div>
      </div>
      </div>

      {detailsProfile && (
        <ProfileInspector {...cardProps(detailsProfile)} attention={attention.get(detailsProfile.id) ?? []} onClose={() => setDetailsId(null)} />
      )}
      {paletteOpen && <CommandPalette {...paletteCommands()} onClose={() => setPaletteOpen(false)} />}

      {/* Bulk actions for the selected profiles */}
      {selected.size > 0 && (
        <div
          role="region"
          aria-label={t("Selected profiles")}
          className="fixed inset-x-0 bottom-0 z-30 border-t border-line-strong bg-surface/95 px-4 py-2.5 backdrop-blur md:left-60"
          style={{ paddingBottom: "calc(0.625rem + env(safe-area-inset-bottom, 0px))" }}
        >
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2">
            <span className="mr-1 text-sm font-semibold">{t("{n} selected", { n: selected.size })}</span>
            <button className={btnGhost} onClick={bulkLaunch}>
              {t("Launch")}
            </button>
            <button className={btnGhost} onClick={bulkStop} disabled={!selectedProfiles.some((p) => active.includes(p.id))}>
              {t("Stop")}
            </button>
            <button className={btnGhost} onClick={() => setPrompt({ kind: "set-group" })}>
              {t("Set group…")}
            </button>
            <button className={btnGhost} onClick={() => setPrompt({ kind: "add-tag" })}>
              {t("Add tag…")}
            </button>
            <button className={btnGhost} onClick={() => openExport([...selected])}>
              {t("Export…")}
            </button>
            {api.sync && (
              <button className={btnGhost} onClick={() => openRunTask()} data-bulk-run-task="1">
                {t("Run a task…")}
              </button>
            )}
            <button className={btnGhost + " text-danger hover:bg-danger/10"} onClick={bulkDelete}>
              {t("Delete…")}
            </button>
            <span className="flex-1" />
            <button className="text-xs text-fog/50 hover:text-fog" onClick={() => setSelected(new Set(visibleIds))} title={shortcutLabel("A", host)}>
              {t("Select all {n}", { n: visibleIds.length })}
            </button>
            <button className="text-xs text-fog/50 hover:text-fog" onClick={() => setSelected(new Set())} title="Esc">
              {t("Clear selection")}
            </button>
          </div>
        </div>
      )}

      {editing && (
        <ProfileEditor
          profile={editing}
          onChange={setEditing}
          onSave={save}
          onSaveAndLaunch={saveAndLaunch}
          onCancel={closeEditor}
          dirty={editorDirty}
          initialField={editingField}
          takenNames={takenNames}
          renderLibrary={(onApply, onClose) => <LibraryModal onApply={onApply} onClose={onClose} />}
          launchTarget={target}
          fromTemplate={editingFrom ? { name: editingFrom.name, detail: describeTemplate({ ...editingFrom, usedCount: 0 }) } : undefined}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          binary={binary}
          settings={settings}
          initialSection={settingsOpen}
          autoStartLogin={autoLogin}
          onPick={pickBinary}
          onSettingsReload={(s) => {
            setSettings(s);
            refreshTarget();
          }}
          onSaveSettings={async (patch) => {
            const next = { ...settings, ...patch };
            setSettings(next);
            setSettings(await api.settings.set(next));
            refreshTarget();
          }}
          onClose={() => {
            setSettingsOpen(null);
            setAutoLogin(false);
            refreshTarget();
          }}
        />
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {migrate && (
        <MigrateDialog mode={migrate} onImport={(text, filename) => doMigrate(migrate, text, filename)} onClose={() => setMigrate(null)} />
      )}
      {exportReq && (
        <ExportDialog count={exportReq.count} single={exportReq.single} onExport={doExport} onClose={() => setExportReq(null)} />
      )}
      {runTaskOpen && api.sync && (
        <RunTaskDialog
          profiles={selectedProfiles}
          allProfiles={profiles}
          task={runTaskFor}
          example={runTaskExample}
          onSaveTask={saveTask}
          settings={settings}
          onStart={(req) => api.sync!.start(req)}
          onSaveProfiles={async (list) => {
            for (const p of list) await api.profiles.save(p);
            await refresh();
          }}
          onSaveSettings={async (patch) => {
            const next = { ...settings, ...patch };
            setSettings(next);
            setSettings(await api.settings.set(next));
          }}
          onTrial={(runId, rest) => setTrials((m) => ({ ...m, [runId]: rest }))}
          onOpenSettings={() => {
            closeRunTask();
            setSettingsOpen("tasks");
          }}
          onClose={closeRunTask}
        />
      )}
      {api.sync && (
        <TaskBoard
          runs={taskRuns}
          raised={selected.size > 0}
          onApprove={(runId, id) => void api.sync!.approve(runId, id)}
          onCancel={(runId, id) => void api.sync!.cancel(runId, id)}
          onStop={(runId, id) => void api.sync!.stop(runId, id)}
          onClear={() => void api.sync!.clear()}
          trial={taskRuns[0] && trials[taskRuns[0].id] ? { runId: taskRuns[0].id, rest: trials[taskRuns[0].id].profileIds.length } : undefined}
          onContinue={async (runId) => {
            const rest = trials[runId];
            if (!rest) return;
            setTrials(({ [runId]: _, ...m }) => m);
            const r = await api.sync!.start(rest);
            if (!r.ok) notify(r.error);
          }}
          onDismissTrial={(runId) => setTrials(({ [runId]: _, ...m }) => m)}
          onSaveRun={api.tasks ? (run) => void saveRunAsTask(run) : undefined}
        />
      )}
      {bulkCreateOpen && (
        <BulkCreateDialog
          existingIds={profiles.map((p) => p.id)}
          existingNames={profiles.map((p) => p.name)}
          groups={groupNames}
          templates={templates}
          hostVendor={hostVendor}
          onCreate={createMany}
          onClose={() => setBulkCreateOpen(false)}
        />
      )}
      {saveTplFor && (
        <SaveTemplateDialog
          profile={saveTplFor}
          templates={templates}
          onSave={(choice) => saveAsTemplate(saveTplFor, choice)}
          onClose={() => setSaveTplFor(null)}
        />
      )}
      {manageTplOpen && (
        <ManageTemplatesDialog
          templates={templates}
          onSave={async (next) => {
            await saveTemplates(next);
            setManageTplOpen(false);
            notify(t("Templates saved."));
          }}
          onClose={() => setManageTplOpen(false)}
        />
      )}
      {prompt?.kind === "set-group" && (
        <PromptDialog
          title={selected.size === 1 ? t("Set the group of 1 profile") : t("Set the group of {n} profiles", { n: selected.size })}
          label={t("Group")}
          suggestions={groupNames}
          confirmLabel={t("Set group")}
          allowEmpty
          hint={t("Leave it empty to take them out of any group.")}
          onClose={() => setPrompt(null)}
          onConfirm={(v) => {
            setPrompt(null);
            void bulkEdit(
              (p) => {
                const out = { ...p, group: v || undefined };
                if (!v) delete out.group;
                return out;
              },
              v
                ? selected.size === 1
                  ? t("Moved 1 profile to “{group}”.", { group: v })
                  : t("Moved {n} profiles to “{group}”.", { n: selected.size, group: v })
                : selected.size === 1
                  ? t("Ungrouped 1 profile.")
                  : t("Ungrouped {n} profiles.", { n: selected.size }),
            );
          }}
        />
      )}
      {prompt?.kind === "add-tag" && (
        <PromptDialog
          title={selected.size === 1 ? t("Tag 1 profile") : t("Tag {n} profiles", { n: selected.size })}
          label={t("Tag")}
          suggestions={Array.from(new Set(profiles.flatMap((p) => p.tags ?? []))).sort()}
          confirmLabel={t("Add tag")}
          onClose={() => setPrompt(null)}
          onConfirm={(v) => {
            setPrompt(null);
            const tag = v.replace(/^#/, "");
            void bulkEdit(
              (p) => ({ ...p, tags: (p.tags ?? []).some((x) => x.toLowerCase() === tag.toLowerCase()) ? p.tags : [...(p.tags ?? []), tag] }),
              selected.size === 1
                ? t("Tagged 1 profile #{tag}.", { tag })
                : t("Tagged {n} profiles #{tag}.", { n: selected.size, tag }),
            );
          }}
        />
      )}
      {prompt?.kind === "replace-proxy" && (
        <PromptDialog
          title={t("Replace {proxy}", { proxy: prompt.row.key })}
          label={t("New proxy address")}
          confirmLabel={prompt.row.profiles.length === 1 ? t("Move 1 profile") : t("Move {n} profiles", { n: prompt.row.profiles.length })}
          hint={t("Each profile keeps its own login unless the new address has one. Their last exit is cleared, since it was measured through the old server.")}
          onClose={() => setPrompt(null)}
          onConfirm={(v) => {
            const row = (prompt as { row: ProxyRow }).row;
            setPrompt(null);
            if (v.trim()) void doReplaceProxy(row, v.trim());
          }}
        />
      )}
      {prompt?.kind === "rename-group" && (
        <PromptDialog
          title={t("Rename “{name}”", { name: prompt.name })}
          label={t("New name")}
          initial={prompt.name}
          confirmLabel={t("Rename")}
          hint={t("Every profile in the group moves with it.")}
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
          <button className="shrink-0 text-fog/40 hover:text-fog" onClick={() => setToast(null)} aria-label={t("Dismiss")}>
            ✕
          </button>
        </div>
      )}
    </main>
  );
}
