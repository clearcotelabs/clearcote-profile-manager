import { contextBridge, ipcRenderer } from "electron";
import type {
  Profile, Settings, LaunchResult, GeoResult, ExportResult, ImportResult,
  FpImportResult, FpListResult, LibraryProfile, LicenseStatus, DownloadProgress,
} from "./types";
import type { VersionOption } from "./catalog";
import type { CachedBuild } from "./cache";
import type { UpdateInfo, DownloadResult } from "./appupdate";
import type { LaunchTarget } from "./launchTarget";
import type { TrashResult, RestoreResult } from "./profiles";
import type { ExitEvent } from "./launcher";
import type { StopOutcome } from "./procstop";
import type { TempCopy } from "./cache";

/** Subscribe to a main-process event; returns the unsubscribe function. */
function on<T>(channel: string, cb: (data: T) => void): () => void {
  const handler = (_e: unknown, data: T) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// The narrow, typed surface the renderer is allowed to call. No fs / child_process
// in the renderer — everything goes through these IPC channels.
const api = {
  profiles: {
    list: (): Promise<Profile[]> => ipcRenderer.invoke("profiles:list"),
    get: (id: string): Promise<Profile | null> => ipcRenderer.invoke("profiles:get", id),
    save: (p: Profile): Promise<Profile> => ipcRenderer.invoke("profiles:save", p),
    /** Moves the profile + its data to the trash; undo with restore(trashId). */
    remove: (id: string): Promise<TrashResult> => ipcRenderer.invoke("profiles:delete", id),
    restore: (trashId: string): Promise<RestoreResult> => ipcRenderer.invoke("profiles:restore", trashId),
    openData: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("profiles:openData", id),
    /** Delete the browser's caches, keeping cookies, logins and site storage. */
    clearCache: (id: string): Promise<{ ok: boolean; freedBytes?: number; error?: string }> =>
      ipcRenderer.invoke("profiles:clearCache", id),
    /** Rename (or, with "", dissolve) a group on every profile in it; returns how many changed. */
    renameGroup: (from: string, to: string): Promise<number> => ipcRenderer.invoke("profiles:renameGroup", from, to),
  },
  /** Where a profile's proxy exits, saved onto the profile for its card. */
  checkProfileGeo: (id: string): Promise<GeoResult & { profile?: Profile }> => ipcRenderer.invoke("geo:checkProfile", id),
  /** A browser stopped without the app asking (closed, crashed, killed, licence watchdog). */
  onBrowserExited: (cb: (ev: ExitEvent) => void) => on<ExitEvent>("browser:exited", cb),
  storage: {
    plan: () => ipcRenderer.invoke("storage:plan"),
    prune: (): Promise<{ removed: number; freedBytes: number; skipped: number }> => ipcRenderer.invoke("storage:prune"),
    temp: (): Promise<TempCopy[]> => ipcRenderer.invoke("storage:temp"),
    cleanTemp: (): Promise<{ removed: number; inUse: number; freedBytes: number }> => ipcRenderer.invoke("storage:cleanTemp"),
    profileSizes: (): Promise<{ id: string; name: string; bytes: number; running: boolean }[]> =>
      ipcRenderer.invoke("storage:profileSizes"),
    /** Download the build "Latest" resolves to now, before any launch needs it. */
    prefetch: (): Promise<{ ok: boolean; version?: string; major?: number; downloaded?: boolean; error?: string }> =>
      ipcRenderer.invoke("build:prefetch"),
    onPrefetchProgress: (cb: (p: { pct: number; seenMB: number; totalMB: number; version: string }) => void) =>
      on("prefetch:progress", cb),
  },
  /** Open one of our own pages in the system browser (other hosts are refused). */
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke("openExternal", url),
  /** What a profile on "Latest" launches right now (drives the header pill). */
  launchTarget: (): Promise<LaunchTarget> => ipcRenderer.invoke("launchTarget"),
  launch: (p: Profile): Promise<LaunchResult> => ipcRenderer.invoke("launch", p),
  stop: (id: string): Promise<StopOutcome> => ipcRenderer.invoke("stop", id),
  running: (): Promise<string[]> => ipcRenderer.invoke("running"),
  listVersions: (): Promise<VersionOption[]> => ipcRenderer.invoke("versions:list"),
  /** PRO rebuild revisions ("150.0.7871.114-r10", …), newest first. [] when unlicensed. */
  listRevisions: (): Promise<string[]> => ipcRenderer.invoke("versions:revisions"),
  // Subscribe to browser-download progress during a launch. Returns an unsubscribe fn.
  onDownloadProgress: (cb: (p: DownloadProgress) => void): (() => void) => {
    const handler = (_e: unknown, data: DownloadProgress) => cb(data);
    ipcRenderer.on("download:progress", handler);
    return () => ipcRenderer.removeListener("download:progress", handler);
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke("settings:get"),
    set: (s: Settings): Promise<Settings> => ipcRenderer.invoke("settings:set", s),
  },
  license: {
    check: (key?: string): Promise<LicenseStatus> => ipcRenderer.invoke("license:check", key),
  },
  cache: {
    list: (): Promise<CachedBuild[]> => ipcRenderer.invoke("cache:list"),
    remove: (tag: string): Promise<boolean> => ipcRenderer.invoke("cache:remove", tag),
  },
  update: {
    /** Newest release vs this build — asked on every app start. `force` asks even when update
     *  checks are turned off (the Settings button). Null when off or GitHub is unreachable. */
    check: (force?: boolean): Promise<UpdateInfo | null> => ipcRenderer.invoke("update:check", force),
    /** Download the matching asset and verify it against the release's SHA256SUMS. */
    download: (info: UpdateInfo): Promise<DownloadResult> => ipcRenderer.invoke("update:download", info),
    /** Open the verified installer, or reveal it in Explorer. The user does the installing. */
    run: (file: string): Promise<void> => ipcRenderer.invoke("update:run", file),
    reveal: (file: string): Promise<void> => ipcRenderer.invoke("update:reveal", file),
    openReleases: (url: string): Promise<void> => ipcRenderer.invoke("update:openReleases", url),
  },
  onUpdateProgress: (cb: (p: { pct: number; seenMB: number; totalMB: number }) => void): (() => void) => {
    const handler = (_e: unknown, data: { pct: number; seenMB: number; totalMB: number }) => cb(data);
    ipcRenderer.on("update:progress", handler);
    return () => ipcRenderer.removeListener("update:progress", handler);
  },
  resolveBinary: (): Promise<string | null> => ipcRenderer.invoke("resolveBinary"),
  pickBinary: (): Promise<string | null> => ipcRenderer.invoke("pickBinary"),
  geoCheck: (p: Profile): Promise<GeoResult> => ipcRenderer.invoke("geo:check", p),
  exportProfiles: (opts?: { includeSecrets?: boolean; ids?: string[] }): Promise<ExportResult> =>
    ipcRenderer.invoke("profiles:export", opts),
  importProfiles: (): Promise<ImportResult> => ipcRenderer.invoke("profiles:import"),
  fp: {
    import: (): Promise<FpImportResult> => ipcRenderer.invoke("fp:import"),
    library: (): Promise<FpListResult> => ipcRenderer.invoke("fp:library"),
    use: (lib: LibraryProfile): Promise<FpImportResult> => ipcRenderer.invoke("fp:use", lib),
  },
};

contextBridge.exposeInMainWorld("clearcote", api);

export type ClearcoteApi = typeof api;
