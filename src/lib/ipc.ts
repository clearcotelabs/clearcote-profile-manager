// Renderer-side bridge to the Electron main process.
// In the desktop app, window.clearcote is injected by electron/preload.ts.
// In a plain browser (next dev / preview), fall back to a localStorage-backed mock
// so the UI is fully usable for design + testing without Electron.

import type { Profile } from "@/types/profile";

export interface Settings {
  binaryPath?: string;
  theme?: "dark" | "light";
}
export interface LaunchResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

export interface ClearcoteApi {
  profiles: {
    list: () => Promise<Profile[]>;
    get: (id: string) => Promise<Profile | null>;
    save: (p: Profile) => Promise<Profile>;
    remove: (id: string) => Promise<void>;
  };
  launch: (p: Profile) => Promise<LaunchResult>;
  stop: (id: string) => Promise<void>;
  running: () => Promise<string[]>;
  settings: {
    get: () => Promise<Settings>;
    set: (s: Settings) => Promise<Settings>;
  };
  resolveBinary: () => Promise<string | null>;
  pickBinary: () => Promise<string | null>;
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
      remove: async (id) => write(read().filter((p) => p.id !== id)),
    },
    launch: async () => ({
      ok: false,
      error: "Launching only works in the desktop app (this is the browser preview).",
    }),
    stop: async () => {},
    running: async () => [],
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
    resolveBinary: async () => null,
    pickBinary: async () => null,
  };
}

export const isElectron = typeof window !== "undefined" && !!window.clearcote;

export const api: ClearcoteApi =
  (typeof window !== "undefined" && window.clearcote) || buildMock();
