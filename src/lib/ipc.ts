// Renderer-side bridge to the Electron main process.
// In the desktop app, window.clearcote is injected by electron/preload.ts.
// In a plain browser (next dev / preview), fall back to a localStorage-backed mock
// so the UI is fully usable for design + testing without Electron.

import { redactProxyString, screenWarningFromLabel, type Profile } from "@/types/profile";
import type { LaunchTarget } from "@/lib/launchTarget";

export type TrashResult = { ok: true; trashId: string } | { ok: false; error: string };
export type RestoreResult = { ok: true; profile: Profile } | { ok: false; error: string };
export type StopOutcome = "graceful" | "forced" | "gone";

/** A browser stopped without the app asking — see electron/exitreason.ts for what the facts mean. */
export interface ExitEvent {
  id: string;
  code: number | null;
  signal: string | null;
  stderrTail?: string;
  leaseRefusal?: { status: number; code?: string; error?: string };
  ranForMs?: number;
}
export interface StorageBuild {
  tag: string;
  version: string;
  tier: "free" | "pro";
  sizeBytes: number;
  /** Why it is kept ("Latest", "Pinned by Bank", "Running"); absent for removable builds. */
  reasons?: string[];
}
export interface StoragePlan {
  keep: StorageBuild[];
  remove: StorageBuild[];
  freeBytes: number;
  /** The catalog was unreachable, so nothing could safely be marked removable. */
  offline: boolean;
}
export interface TempCopy {
  path: string;
  kind: "launch-copy" | "leftover";
  sizeBytes: number;
}
export interface ProfileSize {
  id: string;
  name: string;
  bytes: number;
  running: boolean;
}
export interface PrefetchProgress {
  pct: number;
  seenMB: number;
  totalMB: number;
  version: string;
}

export interface Settings {
  binaryPath?: string;
  theme?: "dark" | "light";
  /** PRO license key (`cc_lic_...`). Set = launches use the license-gated PRO browser
   *  + a floating-concurrency slot. Empty = free mode (no backend contact). */
  licenseKey?: string;
  licenseApiBase?: string;
  /** Check GitHub for a newer release every time the app starts. On unless turned off. */
  updateCheck?: boolean;
  lastUpdateCheck?: string;
  /** No longer read — see electron/types.ts. */
  skippedVersion?: string;
  /** Plan last reported for licenseKey — written by the main process, read-only here. */
  lastPlan?: string;
  /** Closing the window while browsers run: ask, keep running in the tray, or close them and quit. */
  closeBehavior?: "ask" | "tray" | "quit";
  /** Remove cached builds nothing needs once a newer one is downloaded. On unless turned off. */
  autoPruneBuilds?: boolean;
  /** Window size/position at last close, restored on start when it is still on a screen. */
  window?: { x: number; y: number; width: number; height: number; maximized?: boolean };
}
export interface LaunchResult {
  ok: boolean;
  pid?: number;
  error?: string;
  /** Machine-readable reason, when the failing layer gave one (e.g. CONCURRENCY_LIMIT_EXCEEDED). */
  code?: string;
  /** True when the launch used the PRO (license-gated) binary + a leased run-token. */
  pro?: boolean;
  /** Non-fatal problems with an otherwise successful launch — an option that will silently do
   *  nothing (a switch the resolved build predates), or geoip failing to resolve the exit region. */
  warnings?: string[];
}
export interface LicenseStatus {
  ok: boolean;
  /** Valid, but every browser slot is in use right now (the check could not take one). */
  busy?: boolean;
  plan?: string;
  used?: number;
  limit?: number;
  error?: string;
  code?: string;
}
export interface GeoResult {
  ok: boolean;
  ip?: string;
  country?: string;
  countryCode?: string;
  city?: string;
  timezone?: string;
  lat?: number;
  lon?: number;
  acceptLanguage?: string;
  error?: string;
}
export interface ExportResult {
  ok: boolean;
  path?: string;
  count?: number;
}
export interface ImportResult {
  ok: boolean;
  count?: number;
  /** Imported under a new id because theirs was unusable or already taken (never overwritten). */
  renamed?: number;
  error?: string;
}

