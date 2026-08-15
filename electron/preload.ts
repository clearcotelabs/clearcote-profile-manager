import { contextBridge, ipcRenderer } from "electron";
import type {
  Profile, Settings, LaunchResult, GeoResult, ExportResult, ImportResult,
  FpImportResult, FpListResult, LibraryProfile, LicenseStatus, DownloadProgress,
} from "./types";
import type { VersionOption } from "./catalog";
import type { CachedBuild } from "./cache";
import type { UpdateInfo, DownloadResult } from "./appupdate";

// The narrow, typed surface the renderer is allowed to call. No fs / child_process
// in the renderer — everything goes through these IPC channels.
const api = {
  profiles: {
    list: (): Promise<Profile[]> => ipcRenderer.invoke("profiles:list"),
    get: (id: string): Promise<Profile | null> => ipcRenderer.invoke("profiles:get", id),
    save: (p: Profile): Promise<Profile> => ipcRenderer.invoke("profiles:save", p),
    remove: (id: string): Promise<void> => ipcRenderer.invoke("profiles:delete", id),
  },
  launch: (p: Profile): Promise<LaunchResult> => ipcRenderer.invoke("launch", p),
  stop: (id: string): Promise<void> => ipcRenderer.invoke("stop", id),
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
    /** Newest release vs this build. `force` ignores the once-a-day throttle (the Settings button).
     *  Resolves null when the check is off, throttled, or GitHub is unreachable. */
    check: (force?: boolean): Promise<UpdateInfo | null> => ipcRenderer.invoke("update:check", force),
    /** Download the matching asset and verify it against the release's SHA256SUMS. */
    download: (info: UpdateInfo): Promise<DownloadResult> => ipcRenderer.invoke("update:download", info),
    /** Open the verified installer, or reveal it in Explorer. The user does the installing. */
    run: (file: string): Promise<void> => ipcRenderer.invoke("update:run", file),
    reveal: (file: string): Promise<void> => ipcRenderer.invoke("update:reveal", file),
    /** Stop offering this version until a newer one ships. */
    skip: (version: string): Promise<void> => ipcRenderer.invoke("update:skip", version),
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
  exportProfiles: (opts?: { redact?: boolean }): Promise<ExportResult> =>
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
