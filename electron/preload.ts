import { contextBridge, ipcRenderer } from "electron";
import type { Profile, Settings, LaunchResult, GeoResult, ExportResult, ImportResult } from "./types";

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
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke("settings:get"),
    set: (s: Settings): Promise<Settings> => ipcRenderer.invoke("settings:set", s),
  },
  resolveBinary: (): Promise<string | null> => ipcRenderer.invoke("resolveBinary"),
  pickBinary: (): Promise<string | null> => ipcRenderer.invoke("pickBinary"),
  geoCheck: (p: Profile): Promise<GeoResult> => ipcRenderer.invoke("geo:check", p),
  exportProfiles: (opts?: { redact?: boolean }): Promise<ExportResult> =>
    ipcRenderer.invoke("profiles:export", opts),
  importProfiles: (): Promise<ImportResult> => ipcRenderer.invoke("profiles:import"),
};

contextBridge.exposeInMainWorld("clearcote", api);

export type ClearcoteApi = typeof api;