export interface FingerprintMeta {
  label?: string;
  renderer?: string;
  cores?: number;
  memory?: number;
  screen?: string;
  screenWidth?: number;
  screenHeight?: number;
  /** Set when the captured display is too small to contain a real browser window. */
  screenWarning?: string;
  source?: "file" | "library";
}
export interface FpImportResult {
  ok: boolean;
  file?: string;
  meta?: FingerprintMeta;
  error?: string;
}
export interface LibraryProfile {
  name: string;
  downloadUrl: string;
  /** From the curated clearcote-profiles index.json — match your host GPU vendor for coherence. */
  gpuVendor?: string;
  gpuFamily?: string;
  renderer?: string;
  screen?: string;
  /** Set when the indexed screen size is below the guard floor, so the picker can warn (or filter)
   *  BEFORE downloading a capture that would produce impossible window geometry. */
  screenWarning?: string;
}
export interface FpListResult {
  ok: boolean;
  profiles?: LibraryProfile[];
  error?: string;
}

/** One available browser build (from GET /api/v1/versions), for the version dropdown. */
export interface VersionOption {
  version: string;
  major: number;
  tier: "free" | "pro";
  tag: string;
}

/** Browser-download progress streamed during a launch (first use of a version). */
export interface DownloadProgress {
  id: string;
  version: string;
  pct: number;
  seenMB: number;
  totalMB: number;
}

/** One browser build currently downloaded in the cache (removable to force a re-download). */
export interface CachedBuild {
  tag: string;
  version: string;
  tier: "free" | "pro";
  sizeBytes: number;
  path: string;
}

export interface UpdateAsset { name: string; url: string; size: number }
export interface UpdateInfo {
  available: boolean;
  latest: string;
  current: string;
  releaseUrl: string;
  notes?: string;
  asset?: UpdateAsset;
  sumsUrl?: string;
}
export interface UpdateDownloadResult {
  ok: boolean;
  path?: string;
  error?: string;
  /** False when the release published no checksums, so nothing could be checked. "Downloaded" and
   *  "downloaded and verified" are different claims and the UI says which one it is. */
  verified?: boolean;
}

export interface ClearcoteApi {
  profiles: {
    list: () => Promise<Profile[]>;
    get: (id: string) => Promise<Profile | null>;
    save: (p: Profile) => Promise<Profile>;
    /** Moves the profile and its browser data to the trash; undo with restore(). */
    remove: (id: string) => Promise<TrashResult>;
    restore: (trashId: string) => Promise<RestoreResult>;
    /** Open the profile's saved browser data folder. */
    openData: (id: string) => Promise<{ ok: boolean; error?: string }>;
    /** Delete the browser's caches; cookies, logins and site storage stay. */
    clearCache: (id: string) => Promise<{ ok: boolean; freedBytes?: number; error?: string }>;
    /** Rename (or with "" dissolve) a group on every profile in it; resolves to how many changed. */
    renameGroup: (from: string, to: string) => Promise<number>;
  };
  /** Where a profile's proxy exits, saved onto the profile. */
  checkProfileGeo: (id: string) => Promise<GeoResult & { profile?: Profile }>;
  /** A browser stopped without the app asking. Returns an unsubscribe fn. */
  onBrowserExited: (cb: (ev: ExitEvent) => void) => () => void;
  storage: {
    plan: () => Promise<StoragePlan>;
    prune: () => Promise<{ removed: number; freedBytes: number; skipped: number }>;
    temp: () => Promise<TempCopy[]>;
    cleanTemp: () => Promise<{ removed: number; inUse: number; freedBytes: number }>;
    profileSizes: () => Promise<ProfileSize[]>;
    prefetch: () => Promise<{ ok: boolean; version?: string; major?: number; downloaded?: boolean; error?: string }>;
    onPrefetchProgress: (cb: (p: PrefetchProgress) => void) => () => void;
  };
  /** Open one of our own pages in the system browser. */
  openExternal: (url: string) => Promise<boolean>;
  /** What a profile on "Latest" launches right now — drives the header pill. */
  launchTarget: () => Promise<LaunchTarget>;
  launch: (p: Profile) => Promise<LaunchResult>;
  stop: (id: string) => Promise<StopOutcome>;
  running: () => Promise<string[]>;
  /** Public browser-build catalog for this OS (newest major first). Drives the version dropdown. */
  listVersions: () => Promise<VersionOption[]>;
  /** PRO rebuild revisions ("150.0.7871.114-r10", …), newest first — pin one for a reproducible
   *  run, since "latest" and a bare major both follow the current pin. [] without a license key. */
  listRevisions: () => Promise<string[]>;
  /** Subscribe to browser-download progress during a launch. Returns an unsubscribe fn. */
  onDownloadProgress: (cb: (p: DownloadProgress) => void) => () => void;
  settings: {
    get: () => Promise<Settings>;
    set: (s: Settings) => Promise<Settings>;
  };
  license: {
    check: (key?: string) => Promise<LicenseStatus>;
  };
  /** Downloaded-browser cache: list what's on disk, and remove a build to force a re-download. */
  cache: {
    list: () => Promise<CachedBuild[]>;
    remove: (tag: string) => Promise<boolean>;
  };
  update: {
    check: (force?: boolean) => Promise<UpdateInfo | null>;
    download: (info: UpdateInfo) => Promise<UpdateDownloadResult>;
    run: (file: string) => Promise<void>;
    reveal: (file: string) => Promise<void>;
    openReleases: (url: string) => Promise<void>;
  };
  onUpdateProgress: (cb: (p: { pct: number; seenMB: number; totalMB: number }) => void) => () => void;
  resolveBinary: () => Promise<string | null>;
  pickBinary: () => Promise<string | null>;
  geoCheck: (p: Profile) => Promise<GeoResult>;
  exportProfiles: (opts?: { includeSecrets?: boolean; ids?: string[] }) => Promise<ExportResult>;
  importProfiles: () => Promise<ImportResult>;
  fp: {
    import: () => Promise<FpImportResult>;
    library: () => Promise<FpListResult>;
    use: (lib: LibraryProfile) => Promise<FpImportResult>;
  };
}

declare global {
  interface Window {
    clearcote?: ClearcoteApi;
  }
}

const PROFILES_KEY = "clearcote.profiles.mock";
const SETTINGS_KEY = "clearcote.settings.mock";

function buildMock(): ClearcoteApi {
  const read = (): Profile[] => {
    try {
      return JSON.parse(localStorage.getItem(PROFILES_KEY) || "[]") as Profile[];
    } catch {
      return [];
    }
  };
  const write = (ps: Profile[]) => localStorage.setItem(PROFILES_KEY, JSON.stringify(ps));
  const mockTrash = new Map<string, Profile>();

  // Opt-in test hooks. The preview normally cannot launch anything; with
  // localStorage["clearcote.mock.launch"] = "ok" a launch "runs" (and "clearcote.mock.limit" = "1"
  // makes it a one-browser plan), or set it to {"error","code"} to fail that way.
  // window.__clearcoteMock.exit(ev) plays a browser stopping on its own.
  const mockRunning = new Set<string>();
  const exitListeners = new Set<(ev: ExitEvent) => void>();
  const prefetchListeners = new Set<(p: PrefetchProgress) => void>();
  const readJson = <T,>(key: string, fallback: T): T => {
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  if (typeof window !== "undefined") {
    (window as unknown as { __clearcoteMock: unknown }).__clearcoteMock = {
      exit: (ev: ExitEvent) => {
        mockRunning.delete(ev.id);
        exitListeners.forEach((l) => l(ev));
      },
    };
  }
  const STORAGE_KEY = "clearcote.mock.storage";
  type MockStorage = { plan?: StoragePlan; temp?: TempCopy[]; sizes?: Record<string, number> };

  return {
    profiles: {
      list: async () =>
        read().sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")),
      get: async (id) => read().find((p) => p.id === id) || null,
      save: async (p) => {
        const now = new Date().toISOString();
        const out: Profile = { ...p, createdAt: p.createdAt || now, updatedAt: now };
        write([...read().filter((x) => x.id !== out.id), out]);
        return out;
      },
      // Same trash semantics as the desktop app, so Undo works in the browser preview too.
      remove: async (id) => {
        const p = read().find((x) => x.id === id);
        if (!p) return { ok: false, error: "That profile no longer exists." };
        const trashId = `${id}__${Date.now()}`;
        mockTrash.set(trashId, p);
        write(read().filter((x) => x.id !== id));
        return { ok: true, trashId };
      },
      restore: async (trashId) => {
        const p = mockTrash.get(trashId);
        if (!p) return { ok: false, error: "It can no longer be restored." };
        if (read().some((x) => x.id === p.id)) return { ok: false, error: `A profile named “${p.id}” exists again.` };
        mockTrash.delete(trashId);
        write([...read(), p]);
        return { ok: true, profile: p };
      },
      openData: async () => ({ ok: false, error: "Browser data lives in the desktop app." }),
      clearCache: async (id) =>
        mockRunning.has(id)
          ? { ok: false, error: "Stop this profile's browser first — it has its cache open." }
          : { ok: true, freedBytes: readJson<MockStorage>(STORAGE_KEY, {}).sizes?.[id] ?? 0 },
      renameGroup: async (from, to) => {
        const key = from.trim().toLowerCase();
        let n = 0;
        write(
          read().map((p) => {
            if ((p.group ?? "").trim().toLowerCase() !== key) return p;
            n++;
            const out = { ...p, group: to.trim() || undefined };
            if (!out.group) delete out.group;
            return out;
          }),
        );
        return n;
      },
    },
    checkProfileGeo: async () => ({ ok: false, error: "IP / geo check runs in the desktop app." }),
    onBrowserExited: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    storage: {
      plan: async () => readJson<MockStorage>(STORAGE_KEY, {}).plan ?? { keep: [], remove: [], freeBytes: 0, offline: false },
      prune: async () => {
        const st = readJson<MockStorage>(STORAGE_KEY, {});
        const plan = st.plan ?? { keep: [], remove: [], freeBytes: 0, offline: false };
        const out = { removed: plan.remove.length, freedBytes: plan.freeBytes, skipped: 0 };
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...st, plan: { ...plan, remove: [], freeBytes: 0 } }));
        return out;
      },
      temp: async () => readJson<MockStorage>(STORAGE_KEY, {}).temp ?? [],
      cleanTemp: async () => {
        const st = readJson<MockStorage>(STORAGE_KEY, {});
        const temp = st.temp ?? [];
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...st, temp: [] }));
        return { removed: temp.length, inUse: 0, freedBytes: temp.reduce((a, t) => a + t.sizeBytes, 0) };
      },
      profileSizes: async () => {
        const sizes = readJson<MockStorage>(STORAGE_KEY, {}).sizes ?? {};
        return read().map((p) => ({ id: p.id, name: p.name?.trim() || p.id, bytes: sizes[p.id] ?? 0, running: mockRunning.has(p.id) }));
      },
      prefetch: async () => {
        if (localStorage.getItem("clearcote.mock.prefetch") !== "ok") return { ok: false, error: "Downloading builds runs in the desktop app." };
        for (const pct of [25, 50, 75, 100]) {
          prefetchListeners.forEach((l) => l({ pct, seenMB: pct * 2, totalMB: 200, version: "153.0.8010.36" }));
          await new Promise((r) => setTimeout(r, 60));
        }
        return { ok: true, version: "153.0.8010.36", major: 153, downloaded: true };
      },
      onPrefetchProgress: (cb) => {
        prefetchListeners.add(cb);
        return () => prefetchListeners.delete(cb);
      },
    },
    openExternal: async (url: string) => {
      window.open(url, "_blank", "noopener");
      return true;
    },
    // localStorage["clearcote.mock.target"] plays the desktop's launch target (tests, design review).
    launchTarget: async () => readJson<LaunchTarget>("clearcote.mock.target", { mode: "preview" }),
    launch: async (p) => {
      const mode = localStorage.getItem("clearcote.mock.launch");
      if (!mode) return { ok: false, error: "Launching only works in the desktop app (this is the browser preview)." };
      if (mode !== "ok") {
        const e = readJson<{ error?: string; code?: string }>("clearcote.mock.launch", {});
        return { ok: false, error: e.error, code: e.code };
      }
      if (mockRunning.has(p.id)) return { ok: false, error: "This profile is already running." };
      if (localStorage.getItem("clearcote.mock.limit") === "1" && mockRunning.size >= 1) {
        return { ok: false, error: "Concurrency limit reached: 1 of 1 browsers in use.", code: "CONCURRENCY_LIMIT_EXCEEDED" };
      }
      mockRunning.add(p.id);
      write(read().map((x) => (x.id === p.id ? { ...x, lastLaunchedAt: new Date().toISOString() } : x)));
      return { ok: true, pid: 4000 + mockRunning.size, pro: true };
    },
    stop: async (id) => (mockRunning.delete(id) ? "graceful" : "gone"),
    running: async () => [...mockRunning],
    listVersions: async () => [], // browser preview has no catalog access; UI falls back to "latest"
    listRevisions: async () => [], // revisions need an authenticated PRO call — desktop app only
    onDownloadProgress: () => () => {}, // no downloads in the browser preview
    // The browser preview never offers a real update: there is no installed app to replace. A fake
    // release placed in localStorage["clearcote.mock.update"] stands in for GitHub, so the UI tests
    // can drive the banner — and it honours the Settings switch exactly like the main process does.
    update: {
      check: async (force?: boolean) => {
        let fake: UpdateInfo | null = null;
        try {
          fake = JSON.parse(localStorage.getItem("clearcote.mock.update") || "null") as UpdateInfo | null;
        } catch {
          fake = null;
        }
        if (!fake) return null;
        let s: Settings = {};
        try {
          s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as Settings;
        } catch {
          /* defaults */
        }
        if (!force && s.updateCheck === false) return null;
        return fake;
      },
      download: async () => ({ ok: false, error: "Updating only works in the desktop app." }),
      run: async () => {},
      reveal: async () => {},
      openReleases: async (url: string) => {
        window.open(url, "_blank", "noopener");
      },
    },
    onUpdateProgress: () => () => {},
    cache: { list: async () => [], remove: async () => false }, // no on-disk cache in the browser
    settings: {
      get: async () => {
        try {
          return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as Settings;
        } catch {
          return { theme: "dark" };
        }
      },
      set: async (s) => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
        return s;
      },
    },
    license: {
      // localStorage["clearcote.mock.license"] plays the licence service's answer.
      check: async () => readJson<LicenseStatus>("clearcote.mock.license", { ok: false, error: "License check runs in the desktop app." }),
    },
    resolveBinary: async () => null,
    pickBinary: async () => null,
    geoCheck: async () => ({ ok: false, error: "IP / geo check runs in the desktop app." }),
    exportProfiles: async (opts) => {
      const only = opts?.ids?.length ? new Set(opts.ids) : null;
      const list = read()
        .filter((p) => !only || only.has(p.id))
        .map((p) => {
          if (opts?.includeSecrets) return p;
          const out = p.proxy ? { ...p, proxy: redactProxyString(p.proxy) } : { ...p };
          delete out.encryptionKey;
          return out;
        });
      const blob = new Blob([JSON.stringify(list, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "clearcote-profiles.json";
      a.click();
      URL.revokeObjectURL(url);
      return { ok: true, count: list.length };
    },
    importProfiles: async () => ({ ok: false, error: "Import runs in the desktop app." }),
    fp: {
      import: async () => ({ ok: false, error: "Importing a fingerprint runs in the desktop app." }),
      library: async () => {
        const RAW = "https://raw.githubusercontent.com/clearcotelabs/clearcote-profiles/main/samples";
        try {
          const ir = await fetch(`${RAW}/index.json`);
          if (ir.ok) {
            const idx = (await ir.json()) as { profiles?: Array<Record<string, unknown>> };
            if (Array.isArray(idx.profiles) && idx.profiles.length) {
              return {
                ok: true,
                profiles: idx.profiles.map((e) => ({
                  name: `${e.id}.json`,
                  downloadUrl: `${RAW}/${e.id}.json`,
                  gpuVendor: e.gpu_vendor as string | undefined,
                  gpuFamily: e.gpu_family as string | undefined,
                  renderer: e.renderer as string | undefined,
                  screen: e.screen as string | undefined,
                  screenWarning: screenWarningFromLabel(e.screen as string | undefined) ?? undefined,
                })),
              };
            }
          }
        } catch {
          /* fall through to the directory listing */
        }
        try {
          const res = await fetch(
            "https://api.github.com/repos/clearcotelabs/clearcote-profiles/contents/samples",
          );
          if (!res.ok) return { ok: false, error: `GitHub API ${res.status}` };
          const items = (await res.json()) as Array<{ name: string; download_url: string }>;
          return {
            ok: true,
            profiles: items
              .filter((i) => i.name?.endsWith(".json") && i.name !== "index.json")
              .map((i) => ({ name: i.name, downloadUrl: i.download_url })),
          };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
      use: async () => ({ ok: false, error: "Applying a fingerprint runs in the desktop app." }),
    },
  };
}

export const isElectron = typeof window !== "undefined" && !!window.clearcote;

export const api: ClearcoteApi =
  (typeof window !== "undefined" && window.clearcote) || buildMock();
